import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Store, AppError, equal, fail } from './store.mjs';

function secret(value, name) {
  if (!/^[a-f0-9]{64}$/i.test(value || '')) throw new Error(`${name} must be 64 hex characters; run scripts/init-env.mjs`);
  return value;
}
async function jsonBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, 'Use application/json');
  const parts = []; let size = 0;
  for await (const part of req) { size += part.length; if (size > 32768) fail(413, 'Request too large'); parts.push(part); }
  try {
    const b = JSON.parse(Buffer.concat(parts).toString());
    if (!b || Array.isArray(b) || typeof b !== 'object') fail(400, 'Expected JSON object'); return b;
  } catch (e) { if (e instanceof AppError) throw e; fail(400, 'Invalid JSON'); }
}
function attr(body, name, fallback = '') {
  const item = body[name];
  if (item === undefined) return fallback;
  if (!item || !Array.isArray(item.value) || item.value.length !== 1) fail(400, `Invalid RADIUS attribute ${name}`);
  return item.value[0];
}
function classValue(value) {
  if (typeof value === 'string' && /^0x(?:[a-f0-9]{2})+$/i.test(value)) return Buffer.from(value.slice(2), 'hex').toString('utf8');
  return value;
}
export function makeServer({ store, adminToken, radiusToken, log = console.error }) {
  secret(adminToken, 'ADMIN_TOKEN'); secret(radiusToken, 'RADIUS_TOKEN');
  const buckets = new Map();
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') { store.get('SELECT 1'); return send(200, { ok: true }); }
      // Ignore X-Forwarded-For: never trust arbitrary caller-supplied proxy identity.
      const bucketKey = `${req.socket.remoteAddress}:${path.startsWith('/radius/') ? 'radius' : 'api'}`;
      const minute = Math.floor(Date.now() / 60000), limit = path.startsWith('/radius/') ? 6000 : 300;
      if (buckets.size > 10000) for (const [key, b] of buckets) if (b.minute !== minute) buckets.delete(key);
      const bucket = buckets.get(bucketKey) || { minute, count: 0 };
      if (bucket.minute !== minute) { bucket.minute = minute; bucket.count = 0; }
      bucket.count++; buckets.set(bucketKey, bucket);
      if (bucket.count > limit) fail(429, 'Request rate exceeded');
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (path.startsWith('/radius/')) {
        if (!equal(bearer, radiusToken)) fail(401, 'Unauthorized');
        if (req.method !== 'POST') fail(405, 'POST required');
        const site = req.headers['x-site-id'], nas = req.headers['x-nas-ip'];
        if (typeof site !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(site) || typeof nas !== 'string' || !nas || nas.length > 64) fail(400, 'Missing trusted RADIUS site/source headers');
        const body = await jsonBody(req), username = attr(body, 'User-Name'), callingStationId = attr(body, 'Calling-Station-Id');
        if (path === '/radius/authenticate') return send(200, store.authenticate({ site, nas, username, password: attr(body, 'User-Password'), callingStationId }));
        if (path === '/radius/accounting') {
          const statusRaw = attr(body, 'Acct-Status-Type');
          const status = ({ 1: 'Start', 2: 'Stop', 3: 'Interim-Update' })[statusRaw] || statusRaw;
          const rawSeconds = attr(body, 'Acct-Session-Time', status === 'Start' ? 0 : undefined);
          if (rawSeconds === undefined || rawSeconds === '' || !/^\d+$/.test(String(rawSeconds))) fail(400, 'Missing or invalid Acct-Session-Time');
          store.accounting({ site, nas, username, callingStationId, status, seconds: Number(rawSeconds), classId: classValue(attr(body, 'Class')), sessionId: attr(body, 'Acct-Session-Id') });
          res.writeHead(204); return res.end();
        }
        fail(404, 'Not found');
      }
      if (path.startsWith('/api/admin/')) {
        if (!equal(bearer, adminToken)) fail(401, 'Unauthorized');
        if (req.method === 'GET' && path === '/api/admin/sites') return send(200, store.all('SELECT * FROM sites ORDER BY id'));
        if (req.method === 'GET' && path === '/api/admin/vouchers') return send(200, store.vouchers(url.searchParams.get('site')));
        if (req.method === 'GET' && path === '/api/admin/audit') return send(200, store.all('SELECT * FROM audit ORDER BY id DESC LIMIT 200'));
        if (req.method === 'GET' && path === '/api/admin/devices') return send(200, store.all('SELECT id,site,enabled,rate_version FROM devices ORDER BY id'));
        if (req.method !== 'POST') fail(405, 'POST required');
        const body = await jsonBody(req);
        if (path === '/api/admin/sites') return send(201, store.createSite(body));
        if (path === '/api/admin/devices') return send(201, store.createDevice(body));
        if (path === '/api/admin/vouchers') return send(201, store.transaction(() => store.issue(body.site, body.seconds)));
        const match = path.match(/^\/api\/admin\/(devices|vouchers)\/([a-zA-Z0-9_-]+)\/(rotate|enabled|revoke)$/);
        if (match) {
          if (match[1] === 'devices' && match[3] === 'rotate') return send(200, store.rotateDevice(match[2]));
          if (match[1] === 'devices' && match[3] === 'enabled') return send(200, store.setDeviceEnabled(match[2], body.enabled));
          if (match[1] === 'vouchers' && match[3] === 'revoke') return send(200, store.revoke(match[2]));
        }
        fail(404, 'Not found');
      }
      if (path.startsWith('/api/device/')) {
        const device = store.device(bearer);
        if (req.method === 'GET' && path === '/api/device/config') return send(200, store.deviceConfig(device));
        if (req.method === 'PUT' && path === '/api/device/rates') return send(200, store.setRates(device, await jsonBody(req)));
        if (req.method === 'POST' && path === '/api/device/purchases') return send(200, store.purchase(device, await jsonBody(req)));
        fail(404, 'Not found');
      }
      fail(404, 'Not found');
    } catch (e) {
      if (e instanceof AppError) return send(e.status, req.url.startsWith('/radius/')
        ? { 'reply:Reply-Message': { op: ':=', value: e.message, do_xlat: false } }
        : { error: e.message });
      // Do not log input, voucher credentials, tokens, or SQLite bindings.
      log('Request failed:', e.code || e.name || 'Error'); return send(500, { error: 'Internal error' });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 40;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const adminToken = secret(process.env.ADMIN_TOKEN, 'ADMIN_TOKEN'), radiusToken = secret(process.env.RADIUS_TOKEN, 'RADIUS_TOKEN');
  if (equal(adminToken, radiusToken)) throw new Error('Admin and RADIUS tokens must differ');
  const store = new Store({ path: process.env.DB_PATH || './data/vouchers.sqlite', dataKey: process.env.DATA_KEY });
  const server = makeServer({ store, adminToken, radiusToken });
  const port = Number(process.env.PORT || 3100), host = process.env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('Bind to loopback; expose device routes through HTTPS proxy');
  server.listen(port, host, () => console.log(`OneDash voucher backend listening on ${host}:${port}`));
  const sweeper = setInterval(() => { try { store.sweepExpired(); } catch { console.error('Session expiry sweep failed'); } }, 5000);
  sweeper.unref();
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweeper);
    server.close(() => { store.close(); process.exit(0); });
    server.closeIdleConnections();
    // FreeRADIUS pools keep-alive sockets; bound shutdown time for service restarts.
    setTimeout(() => server.closeAllConnections(), 1000).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
}

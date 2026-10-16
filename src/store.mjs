import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new AppError(status, message); };
export const hash = value => createHash('sha256').update(String(value)).digest('hex');
export const equal = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const id = () => randomUUID();
const integer = (v, min, max, name) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail(400, `Invalid ${name}`);
  return v;
};
const label = (v, name) => {
  if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(v)) fail(400, `Invalid ${name}`);
  return v;
};
const mac = value => {
  const v = String(value || '').replace(/[:-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(v) || v === '000000000000' || v === 'FFFFFFFFFFFF') fail(403, 'Invalid client MAC');
  return v;
};

export class Store {
  constructor({ path = ':memory:', dataKey, now = () => Math.floor(Date.now() / 1000) }) {
    if (!/^[a-f0-9]{64}$/i.test(dataKey || '')) throw new Error('DATA_KEY must be 64 hexadecimal characters');
    this.key = Buffer.from(dataKey, 'hex'); this.now = now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, site TEXT NOT NULL REFERENCES sites(id), token_hash TEXT UNIQUE NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, rate_version INTEGER NOT NULL DEFAULT 1,
        rates TEXT NOT NULL, max_seconds_per_peso INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vouchers (
        id TEXT PRIMARY KEY, site TEXT NOT NULL REFERENCES sites(id), code_hash TEXT UNIQUE NOT NULL,
        total INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, bound_mac TEXT,
        revoked INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS purchases (
        device TEXT NOT NULL REFERENCES devices(id), purchase_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, response TEXT NOT NULL, created INTEGER NOT NULL,
        PRIMARY KEY(device, purchase_id));
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, voucher TEXT NOT NULL REFERENCES vouchers(id), site TEXT NOT NULL,
        nas TEXT NOT NULL, mac TEXT NOT NULL, granted INTEGER NOT NULL,
        started INTEGER NOT NULL, deadline INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
        session_id TEXT, closed INTEGER NOT NULL DEFAULT 0, close_reason TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_session ON sessions(voucher) WHERE closed=0;
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  get(sql, ...p) { return this.db.prepare(sql).get(...p); }
  all(sql, ...p) { return this.db.prepare(sql).all(...p); }
  run(sql, ...p) { return this.db.prepare(sql).run(...p); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  audit(action, target, detail = {}) { this.run('INSERT INTO audit(at,action,target,detail) VALUES(?,?,?,?)', this.now(), action, target, JSON.stringify(detail)); }
  encrypt(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const out = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), out]).toString('base64');
  }
  decrypt(value) {
    const b = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    decipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString());
  }
  createSite({ id: site, name }) {
    label(site, 'site ID');
    if (typeof name !== 'string' || !name.trim() || name.length > 100) fail(400, 'Invalid site name');
    if (this.get('SELECT id FROM sites WHERE id=?', site)) fail(409, 'Site already exists');
    this.run('INSERT INTO sites VALUES(?,?)', site, name.trim()); this.audit('site.create', site);
    return { id: site, name: name.trim() };
  }
  validateRates(rates, cap) {
    if (!Array.isArray(rates) || rates.length < 1 || rates.length > 50) fail(400, 'Supply 1–50 rate entries');
    const seen = new Set();
    return rates.map(r => {
      const amountCentavos = integer(r.amountCentavos, 100, 100000, 'amountCentavos');
      const seconds = integer(r.seconds, 60, 604800, 'seconds');
      if (seconds * 100 > amountCentavos * cap) fail(400, 'Rate exceeds device seconds-per-peso ceiling');
      if (seen.has(amountCentavos)) fail(400, 'Duplicate rate amount');
      seen.add(amountCentavos); return { amountCentavos, seconds };
    }).sort((a, b) => a.amountCentavos - b.amountCentavos);
  }
  createDevice({ id: device, site, rates, maxSecondsPerPeso = 3600 }) {
    label(device, 'device ID'); label(site, 'site ID');
    integer(maxSecondsPerPeso, 60, 86400, 'maxSecondsPerPeso');
    if (!this.get('SELECT id FROM sites WHERE id=?', site)) fail(404, 'Site not found');
    if (this.get('SELECT id FROM devices WHERE id=?', device)) fail(409, 'Device already exists');
    const validated = this.validateRates(rates, maxSecondsPerPeso), token = randomBytes(32).toString('hex');
    this.run('INSERT INTO devices(id,site,token_hash,rates,max_seconds_per_peso) VALUES(?,?,?,?,?)', device, site, hash(token), JSON.stringify(validated), maxSecondsPerPeso);
    this.audit('device.create', device, { site });
    return { id: device, site, token, rates: validated, rateVersion: 1 };
  }
  device(token) {
    const device = this.get('SELECT * FROM devices WHERE token_hash=? AND enabled=1', hash(token));
    if (!device) fail(401, 'Invalid device credential'); return device;
  }
  deviceConfig(device) { return { id: device.id, site: device.site, rates: JSON.parse(device.rates), rateVersion: device.rate_version }; }
  setRates(device, { rates, expectedVersion }) {
    integer(expectedVersion, 1, 1000000000, 'expectedVersion');
    const validated = this.validateRates(rates, device.max_seconds_per_peso);
    const result = this.run('UPDATE devices SET rates=?, rate_version=rate_version+1 WHERE id=? AND rate_version=? AND enabled=1', JSON.stringify(validated), device.id, expectedVersion);
    if (!result.changes) fail(409, 'Rate version changed; fetch device config');
    this.audit('device.rates', device.id, { rates: validated });
    return this.deviceConfig(this.get('SELECT * FROM devices WHERE id=?', device.id));
  }
  rotateDevice(deviceId) {
    const token = randomBytes(32).toString('hex');
    if (!this.run('UPDATE devices SET token_hash=? WHERE id=?', hash(token), deviceId).changes) fail(404, 'Device not found');
    this.audit('device.rotate', deviceId); return { token };
  }
  setDeviceEnabled(deviceId, enabled) {
    if (typeof enabled !== 'boolean') fail(400, 'enabled must be boolean');
    if (!this.run('UPDATE devices SET enabled=? WHERE id=?', Number(enabled), deviceId).changes) fail(404, 'Device not found');
    this.audit('device.enabled', deviceId, { enabled }); return { enabled };
  }
  issue(site, seconds) {
    label(site, 'site ID'); integer(seconds, 60, 604800, 'seconds');
    if (!this.get('SELECT id FROM sites WHERE id=?', site)) fail(404, 'Site not found');
    const code = randomBytes(12).toString('hex').toUpperCase(), voucherId = id();
    this.run('INSERT INTO vouchers(id,site,code_hash,total,created) VALUES(?,?,?,?,?)', voucherId, site, hash(code), seconds, this.now());
    this.audit('voucher.issue', voucherId, { site, seconds });
    return { voucherId, code, username: code, password: code, seconds, site };
  }
  purchase(device, input) {
    const { purchaseId, amountCentavos, rateVersion } = input;
    if (typeof purchaseId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(purchaseId)) fail(400, 'purchaseId must be 16–80 stable characters');
    integer(amountCentavos, 100, 100000, 'amountCentavos'); integer(rateVersion, 1, 1000000000, 'rateVersion');
    const fingerprint = hash(JSON.stringify([amountCentavos, rateVersion]));
    return this.transaction(() => {
      const old = this.get('SELECT * FROM purchases WHERE device=? AND purchase_id=?', device.id, purchaseId);
      if (old) {
        if (old.fingerprint !== fingerprint) fail(409, 'purchaseId reused with different purchase data');
        return this.decrypt(old.response);
      }
      const current = this.get('SELECT * FROM devices WHERE id=? AND enabled=1', device.id);
      if (!current) fail(401, 'Device disabled');
      if (current.rate_version !== rateVersion) fail(409, 'Rate version changed; retain coins and reconcile before retrying');
      const rate = JSON.parse(current.rates).find(r => r.amountCentavos === amountCentavos);
      if (!rate) fail(400, 'No exact rate for this total; configure that amount before accepting coins');
      const result = { ...this.issue(current.site, rate.seconds), purchaseId, amountCentavos, rateVersion };
      this.run('INSERT INTO purchases VALUES(?,?,?,?,?)', device.id, purchaseId, fingerprint, this.encrypt(result), this.now());
      this.audit('purchase.create', device.id, { purchaseId, voucherId: result.voucherId, amountCentavos }); return result;
    });
  }
  settleExpired(voucherId) {
    const s = this.get('SELECT * FROM sessions WHERE voucher=? AND closed=0', voucherId);
    // A lost Stop cannot grant free time. Charge the reservation when its deadline passes.
    if (s && s.deadline <= this.now()) {
      this.run('UPDATE vouchers SET used=used+? WHERE id=?', s.granted - s.used, voucherId);
      this.run("UPDATE sessions SET used=granted,closed=1,close_reason='timeout-unconfirmed' WHERE id=?", s.id);
      this.audit('session.timeout-unconfirmed', s.id);
    }
  }
  sweepExpired() {
    return this.transaction(() => {
      for (const s of this.all('SELECT voucher FROM sessions WHERE closed=0 AND deadline<=?', this.now())) this.settleExpired(s.voucher);
    });
  }
  authenticate({ site, nas, username, password, callingStationId }) {
    if (typeof username !== 'string' || !/^[A-F0-9]{24}$/.test(username) || typeof password !== 'string' || !equal(username, password)) fail(401, 'Invalid voucher');
    const clientMac = mac(callingStationId);
    // Commit expiry independently, even when the subsequent login is rejected.
    this.sweepExpired();
    return this.transaction(() => {
      const voucher = this.get('SELECT * FROM vouchers WHERE code_hash=? AND site=?', hash(username), site);
      if (!voucher || voucher.revoked) fail(401, 'Invalid voucher');
      if (voucher.bound_mac && voucher.bound_mac !== clientMac) fail(403, 'Voucher bound to another device');
      const active = this.get('SELECT * FROM sessions WHERE voucher=? AND closed=0', voucher.id);
      let session = active;
      if (active) {
        // Brief same-client retry window for lost Access-Accept; never extend its deadline.
        if (active.session_id || active.nas !== nas || active.mac !== clientMac || this.now() - active.started > 15) fail(403, 'Session already active or awaiting accounting');
      } else {
        const updated = this.get('SELECT * FROM vouchers WHERE id=?', voucher.id), remaining = updated.total - updated.used;
        if (remaining < 1) fail(403, 'Voucher exhausted');
        session = { id: 'oda-' + randomBytes(16).toString('hex'), granted: remaining, started: this.now(), deadline: this.now() + remaining };
        this.run('UPDATE vouchers SET bound_mac=? WHERE id=?', clientMac, voucher.id);
        this.run('INSERT INTO sessions(id,voucher,site,nas,mac,granted,started,deadline) VALUES(?,?,?,?,?,?,?,?)', session.id, voucher.id, site, nas, clientMac, remaining, session.started, session.deadline);
        this.audit('session.authorize', session.id, { voucherId: voucher.id });
      }
      return {
        'reply:Session-Timeout': { op: ':=', value: session.deadline - this.now() },
        'reply:Acct-Interim-Interval': { op: ':=', value: 60 },
        'reply:Class': { op: ':=', value: session.id }
      };
    });
  }
  accounting({ site, nas, username, classId, sessionId, status, seconds, callingStationId }) {
    if (!['Start', 'Interim-Update', 'Stop'].includes(status)) fail(400, 'Unsupported accounting status');
    if (typeof classId !== 'string' || !/^oda-[a-f0-9]{32}$/.test(classId)) fail(400, 'Missing or invalid Class: confirm EAP echoes it');
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) fail(400, 'Invalid Acct-Session-Id');
    integer(seconds, 0, 31536000, 'Acct-Session-Time');
    if (status === 'Start' && seconds !== 0) fail(400, 'Start must have zero session time');
    const clientMac = mac(callingStationId);
    return this.transaction(() => {
      const s = this.get('SELECT * FROM sessions WHERE id=? AND site=? AND nas=?', classId, site, nas);
      const v = s && this.get('SELECT * FROM vouchers WHERE id=?', s.voucher);
      if (!s || !v || v.code_hash !== hash(username) || s.mac !== clientMac) fail(403, 'Accounting ownership mismatch');
      if (s.session_id && s.session_id !== sessionId) fail(409, 'Conflicting Acct-Session-Id');
      if (s.closed) return { ok: true, duplicate: true };
      const used = Math.max(s.used, Math.min(seconds, s.granted));
      this.run('UPDATE vouchers SET used=used+? WHERE id=?', used - s.used, s.voucher);
      this.run('UPDATE sessions SET used=?,session_id=?,closed=?,close_reason=? WHERE id=?', used, sessionId, status === 'Stop' ? 1 : 0, status === 'Stop' ? 'accounting-stop' : null, s.id);
      if (status === 'Stop') this.audit('session.stop', s.id, { used });
      return { ok: true };
    });
  }
  vouchers(site) {
    label(site, 'site ID');
    this.sweepExpired();
    // Report confirmed usage separately from the live reservation.
    return this.all(`SELECT v.id,v.site,v.total AS totalSeconds,v.used AS confirmedUsedSeconds,
      v.total-v.used AS unspentSeconds,v.bound_mac AS boundMac,v.revoked,v.created,
      s.id AS activeSession,s.deadline AS sessionDeadline,s.session_id AS radiusSessionId
      FROM vouchers v LEFT JOIN sessions s ON s.voucher=v.id AND s.closed=0
      WHERE v.site=? ORDER BY v.created DESC,v.id LIMIT 500`, site);
  }
  revoke(voucherId) {
    if (!this.run('UPDATE vouchers SET revoked=1 WHERE id=?', voucherId).changes) fail(404, 'Voucher not found');
    this.audit('voucher.revoke', voucherId);
    return { revoked: true, note: 'Blocks future logins. Existing sessions continue until their timeout or manual AP disconnect.' };
  }
}

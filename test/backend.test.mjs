import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { makeServer } from '../src/server.mjs';

const key = 'a'.repeat(64), admin = 'b'.repeat(64), radius = 'c'.repeat(64);
function fixture(path = ':memory:') {
  let now = 100000;
  const store = new Store({ path, dataKey: key, now: () => now });
  store.createSite({ id: 'lab', name: 'Lab' });
  store.createSite({ id: 'other', name: 'Other operator' });
  const d = store.createDevice({ id: 'esp1', site: 'lab', rates: [{ amountCentavos: 100, seconds: 600 }, { amountCentavos: 500, seconds: 3600 }] });
  return { store, d, device: store.device(d.token), advance: seconds => { now += seconds; } };
}
const buy = (f, overrides = {}) => f.store.purchase(f.device, { purchaseId: 'purchase-000000001', amountCentavos: 100, rateVersion: 1, ...overrides });
const authInput = v => ({ site: 'lab', nas: '10.0.0.2', username: v.code, password: v.code, callingStationId: '02:11:22:33:44:55' });
const authenticate = (f, v, overrides = {}) => f.store.authenticate({ ...authInput(v), ...overrides });
const accounting = (f, v, reply, status, seconds, overrides = {}) => f.store.accounting({ ...authInput(v), classId: reply['reply:Class'].value, sessionId: 'session-1', status, seconds, ...overrides });

test('purchase retry returns identical encrypted receipt and creates only one voucher', t => {
  const f = fixture(); t.after(() => f.store.close()); const v = buy(f);
  assert.deepEqual(buy(f), v); assert.equal(f.store.get('SELECT count(*) n FROM vouchers').n, 1);
  const row = f.store.get('SELECT response FROM purchases'); assert.ok(!row.response.includes(v.code));
  assert.throws(() => buy(f, { amountCentavos: 500 }), /different purchase data/);
});
test('rate changes preserve historical retries but reject stale new purchases', t => {
  const f = fixture(); t.after(() => f.store.close()); const original = buy(f);
  const result = f.store.setRates(f.device, { expectedVersion: 1, rates: [{ amountCentavos: 100, seconds: 120 }] });
  assert.equal(result.rateVersion, 2); assert.deepEqual(buy(f), original);
  assert.throws(() => buy(f, { purchaseId: 'purchase-000000002' }), /Rate version changed/);
  assert.equal(buy(f, { purchaseId: 'purchase-000000002', rateVersion: 2 }).seconds, 120);
  assert.throws(() => f.store.setRates(f.device, { expectedVersion: 1, rates: [{ amountCentavos: 100, seconds: 100 }] }), /version changed/);
});
test('rejects unconfigured totals, invalid money and excessive rate settings', t => {
  const f = fixture(); t.after(() => f.store.close());
  assert.throws(() => buy(f, { amountCentavos: 200 }), /No exact rate/);
  assert.throws(() => buy(f, { amountCentavos: 1.5 }), /Invalid/);
  assert.throws(() => f.store.setRates(f.device, { expectedVersion: 1, rates: [{ amountCentavos: 100, seconds: 9999 }] }), /ceiling/);
  assert.equal(f.store.get('SELECT count(*) n FROM purchases').n, 0);
});
test('rotation and disabling invalidate device access', t => {
  const f = fixture(); t.after(() => f.store.close());
  const next = f.store.rotateDevice('esp1'); assert.throws(() => f.store.device(f.d.token), /credential/);
  assert.equal(f.store.device(next.token).id, 'esp1');
  f.store.setDeviceEnabled('esp1', false); assert.throws(() => f.store.device(next.token), /credential/);
});
test('authentication rejects wrong password, another site, and another MAC', t => {
  const f = fixture(); t.after(() => f.store.close()); const v = buy(f);
  assert.throws(() => authenticate(f, v, { password: 'wrong' }), /Invalid voucher/);
  assert.throws(() => authenticate(f, v, { site: 'other' }), /Invalid voucher/);
  authenticate(f, v);
  assert.throws(() => authenticate(f, v, { callingStationId: '02:00:00:00:00:01' }), /bound/);
});
test('short auth retry never extends deadline and cannot switch NAS', t => {
  const f = fixture(); t.after(() => f.store.close()); const v = buy(f), reply = authenticate(f, v);
  f.advance(5); const retry = authenticate(f, v);
  assert.equal(retry['reply:Class'].value, reply['reply:Class'].value);
  assert.equal(retry['reply:Session-Timeout'].value, 595);
  assert.throws(() => authenticate(f, v, { nas: '10.0.0.3' }), /active/);
  f.advance(11); assert.throws(() => authenticate(f, v), /active/);
});
test('usage counts cumulative accounting once and reconnect receives only remainder', t => {
  const f = fixture(); t.after(() => f.store.close()); const v = buy(f), reply = authenticate(f, v);
  accounting(f, v, reply, 'Start', 0);
  assert.throws(() => authenticate(f, v), /active/);
  accounting(f, v, reply, 'Interim-Update', 60);
  accounting(f, v, reply, 'Interim-Update', 60);
  accounting(f, v, reply, 'Interim-Update', 30);
  assert.equal(f.store.get('SELECT used FROM vouchers').used, 60);
  accounting(f, v, reply, 'Stop', 120);
  accounting(f, v, reply, 'Stop', 120);
  accounting(f, v, reply, 'Interim-Update', 180);
  assert.equal(f.store.get('SELECT used FROM vouchers').used, 120);
  f.advance(5000); assert.equal(authenticate(f, v)['reply:Session-Timeout'].value, 480);
});
test('full use prevents reuse', t => {
  const f = fixture(); t.after(() => f.store.close()); const v = buy(f), reply = authenticate(f, v);
  accounting(f, v, reply, 'Stop', 600); assert.throws(() => authenticate(f, v), /exhausted/);
});
test('missing accounting fails closed and consumes the unconfirmed reservation', t => {
  const f = fixture(); t.after(() => f.store.close()); const v = buy(f);
  authenticate(f, v); f.advance(601); assert.throws(() => authenticate(f, v), /exhausted/);
  assert.equal(f.store.get('SELECT used FROM vouchers').used, 600);
  assert.equal(f.store.get('SELECT closed FROM sessions').closed, 1);
  assert.throws(() => authenticate(f, v), /exhausted/);
});
test('foreign and malformed accounting cannot modify balance', t => {
  const f = fixture(); t.after(() => f.store.close()); const v = buy(f), reply = authenticate(f, v);
  for (const overrides of [{ site: 'other' }, { nas: 'other' }, { username: 'OTHER' }, { callingStationId: '02:00:00:00:00:09' }]) {
    assert.throws(() => accounting(f, v, reply, 'Stop', 50, overrides), /mismatch/);
  }
  assert.throws(() => accounting(f, v, reply, 'Stop', -10), /Invalid/);
  assert.throws(() => accounting(f, v, reply, 'Start', 20), /zero/);
  assert.throws(() => accounting(f, v, reply, 'Stop', 20, { classId: '' }), /Class/);
  accounting(f, v, reply, 'Start', 0);
  assert.throws(() => accounting(f, v, reply, 'Stop', 20, { sessionId: 'other' }), /Conflicting/);
  assert.equal(f.store.get('SELECT used FROM vouchers').used, 0);
});
test('revocation blocks new login but accepts final accounting', t => {
  const f = fixture(); t.after(() => f.store.close()); const v = buy(f), reply = authenticate(f, v);
  f.store.revoke(v.voucherId); accounting(f, v, reply, 'Stop', 10);
  assert.throws(() => authenticate(f, v), /Invalid voucher/);
  assert.equal(f.store.get('SELECT used FROM vouchers').used, 10);
});
test('state and idempotent purchase survive process/store restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'oda-test-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(path), v = buy(f), reply = authenticate(f, v); accounting(f, v, reply, 'Start', 0); f.store.close();
  const reopened = new Store({ path, dataKey: key, now: () => 100002 }); t.after(() => reopened.close());
  assert.deepEqual(reopened.purchase(reopened.device(f.d.token), { purchaseId: 'purchase-000000001', amountCentavos: 100, rateVersion: 1 }), v);
  assert.throws(() => reopened.authenticate(authInput(v)), /active/);
});
test('second device purchase key is scoped independently but vouchers remain site scoped', t => {
  const f = fixture(); t.after(() => f.store.close()); const first = buy(f);
  const second = f.store.createDevice({ id: 'esp2', site: 'other', rates: [{ amountCentavos: 100, seconds: 60 }] });
  const v = f.store.purchase(f.store.device(second.token), { purchaseId: first.purchaseId, amountCentavos: 100, rateVersion: 1 });
  assert.notEqual(v.voucherId, first.voucherId); assert.equal(v.site, 'other');
  assert.throws(() => authenticate(f, v), /Invalid voucher/);
});

function attributes(values) { return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { type: typeof v === 'number' ? 'integer' : 'string', value: [v] }])); }
test('real HTTP routes enforce auth and support FreeRADIUS JSON contract', async t => {
  const f = fixture(); const server = makeServer({ store: f.store, adminToken: admin, radiusToken: radius });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, token, headers = {}, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await request('/api/admin/sites', { id: 'evil', name: 'evil' }, f.d.token)).status, 401);
  assert.equal((await request('/api/device/purchases', {}, admin)).status, 401);
  const res = await request('/api/device/purchases', { purchaseId: 'http-purchase-00001', amountCentavos: 100, rateVersion: 1 }, f.d.token);
  assert.equal(res.status, 200); const v = await res.json();
  const values = { 'User-Name': v.code, 'User-Password': v.code, 'Calling-Station-Id': '02:11:22:33:44:55' };
  const headers = { 'X-Site-ID': 'lab', 'X-Nas-IP': '10.0.0.2' };
  assert.equal((await request('/radius/authenticate', attributes(values), f.d.token, headers)).status, 401);
  assert.equal((await request('/radius/authenticate', attributes(values), radius)).status, 400);
  const auth = await request('/radius/authenticate', attributes(values), radius, headers);
  assert.equal(auth.status, 200); const reply = await auth.json(); assert.equal(reply['reply:Session-Timeout'].value, 600);
  const acct = attributes({ ...values, Class: '0x' + Buffer.from(reply['reply:Class'].value).toString('hex'), 'Acct-Session-Id': 'http-session', 'Acct-Status-Type': 2, 'Acct-Session-Time': 120 });
  assert.equal((await request('/radius/accounting', acct, radius, headers)).status, 204);
  assert.equal(f.store.get('SELECT used FROM vouchers').used, 120);
  delete acct['Acct-Session-Time']; assert.equal((await request('/radius/accounting', acct, radius, headers)).status, 400);
  const list = await request('/api/admin/vouchers?site=lab', null, admin, {}, 'GET');
  const text = await list.text(); assert.ok(!text.includes(v.code)); assert.ok(!text.includes('code_hash'));
  assert.equal((await request('/api/device/purchases', { bad: 'x'.repeat(40000) }, f.d.token)).status, 413);
});

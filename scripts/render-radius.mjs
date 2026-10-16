import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const [output = './generated-radius', site = 'lab', source = '127.0.0.1'] = process.argv.slice(2);
if (!/^[a-f0-9]{64}$/.test(process.env.RADIUS_TOKEN || '')) throw new Error('Load .env containing RADIUS_TOKEN');
if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(site)) throw new Error('Invalid site ID');
if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(source) || source.split('.').some(n => Number(n) > 255)) throw new Error('Source must be one IPv4 address, no wildcard');
mkdirSync(output, { recursive: true, mode: 0o700 });
for (const [template, target] of [['onedash-rest.template', 'onedash_rest'], ['onedash-site.template', 'onedash']]) {
  const text = readFileSync(fileURLToPath(new URL('../deploy/' + template, import.meta.url)), 'utf8').replaceAll('__RADIUS_TOKEN__', process.env.RADIUS_TOKEN);
  writeFileSync(resolve(output, target), text, { flag: 'wx', mode: 0o600 });
}
const radiusSecret = randomBytes(32).toString('hex');
writeFileSync(resolve(output, 'clients.conf'), `# One exact source per site/AP; this replaces default test clients on a dedicated host.\nclient onedash_${site} {\n    ipaddr = ${source}\n    secret = ${radiusSecret}\n    shortname = ${site}\n    require_message_authenticator = yes\n}\n`, { flag: 'wx', mode: 0o600 });
writeFileSync(resolve(output, 'client-secret'), radiusSecret + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Created ${output}. Client secret is stored in client-secret, not printed. Keep generated files private.`);

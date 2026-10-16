import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const path = process.argv[2] || '.env';
const body = `HOST=127.0.0.1\nPORT=3100\nDB_PATH=./data/vouchers.sqlite\nADMIN_TOKEN=${randomBytes(32).toString('hex')}\nRADIUS_TOKEN=${randomBytes(32).toString('hex')}\nDATA_KEY=${randomBytes(32).toString('hex')}\n`;
writeFileSync(path, body, { flag: 'wx', mode: 0o600 });
console.log(`Created ${path}. Keep it private and back it up with the database.`);

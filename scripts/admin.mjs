// Run with node --env-file=.env scripts/admin.mjs METHOD /api/admin/path '{"json":"body"}'
const [method, path, raw] = process.argv.slice(2);
if (!['GET', 'POST'].includes(method) || !path?.startsWith('/api/admin/') || !process.env.ADMIN_TOKEN) {
  console.error('Usage: node --env-file=.env scripts/admin.mjs GET|POST /api/admin/... [JSON]'); process.exit(1);
}
const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3100}${path}`, {
  method, headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
  body: raw ? JSON.stringify(JSON.parse(raw)) : undefined
});
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;

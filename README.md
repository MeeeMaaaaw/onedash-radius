# OneDash RADIUS voucher backend — pilot v0.1.0

Node.js 24 + SQLite + FreeRADIUS 3.x REST integration for a standalone TP-Link EAP coin-slot project. No npm dependencies, MongoDB, or Omada Controller.

**Start with [SETUP-UBUNTU.md](SETUP-UBUNTU.md).** This is an executable backend and server configuration, not ESP firmware or a customer-facing portal. Use the EAP's built-in External RADIUS portal for the first hardware test. The complete coin-slot product still needs ESP firmware, a coin insertion ownership flow, and a custom portal if automatic login is wanted.

## Architecture

- ESP sends coin purchases over HTTPS to the Node API. It never connects directly to the database and does not contain an admin token.
- ESP rate settings are mirrored through its authenticated rate API. Backend validates the total against that rate version and an administrator-set seconds-per-peso ceiling.
- Backend generates a random 96-bit voucher code. Use that code as BOTH username and password on the EAP portal.
- EAP sends PAP Access-Requests to FreeRADIUS. FreeRADIUS calls the local Node REST adapter, then returns Session-Timeout, Class, and Acct-Interim-Interval.
- EAP enforces access and reports accounting. Node records cumulative session time without counting duplicates twice.
- Browsing traffic continues through the customer's ISP. It does not pass through the VPS.

## Implemented behavior

| Feature | Behavior |
|---|---|
| Site separation | RADIUS client shortname selects the trusted site; devices can create vouchers only in their assigned site |
| Coin purchases | Exact configured amount in integer centavos; server determines seconds |
| ESP rate settings | GET config and versioned PUT rates; ceiling controlled by admin |
| Purchase retries | Same device + purchaseId returns the same voucher; conflicting payload returns 409 |
| Persistence | SQLite WAL transactions; survives process restart |
| Time policy | Authenticated session usage; unspent time remains after a confirmed Stop |
| Concurrent use | One reservation/session per voucher; first login binds voucher to normalized client MAC |
| Missing accounting | Reservation stays locked; at its deadline the full unconfirmed grant is charged |
| Revocation | Blocks future logins; active session ends at its existing timeout or manual AP disconnect |
| Credential storage | Device tokens and voucher codes hashed; purchase responses encrypted for safe retries |
| Operator access | Local admin API and command-line helper; no admin dashboard in this version |

No speed-limit attributes, CoA/disconnect automation, voucher top-up, refunds, pause button, offline vending, billing portal, or automatic AP onboarding are included. Those depend on tested AP capabilities and later workflow choices. This version targets a single backend process and database on one host.

## Time accounting: exact meaning and limits

This measures authenticated session time reported by the AP, not active browsing time. Turning off Wi-Fi may not immediately end an AP session; test the EAP's idle/disconnect behavior. Phone sleep, roaming, and lost Stop packets must be tested before advertising “only while connected.”

Example: 600 seconds purchased; final Stop reports 120 seconds; next login receives 480 seconds. Interim reports 60, 60, then 30 still deduct only 60, because counters are cumulative. A new session gets its own Class identifier and accounting session ID.

A missing Start or Stop does not release a reservation. After the original authorization deadline, its entire granted duration is consumed conservatively. The software does not manufacture unused credit based on a missing packet. A late Stop after finalization cannot refund it. This favors preventing free reuse and may require operator compensation after an outage. Check audit events `session.timeout-unconfirmed`. Do not delete database rows to “fix” balances.

Within 15 seconds of authorization, a retry for the same voucher/MAC/NAS may receive the same Class with a reduced timeout. It cannot extend the original deadline. After accounting starts, a new Access-Request is rejected until Stop or timeout. This strict behavior may require a reconnect after stale AP sessions; verify against your EAP before rollout.

## Local development

Install Node.js 24, then:

```bash
node scripts/init-env.mjs .env
node --test test/*.test.mjs
node --env-file=.env src/server.mjs
```

Another terminal:

```bash
node --env-file=.env scripts/admin.mjs POST /api/admin/sites '{"id":"lab","name":"EAP lab"}'
node --env-file=.env scripts/admin.mjs POST /api/admin/devices '{"id":"esp-lab","site":"lab","rates":[{"amountCentavos":100,"seconds":600},{"amountCentavos":500,"seconds":3600}]}'
```

Keep the returned device token private. A device credential is authority to report sales for that device; the server cannot independently verify physical coin insertion. Compromised keys must be rotated or disabled.

## API contract

All POST/PUT bodies are JSON. Money uses centavos; time uses seconds. All protected routes require `Authorization: Bearer TOKEN`. Body limit: 32 KiB. Admin and RADIUS routes stay on loopback; publish only `/api/device/` via HTTPS.

### Admin token

| Method | Path | Body / result |
|---|---|---|
| POST | /api/admin/sites | `{ "id":"lab", "name":"Lab" }` |
| GET | /api/admin/sites | Site list |
| POST | /api/admin/devices | `{ "id":"esp-lab", "site":"lab", "rates":[{"amountCentavos":100,"seconds":600}], "maxSecondsPerPeso":3600 }`; returns token once |
| GET | /api/admin/devices | Device status; no credentials |
| POST | /api/admin/devices/esp-lab/rotate | `{}`; returns replacement token |
| POST | /api/admin/devices/esp-lab/enabled | `{ "enabled":false }` |
| POST | /api/admin/vouchers | `{ "site":"lab", "seconds":60 }`; creates manual/test voucher |
| GET | /api/admin/vouchers?site=lab | Latest 500 vouchers; confirmed usage and active reservation shown separately |
| POST | /api/admin/vouchers/VOUCHER_ID/revoke | `{}`; prevents future login |
| GET | /api/admin/audit | Latest 200 audit events |

Admin manual voucher creation is not idempotent: if a response is lost, inspect the voucher list before retrying. Device purchase creation IS idempotent.

### Device token

`GET /api/device/config` returns device/site IDs, `rateVersion`, and the exact rate list.

`PUT /api/device/rates` mirrors edits from ESP settings:

```json
{"expectedVersion":1,"rates":[{"amountCentavos":100,"seconds":600},{"amountCentavos":200,"seconds":1200},{"amountCentavos":500,"seconds":3600}]}
```

Each amount must have an explicit entry. There is no implicit greedy bundle calculation. Do not accept coin totals your current table cannot price. A successful update increments rateVersion; save the returned version on the ESP. Avoid edits during an unfinished coin transaction.

`POST /api/device/purchases`:

```json
{"purchaseId":"esp-lab-000000000001","amountCentavos":500,"rateVersion":2}
```

Example shape of response (actual credentials are random):

```json
{"voucherId":"uuid","code":"24_HEX_CHARACTERS","username":"same-code","password":"same-code","seconds":3600,"site":"lab","purchaseId":"esp-lab-000000000001","amountCentavos":500,"rateVersion":2}
```

ESP requirements:

1. Create a unique purchaseId and persist it with coins received BEFORE sending the request.
2. Lock the coin insertion session to one customer; debounce and calibrate coin pulses.
3. Retry a timeout with exactly the same ID, amount and rateVersion. Do not generate a new ID for the same money.
4. Save the successful voucher before clearing pending coins. Recover pending transactions after reboot.
5. On 409 rate conflict, retain pending money and show a reconciliation error; do not silently clear it or change transaction details.
6. Disable accepting new coins when the service cannot fulfill a purchase. Physical acceptor inhibition needs hardware/firmware support.
7. Validate HTTPS certificates; do not use insecure TLS. Give each ESP its own key.

### Internal RADIUS REST

FreeRADIUS's default JSON attribute encoder is used; no hand-built JSON interpolation is needed. Authentication requests include User-Name, User-Password and Calling-Station-Id. Accounting also requires Class (echoed from Access-Accept), Acct-Session-Id, Acct-Status-Type and Acct-Session-Time. Source/site headers are set by the trusted virtual server, not the portal.

Only PAP hotspot authentication is supported. CHAP, MSCHAP and WPA-Enterprise are intentionally outside this pilot. Start/Interim-Update/Stop are supported; other accounting types currently return an error and do not release reservations.

## Operational notes

- Use a dedicated VM/VPS for the installer. It does not alter an existing Node runtime or open firewall ports.
- Keep `/etc/onedash-radius.env` and the database in the same backup set. Losing DATA_KEY prevents recovering encrypted purchase responses. Keep DATA_KEY stable during upgrades.
- Stop the backend briefly for a filesystem backup of the full data directory, then restart it. Do not copy only the live SQLite main file while WAL writes are active.
- Admin token and RADIUS token are separate. Device tokens are independently revocable.
- Production logging omits credentials. `freeradius -X` is a temporary diagnostic mode and may display voucher passwords and REST credentials; do not publish its full output.
- The global HTTP safeguard limits API requests to 300/minute per source; behind the supplied proxy all devices share the loopback bucket. This is intentional for a small pilot, not a nationwide capacity claim. Load-test and design trusted per-device limits before scaling.
- Use HTTPS for device calls and a private tunnel for off-site RADIUS. Do not expose UDP RADIUS to arbitrary sources or identify different operators merely by an untrusted NAS-Identifier.

## Validation status

Backend behavior tests and real FreeRADIUS 3.2.5 UDP integration were run during preparation. See VALIDATION.md for precise scope. No EAP hardware, ESP hardware, production server, systemd install, or public HTTPS deployment was available for testing. Treat this as a tested server pilot pending hardware acceptance, not a completed commercial coin-slot system.

## References

- TP-Link standalone portal guide: https://www.tp-link.com/us/configuration-guides/configuring_eap_standalone_eap/
- FreeRADIUS 3 REST implementation/configuration: https://github.com/FreeRADIUS/freeradius-server/tree/v3.2.x/src/modules/rlm_rest and the installed `/etc/freeradius/3.0/mods-available/rest`
- FreeRADIUS accounting counters: https://wiki.freeradius.org/modules/Rlm_sqlcounter (conceptual reference; this project keeps its usage ledger in Node/SQLite)
- Node.js official downloads: https://nodejs.org/en/download

Do not paste FreeRADIUS 4 configuration examples into the included FreeRADIUS 3 setup; syntax differs.

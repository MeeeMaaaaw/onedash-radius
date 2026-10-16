# Validation — 2026-10-15

## Passed

- Node.js v24.19.0: 14 automated test groups, 14 passed, 0 failed.
- Purchase idempotency, changed-payload rejection, rate version conflicts, amount validation, rate ceilings.
- Token rotation/disable, wrong credentials, cross-site isolation, first-MAC binding.
- Authorization retry deadline, single active reservation, cumulative accounting deduplication and out-of-order handling.
- Stop/reconnect with remaining balance, exhausted rejection, conservative missing-accounting expiry.
- Accounting ownership and session ID checks, revocation, persistent state across SQLite reopen.
- Real HTTP route authentication, request-size limits, FreeRADIUS JSON attribute shapes and hex Class decoding.
- Ubuntu 24.04 FreeRADIUS 3.2.5 with rlm_rest: configuration syntax check passed in an isolated test configuration using the supplied module and virtual-server templates.
- Real UDP RADIUS -> FreeRADIUS -> HTTP -> Node -> SQLite integration: wrong password rejected; correct password accepted with 60-second Session-Timeout and Class; Start, duplicate Interim and Stop accepted; reconnect granted 40 remaining seconds; exhausted voucher rejected.
- Malformed accounting without Class received no acknowledgment, allowing client retry rather than silently dropping an unrecorded update.
- Backend unavailable: FreeRADIUS rejected access.
- Bash syntax checks for installer/configuration scripts; JavaScript syntax and Python compilation checks.

## Scope and remaining checks

The real FreeRADIUS test used extracted Ubuntu packages, synthetic credentials, localhost UDP ports 19120/19130 and an isolated configuration. Standard deployment ports are 1812/1813. No production data or server was used.

The installation scripts were syntax checked, not executed against a full systemd Ubuntu host. Private Node download, package installation, service user creation, backup/rollback, provider firewall and HTTPS configuration need validation on the target host.

No physical EAP110 or ESP was available. Confirm PAP, Message-Authenticator, RADIUS Session-Timeout enforcement, Class echo, Start/Interim/Stop reliability, and disconnected-phone behavior before enabling paid service. No load/capacity guarantee is made. A live multi-site VPN/NAT test remains required before deployment across operators.

Reproduce backend tests with `node --test test/*.test.mjs`. Reproduce server integration after installation using `scripts/radius-smoke.py` as described in SETUP-UBUNTU.md. The test deliberately synthesizes accounting; it is not evidence of physical AP disconnection.

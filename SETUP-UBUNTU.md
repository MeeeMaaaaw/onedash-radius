# Ubuntu 24.04 setup and EAP110 acceptance test

Use a fresh Ubuntu 24.04 VM or dedicated VPS. Start with one EAP and one site. A local VM on a bridged LAN is the easiest hardware test; a remote VPS needs a reachable RADIUS path. No access to your server is assumed or included.

## 1. Install the backend and prerequisites

Upload and extract the project ZIP, then enter its `onedash-radius` directory. Confirm:

```bash
cat /etc/os-release
uname -m
free -h
df -h /
```

On a fresh dedicated Ubuntu 24.04 host:

```bash
sudo bash scripts/install-ubuntu.sh
```

This installs FreeRADIUS, its REST module and utilities, a private current Node 24 runtime (HTTPS download with SHA-256 verification), a service account, fresh secrets, and the Node systemd service. It does not replace your system Node binary. It refuses to overwrite an existing OneDash installation. It leaves FreeRADIUS configuration for the next step and opens no firewall ports.

Expected backend check:

```bash
curl -fsS http://127.0.0.1:3100/healthz
sudo systemctl status onedash-radius --no-pager
```

The HTTP result should be `{"ok":true}`. If not, inspect `sudo journalctl -u onedash-radius -n 50 --no-pager`. Do not send the contents of `/etc/onedash-radius.env` to others.

## 2. Create a lab site and ESP device

Run on the server:

```bash
cd /opt/onedash-radius
sudo /opt/onedash-node24/bin/node --env-file=/etc/onedash-radius.env scripts/admin.mjs POST /api/admin/sites '{"id":"lab","name":"EAP110 test site"}'
sudo /opt/onedash-node24/bin/node --env-file=/etc/onedash-radius.env scripts/admin.mjs POST /api/admin/devices '{"id":"esp-lab","site":"lab","rates":[{"amountCentavos":100,"seconds":600},{"amountCentavos":200,"seconds":1200},{"amountCentavos":500,"seconds":3600}],"maxSecondsPerPeso":3600}'
```

Store the returned ESP device token securely. It is separate from the RADIUS shared secret. The example rates are editable; they are not hard-coded business prices.

## 3. Configure FreeRADIUS for a local server test

Generate one exact localhost client bound to the `lab` site:

```bash
cd /opt/onedash-radius
sudo /opt/onedash-node24/bin/node --env-file=/etc/onedash-radius.env scripts/render-radius.mjs /root/onedash-radius-lab lab 127.0.0.1
sudo bash scripts/enable-radius.sh /root/onedash-radius-lab
```

The enable script backs up `/etc/freeradius/3.0`, disables the stock default and inner-tunnel virtual-server links on this dedicated host, installs the custom PAP-only server, replaces default test clients, checks `freeradius -XC`, and restarts FreeRADIUS only after validation. It restores its prior configuration if validation or restart fails. Do not run it on a server already serving PPPoE, Wi-Fi enterprise, or another RADIUS workload.

Check:

```bash
sudo systemctl status freeradius --no-pager
sudo ss -lunp
sudo python3 /opt/onedash-radius/scripts/radius-smoke.py --secret-file /root/onedash-radius-lab/client-secret
```

The smoke test creates a 60-second voucher and sends real UDP packets: wrong-password rejection, successful login, accounting updates, duplicate update, stop, reconnect with 40 seconds left, and final exhausted rejection. It prints PASS only when those assertions succeed. The simulated accounting is deliberately accelerated and does not test an AP's clock or disconnection.

If the test fails, inspect backend logs and `sudo journalctl -u freeradius -n 50 --no-pager`. For temporary RADIUS debug, stop the service then run `sudo freeradius -X`; use another terminal for the test. Stop debug and restart the service afterward. Debug output contains secrets—share only a redacted error section.

## 4. Add the actual EAP as a RADIUS client

FreeRADIUS identifies clients by the source IP that reaches it, not the EAP's claimed NAS-IP-Address. For a bridged local VM, this will normally be the EAP's LAN IP. Across a VPN, use the unique routed source IP seen by the server. Across ordinary NAT, it may be the site's public IP. Two operators behind the same CGNAT address cannot be securely separated with this static-source design; use separate private tunnel addresses.

Keep the localhost test client. Append a new block to `/etc/freeradius/3.0/clients.conf`, using your actual address and a new secret:

```text
client eap_lab {
    ipaddr = 192.168.1.20
    secret = REPLACE_WITH_64_RANDOM_HEX_CHARACTERS
    shortname = lab
    require_message_authenticator = yes
}
```

Generate a secret on the server with `openssl rand -hex 32`, then put that same value in the EAP's RADIUS settings. Never use the sample placeholder. `shortname` MUST equal an existing backend site ID; do not trust a site name supplied by the customer portal.

```bash
sudo freeradius -XC
sudo systemctl restart freeradius
```

If UFW is already enabled, allow only the actual EAP/tunnel source (replace the example IP):

```bash
sudo ufw allow from 192.168.1.20 to any port 1812 proto udp
sudo ufw allow from 192.168.1.20 to any port 1813 proto udp
```

Apply equivalent source restrictions in your VPS provider firewall. Do not enable UFW blindly on an SSH server before preserving SSH access. Keep TCP 3100 private. For off-site production use, route RADIUS through a VPN on the site's gateway; the ESP's outbound HTTPS connection alone does not provide the EAP a RADIUS tunnel.

## 5. Configure the standalone EAP

Exact labels vary with firmware. On the EAP's portal settings:

| Setting | Value |
|---|---|
| Portal authentication | External RADIUS Server |
| Portal page | Local Web Portal for the first test |
| RADIUS server | VM LAN IP or reachable VPS/tunnel IP |
| Authentication port | 1812 |
| Shared secret | Secret from `client eap_lab` |
| RADIUS accounting | Enabled |
| Accounting server / port | Same server / 1813 |
| Accounting interim interval | 60 seconds, if configurable |
| Portal SSID | Enable portal on the intended test SSID |

Set the EAP's static/global portal timeout longer than the test voucher (for example one hour). The test must prove that the RADIUS reply's 60-second limit takes precedence. Do not assume it does. PAP User-Password must be sent by this portal; CHAP-only firmware will not work with this adapter.

Current configuration requires Message-Authenticator on Access-Request. If older firmware does not send it, update firmware or resolve compatibility within a protected deployment; do not disable the check on a publicly exposed RADIUS server just to make a login pass.

## 6. Physical 60-second expiry test — required

Create a voucher:

```bash
cd /opt/onedash-radius
sudo /opt/onedash-node24/bin/node --env-file=/etc/onedash-radius.env scripts/admin.mjs POST /api/admin/vouchers '{"site":"lab","seconds":60}'
```

1. Connect a test phone to the portal SSID.
2. Enter the returned code as both username and password.
3. Verify internet access begins. Observe the returned `Session-Timeout = 60` and Class in a redacted RADIUS trace if needed.
4. Confirm EAP accounting Start contains the SAME Class value plus Acct-Session-Id and Calling-Station-Id. Missing Class is a compatibility blocker for this implementation.
5. Leave the phone connected and verify internet access stops at roughly 60 seconds. Check actual network access, not just the portal's countdown.
6. Attempt login again: it must be rejected.

Create a fresh 180-second voucher for a second test: use approximately 60 seconds, disconnect, wait for a confirmed Stop, then reconnect. The new timeout must reflect the remaining balance. A Wi-Fi toggle alone may not trigger immediate Stop; determine the AP's session/idle behavior. Check sleep, AP restart, lost network, missing Stop, and a second phone trying the same voucher.

Inspect state:

```bash
sudo /opt/onedash-node24/bin/node --env-file=/etc/onedash-radius.env scripts/admin.mjs GET '/api/admin/vouchers?site=lab'
sudo /opt/onedash-node24/bin/node --env-file=/etc/onedash-radius.env scripts/admin.mjs GET /api/admin/audit
```

`unspentSeconds` is based on confirmed accounting, not a live countdown. An active reservation is not spendable by another login. If `session.timeout-unconfirmed` appears, fix accounting before accepting coins. Do not promise pause-on-Wi-Fi-off until this test passes.

## 7. Expose ESP purchase endpoints over HTTPS

After the EAP test passes, provision a DNS name and trusted TLS certificate, then adapt `deploy/nginx-device-api.conf`. It exposes only `/api/device/`. Do not expose `/api/admin/` or `/radius/`. Run `sudo nginx -t` before reloading. The included file is a template; it does not obtain certificates or alter an existing web server.

From an HTTPS client, use the ESP device token to GET `/api/device/config`, PUT rate settings, and POST purchases as documented in README.md. Test network loss and retries before connecting the real coin acceptor. A custom external portal and ESP coin ownership/automatic login flow still need to be built after the hardware acceptance test.

## 8. Nationwide deployment considerations

Create one site per independent operator/location and one device key per coin machine. Each incoming RADIUS source must map unambiguously to its site through a registered client and secret. Dynamic public IPs and carrier NAT need a networking plan; a private site gateway tunnel is the preferred starting point. Do not register `0.0.0.0/0` with a shared secret.

This version has no API for automatic NAS registration. Add approved clients through configuration management and validate before reloading. Test traffic, memory, database growth, and accounting failure rates before increasing site count. The package does not claim a specific subscriber capacity for a 1 vCPU / 2 GB VPS.

## 9. Backup and recovery

Back up the complete database directory, `/etc/onedash-radius.env`, and FreeRADIUS configuration. A simple consistent backup has brief backend downtime:

```bash
sudo systemctl stop onedash-radius
sudo tar -czf /root/onedash-radius-backup.tar.gz /var/lib/onedash-radius /etc/onedash-radius.env /etc/freeradius/3.0
sudo chmod 600 /root/onedash-radius-backup.tar.gz
sudo systemctl start onedash-radius
```

Use unique backup filenames for subsequent backups; protect them because they contain secrets. If tar fails, restart the backend before troubleshooting. Restoring old balances can re-enable spent credit: restore only with a reconciliation plan. Never generate a new DATA_KEY while keeping an existing database.

For CPU/RAM and health checks:

```bash
free -h
sudo systemctl status onedash-radius freeradius --no-pager
ps -eo pid,comm,rss,%cpu --sort=-rss | head -15
```

The next conversation step is to share the non-secret output from section 1 and whether the first test will run on a local VM or VPS. That determines the correct EAP source address, routing, and firewall setup.

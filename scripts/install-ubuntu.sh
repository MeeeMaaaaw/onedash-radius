#!/usr/bin/env bash
# Fresh dedicated Ubuntu 24.04 VM/VPS only. Does not open firewall ports.
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run with sudo bash scripts/install-ubuntu.sh'; exit 1; }
source /etc/os-release
[[ ${ID} == ubuntu && ${VERSION_ID} == 24.04 ]] || { echo 'This installer targets Ubuntu 24.04 only.'; exit 1; }
[[ ! -e /opt/onedash-radius && ! -e /etc/onedash-radius.env && ! -e /opt/onedash-node24 ]] || { echo 'Existing OneDash install found; refusing to overwrite code or secrets.'; exit 1; }
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
apt-get update
apt-get install -y ca-certificates curl xz-utils python3 freeradius freeradius-rest freeradius-utils
# Private Node runtime: never replace a Node version used by other services.
case "$(uname -m)" in x86_64) node_arch=x64;; aarch64) node_arch=arm64;; *) echo 'Unsupported architecture'; exit 1;; esac
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
curl --fail --silent --show-error --location https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$temp_dir/SHASUMS256.txt"
node_file="$(awk -v arch="$node_arch" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' "$temp_dir/SHASUMS256.txt")"
[[ "$node_file" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || { echo 'Could not resolve Node 24 release'; exit 1; }
curl --fail --silent --show-error --location "https://nodejs.org/dist/latest-v24.x/$node_file" -o "$temp_dir/$node_file"
(cd "$temp_dir"; awk -v f="$node_file" '$2 == f' SHASUMS256.txt | sha256sum --check -)
mkdir -p /opt/onedash-node24
tar -xJf "$temp_dir/$node_file" --strip-components=1 -C /opt/onedash-node24
/opt/onedash-node24/bin/node --version
id onedash-radius >/dev/null 2>&1 || useradd --system --home-dir /var/lib/onedash-radius --shell /usr/sbin/nologin onedash-radius
install -d -m 755 /opt/onedash-radius
cp -R "$project_dir/src" "$project_dir/scripts" "$project_dir/deploy" "$project_dir/test" "$project_dir/package.json" "$project_dir/README.md" "$project_dir/SETUP-UBUNTU.md" /opt/onedash-radius/
install -d -o onedash-radius -g onedash-radius -m 700 /var/lib/onedash-radius
/opt/onedash-node24/bin/node /opt/onedash-radius/scripts/init-env.mjs /etc/onedash-radius.env
sed -i 's|^DB_PATH=.*|DB_PATH=/var/lib/onedash-radius/vouchers.sqlite|' /etc/onedash-radius.env
sed 's|ExecStart=/usr/bin/node |ExecStart=/opt/onedash-node24/bin/node |' "$project_dir/deploy/onedash-radius.service" > /etc/systemd/system/onedash-radius.service
systemctl daemon-reload
systemctl enable --now onedash-radius
curl --fail --silent --show-error http://127.0.0.1:3100/healthz
echo
echo 'Backend installed. Continue SETUP-UBUNTU.md at section 2. FreeRADIUS has not been reconfigured; no firewall ports were opened.'

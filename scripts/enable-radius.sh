#!/usr/bin/env bash
# Apply generated config only to a fresh, dedicated FreeRADIUS installation.
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run as root'; exit 1; }
generated_dir="${1:?Pass generated config directory}"
radius_dir=/etc/freeradius/3.0
[[ -f "$generated_dir/onedash" && -f "$generated_dir/onedash_rest" && -f "$generated_dir/clients.conf" ]] || { echo 'Incomplete generated config'; exit 1; }
[[ ! -e "$radius_dir/sites-enabled/onedash" && ! -e "$radius_dir/mods-enabled/onedash_rest" ]] || { echo 'OneDash configuration exists; refusing to overwrite'; exit 1; }
for item in "$radius_dir"/sites-enabled/*; do
  case "$(basename "$item")" in default|inner-tunnel|'*') ;; *) echo 'Custom virtual server exists; merge manually instead.'; exit 1;; esac
done
backup_dir="/root/freeradius-before-onedash-$(date +%Y%m%d-%H%M%S)"
cp -a "$radius_dir" "$backup_dir"
rollback() {
  rm -f "$radius_dir/sites-enabled/onedash" "$radius_dir/sites-available/onedash" "$radius_dir/mods-enabled/onedash_rest" "$radius_dir/mods-available/onedash_rest"
  cp -a "$backup_dir/clients.conf" "$radius_dir/clients.conf"
  cp -a "$backup_dir/sites-enabled/." "$radius_dir/sites-enabled/"
  echo "Validation failed; original config restored. Backup: $backup_dir"
}
install -o root -g freerad -m 640 "$generated_dir/onedash" "$radius_dir/sites-available/onedash"
install -o root -g freerad -m 640 "$generated_dir/onedash_rest" "$radius_dir/mods-available/onedash_rest"
install -o root -g freerad -m 640 "$generated_dir/clients.conf" "$radius_dir/clients.conf"
rm -f "$radius_dir/sites-enabled/default" "$radius_dir/sites-enabled/inner-tunnel"
ln -s ../sites-available/onedash "$radius_dir/sites-enabled/onedash"
ln -s ../mods-available/onedash_rest "$radius_dir/mods-enabled/onedash_rest"
if ! freeradius -XC; then rollback; exit 1; fi
systemctl enable freeradius
if ! systemctl restart freeradius; then rollback; systemctl restart freeradius; exit 1; fi
echo "FreeRADIUS configured. Backup: $backup_dir. Keep UDP 1812/1813 restricted to registered sources."

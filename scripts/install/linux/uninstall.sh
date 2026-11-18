#!/usr/bin/env bash
# Removes Appbuilder installed by scripts/install/linux/install.sh. Run as root:
#
#   sudo bash uninstall.sh                 removes the service, the program folder, the command and the configuration;
#                                          KEEPS the data folder (workspace, backups) and the database
#   sudo bash uninstall.sh --remove-data   also deletes the data folder, the database and its role, after you type
#                                          DELETE <host name> to confirm (there is no undo; make and move a backup first)
#   --prefix <dir> --data <dir>            when the install used other folders;  --dry-run  prints what it would do
#
# PostgreSQL and Caddy (the programs) stay installed: other software may use them. A Caddyfile written by the installer
# is removed and Caddy stopped.
set -Eeuo pipefail
PREFIX=/opt/appbuilder DATA=/var/lib/appbuilder REMOVE_DATA=0 DRY=0 YES_TEXT=''
SERVICE=appbuilder SVC_USER=appbuilder DB_NAME=appbuilder DB_USER=appbuilder
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    --remove-data) REMOVE_DATA=1; shift ;;
    --confirm) YES_TEXT="$2"; shift 2 ;;   # for scripted tests: the exact confirmation text
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option $1" >&2; exit 64 ;;
  esac
done
run() { if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }
[ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || { echo "Run as root." >&2; exit 1; }
cd /

if [ "$REMOVE_DATA" = 1 ]; then
  want="DELETE $(hostname -s)"
  echo "This deletes $DATA (workspace, attachments, backups, the encryption key) and the database $DB_NAME. There is no undo."
  if [ -z "$YES_TEXT" ]; then read -r -p "Type '$want' to continue: " YES_TEXT; fi
  [ "$YES_TEXT" = "$want" ] || { echo "Not confirmed: nothing was removed." >&2; exit 1; }
fi

echo "Stopping and removing the service ..."
if systemctl list-unit-files "$SERVICE.service" >/dev/null 2>&1; then
  run systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
fi
run rm -f "/etc/systemd/system/$SERVICE.service"
if [ -f /etc/caddy/Caddyfile ] && grep -q 'written by the Appbuilder installer' /etc/caddy/Caddyfile; then
  echo "Removing the Appbuilder Caddyfile and stopping Caddy ..."
  run systemctl disable --now caddy >/dev/null 2>&1 || true
  run rm -f /etc/caddy/Caddyfile
fi
run systemctl daemon-reload
echo "Removing $PREFIX, /usr/local/bin/appbuilder and /etc/appbuilder ..."
run rm -rf "$PREFIX" /usr/local/bin/appbuilder /etc/appbuilder

if [ "$REMOVE_DATA" = 1 ]; then
  echo "Dropping the database $DB_NAME and the role $DB_USER ..."
  psql=''
  for d in /usr/lib/postgresql/*/bin; do [ -x "$d/psql" ] && psql="$d/psql"; done
  if [ -n "$psql" ]; then
    run runuser -u postgres -- "$psql" -X -q -p 5432 -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" || echo "  could not drop the database (drop it yourself)" >&2
    run runuser -u postgres -- "$psql" -X -q -p 5432 -d postgres -c "DROP ROLE IF EXISTS \"$DB_USER\"" || echo "  could not drop the role (drop it yourself)" >&2
  fi
  echo "Deleting $DATA ..."
  run rm -rf "$DATA"
  if id "$SVC_USER" >/dev/null 2>&1; then run userdel "$SVC_USER" || true; fi
  echo "Appbuilder and its data are removed."
else
  echo "Appbuilder is removed. Kept: $DATA (workspace, backups) and the database $DB_NAME."
  echo "Reinstalling with the installer picks them up again."
fi

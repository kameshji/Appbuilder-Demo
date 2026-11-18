#!/usr/bin/env bash
# Appbuilder installer for Linux (Ubuntu 22.04 / 24.04, Debian 12). Run as root from an unpacked release:
#
#   sudo bash scripts/install/linux/install.sh [options]
#
# Options
#   --https none|lan|domain   none (default): Appbuilder only on this server (http://localhost:5174, SSH tunnel);
#                             lan: Caddy with its own certificate authority for https://<names> on the local network;
#                             domain: Caddy with an automatic Let's Encrypt certificate for --domain (ports 80 and 443
#                             must reach this server from the internet)
#   --domain <name>           the public DNS name for --https domain
#   --acme-email <address>    optional contact address for Let's Encrypt
#   --lan-names <a,b,...>     names (and IP addresses) clients use with --https lan (default: host name, FQDN, IPs)
#   --ufw                     also open the HTTPS port(s) in ufw (only with --https lan|domain)
#   --postgres auto|pgdg|distro|existing   where PostgreSQL comes from (default auto: an existing local PostgreSQL 15+,
#                             else PostgreSQL 17 from the PGDG apt repository)
#   --port <n>                Appbuilder's local port (default 5174)
#   --offline <dir>           take Node.js and Caddy from a bundle made by scripts/install/prepare-offline.mjs;
#                             PostgreSQL must then already be installed (or come from a local apt mirror)
#   --prefix <dir>            program folder (default /opt/appbuilder)   --data <dir>  data folder (default /var/lib/appbuilder)
#   --dry-run                 print every action, change nothing
#   --yes                     do not ask questions
#   --force                   continue on an untested distribution
#
# Re-running it repairs an install: missing pieces are put back, nothing that exists is overwritten without need, the
# database password is only replaced when the saved one no longer works. Uninstall: scripts/install/linux/uninstall.sh.
set -Eeuo pipefail
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MANIFEST="$SCRIPT_DIR/../manifest.txt"
INSTALLER_VERSION=1
cd /   # the service account runs some steps: never inside a folder it cannot read

HTTPS=none DOMAIN='' ACME_EMAIL='' LAN_NAMES='' UFW=0 PG_MODE=auto PORT=5174 OFFLINE='' PREFIX=/opt/appbuilder DATA=/var/lib/appbuilder
DRY=0 YES=0 FORCE=0
SERVICE=appbuilder SVC_USER=appbuilder DB_NAME=appbuilder DB_USER=appbuilder ETC=/etc/appbuilder

STEP=0
say()  { printf '%s\n' "$*"; }
step() { STEP=$((STEP + 1)); printf '\n[%s] %s\n' "$STEP" "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
trap 'fail "line $LINENO: $BASH_COMMAND failed"' ERR
# run: every changing action goes through here (printed in --dry-run instead of executed)
run()  { if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@" || fail "this command failed (exit $?): $*"; fi; }
# write_file <path> <mode> <owner:group>: contents from stdin
write_file() {
  local dst="$1" mode="$2" owner="$3" tmp
  if [ "$DRY" = 1 ]; then printf '  would write %s (%s %s):\n' "$dst" "$mode" "$owner"; sed 's/^/    | /'; return; fi
  tmp="$(mktemp "${dst}.XXXXXX")"
  cat > "$tmp"
  chmod "$mode" "$tmp"; chown "$owner" "$tmp"
  mv -f "$tmp" "$dst"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --https) HTTPS="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --acme-email) ACME_EMAIL="$2"; shift 2 ;;
    --lan-names) LAN_NAMES="$2"; shift 2 ;;
    --ufw) UFW=1; shift ;;
    --postgres) PG_MODE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --offline) OFFLINE="$(cd "$2" && pwd)"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --data) DATA="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) fail "Unknown option $1 (see --help)" ;;
  esac
done

case "$HTTPS" in none|lan|domain) ;; *) fail "--https must be none, lan or domain" ;; esac
case "$PG_MODE" in auto|pgdg|distro|existing) ;; *) fail "--postgres must be auto, pgdg, distro or existing" ;; esac
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || fail "Invalid --port"
[ "$HTTPS" != domain ] || [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] || fail "--https domain needs --domain <public DNS name>"
[[ "$PREFIX" = /* && "$DATA" = /* ]] || fail "--prefix and --data must be absolute paths"

# manifest.txt -> M[key]=value
declare -A M
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%$'\r'}"
  [[ -z "$line" || "$line" = \#* ]] && continue
  M["${line%%=*}"]="${line#*=}"
done < "$MANIFEST"
m() { [ -n "${M[$1]:-}" ] || fail "manifest.txt has no $1"; printf '%s' "${M[$1]}"; }

APP="$PREFIX/app" NODE_DIR="$PREFIX/node" NODE="$PREFIX/node/bin/node"
WS="$DATA/workspace" BACKUPS="$DATA/backups" UPDATES="$DATA/updates"
ENV_FILE="$ETC/appbuilder.env"
T0=$(date +%s)

# ------------------------------------------------------------------ helpers
download() { # url dest algo checksum
  local url="$1" dst="$2" algo="$3" sum="$4" name
  name="$(basename "$url")"
  [[ "$url" = https://* ]] || fail "refusing a non-HTTPS download: $url"
  if [ -n "$OFFLINE" ]; then
    [ -f "$OFFLINE/$name" ] || fail "the offline bundle $OFFLINE has no $name"
    cp "$OFFLINE/$name" "$dst"
  else
    say "  downloading $url"
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$dst" "$url" || fail "download failed: $url"
  fi
  echo "$sum  $dst" | "${algo}sum" -c --quiet - >/dev/null 2>&1 || fail "checksum mismatch for $name: the file is damaged or not the pinned version"
  say "  $name: $algo checksum ok"
}
pg_bindir() { # newest /usr/lib/postgresql/<major>/bin with psql
  local d best=''
  for d in /usr/lib/postgresql/*/bin; do [ -x "$d/psql" ] && best="$d"; done
  printf '%s' "$best"
}
as_postgres() { runuser -u postgres -- "$@"; }
pg_major_running() { # major version of the server answering on 5432 via the local socket, or empty
  as_postgres "$(pg_bindir)/psql" -X -qAt -p 5432 -d postgres -c 'SHOW server_version_num' 2>/dev/null | cut -c1-2 || true
}
health() { { curl -sS --noproxy '*' --max-time 3 "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null || true; } | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p'; }
# apt-get quietly; the full output goes to the install log, shown when it fails
INSTALL_LOG=/var/log/appbuilder-install.log
apt_get() {
  if [ "$DRY" = 1 ]; then printf '  would run: apt-get %s\n' "$*"; return; fi
  say "  apt-get $*"
  DEBIAN_FRONTEND=noninteractive apt-get -y -q "$@" >>"$INSTALL_LOG" 2>&1 || { tail -n 30 "$INSTALL_LOG" >&2; fail "apt-get $* failed (full output: $INSTALL_LOG)"; }
}

# ------------------------------------------------------------------ 1. checks
step "Checking this server"
[ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || fail "Run as root: sudo bash $0"
[ -f "$RELEASE_DIR/release.json" ] || fail "$RELEASE_DIR is not an unpacked Appbuilder release (release.json missing)"
. /etc/os-release
case "${ID}:${VERSION_ID}" in
  ubuntu:22.04|ubuntu:24.04|debian:12) say "  ${PRETTY_NAME}" ;;
  *) [ "$FORCE" = 1 ] || fail "${PRETTY_NAME:-this system} is not tested (Ubuntu 22.04/24.04, Debian 12). Use --force to try anyway."; warn "untested system ${PRETTY_NAME}" ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in x86_64) NODE_ARCH=linux-x64 ;; aarch64) NODE_ARCH=linux-arm64 ;; *) fail "unsupported CPU architecture $ARCH" ;; esac
command -v systemctl >/dev/null && [ -d /run/systemd/system ] || fail "systemd is required (the service runs as a systemd unit)"
MEM_MB=$(( $(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' /proc/meminfo) / 1024 ))
[ "$MEM_MB" -ge 1800 ] || fail "at least 2 GB of RAM is needed (found ${MEM_MB} MB)"
[ "$MEM_MB" -ge 3800 ] || warn "${MEM_MB} MB of RAM: 4 GB or more is recommended for 20-50 users"
for d in "$(dirname "$PREFIX")" "$(dirname "$DATA")"; do
  free_mb=$(df -Pm "$d" | awk 'NR==2 {print $4}')
  [ "$free_mb" -ge 2048 ] || fail "less than 2 GB free on $d (${free_mb} MB)"
done
say "  ${ARCH}, ${MEM_MB} MB RAM, disk ok"
# tools the installer itself needs (minimal images lack some)
need_pkgs=()
command -v curl >/dev/null || need_pkgs+=(curl ca-certificates)
command -v xz >/dev/null || need_pkgs+=(xz-utils)
command -v gpg >/dev/null || [ -n "$OFFLINE" ] || need_pkgs+=(gnupg)
if [ "${#need_pkgs[@]}" -gt 0 ]; then
  [ -z "$OFFLINE" ] || fail "missing for an offline install: ${need_pkgs[*]} (install them from the distribution's media first)"
  say "  installing ${need_pkgs[*]}"
  apt_get update
  apt_get install --no-install-recommends "${need_pkgs[@]}"
fi
ver="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$RELEASE_DIR/release.json")"
commit="$(sed -n 's/.*"commit": *"\([^"]*\)".*/\1/p' "$RELEASE_DIR/release.json")"
say "  Installing Appbuilder $ver (${commit:0:12}) to $PREFIX, data in $DATA"

# ------------------------------------------------------------------ 2. the release files
step "Checking the release files against SHA256SUMS"
( cd "$RELEASE_DIR" && sha256sum -c --quiet --strict SHA256SUMS ) || fail "some release files do not match SHA256SUMS: unpack the ZIP again"
say "  $(wc -l < "$RELEASE_DIR/SHA256SUMS") files ok"

# ------------------------------------------------------------------ 3. Node.js
step "Node.js $(m node.version)"
want="v$(m node.version)"
if [ -x "$NODE" ] && [ "$("$NODE" --version)" = "$want" ]; then
  say "  already installed ($NODE)"
else
  tmpd="$(mktemp -d)"
  download "$(m "node.$NODE_ARCH.url")" "$tmpd/node.tar.xz" sha256 "$(m "node.$NODE_ARCH.sha256")"
  run mkdir -p "$PREFIX"
  run rm -rf "$NODE_DIR.new"
  run mkdir -p "$NODE_DIR.new"
  run tar -xJf "$tmpd/node.tar.xz" -C "$NODE_DIR.new" --strip-components=1 --no-same-owner
  run rm -rf "$NODE_DIR.old"
  [ -d "$NODE_DIR" ] && run mv "$NODE_DIR" "$NODE_DIR.old"
  run mv "$NODE_DIR.new" "$NODE_DIR"
  run rm -rf "$NODE_DIR.old" "$tmpd"
  [ "$DRY" = 1 ] || say "  $("$NODE" --version) in $NODE_DIR"
fi
[ "$DRY" = 1 ] || "$NODE" "$RELEASE_DIR/server/main.ts" verify-release "$RELEASE_DIR" --allow-unsigned | sed 's/^/  /'

# ------------------------------------------------------------------ 4. PostgreSQL
step "PostgreSQL"
if [ "$PG_MODE" = auto ] || [ "$PG_MODE" = existing ]; then
  running="$( [ -n "$(pg_bindir)" ] && pg_major_running || true)"
  if [ -n "$running" ] && [ "$running" -ge 15 ]; then PG_MODE=existing; say "  using the PostgreSQL $running server already running on port 5432"
  elif [ "$PG_MODE" = existing ]; then fail "no local PostgreSQL 15+ answers on port 5432"
  else PG_MODE=pgdg; fi
fi
if [ "$PG_MODE" = distro ]; then
  cand="$(apt-cache policy postgresql 2>/dev/null | sed -n 's/ *Candidate: \([0-9]*\).*/\1/p')"
  [ -n "$cand" ] && [ "$cand" -ge 15 ] || fail "the distribution's PostgreSQL (${cand:-none}) is older than 15: use --postgres pgdg"
  apt_get install postgresql
elif [ "$PG_MODE" = pgdg ]; then
  [ -z "$OFFLINE" ] || fail "offline install: install PostgreSQL 15+ first (from the distribution's media or a local mirror), then run again"
  major="$(m apt.pgdg.major)"
  if ! [ -x "/usr/lib/postgresql/$major/bin/postgres" ]; then
    apt_get install ca-certificates curl gnupg
    tmpk="$(mktemp)"
    curl -fsSL --proto '=https' "$(m apt.pgdg.keyurl)" -o "$tmpk"
    fp="$(gpg --show-keys --with-colons "$tmpk" 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')"
    [ "$fp" = "$(m apt.pgdg.fingerprint)" ] || fail "the PGDG signing key has fingerprint $fp, expected $(m apt.pgdg.fingerprint)"
    run install -d -m 0755 /usr/share/keyrings
    [ "$DRY" = 1 ] || gpg --dearmor < "$tmpk" > /usr/share/keyrings/appbuilder-pgdg.gpg
    rm -f "$tmpk"
    echo "deb [signed-by=/usr/share/keyrings/appbuilder-pgdg.gpg] $(m apt.pgdg.repo) ${VERSION_CODENAME}-pgdg main" | write_file /etc/apt/sources.list.d/appbuilder-pgdg.list 0644 root:root
    apt_get update
    apt_get install "postgresql-$major"
  else
    say "  PostgreSQL $major is installed"
  fi
fi
if [ "$DRY" = 0 ]; then
  systemctl enable --now postgresql >/dev/null 2>&1 || true
  # Debian/Ubuntu: the cluster may need starting after install inside minimal systems
  for _ in $(seq 1 30); do [ -n "$(pg_major_running)" ] && break; sleep 1; done
  PG_MAJOR="$(pg_major_running)"
  [ -n "$PG_MAJOR" ] && [ "$PG_MAJOR" -ge 15 ] || fail "PostgreSQL does not answer on port 5432 (major ${PG_MAJOR:-none})"
  PG_BIN="/usr/lib/postgresql/$PG_MAJOR/bin"
  say "  PostgreSQL $PG_MAJOR answers on 127.0.0.1:5432 (client tools $PG_BIN)"
else
  PG_MAJOR=17 PG_BIN=/usr/lib/postgresql/17/bin
fi

# ------------------------------------------------------------------ 5. account and folders
step "Service account and folders"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  run useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin --user-group "$SVC_USER"
else say "  user $SVC_USER exists"; fi
run install -d -m 0755 -o root -g root "$PREFIX"
run install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA"
run install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$WS" "$BACKUPS"
run install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$UPDATES"
run install -d -m 0750 -o root -g "$SVC_USER" "$ETC"

# ------------------------------------------------------------------ 6. the app
step "Appbuilder $ver"
same=0
if [ -f "$APP/release.json" ] && [ "$(sed -n 's/.*"commit": *"\([^"]*\)".*/\1/p' "$APP/release.json")" = "$commit" ] \
   && [ "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APP/release.json")" = "$ver" ] \
   && ( cd "$APP" && sha256sum -c --quiet --strict SHA256SUMS >/dev/null 2>&1 ); then same=1; fi
if [ "$same" = 1 ]; then
  say "  already installed and intact"
else
  if [ -d "$APP" ]; then
    if [ "$YES" != 1 ] && [ -t 0 ]; then
      read -r -p "  $APP holds another or a damaged release. Replace it (the old one goes to app.previous)? [y/N] " a
      [[ "$a" =~ ^[Yy] ]] || fail "cancelled"
    fi
  fi
  run rm -rf "$PREFIX/app.staging"
  run cp -a "$RELEASE_DIR" "$PREFIX/app.staging"
  run chown -R root:root "$PREFIX/app.staging"
  run chmod -R u=rwX,go=rX "$PREFIX/app.staging"
  if [ -d "$APP" ]; then run rm -rf "$PREFIX/app.previous"; run mv "$APP" "$PREFIX/app.previous"; fi
  run mv "$PREFIX/app.staging" "$APP"
  say "  installed in $APP"
fi

# ------------------------------------------------------------------ 7. database role, database and saved login
step "Database $DB_NAME and role $DB_USER"
need_pw=1
if [ "$DRY" = 0 ] && [ -f "$WS/server.json" ] && grep -q '"passwordSealed"' "$WS/server.json"; then
  # the saved login still works: keep it (re-running the installer must not change a working password)
  if runuser -u "$SVC_USER" -- env APPBUILDER_WORKSPACE="$WS" "$NODE" "$APP/server/main.ts" db-check >/dev/null 2>&1; then
    need_pw=0; say "  the saved database login works: kept"
  else
    say "  the saved database login does not work: setting a new password"
  fi
fi
if [ "$need_pw" = 1 ] && [ "$DRY" = 0 ]; then
  # a random password, made here, never shown, never on a command line or in a file outside server.json (sealed)
  DB_PW="$(head -c 33 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-40)"
  VERIFIER="$(printf '%s' "$DB_PW" | "$NODE" -e '
    const c = require("node:crypto"); let pw = ""; process.stdin.on("data", (d) => (pw += d)).on("end", () => {
      const salt = c.randomBytes(16), it = 4096
      const sp = c.pbkdf2Sync(Buffer.from(pw.normalize("NFKC"), "utf8"), salt, it, 32, "sha256")
      const hmac = (k, s) => c.createHmac("sha256", k).update(s).digest()
      const stored = c.createHash("sha256").update(hmac(sp, "Client Key")).digest()
      process.stdout.write(`SCRAM-SHA-256$${it}:${salt.toString("base64")}$${stored.toString("base64")}:${hmac(sp, "Server Key").toString("base64")}`)
    })')"
  [[ "$VERIFIER" =~ ^SCRAM-SHA-256\$4096: ]] || fail "could not prepare the database password"
  as_postgres "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -p 5432 -d postgres >/dev/null <<SQL
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER') THEN
    ALTER ROLE "$DB_USER" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$VERIFIER';
  ELSE
    CREATE ROLE "$DB_USER" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$VERIFIER';
  END IF;
END \$\$;
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', '$DB_NAME', '$DB_USER')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DB_NAME') \gexec
ALTER DATABASE "$DB_NAME" OWNER TO "$DB_USER";
REVOKE ALL ON DATABASE "$DB_NAME" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE "$DB_NAME" TO "$DB_USER";
SQL
  unset VERIFIER
  # sealed into server.json by the server's own code, as the service account (owner-only file)
  printf '%s\n' "$DB_PW" | runuser -u "$SVC_USER" -- env APPBUILDER_WORKSPACE="$WS" "$NODE" "$APP/server/main.ts" seed-config \
    --workspace "$WS" --db-host 127.0.0.1 --db-port 5432 --db-name "$DB_NAME" --db-user "$DB_USER" --test | sed 's/^/  /'
  unset DB_PW
  say "  role $DB_USER (no superuser, CREATEDB or CREATEROLE) owns $DB_NAME; the password is sealed in $WS/server.json"
elif [ "$DRY" = 1 ]; then
  say "  would create the role and database, generate a password and seal it into $WS/server.json"
fi

# ------------------------------------------------------------------ 8. configuration
step "Configuration"
names="localhost"
if [ "$HTTPS" = lan ]; then
  if [ -z "$LAN_NAMES" ]; then
    LAN_NAMES="$(hostname -s)"
    fq="$(hostname -f 2>/dev/null || true)"; [ -n "$fq" ] && [ "$fq" != "$LAN_NAMES" ] && LAN_NAMES="$LAN_NAMES,$fq"
    for ip in $(hostname -I 2>/dev/null); do [[ "$ip" =~ ^[0-9.]+$ ]] && LAN_NAMES="$LAN_NAMES,$ip"; done
  fi
  names="$LAN_NAMES"
elif [ "$HTTPS" = domain ]; then names="$DOMAIN"; fi
{
  echo "# Appbuilder service environment (written by the installer; re-running it rewrites this file)."
  echo "# Changes take effect after: sudo systemctl restart appbuilder"
  echo "NODE_ENV=production"
  echo "PORT=$PORT"
  echo "APPBUILDER_HOST=127.0.0.1"
  echo "APPBUILDER_WORKSPACE=$WS"
  echo "APPBUILDER_BACKUP_DIR=$BACKUPS"
  echo "APPBUILDER_PG_BIN=$PG_BIN"
  echo "APPBUILDER_INSTALL_ROOT=$PREFIX"
  echo "APPBUILDER_SETUP_CODE_FILE=$WS/setup-code.txt"
  if [ "$HTTPS" != none ]; then
    echo "APPBUILDER_ALLOWED_HOSTS=$names"
    echo "APPBUILDER_TRUST_PROXY=1"
  fi
} | write_file "$ENV_FILE" 0640 "root:$SVC_USER"
cat <<JSON | write_file "$PREFIX/install.json" 0644 root:root
{
  "platform": "linux",
  "root": "$PREFIX",
  "dataDir": "$DATA",
  "workspace": "$WS",
  "serviceName": "$SERVICE",
  "serviceAccount": "$SVC_USER",
  "port": $PORT,
  "node": "$NODE",
  "https": "$HTTPS",
  "envFile": "$ENV_FILE",
  "postgres": "$PG_MODE",
  "installerVersion": "$INSTALLER_VERSION",
  "installedOn": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
cat <<'SH' | write_file /usr/local/bin/appbuilder 0755 root:root
#!/bin/sh
# Appbuilder command-line tools (written by the installer): appbuilder version|health|update|diagnostics|restore|verify-release
NODE=__NODE__ MAIN=__APP__/server/main.ts USER=__USER__
cd / || exit 1
case "$1" in
  update)
    [ "$(id -u)" = 0 ] || { echo "appbuilder update must run as root (sudo appbuilder update ...)" >&2; exit 77; }
    exec "$NODE" "$MAIN" "$@" ;;
  restore|seed-config)
    # files in the workspace must belong to the service account
    if [ "$(id -u)" = 0 ]; then exec runuser -u "$USER" -- "$NODE" "$MAIN" "$@"; fi
    exec "$NODE" "$MAIN" "$@" ;;
  *) exec "$NODE" "$MAIN" "$@" ;;
esac
SH
[ "$DRY" = 1 ] || sed -i "s#__NODE__#$NODE#; s#__APP__#$APP#; s#__USER__#$SVC_USER#" /usr/local/bin/appbuilder
say "  $ENV_FILE, $PREFIX/install.json, /usr/local/bin/appbuilder"

# ------------------------------------------------------------------ 9. systemd service
step "systemd service $SERVICE"
cat <<UNIT | write_file "/etc/systemd/system/$SERVICE.service" 0644 root:root
# Appbuilder (written by the installer)
[Unit]
Description=Appbuilder
Documentation=file://$APP/README.txt
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$DATA
ExecStart=$NODE $APP/server/main.ts
Restart=on-failure
RestartSec=5
TimeoutStartSec=infinity
TimeoutStopSec=30
UMask=0027
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE
# hardening: the server writes only its data folder; no privilege gain, no devices, no kernel tunables
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DATA
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
# V8 compiles JavaScript to machine code at run time: MemoryDenyWriteExecute would stop Node.js
MemoryDenyWriteExecute=no

[Install]
WantedBy=multi-user.target
UNIT
run systemctl daemon-reload
run systemctl enable "$SERVICE" >/dev/null 2>&1
run systemctl restart "$SERVICE"
if [ "$DRY" = 0 ]; then
  st=''
  for _ in $(seq 1 120); do st="$(health)"; [ "$st" = ok ] && break; sleep 1; done
  [ "$st" = ok ] || { journalctl -u "$SERVICE" -n 40 --no-pager >&2 || true; fail "Appbuilder did not become healthy (last answer: ${st:-none}); the service log is above"; }
  say "  running; GET /api/v1/health: ok"
fi

# ------------------------------------------------------------------ 10. HTTPS (optional)
CA_FILE=''
if [ "$HTTPS" != none ]; then
  step "HTTPS with Caddy ($HTTPS)"
  if ! command -v caddy >/dev/null; then
    if [ -n "$OFFLINE" ]; then
      tmpd="$(mktemp -d)"
      download "$(m caddy.linux-x64.url)" "$tmpd/caddy.tgz" sha512 "$(m caddy.linux-x64.sha512)"
      run tar -xzf "$tmpd/caddy.tgz" -C "$tmpd" caddy
      run install -m 0755 "$tmpd/caddy" /usr/bin/caddy
      id caddy >/dev/null 2>&1 || run useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin --user-group caddy
      run install -d -m 0755 /etc/caddy
      cat <<'UNIT' | write_file /etc/systemd/system/caddy.service 0644 root:root
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE
[Install]
WantedBy=multi-user.target
UNIT
      rm -rf "$tmpd"
    else
      apt_get install ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https
      tmpk="$(mktemp)"
      curl -fsSL --proto '=https' "$(m apt.caddy.keyurl)" -o "$tmpk"
      fp="$(gpg --show-keys --with-colons "$tmpk" 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')"
      [ "$fp" = "$(m apt.caddy.fingerprint)" ] || fail "the Caddy signing key has fingerprint $fp, expected $(m apt.caddy.fingerprint)"
      [ "$DRY" = 1 ] || gpg --dearmor < "$tmpk" > /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      rm -f "$tmpk"
      echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] $(m apt.caddy.repo)" | write_file /etc/apt/sources.list.d/caddy-stable.list 0644 root:root
      apt_get update
      apt_get install caddy
    fi
  fi
  {
    echo "# Appbuilder reverse proxy (written by the Appbuilder installer; re-running it rewrites this file)"
    if [ "$HTTPS" = domain ]; then
      [ -n "$ACME_EMAIL" ] && printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL"
      echo "$DOMAIN {"
      echo "	header Strict-Transport-Security \"max-age=31536000\""
    else
      sites=""
      IFS=',' read -r -a arr <<< "$LAN_NAMES"
      for n in "${arr[@]}"; do sites="${sites:+$sites, }https://$n"; done
      echo "$sites {"
      echo "	tls internal"
    fi
    echo "	encode zstd gzip"
    echo "	reverse_proxy 127.0.0.1:$PORT"
    echo "}"
  } | write_file /etc/caddy/Caddyfile 0644 root:root
  run caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>>"$INSTALL_LOG"
  run systemctl daemon-reload
  run systemctl enable caddy >/dev/null 2>&1
  run systemctl restart caddy
  if [ "$DRY" = 0 ]; then
    first="$( [ "$HTTPS" = domain ] && echo "$DOMAIN" || echo "${LAN_NAMES%%,*}")"
    hs=''
    for _ in $(seq 1 60); do
      hs="$(curl -sk --noproxy '*' --max-time 3 --resolve "$first:443:127.0.0.1" "https://$first/api/v1/health" 2>/dev/null || true)"
      [ "$hs" = '{"status":"ok"}' ] && break; sleep 1
    done
    if [ "$hs" = '{"status":"ok"}' ]; then say "  https://$first/ answers through Caddy"
    elif [ "$HTTPS" = domain ]; then warn "https://$DOMAIN/ does not answer yet: Let's Encrypt needs $DOMAIN to point to this server and ports 80 and 443 open (journalctl -u caddy)"
    else warn "https://$first/ does not answer yet (journalctl -u caddy)"; fi
  fi
  if [ "$HTTPS" = lan ] && [ "$DRY" = 0 ]; then
    for _ in $(seq 1 30); do [ -f /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt ] && break; sleep 1; done
    if [ -f /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt ]; then
      CA_FILE="$DATA/appbuilder-local-ca.crt"
      install -m 0644 /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt "$CA_FILE"
    fi
  fi
  if [ "$UFW" = 1 ]; then
    if command -v ufw >/dev/null; then
      run ufw allow 443/tcp comment 'Appbuilder HTTPS'
      [ "$HTTPS" = domain ] && run ufw allow 80/tcp comment 'Appbuilder ACME / redirect'
      ufw status | grep -q 'Status: active' || warn "ufw is not active: the rules were added but nothing is filtered until you enable ufw (allow SSH first)"
    else warn "ufw is not installed: open port 443${HTTPS:+ (and 80 for --https domain)} in your firewall yourself"; fi
  fi
fi

# ------------------------------------------------------------------ done
T1=$(date +%s)
step "Done in $((T1 - T0)) s"
say ""
say "  Appbuilder $ver is running as the service \"$SERVICE\" (user $SVC_USER)."
if [ "$DRY" = 1 ] || [ -f "$WS/setup-code.txt" ]; then cat <<EOF

  First-run setup (only from this server; the setup screen refuses other computers):
    1. The one-time setup code:   sudo cat $WS/setup-code.txt
    2. Open http://localhost:$PORT/ on this server, or from your PC through an SSH tunnel:
         ssh -L $PORT:127.0.0.1:$PORT <user>@<this server>    then open http://localhost:$PORT/
    3. The database is already connected: create the first administrator.
EOF
fi
if [ "$HTTPS" = domain ]; then
  echo "  After the setup, users open:  https://$DOMAIN/"
elif [ "$HTTPS" = lan ]; then
  echo "  After the setup, users open:  $(echo "$LAN_NAMES" | sed 's/^\([^,]*\).*/https:\/\/\1\//')"
  [ -n "$CA_FILE" ] && echo "  Trust this certificate authority on every client PC once: $CA_FILE (docs/admin/installation.md#trust-the-local-certificate)."
fi
cat <<EOF

  Service:    sudo systemctl status|restart|stop $SERVICE      Logs: journalctl -u $SERVICE   and $WS/logs/
  Commands:   appbuilder version | appbuilder health | sudo appbuilder update <zip> | appbuilder diagnostics
  Uninstall:  sudo bash $APP/scripts/install/linux/uninstall.sh   (keeps the data unless you ask otherwise)
EOF

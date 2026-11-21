#!/bin/sh
# Appbuilder FLEET installer (hosting package H-K): prepares ONE fresh Ubuntu 24.04 / 22.04 server for up to 20
# organisations, one install each (docs/admin/fleet-operations.md). It installs Node.js, PostgreSQL 17 and Caddy from
# the pinned manifest (scripts/install/manifest.txt: checksums and signing-key fingerprints), sets PostgreSQL's fleet
# settings, puts the release and the fleet tool in place and runs `abfleet init`. It creates NO organisation.
# The single-install installer (scripts/install/linux/install.sh) is a different thing and is not changed by this one.
#
#   sudo sh scripts/fleet/install.sh --release <unpacked release folder> --domain <domain> [options]
#
# Options
#   --release <dir>         an unpacked, verified Appbuilder release (release.json, SHA256SUMS); default: the release
#                           this script is in, when it is in one
#   --domain <d>            organisations get <name>.<d> (DNS: a wildcard *.<d> to this server)
#   --tls acme|internal     acme (default): automatic certificates (ports 80 and 443 must reach the server);
#                           internal: Caddy's own CA (tests, a closed network)
#   --acme-email <a>        contact address for the certificate authority
#   --operator-email <a>    alerts and the daily summary go here
#   --access-email <a>      operator access accounts use <local>+<grant>@<domain> of this address
#   --backup-target <t>     a folder (a mounted disk of another machine) or rclone:<remote>:<path> (rclone installed
#                           and configured by you: apt install rclone && rclone config)
#   --licence               also set up the licence service (licence.<domain>)
#   --public-ip <a,b>       the server's public addresses (refused to every install's outbound connections)
#   --postgres pgdg|existing  pgdg (default): PostgreSQL 17 from apt.postgresql.org; existing: a PostgreSQL 15+
#                           already running on port 5432
#   --offline <dir>         Node.js and Caddy from a bundle made by scripts/install/prepare-offline.mjs
#   --dry-run               print every action, change nothing      --yes   no questions      --force  untested OS
set -eu
umask 022

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
RELEASE='' DOMAIN='' TLS=acme ACME_EMAIL='' OPERATOR_EMAIL='' ACCESS_EMAIL='' TARGET='' LICENCE=0 PUBLIC_IP=''
PG_MODE=pgdg OFFLINE='' DRY=0 YES=0 FORCE=0
PREFIX=/opt/appbuilder NODE_DIR=/opt/appbuilder/node NODE=/opt/appbuilder/node/bin/node TOOL=/opt/appbuilder/fleet
LOG=/var/log/appbuilder-fleet-install.log

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '  would run: %s\n' "$*"; else "$@" || fail "this command failed: $*"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE=$2; shift 2 ;;
    --domain) DOMAIN=$2; shift 2 ;;
    --tls) TLS=$2; shift 2 ;;
    --acme-email) ACME_EMAIL=$2; shift 2 ;;
    --operator-email) OPERATOR_EMAIL=$2; shift 2 ;;
    --access-email) ACCESS_EMAIL=$2; shift 2 ;;
    --backup-target) TARGET=$2; shift 2 ;;
    --licence) LICENCE=1; shift ;;
    --public-ip) PUBLIC_IP=$2; shift 2 ;;
    --postgres) PG_MODE=$2; shift 2 ;;
    --offline) OFFLINE=$(cd "$2" && pwd); shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done

[ -n "$RELEASE" ] || { [ -f "$SCRIPT_DIR/../../release.json" ] && RELEASE=$(cd "$SCRIPT_DIR/../.." && pwd); } || true
[ -n "$RELEASE" ] || fail "--release <unpacked release folder> is needed"
RELEASE=$(cd "$RELEASE" && pwd)
[ -f "$RELEASE/release.json" ] || fail "$RELEASE is not an unpacked Appbuilder release (no release.json)"
case "$DOMAIN" in ''|*[!a-z0-9.-]*|.*|*.) fail "--domain must be a lowercase DNS name such as apps.example.com" ;; esac
case "$TLS" in acme|internal) ;; *) fail "--tls must be acme or internal" ;; esac
case "$PG_MODE" in pgdg|existing) ;; *) fail "--postgres must be pgdg or existing" ;; esac
MANIFEST="$RELEASE/scripts/install/manifest.txt"
[ -f "$MANIFEST" ] || MANIFEST="$SCRIPT_DIR/../install/manifest.txt"
[ -f "$MANIFEST" ] || fail "no scripts/install/manifest.txt next to the release or this script"
# m <key>: one value of the manifest
m() { v=$(sed -n "s/^$1=//p" "$MANIFEST" | tr -d '\r' | head -n 1); [ -n "$v" ] || fail "manifest.txt has no $1"; printf '%s' "$v"; }

download() { # url dest algo checksum
  name=$(basename "$1")
  case "$1" in https://*) ;; *) fail "refusing a non-HTTPS download: $1" ;; esac
  if [ -n "$OFFLINE" ]; then [ -f "$OFFLINE/$name" ] || fail "the offline bundle has no $name"; cp "$OFFLINE/$name" "$2"
  else say "  downloading $1"; curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1" || fail "download failed: $1"; fi
  echo "$4  $2" | "${3}sum" -c --quiet - >/dev/null 2>&1 || fail "checksum mismatch for $name"
  say "  $name: $3 checksum ok"
}
apt_get() {
  if [ "$DRY" = 1 ]; then printf '  would run: apt-get %s\n' "$*"; return 0; fi
  say "  apt-get $*"
  DEBIAN_FRONTEND=noninteractive apt-get -y -q "$@" >>"$LOG" 2>&1 || { tail -n 30 "$LOG" >&2; fail "apt-get $* failed (log: $LOG)"; }
}
# apt_repo <name> <key url> <fingerprint> <deb line>: a signed apt repository, its key checked by fingerprint first
apt_repo() {
  tmpk=$(mktemp)
  curl -fsSL --proto '=https' "$2" -o "$tmpk" || fail "could not download the $1 signing key"
  fp=$(gpg --show-keys --with-colons "$tmpk" 2>/dev/null | awk -F: '$1=="fpr" {print $10; exit}')
  [ "$fp" = "$3" ] || fail "the $1 signing key has fingerprint $fp, expected $3"
  if [ "$DRY" = 0 ]; then
    install -d -m 0755 /usr/share/keyrings
    gpg --dearmor < "$tmpk" > "/usr/share/keyrings/appbuilder-$1.gpg"
    printf '%s\n' "deb [signed-by=/usr/share/keyrings/appbuilder-$1.gpg] $4" > "/etc/apt/sources.list.d/appbuilder-$1.list"
  fi
  rm -f "$tmpk"
}

# ------------------------------------------------------------------ 1. this server
step "1. Checking this server"
[ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || fail "run as root: sudo sh $0 ..."
. /etc/os-release
case "${ID}:${VERSION_ID}" in
  ubuntu:24.04|ubuntu:22.04) say "  ${PRETTY_NAME}" ;;
  *) [ "$FORCE" = 1 ] || fail "${PRETTY_NAME:-this system} is not tested (Ubuntu 24.04 / 22.04); --force to try"; warn "untested ${PRETTY_NAME:-system}" ;;
esac
case "$(uname -m)" in x86_64) ARCH=linux-x64 ;; aarch64) ARCH=linux-arm64 ;; *) fail "unsupported CPU $(uname -m)" ;; esac
[ -d /run/systemd/system ] || fail "systemd is required"
MEM_MB=$(( $(sed -n 's/^MemTotal: *\([0-9]*\) kB/\1/p' /proc/meminfo) / 1024 ))
[ "$MEM_MB" -ge 3800 ] || fail "at least 4 GB of RAM is needed (found $MEM_MB MB)"
[ "$MEM_MB" -ge 30000 ] || warn "$MEM_MB MB of RAM: the spec's estimate for 20 organisations is 32 GB (DC-12); fewer installs fit"
say "  $(uname -m), $MEM_MB MB RAM"
( cd "$RELEASE" && sha256sum -c --quiet --strict SHA256SUMS ) || fail "release files do not match SHA256SUMS: unpack the ZIP again"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$RELEASE/release.json")
say "  release $VERSION: $(wc -l < "$RELEASE/SHA256SUMS") files match SHA256SUMS"
need=''
command -v curl >/dev/null || need="$need curl ca-certificates"
command -v xz >/dev/null || need="$need xz-utils"
command -v gpg >/dev/null || need="$need gnupg"
command -v findmnt >/dev/null || need="$need util-linux"
# shellcheck disable=SC2086 # $need is a list of package names
if [ -n "$need" ]; then apt_get update; apt_get install --no-install-recommends $need; fi

# ------------------------------------------------------------------ 2. Node.js
step "2. Node.js $(m node.version)"
if [ -x "$NODE" ] && [ "$("$NODE" --version)" = "v$(m node.version)" ]; then say "  already installed"
else
  t=$(mktemp -d)
  download "$(m "node.$ARCH.url")" "$t/node.tar.xz" sha256 "$(m "node.$ARCH.sha256")"
  run mkdir -p "$PREFIX"
  run rm -rf "$NODE_DIR.new"
  run mkdir -p "$NODE_DIR.new"
  run tar -xJf "$t/node.tar.xz" -C "$NODE_DIR.new" --strip-components=1 --no-same-owner
  if [ -d "$NODE_DIR" ]; then run rm -rf "$NODE_DIR.old"; run mv "$NODE_DIR" "$NODE_DIR.old"; fi
  run mv "$NODE_DIR.new" "$NODE_DIR"
  run rm -rf "$NODE_DIR.old" "$t"
fi

# ------------------------------------------------------------------ 3. PostgreSQL with the fleet settings
step "3. PostgreSQL"
pg_bindir() { best=''; for d in /usr/lib/postgresql/*/bin; do [ -x "$d/psql" ] && best=$d; done; printf '%s' "$best"; }
if [ "$PG_MODE" = pgdg ]; then
  major=$(m apt.pgdg.major)
  if [ ! -x "/usr/lib/postgresql/$major/bin/postgres" ]; then
    [ -z "$OFFLINE" ] || fail "offline: install PostgreSQL $major first"
    apt_repo pgdg "$(m apt.pgdg.keyurl)" "$(m apt.pgdg.fingerprint)" "$(m apt.pgdg.repo) ${VERSION_CODENAME}-pgdg main"
    apt_get update
    apt_get install "postgresql-$major"
  else say "  PostgreSQL $major is installed"; fi
  PG_BIN=/usr/lib/postgresql/$major/bin
else
  PG_BIN=$(pg_bindir)
  [ -n "$PG_BIN" ] || fail "--postgres existing: no PostgreSQL client tools in /usr/lib/postgresql"
fi
run systemctl enable --now postgresql
psql_su() { runuser -u postgres -- "$PG_BIN/psql" -X -q -At -v ON_ERROR_STOP=1 -p 5432 -d postgres "$@"; }
if [ "$DRY" = 0 ]; then
  i=0; until psql_su -c 'SELECT 1' >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 30 ] || fail "PostgreSQL does not answer on port 5432"; sleep 1; done
  ver=$(psql_su -c 'SHOW server_version_num' | cut -c1-2)
  [ "$ver" -ge 15 ] || fail "PostgreSQL $ver: 15 or newer is needed"
  # the client tools of the RUNNING server's major version (pg_dump must not be older than the server); this folder is
  # passed to abfleet init (--pg-bin), recorded in /etc/appbuilder/fleet.json and used by every fleet command after
  if [ -x "/usr/lib/postgresql/$ver/bin/psql" ] && [ "$PG_BIN" != "/usr/lib/postgresql/$ver/bin" ]; then
    say "  using the client tools of the running PostgreSQL $ver (not $PG_BIN)"; PG_BIN=/usr/lib/postgresql/$ver/bin
  fi
  # 20 installs x 12 connections, the licence service and the tools (spec "Connections for 20 installs")
  sb=$(( MEM_MB / 8 )); [ "$sb" -le 4096 ] || sb=4096
  changed=0
  for kv in "max_connections=300" "shared_buffers=${sb}MB" "listen_addresses=localhost" "password_encryption=scram-sha-256"; do
    k=${kv%%=*} v=${kv#*=}
    if [ "$k" = shared_buffers ]; then cur="$(psql_su -c "SELECT setting::bigint * 8 / 1024 FROM pg_settings WHERE name = 'shared_buffers'")MB"
    else cur=$(psql_su -c "SHOW $k"); fi
    [ "$cur" = "$v" ] && continue
    psql_su -c "ALTER SYSTEM SET $k = '$v'" >/dev/null; changed=1
  done
  if grep -Eq '^[[:space:]]*host[[:space:]].*[[:space:]]trust[[:space:]]*$' "$(psql_su -c 'SHOW hba_file')"; then fail "pg_hba.conf has a host line with 'trust': install roles must use password authentication (docs/admin/hosting.md)"; fi
  [ "$changed" = 0 ] || { systemctl restart postgresql; i=0; until psql_su -c 'SELECT 1' >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 30 ] || fail "PostgreSQL did not come back"; sleep 1; done; }
  say "  PostgreSQL $ver on localhost:5432: max_connections 300, shared_buffers ${sb} MB, scram-sha-256"
fi

# ------------------------------------------------------------------ 4. Caddy
step "4. Caddy $(m caddy.version)"
if command -v caddy >/dev/null; then say "  installed: $(caddy version | head -n 1)"
elif [ -n "$OFFLINE" ]; then
  t=$(mktemp -d)
  download "$(m caddy.linux-x64.url)" "$t/caddy.tgz" sha512 "$(m caddy.linux-x64.sha512)"
  run tar -xzf "$t/caddy.tgz" -C "$t" caddy
  run install -m 0755 "$t/caddy" /usr/bin/caddy
  id caddy >/dev/null 2>&1 || run useradd --system --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin --user-group caddy
  rm -rf "$t"
  warn "offline Caddy: write its systemd unit as in scripts/install/linux/install.sh step 10"
else
  apt_get install ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https
  apt_repo caddy "$(m apt.caddy.keyurl)" "$(m apt.caddy.fingerprint)" "$(m apt.caddy.repo)"
  apt_get update
  apt_get install caddy
fi
run install -d -m 0755 /etc/caddy /etc/caddy/fleet.d

# ------------------------------------------------------------------ 5. the fleet tool
step "5. The fleet tool in $TOOL"
run rm -rf "$TOOL.new"
run mkdir -p "$TOOL.new/lib"
for f in abfleet.ts agent.ts; do run install -m 0644 "$SCRIPT_DIR/$f" "$TOOL.new/$f"; done
for f in "$SCRIPT_DIR"/lib/*.ts; do run install -m 0644 "$f" "$TOOL.new/lib/$(basename "$f")"; done
run install -m 0755 "$SCRIPT_DIR/install.sh" "$TOOL.new/install.sh"
if [ -d "$TOOL" ]; then run rm -rf "$TOOL.old"; run mv "$TOOL" "$TOOL.old"; fi
run mv "$TOOL.new" "$TOOL"
run rm -rf "$TOOL.old"
run chown -R root:root "$TOOL"

# ------------------------------------------------------------------ 6. abfleet init
step "6. abfleet init"
set -- init --release "$RELEASE" --domain "$DOMAIN" --tls "$TLS" --pg-bin "$PG_BIN"
[ -z "$ACME_EMAIL" ] || set -- "$@" --acme-email "$ACME_EMAIL"
[ -z "$OPERATOR_EMAIL" ] || set -- "$@" --operator-email "$OPERATOR_EMAIL"
[ -z "$ACCESS_EMAIL" ] || set -- "$@" --access-email "$ACCESS_EMAIL"
[ -z "$TARGET" ] || set -- "$@" --backup-target "$TARGET"
[ -z "$PUBLIC_IP" ] || set -- "$@" --public-ip "$PUBLIC_IP"
[ "$LICENCE" = 0 ] || set -- "$@" --licence
[ "$DRY" = 0 ] || set -- "$@" --dry-run
if [ -x "$NODE" ] && [ -f "$TOOL/abfleet.ts" ]; then
  "$NODE" "$TOOL/abfleet.ts" "$@" || fail "abfleet init failed (see above)"
else
  say "  would run: $NODE $TOOL/abfleet.ts $*"
fi

step "Done"
cat <<EOF
  The fleet server is prepared (no organisation yet). Next:
    sudo abfleet doctor
    sudo abfleet org create <name> --name "<organisation>" --admin-email <address>
  DNS: *.$DOMAIN (and licence.$DOMAIN) must point to this server; ports 80 and 443 open for automatic certificates.
  The runbook: docs/admin/fleet-operations.md (first: copy /etc/appbuilder/secrets/backup-master.key off this server).
EOF

#!/usr/bin/env bash
# Creates Appbuilder's PostgreSQL role and database on Linux (PostgreSQL 15 or newer).
#
#   scripts/setup-postgres.sh [--host 127.0.0.1] [--port 5432] [--database appbuilder] [--user appbuilder]
#                             [--superuser postgres] [--peer]
#
# What it does:
#   1. finds psql (PATH, /usr/lib/postgresql/*/bin, /usr/pgsql-*/bin) or tells you how to install PostgreSQL;
#   2. asks for the new role's password twice (typed, never shown) and, unless --peer is given, the superuser's password;
#   3. creates (or updates) the login role and an empty UTF8 database owned by it. The role gets no superuser, CREATEDB or
#      CREATEROLE rights; as the owner it may create Appbuilder's schemas in its own database.
# Passwords are never echoed, written to disk or put on a command line: the superuser password reaches psql through the
# PGPASSWORD variable of that one psql process only, and the new role's password is turned into a SCRAM-SHA-256 verifier
# on this computer first, so not even the server's statement log can contain it.
# --peer runs psql as the operating-system user "postgres" through sudo (the usual local setup on Debian/Ubuntu/RHEL);
# no superuser password is needed then.
set -euo pipefail

HOST=127.0.0.1
PORT=5432
DATABASE=appbuilder
ROLE=appbuilder
SUPERUSER=postgres
PEER=0

fail() { echo "ERROR: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --database) DATABASE="$2"; shift 2 ;;
    --user) ROLE="$2"; shift 2 ;;
    --superuser) SUPERUSER="$2"; shift 2 ;;
    --peer) PEER=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) fail "Unknown option $1 (see --help)" ;;
  esac
done

[[ "$DATABASE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "The database name may contain lowercase letters, digits and _ only."
[[ "$ROLE" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "The role name may contain lowercase letters, digits and _ only."
[[ "$SUPERUSER" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || fail "Invalid superuser name."
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || fail "Invalid port."

# 1. psql
PSQL="$(command -v psql || true)"
if [ -z "$PSQL" ]; then
  for c in /usr/lib/postgresql/*/bin/psql /usr/pgsql-*/bin/psql /opt/homebrew/bin/psql /usr/local/pgsql/bin/psql; do
    [ -x "$c" ] && PSQL="$c"
  done
fi
if [ -z "$PSQL" ]; then
  cat >&2 <<'EOF'
ERROR: PostgreSQL (psql) was not found.
Install PostgreSQL 17 (15 or newer works), for example:
  Debian/Ubuntu:  sudo apt install postgresql        (or the PGDG packages from https://www.postgresql.org/download/linux/)
  Fedora/RHEL:    sudo dnf install postgresql-server && sudo postgresql-setup --initdb && sudo systemctl enable --now postgresql
Then run this script again.
EOF
  exit 1
fi
echo "Using $("$PSQL" --version)"

# 2. passwords
read_secret() { # prompt -> stdout, never echoed
  local v
  if [ -t 0 ]; then read -r -s -p "$1: " v; echo >&2; else read -r v; fi
  printf '%s' "$v"
}
SUPER_PW=''
if [ "$PEER" = 0 ]; then SUPER_PW="$(read_secret "Password of the PostgreSQL superuser '$SUPERUSER'")"; fi
PW1="$(read_secret "New password for the role '$ROLE' (at least 12 characters)")"
PW2="$(read_secret "Repeat the password")"
[ "$PW1" = "$PW2" ] || fail "The passwords do not match."
[ "${#PW1}" -ge 12 ] || fail "The password must be at least 12 characters."
unset PW2

# SCRAM-SHA-256 verifier (what PostgreSQL stores; the password itself never reaches the server). Node or Python reads
# the password from stdin.
scram() {
  if command -v node >/dev/null 2>&1; then
    node -e '
      const c = require("node:crypto"); let pw = ""; process.stdin.on("data", (d) => (pw += d)).on("end", () => {
        const salt = c.randomBytes(16), it = 4096
        const sp = c.pbkdf2Sync(Buffer.from(pw.normalize("NFKC"), "utf8"), salt, it, 32, "sha256")
        const hmac = (k, s) => c.createHmac("sha256", k).update(s).digest()
        const stored = c.createHash("sha256").update(hmac(sp, "Client Key")).digest()
        process.stdout.write(`SCRAM-SHA-256$${it}:${salt.toString("base64")}$${stored.toString("base64")}:${hmac(sp, "Server Key").toString("base64")}`)
      })'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -I -c '
import sys, os, hashlib, hmac, base64, unicodedata
pw = unicodedata.normalize("NFKC", sys.stdin.read()).encode()
salt = os.urandom(16); it = 4096
sp = hashlib.pbkdf2_hmac("sha256", pw, salt, it, 32)
h = lambda k, s: hmac.new(k, s, hashlib.sha256).digest()
b = lambda x: base64.b64encode(x).decode()
sys.stdout.write("SCRAM-SHA-256$%d:%s$%s:%s" % (it, b(salt), b(hashlib.sha256(h(sp, b"Client Key")).digest()), b(h(sp, b"Server Key"))))'
  else
    fail "Node.js or Python 3 is needed to prepare the password (Appbuilder needs Node.js 22.18+ anyway)."
  fi
}
VERIFIER="$(printf '%s' "$PW1" | scram)"
unset PW1
[[ "$VERIFIER" =~ ^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$ ]] || fail "Could not prepare the password."

# 3. SQL through stdin
SQL=$(cat <<EOF
\\set ON_ERROR_STOP on
SELECT current_setting('server_version_num')::int >= 150000 AS ok \\gset
\\if :ok
\\else
  \\echo 'PostgreSQL 15 or newer is needed.'
  \\quit 3
\\endif
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$ROLE') THEN
    ALTER ROLE "$ROLE" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$VERIFIER';
  ELSE
    CREATE ROLE "$ROLE" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$VERIFIER';
  END IF;
END \$\$;
SELECT format('CREATE DATABASE %I OWNER %I ENCODING ''UTF8'' TEMPLATE template0', '$DATABASE', '$ROLE')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DATABASE') \\gexec
ALTER DATABASE "$DATABASE" OWNER TO "$ROLE";
REVOKE ALL ON DATABASE "$DATABASE" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE "$DATABASE" TO "$ROLE";
SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = '$DATABASE' \\gset
\\echo 'Database $DATABASE (encoding' :enc') is owned by $ROLE.'
EOF
)
unset VERIFIER

echo "Connecting to PostgreSQL at $HOST:$PORT as $SUPERUSER ..."
if [ "$PEER" = 1 ]; then
  printf '%s\n' "$SQL" | sudo -u postgres "$PSQL" -X -q -d postgres -p "$PORT"
else
  printf '%s\n' "$SQL" | PGPASSWORD="$SUPER_PW" "$PSQL" -X -q -h "$HOST" -p "$PORT" -U "$SUPERUSER" -d postgres
fi
unset SUPER_PW SQL

cat <<EOF

Done. In Appbuilder's setup screen enter:
  Host $HOST   Port $PORT   Database $DATABASE   User $ROLE   Password (the one you just typed)
Or start the server with APPBUILDER_DB_HOST=$HOST APPBUILDER_DB_PORT=$PORT APPBUILDER_DB_NAME=$DATABASE APPBUILDER_DB_USER=$ROLE
and APPBUILDER_DB_PASSWORD set in the service's environment (not on a command line).
EOF

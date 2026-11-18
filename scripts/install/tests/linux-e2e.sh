#!/usr/bin/env bash
# End-to-end test of the Linux installer, the first-run setup, backups, the updater (success and automatic rollback),
# HTTPS (LAN, Caddy from its apt repository), repair, diagnostics and uninstall, in a clean systemd container.
# Developer tool (not shipped in releases). Needs Docker with privileged containers and internet access.
#
#   bash scripts/install/tests/linux-e2e.sh [ubuntu:24.04|ubuntu:22.04|debian:12] [--keep]
#
# Behind an HTTPS-intercepting proxy: export https_proxy and E2E_CA_FILE=<the proxy's CA certificate>; the container
# then trusts that CA (that is test harness setup, not something the installer does).
set -Eeuo pipefail
IMAGE_BASE="${1:-ubuntu:24.04}"
KEEP=0; [ "${2:-}" = --keep ] && KEEP=1
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d /tmp/ab-e2e-XXXXXX)"
NAME="ab-e2e-$(echo "$IMAGE_BASE" | tr ':.' '--')-$$"
TAG="ab-e2e-systemd:$(echo "$IMAGE_BASE" | tr ':' '-')"
P=5197   # Appbuilder's port in the container (host network: avoid the default 5174 other servers may use)
declare -A T
ts() { date +%s.%N; }
lap() { T[$1]="$(awk -v a="$2" -v b="$(ts)" 'BEGIN { printf "%.1f", b - a }')"; printf '    (%s: %s s)\n' "$1" "${T[$1]}"; }
say() { printf '\n=== %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
die() { printf 'E2E FAILED: %s\n' "$*" >&2; exit 1; }
cleanup() { [ "$KEEP" = 1 ] || { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }; }
trap cleanup EXIT
X() { docker exec -i -e https_proxy="${https_proxy:-}" -e HTTPS_PROXY="${https_proxy:-}" -e no_proxy=localhost,127.0.0.1,abtest -e NO_PROXY=localhost,127.0.0.1,abtest "$NAME" "$@"; }
api() { # method path [json] -> body (cookie jar in the container)
  X curl -sS -X "$1" -H 'X-Appbuilder: 1' -H 'Content-Type: application/json' -b /root/jar -c /root/jar "http://127.0.0.1:$P$2" ${3:+--data "$3"}
}
START=$(ts)

say "Building three releases (A, B: signed with a throwaway vendor key; C: signed but broken)"
t=$(ts)
export APPBUILDER_RELEASE_KEY_PASSPHRASE="e2e throwaway passphrase"
node "$REPO/scripts/release/keygen.mjs" --out "$WORK/key" --comment 'e2e throwaway key' > "$WORK/keygen.txt"
PUB="$(ls "$WORK"/key/*.pub)"; KEY="$(ls "$WORK"/key/*.key)"
for v in 0.5.0-e2e.1 0.5.0-e2e.2; do
  node "$REPO/scripts/release/build.mjs" --skip-build --version "$v" --out "$WORK/rel" --trust-key "$PUB" >/dev/null
  node "$REPO/scripts/release/sign.mjs" "$WORK/rel/appbuilder-$v" --key "$KEY" >/dev/null
done
cp -a "$WORK/rel/appbuilder-0.5.0-e2e.2" "$WORK/rel/appbuilder-0.5.0-e2e.3"
C="$WORK/rel/appbuilder-0.5.0-e2e.3"
sed -i 's/"version": "0.5.0-e2e.2"/"version": "0.5.0-e2e.3"/' "$C/release.json"
sed -i '0,/^import /s//process.exit(3)\nimport /' "$C/server/main.ts"
node --input-type=module -e "const { writeSums } = await import('$REPO/server/core/update/release.ts'); writeSums('$C')"
rm -f "$C/SHA256SUMS.sig"
node "$REPO/scripts/release/sign.mjs" "$C" --key "$KEY" >/dev/null
ls -la "$WORK/rel"/*.zip | awk '{print "    " $5, $9}'
lap build-releases "$t"

say "Starting a clean $IMAGE_BASE container with systemd"
t=$(ts)
mkdir -p "$WORK/img"
if [ -n "${E2E_CA_FILE:-}" ]; then cp "$E2E_CA_FILE" "$WORK/img/proxy-ca.crt"; else : > "$WORK/img/proxy-ca.crt"; fi
cat > "$WORK/img/Dockerfile" <<EOF
FROM $IMAGE_BASE
ENV DEBIAN_FRONTEND=noninteractive container=docker
COPY proxy-ca.crt /usr/local/share/ca-certificates/e2e-proxy-ca.crt
RUN apt-get update -q && apt-get install -y -q --no-install-recommends systemd systemd-sysv dbus ca-certificates curl unzip procps iproute2 \
 && update-ca-certificates && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty@tty1.service systemd-logind.service console-getty.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
docker build -q --network host -t "$TAG" "$WORK/img" >/dev/null
docker run -d --name "$NAME" --hostname abtest --privileged --network host --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock "$TAG" >/dev/null
for _ in $(seq 1 30); do X systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break; sleep 1; done
X sh -c 'echo "Acquire::https::Proxy \"$https_proxy\";" > /etc/apt/apt.conf.d/99e2e-proxy' # harness: the sandbox's egress proxy
lap container "$t"
docker cp "$WORK/rel/appbuilder-0.5.0-e2e.1.zip" "$NAME:/root/"
docker cp "$WORK/rel/appbuilder-0.5.0-e2e.2.zip" "$NAME:/root/"
docker cp "$WORK/rel/appbuilder-0.5.0-e2e.3.zip" "$NAME:/root/"

say "Install release A (one script, PostgreSQL included)"
t=$(ts)
X sh -c 'cd /root && unzip -q appbuilder-0.5.0-e2e.1.zip'
X bash /root/appbuilder-0.5.0-e2e.1/scripts/install/linux/install.sh --yes --port $P 2>&1 | sed 's/^/    | /'
lap install "$t"
[ "$(X curl -s http://127.0.0.1:$P/api/v1/health)" = '{"status":"ok"}' ] || die "health is not ok after install"
X systemctl is-active appbuilder >/dev/null || die "service not active"
[ "$(X stat -c '%U %a' /var/lib/appbuilder/workspace/server.json)" = "appbuilder 600" ] || die "server.json owner/mode"
[ "$(X stat -c '%U %a' /var/lib/appbuilder/workspace/.secret-key)" = "appbuilder 600" ] || die ".secret-key owner/mode"
X pgrep -u appbuilder -f 'app/server/main.ts' >/dev/null || die "node does not run as appbuilder"
X grep -q passwordSealed /var/lib/appbuilder/workspace/server.json || die "no sealed password"
ok "service active as user appbuilder, server.json and .secret-key 0600, health ok"
X systemctl show appbuilder -p NoNewPrivileges -p ProtectSystem -p PrivateTmp | sed 's/^/    /'

say "First-run setup, headless (the database step is already done by the installer)"
t=$(ts)
st="$(api GET /api/v1/status)"
echo "$st" | grep -q '"needsDatabase":false' || die "status says the database still needs setup: $st"
CODE="$(X head -1 /var/lib/appbuilder/workspace/setup-code.txt)"
# through a proxy header the setup is refused (what Caddy adds)
code_proxy="$(X curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-Appbuilder: 1' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.5' http://127.0.0.1:$P/api/v1/setup/admin --data "{\"setupCode\":\"$CODE\",\"name\":\"E2E Admin\",\"email\":\"admin@example.test\",\"password\":\"e2e-admin-password-1\"}")"
[ "$code_proxy" = 403 ] || die "setup through a proxy header was not refused ($code_proxy)"
api POST /api/v1/setup/admin "{\"setupCode\":\"$CODE\",\"name\":\"E2E Admin\",\"email\":\"admin@example.test\",\"password\":\"e2e-admin-password-1\"}" | grep -q '"user"' || die "setup/admin failed"
X test ! -e /var/lib/appbuilder/workspace/setup-code.txt || die "setup-code.txt still there after setup"
ok "administrator created; setup code file removed; setup via proxy header refused"
api GET /api/v1/admin/health | grep -o '"status":"[a-z]*"' | head -1 | sed 's/^/    detailed health /'
lap setup "$t"

say "Backup now (install backup with pg_dump from the installed client tools)"
t=$(ts)
r="$(api POST /api/v1/backups '{"scope":"install","note":"e2e"}')"
echo "$r" | grep -q '"id"' || die "backup not started: $r"
s=''
for _ in $(seq 1 120); do
  s="$(api GET /api/v1/backups | grep -o '"state":"[a-z-]*"' | head -1 || true)"
  [ "$s" = '"state":"ok"' ] && break; [ "$s" = '"state":"failed"' ] && die "backup failed: $(api GET /api/v1/backups | head -c 600)"; sleep 1
done
[ "$s" = '"state":"ok"' ] || die "backup did not finish"
method="$(api GET /api/v1/backups | { grep -o '"method":"[a-z_-]*"' || true; } | head -1)"
[ "$method" = '"method":"pg_dump"' ] || die "the backup did not use pg_dump from APPBUILDER_PG_BIN under the systemd hardening ($method)"
ok "install backup verified, made with pg_dump"

X sh -c 'ls -la /var/lib/appbuilder/backups' | sed 's/^/    /'
lap backup "$t"

say "Disaster-recovery restore of that backup on the installed server (appbuilder restore)"
t=$(ts)
BK="$(X sh -c 'ls /var/lib/appbuilder/backups/*.abbak | head -1')"
X systemctl stop appbuilder
X appbuilder restore "$BK" --force --yes 2>&1 | tail -n 4 | sed 's/^/    | /'
X systemctl start appbuilder
for _ in $(seq 1 60); do [ "$(X curl -s http://127.0.0.1:$P/api/v1/health)" = '{"status":"ok"}' ] && break; sleep 1; done
api POST /api/v1/auth/login '{"email":"admin@example.test","password":"e2e-admin-password-1"}' | grep -q '"user"' || die "sign-in after the restore"
[ "$(X stat -c %U /var/lib/appbuilder/workspace/server.json)" = appbuilder ] || die "restored files are not owned by the service account"
ok "restored with the service stopped; the administrator signs in; files owned by appbuilder"
lap restore "$t"

say "Update to release B (signed, verified against the installed release's key)"
t=$(ts)
X appbuilder update /root/appbuilder-0.5.0-e2e.2.zip --yes 2>&1 | sed 's/^/    | /'
[[ "$(X appbuilder version)" == *0.5.0-e2e.2* ]] || die "not updated to B"
[ "$(X curl -s http://127.0.0.1:$P/api/v1/health)" = '{"status":"ok"}' ] || die "health after update"
X test -d /opt/appbuilder/app.previous || die "no app.previous"
lap update "$t"

say "Update to the broken release C: automatic rollback of the app folder"
t=$(ts)
set +e
X appbuilder update /root/appbuilder-0.5.0-e2e.3.zip --yes --health-timeout 25 2>&1 | sed 's/^/    | /'
rc=${PIPESTATUS[0]}
set -e
[ "$rc" = 2 ] || die "the broken update should exit 2 (rolled back), got $rc"
[[ "$(X appbuilder version)" == *0.5.0-e2e.2* ]] || die "not rolled back to B"
[ "$(X curl -s http://127.0.0.1:$P/api/v1/health)" = '{"status":"ok"}' ] || die "health after rollback"
X grep -q '"result": "rolled-back"' /var/lib/appbuilder/updates/history.json || die "history does not record the rollback"
ok "rolled back to B, healthy, recorded in history.json"
lap rollback "$t"

say "Tampered and unsigned packages are refused"
X sh -c 'rm -rf /root/t && mkdir /root/t && cd /root/t && unzip -q /root/appbuilder-0.5.0-e2e.3.zip && echo "evil()" >> appbuilder-0.5.0-e2e.3/server/main.ts'
set +e; out="$(X appbuilder update /root/t/appbuilder-0.5.0-e2e.3 --yes 2>&1)"; rc=$?; set -e
[ "$rc" = 3 ] && echo "$out" | grep -q 'checksum' || die "tampered package not refused: $out"
X sh -c 'rm /root/t/appbuilder-0.5.0-e2e.3/SHA256SUMS.sig; cd /root/t/appbuilder-0.5.0-e2e.3 && sed -i "\$d" server/main.ts'
set +e; out="$(X appbuilder update /root/t/appbuilder-0.5.0-e2e.3 --yes 2>&1)"; rc=$?; set -e
[ "$rc" = 3 ] && echo "$out" | grep -q 'not signed' || die "unsigned package not refused: $out"
ok "tampered: refused (checksum); unsigned: refused (install trusts a key)"

say "Re-run the installer (repair, idempotent) with HTTPS for the LAN (Caddy from its apt repository)"
t=$(ts)
X sh -c 'cd /root && rm -rf appbuilder-0.5.0-e2e.2 && unzip -q appbuilder-0.5.0-e2e.2.zip'
X bash /root/appbuilder-0.5.0-e2e.2/scripts/install/linux/install.sh --yes --port $P --https lan --lan-names abtest,localhost 2>&1 | sed 's/^/    | /'
lap reinstall-https "$t"
X test -f /var/lib/appbuilder/appbuilder-local-ca.crt || die "no local CA certificate"
[ "$(X curl -s --cacert /var/lib/appbuilder/appbuilder-local-ca.crt --resolve abtest:443:127.0.0.1 https://abtest/api/v1/health)" = '{"status":"ok"}' ] || die "health through Caddy"
login="$(X curl -s -c /root/jar2 --cacert /var/lib/appbuilder/appbuilder-local-ca.crt --resolve abtest:443:127.0.0.1 -H 'X-Appbuilder: 1' -H 'Content-Type: application/json' https://abtest/api/v1/auth/login --data '{"email":"admin@example.test","password":"e2e-admin-password-1"}' -D - )"
echo "$login" | grep -i '^set-cookie: ab_session=' | grep -qi 'secure' || die "session cookie through HTTPS is not Secure"
ok "https://abtest via Caddy's local CA: health ok, sign-in ok, session cookie Secure"

say "Diagnostics bundle from the command line (no secrets)"
X appbuilder diagnostics --out /root/diag.zip | sed 's/^/    /'
X sh -c 'mkdir -p /root/d && cd /root/d && unzip -qo /root/diag.zip && ls'
key="$(X cat /var/lib/appbuilder/workspace/.secret-key)"
X grep -rq "$key" /root/d && die "the install key is in the bundle"
X grep -rq 'e2e-admin-password-1' /root/d && die "a password is in the bundle"
ok "bundle written, no key, no password"

say "Uninstall keeping the data, reinstall picks it up, then uninstall with --remove-data"
t=$(ts)
X bash /opt/appbuilder/app/scripts/install/linux/uninstall.sh | sed 's/^/    | /'
X test -d /var/lib/appbuilder/workspace || die "data was removed"
X bash /root/appbuilder-0.5.0-e2e.2/scripts/install/linux/install.sh --yes --port $P >/dev/null 2>&1
api POST /api/v1/auth/login '{"email":"admin@example.test","password":"e2e-admin-password-1"}' | grep -q '"user"' || die "sign-in after reinstall"
ok "reinstall over kept data: the administrator signs in"
set +e; X bash /opt/appbuilder/app/scripts/install/linux/uninstall.sh --remove-data --confirm 'DELETE wrong' >/dev/null 2>&1; rc=$?; set -e
[ "$rc" = 1 ] && X test -d /var/lib/appbuilder || die "wrong confirmation text did not stop the removal"
X bash /opt/appbuilder/app/scripts/install/linux/uninstall.sh --remove-data --confirm 'DELETE abtest' | sed 's/^/    | /'
X test ! -e /var/lib/appbuilder || die "data folder still there"
[ -z "$(X runuser -u postgres -- psql -XqAt -c "SELECT 1 FROM pg_database WHERE datname='appbuilder'")" ] || die "database still there"
lap uninstall "$t"

say "Timings ($IMAGE_BASE)"
for k in build-releases container install setup backup restore update rollback reinstall-https uninstall; do printf '    %-16s %6s s\n' "$k" "${T[$k]:-?}"; done
printf '    %-16s %6s s\n' total "$(awk -v a="$START" -v b="$(ts)" 'BEGIN { printf "%.1f", b - a }')"
echo "E2E PASSED"

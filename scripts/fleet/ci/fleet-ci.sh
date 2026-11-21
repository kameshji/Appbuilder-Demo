#!/bin/sh
# The fleet on a REAL Linux machine (CI job "fleet" in .github/workflows/ci.yml, ubuntu-latest; also any throwaway
# Ubuntu 24.04 VM). DEVELOPER AND CI TOOL, not shipped. Needs root through sudo, systemd, internet access (Node.js,
# Caddy and their apt repositories), and a built web app (npm ci && npm run build). It:
#
#   builds two releases signed with a throwaway key, runs the fleet installer (scripts/fleet/install.sh: Node.js,
#   PostgreSQL settings, Caddy with its local CA, the template unit, abfleet init), creates 3 organisations, reaches
#   each over HTTPS through Caddy by host name, re-checks isolation at the OS level (users, folders, sockets, roles),
#   updates with a canary and one forced failure, backs up off the machine and restores one organisation, grants
#   and expires operator access, rotates a database password, and deletes one organisation with a verified scan.
#
# Prints PASS / FAIL / SKIP lines and a summary; exit 1 when anything FAILS. Every SKIP says why (what a hosted runner
# cannot show). Never run it on a machine that matters: it installs packages and changes PostgreSQL.
set -eu
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
WORK=$(mktemp -d /tmp/abfleet-ci-XXXXXX)
DOMAIN=fleet.test
OFFSITE=/var/backups/abfleet-offsite
PASS=0 FAILS=0 SKIPS=0
pass() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAILS=$((FAILS + 1)); printf 'FAIL  %s\n' "$*"; }
skip() { SKIPS=$((SKIPS + 1)); printf 'SKIP  %s\n' "$*"; }
ok()   { if eval "$2"; then pass "$1"; else bad "$1"; fi; }
ab()   { sudo /usr/local/sbin/abfleet "$@"; }
say()  { printf '\n=== %s\n' "$*"; }

say "Two releases signed with a throwaway key"
export APPBUILDER_RELEASE_KEY_PASSPHRASE="fleet ci throwaway passphrase"
node "$REPO/scripts/release/keygen.mjs" --out "$WORK/key" --comment 'fleet ci throwaway key' >/dev/null
PUB=$(ls "$WORK"/key/*.pub)
KEY=$(ls "$WORK"/key/*.key)
for v in 0.8.0-fleetci.1 0.8.0-fleetci.2; do
  node "$REPO/scripts/release/build.mjs" --skip-build --version "$v" --out "$WORK/rel" --trust-key "$PUB" >/dev/null
  node "$REPO/scripts/release/sign.mjs" "$WORK/rel/appbuilder-$v" --key "$KEY" >/dev/null
done
R1="$WORK/rel/appbuilder-0.8.0-fleetci.1"
ZIP2="$WORK/rel/appbuilder-0.8.0-fleetci.2.zip"
ls -la "$WORK/rel"

say "The fleet installer (the runner's own PostgreSQL, Caddy from its apt repository with --tls internal)"
sudo systemctl start postgresql
sudo mkdir -p "$OFFSITE"
sudo sh "$REPO/scripts/fleet/install.sh" --release "$R1" --domain "$DOMAIN" --tls internal --licence --postgres existing \
  --backup-target "$OFFSITE" --operator-email ops@example.test --access-email ops@example.test --yes
ok "abfleet doctor after init" "ab doctor >/dev/null"
ok "template unit installed" "systemctl cat appbuilder@.service >/dev/null 2>&1"
ok "timers enabled" "systemctl is-enabled appbuilder-fleet-backup.timer >/dev/null && systemctl is-enabled appbuilder-fleet-sweep.timer >/dev/null"
ok "licence service active" "systemctl is-active --quiet appbuilder-licence"
ok "PUBLIC has no CONNECT on postgres" "[ \"\$(sudo -u postgres psql -XAtc \"SELECT has_database_privilege('public','postgres','CONNECT')\")\" = f ]"

say "Three organisations, no manual step"
for s in acme beta core; do
  ab org create "$s" --name "$s Ltd" --admin-email "it@$s.example" --print-link --json > "$WORK/$s.json"
  ok "org create $s" "[ \"\$(jq -r .ok '$WORK/$s.json')\" = true ]"
done
id_of() { jq -r .result.id "$WORK/$1.json"; }
A=$(id_of acme) B=$(id_of beta) C=$(id_of core)
CA=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
for _ in $(seq 1 60); do sudo test -f "$CA" && break; sleep 1; done
sudo cp "$CA" "$WORK/ca.crt" && sudo chmod 644 "$WORK/ca.crt"
https() { # host method path [json body] [cookie jar]
  set -- "$1" "$2" "$3" "${4:-}" "${5:-$WORK/none.jar}"
  if [ -n "$4" ]; then
    curl -sS --cacert "$WORK/ca.crt" --resolve "$1.$DOMAIN:443:127.0.0.1" -X "$2" -H 'X-Appbuilder: 1' -H 'Content-Type: application/json' -b "$5" -c "$5" --data "$4" "https://$1.$DOMAIN/api/v1$3"
  else
    curl -sS --cacert "$WORK/ca.crt" --resolve "$1.$DOMAIN:443:127.0.0.1" -X "$2" -H 'X-Appbuilder: 1' -b "$5" -c "$5" "https://$1.$DOMAIN/api/v1$3"
  fi
}
for s in acme beta core; do
  h=''
  for _ in $(seq 1 60); do h=$(https "$s" GET /health 2>/dev/null || true); [ "$h" = '{"status":"ok"}' ] && break; sleep 1; done
  ok "https://$s.$DOMAIN answers through Caddy with a certificate of its local CA" "[ '$h' = '{\"status\":\"ok\"}' ]"
done
ok "an unknown host name gets no install (404 on http, no certificate on https)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: nobody.$DOMAIN' http://127.0.0.1/)\" = 404 ] && ! curl -s --cacert '$WORK/ca.crt' --resolve nobody.$DOMAIN:443:127.0.0.1 https://nobody.$DOMAIN/ >/dev/null 2>&1"
for s in acme beta core; do
  tok=$(jq -r .result.link "$WORK/$s.json" | sed 's/.*#invite=//')
  https "$s" POST /auth/invitation/accept "{\"token\":\"$tok\",\"password\":\"Fleet-ci-$s-pw1\"}" "" "$WORK/$s.jar" >/dev/null
  tid=$(https "$s" POST /tables '{"displayName":"Fleet mark","name":"FleetMark","columns":[{"displayName":"Title","type":"text"}]}' "" "$WORK/$s.jar" | jq -r .id)
  echo "$tid" > "$WORK/$s.table"
  ok "$s: the first administrator signs in through the one-time link and writes a row" "https '$s' POST /data/$tid/rows '{\"values\":{\"Title\":\"MARK-$s\"}}' '' '$WORK/$s.jar' | grep -q MARK-$s"
done

say "Isolation at the OS level (what local mode cannot show)"
ok "each install runs as its own user" "[ \"\$(ps -o user= -p \$(systemctl show -p MainPID --value appbuilder@$A))\" = ab-$A ]"
ok "A cannot list the installs' folder or read B's" "! sudo -u ab-$A ls /srv/appbuilder >/dev/null 2>&1 && ! sudo -u ab-$A ls /srv/appbuilder/$B >/dev/null 2>&1 && ! sudo -u ab-$A cat /srv/appbuilder/$B/workspace/.secret-key >/dev/null 2>&1"
ok "A cannot connect to B's socket" "! sudo -u ab-$A curl -s --max-time 3 --unix-socket /run/appbuilder/$B/http.sock http://x/api/v1/health >/dev/null 2>&1"
ok "B's socket: owner ab-B, group caddy, 0660" "[ \"\$(stat -c '%U %G %a' /run/appbuilder/$B/http.sock)\" = 'ab-$B caddy 660' ]"
ok "secret key and server.json 0600 of the install's user" "[ \"\$(sudo stat -c '%U %a' /srv/appbuilder/$A/workspace/.secret-key)\" = 'ab-$A 600' ] && [ \"\$(sudo stat -c '%U %a' /srv/appbuilder/$A/workspace/server.json)\" = 'ab-$A 600' ]"
reach() { sudo -u "ab-$1" env APPBUILDER_ENV_FILE="/srv/appbuilder/$1/instance.env" ABFLEET_APP="/srv/appbuilder/$1/app" /opt/appbuilder/node/bin/node /opt/appbuilder/fleet/agent.ts db-reach "$2" | tail -n 1 | jq -r .connected; }
ok "A's role reaches its own database, not B's, not postgres" "[ \"\$(reach $A ab_$A)\" = true ] && [ \"\$(reach $A ab_$B)\" = false ] && [ \"\$(reach $A postgres)\" = false ]"
ok "systemd limits on the unit (MemoryMax 1.5 GB, TasksMax 256, CPUQuota 200%)" "[ \"\$(systemctl show appbuilder@$A -p MemoryMax --value)\" = 1610612736 ] && [ \"\$(systemctl show appbuilder@$A -p TasksMax --value)\" = 256 ] && [ \"\$(systemctl show appbuilder@$A -p CPUQuotaPerSecUSec --value)\" = 2s ]"
ok "other installs' folders are not even visible inside a unit (TemporaryFileSystem)" "! sudo nsenter -t \$(systemctl show -p MainPID --value appbuilder@$A) -m ls /srv/appbuilder/$B >/dev/null 2>&1"
q=$(ab limits show acme --json | jq -r '.result[0].disk.mode')
if [ "$q" = watch ]; then skip "disk project quota: the runner's file system has no prjquota (mode '$q'; needs XFS or ext4 with project quotas: a rented server)"; else pass "disk quota mode $q"; fi

say "Update: canary, batches, beta forced to fail"
cat > "$WORK/smoke.mjs" <<'EOF'
if (process.env.ABFLEET_SLUG === 'beta') { console.error('forced failure for beta'); process.exit(1) }
process.exit(0)
EOF
chmod 644 "$WORK/smoke.mjs"
ab update "$ZIP2" --canary acme --batch 1 --on-failure continue --smoke "$WORK/smoke.mjs" --json > "$WORK/update.json" || true
ok "canary acme updated, beta rolled back alone, core updated" "[ \"\$(jq -r '[.result.steps[] | .result] | join(\",\")' '$WORK/update.json')\" = 'updated,rolled-back,updated' ]"
ok "beta runs the previous release; acme the new one" "readlink /srv/appbuilder/$B/app | grep -q fleetci.1 && readlink /srv/appbuilder/$A/app | grep -q fleetci.2"
ok "all three healthy after the update" "for s in acme beta core; do [ \"\$(https \$s GET /health)\" = '{\"status\":\"ok\"}' ] || exit 1; done"
ok "the new release is root-owned and read-only" "[ \"\$(stat -c '%U %a' /opt/appbuilder/releases/0.8.0-fleetci.2/server/main.ts)\" = 'root 644' ]"

say "Backups off the machine, restore of ONE organisation"
ok "backup run --all" "ab backup run --all >/dev/null"
ok "three encrypted copies off the machine" "[ \$(sudo find $OFFSITE -name '*-nightly-*.abbak' | wc -l) -eq 3 ]"
tidb=$(cat "$WORK/beta.table")
https beta POST "/data/$tidb/rows" '{"values":{"Title":"AFTER-BACKUP"}}' "" "$WORK/beta.jar" >/dev/null
ok "backup restore beta" "ab backup restore beta >/dev/null"
https beta POST /auth/login '{"email":"it@beta.example","password":"Fleet-ci-beta-pw1"}' "" "$WORK/beta.jar" >/dev/null
ok "beta is back at its backup" "https beta POST /query '{\"plan\":{\"version\":2,\"table\":\"FleetMark\"}}' '' '$WORK/beta.jar' | grep -q MARK-beta && ! https beta POST /query '{\"plan\":{\"version\":2,\"table\":\"FleetMark\"}}' '' '$WORK/beta.jar' | grep -q AFTER-BACKUP"
ok "acme's administrator stayed signed in" "https acme GET /auth/session '' '$WORK/acme.jar' | grep -q '\"user\"'"
ok "restore test into a scratch database" "ab backup restore-test acme >/dev/null"

say "Operator access, secrets"
ab access grant acme --reason "CI check of the access procedure" --minutes 1 --json > "$WORK/grant.json" 2>/dev/null || ab access grant acme --reason "CI check of the access procedure" --minutes 1 --print-link --json > "$WORK/grant.json"
ok "access granted (install audit, administrators told)" "[ \"\$(jq -r .ok '$WORK/grant.json')\" = true ]"
sleep 65
ok "access ends by itself (sweep)" "ab access sweep --json | jq -e '.result.ended | length == 1' >/dev/null"
ok "rotate the database password of acme" "ab secrets rotate acme --what db >/dev/null"
ok "the secret key rotation is refused as not supported" "! ab secrets rotate acme --what secret-key >/dev/null 2>&1"

say "Delete with a verified removal"
ok "org delete core" "ab org delete core --confirm core.$DOMAIN --json | jq -e '.result.remaining | length == 0' >/dev/null"
ok "no user, folder, socket folder, unit or database of core remains" "! id ab-$C >/dev/null 2>&1 && [ ! -e /srv/appbuilder/$C ] && [ ! -e /run/appbuilder/$C ] && ! systemctl is-enabled --quiet appbuilder@$C && [ -z \"\$(sudo -u postgres psql -XAtc \"SELECT 1 FROM pg_database WHERE datname='ab_$C'\")\" ]"
ok "doctor after everything" "ab doctor >/dev/null"
ab summary || true

skip "public DNS and real (ACME) certificates: a runner has no public name (Caddy's local CA was used)"
skip "reboot survival of the units, timers and sockets (tmpfiles): a runner cannot reboot"
skip "resource limits under real pressure (exit check 8) and the load test (exit check 7): a rented server"
skip "mail deliverability of invitations and the summary: no relay (one-time links printed with --print-link)"

printf '\nfleet CI: %s passed, %s failed, %s skipped\n' "$PASS" "$FAILS" "$SKIPS"
[ "$FAILS" = 0 ]

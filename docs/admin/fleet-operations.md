# Fleet operations: the operator's runbook

**Read this first.** The fleet tool `abfleet` and this runbook have **never run on a real rented server**. They were
run on a Windows developer PC in a local test mode (installs as plain processes, no systemd, no OS users, no Caddy) and
are written to run on an Ubuntu CI runner with systemd, OS users and Caddy's local certificate authority; see "What has
been proven" at the end. Public DNS, real certificates, disk quotas, reboot survival, resource limits under real
pressure and mail deliverability are unproven. Nothing here is a claim that the fleet is secure: an outside security
review has not happened (hosting spec, "Hosted testers start before an outside security review").

One Linux server (Ubuntu 24.04 or 22.04 LTS with systemd) runs up to 20 Appbuilder installs, one per organisation, each
with its own process, PostgreSQL database and role, OS user, folder, secret key and Unix socket, behind Caddy at
`<name>.<domain>`. Design: [the hosting specification](../plan/hosting-spec.md). What one install offers:
[Hosting](hosting.md). The licence service: [Licensing](licensing.md).

## Where things are

| Path | What |
| --- | --- |
| `/opt/appbuilder/releases/<version>/` | one verified release per version, root-owned, read-only; `/opt/appbuilder/current` is the one new installs start on |
| `/opt/appbuilder/fleet/` | `abfleet.ts`, `agent.ts`, `lib/` (the tool); `/usr/local/sbin/abfleet` runs it. Inside an install it runs the release's own server commands (`appbuilder status --json`, `backup create`, `admin operator-access`: [Hosting](hosting.md#server-commands-for-operators)); `agent.ts` only for releases without them and for saving the mail relay |
| `/srv/appbuilder/<id>/` | one install (root:ab-<id> 0750): `app` and `app.previous` (links to releases), `instance.env`, `workspace/` (0700), `backups/` (its own Admin console backups), `fleet-backups/`, `licence.key` |
| `/run/appbuilder/<id>/http.sock` | its socket (ab-<id>:caddy 0660; the folder is made at boot by `/etc/tmpfiles.d/appbuilder-<id>.conf`) |
| `/etc/appbuilder/fleet.json` | the registry and configuration (root 0600; no secrets in it) |
| `/etc/appbuilder/secrets/` | `backup-master.key` (opens every fleet backup), mail relay passwords (root 0700) |
| `/etc/appbuilder/licence/` | the licence service's environment, signing key and passphrase |
| `/var/lib/appbuilder-fleet/` | exports, the sealed roles dump (`globals/`) |
| `/var/log/appbuilder-fleet/audit.jsonl` | the operator audit: one JSON line per abfleet command (who, when, what, organisation, result); append-only (`chattr +a`) |
| `/etc/systemd/system/appbuilder@.service` | the template unit (one per install: `appbuilder@<id>`), limits drop-ins in `appbuilder@<id>.service.d/` |
| `/etc/caddy/Caddyfile`, `/etc/caddy/fleet.d/<id>.caddy` | the proxy: one site per organisation, everything else 404 |

`<id>` is an opaque id (`o` and 8 letters or digits). Database and role names (`ab_<id>`) and OS users (`ab-<id>`) never
carry the organisation's name: every install can read the cluster's list of databases. `abfleet org list` maps ids to
host names.

## Day one

1. Rent the server (the spec's estimate for 20 organisations of 50 people: 8 vCPU, 32 GB RAM, 400 GB NVMe; not yet
   measured under load). Point `*.<domain>` and `licence.<domain>` to it. Open ports 22, 80 and 443 only.
2. Unpack the release ZIP and check its published SHA-256, then:

   ```bash
   sudo sh appbuilder-<version>/scripts/fleet/install.sh --release appbuilder-<version> --domain apps.example.com \
     --acme-email ops@example.com --operator-email ops@example.com --access-email ops@example.com \
     --backup-target rclone:offsite:appbuilder-fleet --licence --public-ip 203.0.113.10,2001:db8::10
   ```

   (Until the release build ships `scripts/fleet`, run it from a checkout of this repository: `sudo sh
   scripts/fleet/install.sh --release <unpacked release> ...`.) It installs Node.js, PostgreSQL 17 (from
   apt.postgresql.org, its key checked by fingerprint; `--postgres existing` uses a PostgreSQL 15 or newer already on
   port 5432) with `max_connections 300`, Caddy, the tool, and runs `abfleet init`. `--dry-run` prints every step first.
   The installer passes the client tools folder of the **running** server (`/usr/lib/postgresql/<major>/bin`) to
   `abfleet init`, which records it in `fleet.json` (`config.pgBin`); every later command, and each install's
   `APPBUILDER_PG_BIN` (pg_dump for backups), uses that folder. Without it abfleet takes `pg_config --bindir`, else the
   highest `/usr/lib/postgresql/*/bin` with `psql`. After a PostgreSQL major upgrade: `sudo abfleet init --pg-bin
   /usr/lib/postgresql/<new>/bin`, then `sudo abfleet limits apply --all --restart` rewrites each install's environment.
3. **Copy `/etc/appbuilder/secrets/backup-master.key` off the server now** (a password manager and an encrypted USB key).
   Without it no fleet backup can be opened after losing the server. Keep the licence signing key
   (`/etc/appbuilder/licence/keys/`) the same way.
4. Mail: give the fleet a relay on a public address (hosted installs refuse loopback and private addresses):
   `sudo abfleet init --mail-host smtp.example.com --mail-port 587 --mail-user fleet@example.com --mail-password-file
   /root/mail.pw --mail-from fleet@example.com` (then remove the file). Each install created afterwards gets it.
5. Off-machine backups: `rclone` is an external program, installed and configured by you (`apt install rclone`, `rclone
   config`); or `--backup-target <folder>` for a mounted disk of another machine. `sudo abfleet doctor` checks it.
6. `sudo abfleet doctor`: every line must be ok.
7. The first organisation:

   ```bash
   sudo abfleet org create acme --name "Acme Pvt Ltd" --admin-email it@acme.example --plan pilot --seats 25
   ```

   About 10 to 15 seconds: OS user, folder, database and role, secret key, licence registration, `migrate`, the first
   administrator invited by email (one-time link, 7 days), unit started, Caddy site, health. Any failure removes
   everything it created and says so. `--print-link` prints the link instead of relying on email (treat it as a password).

## Every day

- Read the summary email (07:00; exceptions only: failed or old backups, installs down or near limits, failing licence
  checks, restarts, failed updates or restore tests, open operator access, alerts). No email means the summary timer
  itself is broken: `systemctl status appbuilder-fleet-summary.timer`.
- `sudo abfleet status` when something looks wrong: health, release, read-only state, users and seats against the
  licence, disk, database size, last backup, last licence check, problems.
- The timers do the rest: backups at 02:30 (`appbuilder-fleet-backup`), the restore test on the 1st of the month,
  operator access expiry every 5 minutes, the summary. `systemctl list-timers 'appbuilder-fleet-*'`.

## An update

```bash
sudo abfleet update appbuilder-0.9.0.zip --dry-run        # verifies the package, shows the order
sudo abfleet update appbuilder-0.9.0.zip                  # canary (first organisation), then batches of 5
sudo abfleet update status
```

The package is verified once against the keys of the **installed** release (signature and every checksum), unpacked to
`/opt/appbuilder/releases/<version>`, then each install is: made read-only (maintenance), stopped, snapshotted with its
own backup engine, switched, migrated, started, health-checked and smoke-checked, made writable. An install that fails
is rolled back **alone**: its `app` link goes back, and **when the database schema changed or `migrate` failed, the
pre-update snapshot is restored** (nothing is lost: the install was read-only from before the snapshot). Without a
schema change only the code goes back. The canary failing stops everything; a later failure stops the fleet unless
`--on-failure continue`. Options: `--canary <org>`, `--batch <n>`, `--smoke <script.mjs>` (your own check, run with
`ABFLEET_HOST` and `ABFLEET_SOCKET`; exit 0 = pass), `--data-rollback auto|always|never`.

Going back later: `sudo abfleet update rollback <org>`; if the newer release had migrated the database, it needs
`--restore-snapshot --confirm <host>`, which discards everything written since that update (a safety backup is taken).

## A restore

- One organisation, from its latest fleet backup: `sudo abfleet backup restore <org>` (stops only that install, keeps a
  safety copy of what is there, `appbuilder restore --force` in one transaction, starts it, health). `--from-offsite`
  uses the copy off the machine; `--file <archive>` any archive. People of that organisation sign in again (sessions are
  not in backups). No other install is stopped, read or written.
- One environment or some tables: the organisation's own administrators do it in Admin console > Backups.
- The whole server lost: install a new server (Day one, steps 1 and 2), put `backup-master.key` back into
  `/etc/appbuilder/secrets/`, then for each organisation `abfleet org create` with the same name and `abfleet backup
  restore <org> --file <its latest off-machine archive>` (the archive holds the install's key). The sealed roles dump in
  `globals/` is for reference (opening it needs the master key; abfleet has no command for it yet). **This rebuild has
  not been rehearsed yet: do it once on a scratch server before the first tester (spec risk 2).**

## An incident

1. Contain: `sudo abfleet org suspend <org> --reason "<one line people see>" --stop` (stopped, Caddy shows a notice);
   without `--stop` it is read-only (sign-in, reading and export keep working).
2. Look: `sudo abfleet org show <org>`, `journalctl -u appbuilder@<id>`, the install's own log in
   `/srv/appbuilder/<id>/workspace/logs/`, `sudo abfleet doctor`.
3. Access inside the install, visibly: `sudo abfleet access grant <org> --reason "<ticket>" --minutes 60`. This creates
   an install administrator "Operator access (<you>)" for `<access-email>+<grant>@...` with a one-time link that expires
   with the grant (at most 240 minutes), writes `install.operator_access` into the install's own audit log and tells the
   organisation's install administrators at once (an in-app notification, and an email when the install has a relay):
   who, why, until when. At the end (or `abfleet access revoke <org>`) the account is disabled, signed out everywhere,
   its tokens revoked, and the administrators are told again. `abfleet access list` shows open grants.
4. Direct database or file access is for incidents only: record it by hand with `sudo abfleet note <org> "<what and
   why>"` (it goes to the operator audit).
5. Secrets: `sudo abfleet secrets rotate <org> --what db` (a new database password, sealed again, restart, checked) and
   `--what licence-key` (the old key is revoked at once). **The secret key cannot be rotated** with this release: the
   server has no command that re-seals every stored secret (why: [Hosting](hosting.md#server-commands-for-operators));
   abfleet refuses and changes nothing.
6. Tell the organisation; keep the evidence (the operator audit, the install's audit, logs). Legal timelines: ask a
   lawyer.

## Leaving organisations

`sudo abfleet org delete <org> --confirm <full host name>` exports first (refuses to delete without a verified export
unless `--no-export`), then removes the unit, the Caddy site, the licence keys (the licence is cancelled), the database
and role, the folder, the socket folder, the drop-ins and the OS user, and scans the machine for anything left with the
id (it exits 1 and lists it if so). Kept: the export for 30 days, off-machine backups until their 14-day retention
(`--purge-offsite` removes them now), the operator audit lines.

## Limits

Defaults (spec section 4, estimates, not measured under load): `MemoryHigh 1G`, `MemoryMax 1.5G`, `CPUQuota 200%`,
`TasksMax 256`, 12 database connections per role and database, `statement_timeout 60s`, heap 1024 MB, disk 25 GB.
`sudo abfleet limits show [<org>]`; `sudo abfleet limits apply <org> --memory-max 2G` (systemd at once, PostgreSQL for
new sessions, the heap at the next restart, `--restart` to restart now). The disk limit is a project quota only on XFS
mounted with `prjquota` (or ext4 with `prjquota`); otherwise the folder size is only watched (warning at 80 %), and a
database has no size limit in PostgreSQL at all.

## Exit codes and flags

Every command: `--dry-run` (what would change; nothing changes), `--json`, an audit line. Exit 0 done, 1 failed, 2
refused (nothing changed), 64 usage, 69 not supported, 75 another abfleet command is running. A command that changes
something waits up to 120 seconds for another one (a timer's sweep or backup) to finish before it gives up with 75
(`ABFLEET_LOCK_WAIT_S` sets the wait).

## What has been proven, and what not

| | Where | Status |
| --- | --- | --- |
| Every command's plan, order and rollback (create rolled back after a failure at every step), delete's scan, the update rule, backups, access, rotation, limits, dry runs | `npx vitest run scripts/fleet` (recording fake) | run on the developer PC |
| Three organisations created without a manual step, status, suspend / resume, stop / start, export, update with a canary and one forced failure (code-only and snapshot rollback), backups off the machine, restore of one organisation with the others' checksums and sessions unchanged, restore test, operator access and expiry, database password and licence key rotation, limits in PostgreSQL, doctor, the summary email, delete with a scan | `node scripts/exit-check/h-fleet.mjs` (local test mode) | run on the developer PC |
| systemd template unit and limits, one OS user per install, folder and socket permissions, Caddy with HTTPS by host name, the fleet installer, update with real release builds | `.github/workflows/ci.yml` job `fleet` (`scripts/fleet/ci/fleet-ci.sh`) | **not passed yet**: the first runs stopped at `abfleet init` (PostgreSQL version disagreement, fixed); nothing after it has run on Linux. On a failure the job prints units, journals, the registry and doctor |
| Public DNS and real certificates, disk project quotas, reboot survival, limits under real pressure (exit check 8), the load test (exit check 7), mail deliverability, a full server rebuild from backups | a rented server | not done |

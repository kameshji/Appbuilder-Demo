# Hardening checklist

A short list for a new installation. Details are in the other pages; read the
[Security model](security-model.md) for what Appbuilder does and does not protect against.

## Installed with the installers

The [installers](installation.md) do several items below for you: a dedicated PostgreSQL role and database with a random
password sealed in `server.json`, PostgreSQL on `127.0.0.1` only, Appbuilder on `127.0.0.1` only as a service under a
low-privilege account (`NT SERVICE\Appbuilder` / the `appbuilder` user), the data folder closed to everyone else, the
workspace outside the program folder, `APPBUILDER_SECURE_COOKIE`/`APPBUILDER_TRUST_PROXY` and allowed host names when you
choose HTTPS, systemd sandboxing on Linux. Still do:

- [ ] **Check the release** before installing it: its SHA-256 against the published value, and `appbuilder version`
  afterwards shows the release keys the install trusts. Install updates only with `appbuilder update`, which refuses
  packages not signed by those keys ([Upgrades](upgrades.md)).
- [ ] **Choose the exposure deliberately** ([Which way users reach it](installation.md#which-way-users-reach-it)): no HTTPS
  option keeps Appbuilder on this machine; `Lan` opens port 443 only with `-OpenFirewall` and only for the local subnet;
  `Domain` puts it on the internet. Trust the local certificate authority only after comparing its fingerprint.
- [ ] **Do the first-run setup at once**, on the server or through an SSH tunnel; the setup code file is readable by
  administrators only and disappears afterwards. The setup cannot be done through the HTTPS address.
- [ ] **Keep the admin folder private**: on Windows, `C:\ProgramData\Appbuilder\admin` holds the PostgreSQL superuser
  password (DPAPI, machine scope) for repairs; only SYSTEM and Administrators can open it. Anyone who is an administrator of
  the PC is an administrator of the database anyway.
- [ ] **Watch health**: monitor `GET /api/v1/health` (ok / starting / degraded) and look at Admin console > Server logs
  after updates ([Operations](operations.md)).
- [ ] **Diagnostics bundles leave the building**: secrets are removed, but table, environment and host names remain; look
  inside before sending one.

## Before first start

- [ ] **Use a dedicated PostgreSQL database and role** for Appbuilder, not the `postgres` superuser and not a database that
  another application uses. The role owns its database and has no superuser, `CREATEDB` or `CREATEROLE` rights; `CONNECT` on the
  database is revoked from `PUBLIC` (`scripts/setup-postgres.ps1` / `.sh` do exactly this,
  [Installation](installation.md#prepare-the-database)).
- [ ] **Keep PostgreSQL local** unless you need otherwise: the Windows installer and the Linux packages listen on `localhost`
  only. If the database is on another machine, require SSL (`hostssl` lines in `pg_hba.conf`, *Use SSL* in the setup) and allow
  only the Appbuilder machine's address in `pg_hba.conf`.
- [ ] **Keep the server on `127.0.0.1`** (the default). Do not set `APPBUILDER_HOST=0.0.0.0`: the Host header check can
  be passed by a client that sends `Host: localhost`, so other computers reach the sign-in page and the API, and there is
  no TLS. (The first-run setup is safe from them: it checks the real connection address and needs the setup code.)
- [ ] If users reach Appbuilder through **your own HTTPS reverse proxy**, set `APPBUILDER_SECURE_COOKIE=1` (or
  `APPBUILDER_TRUST_PROXY=1` when the proxy sends `X-Forwarded-Proto: https`) so the session cookie is marked `Secure`,
  and list the proxy's host name in `APPBUILDER_ALLOWED_HOSTS` ([Installation](installation.md#environment-variables)).
  The proxy must pass WebSocket upgrades on `/api/v1/live` and keep the original `Host` and `Origin` headers
  ([Installation](installation.md#behind-a-reverse-proxy)); otherwise live updates stop (pages then refresh every 30 seconds
  and show "Live updates paused").
- [ ] **Put the workspace outside the source folder** with `APPBUILDER_WORKSPACE`, in a folder only the Windows account
  that runs Appbuilder (and administrators) can open.
- [ ] **Prefer the setup screen** over `APPBUILDER_DB_PASSWORD`: the screen stores the password encrypted, while an
  environment variable sits in plain text in your service definition.
- [ ] Prefer PostgreSQL running before Appbuilder starts (its Windows service starts automatically). If it is not, the server
  retries in the background (up to every 30 s) and shows "The database is not reachable" meanwhile; no restart is needed.

## First run

- [ ] **Do the setup yourself, immediately**, on the server PC, with the setup code printed in the server window. Until
  the first administrator exists, anyone at this PC who can read that window (or the log file it is redirected to) can
  become administrator. Keep the log file private.
- [ ] Choose a long, unique password (10 characters is the minimum, longer is better).
- [ ] **Create a second administrator** so one lost password does not lock you out (the last active administrator
  cannot be disabled or deleted).
- [ ] **Delete the sample data** (Contacts, Orders, Contacts app) if you do not want it.

## Accounts and roles

- [ ] When someone leaves, **disable the account**: their open pages lose their session and their live connection at once.
- [ ] Keep the realtime limits unless you know you need more: `APPBUILDER_LIVE_MAX_PER_USER` (default 20 sockets, one per open
  tab) and `APPBUILDER_LIVE_MAX_CONNECTIONS` (default 5,000).

- [ ] One account per person; no shared logins (the audit log names users).
- [ ] Give the **Maker** and **Administrator** roles to as few people as possible. Makers can list and link any table
  in a connected database that is not linked yet, and drop tables and columns that Appbuilder created (linked tables are
  never dropped) ([Users and roles](users-and-roles.md#what-makers-and-administrators-can-do)).
- [ ] **Do not share the Appbuilder database with other applications**: every maker can see their tables' structure and
  link them. Use a separate database (or a database user that sees only what makers may see) for each extra connection.
- [ ] Give everyone else Viewer or a custom role with the least access. Use **Test as user** to check what a role really
  sees before you rely on it.
- [ ] Remember that row filters and "own rows only" limit *what is seen*, not *what values a user may write*
  ([limits](users-and-roles.md#known-limits-of-row-filters)).
- [ ] Disable accounts when people leave (**Ban** button). Review the user list regularly.
- [ ] Passwords you set for users are temporary: Appbuilder makes them choose their own at the next sign-in. Hand them
  over (and one-time reset codes) by a different channel than the email address.
- [ ] After linking tables that existed before, use **Assign to me** (table settings) if roles with *Own* scope must see
  the old rows; otherwise those rows have no owner.

## Sign-in and identity

See [Sign-in and identity](sign-in-and-identity.md).

- [ ] **Turn on two-step verification yourself** (Settings > Profile) and store the recovery codes offline. Then require it
  for administrators at least (Admin console > Sign-in and security > Required for: Administrators), with a short grace
  period. Keep a second install administrator who can reset your two-step verification if you lose your phone.
- [ ] **Set up email** (Admin console > Email) with STARTTLS or TLS and certificate verification on, and send a test email.
  Without it, people who forget their password depend on an administrator's one-time reset code.
- [ ] Set the **public address** in Admin console > Email to the address people really use (`https://...` behind a TLS
  proxy), so links in emails point there.
- [ ] Prefer **invitations** to temporary passwords: the administrator never knows the password.
- [ ] Review the **sign-in log** (Admin console > Sign-in and security) now and then for failures from unknown addresses.
  It keeps 180 days by default (Jobs page of the Default environment).
- [ ] Decide **who sees the directory** (Admin console > Users > Directory visibility): everyone in the environment (the
  default), the same department, or administrators only.
- [ ] Decide your **audit retention** (Audit log page): off (kept forever) by default.

## Flows, approvals and connections (0.6.0)

- [ ] **Turn on the health email and a heartbeat** (Admin console > Server logs > Health email / Heartbeat): a daily
  summary, alerts at once on a degraded server, a failed backup, dead jobs and failing flows, and an outside uptime monitor
  that alerts when the pings stop (the PC is off). Email must be set up first.
- [ ] **Know where the kill switch is**: Admin console > Flows > Pause all flows (or the Flows page). It stops every flow
  of the environment between steps; nothing is lost.
- [ ] **Service accounts for flows only where needed**: a flow that runs as a service account ignores the rights of the
  people who trigger it. Review the flows marked "runs as a service account" in Admin console > Flows and the audit
  entries `flow.run_as_service`.
- [ ] **Give "use" on connections narrowly** (Connections > Access): whoever may use a connection can attach it to a flow.
  Keep each HTTP connection's host allow-list to the hosts it needs; leave "allow private network addresses" off unless
  the API is in your network.
- [ ] **Keep webhook signatures required** (the default) and give the signing secret only to the sending system; expose
  `/api/v1/hooks/...` only through the HTTPS reverse proxy, never the built-in server directly.
- [ ] **Use OAuth 2.0 for Microsoft 365 or Google Workspace mail** (Admin console > Email) instead of a mailbox password
  where you can ([installation](installation.md#email-with-microsoft-365-or-google-workspace)).
- [ ] **Lock the production environment** (Admin console > Environments): flows and approval policies then change only by
  deploying a solution, and the plan screen asks you to map connections and people and to allow service-account flows.
- [ ] Choose **who may run flows by hand** per flow (Flows > the flow > Permissions); the person who starts a run of a flow
  that runs as its owner acts with the owner's rights.
- [ ] If Appbuilder should only reach the internet (no databases or mail relay on your network), set
  `APPBUILDER_OUTBOUND_PRIVATE=deny`. Link-local and cloud metadata addresses are always refused.
- [ ] Limit **formula and rollup columns** that summarise private rows or hidden columns with column security: their
  values are computed by the system and shown to everyone who can see the column.
- [ ] Shorten the session lifetime on shared PCs (for example 60 minutes idle, 12 hours absolute), and tell people not to
  tick "Remember this device" there.
- [ ] One **service account per integration**, with a role that grants only the tables it needs; give each key an expiry
  and, for the LAN agent, an IP allow-list. Revoke keys that are not used any more (Admin console > Service accounts shows
  when each was last used).
- [ ] When someone loses their phone: Admin console > Users > the person's menu > **Reset two-step verification** (it also
  signs them out everywhere); they set it up again at the next sign-in.

## Phones, PDFs, dashboards, templates and WhatsApp (Phase 2)

- [ ] **Shared phones**: tell people to sign out from the profile menu (it deletes the phone's offline data; other ways of
  signing out only lock it), keep sessions short there, and use **Wipe phone and offline data** (Users > the person's
  menu) when a phone is lost. Keep "available offline" tables narrow (a filter such as `owner = User().Id`, a low row cap).
- [ ] **Print templates that run as a service account**: every signed-in person can print every record of the
  template's table that the service account reads. Use it only for data everyone may print; review the audit entries
  `print.run_as_service` and `print.generate_as_service`.
- [ ] **Dashboard view tokens** (TV screens): prefer a service account with narrow roles over your own account (an
  administrator's token shows every row), give each token an expiry, and revoke tokens of screens that are gone. The token
  is in the kiosk browser's address bar and history: use a dedicated browser profile on the screen, and keep reverse
  proxies from logging `Authorization` headers.
- [ ] **WhatsApp**: give "use" on the WhatsApp connection only to makers whose flows may record consent (a flow can
  record an opt-in; it is attributed, not prevented), review the opt-in history now and then, and keep the app secret set
  (without it the webhook refuses everything).

## Data and connections

- [ ] Use least-privilege database users for every extra PostgreSQL or MySQL connection (read-only where possible). A
  PostgreSQL connection names one schema; Appbuilder refuses the schemas `ab`, `env_*`, `pg_*` and `information_schema`.
- [ ] Share Google spreadsheets only with the service account and the few people who need them. Keep the service-account
  key private and delete it in Google Cloud if the PC is lost.
- [ ] Treat CSV exports as sensitive. Text cells that a spreadsheet could run as formulas (starting with `=`, `+`, `-`,
  `@`, tab or carriage return) are exported with a leading `'`; files imported from elsewhere are not checked.

## Windows machine

- [ ] Turn on **BitLocker** (or equivalent disk encryption). Appbuilder encrypts saved secrets, but the key
  (`.secret-key`) sits beside them, so anyone who can read the workspace folder can decrypt them.
- [ ] Do not rely on file permissions set by Appbuilder: its `0600` file modes are not meaningful on Windows (untested);
  set folder permissions (ACLs) yourself.
- [ ] Lock the screen. Sessions last 7 days. The cookie is marked `Secure` only over TLS or with
  `APPBUILDER_SECURE_COOKIE` / `APPBUILDER_TRUST_PROXY` (the built-in server speaks plain HTTP on loopback).
- [ ] Keep Windows, Node.js and PostgreSQL up to date (minor releases: `winget upgrade PostgreSQL.PostgreSQL.17`).

## Backups, monitoring, updates

- [ ] **Backups on and checked**: Admin console > Backups shows green (the nightly install backup ran and was verified).
  Point the **backup folder** at a second disk and set an **off-site** folder or an rclone/restic job; a backup on the same
  disk does not survive a disk failure ([Backup and restore](backup-and-restore.md)).
- [ ] **Encrypt backups that leave the machine**: save a passphrase (scheduled backups are then encrypted) and keep a copy
  of the passphrase apart. Do not include the encryption key in backups unless they are encrypted.
- [ ] **Keep `.secret-key` apart** from the backups (a password manager or a safe): without it a restore on a new machine
  loses the saved secrets; with it next to an unencrypted backup, anyone with both reads them.
- [ ] **The backup folder is only readable by the server's account** (archives hold password hashes and all data); it is
  outside the web folder by default; do not share it on the network without access control.
- [ ] **Turn on the restore test** (Backups > Schedule) and run the [restore drill](backup-and-restore.md#restore-drill) on a
  spare machine once a year ([Disaster recovery](disaster-recovery.md)).
- [ ] Downloading a backup asks for a recent sign-in; review `backup.download` entries in the install audit log.
- [ ] **Review the audit log** weekly for user, role and connection changes, failed sign-ins and rejected setup codes
  ([Audit log](audit-log.md)); it is only readable through SQL, and it is not tamper-proof.
- [ ] Watch the server console for `ERROR audit write failed` lines (an entry was lost) and for `DATABASE NOT USED`
  (an older Appbuilder was started against a newer database).
- [ ] **Update** when new versions appear, after a backup ([Upgrades](upgrades.md)).
- [ ] Know where the server's console output goes: the setup code, errors and the migration summary appear there (the
  migration summary is also in the audit log as `schema.migrate`).
- [ ] **Never expose the built-in port (5174) itself**: no `APPBUILDER_HOST=0.0.0.0`, no port forward and no tunnel that
  ends at that port; it speaks plain HTTP. Other computers and phones reach Appbuilder only through the installers'
  HTTPS option (Caddy: `--https lan` for the local network, `--https domain` for the internet) or your own TLS reverse
  proxy ([Which way users reach it](installation.md#which-way-users-reach-it)). An SSH tunnel to `127.0.0.1:5174` for
  one administrator (the first-run setup, maintenance) is fine: it is encrypted and needs an SSH login.
- [ ] **Before choosing `--https domain`** (the sign-in page on the internet), do this whole checklist, require two-step
  verification for everyone, set up email (password reset, new-device mail), and read the
  [explicit limitations](security-model.md#explicit-limitations): Appbuilder has had internal reviews only, no outside
  security review.

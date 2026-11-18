# Installation

Appbuilder is a Node.js server plus a web app. The server keeps its data in MySQL or MariaDB, and keeps a few files
(data files, attachments, an encryption key) in a *workspace folder*. You use it in a browser on the same PC.

## Requirements

| Item | Requirement | Notes |
| --- | --- | --- |
| Operating system | Windows 10 or 11 for the setup scripts | The scripts are PowerShell. The server itself is plain Node.js; our own tests and the checks for this guide ran on Linux. |
| Node.js | **22.18 or newer** | The server is TypeScript that Node runs directly (`node server/main.ts`), which needs Node 22.18+. The root `README.md` and `scripts/setup-offline.ps1` currently say "Node.js 20 or newer"; that is too low for the server. |
| git | Any recent version | Used by `setup-offline.ps1` and for [updates](upgrades.md). |
| Database | MySQL 5.7+ or 8.x, or MariaDB 10.4+ | Verified by tests on **MariaDB 10.11 only**. MySQL 8.4 has not been verified yet (decision D7 in [decisions.md](../decisions.md)). |
| Browser | A current Chrome, Edge or Firefox | Not tested or specified beyond this. |
| Internet | Needed once, to download the code and packages | After `npm ci` and `npm run build`, running needs no internet. Google Sheets connections need internet. |

## Install on Windows

1. Install [Node.js](https://nodejs.org) (22.18 or newer) and [Git for Windows](https://git-scm.com).
2. Install MySQL or MariaDB and make sure it is running (see [Prepare the database](#prepare-the-database)).
3. Open PowerShell and run the setup script from a copy of the repository:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\setup-offline.ps1
   ```

   Optional parameters: `-Path` (where to install; default `$HOME\Appbuilder-Demo`) and `-Repo` (the git URL).

   The script (`scripts/setup-offline.ps1`) does five things: checks Node.js and git, clones the repository (or runs
   `git pull --ff-only` if it is already installed), runs `npm ci`, runs `npm run build`, then starts the server in its
   own window and opens `http://localhost:5174`.
4. Complete the [first-run setup](#first-run-setup) in the browser.

To start an existing install later, run `scripts\start.ps1`, which starts `npm start` in a new window and opens the
browser. **Closing that window stops the server.** To start it automatically instead, see
[Start automatically at login](#start-automatically-at-login).

Things to know about the scripts:

- Both scripts open `http://localhost:5174`. If you change `PORT`, open the right address yourself.
- Running `setup-offline.ps1` on an existing install also **updates** it (a `git pull`). Stop the running server first,
  or the new one will fail with "Port 5174 is already in use". See [Upgrades](upgrades.md).
- On other systems: `npm ci`, `npm run build`, then `npm start`.

## Prepare the database

Appbuilder needs an empty database and a database user that owns it. Use a **dedicated database and user for
Appbuilder**. Do not point it at the database of another application: makers can link and edit any table in the
connected database (except tables starting `ab_`), see [Connections](connections.md#link-existing-tables).

### With the script

`scripts/setup-mysql.ps1` creates the database and user on a MySQL that lives in `$HOME\MySQL\mysql-*` (a portable
install with `bin\mysql.exe`, and an optional `start-mysql.cmd` that the script runs if MySQL is not listening):

```powershell
.\scripts\setup-mysql.ps1
.\scripts\setup-mysql.ps1 -MySqlHome "C:\Users\me\MySQL" -Database appbuilder -User appbuilder -Port 3306
```

It starts MySQL if needed, asks you twice for a password for the new user (minimum 10 characters; it is not shown,
logged or saved), then connects as `root` (press Enter at the prompt if root has no password) and runs the SQL below.
Database and user names may contain only letters, digits and `_`. If your MySQL is installed any other way, use the
manual SQL.

### Manual SQL

Run this as an administrative MySQL user (for example `mysql -u root -p`). Replace the password.

```sql
CREATE DATABASE IF NOT EXISTS `appbuilder` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'appbuilder'@'localhost' IDENTIFIED BY 'choose-a-long-password';
CREATE USER IF NOT EXISTS 'appbuilder'@'127.0.0.1' IDENTIFIED BY 'choose-a-long-password';
GRANT ALL PRIVILEGES ON `appbuilder`.* TO 'appbuilder'@'localhost';
GRANT ALL PRIVILEGES ON `appbuilder`.* TO 'appbuilder'@'127.0.0.1';
FLUSH PRIVILEGES;
```

This is what the script runs. Both host forms are created because Appbuilder connects over TCP to `127.0.0.1`.

**Privileges.** Makers create, alter and drop tables, so the user needs data and schema rights on its database. We
confirmed on MariaDB 10.11 that this narrower grant is enough to set up, create a table, add a column, insert rows and
drop the table: `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, INDEX`. The script grants `ALL PRIVILEGES` on the
one database. Either way, grant nothing outside that database.

**Authentication plugin (MySQL 8 and later).** If the connection fails with a message about the authentication method,
the error text suggests turning on SSL or switching the user to `mysql_native_password`. We have not verified MySQL 8.4;
note that MySQL 8.4 ships with `mysql_native_password` disabled by default.

## First-run setup

Open `http://localhost:5174` **on the PC that runs the server** (the setup screen refuses requests from any other
computer, whatever address or `Host` header they use). The setup has two steps, and both ask for the **setup code**.

**The setup code.** While setup is needed, the server prints a one-time code in its window when it starts:

```
============================================================
  FIRST-RUN SETUP CODE:  K7QD-M2XP
  Open Appbuilder on THIS computer (http://localhost:5174/) and
  type this code in the setup screen. It changes on every start.
============================================================
```

Type it in the field *Setup code (shown in the server window)*, with or without the dash. It is 8 characters from an
alphabet without look-alikes (no `0/O`, `1/I/L`), changes at every start, and is replaced (and no longer printed) as soon
as the administrator exists. 20 wrong codes within 15 minutes block further tries for a while. If you started the server
through Task Scheduler, the code is in the log file (`appbuilder.log` in the example below). The API takes it as
`setupCode` in the JSON body or in the `X-Appbuilder-Setup-Code` header.

1. **Connect your database.** Enter Host, Port, Database, User and Password. The box *Create the database if it does not
   exist* needs a user with the `CREATE` privilege (if that fails, the server carries on and the connection test
   decides). Appbuilder tests the login, creates its system tables (they all start with `ab_`), and saves the login in
   `workspace/server.json` with the password **encrypted** (see [Secrets at rest](security-model.md#secrets-at-rest)).
2. **Create administrator and sign in.** Enter your name, email and a password (minimum 10 characters). This creates the
   first user, the three built-in roles (Administrator, Maker, Viewer) and signs you in.

What else happens at step 2:

- If the workspace folder holds data from the older file-based version (`workspace.yaml`, `apps/`, `tables/`), it is
  **migrated** instead of seeding sample data. See [Upgrades](upgrades.md#migrating-an-older-file-based-workspace).
- Otherwise a **sample** is created in your database: tables *Contacts* and *Orders* (stored as `t_contacts` and
  `t_orders`) with example rows, and a *Contacts app*. Delete them from the Tables and Apps pages if you do not want them.

**Only someone at this PC who can read the server window can do the setup.** The two setup requests need no sign-in,
but they need the setup code and must come from the PC itself (the server checks the connection's real address,
127.0.0.1 or ::1, not a header). Still, finish the setup right after the first start.

After step 2:

- setup can no longer create an administrator, the code is rotated and `"setupComplete": true` is written to
  `workspace/server.json`;
- the database can be changed only by a signed-in administrator calling `POST /api/v1/setup/database` from this PC (the
  portal has no screen for it), **even while the database is unreachable**: then nobody can sign in, so re-pointing
  Appbuilder means editing `workspace/server.json` (or setting `APPBUILDER_DB_*`) and restarting. Before this change an
  unreachable database at start made the setup screen open again for anyone.
- If an administrator points Appbuilder at an empty database, the marker is cleared and a new setup code is printed, so
  a first administrator can be created there.

You can skip step 1 by setting the `APPBUILDER_DB_*` environment variables (see below). Step 2 is still needed.

## Environment variables

All are optional. Set them before starting the server (`npm start` or `node server/main.ts`). Read from
`server/main.ts`, `server/core/config.ts` and `server/core/secrets.ts`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `5174` | TCP port to listen on. A non-numeric or zero value falls back to 5174. If the port is taken the server exits with "Port N is already in use. Set PORT to another value." |
| `APPBUILDER_HOST` | `127.0.0.1` | Address to listen on. **Leave it alone**; see the warning below. |
| `APPBUILDER_WORKSPACE` | `workspace` folder next to `package.json` | The workspace folder. Use a path **outside** the repository folder (see [Upgrades](upgrades.md)). Created if missing. |
| `APPBUILDER_SECRET_KEY` | none | 64 hexadecimal characters (32 bytes). If set, it is used as the encryption key and `workspace/.secret-key` is not read or created. A value that is not exactly 64 hex characters stops the server at start. |
| `APPBUILDER_DB_HOST` | none | Together with `_NAME` and `_USER`: configures the default database at every start and **skips the setup screen**. If any of the three is missing, the variables are ignored. |
| `APPBUILDER_DB_PORT` | `3306` | |
| `APPBUILDER_DB_NAME` | none | |
| `APPBUILDER_DB_USER` | none | |
| `APPBUILDER_DB_PASSWORD` | empty | The database password, in plain text in the process environment. |
| `APPBUILDER_DB_SSL` | off | `true` turns SSL on (TLS 1.2 or newer, certificate **must verify**). |
| `APPBUILDER_ALLOWED_HOSTS` | none | Extra host names (comma-separated) that the `Host` and `Origin` headers may name, besides `localhost`, `127.0.0.1`, `::1` and the `APPBUILDER_HOST` address. Only needed behind a reverse proxy with its own name. These names are **not** proof that a request is local. |
| `APPBUILDER_SECURE_COOKIE` | off | `1`: the session cookie `ab_session` always carries `Secure` (the browser sends it only over HTTPS). Set it when users reach Appbuilder through an HTTPS reverse proxy. Without HTTPS in front, sign-in then stops working, because browsers drop `Secure` cookies on plain `http://` (except on `localhost` in current Chrome and Firefox). |
| `APPBUILDER_TRUST_PROXY` | off | `1`: trust the `X-Forwarded-Proto` header from a reverse proxy; when it says `https`, the cookie gets `Secure`. Only set it when a proxy you control is the only way to reach the port (otherwise any client can send the header; harmless for `Secure`, but nothing else is derived from it). |

Notes:

- With `APPBUILDER_DB_*` set, the database login is **not** written to `server.json`, and it takes precedence over
  `server.json`. The server also tries `CREATE DATABASE IF NOT EXISTS` for that name at start.
- Environment variables are visible to other processes running as the same Windows user. For a business install prefer
  the setup screen, which stores the password encrypted.
- Windows: set a permanent variable for your user with
  `[Environment]::SetEnvironmentVariable("APPBUILDER_WORKSPACE", "D:\AppbuilderData", "User")`, then start a new
  PowerShell.

## The workspace folder

Default: `workspace\` next to `package.json` (listed in `.gitignore`, so git never touches it). Layout:

| Path | What it is | Back it up? |
| --- | --- | --- |
| `server.json` | The saved default database login: host, port, database, user, SSL, and the password encrypted, plus `"setupComplete": true` once the first administrator exists. Written by the setup. Without `APPBUILDER_DB_*` it holds the login; with them only the marker. | Yes |
| `.secret-key` | The encryption key (64 hex characters), created on first start. **If you lose it, every saved connection password and Google key becomes unreadable.** Absent when you use `APPBUILDER_SECRET_KEY`. | **Yes, and keep it safe** |
| `files/` | One sub-folder per data file you added (the copy Appbuilder edits). | Yes |
| `attachments/` | Files uploaded into file and image columns, in sub-folders named after the first two characters of a random key. The database knows which file belongs to which row. | Yes |
| `legacy-phase2/` | Only if an older file-based workspace was migrated: the original files, moved here, never deleted. If it already exists the next one is `legacy-phase2-2`, and so on. | Yes, until you are sure you do not need it |

On Windows the file permissions set by the server (owner-only for `.secret-key`, `server.json` and attachments) are a
Unix feature and have no effect; protection comes from the folder permissions of your Windows profile. Keep the
workspace inside a folder only the Appbuilder user can read.

## Start automatically at login

Without this, someone must run `scripts\start.ps1` (or `npm start`) after every restart. Appbuilder has no installer
and no Windows service. Task Scheduler works; we have not tested these exact commands on Windows, so check them once.

1. Preferably start the database **before** Appbuilder. If the server starts while the database is down, it keeps
   retrying in the background (after 1 s, 2 s, 4 s ... then every 30 s) and picks the database up when it comes; no
   restart is needed. Meanwhile the browser shows "The database is not reachable" with a *Try again* button, and
   `GET /api/v1/status` reports `setup.unavailable: true`. (Start MySQL as a Windows service set to Automatic.) Retrying
   stops only for problems that waiting cannot fix: a password that cannot be decrypted, or a database upgraded by a newer
   Appbuilder ([Upgrades](upgrades.md#running-an-older-version-against-a-newer-database)).
2. In PowerShell, as the user who will use Appbuilder (adjust `$repo`):

   ```powershell
   $repo   = "$HOME\Appbuilder-Demo"
   $node   = (Get-Command node).Source
   $log    = "$HOME\appbuilder.log"
   $cmd    = "Set-Location '$repo'; & '$node' server\main.ts *>> '$log'"
   $action = New-ScheduledTaskAction -Execute "powershell.exe" `
             -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`"" -WorkingDirectory $repo
   $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
   $trigger.Delay = "PT1M"
   $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
               -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
   Register-ScheduledTask -TaskName "Appbuilder" -Action $action -Trigger $trigger -Settings $settings
   ```

   - `-ExecutionTimeLimit ([TimeSpan]::Zero)` matters: Task Scheduler stops tasks after 3 days by default.
   - The server writes its log to the console only; the command above appends it to `appbuilder.log`. Nothing rotates
     or deletes that file.
   - The task runs as you, so it sees your user-level environment variables. It runs only while you are signed in.
3. Test it: sign out and in, wait a minute, open `http://localhost:5174`.
4. To stop the server, end the task (`Stop-ScheduledTask -TaskName Appbuilder`); the server then shuts down cleanly.
   Stop it the same way before a backup or update.

## What listening on 127.0.0.1 means

`127.0.0.1` is the PC's *loopback* address: only programs on that PC can connect. Other computers on your network
cannot reach the server, and that is the main reason it needs no firewall or TLS setup.

It does **not** mean "only you": every user account and every program on that PC can open the port. On a PC shared by
several Windows users, or a Remote Desktop server, any of them can reach the sign-in page and the setup screen. They
still need a valid Appbuilder login, but the protection is the application's own, not the network's.

### Changing the listening address is not supported

`APPBUILDER_HOST` exists, but setting it (for example to `0.0.0.0`, or the PC's LAN address) is **not supported** and
makes the system less safe:

- The server's Host check compares the `Host` header with the configured host names, and a client chooses its headers.
  With `APPBUILDER_HOST=0.0.0.0` a computer on your network that sends `Host: localhost` passes that check and reaches the
  sign-in page and the API. (Before this version it could also run the first-run setup and make itself administrator;
  the setup now checks the connection's real address and needs the setup code, see [First-run setup](#first-run-setup).)
- There is no TLS, so passwords and session cookies would travel in clear text.
- The login throttle (below) would be the only brake on password guessing.

If you need access from another PC, use Remote Desktop to the server PC, or an SSH/VPN tunnel to the loopback port.
Do not expose the port.

## Not supported yet

- Windows service or installer, automatic start without Task Scheduler.
- HTTPS and serving other computers. (Behind your own HTTPS reverse proxy, set `APPBUILDER_SECURE_COOKIE=1` or
  `APPBUILDER_TRUST_PROXY=1` so the session cookie is marked `Secure`; this setup is not tested by us.)
- Setting up the database from the portal after the first setup (once configured, the setup screen no longer appears;
  see [Connections](connections.md#the-default-database)).
- Checking Node.js or database versions at start: an unsupported version fails with whatever error it produces.

# Troubleshooting

## Setup wizard

| Message | What to do |
|---|---|
| Could not connect to host:port: connection refused. Check that PostgreSQL is running ... | PostgreSQL is not running, or the host/port is wrong (default 5432). On Windows start the service `postgresql-x64-17` (Services, or `Start-Service postgresql-x64-17` as administrator). |
| Access denied for user "x": wrong user name or password | Re-enter the credentials, or run `scripts\setup-postgres.ps1` again (it sets a new password for the role). |
| The database "x" does not exist | Run `scripts\setup-postgres.ps1`, or tick "Create the database if it does not exist" (needs a role that may create databases). |
| User "x" may not create schemas in the database "y" | The role does not own the database. Run the `ALTER DATABASE ... OWNER TO ...` or `GRANT CREATE ...` shown in the message as the `postgres` superuser, or use the role `setup-postgres` created. |
| The server does not accept connections from this computer ... pg_hba.conf | PostgreSQL's access file has no line for this connection. Add `host appbuilder appbuilder 127.0.0.1/32 scram-sha-256` to `pg_hba.conf` and reload PostgreSQL. |
| The database uses the ... encoding; Appbuilder needs UTF8 | Create the database again with `scripts\setup-postgres.ps1` (UTF8). |
| This database holds an Appbuilder schema of version N, which is not supported on PostgreSQL | Use an empty database. |
| The setup code is missing or wrong. It is shown in the window where the Appbuilder server runs. | Type the code printed in the server window (the newest one if the server restarted). |
| This can only be done on the computer that runs Appbuilder | Open `http://localhost:5174` on the PC where the server runs. |
| Too many wrong setup codes | Wait 15 minutes, or restart the server (a new code is printed). |

## Cannot sign in

"That email and password do not match": check both. After 8 failed attempts for an email from the same computer, or more than 10 for an email from anywhere within an hour, you see "Too many attempts, wait and try again." The wait is up to 15 minutes. Restarting the server also clears the counters.

"Choose a new password" right after signing in: an administrator set your password, so you must choose your own before you continue. Type the password you were given as the current one.

"The database is not reachable": Appbuilder cannot reach PostgreSQL right now and keeps trying by itself. Start PostgreSQL, then press **Try again**.

## Port already in use

"Port N is already in use. Set PORT to another value." Another program uses the port, or Appbuilder is already running. Set `PORT` before `npm start`.

## Server will not start

The server needs Node 22.18 or newer. Check with `node --version`.

"The saved database password cannot be decrypted": the file `workspace/.secret-key` was replaced. Restore the right `.secret-key`, or delete `workspace/server.json` and run the database setup again (with the setup code from the server window).

"This database needs a newer Appbuilder" / "DATABASE NOT USED" in the server window: the database was upgraded by a newer version. Run that version, or restore a backup taken before the upgrade ([Upgrades](../admin/upgrades.md)).

## Data warnings

- "Can't run on the server: ..." on a formula: the table is too big to work through in the browser and the formula can't be
  turned into a database query. The underlined part is the problem; the message suggests a rewrite. See
  [Data: large tables](maker/data.md#large-tables-what-runs-on-the-server).
- "Runs in browser" (yellow) / a data warning that a formula runs in the browser: fine for now, the table is small; it becomes an error
  when the table passes 2,000 rows. Rewrite it the same way.
- "This query took longer than 15 seconds and was stopped": filter or sort by indexed columns (column setting **Indexed**), or narrow the
  filter. A search for text inside a column that is not indexed reads every row.
- "This query returns more than 5,000 rows" / "more than 5,000 groups": a formula asks for a very long list where it can't page (for
  example in a variable). Use `FirstN(..., n)`, filter further, or group by fewer distinct values.
- "only the first 5,000 rows are searched, sorted and counted": the table is on a MySQL, data file or Google Sheets connection, which
  can't run queries. Move it to the default database to use every row.
- "Could not add/save/delete in <table>": the server refused the write, usually for permission reasons. See [Security for makers](maker/security-for-makers.md).

## Run window blocked

"This host blocks pop-up windows... Opening Preview instead." Allow pop-ups for the Appbuilder address.

## Excel formulas disappeared

Editing a sheet in Appbuilder replaces its formulas with values in the stored copy. Your original file is untouched.

## Google Sheets: access denied

"Google denied access to the spreadsheet (HTTP N)": share the sheet with the service account email (shown in the connection dialog) as Editor, and make sure the Google Sheets API is enabled for the key's project.

## Where are the logs?

In the console window running the server, one line per event. Audit events are in the database table `ab_audit`. There is no log file.

# Troubleshooting

## Setup wizard

| Message | What to do |
|---|---|
| Could not connect to host:port: connection refused | MySQL is not running, or the host/port is wrong. Start MySQL and check. |
| Access denied for user "x": wrong user name or password | Re-enter the credentials, or run `scripts\setup-mysql.ps1` again. |
| The database "x" does not exist | Create it, or tick "Create the database if it does not exist". |
| The server uses an authentication method this connector cannot use over an insecure connection | Turn SSL on, or switch the user to `mysql_native_password` (a common MySQL 8 issue). |
| The setup code is missing or wrong. It is shown in the window where the Appbuilder server runs. | Type the code printed in the server window (the newest one if the server restarted). |
| This can only be done on the computer that runs Appbuilder | Open `http://localhost:5174` on the PC where the server runs. |
| Too many wrong setup codes | Wait 15 minutes, or restart the server (a new code is printed). |

## Cannot sign in

"That email and password do not match": check both. After 8 failed attempts for an email from the same computer, or more than 10 for an email from anywhere within an hour, you see "Too many attempts, wait and try again." The wait is up to 15 minutes. Restarting the server also clears the counters.

"Choose a new password" right after signing in: an administrator set your password, so you must choose your own before you continue. Type the password you were given as the current one.

"The database is not reachable": Appbuilder cannot reach MySQL right now and keeps trying by itself. Start MySQL, then press **Try again**.

## Port already in use

"Port N is already in use. Set PORT to another value." Another program uses the port, or Appbuilder is already running. Set `PORT` before `npm start`.

## Server will not start

The server needs Node 22.18 or newer. Check with `node --version`.

"The saved database password cannot be decrypted": the file `workspace/.secret-key` was replaced. Restore the right `.secret-key`, or delete `workspace/server.json` and run the database setup again (with the setup code from the server window).

"This database needs a newer Appbuilder" / "DATABASE NOT USED" in the server window: the database was upgraded by a newer version. Run that version, or restore a backup taken before the upgrade ([Upgrades](../admin/upgrades.md)).

## Data warnings

- "Only the first 5,000 rows are loaded" / "Data truncated": see [Data](maker/data.md).
- "Could not add/save/delete in <table>": the server refused the write, usually for permission reasons. See [Security for makers](maker/security-for-makers.md).

## Run window blocked

"This host blocks pop-up windows... Opening Preview instead." Allow pop-ups for the Appbuilder address.

## Excel formulas disappeared

Editing a sheet in Appbuilder replaces its formulas with values in the stored copy. Your original file is untouched.

## Google Sheets: access denied

"Google denied access to the spreadsheet (HTTP N)": share the sheet with the service account email (shown in the connection dialog) as Editor, and make sure the Google Sheets API is enabled for the key's project.

## Where are the logs?

In the console window running the server, one line per event. Audit events are in the database table `ab_audit`. There is no log file.

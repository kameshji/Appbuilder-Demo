# Troubleshooting

## Setup wizard

| Message | What to do |
|---|---|
| Could not connect to host:port: connection refused | MySQL is not running, or the host/port is wrong. Start MySQL and check. |
| Access denied for user "x": wrong user name or password | Re-enter the credentials, or run `scripts\setup-mysql.ps1` again. |
| The database "x" does not exist | Create it, or tick "Create the database if it does not exist". |
| The server uses an authentication method this connector cannot use over an insecure connection | Turn SSL on, or switch the user to `mysql_native_password` (a common MySQL 8 issue). |

## Cannot sign in

"That email and password do not match": check both. After 8 failed attempts for an email and address, you see "Too many sign-in attempts. Wait about 15 minutes, then try again." Restarting the server also clears the counter.

## Port already in use

"Port N is already in use. Set PORT to another value." Another program uses the port, or Appbuilder is already running. Set `PORT` before `npm start`.

## Server will not start

The server needs Node 22.18 or newer. Check with `node --version`.

"The saved database password cannot be decrypted": the file `workspace/.secret-key` was replaced. Run the database setup again.

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

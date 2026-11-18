# Connections

A *connection* tells Appbuilder where a table's rows live. There are three kinds:

| Kind | What it is | Who adds it |
| --- | --- | --- |
| **MySQL / MariaDB** | A database. One is the *default*: it also holds Appbuilder's own system tables. | Administrator |
| **Data files** | CSV, Excel (`.xlsx`) or JSON files copied into the workspace. One built-in connection, device only. | Built in; makers add files |
| **Google Sheets** | A Google spreadsheet, read and written through a Google service account. | Administrator |

Open **Connections** in the portal. Makers can see connections, test them and link existing tables; only administrators
can add, edit, delete or choose the default. Passwords and keys are never shown again after you save them.

## The default database

When you finish the first-run setup, Appbuilder creates a connection called **Default database** that points at the
database you entered. It holds the system tables (`ab_users`, `ab_roles`, `ab_audit`, and so on) and, by default, the
tables makers create.

**Do not change the Default database by editing it on the Connections page.** The system tables stay where the setup put
them (the server reads that location from `workspace/server.json` or from the `APPBUILDER_DB_*` variables), and the
Default database connection is reset to that location every time the server starts. We confirmed this: after editing the
default connection to another database, tables created afterwards appeared in that other database, but the next
restart put the connection back and the tables seemed to vanish (their data was still in the other database).

To move Appbuilder to a **different database or server**:

1. Stop the server. Back up (see [Backup and restore](backup-and-restore.md)).
2. Copy the data: dump the old database and restore it into the new one (the system tables and your tables live in the
   same database, so one dump holds both).
3. Point Appbuilder at the new database: if you use `APPBUILDER_DB_*`, change them; otherwise delete
   `workspace/server.json`. Start the server and the setup screen appears. Enter the new login. Because the new database
   already has users, you go straight to the sign-in page; nobody becomes administrator.
   (Confirmed on a test install. The setup screen is only reachable while no database is configured; there is no portal
   page to change the setup database later.)

You can also make **another MySQL connection the default for new tables** (below); that does not move the system tables.

## Add a MySQL connection

**Connections > New connection > MySQL.** Enter a name, host, port, database, user and password. *Use SSL* encrypts the
connection (TLS 1.2 or newer; the server certificate **must be valid**; a self-signed certificate is refused).

- The connection is **saved even when the test fails**. It then shows status *error* with the reason; fix it with the
  pencil button, or press **Test**.
- Use a database user with the **least privileges** the purpose needs. For read-only reporting grant `SELECT` only. Any
  write that the database refuses is reported as "The database user is not allowed to do this."
- Each connection uses a pool of at most 10 database connections with a 10-second connect timeout.
- **Never use the database of another application** (for example a website's database) unless you want makers to be
  able to read and change its tables. See [Link existing tables](#link-existing-tables).

**Set as default** (administrators): new tables are created in that connection. Only a MySQL connection that passes the
test can be the default. The default connection cannot be deleted; choose another default first.

**Delete** is refused while tables or data files still use the connection ("N table(s) use this connection ...").
Unlinking or moving them first lets you delete it.

## Link existing tables

Linking registers a table that already exists in a MySQL database or a Google Sheet so apps can use it **without
copying the rows**. **Connections** > open the connection > **Browse** shows what can be linked, then press **Link**.

- Tables whose names start with **`ab_` are never listed or linkable**: they are Appbuilder's own. (An attempt to use one
  is refused: "Tables starting with "ab_" are reserved for the platform".)
- The list shows every other table in that database, including those already used by Appbuilder as normal tables, and
  any table belonging to another program in the same database.
- Appbuilder needs to address each row by a column named **`id`**. For a table to be **writable** through Appbuilder it
  must have these five columns (this is what Appbuilder's own tables have):

  | Column | MySQL type |
  | --- | --- |
  | `id` | `CHAR(36) NOT NULL`, unique, holding a UUID text such as `9b99b3c0-e0b2-4c5b-a41b-03ec8b8e8d4a` |
  | `createdOn`, `modifiedOn` | `DATETIME(3) NULL` |
  | `createdBy`, `owner` | `VARCHAR(64) NULL` |

  New rows get a generated UUID in `id`; a table whose `id` is a number (for example `INT AUTO_INCREMENT`) cannot be
  written to.
- **Read-only fallback.** A table **without an `id` column** is linked **read-only**: apps can read it, nothing can
  change it, and Appbuilder does not alter it. You can also link any table read-only on purpose through the API.
- **Tables that have `id` but lack the other four columns do not work properly when linked from the portal.** We
  reproduced this: the table links as writable, but then every read and write fails with "A column does not exist in the
  database table". (The API can add the missing columns with consent, see below; the portal does not send that
  consent yet.) The safe route is to prepare the table yourself, once, and then link it. Example for a table
  `crm_clients` with its own key `client_no`, run as the database administrator (tested on MariaDB 10.11):

  ```sql
  ALTER TABLE crm_clients
    ADD COLUMN id CHAR(36) NULL,
    ADD COLUMN createdOn DATETIME(3) NULL,
    ADD COLUMN modifiedOn DATETIME(3) NULL,
    ADD COLUMN createdBy VARCHAR(64) NULL,
    ADD COLUMN owner VARCHAR(64) NULL;
  UPDATE crm_clients SET id = UUID(), createdOn = NOW(3), modifiedOn = NOW(3);
  ALTER TABLE crm_clients MODIFY id CHAR(36) NOT NULL, ADD UNIQUE KEY uq_crm_clients_id (id), ADD KEY ix_owner (owner);
  ```

  Back up first. Rows that existed before have no `owner`, so roles limited to *Own* rows will not see them
  ([Users and roles](users-and-roles.md#table-privileges)).
- **About the consent box.** For a table without `id`, the Browse dialog asks you to tick "I agree that Appbuilder adds
  an id column ..." before **Link** is enabled. In this version the tick is **not sent to the server**, so for MySQL the
  table is linked read-only and nothing is added; for a Google Sheet tab also read-only (see below). The server's API
  does support the consent (`ensureIdColumn: true` in `POST /api/v1/connections/:id/link`): for a MySQL table that
  already has `id` it adds the missing system columns, and for a Google Sheet tab it adds the `id` column and fills it.
  It never adds an `id` to a MySQL table that has none.
- **What a linked table gets.** Default privileges follow the rule in
  [Users and roles](users-and-roles.md#what-new-tables-get-automatically): Maker and full-access roles get full access,
  Viewer-like roles get read-only, all other roles get nothing. Give other roles privileges yourself.
- **Removing a linked table.** Unlinking only removes Appbuilder's registration. But the portal's **Delete table** button
  *drops the underlying database table and its rows* (it passes `dropSource` by default), also for a linked, writable
  table. That is the same permanent deletion as for a table created in Appbuilder. A table linked read-only cannot be
  deleted from the portal.
- Makers who link tables can also **add or remove columns** on them (`ALTER TABLE`), for writable tables.

## Data files

Use data files to work with a spreadsheet or export without a database. **Data files** page (makers).

- **Device only.** A file you add is **copied** into `workspace/files/`. The original on your disk is never read again or
  changed. Edits made in apps go to the copy. The copy is *not* in MySQL, is not in a `mysqldump`, and is not shared with
  any other PC. To take file data online it must be packaged in a solution; to turn it into a database table use *Move to
  database* (the table keeps its name, so formulas keep working).
- **File types:** `.csv`, `.xlsx`, `.json`. Other types are refused, including old `.xls`. Macro-enabled (`.xlsm`) and
  binary (`.xlsb`) Excel files are refused ("save as .xlsx"), as is any workbook containing macros.
- **Size:** the upload limit is **25 MB** per file (the file reader itself allows 50 MB, the web route stops at 25).
  Whole files are held in memory while the server runs; large files make the server slower.
- **One table per sheet.** Excel: one per sheet that has a header row (empty sheets are skipped). CSV: one table named
  after the file. JSON: an array of objects, or an object whose values are arrays of objects (one table each). A sheet
  name can be at most 31 characters in Excel, 100 otherwise.
- **First row = column names.** Names are changed to simple identifiers (letters, digits, `_`); the original header is
  kept as the display name. Types are guessed from the data: number, decimal, yes/no, date, date and time, email, link,
  text, long text.
- **Excel details that are not carried over:** a formula cell is read as the *value last calculated by Excel* (the
  formula is not kept); rich text becomes plain text; error cells become empty; only cell values are read, not
  formatting, merged cells, charts or pivot tables. We did **not** verify what happens to formatting or charts in the copy
  when Appbuilder writes changes back to the `.xlsx`; assume they are not preserved. The original file is untouched.
- **System columns** are added to the copy: `id` (a UUID), `createdOn`, `modifiedOn`, `createdBy`, `owner`.
- **Replace** loads a newer version of the file over the copy; rows are matched by `id` when the new file has it.
- **Download** returns the current copy including edits, and needs full read access (all rows, all columns) to every table
  of that file.
- A flag *modified since import* marks files whose copy has been edited.
- File connections are not for several PCs. Back up `workspace/files/` ([Backup and restore](backup-and-restore.md)).

## Google Sheets, end to end

Appbuilder talks to Google with a **service account**: a robot identity with its own email address. It can only see the
spreadsheets you share with that address. The steps below follow Google Cloud's current console; Google changes its
screens from time to time, so names may differ slightly. We have not walked through the Google console for this guide;
the Appbuilder side was checked against the code and a live test with a deliberately fake key.

1. **Create a project.** Open `console.cloud.google.com`, sign in with the Google account that will own this, and create
   (or pick) a project.
2. **Enable the Google Sheets API.** *APIs & Services* > *Library* > search *Google Sheets API* > **Enable**. (The Drive
   API is not needed.)
3. **Create a service account.** *IAM & Admin* > *Service Accounts* > **Create service account**. Give it a name. You
   do not need to grant it any project roles.
4. **Create a JSON key.** Open the service account > *Keys* > *Add key* > *Create new key* > **JSON**. A `.json` file
   downloads. It contains `client_email` and `private_key`. **Treat it like a password.** (If your Google Workspace
   administrator has blocked service-account key creation, you cannot do this step until they allow it.)
5. **Share the spreadsheet.** Open the spreadsheet in Google Sheets > **Share**. Paste the service account's
   `client_email` (it looks like `name@project.iam.gserviceaccount.com`) and choose **Editor**. Appbuilder also shows
   this address after you paste the key. Without this step Google answers "access denied".
6. **Add the connection.** *Connections > New connection > Google Sheets*. Paste the spreadsheet URL (or just its id,
   the part after `/d/`), and paste the **whole contents** of the JSON file as the key. **Add connection.** Status
   should become *connected* and the message names the spreadsheet and the service account.
7. **Link the tabs.** *Browse* the connection: each tab is a table candidate; the first row is the column names.

Things to know:

- **`id` column.** To write to a tab, Appbuilder must be able to find each row, so the tab needs a column headed `id`
  (any capitalisation) holding a **unique value in every row**. A tab without one is linked **read-only** from the
  portal (see the note about the consent box above). To make it writable, add the `id` column yourself in Google Sheets
  and give each row a unique value (a number or text), then link. The API can add and fill the `id` column with consent
  (`ensureIdColumn`).
- **Values.** Writes use `RAW` mode, so nothing a user types can turn into a formula. Dates are written as ISO text
  (`2026-03-05`, or a full ISO date-time). Column types are guessed from the first 200 rows.
- **Freshness.** Appbuilder caches a sheet for 15 seconds, so a change made directly in Google Sheets can take up to
  15 seconds to show. Writes are queued per spreadsheet. Google's rate limits apply: Appbuilder retries up to 4 times
  with growing waits (and honours Google's `Retry-After`, up to 30 seconds) on status 429 and 5xx.
- **Access rules apply only through Appbuilder.** Anyone you shared the sheet with in Google can read and edit it
  without Appbuilder's roles and filters. Share it with as few people as possible.
- **The key.** It is stored encrypted in `ab_connections` with the workspace key, and never shown again. To rotate it,
  edit the connection and paste a new key. After restoring a backup without `.secret-key` you must paste the key again
  ([Backup and restore](backup-and-restore.md)). Use a dedicated service account for Appbuilder; delete its key in Google
  Cloud if the PC is lost.
- Spreadsheet permissions: the connection asks Google for the `spreadsheets` scope (read and write of the sheets shared
  with the account).

## Test a connection

Press **Test** on a connection (makers and administrators). Appbuilder opens a fresh connection (MySQL: logs in and asks
for the server version; Google Sheets: signs in and reads the spreadsheet's title and tabs), then stores the result as
the connection's status (*connected* or *error*) and last error. Editing a connection's settings or secret re-tests it
automatically. The Data files connection has nothing to test.

## What the messages mean

### MySQL / MariaDB

| Message | Meaning and what to do |
| --- | --- |
| Could not connect to HOST:PORT: connection refused. | Nothing is listening there. Start MySQL; check host and port. |
| Could not find the server "HOST". | The host name does not resolve. Check spelling and network. |
| Timed out connecting to HOST:PORT. | Firewall, wrong address, or the machine is off. |
| The connection to HOST:PORT was closed by the server. If the server requires SSL, turn SSL on. | The server dropped the connection, often because it requires SSL. |
| Access denied for user "U": wrong user name or password. | Wrong login, or the user is not allowed from this host (`'U'@'127.0.0.1'` and `'U'@'localhost'` are different accounts). |
| The database "D" does not exist on HOST:PORT. Create it first, or check the name. | Create the database or fix the name. |
| User "U" has no access to the database "D" (or it does not exist). | Grant the user rights on that database, or fix the name. |
| The server uses an authentication method this connector cannot use over an insecure connection. Turn SSL on, or switch the user to mysql_native_password. | MySQL 8 account plugin; see [Installation](installation.md#prepare-the-database). |
| The SSL handshake with HOST:PORT failed. | The server does not support SSL (turn SSL off) or the TLS setup is wrong. |
| The server's SSL certificate could not be verified (CODE). | Use a valid certificate, or turn SSL off for a trusted local server. Self-signed certificates are refused. |
| The server does not allow connections from this machine for user "U". | Host-based block (`ER_HOST_NOT_PRIVILEGED`). |
| The server has too many connections right now. | Retry; check `max_connections`. |
| The database is not reachable | At run time: the database stopped or the network dropped. Apps get this until it is back (the pool reconnects). |
| The database user is not allowed to do this | The connection's user lacks the privilege for the action (for example `INSERT` on a read-only account). |
| A column does not exist in the database table | The table changed outside Appbuilder, or it lacks the five system columns (above). |
| The saved database password cannot be decrypted (was workspace/.secret-key replaced?). Run the database setup again. | Shown at start: the key file does not match `server.json`. Restore the right `.secret-key`, or run the setup again. |
| Tables starting with "ab_" are reserved for the platform | You tried to use an Appbuilder system table. |
| "T" was not found in "C". / "T" is already linked. | The table is gone from the source, or already registered. |

### Google Sheets

| Message | Meaning and what to do |
| --- | --- |
| The service-account key must be the JSON file downloaded from Google Cloud. | You pasted something that is not JSON. Paste the whole file. |
| The service-account key must contain "client_email" and "private_key". | Wrong or truncated file; download a new key. |
| Google Sheets needs the service-account key. | Add connection without a key. |
| Could not find a spreadsheet id. Paste the sheet URL (...) or the id itself. | The URL/id is not recognisable. |
| Google rejected the service-account credentials (REASON). Check that the key is current and the Google Sheets API is enabled for its project. | The key was deleted, disabled or never existed, or the API is off. (We saw "Invalid grant: account not found" with a fake key.) |
| Google denied access to the spreadsheet (HTTP 403 or 404). Share it with EMAIL (Editor access), and make sure the Google Sheets API is enabled for the key's project. | The sheet is not shared with the service account as Editor, the id is wrong, or the API is off. 404 can also mean a wrong id. |
| Could not reach Google: ... | No internet, a proxy, or Google is down. |
| No service-account key is configured for this connection. | The stored key is missing or unreadable (for example after a restore without `.secret-key`): paste the key again. |
| The private key in the service-account key could not be used to sign | The key is malformed or not an RSA key. |
| The spreadsheet has no tab named "T". | The tab was renamed or deleted in Google Sheets. |
| Tab "T" has no id column, so rows cannot be located. | Add an `id` column with unique values. |
| Tab "T" has no header row, so rows cannot be added. | Put column names in row 1. |

## Not supported yet

- Changing the system database from the portal.
- Other databases (PostgreSQL, SQL Server, Oracle) or other spreadsheet services.
- OAuth sign-in to Google; only service accounts work.
- Syncing data files between PCs.
- Per-connection access control beyond "administrators manage, makers link and test".

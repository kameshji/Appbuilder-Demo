# Users and roles

Access in Appbuilder has three layers, all enforced by the server:

1. **Who you are**: a user with an email and password.
2. **What kind of user you are**: *Administrator*, *Maker*, or an ordinary user.
3. **What you may do with each table**: table privileges (create/read/update/delete), column access and row filters,
   given through **roles**. A user can have several roles.

Manage users and roles on the **Security roles** page (administrators only). It has a *Roles* section and a *Users*
section.

## Built-in roles

Created when the first administrator is set up (`ensureBuiltinRoles` in `server/core/auth.ts`).

| Role | Flag | Table privileges | Apps |
| --- | --- | --- | --- |
| **Administrator** | Administrator | Everything, on every table and every app. Settings on the role are ignored. | All |
| **Maker** | Maker | Create, read, update and delete **all rows** of every table (at the time the role was created, and every table created or linked later, see below). | All |
| **Viewer** | none | Read all rows of every table. No create, update or delete. | All |

You can edit Maker and Viewer (and add your own roles). **Administrator** is special: a role with the Administrator
switch on bypasses every check. Every Administrator is also a Maker.

Roles control three separate things, so keep them apart:

- **Maker switch**: may build things (create apps, tables, connections to test, solutions). It says nothing about which
  data the person may read. The Maker role *happens to* carry full table privileges.
- **Table privileges**: what the person can do with the data.
- **App access**: which apps the person may open (below).

### What new tables get automatically

When a table is created, linked or imported, every non-administrator role gets default privileges on it
(`defaultPrivilegeFor` in `server/routes/meta/tables-core.ts`):

- a role with the Maker flag, or a role that already has full access (create, read all, update all, delete all) on
  **every** table, gets **full access** to the new table;
- the role named *Viewer* (any case), or a role that already has read-only access (read all, nothing else) on **every**
  table, gets **read-only**;
- every other role gets **no access**. This is the safe default for restricted roles; we confirmed it by running the
  server.

Read-only tables (for example linked read-only) never grant write access by default.

## Create a user

1. **Security roles** > *Users* > **Add user**. Enter name, email and the role(s).
2. After adding, use the key button on the user's row to **Set password**. Give the password to the person; they can
   change it from the account menu (**Change password**).

A user with no password cannot sign in. Users created without a role can sign in but see nothing: a user with no roles
has no apps and gets "table does not exist" for every table (confirmed by running the server).

Rules (`server/routes/meta/security.ts`):

- The email must look like an address (`name@host.tld`), at most 190 characters, and is stored in lower case. It must
  be unique. The name is required, at most 100 characters.
- Changing a role, a status or a password takes effect on the person's **next request**; it does not wait for them to
  sign in again.

## Passwords and policy

From `server/core/password.ts`:

- At least **10** characters, at most **1024**.
- Must not be the same as the user's email address (compared without case and surrounding spaces).
- That is all: there is no complexity rule, no check against common or leaked passwords, no expiry and no history.
- Stored as an scrypt hash (see [Security model](security-model.md#passwords)). Nobody, including administrators, can
  read a password.

Password changes:

- **User changes own password** (account menu): must give the current password and a different new one. All the user's
  *other* sessions (other browsers) are signed out; this one stays signed in. Wrong current passwords count towards the
  login throttle.
- **Administrator sets or resets a password** (key button on the user): the new password must meet the policy. The
  user's sessions are signed out (unless the administrator is changing their own). There is **no "must change at next
  sign-in"** option: tell the person to change it themselves.
- **No self-service reset.** There is no "forgot password" link and no email is sent. An administrator resets it. If the
  only administrator forgets the password, see [Locked out](#locked-out).

### Locked out by the login throttle

After 8 failed sign-ins for the same email within 15 minutes the server refuses further attempts (even the correct
password) with "Too many attempts. Try again in a few minutes." The counter is kept in memory: it clears by itself
after 15 minutes, or when the server restarts. Details in [Security model](security-model.md#sign-in-throttle).

### Locked out

There is no command-line password reset. If the only administrator cannot sign in, restore access by one of:
asking another administrator (create at least two administrators), or, as an advanced step, updating the
`password_hash` of an administrator in the `ab_users` table with a hash made by the server's own code. Treat the second
as a support task; we have not documented a tested procedure for it.

## Disable or delete a user

- **Disable** (the stop button on the user's row): the user can no longer sign in and their sessions end immediately. All
  their data (`createdBy`, `owner` values, audit entries) is kept. Enable again with the same button.
- **Delete** (the bin button on the user's row, with a confirmation): removes the user, their role links and their sessions. Rows they created keep
  the old user id in `createdBy` and `owner`, which no longer matches anyone. If you use "own rows" privileges, those
  rows become invisible to everyone except people with *All* scope. Prefer disabling.

### The last-administrator guard

At least one **active** user must always keep an administrator role. The server refuses (409 "At least one active user
must keep an administrator role.") to disable, delete or remove the administrator role from the last such user, to
delete the Administrator role, or to switch off its Administrator flag. You also cannot disable or delete **your own**
account. All confirmed by running the server and in `server/routes/meta/security.test.ts`.

## What makers and administrators can do

Taken from the sign-in level each API route requires (`auth: 'user' | 'maker' | 'admin'` in `server/core/*.ts` and
`server/routes/meta/*.ts`).

| Ability | Ordinary user | Maker | Administrator |
| --- | :---: | :---: | :---: |
| Sign in, sign out, change own password | yes | yes | yes |
| Open an app | only apps allowed by their roles | **every** app | every app |
| Read, add, change, delete rows, import and export CSV, upload attachments | as the table privileges allow | as the table privileges allow | everything |
| Create, edit, duplicate, delete, import and export apps | no | yes | yes |
| Create tables, add/change/remove columns, delete tables, move tables to another connection | no | yes | yes |
| Add, replace, download, delete data files | no | yes (download needs full read access to all the file's tables) | yes |
| Create, edit, delete solutions; import and export solution packages | no | yes | yes |
| Test a connection, list its tables, **link existing tables** | no | yes | yes |
| Create, edit, delete connections; set the default connection | no | no | yes |
| Create, edit, delete roles | no | no | yes |
| Create, edit, disable, delete users; set passwords | no | no | yes |
| Test as user (security preview) | no | no | yes |
| Change the database after setup | no | no | yes |
| Import roles and connections from a solution package | no | skipped with a warning | yes |

Things a Maker can do that you may not expect. **Treat Maker as a trusted role.**

- **Makers see the structure of the whole database.** Listing "source tables" of a MySQL connection shows every table
  and column in that database except those starting with `ab_`.
- **Makers can bypass table privileges by linking the same table again.** A newly linked table gets default
  privileges (above), and the Maker role gets full access. We confirmed this: after removing a Maker role's access to a
  table, a Maker linked the same physical table again through another connection and could read all its rows. If you do
  not want someone to read a table, do not give them the Maker flag.
- **Makers can destroy data.** In the portal, **Delete table** drops the underlying database table and all its rows by
  default (the confirmation says "permanently deletes N rows and the schema"; the portal sends `dropSource` unless told
  otherwise). That includes tables that were linked from an existing database, unless they were linked read-only.
  Removing a column issues `ALTER TABLE ... DROP COLUMN` on the real table. There is no recycle bin. Back up first ([Backup and restore](backup-and-restore.md)).
- **Makers can open every app** and read its definition (formulas, text, constants), whatever the app-access list says.

## Table privileges

For every table, a role sets (`server/core/security.ts`):

| Setting | Values | Meaning |
| --- | --- | --- |
| Create | yes / no | May add rows. |
| Read | None / Own / All | Which rows can be seen. |
| Update | None / Own / All | Which rows can be changed. |
| Delete | None / Own / All | Which rows can be deleted. |
| Columns | None / Read / Update per column | Hide a column, make it read-only, or editable (default). |
| Row filter | list of conditions | Further limits the rows, for Read, Update and Delete. |

- **Own** means rows whose `owner` is the user. `owner` is a system column that Appbuilder sets to the person who
  created the row. Clients cannot change it. Rows created by an import or by a script belong to whoever created them.
- **Row filter** conditions are all required (AND). Operators: *is*, *is not*, *is one of*, *contains*, *starts with*,
  *is less than*, *is at most*, *is greater than*, *is at least*, *is empty*, *is not empty*. For
  *is*, *is not*, *contains* and *starts with* the value can be **Current user** (`@me`, the user's id) or **Current
  user's email** (`@myEmail`). Text comparisons ignore upper/lower case.
- A filter on a column that no longer exists makes that role grant **nothing** on the table (it fails closed).
- A row filter applies together with the scope: Own plus a filter means "my rows that also match the filter".
- The system columns `id`, `createdOn`, `modifiedOn`, `createdBy`, `owner` can be read but never written by clients.
  `id` can never be hidden.

### Known limits of row filters

- **They control what is seen and changed, not what is written.** Row filters are applied to existing rows when
  reading, updating and deleting. They are *not* applied to the values of a new row or to a change: we confirmed that a
  user restricted to `Region = West` could create a row with `Region = East` (which they then could not see) and could
  change one of their West rows to East (which then disappeared from their view). If that matters, give the role no
  Create/Update on the filtered columns (set the column to *Read*), or restrict through Own scope instead.
- **Column access is checked on use.** A query that mentions a hidden column is refused with "You do not have access
  to the column"; hidden columns are never returned.
- **Truncation.** Apps load at most 5,000 rows per table at once; filters are applied first, so the 5,000 are the rows the
  user may see.

## How several roles combine

If a user has several roles, the **broadest** access wins, separately for each part:

- **Scope** (Read/Update/Delete): the highest of None < Own < All across the roles.
- **Create**: allowed if *any* role allows it.
- **Rows**: each role contributes its own condition (its scope plus its row filter); the user gets the rows matching
  **any** of them (OR). If one role grants all rows with no filter, the user sees all rows.
- **Columns**: for each column, the best of the roles that can read the table: Update > Read > None. A column is hidden
  only if **every** role that can read the table hides it. A column not mentioned counts as *Update*.
- **Apps**: all apps of all roles added together; "All apps" on any role means all.
- **Maker/Administrator**: any role with the flag gives it.

There is no way to *deny* something one role grants. Put restrictions in one role and give that role alone to people
who should be restricted. We confirmed these rules by running the server (see the "Staff + HR" example below) and with
`server/core/unit.test.ts` ("own scope and union of roles", "CLS ... max over granting roles").

## Worked examples

The examples use a table **Employees** with columns *Name*, *Email*, *Region*, *Salary*, *Status*. Each was run against
a real server and gave the results shown.

### Sales reps see only their own customers

Role *Sales Rep*: Employees (or your *Customers* table): **Create** yes, **Read** *Own*, **Update** *Own*, **Delete**
*None*.

- A rep who adds a row owns it. Their list shows only their rows. Another rep's rows are not listed, and asking for one
  returns "Row not found" (not "not allowed", so existence is not revealed).
- Ownership is fixed when the row is created and cannot be reassigned through Appbuilder. If customers are imported by
  an administrator, or reps change, *Own* does not fit. Use an assignment column instead:

Alternative: add a column *SalesRepEmail*, set the role to **Read** *All* and add the row filter
*SalesRepEmail is* **Current user's email**. Reassigning a customer is then an ordinary edit of that column (give
reps *Read* access to that column so they cannot reassign).

### Region managers see their region

Role *West Manager*: **Read** *All*, **Update** *All*, **Delete** *None*, with row filter *Region is West*.

- The manager sees only West rows. Create a similar role per region, or one role with the filter *Region is one of*
  `West, South` for a manager of two regions.
- For a single role that fits every manager, add a column holding the manager's email and use
  *ManagerEmail is* **Current user's email**.
- Reminder: the filter does not stop the manager from *writing* a row into another region (see limits above).

### Hide the salary column from everyone except HR

- Role *Staff*: **Read** *All* on Employees, and under **Columns** set *Salary* to **None**.
- Role *HR*: **Read** *All*, **Update** *All*, *Salary* left at **Update** (the default).

A user with only *Staff* sees every column except Salary. A query naming Salary is refused. The CSV export also leaves
the column out. A user with **both** *Staff* and *HR* sees Salary (the broadest wins).

### A read-only status column

Role *Status Read-only*: **Read** *All*, **Update** *All*, under **Columns** set *Status* to **Read**.

The user can change Name, Region and the other columns, but changing *Status* is refused with "Status is read-only for
you." The column is still visible.

## App access

Each role lists which apps its users may open: **All apps**, or a chosen list. A new role created in the portal starts
with **no apps** until you choose some (a role sent to the API without `apps` also gets none). Opening an app that is
not allowed is refused ("You do not have access to this app."); non-makers do not see other apps in the list. Makers and
administrators can open everything.

App access only controls opening the app. The data an app shows is still limited by table privileges, row filters and
column access, so give a role table privileges for every table its apps use.

Anyone who can open an app can read its definition, including every formula and text in it, by inspecting the
network traffic. Never put secrets in an app.

## Test as user

Before you tell people it works, check it. **Security roles** > **Test as user** (administrators only) shows, for a
chosen user and each table: whether they can create, read, update and delete, whether a row filter applies, how many
rows they can see, which columns are hidden and which are read-only. It is computed by the same engine that enforces
access (`GET /api/v1/security/preview`), not a copy. We confirmed that the preview for the *Staff* example listed
*Salary* as hidden and the right row count.

Test as user shows what the *rules* give. It does not sign you in as them. To see an app as someone sees it, sign in
with their account, or a test account that has the same roles.

## Not supported yet

- Denying access that another role grants (roles only add).
- Sign-in by anything other than email and password: no multi-factor, no single sign-on, no directory (Active
  Directory, Google, Microsoft) integration.
- Password expiry, complexity rules, "change at next sign-in", account lockout other than the 15-minute throttle.
- Seeing or ending other people's active sessions.
- Permissions on individual apps beyond "may open", or on individual columns of a linked Google Sheet beyond what the
  table definition shows (Appbuilder, not Google, enforces access to the sheet's data).

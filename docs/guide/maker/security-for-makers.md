# Security for makers

Administrators decide who can see and change what (see the [admin guide](../../admin/users-and-roles.md)). This page explains what your app does for a user who lacks access.

## What users experience

- **Hidden columns**: a column the role cannot see is simply absent.
- **Read-only columns**: shown with a lock icon and unchangeable. Notes such as "Read-only columns for you: ..." appear.
- **Row limits**: the user only sees the rows their role allows.
- **Refused writes**: if the server says no, the change is rolled back on screen. In the portal a toast reads "Could not add/save/delete in <table>: <reason>". In Preview or a run window, `Notify` shows the error and the Studio debug console logs it.

Test your app signed in as a restricted user, not only as an administrator. An administrator's **Test as user** shows
how many rows each table gives a user and why, and **Who can see a row?** lists everyone with access to one row.

## Who owns a row, and sharing it

Every row has an **owner** (the person who created it). Roles can give people the rows of their team, their department,
or the people who report to them, and rules can follow lookups ("rows of the sections I teach"); administrators set that
up ([Users and roles](../../admin/users-and-roles.md#which-rows-scopes), [Organisation](../../admin/organisation.md)).
In the table designer (*Settings* > *Ownership and sharing*) you decide per table:

- **Rows can be owned by teams**: a row can be given to a team. In an app: `Patch(Orders, ThisItem, {owner: First(User().Teams).Id})`
  (only a team you belong to).
- **Record sharing**: owners can share single rows. In an app:

```
Share(Gallery1.Selected, "asha@example.com", "Read")      // or "Edit"; a person (email or User()) or a team code
Unshare(Gallery1.Selected, "asha@example.com")
CountRows(SharedWith(Gallery1.Selected))                  // Name, Email, Id, Type ("User"/"Team"), Access ("Read"/"Edit")
```

`Share` and `Unshare` finish after the formula; a refusal (not the owner, sharing off) appears as a notification.
`SharedWith` is empty while it loads and refreshes by itself.

## What the app knows about the user

`User()` has `FullName`, `Email`, `Id`, `Roles`, and from the organisation `Department`, `DepartmentCode`, `Manager`
(a record with `FullName`, `Email`, `Id`), `JobTitle` and `Teams` (a table of `Name`, `Code`, `Id`). Use them to guide
people (show the right screen, prefill a field). They do not protect anything: the server applies the roles whatever the
app shows, so hiding a UI component is never a security measure.

## Writes appear instantly

Appbuilder shows a change at once (optimistic) and rolls it back if the server refuses.

## The Navigate-after-Patch caveat

```
Patch(Equipment, DataTable1.Selected, {CheckedOut: true}); Navigate(Done)
```

Navigate runs immediately, before the server has answered. If the write is refused the user is already on the Done screen.

## Recommended pattern

Use a **Form** control. It waits for the server. Put the follow-up in **OnSuccess** (`Navigate(Done)`) and the error message in **OnFailure** (`Notify(Form1.Error, NotificationType.Error)`).

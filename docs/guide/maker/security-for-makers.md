# Security for makers

Administrators decide who can see and change what (see the [admin guide](../../admin/users-and-roles.md)). This page explains what your app does for a user who lacks access.

## What users experience

- **Hidden columns**: a column the role cannot see is simply absent.
- **Read-only columns**: shown with a lock icon and unchangeable. Notes such as "Read-only columns for you: ..." appear.
- **Row limits**: the user only sees the rows their role allows.
- **Refused writes**: if the server says no, the change is rolled back on screen. In the portal a toast reads "Could not add/save/delete in <table>: <reason>". In Preview or a run window, `Notify` shows the error and the Studio debug console logs it.

Test your app signed in as a restricted user, not only as an administrator.

## Writes appear instantly

Appbuilder shows a change at once (optimistic) and rolls it back if the server refuses.

## The Navigate-after-Patch caveat

```
Patch(Equipment, DataTable1.Selected, {CheckedOut: true}); Navigate(Done)
```

Navigate runs immediately, before the server has answered. If the write is refused the user is already on the Done screen.

## Recommended pattern

Use a **Form** control. It waits for the server. Put the follow-up in **OnSuccess** (`Navigate(Done)`) and the error message in **OnFailure** (`Notify(Form1.Error, NotificationType.Error)`).

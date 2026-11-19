# When something goes wrong

Most problems are quick to fix when your administrator knows exactly what happened. A good report takes two minutes and saves a day.

## What to do right away

1. **Stop and do not repeat the action** many times (you might create duplicates).
2. **Do not close the message.** Read it.
3. **Take a screenshot** of the whole screen, including the message (on Windows: press the Windows key + Shift + S, or the Print Screen key).
4. Note the **time**, the **app**, the **screen** and the **record** (name or number).
5. Tell your **administrator**. If the work cannot wait, use your paper or Excel fallback.

## What to tell your administrator

- **Who you are** (your name and the email you sign in with).
- **What you were doing**: "I pressed Save on the order for ABC Traders".
- **The exact message**, word for word, or the screenshot.
- **The time** (to the nearest 10 minutes).
- **Does it happen every time**, or only sometimes?
- **Does it happen to others** too?
- **What you expected to happen.**

Never send your password, the code from your phone or your recovery codes, not even to the administrator.

## How to copy an error message

- Select the message text with the mouse, press **Ctrl+C**, and paste with **Ctrl+V** into an email or WhatsApp message.
- If the message disappears quickly, a screenshot is best.
- When the message came from the server, it ends with **Reference: abc123...** and a copy button. Click the button and
  paste the reference into your report: your administrator finds exactly that request in the server's log with it
  (Admin console > Server logs, search for the reference). Without a reference, they use the time and your name.

## Common messages

| What you see | What it usually means | Who can fix it |
| --- | --- | --- |
| You don't have access to this app | None of your roles includes this app | Administrator |
| Could not add / save / delete in `<table>`: ... | You are not allowed to make that change, or a rule refused it | Administrator, or your supervisor if it is a business rule |
| This record was changed by ... | A colleague saved at the same time | You: [Someone else changed this record](changed-by-someone.md) |
| Live updates paused | The live connection is blocked; screens refresh every 30 seconds | Administrator |
| The database is not reachable | The server is not ready; it retries by itself | Administrator (press **Try again**) |
| Too many attempts, wait and try again | Too many wrong passwords | Wait about 15 minutes |
| This environment is locked | The part of the system you tried to change is locked on purpose | Administrator |
| "being restored" | The system is being restored from a backup | Wait; ask your administrator |
| This query took longer than 15 seconds and was stopped | A very large list was asked for | Administrator or app builder |

## If nobody can use Appbuilder

Tell your administrator at once and say "everyone". They will check the server. Meanwhile use your fallback and write down what you did
on paper, with times, so it can be entered later.

## If you think your account was used by someone else

Change your password, end your other sessions (Settings > Profile > **Sign out everywhere else**) and tell your administrator immediately.

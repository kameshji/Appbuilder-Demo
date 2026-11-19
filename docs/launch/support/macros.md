# Reply templates (macros)

Status: working draft, 19 Nov 2026. 40 templates plus a post-incident review template. English first; a Hinglish
(Hindi in Roman letters) version where it is natural for Indian shop-floor and office customers. Use the language the
customer writes in. Keep Hinglish simple and polite ("aap"); technical terms stay in English.

Rules for every reply:

- Fill `{{placeholders}}`. Never send a template with a placeholder left in it.
- Never ask for a password, recovery code, authenticator code, `.secret-key` or backup passphrase (macro 5).
- Only describe features that exist. Planned features are called "planned" and never given a date (macros 30 to 32).
  What exists and what is planned is in [../BRIEF.md](../BRIEF.md).
- Put the ticket ID in the subject: `[SUP-{{id}}]`. Sign with the founder's name and the support number.
- Page and button names are the ones in the product: Admin console > Server logs, Users, Sign-in and security, Email,
  Backups, Jobs, Updates, Usage, Audit log; Settings > Profile / Notifications.

Index: 1 Acknowledge - 2 More details - 3 Diagnostics bundle - 4 Screen share - 5 No passwords - 6 Written access request -
7 Forgot password - 8 Reset code - 9 Lost phone with codes - 10 Admin resets two-step - 11 Too many attempts - 12 Cannot see
records - 13 Cannot open app - 14 "Table does not exist" - 15 Read-only or hidden column - 16 Formula cannot run on server -
17 Query over 15 seconds - 18 Record changed by someone - 19 Live updates paused - 20 User not getting email - 21 Relay
failing - 22 Report not received - 23 Resubscribe - 24 Update instructions - 25 Update rolled back - 26 Backup failing or old -
27 Backup hygiene - 28 Restore after deletion - 29 Lost key or passphrase - 30 Planned, not available - 31 In progress - 32 Logged,
no promise - 33 Out of scope - 34 Version too old - 35 Maintenance window - 36 Outage notice - 37 Incident update and resolved -
38 Data issue - 39 Security report acknowledgement - 40 Closing and no reply. Then the post-incident review template.

---

## A. First contact and information gathering

### 1 Acknowledge a new ticket
**English**
> Subject: [SUP-{{id}}] We have your request: {{short title}}
>
> Hello {{name}},
>
> Thank you for writing. I have logged this as ticket SUP-{{id}} and I am treating it as {{severity label}} for now
> ({{one line why}}). You will hear from me by {{time per severity target}} with either an answer or a plan.
>
> To save time, please reply with: what you were doing, the exact message on the screen (a screenshot is fine), the time it
> happened, and which person or account it happened to.
>
> {{signature}}

**Hinglish**
> Namaste {{name}} ji,
>
> Aapka message mil gaya. Maine isse ticket SUP-{{id}} ke naam se note kar liya hai ({{severity label}}). {{time}} tak
> main aapko jawab ya plan bhej dunga.
>
> Jaldi kaam ho sake, isliye please bataiye: aap kya kar rahe the, screen par exact message kya aaya (screenshot chalega),
> kitne baje hua, aur kis user ke saath hua.
>
> {{signature}}

### 2 Need more details
**English**
> Hello {{name}}, to find the cause I need three things for ticket SUP-{{id}}:
> 1. The exact text of the message (or a screenshot), and the page you were on.
> 2. The time it happened (to the nearest 10 minutes) and the person's name.
> 3. Whether it happens every time or only sometimes, and whether others see it too.
>
> If you are an administrator, a diagnostics bundle is the quickest way for me to help (I will send the steps next).
> Please do not send passwords or codes.

**Hinglish**
> {{name}} ji, ticket SUP-{{id}} ka karan dhundhne ke liye teen cheezein chahiye: (1) screen ka exact message ya screenshot
> aur page ka naam, (2) kitne baje hua aur kis user ke saath, (3) har baar hota hai ya kabhi kabhi, aur doosron ko bhi
> dikhta hai ya nahi. Password ya code mat bhejiye.

### 3 How to send a diagnostics bundle
**English**
> Hello {{name}}, please send us a diagnostics bundle. It contains versions, settings, health checks and recent errors, with
> passwords, keys and tokens removed; it does **not** contain your data, backups or the encryption key file. It does name your
> tables, environments and computer names, so please look inside before you send it.
>
> Option 1 (in the browser, as an administrator): Admin console > Server logs > **Diagnostics bundle**, then Download.
> Option 2 (on the server, also works when Appbuilder does not start): open PowerShell as administrator and run
> `& 'C:\Program Files\Appbuilder\appbuilder.cmd' diagnostics --out C:\Temp\bundle.zip`
> (Linux: `sudo appbuilder diagnostics --out bundle.zip`).
>
> Attach the ZIP to your reply by email, not WhatsApp.

**Hinglish**
> {{name}} ji, please ek diagnostics bundle bhejiye. Isme versions, settings, health checks aur haal ke errors hote hain;
> password, key aur token hata diye jaate hain; aapka data, backup ya key file isme **nahi** hota. Table aur computer ke naam
> isme dikhte hain, isliye bhejne se pehle andar dekh lijiye.
> Browser se: Admin console > Server logs > **Diagnostics bundle** > Download. Server par: PowerShell (administrator) mein
> `& 'C:\Program Files\Appbuilder\appbuilder.cmd' diagnostics --out C:\Temp\bundle.zip`. ZIP email se bhejiye.

### 4 Screen-share session
**English**
> Hello {{name}}, I would like to look at this together on a screen-share, {{date and time}}, about {{minutes}} minutes.
> Your administrator starts the session and stays in control: I will tell you where to click and you do the clicking. We will
> not look at business data unless you agree to it in writing beforehand, and I will write down when we started and finished.
> Please have {{tool}} ready ({{link or steps}}). You can end the session at any moment.

**Hinglish**
> {{name}} ji, hum {{date, time}} par screen-share par saath dekhein, lagbhag {{minutes}} minute. Session aapke
> administrator shuru karenge aur control unhi ke paas rahega: main bataunga kahan click karna hai, click aap karenge.
> Business data tabhi dekhenge jab aap pehle likhit mein haan kahein. Aap kabhi bhi session band kar sakte hain.

### 5 We never ask for passwords
**English**
> A reminder for everyone at {{customer}}: we will never ask you for a password, an authenticator code, a recovery code, the
> `.secret-key` file, the backup passphrase or the database password, in any message, call or screen-share. If someone
> claiming to be from Appbuilder asks for these, do not give them and forward the message to {{support email}}. If you have
> typed one into a screen we could see, tell us and change it.

**Hinglish**
> {{customer}} ke sabhi logon ke liye yaad-dehani: hum aapse kabhi password, authenticator code, recovery code,
> `.secret-key` file, backup passphrase ya database password nahi maangte, na message mein, na call par, na screen-share par.
> Agar koi Appbuilder ke naam par ye maange to mat dijiye aur {{support email}} par forward kar dijiye.

### 6 Written request for access to production data
**English**
> Subject: [SUP-{{id}}] Request for permission: access to production data
>
> Hello {{authorised contact}}, to resolve ticket SUP-{{id}} we may need to look at: {{exact scope: for example "the Orders
> table in the Production environment, rows from 12 to 14 November, on a screen-share driven by your administrator"}}, for
> {{reason}}, on {{date}} between {{from}} and {{to}}. We will not copy, export or keep any data, we will keep a log of what we
> saw, and you can stop us at any time. If you agree, please reply "Approved" with your name and the date. Without it we
> continue using the diagnostics bundle and what your administrator reads to us.

### 7 Forgot password
**English**
> Hello {{name}}, on the sign-in screen choose **Forgot your password?** and type your email. If your server sends email, you
> will get "Reset your password" with a link that works **once for 15 minutes**; choose a new password (a few unrelated words
> is good, at least 10 characters). Check the spam folder. If no email arrives, or the screen tells you email is not set up,
> ask your administrator for a **one-time reset code** (it works once for 24 hours): choose **I have a reset code from an
> administrator**, then type your email, the code and a new password. If you use two-step verification you will still be asked
> for the code from your phone afterwards.

**Hinglish**
> {{name}} ji, sign-in screen par **Forgot your password?** dabaiye aur apna email likhiye. Email aayega to usme "Reset your
> password" ka link hoga jo **sirf ek baar, 15 minute** chalta hai. Spam folder bhi dekhiye. Email na aaye to apne
> administrator se **one-time reset code** maangiye (24 ghante, ek baar): **I have a reset code from an administrator**
> chuniye, email, code aur naya password likhiye. Two-step verification ho to phone ka code phir bhi poochha jayega.

### 8 Reset code for the administrator to hand over
**English**
> Hello {{admin name}}, to give {{person}} a reset code: Admin console > **Users**, open the three-dot menu on their row >
> **Create one-time reset code**. It is shown **once** and works for 24 hours. Give it to them yourself (not by email, ideally
> in person or by phone). They use **I have a reset code from an administrator** on the sign-in screen. This is recorded in
> the audit log. Please do not send the code to us.

## B. Sign-in and security

### 9 Lost phone, recovery codes available
**English**
> Hello {{name}}, sign in with your password, then on the second-step screen choose **Use a recovery code** and type one of the
> 10 codes you saved when you set up two-step verification (each works once). Then open Settings > Profile > Two-step
> verification, turn the authenticator app off, set it up again on your new phone, and make **New recovery codes**; save them
> in a password manager this time.

**Hinglish**
> {{name}} ji, password se sign in kijiye, phir second-step screen par **Use a recovery code** chuniye aur setup ke time save
> kiye 10 codes mein se ek likhiye (har code ek baar chalta hai). Phir Settings > Profile > Two-step verification mein
> authenticator app band karke naye phone par dobara set up kijiye aur **New recovery codes** banakar password manager mein rakhiye.

### 10 No recovery codes: administrator resets two-step verification
**English**
> Hello {{name}}, because you have no recovery codes, an administrator must reset your two-step verification. {{admin name}}:
> Admin console > **Users** > the three-dot menu on {{name}}'s row > **Reset two-step verification** (this signs the person
> out everywhere and is recorded as `user.mfa_reset`). {{name}} then signs in with the password and sets up the app again.
> Please confirm by a call that the request really comes from {{name}} before you do this.

### 11 "Too many attempts, wait and try again"
**English**
> Hello {{name}}, Appbuilder slows down sign-in after several wrong passwords: after 8 failed tries from the same computer
> within 15 minutes it refuses more tries, even with the right password. Please wait about 15 minutes and try once, slowly. If
> you do not remember the password, use **Forgot your password?** instead of guessing. If you did not try that many times
> yourself, please tell us: someone else may be trying your email.

**Hinglish**
> {{name}} ji, kai galat password ke baad Appbuilder sign-in rok deta hai: ek hi computer se 15 minute mein 8 galat
> koshish ke baad sahi password bhi nahi chalta. Lagbhag 15 minute ruk kar ek baar dhyan se try kijiye. Password yaad na ho
> to guess mat kijiye, **Forgot your password?** use kijiye. Agar aapne itni baar try nahi kiya to hume batayiye.

### 12 "I cannot see the records / rows" (access)
**English**
> Hello {{name}}, what you see in Appbuilder depends on your roles: they decide which apps you can open, which tables you can
> read, which **rows** (for example only your own, your team's or your department's) and which **columns**. So two people
> opening the same app can see different rows. {{admin name}} can check exactly what your account gets: Admin console > Users
> (your roles), then **Security roles > Test as user** for your account, and **Who can see a row?** for one record. Please send
> the record name or number you expected to see. What we found for you: {{finding}}.

**Hinglish**
> {{name}} ji, Appbuilder mein aapko kya dikhta hai woh aapke roles par depend karta hai: kaun se app khol sakte hain, kaun si
> tables padh sakte hain, kaun si **rows** (jaise sirf aapki, aapki team ki ya department ki) aur kaun se **columns**. Isliye
> ek hi app mein do logon ko alag rows dikh sakti hain. Administrator **Security roles > Test as user** aur **Who can see a
> row?** se check kar sakte hain. Jo record aap dekhna chahte the uska naam ya number bhejiye.

### 13 "You do not have access to this app"
**English**
> Hello {{name}}, this message means none of your roles lists that app. Your administrator can add it under **Security roles >
> the role > Apps** (the role also needs rights on the tables the app uses, otherwise the app opens but shows no data). Please
> ask {{admin name}} to add **{{app name}}** for your role {{role}}.

### 14 "Table does not exist" / nothing visible after sign-in
**English**
> Hello {{name}}, an account with no role in this environment can sign in but sees nothing, and every table reports "does not
> exist". Your administrator needs to give you a role in **{{environment name}}** (Admin console > Users > your row). After
> that, sign out and in once if the page still looks empty.

### 15 A column is hidden or has a lock icon
**English**
> Hello {{name}}, a column you cannot see is hidden by your role's column security, and a column with a lock icon is read-only
> for you ("Read-only columns for you: ..."). This is by design, and applies on the server whatever the app shows. If you need
> to see or change it for your work, ask {{admin name}} to change your role's **Columns** setting for that table.

### 16 "Can't run on the server" (formula) - for the maker
**English**
> Hello {{name}}, this formula cannot be turned into a database query, and the table now has more than 2,000 rows you can see, so
> Appbuilder shows an error instead of an answer computed from part of the data. The underlined part is the problem. The
> usual fixes: compare the column itself and move the calculation to the other side (`DueDate < DateAdd(Today(), -7, "Days")`
> instead of `DateAdd(DueDate, 7, "Days") < Today()`), multiply instead of dividing by a column, store the computed value in a
> formula column, or limit the rows with `FirstN(..., 500)` first. For your formula I suggest: {{suggestion}}. The formula bar
> shows **Runs on server**, **Runs in browser** or **Can't run**: aim for the first.

### 17 "This query took longer than 15 seconds and was stopped"
**English**
> Hello {{name}}, the screen asked the database a question that reads too many rows. The usual cause is filtering, sorting or
> searching a column that is not indexed on a large table. In the table designer, open that column and switch on **Indexed**
> (it is built in the background; an index costs a little time on each save, so only for columns you really filter by), or narrow
> the filter. Which table and column is it? {{table}} has about {{rows}} rows (Admin console > Usage).

## C. Using the product

### 18 "This record was changed by someone else"
**English**
> Hello {{name}}, someone saved this record while you were editing it, so Appbuilder asks before overwriting their work.
> **Reload** shows their version (your typing is dropped); **Keep mine** makes your next Save replace theirs. If you are not
> sure, copy what you typed somewhere first, choose Reload, and enter your change again. The name in the message is the person
> who saved it, so a quick call to them usually settles it.

**Hinglish**
> {{name}} ji, jab aap edit kar rahe the tab kisi aur ne ye record save kar diya, isliye Appbuilder pooch raha hai.
> **Reload** unka version dikhata hai (aapka likha hua hat jata hai); **Keep mine** dabane par aapka Save unke version ko
> badal dega. Pakka na ho to pehle apna likha hua kahin copy kar lijiye, Reload kijiye aur apna change dobara dalein. Message mein
> jis ka naam hai unse ek call karna sabse aasan hai.

### 19 "Live updates paused"
**English**
> Hello {{name}}, "Live updates paused" means your browser cannot keep the live connection to the server open, so screens
> refresh every 30 seconds instead of at once. Everything still works. It is usually a proxy, firewall or antivirus between the
> browser and the server that blocks the live (WebSocket) connection. {{admin name}}: with a browser's developer tools >
> Network, look for a WebSocket on `/api/v1/live` with status 101; if you use your own proxy, see Installation > Behind a
> reverse proxy. With the installer's HTTPS option this works by default.

### 20 A person is not receiving notification emails
**English**
> Hello {{name}}, please open Settings > **Notifications**. For each kind the **Email** choice can be No email, Right away or In
> a digest, and a lock means your administrator decided for everyone. Also check **Quiet hours hold emails** (an email at
> night is sent when your quiet hours end) and the spam folder. **Why did I get this? > Show recent deliveries** lists what was
> sent and why. If it still fails, your administrator can look at Admin console > **Email** > delivery log for your address.

**Hinglish**
> {{name}} ji, Settings > **Notifications** kholiye. Har kind ke liye **Email** mein No email, Right away ya In a digest
> chuna ja sakta hai; lock ka matlab administrator ne sabke liye tay kiya hai. **Quiet hours hold emails** bhi dekhiye aur
> spam folder bhi. **Why did I get this?** mein dikhta hai kya bheja gaya aur kyun.

### 21 The email relay is failing (administrator)
**English**
> Hello {{admin name}}, please open Admin console > **Email**, press **Send test email** and send us the relay's answer (not the
> password). The usual causes: wrong host, port or security (STARTTLS on 587, TLS on 465), wrong password, a "from" address the
> relay is not allowed to send as, or a certificate problem. Appbuilder signs in with AUTH PLAIN or LOGIN only; if your mail
> provider requires OAuth for SMTP, use an app password or a relay account (we do not support OAuth sign-in to the relay).
> The delivery log under the form shows the last error for each message. Until it works, password resets can be done with
> one-time reset codes (Users menu).

### 22 A scheduled report did not arrive
**English**
> Hello {{name}}, let us check three things in order. (1) Scheduled reports > the report > **History**: it lists every run and
> what happened per recipient (sent, or skipped and why: for example the recipient cannot read the table, or there were no
> rows and the report is set to send nothing then). (2) Is the report **paused**, and is its time zone the one you expect? (3)
> Your administrator: Admin console > Email delivery log and Jobs. You can press **Send now** to test. Tell me what History shows
> for {{date}}.

### 23 Resubscribe to a report or notification kind
**English**
> Hello {{name}}, the "Unsubscribe" link in an email stops that kind of email without signing in. To get it back: for a
> report, open Scheduled reports and subscribe yourself again; for a notification kind, Settings > Notifications > choose Right
> away or In a digest for that kind.

## D. Updates, backups, restore

### 24 How to apply an update (administrator)
**English**
> Hello {{admin name}}, release {{version}} is ready. Please do this at {{window}}:
> 1. Read RELEASE-NOTES.md (in the package, or on Admin console > **Updates** after uploading it). Check the file's SHA-256
>    against {{hash}}: `Get-FileHash .\appbuilder-{{version}}.zip`.
> 2. Admin console > **Backups** > **Back up now** (whole install), and copy the new backup off the machine.
> 3. Check Admin console > **Server logs** shows no red items. Tell your staff the service will stop for about a minute.
> 4. Admin console > **Updates**: upload the ZIP; check it says the checksums match. Then, in PowerShell as administrator,
>    run the one command shown on that page: `& 'C:\Program Files\Appbuilder\appbuilder.cmd' update --staged`
>    (Linux: `sudo appbuilder update --staged`). Answer the confirmation.
> 5. It waits until health says ok (up to 10 minutes) and rolls the program back by itself if the new release does not start.
> 6. Sign in, open one app, test each Connection, and send us a one-line result.
> I will be on the phone from {{time}}. If anything looks wrong, do not retry: call.

### 25 The update failed and rolled back
**English**
> Hello {{admin name}}, thank you. Your system went back to {{previous version}} by itself, as designed; your data was not
> touched unless the new release had already changed the database, in which case a backup taken just before is in the backup
> folder. Please do not run the update again yet, and do not delete the folder `app.failed`. Please send a diagnostics bundle
> (macro 3) and tell me what the updater printed. I will find the cause and tell you whether a fix release is needed. Your
> users can keep working on {{previous version}} meanwhile. {{if schema changed: "Because the database was already upgraded we
> need a short call before anything else."}}

### 26 Backups are failing or old
**English**
> Hello {{admin name}}, Admin console > **Backups** shows {{finding: Failed with reason ... / last good backup older than
> 36 hours}}. Backups are your only way back, so we treat this as urgent. Please: (1) press **Back up now** and tell me the
> result, (2) check free disk space on the server and on the backup folder, (3) send a diagnostics bundle (macro 3). The
> usual causes are a full disk, a backup folder that is missing or not writable, and a server that was off at 02:00.

### 27 Backup hygiene: off-site copy and key file
**English**
> Hello {{admin name}}, a quick check from our onboarding list. Appbuilder makes a verified backup every night at 02:00, but
> that file is on the same machine. Please confirm: (1) a copy goes to a different disk, a NAS or cloud folder
> (Backups > Settings > Off-site copy), (2) the file **`.secret-key`** and the **backup passphrase** are kept in a password
> manager or a safe, apart from the backups, and two named people know where, (3) a second install administrator exists, (4)
> you have done one test restore. We cannot recover a lost key or passphrase for you, so these four matter more than anything else.

### 28 Restore after an accidental deletion
**English**
> Hello {{admin name}}, I am sorry this happened. First, please make no further changes to the affected table. What we can do:
> Admin console > **Backups** > **Restore** on the last backup from before {{time}}: you can **Browse** the table as it was
> (read-only) to confirm the rows are there, then restore **selected tables as new tables** or the whole backup **as a new
> environment**, and copy the rows back. Anything entered after that backup was made is not in it. {{backup time}} is the closest
> backup, so we may lose changes made since. Can we do this together at {{time}}? Table events do not run for restored rows;
> we will refresh the rollups afterwards.

### 29 Lost encryption key or backup passphrase
**English**
> Hello {{admin name}}, I want to be clear about what this means. **Encryption key (`.secret-key`) lost:** all your data, users,
> apps and settings come back from a backup, but the saved secrets must be entered again: passwords of connections to other
> systems, the mail server password, two-step verification secrets (people set up their app again) and the saved backup
> passphrase. **Backup passphrase lost:** an encrypted backup cannot be opened by anyone, including us; please make a new
> backup now, with a passphrase you store safely, while the system is running. Let us do the first step together at
> {{time}}.

## E. Saying no, "not yet" and boundaries

### 30 Planned, not available yet
**English**
> Hello {{name}}, thank you for asking. **{{feature}}** is not available in Appbuilder today. It is on our plan ({{phase
> name in words, e.g. "the next big step after automation"}}), but I cannot give a date, and I would rather tell you that than
> promise something. What you can do today: {{workaround or "nothing equivalent"}}. I have added your request to our list with
> your business reason, which helps us decide the order. If the feature is essential for you now, tell me, and we should decide
> together whether Appbuilder is right for you at this moment.

**Hinglish**
> {{name}} ji, poochne ke liye shukriya. **{{feature}}** abhi Appbuilder mein available nahi hai. Ye hamari planning mein hai, par
> main koi date nahi de sakta; jhoot bolne se achha hai saaf batana. Abhi aap ye kar sakte hain: {{workaround}}. Maine aapki
> request business reason ke saath list mein daal di hai. Agar ye aapke liye abhi zaroori hai to bataiye, saath mein tay karenge
> ki abhi Appbuilder aapke liye sahi hai ya nahi.

### 31 In progress (flows and approvals)
**English**
> Hello {{name}}, **{{flows / approvals}}** are still being built; the engine exists but the screens people would use are not
> finished, so we do not offer it for production use yet. {{What exists today: for example "a table event can send a notification
> and a status column can show where a request stands"}}. I will tell you when it is ready to be tested with you; I cannot give a
> date today.

### 32 Request logged, no promise
**English**
> Hello {{name}}, thank you; I have logged this ({{feature}}) with your reason: {{reason}}. I want to be honest that logging a
> request is not a commitment: we decide the order by how many customers need it and how it fits the plan. I will tell you if
> it moves to a release. In the meantime: {{workaround}}.

### 33 Out of scope (custom work, other software, hardware)
**English**
> Hello {{name}}, I am afraid {{request}} is outside what support covers ({{reason: e.g. "it concerns your network/printer/other
> software" or "it is new development"}}). I can help in two ways: {{suggest: a paid services session / a recommended person
> / documentation}}. Please tell me which you prefer, and I will send a short estimate for the services option.

### 34 Version too old
**English**
> Hello {{name}}, you are running {{version}}; we support the current release ({{current}}) and the one before it. Your problem
> may already be fixed in {{current}} (release notes: {{link}}). Please update with our checklist (macro 24) and we will look at it
> again if it persists. For the first update we will be on the phone with you.

## F. Maintenance, incidents, security

### 35 Maintenance window notice
**English**
> Subject: Planned maintenance {{date}} {{time}} for {{customer}}
>
> Hello team, on {{date}} between {{start}} and {{end}} Appbuilder will be unavailable for about {{expected minutes}} minutes
> while we {{apply release {{version}} / restart / restore test}}. Please save your work before {{start}}. Open pages reconnect
> by themselves afterwards; if a page looks stuck, refresh it. If anything is not working at {{end}}, call {{support number}}.
> Nothing needs to be done by you.

**Hinglish**
> Team ke liye soochna: {{date}} ko {{start}} se {{end}} ke beech Appbuilder lagbhag {{minutes}} minute band rahega
> ({{reason}}). Kripya {{start}} se pehle apna kaam save kar lein. Baad mein pages apne aap dobara jud jayenge; atak jaye to
> refresh kijiye. {{end}} tak sab theek na ho to {{support number}} par call kijiye.

### 36 Incident: outage notice (first message)
**English**
> Subject: [SUP-{{id}}] Appbuilder is not available at {{customer}}: we are working on it
>
> Hello {{name}}, at {{time}} we learned that {{what is affected}}. We are investigating now. **What we know:** {{facts}}.
> **What we do not know yet:** {{unknowns}}. **What you can do:** {{workaround e.g. paper forms}}; please do not restart the
> server repeatedly and do not delete anything. **Next update:** by {{time}} (at least every {{interval}}). Your data is
> {{safe / being checked}}: {{one sentence}}.

**Hinglish**
> {{name}} ji, {{time}} par pata chala ki {{kya affect hua}}. Hum abhi jaanch kar rahe hain. **Jo hume pata hai:** {{facts}}.
> **Jo abhi pata nahi:** {{unknowns}}. **Aap abhi kya karein:** {{workaround}}; server ko baar baar restart na karein aur kuch
> delete na karein. **Agla update:** {{time}} tak. Data ke baare mein: {{one sentence}}.

### 37 Incident: update and resolved
**English (update)**
> Update {{n}} at {{time}} for SUP-{{id}}: {{what changed}}. Current state: {{state}}. Next step: {{step}}. Next update by
> {{time}}.

**English (resolved)**
> Subject: [SUP-{{id}}] Resolved: {{short title}}
>
> Hello {{name}}, service was restored at {{time}} after {{duration}}. **Cause (what we know now):** {{cause}}. **What we did:**
> {{actions}}. **Data:** {{data statement: nothing lost / changes between {{a}} and {{b}} were lost and are listed in
> {{attachment}}}}. **What you should check:** {{checks}}. **What we will change so it does not happen again:** {{actions with
> owners and dates}}. I will send a short written review by {{date}}.

### 38 Data issue notice
**English**
> Subject: [SUP-{{id}}] Important: a data issue in {{system/area}}
>
> Hello {{name}}, we found that {{what is wrong: e.g. "totals in the Invoices rollup were wrong between X and Y"}}. **Who and
> what is affected:** {{scope}}. **How it happened:** {{cause or "still being established"}}. **What we recommend now:**
> {{do not use, use with check, nothing}}. **How we will fix it:** {{restore from backup / recalculate}}; any restore means
> changes after {{backup time}} would need to be entered again, so **we will not do it without your agreement**. Please
> tell me who can decide, and when.

### 39 Security report: acknowledgement (to a researcher or a customer)
**English**
> Subject: Re: security report: received
>
> Hello {{name}}, thank you for telling us about {{short description}}. I received it at {{time}} and I am treating it as
> serious until I have looked at it. Please do not share the details publicly or test against anyone else's installation while
> we investigate. I will confirm whether we can reproduce it by {{date within 3 business days}} and keep you updated at least
> every {{5}} business days. If you can, please send: the version (`appbuilder version`), steps to reproduce, and what you saw;
> please do not include real customer data. We are a very small team and do not yet have a formal reward programme; we will
> credit you if you wish, once the issue is fixed.

(Customer version: replace the last two sentences with: "Please keep the machine as it is, do not delete logs, and send a
diagnostics bundle (macro 3); we are starting runbook 9 now and will call you within {{S1 target}}.")

### 40 Closing a ticket, and a follow-up when there is no reply
**English (closing)**
> Hello {{name}}, I am closing SUP-{{id}}: {{one-line summary of the cause and fix}}. To prevent it: {{prevention}}. If it comes
> back, reply to this email and it reopens. Was this helpful? One line of feedback ("good", "slow", "unclear") helps us improve.

**English (no reply after 5 business days)**
> Hello {{name}}, I have not heard back on SUP-{{id}} since {{date}}. Is it still a problem? If I do not hear from you by
> {{date}} I will close it, and you can reopen it by replying any time.

**Hinglish (closing)**
> {{name}} ji, SUP-{{id}} close kar raha hoon: {{summary}}. Dobara aaye to is email ka reply kar dijiye, ticket phir khul jayega.

---

# Post-incident review template

Use after every S1 and every S2 that lasted more than one business day. Written within 5 business days, blameless, shared with
the customer in a shorter form (sections 1, 2, 4, 6 and 7). Keep it to two pages. File name: `PIR-{{yyyy-mm}}-{{id}}`.

| | |
| --- | --- |
| Ticket / severity | SUP-{{id}} / S{{n}} |
| Customer, version, install type | {{customer}}, {{version}}, {{Windows/Linux, HTTPS mode}} |
| Detected / first response / mitigated / resolved | {{times, IST}} |
| Duration of impact (who could not do what) | {{hours, people, work stopped}} |
| Author, date | {{name}}, {{date}} |

1. **Summary** (three sentences): what happened, impact, how it ended.
2. **Impact**: users affected; data lost or wrong (what, from when to when); money or work effects the customer reported;
   security impact (any data exposed? was customer data accessed by us?).
3. **Timeline** (IST): detection, each action, each message to the customer (with the macro used), each decision and who made
   it. Include what we looked at in the customer's system and under which written request (data access log, support model
   section 10).
4. **Root cause and contributing factors**: the technical cause (with the log line, setting or doc section), why it was not
   prevented (a check missing, a default, a doc gap), why it was not detected sooner (a health check or alert missing).
5. **What went well / what went badly** (process: did we meet the response target; was the runbook right; were macros
   usable; what did the customer have to guess).
6. **Customer actions agreed** (their side: off-site backup, second administrator, key location, a window, training).
7. **Our actions**, each with an owner, a due date and a type: **product fix** (bug or gap: give the roadmap phase), **doc fix**
   (the doc and section), **runbook/macro fix**, **monitoring/health-check addition**, **customer education**. Add every product item
   to the feedback list in [README.md](README.md).
8. **Follow-up**: date of the check that the actions worked; whether the customer accepted the explanation; whether this
   changes the severity definitions or targets.

Rules: no blame on individuals (including the founder and the customer's staff); no customer data in the review; facts with
times, not adjectives; one honest sentence about anything we do not know.

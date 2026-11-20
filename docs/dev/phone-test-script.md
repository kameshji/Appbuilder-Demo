# Phone test script (real devices)

The automated check (`scripts/exit-check/p2-phone.mjs`) runs in headless Chrome with phone emulation. It does **not**
prove anything on a real phone, on iOS Safari, with a real camera, real QR codes, the native camera of "Take photo", a
real keyboard or real Wi-Fi. Run this script on real devices before a release and file the result with the release
notes.

Devices: at least one **Android phone with Chrome** (Android 12 or newer) and one **iPhone with Safari** (iOS 16 or
newer). Server: installed with HTTPS for the LAN (`docs/admin/phones.md`). Test data: a table Production (Line text
required, Qty number, Code text, Photo image), a phone-size app with a Scan input, a Barcode scanner (Continuous on) and
a Form (Item `{Code: ScanInput1.Value}`), **Works offline (entry)** on. Printed labels: one QR code, one EAN-13, one Code
128. A Bluetooth keyboard-wedge scanner if you have one.

Mark each box; write the device and browser version at the top.

Device / OS / browser: ______________________ Tester: __________ Date: __________

## A. Trust and install

| # | Step | Expected | Android | iPhone |
| --- | --- | --- | --- | --- |
| A1 | Install the LAN certificate (admin guide) and open `https://<server>/` | no certificate warning | [ ] | [ ] |
| A2 | Scan **Open on a phone** QR from a PC | the sign-in page opens | [ ] | [ ] |
| A3 | Sign in, with two-step verification | works at phone width, keyboard does not cover the field | [ ] | [ ] |
| A4 | My apps | "Add to Home screen" help for this phone; no sideways scrolling | [ ] | [ ] |
| A5 | Open the app, add it to the home screen | icon with the app's initials and colour | [ ] | [ ] |
| A6 | Start from the icon | the app opens full screen (no browser bar) | [ ] | [ ] |
| A7 | Rotate the phone | the screen gets wider, still scrolls vertically | [ ] | [ ] |

## B. Scan, photo, touch

| # | Step | Expected | Android | iPhone |
| --- | --- | --- | --- | --- |
| B1 | Scan input camera button, allow the camera | camera opens (back camera) | [ ] | [ ] |
| B2 | Scan the EAN-13 and the Code 128 | the field gets the code, OnScan runs | [ ] | [ ] |
| B3 | Scan the QR code | Android: the code; iPhone: the sheet says QR codes cannot be read here | [ ] | [ ] |
| B4 | Torch button (if shown) | the torch lights | [ ] | [ ] |
| B5 | Barcode scanner, Continuous, scan 3 labels | 3 entries, no duplicates within 2 s | [ ] | [ ] |
| B6 | Keyboard-wedge scanner into Scan input | value = code, OnScan runs | [ ] | [ ] |
| B7 | Deny the camera, try again | a message says how to allow it | [ ] | [ ] |
| B8 | Form > Take photo | the phone's camera app opens; photo appears in the form, upright | [ ] | [ ] |
| B9 | Tap a small checkbox slightly outside it | it toggles; no zoom on double tap | [ ] | [ ] |
| B10 | Tap a text field near the bottom | the keyboard does not cover it; no zoom (iPhone) | [ ] | [ ] |
| B11 | Pull down at the top of the app | data reloads, the page does not reload | [ ] | [ ] |

## C. Offline

| # | Step | Expected | Android | iPhone |
| --- | --- | --- | --- | --- |
| C1 | Turn Wi-Fi and mobile data off; scan, fill, take a photo, Save | "Saved on this device", "You're offline", "2 waiting to send" | [ ] | [ ] |
| C2 | Open "waiting to send" | both items, Waiting | [ ] | [ ] |
| C3 | Turn the connection on | the count disappears within ~30 s; one row with the photo on the PC | [ ] | [ ] |
| C4 | Offline: save; close the browser completely; reconnect; open the app | the change is sent once (check on the PC) | [ ] | [ ] |
| C5 | Offline: edit a row; on a PC change the same row; reconnect | "Changed on the server": Keep mine / Use the server's both work | [ ] | [ ] |
| C6 | Offline: save a row the server refuses (add a validation rule first) | "Refused by the server" with the reason; Fix and resend works | [ ] | [ ] |
| C7 | Walk out of Wi-Fi range and back while saving 5 rows | all 5 arrive once, in order | [ ] | [ ] |
| C8 | Offline: try to delete a row | a clear message; nothing is lost | [ ] | [ ] |
| C9 | Sign out with a change waiting | asks first; after sign-out nothing is left (Settings > site data shows no offline database) | [ ] | [ ] |
| C10 | Admin wipes the user's device data; reconnect on the phone | waiting changes are discarded; the app works again | [ ] | [ ] |

## D. Update

| # | Step | Expected | Android | iPhone |
| --- | --- | --- | --- | --- |
| D1 | Install a new version on the server; reopen the app | "New version available — Reload"; Reload shows the new version | [ ] | [ ] |
| D2 | Changes waiting during the update | still waiting after Reload; sent when online | [ ] | [ ] |

## E. Signatures, tables kept on the phone, drafts, Back

Extra test data: a table Visits (Part text, Note text, Signature image); in the app a Signature pad, a button with
`Patch(Visits, Defaults(Visits), {Part: "Pad", Signature: SignaturePad1.FileToken})` and a Form on Visits with
**Signature fields** `"Signature"`; a table Parts with about 3,000 rows marked **Available offline** with a row limit of
1,000; a Dropdown or Combo box over Parts; a Dialog that opens from a button.

| # | Step | Expected | Android | iPhone |
| --- | --- | --- | --- | --- |
| E1 | Sign on the pad with a finger, slowly and fast | smooth line, follows the finger, the page does not scroll or refresh | [ ] | [ ] |
| E2 | Sign with a stylus (if available); tap once without drawing | stylus works; a single tap does not count as signed | [ ] | [ ] |
| E3 | Save with the button; open the row's picture on a PC | a clear PNG signature on white, not stretched | [ ] | [ ] |
| E4 | Form: sign, go offline, Save, reconnect | 2 waiting, then the row with its signature arrives once | [ ] | [ ] |
| E5 | Print the visit with a template that has an image block on Signature | the signature prints | [ ] | [ ] |
| E6 | Open the app online | "Getting Parts ready for offline use" progress, then "Only 1,000 of ... rows" | [ ] | [ ] |
| E7 | Go offline; search Parts in the dropdown / combo box | matches from the kept rows appear; nothing from beyond the limit | [ ] | [ ] |
| E8 | Sign in as a user with a row filter on Parts; open the app; go offline | only that user's rows are offline | [ ] | [ ] |
| E9 | Type into a form, then reload the page (pull the browser's reload) | "Draft restored" with the values; Discard empties it | [ ] | [ ] |
| E10 | Type into a form, switch to other apps until the phone discards the tab, come back | the draft is restored | [ ] | [ ] |
| E11 | Open a dropdown sheet; use the Back gesture | the sheet closes, the app stays | [ ] | [ ] |
| E12 | Open the Dialog; use the Back gesture; then Back once more | the dialog closes; the next Back leaves the page as usual (no dead Back) | [ ] | [ ] |
| E13 | Sign out, sign in again | no draft and no kept rows remain from before | [ ] | [ ] |

Result: ____ of 45 passed. Failures and notes:

# Phone apps

How to build apps that people use on their phones on the shop floor: design size and layout, scanning, photos, working
without a connection, and testing on a phone.

## Design for a phone

- **New app > Phone** (360 x 800) or **Start with data > Phone** (a list screen and a form screen). 360 px wide is the
  narrowest common phone; 390 and 412 are also offered.
- On a phone the app is drawn **1:1 at the phone's width** and **scrolls vertically**. A wider phone (or the phone
  turned sideways) makes the screen wider: set **AnchorH = Stretch** on fields, buttons and lists so they use the width.
  A phone narrower than your design shows the whole screen slightly smaller (never a sideways scroll). Content below
  the design height scrolls; anything anchored to the bottom stays at the bottom of the screen.
- Fingers need room: make tappable things **at least 44 px high**. Smaller UI components (a 24 px checkbox, a rating)
  get an invisible 44 px touch area automatically, but neighbours closer than that compete for taps. Leave 8 px between
  tappable things.
- Nothing appears "on hover" on a phone. Do not hide actions behind hover.
- Prefer a **Gallery** or **List** over a **Data table** on phones (the data table has no card layout yet).
- Dropdowns, combo boxes and date pickers open their desktop lists, which work by touch but are small; for a short list
  of choices use **Radio group** or **Segmented control** with large items.
- Pull down at the top of a running app to reload its data.

## Scanning barcodes and QR codes

- **Scan input** is a text field for codes. A Bluetooth or USB scanner that types like a keyboard fills it and runs
  **OnScan** (a burst of keys ending with Enter, faster than a person types). The camera button scans with the camera.
  ![The camera scanner](../../images/phone/03-scanner.png)
- **Barcode scanner** is a button that opens the camera; the code is in `Value`, its type in `Format`, and **OnScan**
  runs. **Continuous** keeps the camera open for stock counts: OnScan runs for every code (the same code again after 2
  seconds), for example `Collect(Counted, {Code: Scanner1.Value})`.
- **Formats**: "All" or a list such as "qr, ean13, code128".
- Which codes work where: Chrome on Android reads QR, Data Matrix, EAN, UPC, Code 128, Code 39 and ITF with the camera.
  iPhones and desktop browsers read EAN, UPC, Code 128, Code 39 and ITF with the camera, **but not QR codes or Data
  Matrix**. Keyboard scanners work everywhere. If your labels are QR codes and people use iPhones, give them keyboard
  scanners or use barcodes.
- **Scan to find a record**: `LookUp(Parts, Code = ScanInput1.Value)` in a label or a form's Item.
- **Scan to fill a form**: a form in New mode takes starting values from an Item that is not a row:
  set the form's **Item** to `{Code: ScanInput1.Value}` and scan before filling the other fields.

## Photos

A form field for an **image** column shows **Take photo** on phones (the phone's own camera opens) and **Use camera** on
computers with a camera. Photos are turned the right way up and made smaller (at most 1600 px on the longer side) before
they are uploaded, so they arrive fast on plant Wi-Fi; the photo's location data is not uploaded. A column with
**multiple** allows several photos.

## Device() and Location()

- `Device().Kind` is "Phone", "Tablet" or "Desktop"; also `Platform`, `Touch`, `Online`, `Standalone` (opened from the
  home screen), `ScreenWidth`, `ScreenHeight`, `Orientation`. Example: `If(Device().Online, "", "Offline: saved on this phone")`.
- `Location()` asks for the position once (the browser asks the user the first time) and updates formulas when it
  arrives: `Location().Latitude`, `.Longitude`, `.Accuracy` (metres), `.Status` ("Pending", "Ready", "Denied",
  "Unavailable", "NeedsHttps"). `UpdateLocation()` in a button asks again. Location needs HTTPS.

## Working without a connection

Turn on **App settings > Works offline (entry)** for apps people use where Wi-Fi drops. Then, on the phone:

- **Adding and changing rows and taking photos** without a connection works: the change is saved on the phone
  (encrypted) and the screen shows "You're offline" and "N waiting to send". When the connection returns, the changes are
  sent in the order they were made, exactly once.
- **Screens** show the last data the phone loaded while it was connected. A search or filter the phone never ran shows
  "Could not reach the server" instead of data.
- **Not without a connection**: deleting, approvals, running flows, connector actions. They fail with a message.
- **Server rules win**: a change the server refuses (a validation rule, a required column, a permission) waits on the
  phone with the reason; the person fixes and resends it or discards it. If someone else changed the same row meanwhile,
  the person chooses "Keep mine" or "Use the server's".
- Opening the app for the first time, or after closing the browser, needs a connection once.
- Formulas that read big tables run on the server: offline they show their last result or "Could not reach the server".

## Testing on a phone

1. The server must be reachable over HTTPS from the phone (ask your administrator; see the administrator guide "Phones on
   the local network").
2. On your PC, open **My apps** and tap the QR icon (**Open on a phone**) on the app's card; scan the code with the phone.

   ![Open on a phone: the QR code of an app](../../images/phone/10-open-on-phone.png)

3. On the phone, add it to the home screen (Android: menu > Add to Home screen; iPhone: Share > Add to Home Screen).
4. Test with Wi-Fi off: save a row, turn Wi-Fi on, check it arrives once.

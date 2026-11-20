# Phones on the local network

How to let people use Appbuilder apps on their phones on the plant or office network: HTTPS, trusting the local
certificate on Android and iPhone, adding apps to the home screen, and what offline data on phones means for you.

## Phones need HTTPS

Phones can open Appbuilder over plain `http://<server-ip>` and use the apps online, but **the camera, the scanner, the
location, "Add to Home screen" and working offline all need HTTPS** (browsers allow them only on secure addresses;
`localhost` counts as secure, other computers and phones do not).

1. Install (or reinstall) with HTTPS for the local network: Windows `-Https Lan -OpenFirewall`, Linux `--https lan
   --ufw` (see [Installation](installation.md#https)). Add the server's IP address to the certificate names
   (`-LanNames appserver,192.168.1.10` / `--lan-names ...`): many phones cannot resolve Windows computer names or
   `.local` names, so give phones the IP address.
2. Trust the local certificate authority on every phone, once (below). Without it the phone shows a certificate warning
   and the browser refuses the service worker, so offline use and installation do not work even if the user taps
   "continue anyway".
3. Give people the address `https://<ip-or-name>/`. Easiest: on a PC, open My apps, use **Open on a phone** (the QR
   icon) on an app's card and let them scan it with the phone camera.

The certificate authority file is `appbuilder-local-ca.crt` in `C:\ProgramData\Appbuilder` (Windows) or
`/var/lib/appbuilder` (Linux). Check its SHA-256 fingerprint on the phone against the server's
(`openssl x509 -noout -fingerprint -sha256 -in appbuilder-local-ca.crt`) before trusting it.

### Android (Android 11 to 15; menu names differ slightly between makers)

1. Copy `appbuilder-local-ca.crt` to the phone (email it to yourself, a USB cable, or a shared folder). Do not rename the
   extension.
2. Open **Settings > Security and privacy > More security settings > Encryption and credentials > Install a
   certificate > CA certificate** (Samsung: **Settings > Security and privacy > Other security settings > Install from
   device storage > CA certificate**).
3. Confirm "Install anyway", unlock with the phone's PIN, pick the file.
4. Check under **Trusted credentials > User** that "Caddy Local Authority" is listed.
5. Open `https://<server>/` in **Chrome**. No warning must appear. (Chrome trusts certificates installed this way; some
   other apps do not, which does not matter here.)

A phone with a work profile (Android Enterprise): install it in the work profile, or push it through your device
management (MDM) as a trusted CA.

### iPhone and iPad (iOS / iPadOS 16 to 18)

1. Send `appbuilder-local-ca.crt` to the phone by email or AirDrop and open it. iOS says "Profile Downloaded".
2. Open **Settings > General > VPN and Device Management**, tap the downloaded profile, **Install**, enter the passcode,
   **Install** again.
3. Then **Settings > General > About > Certificate Trust Settings**: turn on **full trust** for "Caddy Local
   Authority". (This second step is easy to miss; without it Safari still warns.)
4. Open `https://<server>/` in **Safari**. No warning must appear.

Managed iPhones: deploy the certificate with your MDM as a trusted root.

## Adding apps to the home screen

People open an app on the phone, then: Android Chrome **menu (⋮) > Add to Home screen / Install app**; iPhone Safari
**Share > Add to Home Screen**. The icon starts that app directly, full screen. My apps shows these steps on phones.
See [Using apps on your phone](../help/phone.md).

## Offline data on phones: what you should know

Apps a maker marked **Works offline (entry)** keep, on the phone, the screens' last loaded data and the changes made
without a connection (encrypted with a key the server issues for the user and the phone, held only while the browser
session lasts). The details and the threat model are in the developer documentation (`docs/dev/phone.md`, "Threat
model"). For you:

- A **lost or stolen phone**: Admin console > **Users** > the person's menu > **Wipe phone and offline data**. Every
  phone of that person discards its offline data the next time it connects, and data left on a phone that never
  connects again cannot be decrypted with a key the server will issue. Also end their sessions (Users > Sessions) and,
  if needed, reset their password. People can do the wipe for themselves under Settings > Data and privacy.
- Changes **not yet sent** are lost by a wipe and by signing out (sign-out asks first).
- An unlocked phone with the browser open is as good as a signed-in PC: keep session lifetimes short for phone users and
  require two-step verification (Admin console > Sign-in and security).
- Server rules (permissions, validation rules, table events) apply when the changes arrive; a refused change waits on
  the phone with the reason until the person fixes or discards it.
- Signing out on a shared phone deletes that person's offline data and the browser's cached copy of the application.

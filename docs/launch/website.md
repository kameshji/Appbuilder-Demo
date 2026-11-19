# Marketing website

Status: first build, 19 November 2026. The source is in `website/`. Nothing is deployed, and no domain is set up yet.
The product name, prices, contact addresses and domain are placeholders, set in one file (`website/site.config.json`).
The copy follows [BRIEF.md](BRIEF.md). It was then checked against [marketing/strategy.md](marketing/strategy.md) and
[marketing/brand-foundations.md](marketing/brand-foundations.md), which were written alongside it (see section 9).

## 1. What is there

25 pages: 24 English and 1 Hindi landing page. All are plain static HTML, built by a zero-dependency Node script.

| Path | Page |
|---|---|
| `/` | Home. It has the hero, the problem (Excel, WhatsApp and Tally) and a "sheet to app" walkthrough built from real screenshots. Then come the features (each with an available, in-progress or planned badge), a planned-features strip, who it is for, a summary comparison, a "Where we are" box, FAQ and a final call to action |
| `/hi/` | Hindi landing page. It is a shorter version of the home page. Translation still to be checked by a native speaker |
| `/product/` and five sub-pages | Apps and Studio; Data and security; Automation (marked "in progress"); Collaboration; Admin and operations. Each has real screenshots and a "Not built yet" box |
| `/solutions/`, `/solutions/manufacturing/`, `/solutions/other-teams/` | Manufacturing: three example apps that can be built today, each labelled "example, not a customer project". Templates are labelled planned |
| `/pricing/` | Seat bands and passes taken from the config, the on-premises vs VPS choice, an ROI estimator and an FAQ. Prints cleanly on A4 (see `website/review/pricing-print.pdf`) |
| `/compare/` and four sub-pages | Comparisons with Power Platform, Zoho Creator, ERPNext, and Excel with WhatsApp. Each has a dated source list and a "when the other option is better" section |
| `/pilot/` | The pilot programme and its application form |
| `/contact/` | Contact form with a topic choice (`?topic=demo` preselects it) |
| `/docs/` | Links into the GitHub docs |
| `/security/` | What the product does, what we do not claim, and how to report a vulnerability (points to SECURITY.md) |
| `/about/` | Founder-led and honest about the current status |
| `/legal/privacy/`, `/legal/terms/` | Skeletons, marked "Draft, to be reviewed by a lawyer" |
| `/404.html` | Not-found page |

Two interactive elements, both client-side only:

- **Walkthrough** (home and Hindi pages). Four tabs of real screenshots: import a CSV, Start with data, a formula,
  then the running app. It uses the ARIA tab pattern with arrow keys. "Play" advances every 5 seconds and never
  starts by itself. With JavaScript off, all steps are shown in a list.
- **ROI estimator** (pricing page). Hours saved = people × hours per week × weeks × share saved; value = hours ×
  hourly cost. Every assumption is visible and editable. The text says it is an illustration, not a promise, and that
  we have no customer data behind the defaults. The defaults are in `site.config.json > roi`.

## 2. How it is built

```
website/
  site.config.json        name, tagline, domain, emails, CTA labels, form endpoint, prices, ROI defaults, analytics
  build.mjs               renders every page into dist/, then writes sitemap.xml and robots.txt
  src/layout.mjs          head (SEO, CSP, Open Graph, JSON-LD), header, footer, screenshot frame, badges, icons
  src/forms.mjs           form fields, privacy notice, consent checkbox, mailto: fallback and endpoint hook
  src/pages/*.mjs         page content (template strings)
  src/i18n/en.json, hi.json   interface strings (banner, menu, footer, calls to action)
  static/                 copied as-is: CSS, JS, favicon, screenshots (WebP), Open Graph images, _headers
  tools/                  serve.mjs (preview), check-links.mjs, optimise-images.py, make-og.mjs, review.mjs
  review/                 screenshots at 360/768/1280/1920 px, dark variants, pricing print PDF, results.json
  dist/                   build output: upload this folder
```

Technical choices:

- **No framework and no runtime dependencies.** The build needs Node 20 or newer and nothing else. `package.json`
  has no dependencies.
- **No web fonts.** The site uses system font stacks with Devanagari fallbacks (Nirmala UI, Noto Sans Devanagari,
  Kohinoor Devanagari). That adds zero bytes, has no licence to track and makes no third-party requests.
- **Screenshots** are real files from `docs/images/`, converted to WebP at 720 px and 1440 px with `srcset`. Width and
  height are always set, so the layout does not shift. One crop of the Studio is used in the hero.
- **Themes.** Light by default. Dark follows the system setting or the toggle, which is stored in `localStorage`
  on the visitor's device only. A small inline head script, allowed by its hash in the CSP, applies the theme
  before first paint.
- **Motion.** A subtle reveal on scroll and the walkthrough fade. Both are off with `prefers-reduced-motion`, and
  content is visible without JavaScript.
- **SEO.** Each page has a title and meta description, a canonical URL and Open Graph and Twitter tags, plus a
  1200×630 PNG for each page in `static/og/`. `hreflang` links connect `/` and `/hi/`. There is also a
  `sitemap.xml` (with alternates) and a `robots.txt`. JSON-LD covers `SoftwareApplication` (name, category,
  operating systems, version, description and URL only: no price, rating or review), `BreadcrumbList` and `FAQPage`
  (only questions that appear on the page). The 404 page is `noindex`.
- **Security headers.** A strict Content-Security-Policy `<meta>` on every page: no inline script except the hashed
  theme snippet, no third-party origins, and `form-action 'self' mailto:`. `static/_headers` adds HSTS, nosniff,
  frame and referrer headers on Cloudflare Pages or Netlify.
- **Identity.** The palette is original: deep green with an ochre accent on warm off-white. The logo is a simple
  placeholder mark (a 2×2 grid where one cell has become a button) in `static/assets/img/logo-placeholder.svg`
  and `layout.mjs > logoMark()`. Both are marked as placeholders in the files. The site does not imitate Microsoft's
  or any competitor's design. The indigo seen inside screenshots belongs to the product UI.

### Build, preview, check

```sh
cd website
npm run build            # node build.mjs -> dist/
npm run preview          # http://localhost:8080 (tiny static server, also serves 404.html)
npm run check            # build + internal link check (every href/src/srcset and #fragment)
```

Optional tools (not needed for a normal build; their outputs are committed):

```sh
npm run images           # python3 + Pillow: re-create WebP screenshots from docs/images (list in tools/optimise-images.py)
npm run og               # headless Chrome via puppeteer-core: re-create static/og/*.png after a rename
npm run review           # screenshots at 4 widths + weight + layout shift + axe-core; see the top of tools/review.mjs
```

`og` and `review` need `puppeteer-core` (Apache-2.0) and Chrome. Point `PUPPETEER_CORE` at an install outside the
repository, and `CHROME_PATH` at Chrome if it is not in a standard place. `review` also needs `AXE_PATH` pointing at
`axe.min.js` from `axe-core` (MPL-2.0; used unmodified as a test tool, never shipped). HTML was validated with
`html-validate` (MIT), installed outside the repository: `npx html-validate dist/**/*.html`.

## 3. Measured results (19 November 2026, headless Chrome 153)

| Check | Result |
|---|---|
| Page weight, excluding product screenshots and OG images | 49 to 78 KB per page, uncompressed (budget 600 KB). CSS 23 KB, JS 10 KB |
| Full page with all screenshots loaded | 49 to 150 KB at 1280 px after scrolling through (WebP; hidden walkthrough steps load only when opened); the home page's first view is 114 KB |
| Layout shift (CLS) after load and full scroll | 0.0000 on all 25 pages at 360, 768, 1280 and 1920 px |
| Horizontal overflow | none at any of the four widths |
| Console errors | none |
| axe-core 4.14 (WCAG 2.0, 2.1 and 2.2 A/AA plus best practice), at 360 and 1280 px, all pages | 0 violations. Dark-theme colour contrast checked on home, Hindi and pricing: 0 violations. The first run found 3 issues, all fixed: banner outside a landmark, link names not matching visible text, heading order |
| HTML validation (html-validate, recommended rules) | 0 errors on all 25 pages |
| Internal links | 1,400 references checked, 0 broken |
| Functional | ROI updates and clamps out-of-range input; walkthrough arrow keys; theme toggle; mobile menu; `?topic=` preselect; the form opens the mailto: confirmation |

Not measured: a real Lighthouse score (no Lighthouse install; the checks above cover its main items), a screen
reader walk-through, Safari and Firefox rendering, and real 3G timing. These are in the pre-launch checklist.

Screenshots for review are in `website/review/` (`<page>-<width>.png`; `*-dark.png` for home, Hindi and pricing;
`pricing-print.pdf`; `results.json` with the raw numbers).

## 4. Changing things

All of these are in `website/site.config.json`, followed by `npm run build`.

| Change | Where |
|---|---|
| **Product name** | `site.name`. Every page, title, footer, JSON-LD and form subject uses it. Set `site.nameIsPlaceholder` to `false` to remove the "working name" tag. Then run `npm run og` and build again so the social images show the new name. Replace the logo in `layout.mjs > logoMark()`, `static/favicon.svg` and `static/assets/img/logo-placeholder.svg` |
| Tagline | `site.tagline` and `site.taglineHi` (used in OG images) |
| Domain | `site.domain` (canonical URLs, sitemap, OG). For a sub-folder site, such as a GitHub Pages project site, set `site.basePath` to `"/repo-name"` |
| Emails | `site.contactEmail`, `site.securityEmail`, `forms.mailto` |
| Calls to action | `cta.primaryLabel` / `primaryHref`, `cta.demoLabel` / `demoHref`, `cta.secondary*` |
| **Prices** | `pricing.bands[].price` and `pricing.passes[].price`: a number per year in `pricing.currency`. While any band price is `null` the page shows "Talk to us" and `pricing.pilotNote`. Also update the pricing FAQ in `src/pages/pricing.mjs` (it says prices are not decided) and the home FAQ |
| ROI defaults | `roi.*` |
| Forms to a real handler | `forms.endpoint`: an HTTPS URL that accepts a POST of the form fields. The CSP `form-action` is updated automatically. Do this only after the privacy notice names the processor (section 6) |
| Analytics | `analytics.scriptSrc` (and `domainAttr` for Plausible). The CSP is updated automatically. See section 6 first |
| Version and dates | `site.version`, `site.lastUpdated` |

Copy lives in `src/pages/*.mjs`. Use `{name}` in strings passed through `t()`, or `${NAME}` in templates, never a
literal product name. A few honest-status sentences are repeated (home "Where we are", about, pilot, admin page)
and must be updated together when, for example, the Windows installer has been run on a real machine.

## 5. Deploying

The output is `website/dist/`, plain static files about 5 MB in all. Use clean URLs (`/pricing/` serves
`pricing/index.html`) and use `404.html` as the not-found page. All four options below do both.

| Option | Pros | Cons | Cost (checked 19 Nov 2026) |
|---|---|---|---|
| **Cloudflare Pages** | Fast in India (CDN), free TLS, reads `_headers`, deploy previews, direct upload or Git | Account with Cloudflare; build runs on their side or you upload `dist/` with `wrangler` | Free plan: 500 builds a month, 20,000 files, 25 MiB per file ([limits](https://developers.cloudflare.com/pages/platform/limits/)) |
| **Netlify** | Simple drag-and-drop deploy of `dist/`, reads `_headers`, deploy previews | Free-plan limits and pricing change often; check before choosing | Free starter plan exists; limits not verified here |
| **GitHub Pages** | Same place as the code; free for public repositories | Ignores `_headers` (CSP still works through `<meta>`); a private repository needs GitHub Pro, Team or Enterprise ([docs](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages)); project sites live under `/repo-name/`, so set `basePath` unless you use a custom domain | Free (public repo) |
| **Own VPS with Caddy** | Full control; the same tools as the product install; logs stay with you | You patch the server and watch uptime; no CDN unless you add one | Cost of the VPS you already have or rent |

Recommendation: Cloudflare Pages, or GitHub Pages if the repository becomes public. Use the VPS only if one already
runs for demos.

Caddy example (Caddy is Apache-2.0):

```
www.example.com {
    redir https://example.com{uri} permanent
}
example.com {
    root * /srv/website/dist
    encode zstd gzip
    file_server
    handle_errors {
        rewrite * /404.html
        file_server
    }
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
        X-Frame-Options DENY
    }
    @assets path /assets/* /og/*
    header @assets Cache-Control "public, max-age=604800"
}
```

### Domain steps

1. Choose the real name first: trademark search, then the domain (see marketing/brand-foundations.md).
2. Register the domain. A `.com` and the `.in` are both worth holding for an India-first product. Turn on the
   registrar lock and two-step login for the registrar account.
3. Point DNS at the host: a CNAME to the Pages hostname for Cloudflare, Netlify or GitHub, or an A/AAAA record to the
   VPS. Add `www` and redirect it to the bare domain, or the other way round.
4. Wait for the host's automatic TLS certificate, then turn on "always HTTPS".
5. Set `site.domain` and rebuild. Check `https://<domain>/sitemap.xml` and `/robots.txt`.
6. Set up email on the domain (MX, SPF, DKIM, DMARC) for `hello@` and `security@` before publishing those addresses.
7. Add the domain to Google Search Console and Bing Webmaster Tools and submit the sitemap. Both are verified by a DNS
   TXT record, so nothing is added to the pages.

## 6. Analytics, cookies and consent

Today the site sets **no cookies**, loads **nothing from third parties**, and **collects nothing** through forms.
Forms open the visitor's own email app (`mailto:`), with a short notice, a link to the draft privacy notice and a
required consent checkbox. The only browser storage is the theme choice in `localStorage`. It never leaves the device.

If analytics are wanted, use a self-hosted or privacy-focused tool that sets no cookies:

| Tool | Licence | Cookies | Notes |
|---|---|---|---|
| Umami | MIT ([repo](https://github.com/umami-software/umami)) | "No cookies" (project's own description) | Self-host on the demo VPS (needs PostgreSQL or MySQL), or use Umami Cloud |
| Plausible Community Edition | AGPL-3.0 or later ([repo](https://github.com/plausible/analytics)) | "No cookies or persistent identifiers" (project's own description) | Running it unmodified as a separate service is the usual way; Plausible also sells a hosted version |

Set `analytics.scriptSrc` to the script URL. The CSP allows that one origin automatically.

Consent implications. This is not legal advice; it is for the lawyer review listed in
[legal-essentials.md](legal-essentials.md):

- **India (DPDP Act, 2023 and the DPDP Rules).** Personal data needs a lawful basis, which for marketing is usually
  consent, with a clear notice in English or a scheduled language. The form notice and checkbox are written with this
  in mind. Once forms post to a server or analytics collect IP addresses, the privacy notice must name what is
  collected, why, the retention period, the processors, and how to withdraw consent or complain.
- **EU and UK (ePrivacy and GDPR).** Storing or reading information on a visitor's device needs consent unless it is
  strictly necessary for a service the visitor asked for. The theme preference is set only when the visitor clicks
  the toggle, so it can probably be treated as requested functionality. Cookie-free analytics that do not store
  anything on the device generally avoid the cookie banner, but GDPR still applies to the IP address processing.
  Ask the lawyer before EU marketing starts.
- Avoid anything that would need a cookie banner (Google Analytics, Meta Pixel, embedded YouTube, chat widgets,
  third-party form services). If a video is needed, self-host it or use a click-to-load placeholder.

## 7. Placeholders and owner decisions

| Item | Current value | Decision needed |
|---|---|---|
| Product name and logo | "Appbuilder", tagged "working name"; placeholder mark | Real name after trademark and domain check; logo and visual route (brand-foundations section 6 has 3 routes; this site's palette is a neutral placeholder) |
| Domain | `https://appbuilder.example.com` | Register and set |
| Emails | `hello@example.com`, `security@example.com` | Real, monitored addresses. SECURITY.md also still has a placeholder contact |
| Prices | all `null`, so "Talk to us" | Band and pass prices, currency and GST wording |
| Pilot terms | "written terms first", "free or close to it", start "from February 2027" | Confirm wording and dates |
| GitHub docs links | `github.com/kameshji/appbuilder-demo/blob/main/docs/` | If the repository stays private, the links will 404 for visitors. Make it public, publish docs elsewhere, or remove the links |
| Founder bio | "[Founder bio and photo: to be written by the owner]" on `/about/` | Write it (see the timing note below) |
| Privacy notice and terms | skeletons with bracketed gaps | Lawyer review; entity name, address, grievance officer, retention, hosting provider |
| Hindi page | machine-quality Hindi by the author of this site | Native-speaker review (brand rule: everyday Hindi, technical terms in English) |
| Location | "Bhopal, India" in the footer and contact page | Confirm it should be public |
| Form handling | `mailto:` | Keep, or set up a handler under our own domain and update the privacy notice |

**Timing note for the owner.** BRIEF says the founder is serving notice at an employer with a no-moonlighting policy
until about the end of January 2027. A public website that markets the product and invites pilots could be read as
outside business activity. The site does not mention the employer or the notice period. Pilot timing says "from
February 2027", with no reason given. Decide, with advice, when to publish the site. A staging URL with
`noindex` is an option until then.

## 8. Competitor claims and sources

Every claim about another product on the compare pages links to an official page. All were checked on
**19 November 2026**, and the pages show that date. Re-check before launch and at least every quarter. Prices are
list prices in US dollars, before tax.

| Claim | Source |
|---|---|
| Power Apps Premium US$20 per user/month, paid yearly; Developer Plan free for building and testing; production needs a paid licence; 250 MB database and 2 GB file capacity per Premium licence, pooled; Dataverse database add-on US$40 per GB/month | [Power Apps pricing](https://www.microsoft.com/en-us/power-platform/products/power-apps/pricing) |
| Power Apps Premium rises to US$22 from 1 January 2027 | [Microsoft Licensing news](https://www.microsoft.com/en-us/licensing/news/power-apps-premium-price-update) |
| On-premises data gateway is a Windows app that bridges local data and Microsoft cloud services | [Microsoft Learn](https://learn.microsoft.com/en-us/data-integration/gateway/service-gateway-onprem) |
| Microsoft 365-included Power Apps rights: standard connectors only, Dataverse for Teams only | [Power Platform Licensing Guide](https://www.microsoft.com/licensing/guidance/Power-Platform) |
| Power Fx borrows heavily from the Excel formula language | [Power Fx overview](https://learn.microsoft.com/en-us/power-platform/power-fx/overview) |
| Canvas apps run offline only in the native Power Apps Mobile players, not in browsers | [Offline canvas apps](https://learn.microsoft.com/en-us/power-apps/maker/canvas-apps/offline-apps) |
| Zoho Creator: Standard US$8, Professional US$20, Enterprise US$25 per user/month billed annually (US$12, 30, 37 monthly); 15-day trial; free edition | [Zoho Creator pricing](https://www.zoho.com/creator/pricing.html) |
| Zoho Creator On-premise is an installable edition | [On-premise overview](https://www.zoho.com/creator/help/on-premise/overview.html) |
| Hybrid deployment: build in the cloud, data on-premise; paid plans; through On-premise sales | [Zoho help](https://help.zoho.com/portal/en/kb/creator/developer-guide/hosting/articles/understand-hybrid-deployment-and-associating-apps) |
| Zoho Creator: drag and drop, Deluge, native Android/iOS apps, "1000+ apps ready to integrate" | [Zoho Creator features](https://www.zoho.com/creator/features.html) |
| ERPNext is GPL-3.0, with accounting, order management, manufacturing, assets and projects; self-hosted with Docker or on Frappe Cloud | [frappe/erpnext](https://github.com/frappe/erpnext) |
| ERPNext self-hosted is free; Frappe Cloud from US$5 (₹410) per month per site, not per user | [ERPNext pricing](https://frappe.io/erpnext/pricing) |
| Custom DocTypes created from the ERPNext interface | [Frappe docs](https://docs.frappe.io/erpnext/user/manual/en/customize-erpnext/doctype) |
| Frappe Framework is written in Python and JavaScript | [frappe/frappe](https://github.com/frappe/frappe) |
| "Worksheet level protection isn't intended as a security feature." | [Microsoft Support](https://support.microsoft.com/en-us/office/protect-a-worksheet-3179efdb-1285-4d49-a9c3-f4ca36276de6) |
| Excel worksheet limit 1,048,576 rows by 16,384 columns | [Excel specifications and limits](https://support.microsoft.com/en-us/office/excel-specifications-and-limits-1672b34d-7043-467e-8e27-269d656771c3) |

Where a fact could not be sourced, the copy was cut back. For example, "maturity" rows say only "an established
product", and the Zoho security row says we have not compared the details.

## 9. Copy inventory to reconcile with marketing

Marketing's [strategy](marketing/strategy.md) and [brand foundations](marketing/brand-foundations.md) appeared while
this site was being built. Already reconciled:

- No banned words ("secure", "certified", "trusted by", "seamless" and others). A grep of the sources finds none.
- The hero now follows the "roof" message: H1 "Your registers and spreadsheets, as apps on your own computer",
  with "who sees what" in the lead.
- "Your own Power Platform" is never used as a headline; Microsoft appears only on the comparison pages.
- Planned features carry "planned" and flows carry "in progress". Examples are labelled "example".
- The phone-size screenshot (`studio-phone-app.png`) is not used, to follow BRIEF (phone layouts planned).

Still to reconcile with marketing:

| Copy | Where | Question |
|---|---|---|
| Hero H1, lead, eyebrow | `src/pages/home.mjs` | Pick from the tested taglines ("Your apps. Your computer. Your rules.", "Registers in, apps out.") once tested |
| Problem section ("Excel, WhatsApp and Tally get a small company far…") | home | Matches the wedge; marketing may prefer "The work Tally doesn't cover" (lawyer check on the Tally mark) |
| Feature card texts and "What's coming" list | home, `/product/` | Keep in step with BRIEF and the roadmap order |
| Manufacturing examples (production log, QC/NCR, maintenance) | `/solutions/manufacturing/` | Align the vocabulary with the sales playbook ("register", "rejection", "indent") |
| Pricing structure text and FAQ | `/pricing/` | Align with docs/launch/payments.md and the final model |
| Pilot offer ("first one to three apps", "free or close to it", "from February 2027") | `/pilot/`, home | Align with the sales playbook and the legal timing |
| Comparison "when the other option is better" lists | `/compare/*` | Align with sales/competitive-battlecards.md |
| Hindi landing page | `/hi/` | Native-speaker review; brand rule on Hinglish vs Devanagari for web |
| Visual identity | CSS tokens in `static/assets/css/site.css` | Choose one of the three visual routes; this palette is a neutral placeholder |

## 10. Pre-launch checklist

- [ ] Real name chosen and cleared. `site.name` set, `nameIsPlaceholder: false`, logo replaced, `npm run og`, rebuild
- [ ] Domain registered, DNS and TLS working, `site.domain` set, `www` redirect, HSTS on
- [ ] `hello@` and `security@` mailboxes exist and are monitored. SECURITY.md contact and response times filled in
- [ ] Owner decided when to publish, given the notice-period timing (section 7)
- [ ] Prices or "talk to us" confirmed; pricing FAQ text matches
- [ ] Privacy notice and terms reviewed by a lawyer; draft banners removed only then
- [ ] Hindi page reviewed by a native speaker
- [ ] Docs links work for an anonymous visitor (repository public, or docs published elsewhere)
- [ ] Competitor facts re-checked on the official pages; dates on `/compare/*` updated (`CHECKED` in `src/pages/compare.mjs`)
- [ ] Honest-status lines still true (customers, pilots, Windows installer, security review, flows), in all four places
- [ ] Screenshots still match the current product (re-run `npm run images` if `docs/images` changed)
- [ ] `npm run check` passes (build and links); `npm run review` shows 0 axe violations, CLS 0, no overflow
- [ ] Manual checks: keyboard-only walk-through of every page; a screen reader (NVDA or VoiceOver) on home, pricing
      and the pilot form; Safari, Firefox and Chrome on Android; 200% zoom; Windows high-contrast mode
- [ ] Forms: test the mailto: flow on Windows (Outlook / Mail) and Android (Gmail); or, if an endpoint is set, test
      delivery, spam protection and data retention
- [ ] Open Graph preview checked (paste the URL into a WhatsApp chat and LinkedIn's post inspector)
- [ ] Search Console and Bing verified by DNS, sitemap submitted
- [ ] If analytics are added: privacy notice updated and the cookie-free setting confirmed

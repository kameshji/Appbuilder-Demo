import { url, shot, badge, icon, iconBox, ctaBand, faq, softwareLd, config, t, esc, NAME } from "../layout.mjs";

const C = config.cta;

/* Shared pieces used by the English and Hindi pages */
export const ROADMAP = [
  ["Phone layouts", "फ़ोन लेआउट", "Entry forms sized for the shop floor"],
  ["PDF output", "PDF आउटपुट", "Reports and documents from records"],
  ["Dashboards", "डैशबोर्ड", "Charts on live data, security-trimmed"],
  ["WhatsApp alerts", "व्हाट्सऐप अलर्ट", "Notifications where people already are"],
  ["Templates", "टेम्पलेट", "Manufacturing pack, CRM, ERP-lite"],
  ["Team chat", "टीम चैट", "Channels and record discussions"],
  ["Documents, sheets, slides", "डॉक्यूमेंट, शीट, स्लाइड", "Simple built-in editors"],
  ["Mail client", "मेल क्लाइंट", "On your existing mailboxes"],
  ["AI agents", "AI एजेंट", "That act with the user's own permissions"],
  ["External portals", "बाहरी पोर्टल", "For suppliers and customers"],
  ["Single sign-on", "सिंगल साइन-ऑन", "Sign in with your company identity"],
];

export function walkthrough(lang = "en") {
  const hi = lang === "hi";
  const steps = hi ? [
    ["अपनी शीट लाइए", "CSV इम्पोर्ट करें या Excel फ़ाइल को डेटा फ़ाइल के रूप में जोड़ें।", "table-import-csv", "Equipment नाम की टेबल में CSV इम्पोर्ट का डायलॉग, जिसमें पाँच पंक्तियाँ चिपकाई गई हैं।"],
    ["एक क्लिक में ऐप", "“Start with data” टेबल से सूची और फ़ॉर्म वाला ऐप बना देता है।", "studio-start-with-data", "Studio में अपने-आप बना Equipment ऐप: बाईं ओर पंक्तियों की टेबल और दाईं ओर फ़ॉर्म।"],
    ["फ़ॉर्मूला से नियम", "Excel जैसे फ़ॉर्मूले: खोज, फ़िल्टर, बटन का काम।", "studio-filter-formula", "Studio का फ़ॉर्मूला बार, जिसमें Filter(Equipment, ...) फ़ॉर्मूला लिखा है।"],
    ["टीम इस्तेमाल करे", "प्रीव्यू करें, फिर लोग ब्राउज़र में ऐप चलाएँ।", "preview-checked-out", "चलता हुआ Equipment ऐप: एक कैमरा 7 दिन के लिए चेक-आउट हुआ और पुष्टि का संदेश दिखा।"],
  ] : [
    ["Bring your sheet", "Import a CSV, or connect an Excel file as a data file.", "table-import-csv", "Import CSV dialog for a table called Equipment, with five rows pasted in and an Import rows button."],
    ["Get an app in one click", "“Start with data” builds a list and a form from the table.", "studio-start-with-data", "The Studio showing an automatically generated Equipment app: a data table of rows on the left and an edit form on the right."],
    ["Add rules with formulas", "Excel-style formulas for search, filters and buttons.", "studio-filter-formula", "The Studio formula bar with the formula Filter(Equipment, IsBlank(SearchBox1.Value) || SearchBox1.Value in Item) applied to a data table."],
    ["Your team uses it", "Preview it, then people run it in their browser.", "preview-checked-out", "The running Equipment app: a camera row is checked out to Test Admin with a due date, and a message says Checked out for 7 days."],
  ];
  const tabs = steps.map(([title, d], i) => `<li role="presentation"><button class="walk-step" role="tab" type="button" id="walk-tab-${i}" aria-controls="walk-panel-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}"><span class="walk-num" aria-hidden="true">${i < 3 ? i + 1 : "✓"}</span><span><strong>${title}</strong><span class="d">${d}</span></span></button></li>`).join("");
  const panels = steps.map(([title, , img, alt], i) => `<div class="walk-panel" role="tabpanel" id="walk-panel-${i}" aria-labelledby="walk-tab-${i}"${i ? " hidden" : ""} tabindex="0">${shot(img, { alt, label: hi ? "असली स्क्रीनशॉट" : "Real screenshot", sizes: "(max-width: 900px) 100vw, 720px" })}</div>`).join("");
  return `<div class="walk" data-walk>
  <div>
    <ol class="walk-steps" role="tablist" aria-label="${hi ? "शीट से ऐप तक के चरण" : "From sheet to app, step by step"}" aria-orientation="vertical">${tabs}</ol>
    <div class="walk-controls">
      <button class="btn btn-secondary btn-sm" type="button" data-walk-play aria-pressed="false" data-play="${hi ? "चरण अपने-आप दिखाएँ" : "Play the steps"}" data-pause="${hi ? "रोकें" : "Pause"}" hidden>${icon("play")}<span>${hi ? "चरण अपने-आप दिखाएँ" : "Play the steps"}</span></button>
      <div class="progress" aria-hidden="true"><i></i></div>
    </div>
    <p class="small muted">${hi ? "ये प्रोडक्ट के असली स्क्रीनशॉट हैं (डेवलपमेंट बिल्ड, नवंबर 2026), कोई मॉक-अप नहीं।" : `Real screenshots from ${esc(NAME)} (development build, November 2026), not mock-ups. The full tutorial is in the <a href="${config.site.docsBaseUrl}guide/getting-started.md">getting started guide</a>.`}</p>
  </div>
  <div class="walk-panels">${panels}</div>
</div>`;
}

const FAQ = [
  ["Is this a cloud service?", "No. {name} is software you install once on your own Windows PC or server, or on a small Linux server (VPS) you rent. Your people open the apps in a browser. Your data stays in a database on that machine."],
  ["Who builds the apps?", "Usually one or two people who are comfortable with Excel: an office manager, an accounts person, a production planner. Screens are designed by drag and drop and behaviour is written in Excel-style formulas. During a pilot we build the first app together."],
  ["Does it replace Tally or our ERP?", "No. Today it is for the work around them: logs, checklists, registers, requests and approvals that live in Excel and WhatsApp. Tally and ERP connectors are planned, not built."],
  ["Can people use it on their phones?", "Apps open in a mobile browser, but layouts designed for phones are planned, not built. Today the product is best on desktop and laptop screens."],
  ["How is our data protected?", "It has sign-in with two-step verification, role-based permissions down to rows and columns, an audit log and backups. It has not had an outside security review yet; that is planned before pilots go beyond one company. The <a href=\"/security/\">security page</a> lists what we do and what we do not claim."],
  ["What does it cost?", "Pricing is not decided. The plan is one licence per install by team size (25, 50 or 100 people), with user passes. Pilot organisations get written pilot terms first. See <a href=\"/pricing/\">pricing</a>."],
  ["Who is behind it?", "One founder in Bhopal, India, building with AI coding tools. It is an early product: version {version}, no customers yet. Read the <a href=\"/about/\">about page</a>."],
];

export const homeEn = {
  path: "/",
  lang: "en",
  og: "home",
  title: "Business apps for your whole team, on your own server",
  description: "{name} turns the registers and spreadsheets a 20-50 person organisation runs on into apps with who-sees-what built in: drag and drop, Excel-style formulas, built-in database with row and column security, installed on your own PC or server.",
  alternates: [{ lang: "en", path: "/" }, { lang: "hi", path: "/hi/" }, { lang: "x-default", path: "/" }],
  sitemap: { priority: "1.0" },
  build() {
    const f = faq(FAQ.map(([q, a]) => [q, a.replace(/href="\//g, `href="${url("/")}`)]));
    this.jsonld = [softwareLd(), f.ld];
    return `
<section class="hero" aria-labelledby="hero-h">
  <div class="container hero-grid">
    <div>
      <span class="eyebrow">Self-hosted business apps for 20 to 50 people</span>
      <h1 id="hero-h">Your registers and spreadsheets, as apps on your own computer.</h1>
      <p class="lead">${esc(NAME)} lets the person who knows Excel build forms, registers and request apps for everyone, with a real database, sign-in and "who sees what" built in. It installs on your own PC or a small server, so your data stays on a machine you control.</p>
      <div class="btn-row">
        <a class="btn btn-primary" href="${url(C.primaryHref)}">${C.primaryLabel}${icon("arrow")}</a>
        <a class="btn btn-secondary" href="${url(C.secondaryHref)}">${C.secondaryLabel}</a>
      </div>
      <p class="hero-note">${icon("info")}<span>Early product (version ${config.site.version}). We are looking for our first pilot organisations, starting with small manufacturers in India.</span></p>
    </div>
    <div>${shot("studio-filter-formula-crop", { alt: "The {name} Studio: an Equipment app on a design canvas, with a data table selected and an Excel-style Filter formula in the formula bar.", label: "Studio, the app designer", eager: true, tilt: true, sizes: "(max-width: 900px) 100vw, 660px" })}</div>
  </div>
</section>

<section class="section section-alt" aria-labelledby="problem-h">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">The problem</span>
      <h2 id="problem-h">Excel, WhatsApp and Tally get a small company far. Then the cracks show.</h2>
      <p class="lead">Accounts live in Tally. Everything else, from the production log to purchase requests, lives in spreadsheets, paper registers and chat groups. It works until the team grows past a dozen people.</p>
    </div>
    <div class="grid grid-3">
      <div class="card reveal"><div class="problem"><span class="tag">Excel</span><div><h3>Copies of copies</h3><p>Which file is the latest? Anyone who can open the sheet can change any cell, and Microsoft itself says worksheet protection is not meant as a security feature.<sup><a href="${url("/compare/excel-whatsapp/#src-1")}" aria-label="Source 1">1</a></sup></p></div></div></div>
      <div class="card reveal"><div class="problem"><span class="tag">WhatsApp</span><div><h3>Decisions lost in chat</h3><p>Approvals, photos and "done" messages scroll away. Nobody can search them by order or machine, and there is no record of who approved what.</p></div></div></div>
      <div class="card reveal"><div class="problem"><span class="tag">Tally</span><div><h3>Accounts, not operations</h3><p>Tally keeps the books. The inspection sheet, breakdown register and daily production numbers usually sit outside it, on paper or in Excel.</p></div></div></div>
    </div>
    <p class="muted small mt">The big platforms solve this, but they are priced per user per month in the cloud, or they are full ERPs that ask you to change how you work. ${esc(NAME)} aims at the gap in between. <a href="${url("/compare/")}">See the comparisons</a>.</p>
  </div>
</section>

<section class="section" id="how-it-works" aria-labelledby="how-h">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">How it works</span>
      <h2 id="how-h">From a spreadsheet to an app in three steps</h2>
      <p class="lead">This is the tutorial from our getting-started guide, shown with real screenshots. Pick a step, or press play.</p>
    </div>
    ${walkthrough("en")}
  </div>
</section>

<section class="section section-alt" aria-labelledby="features-h">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">What it does today</span>
      <h2 id="features-h">One install with the parts a small organisation needs</h2>
      <p class="lead">Everything marked "Available now" is in version ${config.site.version}. Automation is being built; we label it that way.</p>
    </div>
    <div class="grid grid-3">
      <a class="card card-link reveal" href="${url("/product/apps-studio/")}">${iconBox("apps")}<h3>Apps and Studio ${badge("available")}</h3><p>Drag-and-drop screens, Excel-style formulas, "start with data", preview, and apps that open as tabs for your users.</p><span class="more">Apps and Studio →</span></a>
      <a class="card card-link reveal" href="${url("/product/data-security/")}">${iconBox("shield")}<h3>Data and security ${badge("available")}</h3><p>Built-in database, validation rules, formula columns, rollups, a visual data model, and roles that limit rows and columns.</p><span class="more">Data and security →</span></a>
      <a class="card card-link reveal" href="${url("/product/admin-operations/")}">${iconBox("layers")}<h3>Environments ${badge("available")}</h3><p>Try changes in a sandbox, then deploy to production with a preview of what will change.</p><span class="more">Admin and operations →</span></a>
      <a class="card card-link reveal" href="${url("/product/automation/")}">${iconBox("flow")}<h3>Automation ${badge("progress")}</h3><p>Flows on table changes, schedules and buttons, plus approvals. The engine runs in development builds; the visual designer and approvals are being built. Scheduled email reports are available now.</p><span class="more">Automation →</span></a>
      <a class="card card-link reveal" href="${url("/product/collaboration/")}">${iconBox("chat")}<h3>Collaboration ${badge("available")}</h3><p>Tasks, comments, @mentions and a timeline on any record, live updates, and notifications in the app or by email.</p><span class="more">Collaboration →</span></a>
      <a class="card card-link reveal" href="${url("/product/admin-operations/")}">${iconBox("server")}<h3>Backup and on-prem install ${badge("available")}</h3><p>Installers for Windows and Linux, nightly backups with restore, updates, server logs and a diagnostics bundle.</p><span class="more">Admin and operations →</span></a>
    </div>
  </div>
</section>

<section class="section" aria-labelledby="sec-h">
  <div class="container">
    <div class="feature">
      <div>
        <span class="eyebrow">Security by design</span>
        <h2 id="sec-h">Decide who sees which rows and columns, once</h2>
        <p>Roles are enforced by the server on every request, for every app. A supervisor can see all production rows of their line; an operator only their team's rows; nobody but accounts sees the cost column.</p>
        <ul class="checks">
          <li>Row rules by owner, team, department or any condition</li>
          <li>Hidden and read-only columns per role</li>
          <li>"Who can see this row?" and "Test as user" to check before you go live</li>
          <li>Two-step verification and an audit log</li>
        </ul>
        <p><a href="${url("/product/data-security/")}">How security works →</a></p>
      </div>
      ${shot("roles-who-can-see", { alt: "The Who can see this row dialog for production batch B-101: each user is listed with the role and rule that lets them read, update or delete it.", label: "Security roles", sizes: "(max-width: 900px) 100vw, 640px" })}
    </div>
    <div class="feature flip">
      <div>
        <span class="eyebrow">Safe changes</span>
        <h2>Build in a sandbox, deploy when it is ready</h2>
        <p>Each install can have separate environments, such as a sandbox and production. Package apps and tables as a solution and deploy them; you see exactly what will be added or changed before anything happens, and the upgrade runs in one transaction.</p>
        <p><a href="${url("/product/admin-operations/")}">Environments, backups and installers →</a></p>
      </div>
      ${shot("solutions-deploy-plan", { alt: "Deploy dialog for the Customer care solution from a sandbox into production, listing a changed Contacts table with a new LoyaltyTier column and a changed Contacts app.", label: "Deploy between environments", sizes: "(max-width: 900px) 100vw, 640px" })}
    </div>
  </div>
</section>

<section class="section section-alt" aria-labelledby="road-h">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">What's coming</span>
      <h2 id="road-h">Planned, not built ${badge("planned")}</h2>
      <p class="lead">These are on the plan in roughly this order of need, not promises with dates. If one of them decides whether you can use ${esc(NAME)}, tell us: pilots shape the order.</p>
    </div>
    <ul class="roadmap">${ROADMAP.map(([en, , d]) => `<li><strong>${en}</strong><span class="small">${d}</span></li>`).join("")}</ul>
  </div>
</section>

<section class="section" aria-labelledby="who-h">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">Who it is for</span>
      <h2 id="who-h">Small manufacturers first, then any team that outgrew Excel</h2>
    </div>
    <div class="grid grid-3">
      <a class="card card-link reveal" href="${url("/solutions/manufacturing/")}">${iconBox("factory")}<h3>Small manufacturers</h3><p>Production logs, quality inspection, maintenance registers and purchase requests around Tally, on a PC in the plant office.</p><span class="more">Manufacturing →</span></a>
      <a class="card card-link reveal" href="${url("/solutions/other-teams/")}">${iconBox("people")}<h3>Other organisations of 20 to 50</h3><p>Trading firms, service companies, institutes and trusts with registers, requests and trackers spread across sheets.</p><span class="more">Other teams →</span></a>
      <div class="card reveal">${iconBox("info")}<h3>Not a fit yet if…</h3><ul><li>most users need a phone-first app today</li><li>you want a hosted service with no machine to look after</li><li>you need a complete ERP or accounting system</li></ul></div>
    </div>
  </div>
</section>

<section class="section section-alt" aria-labelledby="cmp-h">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">How it compares</span>
      <h2 id="cmp-h">The short version</h2>
      <p class="lead">Each comparison page has sources, dates and a section on when the other option is the better choice.</p>
    </div>
    <div class="table-wrap">
      <table>
        <caption class="visually-hidden">Summary comparison, checked 19 November 2026</caption>
        <thead><tr><th scope="col">Option</th><th scope="col">Where it runs</th><th scope="col">How you pay</th><th scope="col">Good to know</th></tr></thead>
        <tbody>
          <tr><th scope="row">${esc(NAME)}</th><td>Your PC, server or VPS</td><td>Not decided; planned per install by team size</td><td>Early product, no customers yet</td></tr>
          <tr><th scope="row"><a href="${url("/compare/power-platform/")}">Microsoft Power Platform</a></th><td>Microsoft cloud; on-premises data through a gateway</td><td>Per user per month (Power Apps Premium US$20, paid yearly)</td><td>Mature, huge ecosystem, Microsoft 365 integration</td></tr>
          <tr><th scope="row"><a href="${url("/compare/zoho-creator/")}">Zoho Creator</a></th><td>Zoho cloud; an on-premise edition exists</td><td>Per user per month (from US$8, billed annually)</td><td>Mature, mobile apps, part of the Zoho suite</td></tr>
          <tr><th scope="row"><a href="${url("/compare/erpnext/")}">ERPNext</a></th><td>Self-hosted or Frappe Cloud</td><td>Free software (GPL-3.0); hosting from US$5 a month</td><td>A full ERP, including manufacturing</td></tr>
          <tr><th scope="row"><a href="${url("/compare/excel-whatsapp/")}">Excel and WhatsApp</a></th><td>Everyone's laptops and phones</td><td>Usually already paid for</td><td>Nothing to install or learn</td></tr>
        </tbody>
      </table>
    </div>
    <p class="small muted">Competitor prices are list prices from their official pages, checked 19 November 2026; see each comparison page for sources. Microsoft has announced Power Apps Premium will be US$22 from 1 January 2027.</p>
  </div>
</section>

<section class="section" id="status" aria-labelledby="status-h">
  <div class="container">
    <div class="status-box">
      <div>
        <span class="eyebrow">Where we are</span>
        <h2 id="status-h">An early product, built in the open</h2>
        <p>We would rather you hear it from us: ${esc(NAME)} is new. It works, it is documented, and it has a test suite, but nobody runs it in a business yet. That is what the pilot programme is for.</p>
        <dl class="facts">
          <dt>Version</dt><dd>${config.site.version} (November 2026)</dd>
          <dt>Customers</dt><dd>None yet</dd>
          <dt>Pilots</dt><dd>Open, none running yet</dd>
          <dt>Security review</dt><dd>Internal only; outside review planned</dd>
          <dt>Windows installer</dt><dd>Run on one Windows PC so far; not yet on a customer machine</dd>
          <dt>Team</dt><dd>One founder, building with AI coding tools</dd>
        </dl>
      </div>
      <div>
        <h3>What a design partner gets</h3>
        <ul class="checks">
          <li>We install it with you, on your machine, and build your first one to three apps together</li>
          <li>Direct access to the founder, and a say in what gets built next</li>
          <li>Written pilot terms before anything is installed, including what happens to your data if you stop</li>
          <li>Your data stays on your machine; you can export it at any time</li>
        </ul>
        <p><strong>What we ask:</strong> a real process to try, one person who can give it a few hours a week, and honest feedback.</p>
        <a class="btn btn-primary" href="${url("/pilot/")}">About the pilot programme</a>
      </div>
    </div>
  </div>
</section>

<section class="section section-alt" aria-labelledby="faq-h">
  <div class="container narrow">
    <div class="section-head"><h2 id="faq-h">Questions people ask</h2></div>
    ${f.html}
  </div>
</section>

${ctaBand("en")}
`;
  },
};

export const homeHi = {
  path: "/hi/",
  lang: "hi",
  og: "home-hi",
  title: "आपकी पूरी टीम के लिए बिज़नेस ऐप्स, आपके अपने सर्वर पर",
  description: "{name} 20-50 लोगों के संगठन की एक्सेल शीट को सुरक्षित ऐप्स में बदलता है: ड्रैग-एंड-ड्रॉप, एक्सेल जैसे फ़ॉर्मूले, पंक्ति और कॉलम स्तर की सुरक्षा वाला डेटाबेस, आपके अपने पीसी या सर्वर पर।",
  alternates: [{ lang: "en", path: "/" }, { lang: "hi", path: "/hi/" }, { lang: "x-default", path: "/" }],
  sitemap: { priority: "0.8" },
  build() {
    this.jsonld = [{ ...softwareLd(), inLanguage: "hi" }];
    return `
<section class="hero" aria-labelledby="hero-h">
  <div class="container hero-grid">
    <div>
      <span class="eyebrow">20 से 50 लोगों की टीमों के लिए, आपके अपने सर्वर पर</span>
      <h1 id="hero-h">आपके रजिस्टर और एक्सेल शीट, अब ऐप्स के रूप में, आपके अपने कंप्यूटर पर।</h1>
      <p class="lead">${esc(NAME)} से वह व्यक्ति, जो एक्सेल अच्छी तरह जानता है, पूरी टीम के लिए फ़ॉर्म, रजिस्टर और रिक्वेस्ट वाले ऐप बना सकता है, जिनमें असली डेटाबेस, लॉग-इन और अनुमतियाँ (permissions) हों। यह आपके अपने पीसी या छोटे सर्वर पर इंस्टॉल होता है, इसलिए आपका डेटा आपकी अपनी मशीन पर रहता है।</p>
      <div class="btn-row">
        <a class="btn btn-primary" href="${url(C.primaryHref)}">पायलट के लिए आवेदन करें${icon("arrow")}</a>
        <a class="btn btn-secondary" href="#how-it-works">यह कैसे काम करता है</a>
      </div>
      <p class="hero-note">${icon("info")}<span>शुरुआती प्रोडक्ट (संस्करण ${config.site.version})। हम अपने पहले पायलट संगठनों की तलाश में हैं, शुरुआत भारत के छोटे मैन्युफ़ैक्चरर्स से।</span></p>
    </div>
    <div>${shot("studio-filter-formula-crop", { alt: "{name} Studio: डिज़ाइन कैनवास पर Equipment ऐप, एक डेटा टेबल चुनी हुई है और फ़ॉर्मूला बार में एक्सेल जैसा Filter फ़ॉर्मूला है।", label: "Studio, ऐप डिज़ाइनर", eager: true, tilt: true, sizes: "(max-width: 900px) 100vw, 660px" })}</div>
  </div>
</section>

<section class="section section-alt" aria-labelledby="problem-h">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">समस्या</span>
      <h2 id="problem-h">एक्सेल, व्हाट्सऐप और टैली से छोटी कंपनी काफ़ी आगे जाती है। फिर दरारें दिखने लगती हैं।</h2>
      <p class="lead">हिसाब-किताब टैली में है। बाकी सब कुछ, प्रोडक्शन लॉग से लेकर ख़रीद के अनुरोध तक, शीट, काग़ज़ी रजिस्टर और चैट ग्रुप में है। जब तक टीम छोटी है, यह चल जाता है।</p>
    </div>
    <div class="grid grid-3">
      <div class="card"><div class="problem"><span class="tag">Excel</span><div><h3>कॉपी की कॉपी</h3><p>कौन-सी फ़ाइल नई है? जो शीट खोल सकता है, वह कोई भी सेल बदल सकता है। Microsoft ख़ुद कहता है कि वर्कशीट प्रोटेक्शन सुरक्षा फ़ीचर के तौर पर नहीं बना है।<sup><a href="${url("/compare/excel-whatsapp/#src-1")}" aria-label="स्रोत 1">1</a></sup></p></div></div></div>
      <div class="card"><div class="problem"><span class="tag">WhatsApp</span><div><h3>चैट में खोए फ़ैसले</h3><p>मंज़ूरियाँ, फ़ोटो और "हो गया" वाले संदेश ऊपर चले जाते हैं। किसने क्या मंज़ूर किया, इसका कोई रिकॉर्ड नहीं रहता।</p></div></div></div>
      <div class="card"><div class="problem"><span class="tag">Tally</span><div><h3>हिसाब, कामकाज नहीं</h3><p>टैली खाते रखता है। इंस्पेक्शन शीट, ब्रेकडाउन रजिस्टर और रोज़ का प्रोडक्शन आमतौर पर उसके बाहर, काग़ज़ या एक्सेल में रहता है।</p></div></div></div>
    </div>
  </div>
</section>

<section class="section" id="how-it-works" aria-labelledby="how-h">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">यह कैसे काम करता है</span>
      <h2 id="how-h">शीट से ऐप तक, तीन चरणों में</h2>
      <p class="lead">प्रोडक्ट अभी अंग्रेज़ी में है, इसलिए स्क्रीनशॉट अंग्रेज़ी में हैं।</p>
    </div>
    ${walkthrough("hi")}
  </div>
</section>

<section class="section section-alt" aria-labelledby="features-h">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">आज क्या उपलब्ध है</span>
      <h2 id="features-h">एक इंस्टॉल, जिसमें छोटे संगठन की ज़रूरत के हिस्से हैं</h2>
    </div>
    <div class="grid grid-3">
      <div class="card">${iconBox("apps")}<h3>ऐप्स और Studio ${badge("available", "hi")}</h3><p>ड्रैग-एंड-ड्रॉप स्क्रीन, एक्सेल जैसे फ़ॉर्मूले, टेबल से एक क्लिक में ऐप।</p></div>
      <div class="card">${iconBox("shield")}<h3>डेटा और सुरक्षा ${badge("available", "hi")}</h3><p>अपना डेटाबेस, वैलिडेशन नियम, फ़ॉर्मूला कॉलम, और रोल जो पंक्तियों व कॉलम तक पहुँच तय करते हैं।</p></div>
      <div class="card">${iconBox("layers")}<h3>एनवायरनमेंट ${badge("available", "hi")}</h3><p>बदलाव पहले सैंडबॉक्स में आज़माइए, फिर प्रोडक्शन में डिप्लॉय कीजिए।</p></div>
      <div class="card">${iconBox("flow")}<h3>ऑटोमेशन और मंज़ूरी ${badge("progress", "hi")}</h3><p>फ़्लो और अप्रूवल अभी बन रहे हैं। ईमेल से शेड्यूल्ड रिपोर्ट आज उपलब्ध हैं।</p></div>
      <div class="card">${iconBox("chat")}<h3>सहयोग ${badge("available", "hi")}</h3><p>हर रिकॉर्ड पर टास्क, कमेंट, @मेंशन और टाइमलाइन; ऐप में या ईमेल से सूचनाएँ।</p></div>
      <div class="card">${iconBox("server")}<h3>बैकअप और इंस्टॉलर ${badge("available", "hi")}</h3><p>Windows और Linux के इंस्टॉलर, रोज़ रात का बैकअप और रीस्टोर, अपडेट।</p></div>
    </div>
    <h3 class="mt-lg">योजना में, अभी बना नहीं ${badge("planned", "hi")}</h3>
    <ul class="pill-list">${ROADMAP.map(([, hi]) => `<li>${hi}</li>`).join("")}</ul>
    <p class="small muted">कोई तारीख़ का वादा नहीं। पायलट संगठनों की ज़रूरतें क्रम तय करती हैं।</p>
  </div>
</section>

<section class="section" aria-labelledby="status-h">
  <div class="container">
    <div class="status-box">
      <div>
        <span class="eyebrow">हम कहाँ हैं</span>
        <h2 id="status-h">एक शुरुआती प्रोडक्ट, ईमानदारी से</h2>
        <dl class="facts">
          <dt>संस्करण</dt><dd>${config.site.version} (नवंबर 2026)</dd>
          <dt>ग्राहक</dt><dd>अभी कोई नहीं</dd>
          <dt>पायलट</dt><dd>आवेदन खुले हैं, अभी कोई चालू नहीं</dd>
          <dt>सुरक्षा समीक्षा</dt><dd>सिर्फ़ आंतरिक; बाहरी समीक्षा की योजना है</dd>
          <dt>टीम</dt><dd>एक संस्थापक, AI कोडिंग टूल्स के साथ</dd>
        </dl>
      </div>
      <div>
        <h3>डिज़ाइन पार्टनर को क्या मिलता है</h3>
        <ul class="checks">
          <li>हम आपकी मशीन पर आपके साथ इंस्टॉल करते हैं और पहले एक से तीन ऐप साथ बनाते हैं</li>
          <li>संस्थापक से सीधा संपर्क, और आगे क्या बने उसमें आपकी राय</li>
          <li>कुछ भी इंस्टॉल होने से पहले लिखित पायलट शर्तें</li>
          <li>आपका डेटा आपकी मशीन पर रहता है; आप कभी भी एक्सपोर्ट कर सकते हैं</li>
        </ul>
        <a class="btn btn-primary" href="${url("/pilot/")}">पायलट प्रोग्राम (अंग्रेज़ी पेज)</a>
      </div>
    </div>
    <p class="note small">अनुवाद पर ध्यान दें: यह पेज अंग्रेज़ी पेज का हिंदी रूप है। बाकी पेज अभी अंग्रेज़ी में हैं। (Translation to be reviewed by a native speaker before launch.)</p>
  </div>
</section>

${ctaBand("hi")}
`;
  },
};

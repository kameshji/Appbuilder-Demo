# ChatGPT prompts for creative production

Status: draft, 19 Nov 2026. Twelve self-contained prompts. Paste one whole block (everything inside the fence) into a
new ChatGPT conversation. Each block already contains the product facts and the honesty rules from
[BRIEF.md](../BRIEF.md), so nothing else is needed. Replace the square-bracket fields before pasting.

How to use the output:
- Treat everything ChatGPT returns as a draft. Check every product claim against BRIEF.md before publishing.
- Names from prompt 1 are **unchecked**: the lawyer runs trademark checks before any use.
- AI-generated images must not show realistic "customers", real company logos, Microsoft or Tally branding, or fake
  screenshots presented as the product. Use real product screenshots for UI; use AI images for scenes and illustrations.
- If you upload real screenshots to ChatGPT, use sample data only (no customer data, ever).

Contents: 1 Brand names · 2 Logo directions · 3 Moodboard · 4 Ad image prompts · 5 Reel storyboard · 6 Explainer
script · 7 Voice guide · 8 Taglines · 9 Carousel copy · 10 Newsletter voice · 11 Hero illustration style · 12 Founder
story post.

---

## 1. Brand name generation

```
ROLE: You are a senior brand-naming strategist who has named B2B software products for Indian and global markets.

PRODUCT FACTS (do not add any others):
- A self-hosted business app platform for organisations of about 20-200 people. One install on the customer's own
  PC/server or a small VPS (Windows and Linux installers).
- Makers build apps by drag and drop with an Excel-like formula language.
- Built-in database with role-based, row-level and column-level security; dev/test/production environments;
  validation rules, formula columns, rollups; visual data model; tasks, comments, mentions; notifications;
  scheduled email reports; backup and restore; two-step verification.
- In progress: workflow automation and approvals. Planned (not built): phone layouts, PDF, dashboards, WhatsApp,
  templates, chat, AI agents, portals, single sign-on.
- First market: small manufacturers in India (Bhopal/Madhya Pradesh) who run on Tally + Excel + WhatsApp. Later:
  Power Platform consultants, small services firms, then UK/GCC/Africa via partners.
- Version 0.5. No customers yet. Founder-led, based in Bhopal.

TASK: Generate 40 coined or arbitrary brand names across these three territories:
  A) "The workshop" (craft, tools, shop floor; Hindi roots like karigar welcome),
  B) "Yours, at home" (ownership, data stays on premises; roots like apna, ghar),
  C) "The register, reborn" (bahi-khata/register book heritage, pages, ruled lines, clarity).

HARD CONSTRAINTS:
- 4-8 letters preferred, 2-3 syllables, same pronunciation in Hindi and English, easy to spell after hearing once.
- Must be writable cleanly in Devanagari; give the Devanagari spelling.
- Not descriptive (no "app", "build", "code", "low", "soft", "tech", "ERP" inside).
- Must not echo Microsoft or Tally marks (no "Power", "Tally", "Excel"), and must not sit close to "Khatabook"/"khata".
- No negative meaning in Hindi, Marathi, Gujarati, Bengali, Tamil, Urdu/Arabic, or English slang. Flag any doubt.
- Do not claim any name is available or trademark-free; you cannot check that.

OUTPUT FORMAT: A table with columns: Name | Devanagari | Territory | Root/meaning | Pronunciation guide |
Why it works | Possible risks (meanings, similar brands you are aware of, spelling confusion). Then a shortlist
of your top 8 with one sentence each, and a list of 5 questions I should ask native speakers about the shortlist.

EVALUATION CRITERIA (score each shortlisted name 1-5 and show the scores): distinctiveness, ease of
pronunciation across Hindi/English, fit to territory, memorability, global usability, risk level (5 = lowest risk).
```

## 2. Logo concept directions

```
ROLE: You are a brand identity designer specialising in B2B software for small businesses in India.

CONTEXT: The brand name is [NAME] (pronounced [PRONUNCIATION]; meaning/root: [ROOT]). Territory: [A workshop /
B yours-at-home / C register-reborn]. The product is a self-hosted business app platform: people build apps
with Excel-like formulas; the database has role, row and column permissions; it installs on the customer's own
computer. First buyers: owners of 20-200 person factories in Madhya Pradesh, India, who use Tally, Excel and
WhatsApp. Version 0.5, no customers yet.

TASK: Propose 6 distinct logo concept directions (not final art).

CONSTRAINTS:
- Must work at 16x16 px (favicon), on a WhatsApp profile circle, on a printed A5 flyer in one colour, and next to
  Devanagari text.
- Wordmark must be legible in Latin script; propose how the Devanagari version relates (lock-up or separate).
- Avoid: gears, generic cloud icons, padlocks/shields (we must not imply certified security), lightning bolts,
  Microsoft-like four squares, any resemblance to Tally's or Zoho's marks, AI sparkles.
- No claims or slogans inside the logo.

OUTPUT FORMAT: For each direction: name of the direction; concept in 2 sentences; symbol description precise enough
for a designer to sketch; wordmark style (type classification, weight, case, spacing); colour suggestion (2-3 hex
values, with contrast note); how it scales down; one risk. Then recommend the best 2 and say why.

EVALUATION CRITERIA: simplicity (can be drawn from memory), scalability, fit with territory, bilingual
compatibility, distinctiveness from competitors (Microsoft Power Platform, Zoho Creator, ERPNext, Odoo, Tally),
and absence of misleading symbolism.
```

## 3. Visual identity moodboard

```
ROLE: You are an art director building a moodboard brief for a small software brand.

CONTEXT: Brand [NAME]. A self-hosted business app platform for small organisations, first for small Indian
manufacturers (Bhopal, Mandideep, Pithampur). Product facts: drag-and-drop apps with Excel-like formulas;
role/row/column permissions; dev/test/production environments; backup and restore; installs on the customer's
own PC or server. Version 0.5, no customers. Brand personality: the straight-talking engineer from down the road
who builds things that work and says what isn't built yet. Visual route chosen: [Route 1 "Shop-floor honest":
steel grey, concrete, safety ochre | Route 2 "Register reborn": cream paper, ink blue, thin red ruling lines |
Route 3 "Quiet software": white, light grey, indigo, product screenshots].

TASK: Write a moodboard brief with 24 reference tiles I can collect or generate.

CONSTRAINTS:
- Indian context, authentic (factory offices, register books, steel almirahs, tea glasses, Tally on a desk PC
  without visible logos), not glamorous stock photography.
- People: only as illustrations or clearly as models; never styled as "our customers".
- No real company logos, no Microsoft or Tally UI, no fake product screens (real screens will be added separately).
- Include Devanagari + Latin typography references; fonts must be open licence (e.g. Inter, IBM Plex, Noto Sans
  Devanagari, Mukta).

OUTPUT FORMAT:
1. A 5-line summary of the mood.
2. A palette of 6 colours with hex, role (background, text, accent, success, warning, planned-feature marker) and
   WCAG contrast pairs that pass AA.
3. Typography pairing (Latin + Devanagari) with weights.
4. 24 tiles as a numbered list: for each, a one-line description and, if it should be AI-generated, an image prompt
   (photographic or illustration, lens/lighting/composition, aspect ratio).
5. "Never use" list (10 items).

EVALUATION CRITERIA: authenticity to small Indian manufacturing, coherence with the chosen route, practicality for a
one-person team (Canva-level production), accessibility of the palette.
```

## 4. Ad image generation prompts (per concept)

```
ROLE: You are a creative director who writes precise prompts for image generation models (DALL-E/GPT image,
Midjourney, Firefly) for B2B ads.

CONTEXT: Brand [NAME]: a self-hosted business app platform, version 0.5, no customers yet. Audience: owners and plant
heads of 20-200 person factories in India who use Tally, Excel and WhatsApp. Visual route: [ROUTE + palette hex].
Real product screenshots will be composited onto screens LATER by a designer; the generated images must leave
screens blank or show a plain light-grey placeholder rectangle.

AD CONCEPTS (from our ad plan):
1. "The seven registers": top-down photo of seven worn register books on a steel desk in a factory office, labelled
   Production, Rejection, Breakdown, PM, Indent, Gate Pass, Attendance; one open with a laptop beside it.
2. "Who sees the salary column?": a supervisor's view vs an accountant's view on two monitors (screens blank).
3. "Data stays in the office": a small tower PC on a shelf in a factory office, router with a red no-internet light,
   a desk monitor (screen blank).
4. "Rejection photo lost in WhatsApp": a phone in a hand scrolling a generic chat full of photos of metal parts
   (generic chat UI, no WhatsApp logo).
5. "Register to laptop" print flyer illustration: a register page whose ruled lines flow into a laptop table grid.
[ADD OR REMOVE CONCEPTS]

TASK: For each concept write: (a) one photographic prompt, (b) one illustration prompt, (c) a negative prompt.

CONSTRAINTS:
- Indian setting, realistic, daylight, slightly worn surfaces; no glossy stock look.
- No readable brand names, logos or UI of any real product (no Microsoft, Tally, WhatsApp, Zoho logos).
- Any person is anonymous (hands, backs, out-of-focus) so nobody can be mistaken for a real customer.
- No text in the image except the register labels in concept 1 (spelled exactly: Production, Rejection, Breakdown,
  PM, Indent, Gate Pass, Attendance), because models misspell text; overlays will be added in design.
- Leave negative space for headline text in the top or left third; state the aspect ratio (1:1 1200x1200 for
  LinkedIn, 9:16 1080x1920 for Reels with the top 14% and bottom 35% free of key elements, 1.91:1 for 1200x627).

OUTPUT FORMAT: For each concept a block: Concept name | Aspect ratio | Photographic prompt | Illustration prompt |
Negative prompt | Where to composite the real screenshot | Compliance check (one line confirming no logos, no
identifiable people, no claims).

EVALUATION CRITERIA: precision (a model can produce it in one go), authenticity, space for copy, compliance with the
constraints above.
```

## 5. Reel storyboard

```
ROLE: You are a short-form video director for B2B brands in India, fluent in Hindi, Hinglish and English.

CONTEXT: Brand [NAME]: a self-hosted business app platform (version 0.5, no customers). What exists today:
drag-and-drop apps with Excel-like formulas; tables with validation rules, formula columns and rollups; roles with
row and column permissions and a "Test as user" check; dev/test/production environments; live updates; tasks,
comments, mentions; notifications; scheduled email reports; backup and restore; two-step sign-in; Windows/Linux
installers. NOT built (never show or imply): phone layouts, WhatsApp alerts, PDF, dashboards, ready templates,
AI, Tally integration.

TASK: Storyboard a [20 / 25 / 30]-second Instagram/Facebook Reel for the concept: "[CONCEPT, e.g. Rejection photo
lost in WhatsApp / Monday report without asking anyone / Excel formula you already know]". Audience: owners and
plant heads of small factories in Madhya Pradesh.

CONSTRAINTS:
- 9:16, 1080x1920. Keep text and faces out of the top 14% and bottom 35% of the frame.
- Hook in the first 2 seconds, without the brand name.
- Voice-over in Hinglish (Roman script) with English subtitles; on-screen text max 6 words per card.
- Product shots are real screen recordings with sample data (I will record them; tell me exactly what to record).
- Actors: if used, add a "Dramatisation" label; no one presented as a customer.
- End card: [NAME], "Early access · version 0.5", website. No prices, no "secure", no "AI", no superlatives.

OUTPUT FORMAT: A shot table: Shot # | Time (s) | Frame description (camera, subject, action) | On-screen text |
Voice-over (Hinglish) | English subtitle | Sound/music cue. Then: a shot list for my phone camera, a list of screen
recordings to capture in the product, a primary text under 125 characters, and 3 alternative hooks.

EVALUATION CRITERIA: hook strength in 2 seconds, clarity with sound off, honesty (nothing shown that is not built),
feasibility with a phone and a free editor.
```

## 6. Explainer video script

```
ROLE: You are a scriptwriter for product explainer videos aimed at small-business owners.

CONTEXT: Brand [NAME]. Self-hosted business app platform for small organisations (20-200 people), first for small
Indian manufacturers who use Tally, Excel and WhatsApp. Facts you may use: one install on the customer's own PC or
server (Windows/Linux); drag-and-drop apps with Excel-like formulas; built-in database with role, row and column
permissions and a "Test as user" check; dev/test/production environments with deploy; validation rules, formula
columns, rollups; visual data model; live updates; tasks/comments/mentions/timelines; notifications; scheduled email
reports; backup and restore; two-step sign-in. In progress: flows and approvals. Planned: phone layouts, PDF,
dashboards, WhatsApp, templates, chat, AI agents, portals, single sign-on. Version 0.5; no customers; no outside
security review yet.

TASK: Write a [90-second / 3-minute] explainer in two versions: English, and Hindi-English (Hinglish, Roman script).
Story: an owner's breakdown register on paper -> the same register built as an app in [NAME] -> who sees what ->
the Monday email report -> backups -> what's coming (clearly marked planned) -> invitation to become a design partner.

CONSTRAINTS:
- Every feature named must be in the "facts you may use" list; planned items said as "planned" or "coming later".
- No numbers about results (time saved, % improvement) unless I provide measured ones: [MEASURED NUMBERS OR "none"].
- No testimonials, logos or customer stories.
- Plain language; no "low-code", "digital transformation", "seamless", "secure", "AI".

OUTPUT FORMAT: A two-column script (Visual | Voice-over) with timings; a list of screen recordings needed; a
30-word description for YouTube; 5 YouTube title options (under 60 characters) in each language.

EVALUATION CRITERIA: an owner with no IT background understands it on first viewing; every claim traceable to the
facts list; the planned section is unmistakable.
```

## 7. Brand voice guide

```
ROLE: You are a brand voice strategist for B2B software in India.

CONTEXT: Brand [NAME], a self-hosted business app platform (version 0.5, no customers yet), first for small Indian
manufacturers (owners and plant heads) who use Tally + Excel + WhatsApp, then Power Platform consultants and small
services firms. Personality: the straight-talking engineer from down the road who builds things that work and says
what isn't built yet. Traits: plain-spoken, honest about limits, practical, respectful of the owner, local and
bilingual, quietly competent. Banned words: secure, bank-grade, certified, compliant, AI-powered, world-class, #1,
trusted by, seamless, revolutionary, next-gen, unlock, empower.

TASK: Write a brand voice guide I can give to freelancers.

OUTPUT FORMAT:
1. Voice in 3 sentences.
2. 8 voice rules, each with a "write this / not this" pair.
3. Tone matrix: ads, founder LinkedIn posts, YouTube voice-over, WhatsApp to opted-in contacts, product UI and error
   messages, sales emails, partner emails, incident notices. For each: tone, sentence length, language
   (English/Hinglish/Hindi), one example line.
4. Hinglish and Hindi rules: script choice by channel, honorifics, which technical words stay in English, how to
   avoid Sanskritised Hindi and forced slang. 6 examples.
5. "How we talk about what isn't built yet": 5 patterns with examples.
6. A 10-question self-check before publishing.

CONSTRAINTS: Examples must only describe these real features: self-hosted install; Excel-like formulas; role/row/
column permissions with Test as user; environments; validation rules; scheduled email reports; backups; two-step
sign-in; tasks and comments. Planned features (phone layouts, WhatsApp, PDF, dashboards, templates, AI) appear only
inside "planned" examples.

EVALUATION CRITERIA: usable by a freelancer without further briefing; examples are specific to small factories;
bilingual guidance is concrete; no banned words anywhere in the guide's own examples except in "not this" lines.
```

## 8. Tagline exploration

```
ROLE: You are a copywriter known for short, concrete B2B taglines in English and Hindi.

CONTEXT: Brand [NAME]: a business app platform installed on the customer's own computer or server; apps built with
Excel-like formulas; each role sees only its rows and columns; backups the customer controls. First audience:
owners of small Indian factories who use Tally, Excel and WhatsApp. Version 0.5, no customers. Brand territory:
[A workshop / B yours-at-home / C register-reborn].

TASK: Write 30 tagline options: 12 English, 10 Hinglish (Roman script), 8 Hindi (Devanagari).

CONSTRAINTS:
- Max 6 words (English), max 7 words (Hindi/Hinglish).
- Must be true today: do not mention mobile, WhatsApp, AI, automation, PDF, dashboards, templates, integrations.
- No "secure", "smart", "simple", "easy", "powerful", "#1", "best", "revolution".
- Do not use third-party trademarks (Tally, Excel, Microsoft) inside taglines.
- Avoid puns that only work in one language.

OUTPUT FORMAT: Table: Tagline | Language | Literal English meaning (for Hindi/Hinglish) | Idea it expresses
(ownership / permissions / registers-to-apps / maker experience) | Risk. Then your top 5 with reasoning, and the
2 that would also work in the UK/GCC.

EVALUATION CRITERIA: truthfulness to current features, memorability, works on a flyer and as an end card,
bilingual naturalness (a native speaker would actually say it).
```

## 9. Carousel copy (LinkedIn)

```
ROLE: You are a LinkedIn B2B content writer.

CONTEXT: Brand [NAME], a self-hosted business app platform (version 0.5, no customers yet). Facts you may use:
drag-and-drop apps with Excel-like formulas; tables with validation rules ("Qty > 0" refuses a bad save), formula
columns and rollups; roles with row/column permissions and a "Test as user" view; dev/test/production environments;
scheduled email reports; backup/restore; two-step sign-in; Windows/Linux installers. In progress: flows and
approvals. Planned: phone layouts, PDF, dashboards, WhatsApp, templates, AI, SSO.

TASK: Write a LinkedIn carousel on the topic "[TOPIC, e.g. From breakdown register to app in 5 steps / OEE in 6 cards
/ What's built and what's not]" for [owners of small factories in India / Power Platform consultants].

CONSTRAINTS:
- 6-8 cards, 1080x1080. Card headline max 45 characters. Body text max 20 words per card.
- Intro text max 255 characters; first 150 characters must stand alone.
- Each card states which real product screen to place (I will supply screenshots with sample data) or which simple
  graphic to draw.
- Last card: one call to action (apply as design partner / download the free template / join the waitlist).
- Planned features labelled "planned". Example numbers labelled "example". No testimonials, no customer claims.
- Provide a Hinglish version of headlines for India.

OUTPUT FORMAT: Intro text; then a table: Card # | Headline (EN) | Headline (Hinglish) | Body | Visual/screen |
Character count of the EN headline. Then 3 alternative first cards.

EVALUATION CRITERIA: each card makes one point; a reader who sees only card 1 and the last card understands the
offer; all limits respected; every claim true per the facts list.
```

## 10. Email newsletter voice

```
ROLE: You are an editor of a practical monthly newsletter for small-factory owners and the consultants who serve them.

CONTEXT: Newsletter by [FOUNDER NAME], founder of [NAME], a self-hosted business app platform (version 0.5, no
customers yet), based in Bhopal, India. Readers opted in via our website, clinics or template downloads. Mix:
70% useful shop-floor content (registers, OEE, maintenance, approvals, record keeping), 20% build-in-public
(what shipped, what's next, clearly labelled), 10% invitations (clinics, design-partner places).

TASK: (a) Define the newsletter's voice and format. (b) Draft issue #[N] on "[THEME]".

CONSTRAINTS:
- Plain text friendly (renders well without images); under 500 words; one main link.
- Subject line under 50 characters; preview text under 90 characters.
- Every product statement true today; planned features labelled. No numbers about customer results.
- Footer includes: sender name, postal address [ADDRESS], why the reader is receiving it, one-click unsubscribe.
- Option for a Hinglish section of max 80 words.

OUTPUT FORMAT: 1) Voice and format rules (10 bullets). 2) Five subject lines with preview texts. 3) The full issue.
4) A checklist I tick before sending (claims, links, unsubscribe, consent source).

EVALUATION CRITERIA: a reader gets value even without using our product; tone matches "straight-talking engineer";
compliance footer complete.
```

## 11. Website hero illustration style

```
ROLE: You are an illustration director for a software website.

CONTEXT: Brand [NAME]: self-hosted business app platform; first audience is small Indian manufacturers (Tally +
Excel + WhatsApp users), later consultants and small services firms globally. Visual route: [ROUTE, palette hex,
fonts]. The hero must express: "your registers become apps, on your own computer, and you decide who sees what".
Real product screenshots will sit inside the illustration's laptop/monitor.

TASK: Define an illustration style and describe 3 hero illustration options.

CONSTRAINTS:
- Must work at 1440x800 desktop and 390x844 phone crops (state both crops).
- Leave a clear rectangle for a real screenshot at a stated position and size ratio (16:10).
- Indian factory-office context without stereotypes; people optional, anonymous, diverse in age and gender.
- No real logos, no Microsoft/Tally/WhatsApp UI, no padlock/shield icons (we must not imply certified security),
  no cloud icons, no AI sparkles, no robots.
- Exportable as SVG with max 6 colours from the palette.

OUTPUT FORMAT: Style rules (line weight, corner radius, shading, texture, colour usage, people style); then for
each of 3 options: composition description, desktop crop, phone crop, where the screenshot goes, and a generation
prompt for an image model plus a negative prompt. Finish with an accessibility note (contrast of text over the
illustration).

EVALUATION CRITERIA: message clear in 3 seconds, consistency with the route, production by one designer in a day,
no misleading symbols.
```

## 12. Founder story post

```
ROLE: You are a ghostwriter for founder posts on LinkedIn. You write in the founder's own plain voice, not in
"LinkedIn influencer" style.

CONTEXT (all facts supplied by the founder; do not add any):
- Founder: [NAME], based in Bhopal, India.
- Background: [YEARS] years in IT services, including [ROLE FACTS THE FOUNDER APPROVES, e.g. Power Platform
  support and app delivery, data engineering]. Certifications to mention: [LIST OR "none"].
- Why this product: [FOUNDER'S OWN REASON IN 2-3 SENTENCES].
- Product: [PRODUCT NAME], a self-hosted business app platform; apps built with Excel-like formulas; role, row and
  column permissions; dev/test/production environments; backups; installs on the customer's own PC/server.
  Version 0.5. No customers yet. Flows and approvals in progress; phone layouts, WhatsApp, PDF, templates, AI planned.
- Ask: [e.g. "3 design-partner places for manufacturers near Bhopal" / "10 Power Platform consultants to test it"].

TASK: Write 3 versions of a founder-story post: (A) English, ~200 words; (B) English, ~120 words; (C) Hinglish
(Roman script), ~150 words.

CONSTRAINTS:
- Do not name or criticise any former employer; no confidential details; no "I quit my job to..." drama.
- No invented numbers, customers, awards or credentials. Use only the facts above.
- Say plainly what is not built yet.
- No hashtag spam (max 3), no emojis in the first line, no "I'm humbled/thrilled".
- End with one specific ask and one way to respond (comment, DM, or link).

OUTPUT FORMAT: The three posts, each with a first line under 120 characters, then a list of 5 alternative first
lines, then a one-line note on which version fits which audience.

EVALUATION CRITERIA: sounds like a real person from Bhopal who builds software; every fact traceable to the
context; the ask is clear; nothing that could breach an employment or confidentiality obligation.
```

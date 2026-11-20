/**
 * The built-in template catalogue (ships with the install, works offline). Every file is named here with a LITERAL
 * new URL of a relative path and import.meta.url: scripts/release/build.mjs follows exactly that pattern to put data files into the
 * release, so a template that is not listed here is neither loaded nor shipped. After editing a template run
 *   node server/core/templates/manifest.ts --write
 * to refresh its digest and builtin/manifest.json (catalogue.test.ts fails until you do).
 */
export const BUILTIN_TEMPLATE_FILES: { file: string; url: URL }[] = [
  { file: 'approval-bar.json', url: new URL('./approval-bar.json', import.meta.url) },
  { file: 'list-detail.json', url: new URL('./list-detail.json', import.meta.url) },
  { file: 'request-tracker.json', url: new URL('./request-tracker.json', import.meta.url) },
  { file: 'customers-contacts.json', url: new URL('./customers-contacts.json', import.meta.url) },
  // P3-M1 solution templates (format 2): the common business model and the worked example pack
  { file: 'business-model.json', url: new URL('./business-model.json', import.meta.url) },
  { file: 'visitor-log.json', url: new URL('./visitor-log.json', import.meta.url) },
  // P3-M2: the manufacturing pack
  { file: 'manufacturing.json', url: new URL('./manufacturing.json', import.meta.url) },
  { file: 'crm.json', url: new URL('./crm.json', import.meta.url) },
  { file: 'erp-lite.json', url: new URL('./erp-lite.json', import.meta.url) },
]

export const BUILTIN_MANIFEST_URL = new URL('./manifest.json', import.meta.url)

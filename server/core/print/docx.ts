/**
 * Word output (docs/dev/pdf.md "Word templates"): fills an uploaded .docx with docxtemplater's free core (MIT; no paid
 * modules) and PizZip. What the core does, and therefore what we offer:
 *   {formula}                  a value (the tag is a formula: {Number}, {FormatDate(InspectedOn)}, {Company.Name})
 *   {#rows}...{/rows}          a loop over a table (e.g. {#Related.Lines} ... {/Related.Lines}); inside, the row's
 *                              fields are names ({Qty}) and ThisItem is the row; a loop inside a table row repeats the row
 *   {#condition}...{/condition} shown when the formula is true; {^condition}...{/condition} when it is false
 * Not offered (paid modules or not in the core): images, HTML, tables built from data, charts, styling from data.
 * Tag formulas are pure (no table reads); Word's curly quotes inside a tag are read as straight quotes.
 * There is no conversion from .docx to PDF (no office engine in the install).
 */
import Docxtemplater from 'docxtemplater'
import PizZip from 'pizzip'
import type { FxEngine, FxRecord, FxScope, FxValue } from '../../../src/contracts.ts'
import { isRecord } from '../../../src/fx/values.ts'
import { plainText, type FormatOptions } from '../../../src/platform/print-format.ts'
import { checkZip, type ZipLimits } from '../zip-guard.ts'

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * P2 security re-check (finding P2-5): a .docx is a ZIP that PizZip unpacks in memory. Its directory is checked first
 * (zip-guard.ts), on upload and again before every generation (templates also arrive in solution packages, which do not
 * pass the upload check): at most 128 MB unpacked, 100 times compression, 2,000 parts, no ZIP64. A Word document is
 * compressed 5 to 20 times; a 10 MB "document" of zeros unpacks to gigabytes.
 */
export const DOCX_LIMITS: ZipLimits = { maxTotal: 128 * 1024 * 1024, maxRatio: 100, maxEntries: 2000 }

/** the tags of a template (designer: "fields used"); throws on a malformed template with the reason */
export function docxTags(bytes: Buffer): string[] {
  checkZip(bytes, 'The Word template', DOCX_LIMITS)
  const zip = new PizZip(bytes)
  const tags = new Set<string>()
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, parser: (tag) => { tags.add(tag); return { get: () => '' } } })
  try {
    doc.render({})
  } catch (e) {
    throw new Error(docxError(e))
  }
  return [...tags]
}

function docxError(e: unknown): string {
  const err = e as { properties?: { errors?: { properties?: { explanation?: string } }[]; explanation?: string }; message?: string }
  const list = err.properties?.errors?.map((x) => x.properties?.explanation).filter(Boolean) ?? []
  return list.length ? `The Word template has mistakes: ${list.slice(0, 5).join('; ')}` : err.properties?.explanation ?? err.message ?? 'The Word template could not be read.'
}

export function fillDocx(bytes: Buffer, base: FxScope, engine: FxEngine, fmt: FormatOptions, warn: (m: string) => void): Buffer {
  checkZip(bytes, 'The Word template', DOCX_LIMITS)
  let zip: PizZip
  try {
    zip = new PizZip(bytes)
  } catch {
    throw new Error('The uploaded file is not a Word document (.docx).')
  }
  const parser = (tag: string) => {
    const formula = tag.replace(/[“”„]/g, '"').replace(/[‘’]/g, "'").trim()
    return {
      get(scope: unknown, context: { scopeList: unknown[] }) {
        if (formula === '.') return scope
        const list = (context?.scopeList ?? []).slice()
        const sc: FxScope = {
          resolve(name) {
            if (name === 'ThisItem') {
              for (let i = list.length - 1; i >= 0; i--) if (isRecord(list[i] as FxValue)) return list[i] as FxValue
              return undefined
            }
            // the innermost loop row first, then outer rows, then the template's names
            for (let i = list.length - 1; i >= 0; i--) {
              const s = list[i]
              if (isRecord(s as FxValue) && Object.prototype.hasOwnProperty.call(s, name)) return (s as FxRecord)[name]
            }
            return base.resolve(name)
          },
        }
        const r = engine.evaluate(formula.startsWith('=') ? formula : `=${formula}`, sc)
        if (!r.ok) {
          warn(`Word tag {${tag}}: ${r.error.message} (left blank)`)
          return ''
        }
        const v = r.value
        if (Array.isArray(v) || typeof v === 'boolean') return v
        if (isRecord(v) && typeof (v as FxRecord).__display === 'string') return (v as FxRecord).__display
        return plainText(v, fmt)
      },
    }
  }
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, parser, nullGetter: () => '' })
  try {
    doc.render({})
  } catch (e) {
    throw new Error(docxError(e))
  }
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer
}

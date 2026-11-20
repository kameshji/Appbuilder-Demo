import type { AppMeta, TableDef } from '@/platform'
import { createAutoApp } from '@/autoapp/create'
import type { AutoAppOptions } from '@/autoapp'

/**
 * "Start with data" (Home): since P2 package D the same generator as "Create app from a table" (src/autoapp), at the
 * design size picked in the dialog: a list screen and a detail screen with an edit form, related lists and the
 * timeline. Widths under 700 px and portrait sizes get the one-column phone layout.
 */
export function startWithDataOptions(table: TableDef, size: { w: number; h: number }): Omit<AutoAppOptions, 'readable'> {
  return { name: `${table.displayName} app`, device: size.w < 700 ? 'phone' : 'desktop', width: size.w, height: size.h, tables: [table.name] }
}

export async function createAppWithData(table: TableDef, size: { w: number; h: number } = { w: 1920, h: 1080 }): Promise<AppMeta> {
  return (await createAutoApp(startWithDataOptions(table, size))).meta
}

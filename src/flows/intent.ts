/**
 * Entry points into the Flows page from elsewhere (the table designer's "Automate", the Studio): open the "New flow"
 * gallery with a table (and optionally a template) chosen. Kept in memory for the next visit of the Flows page.
 */
import { create } from 'zustand'
import { go } from '@/router'

export interface FlowIntent { table?: string; templateId?: string }

export const useFlowIntent = create<{ intent: FlowIntent | null; take(): FlowIntent | null }>((set, get) => ({
  intent: null,
  take: () => { const i = get().intent; if (i) set({ intent: null }); return i },
}))

/** go to the Flows page and open the gallery for a table */
export function automate(intent: FlowIntent): void {
  useFlowIntent.setState({ intent })
  go({ page: 'flows' })
}

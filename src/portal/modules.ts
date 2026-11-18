/**
 * Planned modules, as menu entries. ONE registry for both modes: the shell's navigation, the "Soon" badges and the
 * placeholder pages (`#soon-<key>`, ComingSoon.tsx) are all driven from here.
 *
 * To make a module real: set `status: 'live'` and give it a `route` (and build the page). The menu entry then
 * navigates to that route and loses its badge; nothing else needs to change.
 * Phases are the build phases of docs/plan/master-plan.md (section 5).
 */
import {
  Bot, CheckSquare, ClipboardCheck, FileText, Folder, Globe, Layers, LayoutDashboard, LayoutTemplate, Mail, MessagesSquare, Network,
  ShieldHalf, StickyNote, Workflow, type LucideIcon,
} from 'lucide-react'
import type { Route } from '@/router'

export type ShellMode = 'dev' | 'user'

export const PHASES = {
  P0: 'P0 Kernel',
  P1: 'P1 Automation',
  P2: 'P2 Reach',
  P3: 'P3 Collaboration and templates',
  P4: 'P4 Agents',
  P5: 'P5 Documents',
  P6: 'P6 Sites',
  later: 'Later (not yet in a phase)',
} as const
export type Phase = keyof typeof PHASES

export interface ModuleEntry {
  /** stable key: the route is `#soon-<key>` while the module is not built */
  key: string
  label: string
  icon: LucideIcon
  /** which shells list it (Dev mode navigation, User mode navigation) */
  modes: ShellMode[]
  status: 'soon' | 'live'
  /** where a live module's menu entry goes */
  route?: Route
  /** special entry behaviour: 'chat' opens the chat dock instead of a page */
  action?: 'chat'
  phase: Phase
  /** one line under the title */
  tagline: string
  /** 2-3 short lines on what it will do */
  details: string[]
  /** Dev mode entries for admins only */
  need?: 'maker' | 'admin'
}

export const MODULES: readonly ModuleEntry[] = [
  /* ---------------------------------------------------------------- Dev mode */
  {
    key: 'datamodel', label: 'Data model', icon: Network, modes: ['dev'], status: 'soon', phase: 'P0', need: 'maker',
    tagline: 'A visual schema designer for your tables.',
    details: [
      'See every table, lookup and relationship on one diagram and edit them in place.',
      'Add formula columns and relationship-based row rules ("rows of my team") without leaving the diagram.',
    ],
  },
  {
    key: 'flows', label: 'Flows', icon: Workflow, modes: ['dev'], status: 'soon', phase: 'P1', need: 'maker',
    tagline: 'Automate work when data changes, on a schedule or at a button press.',
    details: [
      'A visual designer with triggers (table event, schedule, button, webhook) and actions (data, condition, loop, delay, approval, notify, connector).',
      'Every run is recorded with its inputs and errors; flows act with the same security as an app.',
    ],
  },
  {
    key: 'approvals', label: 'Approvals', icon: ClipboardCheck, modes: ['dev', 'user'], status: 'soon', phase: 'P1',
    tagline: 'Request, approve and track decisions.',
    details: [
      'Approval requests from flows land in one inbox, with approve and reject in the app, by email or as a chat card.',
      'Escalation, reminders and a full history of who decided what and when.',
    ],
  },
  {
    key: 'dashboards', label: 'Dashboards', icon: LayoutDashboard, modes: ['dev', 'user'], status: 'soon', phase: 'P2',
    tagline: 'Charts and KPIs over your tables, trimmed to what each viewer may see.',
    details: [
      'Build dashboards from chart controls on top of server-side aggregates; share them as pages or chat cards.',
      'An OData feed for people who prefer Excel or Power BI.',
    ],
  },
  {
    key: 'agents', label: 'Agents', icon: Bot, modes: ['dev'], status: 'soon', phase: 'P4', need: 'maker',
    tagline: 'AI agents with instructions, allow-listed tools and knowledge.',
    details: [
      'An agent runs as the calling user and can only use the tools and data you allow; writes need human approval.',
      'Works with hosted providers or a local Ollama; every turn and tool call is audited, with budgets per install.',
    ],
  },
  {
    key: 'sites', label: 'Sites', icon: Globe, modes: ['dev'], status: 'soon', phase: 'P6', need: 'maker',
    tagline: 'External portals for suppliers and customers.',
    details: [
      'A page builder with deny-by-default data blocks and a security check before anything is published.',
      'One-time-code sign-in for external users, with their own roles.',
    ],
  },
  {
    key: 'environments', label: 'Environments', icon: Layers, modes: ['dev'], status: 'soon', phase: 'P0', need: 'admin',
    tagline: 'Separate Dev, Test and Prod workspaces on one install.',
    details: [
      'Move solutions from Dev to Test to Prod with a previewed upgrade plan and an automatic backup first.',
      'Prod is locked against direct edits.',
    ],
  },
  {
    key: 'admin', label: 'Admin console', icon: ShieldHalf, modes: ['dev'], status: 'soon', phase: 'P0', need: 'admin',
    tagline: 'Users, audit, backups and licences in one place.',
    details: [
      'Manage users, departments and teams; browse the audit log and server logs.',
      'Nightly downloadable backups with restore in place, usage, AI budget and licence status.',
    ],
  },
  {
    key: 'templates', label: 'Templates', icon: LayoutTemplate, modes: ['dev'], status: 'soon', phase: 'P3', need: 'maker',
    tagline: 'Ready-made apps: CRM, ERP and the manufacturing pack.',
    details: [
      'Tasks, Notes, CRM and the manufacturing pack (production log with OEE, quality inspection with NCR, maintenance).',
      'ERP templates (inventory, purchase, sales, ledgers and GST) built on the platform; data import from other systems, with an optional Tally exchange.',
    ],
  },

  /* ---------------------------------------------------------------- User mode */
  {
    key: 'tasks', label: 'Tasks', icon: CheckSquare, modes: ['user'], status: 'soon', phase: 'P3',
    tagline: 'Your to-dos and the work assigned to you.',
    details: [
      'Personal and team tasks with due dates, owners and reminders.',
      'Tasks created by flows and approvals show up here, linked to the record they are about.',
    ],
  },
  {
    key: 'notes', label: 'Notes', icon: StickyNote, modes: ['user'], status: 'soon', phase: 'P3',
    tagline: 'Rich-text notes, private or shared.',
    details: [
      'Write notes with headings, lists, tables and images; share them with people or teams.',
      'Attach a note to any record so the context stays with the data.',
    ],
  },
  {
    key: 'chat', label: 'Chat', icon: MessagesSquare, modes: ['user'], status: 'soon', phase: 'P3', action: 'chat',
    tagline: 'Talk to your team without leaving your apps.',
    details: [
      'Channels, direct messages, mentions and file sharing.',
      'Share a record, an app or a dashboard as a card; discuss a record in its own thread; search everything.',
    ],
  },
  {
    key: 'files', label: 'Files', icon: Folder, modes: ['user'], status: 'soon', phase: 'P5',
    tagline: 'A document library with folders and versions.',
    details: [
      'Folders, versions and permissions that follow the record or folder a file belongs to.',
      'Full-text search inside documents, trimmed to what you may read.',
    ],
  },
  {
    key: 'documents', label: 'Documents / Slides / Sheets', icon: FileText, modes: ['user'], status: 'soon', phase: 'P5',
    tagline: 'Create and edit documents, presentations and spreadsheets in the browser.',
    details: [
      'Generate documents and PDFs from templates filled with your data.',
      'Full Word, PowerPoint and Excel editing through the optional office add-on.',
    ],
  },
  {
    key: 'mail', label: 'Mail', icon: Mail, modes: ['user'], status: 'soon', phase: 'later',
    tagline: 'Your email next to your apps.',
    details: [
      'Read and send mail from your company mailbox, and turn a message into a record or a task.',
      'Not scheduled yet: outgoing email notifications come first, with flows in P1 Automation.',
    ],
  },
]

export const moduleByKey = (key: string): ModuleEntry | undefined => MODULES.find((m) => m.key === key)
export const modulesFor = (mode: ShellMode): ModuleEntry[] => MODULES.filter((m) => m.modes.includes(mode))
/** the route a menu entry opens (live module: its route; planned: its placeholder page) */
export const moduleRoute = (m: ModuleEntry): Route => (m.status === 'live' && m.route ? m.route : { page: 'soon', id: m.key })

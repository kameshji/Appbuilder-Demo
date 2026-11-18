/**
 * Settings (#settings, #settings-<section>): a full-window page with its own section list, opened from the
 * Settings entry at the bottom of the sidebar or the avatar menu (also in the Studio). The close button returns to
 * where the user was.
 *
 * Rule for every control: real where the backing exists today; otherwise shown disabled with a "Soon" badge and one
 * line on what is coming and when (phases of docs/plan/master-plan.md). Client preferences live in ONE store,
 * src/platform/preferences.ts.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft, Bell, Check, Database, Download, ExternalLink, FileText, Info, KeyRound, Languages, LogOut, MessagesSquare, Monitor, Moon,
  Palette, PenTool, ShieldHalf, Sun, Trash2, UserRound, X, type LucideIcon,
} from 'lucide-react'
import { platform, usePlatform } from '@/platform'
import type { StatusServerInfo } from '@/platform/http'
import {
  AVATAR_COLORS, AVATAR_HEX, avatarColorOf, clearLocalData, exportPreferences, localDataKeys, usePrefs, type GridSize, type Preferences,
} from '@/platform/preferences'
import { SIZE_PRESETS, sizeLabel } from '@/runtime/sizes'
import { go, type Route } from '@/router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ChangePasswordDialog } from './Auth'
import { SoonBadge } from './ComingSoon'
import { ConfirmDialog, Segmented, downloadText, errMsg, useToast } from './kit'
import { UserAvatar, settingsReturnRoute, useMe } from './Profile'
import { useCaps } from './security'
import { fetchServerInfo } from './serverApi'
import type { ShellMode } from './modules'

export type SettingsSection = 'profile' | 'appearance' | 'region' | 'notifications' | 'chat' | 'studio' | 'data' | 'admin' | 'about'
interface SectionDef { key: SettingsSection; label: string; icon: LucideIcon; need?: 'maker' | 'admin' }
const SECTIONS: SectionDef[] = [
  { key: 'profile', label: 'Profile', icon: UserRound },
  { key: 'appearance', label: 'Appearance', icon: Palette },
  { key: 'region', label: 'Language and region', icon: Languages },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'chat', label: 'Chat', icon: MessagesSquare },
  { key: 'studio', label: 'Studio', icon: PenTool, need: 'maker' },
  { key: 'data', label: 'Data and privacy', icon: Database },
  { key: 'admin', label: 'Administration', icon: ShieldHalf, need: 'admin' },
  { key: 'about', label: 'About', icon: Info },
]

/** the sections this user sees, in order */
export function settingsSections(caps: { isAdmin: boolean; isMaker: boolean }): SettingsSection[] {
  return SECTIONS.filter((s) => !s.need || (s.need === 'admin' ? caps.isAdmin : caps.isMaker || caps.isAdmin)).map((s) => s.key)
}

/* ------------------------------------------------------------------ building blocks */

function Group({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="mb-7" data-testid={testId}>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
      <div className="divide-y divide-border rounded-xl border border-border bg-card">{children}</div>
    </section>
  )
}

/** one setting: label and description on the left, the control on the right. soon: disabled, with what is coming */
function Row({ title, description, children, soon, testId }: { title: string; description?: ReactNode; children?: ReactNode; soon?: string; testId?: string }) {
  return (
    <div className={cn('flex items-center gap-6 px-4 py-3.5', soon && 'opacity-90')} data-testid={testId} data-soon={soon ? 'true' : undefined}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">{title}{soon && <SoonBadge />}</div>
        {description && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</div>}
        {soon && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{soon}</div>}
      </div>
      {children && <div className={cn('shrink-0', soon && 'pointer-events-none')}>{children}</div>}
    </div>
  )
}

const DisabledSelect = ({ label, value }: { label: string; value: string }) => (
  <select disabled aria-label={label} className="h-8 min-w-40 rounded-md border border-input bg-muted/50 px-2 text-sm text-muted-foreground">
    <option>{value}</option>
  </select>
)

const NativeSelect = ({ id, value, onChange, children, testId, className }: { id?: string; value: string; onChange(v: string): void; children: ReactNode; testId?: string; className?: string }) => (
  <select id={id} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} className={cn('h-8 min-w-40 rounded-md border border-input bg-background px-2 text-sm outline-none focus:border-ring', className)}>
    {children}
  </select>
)

/* ------------------------------------------------------------------ page */

export function SettingsPage({ section, mode }: { section?: string; mode: ShellMode }) {
  const caps = useCaps()
  const visible = settingsSections(caps)
  const current: SettingsSection = visible.includes(section as SettingsSection) ? (section as SettingsSection) : 'profile'
  const fallback: Route = mode === 'user' ? { page: 'u' } : { page: 'home' }
  const close = () => go(settingsReturnRoute(fallback))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // a dialog or menu that is open handles Escape itself
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div data-testid="settings-page" className="flex h-full min-w-[900px] flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
        <Button variant="ghost" size="sm" onClick={close} data-testid="settings-back"><ArrowLeft /> Back</Button>
        <span className="h-5 w-px bg-border" />
        <h1 className="text-[15px] font-semibold tracking-tight">Settings</h1>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={close} aria-label="Close settings" title="Close (Esc)" data-testid="settings-close"><X /></Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings sections" data-testid="settings-nav" className="flex w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-card/60 p-2.5">
          {SECTIONS.filter((s) => visible.includes(s.key)).map((s) => (
            <button
              key={s.key}
              type="button"
              data-testid={`settings-nav-${s.key}`}
              aria-current={current === s.key ? 'page' : undefined}
              onClick={() => go({ page: 'settings', id: s.key })}
              className={cn(
                'flex h-9 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
                current === s.key ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <s.icon className="size-4 shrink-0" />
              <span className="truncate">{s.label}</span>
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto bg-canvas">
          <div className="mx-auto w-full max-w-3xl px-8 py-7" data-testid={`settings-section-${current}`}>
            <h2 className="mb-5 text-xl font-semibold tracking-tight">{SECTIONS.find((s) => s.key === current)!.label}</h2>
            {current === 'profile' && <ProfileSection />}
            {current === 'appearance' && <AppearanceSection />}
            {current === 'region' && <RegionSection />}
            {current === 'notifications' && <NotificationsSection />}
            {current === 'chat' && <ChatSection />}
            {current === 'studio' && <StudioSection />}
            {current === 'data' && <DataSection />}
            {current === 'admin' && <AdminLinksSection />}
            {current === 'about' && <AboutSection />}
          </div>
        </main>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ profile */

function ProfileSection() {
  const { user, demo } = useMe()
  const avatarColor = usePrefs((s) => s.avatarColor)
  const { toast, fail } = useToast()
  const [name, setName] = useState(user?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [pw, setPw] = useState(false)
  useEffect(() => { setName(user?.name ?? '') }, [user?.id, user?.name])
  const dirty = !!user && name.trim() !== user.name && !!name.trim()
  const save = async () => {
    if (!dirty) return
    setBusy(true)
    try {
      await platform.auth.updateProfile({ name: name.trim() })
      toast('Name saved', 'success')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  if (!user) return null
  const auto = avatarColorOf(user.id, 'auto')

  return (
    <>
      <div className="mb-6 flex items-center gap-4">
        <UserAvatar user={{ ...user, name: name.trim() || user.name }} size={56} />
        <div className="min-w-0">
          <div className="truncate text-lg font-semibold">{user.name}</div>
          <div className="truncate text-sm text-muted-foreground">{user.email}</div>
        </div>
      </div>
      <Group title="Account" testId="settings-account">
        <Row title="Display name" description={demo ? 'Demo mode: renames the user you are running as, in this browser.' : 'Shown to other people in apps, the audit log and the user list.'} testId="setting-name">
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void save() }}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="h-8 w-56" aria-label="Display name" data-testid="profile-name" />
            <Button type="submit" size="sm" disabled={!dirty || busy} data-testid="profile-name-save">Save</Button>
          </form>
        </Row>
        <Row title="Email" description="Your sign-in name. Only an administrator can change it." testId="setting-email">
          <Input value={user.email} readOnly className="h-8 w-72 bg-muted/50 text-muted-foreground" aria-label="Email (read-only)" data-testid="profile-email" />
        </Row>
        <Row title="Avatar colour" description="The circle with your initials. Only in this browser." testId="setting-avatar">
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Avatar colour">
            <button
              type="button" role="radio" aria-checked={avatarColor === 'auto'} title="Automatic (from your account)" onClick={() => usePrefs.getState().set({ avatarColor: 'auto' })}
              data-testid="avatar-color-auto"
              className={cn('h-6 rounded-full border px-2 text-[11px] font-medium', avatarColor === 'auto' ? 'border-primary text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}
            >
              Auto
            </button>
            {AVATAR_COLORS.map((c) => (
              <button
                key={c} type="button" role="radio" aria-checked={avatarColor === c} aria-label={c} title={c === auto ? `${c} (automatic)` : c}
                data-testid={`avatar-color-${c}`}
                onClick={() => usePrefs.getState().set({ avatarColor: c })}
                className={cn('grid size-6 place-items-center rounded-full outline-none ring-offset-2 ring-offset-card focus-visible:ring-2 focus-visible:ring-ring', avatarColor === c && 'ring-2 ring-foreground/70')}
                style={{ background: AVATAR_HEX[c] }}
              >
                {avatarColor === c && <Check className="size-3.5 text-white" />}
              </button>
            ))}
          </div>
        </Row>
      </Group>

      <Group title="Security" testId="settings-security">
        <Row title="Password" description={demo ? 'Demo mode has no passwords; sign-in needs the local server.' : 'Change the password you sign in with. Other devices are signed out.'} testId="setting-password">
          <Button size="sm" variant="outline" disabled={demo} onClick={() => setPw(true)} data-testid="settings-change-password"><KeyRound /> Change password</Button>
        </Row>
        <Row title="Sign out everywhere" soon="See your active sessions and end them on every device. Arrives with P0 Kernel (identity basics: reset, TOTP, sessions)." testId="setting-sessions">
          <Button size="sm" variant="outline" disabled tabIndex={-1}>Active sessions</Button>
        </Row>
        <Row title="Two-step verification" soon="A code from an authenticator app (TOTP) in addition to your password. Arrives with P0 Kernel." testId="setting-2fa">
          <Switch disabled aria-label="Two-step verification" tabIndex={-1} />
        </Row>
        <Row title="Passkeys and single sign-on" soon="Sign in with a passkey, or with your company account (single sign-on in and out). Arrives with P3.5 Identity advanced." testId="setting-sso">
          <Button size="sm" variant="outline" disabled tabIndex={-1}>Add a passkey</Button>
        </Row>
        {!demo && (
          <Row title="Sign out" description="End your session in this browser." testId="setting-signout">
            <Button size="sm" variant="outline" onClick={() => { platform.auth.logout().catch(fail) }} data-testid="settings-sign-out"><LogOut /> Sign out</Button>
          </Row>
        )}
      </Group>
      {!demo && <ChangePasswordDialog open={pw} onOpenChange={setPw} />}
    </>
  )
}

/* ------------------------------------------------------------------ appearance */

function AppearanceSection() {
  const caps = useCaps()
  const theme = usePrefs((s) => s.theme)
  const startMode = usePrefs((s) => s.startMode)
  const reduceMotion = usePrefs((s) => s.reduceMotion)
  const systemReduced = usePrefs((s) => s.systemReducedMotion)
  const set = (p: Partial<Preferences>) => usePrefs.getState().set(p)
  return (
    <>
      <Group title="Look" testId="settings-look">
        <Row title="Theme" description="Light, dark, or follow your operating system. Applies to the shell, the Studio and the chat window." testId="setting-theme">
          <Segmented label="Theme" value={theme} onChange={(v) => set({ theme: v })} options={[
            { value: 'light', label: <><Sun className="size-3.5" /> Light</> },
            { value: 'dark', label: <><Moon className="size-3.5" /> Dark</> },
            { value: 'system', label: <><Monitor className="size-3.5" /> System</> },
          ]} />
        </Row>
        <Row title="Density" soon="Compact or comfortable spacing in lists and tables. Not scheduled in a phase yet; today the layout is compact." testId="setting-density">
          <Segmented label="Density" disabled value="compact" onChange={() => undefined} options={[{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }]} />
        </Row>
        <Row
          title="Reduce motion"
          description={<>Turns off transitions and animations in the product, and stops animated icons from looping (also in running apps). {systemReduced && <span className="font-medium text-foreground">Your operating system already asks for reduced motion.</span>}</>}
          testId="setting-motion"
        >
          <Segmented label="Reduce motion" value={reduceMotion} onChange={(v) => set({ reduceMotion: v })} options={[{ value: 'system', label: 'Follow system' }, { value: 'reduce', label: 'Reduce' }]} />
        </Row>
      </Group>
      {(caps.isMaker || caps.isAdmin) && (
        <Group title="Start" testId="settings-start">
          <Row title="Mode at start" description="Which mode opens when you go to the plain address. A link to a page always opens that page." testId="setting-start-mode">
            <Segmented label="Mode at start" value={startMode} onChange={(v) => set({ startMode: v })} options={[{ value: 'last', label: 'Last used' }, { value: 'dev', label: 'Dev mode' }, { value: 'user', label: 'User mode' }]} />
          </Row>
        </Group>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ language and region */

function RegionSection() {
  const facts = useMemo(() => {
    try {
      const o = Intl.DateTimeFormat().resolvedOptions()
      const sample = new Date(Date.UTC(2026, 10, 18, 14, 30))
      return {
        locale: o.locale, timeZone: o.timeZone,
        date: sample.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
        number: (1234567.891).toLocaleString(undefined, { maximumFractionDigits: 2 }),
      }
    } catch {
      return { locale: 'unknown', timeZone: 'unknown', date: '', number: '' }
    }
  }, [])
  const why = 'Needs formula support first: Text(), DateValue() and Language() in apps use fixed formats today, so a setting here could not be honoured everywhere. Not scheduled in a phase yet.'
  return (
    <>
      <div className="mb-5 flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground" data-testid="region-facts">
        <Info className="mt-px size-3.5 shrink-0 text-primary" />
        <span>
          Today the portal shows dates and numbers the way your browser does: language <b className="text-foreground">{facts.locale}</b>, time zone <b className="text-foreground">{facts.timeZone}</b>
          {facts.date && <> (for example {facts.date} and {facts.number})</>}. The server keeps times in UTC.
        </span>
      </div>
      <Group title="Formats" testId="settings-formats">
        <Row title="Date format" soon={why} testId="setting-date-format"><DisabledSelect label="Date format" value="Browser default" /></Row>
        <Row title="Number format" soon={why} testId="setting-number-format"><DisabledSelect label="Number format" value="Browser default" /></Row>
        <Row title="First day of the week" soon={why} testId="setting-week-start"><DisabledSelect label="First day of the week" value="Browser default" /></Row>
        <Row title="Time zone" soon={why} testId="setting-time-zone"><DisabledSelect label="Time zone" value={facts.timeZone} /></Row>
      </Group>
      <Group title="Language" testId="settings-language">
        <Row title="Interface language" soon="The product is in English only. Translations (including Hindi) are not scheduled in a phase yet." testId="setting-language"><DisabledSelect label="Interface language" value="English" /></Row>
      </Group>
    </>
  )
}

/* ------------------------------------------------------------------ notifications */

function NotificationsSection() {
  const soon = 'Arrives with P1 Automation (notifications in the app and by email, with per-user preferences).'
  return (
    <Group title="Notifications" testId="settings-notifications">
      <Row title="In the app" soon={soon} testId="setting-notify-app"><Switch disabled aria-label="Notifications in the app" tabIndex={-1} /></Row>
      <Row title="By email" soon={soon} testId="setting-notify-email"><Switch disabled aria-label="Notifications by email" tabIndex={-1} /></Row>
      <Row title="Approvals waiting for me" soon="Approval requests with approve and reject in the notification. Arrives with P1 Automation." testId="setting-notify-approvals"><Switch disabled aria-label="Approvals" tabIndex={-1} /></Row>
    </Group>
  )
}

/* ------------------------------------------------------------------ chat */

function ChatSection() {
  const side = usePrefs((s) => s.chatSide)
  const restore = usePrefs((s) => s.chatRestore)
  const set = (p: Partial<Preferences>) => usePrefs.getState().set(p)
  const soon = 'Chat itself (channels, direct messages, mentions, files) arrives with P3 Collaboration; the dock already exists.'
  return (
    <>
      <Group title="Chat dock" testId="settings-chat-dock">
        <Row title="Dock side" description="Where the chat panel opens, in the shell and in the Studio." testId="setting-chat-side">
          <Segmented label="Dock side" value={side} onChange={(v) => set({ chatSide: v })} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} />
        </Row>
        <Row title="Reopen chat at start" description="When on, the chat panel is open again after a reload if it was open before. When off, it always starts closed." testId="setting-chat-restore">
          <Switch checked={restore} onCheckedChange={(v) => set({ chatRestore: v })} aria-label="Reopen chat at start" data-testid="chat-restore-switch" />
        </Row>
      </Group>
      <Group title="Messages" testId="settings-chat-messages">
        <Row title="Message notifications" soon={soon} testId="setting-chat-notify"><Switch disabled aria-label="Message notifications" tabIndex={-1} /></Row>
        <Row title="Status and presence" soon={soon} testId="setting-chat-presence"><DisabledSelect label="Status" value="Available" /></Row>
      </Group>
    </>
  )
}

/* ------------------------------------------------------------------ studio */

function StudioSection() {
  const size = usePrefs((s) => s.studioDefaultSize)
  const snap = usePrefs((s) => s.studioSnap)
  const grid = usePrefs((s) => s.studioGrid)
  const set = (p: Partial<Preferences>) => usePrefs.getState().set(p)
  return (
    <>
      <Group title="New apps" testId="settings-studio-new">
        <Row title="Default app size" description="Preselected in New app and Start with data. You can still pick another size there." testId="setting-default-size">
          <NativeSelect value={size} onChange={(v) => set({ studioDefaultSize: v })} testId="studio-default-size">
            {(['Desktop', 'Phone', 'Tablet'] as const).map((g) => (
              <optgroup key={g} label={g}>
                {SIZE_PRESETS.filter((p) => p.group === g).map((p) => <option key={p.id} value={p.id}>{sizeLabel(p)}</option>)}
              </optgroup>
            ))}
          </NativeSelect>
        </Row>
      </Group>
      <Group title="Canvas" testId="settings-studio-canvas">
        <Row title="Snap while dragging" description="Snap controls to the grid and to the edges and centres of other controls. Holding Alt always moves freely." testId="setting-snap">
          <Switch checked={snap} onCheckedChange={(v) => set({ studioSnap: v })} aria-label="Snap while dragging" data-testid="studio-snap" />
        </Row>
        <Row title="Grid size" description="The step for snapping, inserting and moving controls with the mouse." testId="setting-grid">
          <Segmented label="Grid size" disabled={!snap} value={String(grid) as '4' | '8' | '16'} onChange={(v) => set({ studioGrid: Number(v) as GridSize })} options={[{ value: '4', label: '4 px' }, { value: '8', label: '8 px' }, { value: '16', label: '16 px' }]} />
        </Row>
        <Row title="Saving" description="The Studio saves every change by itself, under a second after you stop editing. There is nothing to set." testId="setting-autosave" />
      </Group>
    </>
  )
}

/* ------------------------------------------------------------------ data and privacy */

function DataSection() {
  const { toast } = useToast()
  const mode = usePlatform((s) => s.mode)
  const [confirm, setConfirm] = useState(false)
  const keys = localDataKeys()
  return (
    <>
      <Group title="Your data in this browser" testId="settings-local-data">
        <Row title="Export my settings" description="Download your preferences (theme, chat dock, Studio defaults and so on) as a JSON file." testId="setting-export">
          <Button size="sm" variant="outline" data-testid="export-settings" onClick={() => { downloadText('appbuilder-settings.json', exportPreferences(), 'application/json'); toast('Settings exported', 'success') }}><Download /> Export</Button>
        </Row>
        <Row
          title="Clear local data"
          description={<>Removes what Appbuilder keeps in this browser's local storage ({keys.length === 1 ? '1 entry' : `${keys.length} entries`}): preferences, open tabs, recent apps, the chat dock and Studio view state. {mode === 'server' ? 'Your apps and data on the server are not touched and you stay signed in.' : 'The demo workspace (apps and tables, kept in the browser database) is not touched.'}</>}
          testId="setting-clear"
        >
          <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirm(true)} data-testid="clear-local-data"><Trash2 /> Clear</Button>
        </Row>
      </Group>
      <Group title="AI" testId="settings-ai">
        <Row title="Share data with AI features" soon="Choose whether agents may send your data to an AI provider (off, an approved provider, or a local model). Arrives with P4 Agents; nothing is sent anywhere today." testId="setting-ai">
          <Switch disabled aria-label="Share data with AI features" tabIndex={-1} />
        </Row>
      </Group>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Clear local data?"
        description="Your preferences, open app tabs, recent apps and Studio view state in this browser are removed, and the page reloads. This cannot be undone."
        confirmLabel="Clear and reload"
        onConfirm={() => {
          clearLocalData()
          setTimeout(() => location.reload(), 50)
        }}
      />
    </>
  )
}

/* ------------------------------------------------------------------ admin links */

function AdminLinksSection() {
  const links: { label: string; text: string; route: Route }[] = [
    { label: 'Environments', text: 'The built-in Default environment and what is planned.', route: { page: 'admin', id: 'environments' } },
    { label: 'Users', text: 'Add people, set passwords, enable or disable, assign roles.', route: { page: 'admin', id: 'users' } },
    { label: 'Licences', text: 'Current licence state and the planned passes.', route: { page: 'admin', id: 'licences' } },
    { label: 'Audit log', text: 'Who did what, and when.', route: { page: 'admin', id: 'audit' } },
    { label: 'Security roles', text: 'Table, column and row access per role.', route: { page: 'roles' } },
    { label: 'Connections', text: 'Databases, data files and Google Sheets.', route: { page: 'connections' } },
  ]
  return (
    <Group title="Admin console" testId="settings-admin-links">
      {links.map((l) => (
        <Row key={l.label} title={l.label} description={l.text}>
          <Button size="sm" variant="outline" onClick={() => go(l.route)} data-testid={`settings-admin-${l.label.toLowerCase().replace(/\s+/g, '-')}`}>Open <ExternalLink /></Button>
        </Row>
      ))}
    </Group>
  )
}

/* ------------------------------------------------------------------ about */

function AboutSection() {
  const mode = usePlatform((s) => s.mode)
  const storage = usePlatform((s) => s.storage)
  const caps = useCaps()
  const [info, setInfo] = useState<{ server?: StatusServerInfo; databaseError?: string } | null>(null)
  const [error, setError] = useState('')
  const [all, setAll] = useState(false)
  useEffect(() => {
    if (mode !== 'server' || !caps.isAdmin) return
    let alive = true
    fetchServerInfo().then((i) => alive && setInfo(i)).catch((e) => alive && setError(errMsg(e)))
    return () => { alive = false }
  }, [mode, caps.isAdmin])
  const notices = __THIRD_PARTY__
  const shown = all ? notices : notices.slice(0, 12)
  const docs = [
    ['Getting started', 'docs/guide/getting-started.md'],
    ['Troubleshooting', 'docs/guide/troubleshooting.md'],
    ['Users and roles (administrators)', 'docs/admin/users-and-roles.md'],
    ['Installation and upgrades', 'docs/admin/installation.md'],
    ['Formula reference', 'docs/reference/formulas.md'],
  ]
  return (
    <>
      <Group title="This version" testId="settings-version">
        <Row title="Appbuilder" description="Working name; the product name is not chosen yet."><span className="font-mono text-sm" data-testid="about-version">{__APP_VERSION__}</span></Row>
        <Row title="Mode" description={mode === 'server' ? 'Connected to the local server: sign-in, the system database and server-enforced security.' : 'Demo mode: everything runs and is stored in this browser; security is simulated.'}>
          <span className="text-sm" data-testid="about-mode">{mode === 'server' ? 'Server' : 'Demo'}</span>
        </Row>
        {mode === 'server' && caps.isAdmin && (
          <>
            <Row title="Server" description="Version of the running server and of Node.js."><span className="font-mono text-sm" data-testid="about-server">{info?.server ? `${info.server.version} on Node ${info.server.node}` : error || '...'}</span></Row>
            <Row title="Database" description={storage.location || 'The system database.'}><span className="font-mono text-sm" data-testid="about-database">{info?.server ? `${info.server.database ?? 'not reachable'} · schema ${info.server.schemaVersion}` : '...'}</span></Row>
            {info?.databaseError && <Row title="Database problem" description={info.databaseError} />}
          </>
        )}
        {mode === 'server' && !caps.isAdmin && <Row title="Server" description="Server and database versions are shown to administrators." />}
      </Group>
      <Group title="Setup and health" testId="settings-health">
        <Row title="Health check" description={<>The server answers <code className="font-mono">GET /api/v1/status</code> (no sign-in needed) with whether the database is reachable and set up. Administrators also see the database details there.</>} />
        <Row title="Install, back up and upgrade" description="The administrator guide in docs/admin/ (installation, backup and restore, upgrades, hardening checklist) is part of the installation folder." />
      </Group>
      <Group title="Documentation" testId="settings-docs">
        {docs.map(([t, p]) => <Row key={p} title={t} description={<span className="font-mono">{p}</span>}><FileText className="size-4 text-muted-foreground" /></Row>)}
        <Row title="Where the documents are" description="In the docs folder of the installation (or the source repository). They are not served by the app yet." />
      </Group>
      <Group title={`Third-party notices (${notices.length} packages)`} testId="settings-notices">
        <div className="px-4 py-3 text-xs text-muted-foreground">Appbuilder includes the open-source packages below, each under its own licence. The full licence texts are in <span className="font-mono">THIRD-PARTY-NOTICES.md</span> in the installation folder.</div>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-xs" data-testid="notices-table">
            <thead><tr className="border-y border-border bg-muted/50 text-left text-muted-foreground"><th className="px-4 py-1.5 font-medium">Package</th><th className="px-4 py-1.5 font-medium">Version</th><th className="px-4 py-1.5 font-medium">Licence</th></tr></thead>
            <tbody>
              {shown.map(([n, v, l]) => <tr key={`${n}@${v}`} className="border-b border-border last:border-0"><td className="px-4 py-1 font-mono">{n}</td><td className="px-4 py-1 font-mono text-muted-foreground">{v}</td><td className="px-4 py-1">{l}</td></tr>)}
            </tbody>
          </table>
        </div>
        {notices.length > shown.length && <div className="px-4 py-2"><Button size="xs" variant="ghost" onClick={() => setAll(true)} data-testid="notices-all">Show all {notices.length}</Button></div>}
        {notices.length === 0 && <div className="px-4 py-3 text-xs text-muted-foreground">The notices file was not found when this build was made.</div>}
      </Group>
    </>
  )
}

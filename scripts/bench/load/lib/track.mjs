/**
 * Live delivery bookkeeping of the load harness (scripts/bench/load): end-to-end push latency (the write or chat send
 * leaves the harness -> the push arrives on a subscriber's socket), lost and duplicate pushes, task reminders.
 */
import { performance } from 'node:perf_hooks'
import { summary } from './util.mjs'

export function liveTracker() {
  let sockSeq = 1
  const sockets = []
  const writes = new Map()
  const chats = new Map()
  const tr = {
    chatSeq: 1, tableLat: [], chatLat: [], chatLatByPhase: new Map(), tableLatByPhase: new Map(), dupTable: 0, dupChat: 0, nullTicks: 0, resyncs: 0, closes: new Map(), reminders: [], phase: 'setup',
    sockets,
    register(s, org) {
      s.id = sockSeq++
      s.org = org.inst.key
      s.openedAt = performance.now()
      s.nullTickTimes = []
      s.capable = false
      s.seqs = new Set()
      sockets.push(s)
    },
    noteWrite(org, id) { writes.set(id, { t0: performance.now(), org: org.inst.key, got: new Set(), phase: tr.phase }) },
    noteChat(org, token, person) { chats.set(token, { t0: performance.now(), org: org.inst.key, sender: person, got: new Set(), phase: tr.phase }) },
    unnoteChat(token) { chats.delete(token) },
    onTable(m, at, s) {
      // a duplicate is the same change (seq) delivered twice; a second change of the same row is not
      if (m.seq !== undefined) { const k = `${m.topic}:${m.seq}`; if (s.seqs.has(k)) { tr.dupTable++; return } s.seqs.add(k) }
      if (!Array.isArray(m.rows)) { s.nullTickTimes.push(at); tr.nullTicks++; return }
      s.capable = true
      for (const id of m.rows) {
        const w = writes.get(id)
        if (!w) continue
        if (w.got.has(s.id)) continue
        w.got.add(s.id)
        tr.tableLat.push(at - w.t0)
        const a = tr.tableLatByPhase.get(w.phase) ?? []
        a.push(at - w.t0)
        tr.tableLatByPhase.set(w.phase, a)
      }
    },
    onChat(m, at, s) {
      if (m.op !== 'message' || !m.message) return
      const token = /lt\d+x/.exec(m.message.text ?? m.message.body ?? '')?.[0]
      const c = token && chats.get(token)
      if (!c) return
      if (c.got.has(s.id)) { tr.dupChat++; return }
      c.got.add(s.id)
      tr.chatLat.push(at - c.t0)
      const a = tr.chatLatByPhase.get(c.phase) ?? []
      a.push(at - c.t0)
      tr.chatLatByPhase.set(c.phase, a)
    },
    onUser(m, at, s) {
      if (m.event === 'notification' && (m.notification?.kind === 'task' || /task/i.test(String(m.notification?.source ?? '')))) tr.reminders.push({ at: Date.now(), user: s.person.user.id, title: m.notification?.title })
    },
    onResync() { tr.resyncs++ },
    onClose(s, code) { tr.closes.set(code, (tr.closes.get(code) ?? 0) + 1) },
    /** after the run (and a grace period): who missed what */
    account(createdIds) {
      const created = new Set(createdIds)
      let tableExpected = 0
      let tableLost = 0
      const lostTableExamples = []
      for (const [id, w] of writes) {
        if (!created.has(id)) continue
        for (const s of sockets) {
          if (s.org !== w.org || !s.capable || !s.tableSub) continue
          if (s.openedAt > w.t0 || (s.closedPerf && s.closedPerf < w.t0 + 10_000)) continue
          tableExpected++
          if (w.got.has(s.id)) continue
          if (s.nullTickTimes.some((t) => t >= w.t0 && t <= w.t0 + 15_000)) continue // covered by a "table changed" tick
          tableLost++
          if (lostTableExamples.length < 5) lostTableExamples.push({ org: w.org, row: id, socket: s.id, user: s.person.user.email, role: s.person.user.role, phase: w.phase, closed: s.closed?.code ?? null, sinceOpenS: Math.round((w.t0 - s.openedAt) / 1000) })
        }
      }
      let chatExpected = 0
      let chatLost = 0
      let ownMissing = 0
      const lostChatExamples = []
      for (const [token, c] of chats) {
        for (const s of sockets) {
          if (s.org !== c.org || !s.chatSub) continue
          if (s.openedAt > c.t0 || (s.closedPerf && s.closedPerf < c.t0 + 10_000)) continue
          const own = s.person === c.sender
          if (c.got.has(s.id)) { chatExpected++; continue }
          if (own) { ownMissing++; continue }
          chatExpected++
          chatLost++
          if (lostChatExamples.length < 5) lostChatExamples.push({ org: c.org, token, socket: s.id, user: s.person.user.email, role: s.person.user.role, phase: c.phase, closed: s.closed?.code ?? null, got: c.got.size })
        }
      }
      return {
        table: { writesTracked: [...writes.values()].filter((w) => w.got.size || true).length, expected: tableExpected, lost: tableLost, duplicates: tr.dupTable, nullTicks: tr.nullTicks, latency: summary(tr.tableLat), examples: lostTableExamples },
        chat: { sent: chats.size, expected: chatExpected, lost: chatLost, duplicates: tr.dupChat, senderOwnSocketsWithout: ownMissing, latency: summary(tr.chatLat), examples: lostChatExamples },
        resyncs: tr.resyncs, closes: Object.fromEntries(tr.closes),
      }
    },
  }
  return tr
}

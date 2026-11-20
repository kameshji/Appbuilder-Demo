import { describe, expect, it } from 'vitest'
import { chatLink } from '@/platform/chat-protocol'
import { MODULES, moduleByKey, moduleRoute, modeOfRoute } from '@/portal/modules'
import { PHONE_MAX_WIDTH, chatPlacement, isChatHash, parseChatLink } from './deeplink'

const ID = '0b5e5a1c-1d2e-4f30-9a4b-5c6d7e8f9a0b'

describe('chat deep links', () => {
  it('parses the notification link the server writes', () => {
    expect(parseChatLink(chatLink(ID, 42))).toEqual({ c: ID, m: 42 })
    expect(parseChatLink(`#chat?c=${ID.toUpperCase()}`)).toEqual({ c: ID, m: null })
    expect(parseChatLink('#chat')).toBeNull()
    expect(parseChatLink('#chat?c=not-an-id&m=1')).toBeNull()
    expect(parseChatLink(`#chat?c=${ID}&m=-3`)).toEqual({ c: ID, m: null })
    expect(parseChatLink(`#u-tasks?c=${ID}`)).toBeNull()
    expect(isChatHash('#chat')).toBe(true)
    expect(isChatHash(`#chat?c=${ID}`)).toBe(true)
    expect(isChatHash('#chatter')).toBe(false)
  })
  it('the pop-out and phones show chat in the whole window; a desktop main window keeps the shell for a link', () => {
    expect(chatPlacement({ popup: true, width: 1400, target: true })).toBe('window')
    expect(chatPlacement({ popup: false, width: 360, target: true })).toBe('window')
    expect(chatPlacement({ popup: false, width: PHONE_MAX_WIDTH, target: false })).toBe('window')
    expect(chatPlacement({ popup: false, width: 1280, target: true })).toBe('shell')
    expect(chatPlacement({ popup: false, width: 1280, target: false })).toBe('window')
  })
})

describe('the Chat module is live in the User menu', () => {
  it('opens chat (dock, or full screen on a phone) instead of a page, and keeps the menu\'s mode', () => {
    const m = moduleByKey('chat')!
    expect(m).toMatchObject({ status: 'live', action: 'chat', modes: ['user'] })
    expect(modeOfRoute(moduleRoute(m), 'user')).toBe('user')
    expect(MODULES.filter((x) => x.action === 'chat')).toHaveLength(1)
    expect(m.details.join(' ')).not.toMatch(/\bcontrols?\b/i)
  })
})

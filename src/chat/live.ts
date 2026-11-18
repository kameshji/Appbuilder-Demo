/**
 * The realtime connection handed to the chat module (package H). Chat stays free of platform imports: the shell
 * (Portal.tsx) injects platform.live once with setChatLive(); ChatPanel reads it with useChatLive() and the P3 chat
 * module subscribes to its topics (channels, typing, presence) through it. Only the type comes from the platform.
 */
import { create } from 'zustand'
import type { LiveApi } from '@/platform/live-api'

export const useChatLiveStore = create<{ live: LiveApi | null }>(() => ({ live: null }))

export function setChatLive(live: LiveApi | null): void {
  useChatLiveStore.setState({ live })
}

export const useChatLive = (): LiveApi | null => useChatLiveStore((s) => s.live)

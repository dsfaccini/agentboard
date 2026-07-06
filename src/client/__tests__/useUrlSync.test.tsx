import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { useSessionStore } from '../stores/sessionStore'
import { useUrlSync } from '../hooks/useUrlSync'

// useUrlSync reads/writes the global `window`; give it a mutable fake whose
// history methods actually update the URL, so the hook's readSessionParam()
// dedup guard sees post-navigation state like a real browser would.
const originalWindow = Reflect.get(globalThis, 'window')
const originalLocalStorage = Reflect.get(globalThis, 'localStorage')

function installWindow(initialUrl: string) {
  const url = new URL(initialUrl)
  const popstateListeners = new Set<() => void>()
  const pushCalls: string[] = []
  const replaceCalls: string[] = []
  const location = {
    href: url.href,
    search: url.search,
    protocol: url.protocol,
    host: url.host,
    port: url.port,
  }
  function sync() {
    location.href = url.href
    location.search = url.search
  }
  function navigate(next: string | URL) {
    url.href = new URL(next, url.href).href
    sync()
  }
  const win = {
    location,
    history: {
      pushState(_state: unknown, _title: string, next: string | URL) {
        navigate(next)
        pushCalls.push(url.href)
      },
      replaceState(_state: unknown, _title: string, next: string | URL) {
        navigate(next)
        replaceCalls.push(url.href)
      },
    },
    addEventListener(type: string, cb: () => void) {
      if (type === 'popstate') popstateListeners.add(cb)
    },
    removeEventListener(type: string, cb: () => void) {
      if (type === 'popstate') popstateListeners.delete(cb)
    },
  }
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true })
  function firePopstate(nextUrl: string) {
    navigate(nextUrl)
    for (const cb of popstateListeners) cb()
  }
  return { pushCalls, replaceCalls, firePopstate }
}

let renderer: TestRenderer.ReactTestRenderer | null = null
function renderHook() {
  function Harness() {
    useUrlSync()
    return null
  }
  act(() => {
    renderer = TestRenderer.create(createElement(Harness))
  })
}

describe('useUrlSync', () => {
  beforeEach(() => {
    const bag = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => bag.get(k) ?? null,
        setItem: (k: string, v: string) => bag.set(k, v),
        removeItem: (k: string) => bag.delete(k),
        clear: () => bag.clear(),
      },
      configurable: true,
      writable: true,
    })
    act(() => useSessionStore.getState().setSelectedSessionId(null))
  })

  afterEach(() => {
    if (renderer) act(() => renderer?.unmount())
    renderer = null
    Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true, writable: true })
  })

  test('a ?session= param on load wins over the persisted selection', () => {
    installWindow('http://localhost/?session=from-url')
    act(() => useSessionStore.getState().setSelectedSessionId('persisted'))
    renderHook()
    expect(useSessionStore.getState().selectedSessionId).toBe('from-url')
  })

  test('with no param, the persisted selection is reflected into the URL via replaceState (no history entry)', () => {
    const w = installWindow('http://localhost/')
    act(() => useSessionStore.getState().setSelectedSessionId('persisted'))
    renderHook()
    expect(useSessionStore.getState().selectedSessionId).toBe('persisted')
    expect(w.replaceCalls).toHaveLength(1)
    expect(w.replaceCalls[0]).toContain('session=persisted')
    expect(w.pushCalls).toHaveLength(0)
  })

  test('a genuine selection change pushes one history entry; a redundant set pushes none', () => {
    const w = installWindow('http://localhost/')
    renderHook()
    act(() => useSessionStore.getState().setSelectedSessionId('win-1'))
    expect(w.pushCalls).toHaveLength(1)
    expect(w.pushCalls[0]).toContain('session=win-1')

    act(() => useSessionStore.getState().setSelectedSessionId('win-1'))
    expect(w.pushCalls).toHaveLength(1) // unchanged selection: no-op

    act(() => useSessionStore.getState().setSelectedSessionId(null))
    expect(w.pushCalls).toHaveLength(2)
    expect(w.pushCalls[1]).not.toContain('session=')
  })

  test('back/forward (popstate) mirrors the URL into the store without pushing a duplicate entry', () => {
    const w = installWindow('http://localhost/?session=a')
    renderHook()
    expect(useSessionStore.getState().selectedSessionId).toBe('a')
    expect(w.pushCalls).toHaveLength(0) // URL already matched — mount must not push

    act(() => w.firePopstate('http://localhost/?session=b'))
    expect(useSessionStore.getState().selectedSessionId).toBe('b')
    expect(w.pushCalls).toHaveLength(0) // URL already showed b — no echo push
  })
})

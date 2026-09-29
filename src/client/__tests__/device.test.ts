import { describe, expect, test } from 'bun:test'
import {
  getNavShortcutMod,
  isIOSDevice,
  isIOSPWA,
  isMacOS,
  isMobileDevice,
  isSafari,
} from '../utils/device'

const globalAny = globalThis as typeof globalThis & {
  navigator?: any
}

describe('isMobileDevice', () => {
  const withNavigator = (nav: unknown, check: () => void) => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = nav
      check()
    } finally {
      globalAny.navigator = originalNavigator
    }
  }

  test('treats iOS and Android as mobile', () => {
    withNavigator(
      {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        platform: 'iPhone',
        maxTouchPoints: 5,
      },
      () => expect(isMobileDevice()).toBe(true)
    )
    withNavigator(
      {
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0 Mobile Safari/537.36',
        platform: 'Linux armv8l',
        maxTouchPoints: 5,
      },
      () => expect(isMobileDevice()).toBe(true)
    )
  })

  test('treats desktop browsers as not mobile', () => {
    withNavigator(
      {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0 Safari/537.36',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      },
      () => expect(isMobileDevice()).toBe(false)
    )
    withNavigator(undefined, () => expect(isMobileDevice()).toBe(false))
  })
})

describe('isIOSDevice', () => {
  test('returns false without navigator', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = undefined
      expect(isIOSDevice()).toBe(false)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('detects iPhone user agent', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        platform: 'iPhone',
        maxTouchPoints: 1,
      } as any
      expect(isIOSDevice()).toBe(true)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('detects iPadOS via MacIntel platform with touch', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      } as any
      expect(isIOSDevice()).toBe(true)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })
})

describe('device helpers', () => {
  test('detects iOS PWA mode', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        platform: 'iPhone',
        maxTouchPoints: 1,
        standalone: true,
      } as any
      expect(isIOSPWA()).toBe(true)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('detects Safari without Chrome', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      } as any
      expect(isSafari()).toBe(true)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('treats Chrome as non-Safari', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      } as any
      expect(isSafari()).toBe(false)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('detects macOS and returns shortcut modifiers', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
        platform: 'MacIntel',
        maxTouchPoints: 0,
      } as any
      expect(isMacOS()).toBe(true)
      const macShortcut = `${String.fromCharCode(0x2303)}${String.fromCharCode(0x2325)}`
      expect(getNavShortcutMod()).toBe(macShortcut)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })

  test('returns Windows/Linux shortcut modifiers on non-macOS', () => {
    const originalNavigator = globalAny.navigator
    try {
      globalAny.navigator = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        platform: 'Win32',
        maxTouchPoints: 0,
      } as any
      expect(isMacOS()).toBe(false)
      // ⌃⇧ (Control+Shift symbols)
      const nonMacShortcut = `${String.fromCharCode(0x2303)}${String.fromCharCode(0x21e7)}`
      expect(getNavShortcutMod()).toBe(nonMacShortcut)
    } finally {
      globalAny.navigator = originalNavigator
    }
  })
})

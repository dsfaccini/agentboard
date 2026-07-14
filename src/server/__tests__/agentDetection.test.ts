import { afterEach, describe, expect, test } from 'bun:test'
import {
  inferAgentType,
  resolveSessionCommand,
} from '../agentDetection'

const originalShell = process.env.SHELL

afterEach(() => {
  if (originalShell === undefined) {
    delete process.env.SHELL
  } else {
    process.env.SHELL = originalShell
  }
})

describe('resolveSessionCommand', () => {
  test('returns trimmed command when provided', () => {
    expect(resolveSessionCommand('  grok --cwd .  ')).toBe('grok --cwd .')
  })

  test('falls back to SHELL when command is empty', () => {
    process.env.SHELL = '/bin/zsh'
    expect(resolveSessionCommand(undefined)).toBe('/bin/zsh')
    expect(resolveSessionCommand('')).toBe('/bin/zsh')
    expect(resolveSessionCommand('   ')).toBe('/bin/zsh')
  })

  test('falls back to /bin/sh when SHELL is unset', () => {
    delete process.env.SHELL
    expect(resolveSessionCommand(undefined)).toBe('/bin/sh')
  })
})

describe('inferAgentType', () => {
  test('detects known agents including grok', () => {
    expect(inferAgentType('claude')).toBe('claude')
    expect(inferAgentType('codex --yolo')).toBe('codex')
    expect(inferAgentType('pi')).toBe('pi')
    expect(inferAgentType('grok')).toBe('grok')
    expect(inferAgentType('/Users/me/.grok/bin/grok')).toBe('grok')
    expect(inferAgentType('bunx grok --debug')).toBe('grok')
  })

  test('returns undefined for plain shells', () => {
    expect(inferAgentType('/bin/zsh')).toBeUndefined()
    expect(inferAgentType('bash -li')).toBeUndefined()
  })
})

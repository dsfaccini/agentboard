import { describe, expect, test } from 'bun:test'
import { isLeakedLaunchEnvVar, sanitizedTmuxEnv } from '../tmuxEnv'

describe('isLeakedLaunchEnvVar', () => {
  test('flags the launch-chain vars', () => {
    expect(isLeakedLaunchEnvVar('NODE_ENV')).toBe(true)
    expect(isLeakedLaunchEnvVar('AGENTBOARD_STATIC_DIR')).toBe(true)
    expect(isLeakedLaunchEnvVar('npm_config_cache')).toBe(true)
    expect(isLeakedLaunchEnvVar('npm_lifecycle_script')).toBe(true)
    expect(isLeakedLaunchEnvVar('npm_execpath')).toBe(true)
  })

  test('leaves ordinary env vars alone', () => {
    expect(isLeakedLaunchEnvVar('PATH')).toBe(false)
    expect(isLeakedLaunchEnvVar('HOME')).toBe(false)
    expect(isLeakedLaunchEnvVar('SSH_AUTH_SOCK')).toBe(false)
    expect(isLeakedLaunchEnvVar('TERM')).toBe(false)
    // Other AGENTBOARD_* config vars are deliberately not stripped.
    expect(isLeakedLaunchEnvVar('AGENTBOARD_DB_PATH')).toBe(false)
    expect(isLeakedLaunchEnvVar('NODE_OPTIONS')).toBe(false)
    expect(isLeakedLaunchEnvVar('NPM_TOKEN')).toBe(false)
  })
})

describe('sanitizedTmuxEnv', () => {
  test('strips leaked vars and keeps the rest', () => {
    const env = sanitizedTmuxEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NODE_ENV: 'production',
      AGENTBOARD_STATIC_DIR: '/npx/dist/client',
      npm_config_cache: '/Users/x/.npm',
      npm_execpath: '/opt/npm-cli.js',
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
    })
  })

  test('drops undefined values', () => {
    expect(sanitizedTmuxEnv({ FOO: undefined, BAR: 'x' })).toEqual({ BAR: 'x' })
  })

  test('defaults to process.env', () => {
    const env = sanitizedTmuxEnv()
    expect(env.NODE_ENV).toBeUndefined()
    expect(env.AGENTBOARD_STATIC_DIR).toBeUndefined()
    expect(Object.keys(env).some((k) => k.startsWith('npm_'))).toBe(false)
  })
})

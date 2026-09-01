import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { VisionRelayDirectoryGrantRegistry } from './vision-relay-directory-grants'

const root = mkdtempSync(join(tmpdir(), 'domi-vision-directory-grant-'))
const selected = join(root, 'selected')
const unselected = join(root, 'unselected')

beforeAll(() => {
  mkdirSync(selected, { recursive: true })
  mkdirSync(unselected, { recursive: true })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('Vision Relay native picker directory grants', () => {
  test('only a main-process registered picker result can be consumed, once', () => {
    const registry = new VisionRelayDirectoryGrantRegistry()
    registry.register('session-a', [selected])
    expect(registry.consume('session-a', unselected)).toBeUndefined()
    expect(registry.consume('session-b', selected)).toBeUndefined()
    expect(registry.consume('session-a', selected)).toBeTruthy()
    expect(registry.consume('session-a', selected)).toBeUndefined()
  })

  test('expired picker results fail closed', () => {
    let now = 100
    const registry = new VisionRelayDirectoryGrantRegistry(10, () => now)
    registry.register('session-a', [selected])
    now = 111
    expect(registry.consume('session-a', selected)).toBeUndefined()
  })
})

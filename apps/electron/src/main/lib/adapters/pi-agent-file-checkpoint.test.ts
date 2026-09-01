import { describe, expect, test } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { wrapPiFileMutationToolDefinitions } from './pi-agent-adapter.ts'

function tool(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} } as ToolDefinition['parameters'],
    execute,
  }
}

describe('Pi controlled file checkpoint wrapper', () => {
  test('Given write and edit definitions When they execute successfully Then captures before disk mutation and records the resulting state', async () => {
    const events: string[] = []
    const definitions = wrapPiFileMutationToolDefinitions([
      tool('read', async () => {
        events.push('read:execute')
        return { content: [], details: undefined }
      }),
      tool('write', async (_id, params) => {
        events.push(`write:execute:${(params as { path: string }).path}`)
        return { content: [], details: undefined }
      }),
      tool('edit', async (_id, params) => {
        events.push(`edit:execute:${(params as { path: string }).path}`)
        return { content: [], details: undefined }
      }),
    ], {
      beforeMutation: async (path) => { events.push(`before:${path}`) },
      afterMutation: async (path) => { events.push(`after:${path}`) },
    })

    await definitions[0]!.execute('read-1', { path: 'a.ts' }, undefined, undefined, undefined as never)
    await definitions[1]!.execute('write-1', { path: 'a.ts', content: 'x' }, undefined, undefined, undefined as never)
    await definitions[2]!.execute('edit-1', { path: 'b.ts', edits: [] }, undefined, undefined, undefined as never)

    expect(events).toEqual([
      'read:execute',
      'before:a.ts',
      'write:execute:a.ts',
      'after:a.ts',
      'before:b.ts',
      'edit:execute:b.ts',
      'after:b.ts',
    ])
  })

  test('Given a controlled mutation tool throws after possible disk work When wrapped Then preserves the error and records the actual post-attempt state', async () => {
    const events: string[] = []
    const [definition] = wrapPiFileMutationToolDefinitions([
      tool('write', async () => {
        events.push('execute')
        throw new Error('disk failed')
      }),
    ], {
      beforeMutation: async (path) => { events.push(`before:${path}`) },
      afterMutation: async (path) => { events.push(`after:${path}`) },
    })

    await expect(definition!.execute(
      'write-1',
      { path: 'a.ts', content: 'x' },
      undefined,
      undefined,
      undefined as never,
    )).rejects.toThrow('disk failed')
    expect(events).toEqual(['before:a.ts', 'execute', 'after:a.ts'])
  })

  test('Given checkpoint capture itself fails When a controlled tool runs Then the file operation remains usable and post-write recording is skipped', async () => {
    const events: string[] = []
    const [definition] = wrapPiFileMutationToolDefinitions([
      tool('write', async () => {
        events.push('execute')
        return { content: [], details: undefined }
      }),
    ], {
      beforeMutation: async () => { throw new Error('checkpoint unavailable') },
      afterMutation: async () => { events.push('after') },
      onError: (phase, path) => { events.push(`${phase}:${path}`) },
    })

    await definition!.execute('write-1', { path: 'a.ts', content: 'x' }, undefined, undefined, undefined as never)

    expect(events).toEqual(['before:a.ts', 'execute'])
  })
})

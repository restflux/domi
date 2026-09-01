import { describe, expect, test } from 'bun:test'
import {
  buildQueuedAgentAsideContext,
  normalizeAgentNextTurnAsides,
} from './agent-next-turn-aside'

describe('Agent next-turn asides', () => {
  test('normalizes content and removes invalid or duplicate ids', () => {
    expect(normalizeAgentNextTurnAsides([
      { id: ' a ', content: ' first ' },
      { id: 'a', content: 'duplicate' },
      { id: '', content: 'missing id' },
      { id: 'b', content: '   ' },
      { id: 'c', content: 'third' },
    ])).toEqual([
      { id: 'a', content: 'first' },
      { id: 'c', content: 'third' },
    ])
  })

  test('ignores malformed values from the IPC boundary', () => {
    expect(normalizeAgentNextTurnAsides('not-an-array')).toEqual([])
    expect(normalizeAgentNextTurnAsides([
      null,
      { id: 1, content: 'bad id' },
      { id: 'bad-content', content: null },
      { id: 'ok', content: 'valid' },
    ])).toEqual([{ id: 'ok', content: 'valid' }])
  })

  test('builds escaped context for active steer/followUp delivery', () => {
    const context = buildQueuedAgentAsideContext([
      { id: 'log<1>', content: 'A < B && C > D' },
    ])
    expect(context).toContain('id="log&lt;1&gt;"')
    expect(context).toContain('A &lt; B &amp;&amp; C &gt; D')
    expect(context).toContain('不是额外任务')
  })

  test('returns empty context when there is no valid aside', () => {
    expect(buildQueuedAgentAsideContext(undefined)).toBe('')
    expect(buildQueuedAgentAsideContext([{ id: 'x', content: ' ' }])).toBe('')
  })
})

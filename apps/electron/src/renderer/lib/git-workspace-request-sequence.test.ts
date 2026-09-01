import { describe, expect, test } from 'bun:test'
import { GitWorkspaceRequestSequence } from './git-workspace-request-sequence.ts'

describe('GitWorkspaceRequestSequence', () => {
  test('accepts only the latest refresh generation', () => {
    const sequence = new GitWorkspaceRequestSequence()
    const first = sequence.next()
    const second = sequence.next()

    expect(sequence.isCurrent(first)).toBeFalse()
    expect(sequence.isCurrent(second)).toBeTrue()
    sequence.invalidate()
    expect(sequence.isCurrent(second)).toBeFalse()
  })
})

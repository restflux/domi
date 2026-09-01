import { describe, expect, test } from 'bun:test'
import {
  orderSessionTreesForProject,
  selectStableProjectSessionPreview,
  type AgentSessionTreeOrderItem,
} from './agent-session-project-order.ts'

function tree(
  id: string,
  updatedAt: number,
  marker: 'none' | 'flag' | 'star' = 'none',
): AgentSessionTreeOrderItem {
  return {
    session: {
      id,
      updatedAt,
      needsFollowUp: marker === 'flag',
      starred: marker === 'star',
    },
    childSessions: [],
  }
}

describe('Agent project session ordering', () => {
  test('keeps the existing order in recent mode when markers change', () => {
    const original = [tree('recent', 30), tree('older', 20), tree('oldest', 10)]
    const marked = [tree('recent', 30), tree('older', 20, 'flag'), tree('oldest', 10, 'star')]

    expect(orderSessionTreesForProject(original, 'recent').map((item) => item.session.id)).toEqual([
      'recent', 'older', 'oldest',
    ])
    expect(orderSessionTreesForProject(marked, 'recent').map((item) => item.session.id)).toEqual([
      'recent', 'older', 'oldest',
    ])
  })

  test('only applies Flag then Star priority after the project explicitly enables it', () => {
    const items = [tree('recent', 30), tree('star', 10, 'star'), tree('flag', 20, 'flag')]

    expect(orderSessionTreesForProject(items, 'markers').map((item) => item.session.id)).toEqual([
      'flag', 'star', 'recent',
    ])
  })

  test('keeps old marked sessions visible without moving them out of freshness order', () => {
    const items = [
      tree('recent-a', 30),
      tree('recent-b', 20),
      tree('old-flag', 5, 'flag'),
      tree('old-hidden', 4),
    ]

    expect(selectStableProjectSessionPreview(items, 10, 1).map((item) => item.session.id)).toEqual([
      'recent-a', 'old-flag',
    ])
  })

  test('inherits manual markers from delegated children', () => {
    const parent = tree('parent', 5)
    parent.childSessions = [{ needsFollowUp: true, starred: false }]

    expect(selectStableProjectSessionPreview([tree('recent', 30), parent], 10, 1).map((item) => item.session.id)).toEqual([
      'recent', 'parent',
    ])
    expect(orderSessionTreesForProject([tree('recent', 30), parent], 'markers').map((item) => item.session.id)).toEqual([
      'parent', 'recent',
    ])
  })
})

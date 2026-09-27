import { expect, test } from 'bun:test'
import { parseViewportDimensionDraft } from './browserViewportDraft.ts'

test('Given an unfinished or out-of-range viewport draft When committing Then preserve it for correction instead of resizing the Main-owned browser', () => {
  expect(parseViewportDimensionDraft('', 'width')).toBeNull()
  expect(parseViewportDimensionDraft('39', 'width')).toBeNull()
  expect(parseViewportDimensionDraft('390.5', 'width')).toBeNull()
  expect(parseViewportDimensionDraft('9999', 'width')).toBeNull()
  expect(parseViewportDimensionDraft('400px', 'width')).toBeNull()
  expect(parseViewportDimensionDraft('390', 'width')).toBe(390)
  expect(parseViewportDimensionDraft('844', 'height')).toBe(844)
  expect(parseViewportDimensionDraft('319', 'height')).toBeNull()
})

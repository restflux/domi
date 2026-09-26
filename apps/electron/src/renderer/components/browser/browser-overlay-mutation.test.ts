import { expect, test } from 'bun:test'
import { hasBrowserOverlayMutation } from './browser-overlay-mutation.ts'

const overlay = (matches = false, descendant = false, noisy = false): Element => ({
  nodeType: 1,
  matches: () => matches,
  querySelector: () => descendant ? overlay() : null,
  closest: () => noisy ? overlay() : null,
}) as unknown as Element

const record = (type: 'attributes' | 'childList', target: Element, addedNodes: Node[] = [], removedNodes: Node[] = []): MutationRecord => ({
  type, target, addedNodes, removedNodes,
}) as unknown as MutationRecord

test('Given terminal output and chat text mutate the document When the browser is visible Then no overlay recheck is scheduled', () => {
  expect(hasBrowserOverlayMutation([
    record('childList', overlay(false, false, true), [overlay()]),
    record('attributes', overlay(false, false, true)),
  ])).toBe(false)
})

test('Given a new portal is inserted before its role attributes exist When opening a menu Then the native view is conservatively rechecked', () => {
  expect(hasBrowserOverlayMutation([record('childList', overlay(), [overlay()])])).toBe(true)
})

test('Given a menu or dialog mounts or unmounts When its view crosses the native browser Then the overlay is rechecked', () => {
  expect(hasBrowserOverlayMutation([record('childList', overlay(), [overlay(true)])])).toBe(true)
  expect(hasBrowserOverlayMutation([record('childList', overlay(), [], [overlay(false, true)])])).toBe(true)
})

test('Given the overlay state changes When it becomes visible or hidden Then the native view is rechecked', () => {
  expect(hasBrowserOverlayMutation([record('attributes', overlay(true))])).toBe(true)
  expect(hasBrowserOverlayMutation([record('attributes', overlay(false, true))])).toBe(true)
})

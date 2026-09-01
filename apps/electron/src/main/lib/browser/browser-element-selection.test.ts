import { describe, expect, test } from 'bun:test'
import {
  BROWSER_ELEMENT_SELECTION_SCRIPT,
  buildBrowserElementSelectionCancelScript,
  normalizeBrowserElementSelectionCandidate,
} from './browser-element-selection.ts'

describe('网页元素选择安全裁剪', () => {
  test('Given a visible element When normalizing the isolated-world result Then only bounded semantic fields remain', () => {
    const result = normalizeBrowserElementSelectionCandidate({
      status: 'selected',
      element: {
        tagName: 'A',
        role: 'link',
        name: 'Domi docs',
        text: 'Read Domi documentation',
        href: 'https://example.com/docs',
      },
    })

    expect(result).toEqual({
      status: 'selected',
      element: {
        tagName: 'a',
        role: 'link',
        name: 'Domi docs',
        text: 'Read Domi documentation',
        href: 'https://example.com/docs',
        truncated: false,
      },
    })
  })

  test('Given a form control or password When normalizing Then no entered value or visible text can escape', () => {
    const input = normalizeBrowserElementSelectionCandidate({
      status: 'selected',
      element: {
        tagName: 'INPUT',
        inputType: 'password',
        role: 'textbox',
        name: 'Password',
        text: 'secret-from-page',
        value: 'secret-from-value',
      },
    })
    const textarea = normalizeBrowserElementSelectionCandidate({
      status: 'selected',
      element: {
        tagName: 'textarea',
        name: 'Notes',
        text: 'private draft',
        value: 'private draft',
      },
    })

    expect(input).toEqual({
      status: 'selected',
      element: {
        tagName: 'input',
        role: 'textbox',
        name: 'Password',
        text: '',
        truncated: false,
      },
    })
    expect(textarea).toEqual({
      status: 'selected',
      element: {
        tagName: 'textarea',
        name: 'Notes',
        text: '',
        truncated: false,
      },
    })
    expect(JSON.stringify(input)).not.toContain('secret')
    expect(JSON.stringify(textarea)).not.toContain('private draft')
  })

  test('Given oversized or unsafe page data When normalizing Then text is truncated and unsafe URLs are omitted', () => {
    const result = normalizeBrowserElementSelectionCandidate({
      status: 'selected',
      element: {
        tagName: 'DIV',
        role: 'x'.repeat(500),
        name: 'n'.repeat(1000),
        text: 't'.repeat(5000),
        href: 'https://user:password@example.com/private',
      },
    })

    expect(result.status).toBe('selected')
    if (result.status !== 'selected') throw new Error('expected selected result')
    expect(result.element.role?.length).toBe(100)
    expect(result.element.name?.length).toBe(300)
    expect(result.element.text.length).toBe(2000)
    expect(result.element.truncated).toBe(true)
    expect(result.element.href).toBeUndefined()
  })

  test('Given selection cancellation When normalizing Then only the bounded reason is accepted', () => {
    expect(normalizeBrowserElementSelectionCandidate({ status: 'cancelled', reason: 'navigation' })).toEqual({
      status: 'cancelled',
      reason: 'navigation',
    })
    expect(() => normalizeBrowserElementSelectionCandidate({ status: 'cancelled', reason: 'page-controlled' })).toThrow()
  })
})

describe('网页元素选择固定脚本', () => {
  test('Given the packaged selector When inspecting its contract Then it contains no caller script or selector parameter', () => {
    expect(BROWSER_ELEMENT_SELECTION_SCRIPT).toContain('data-domi-browser-element-selection')
    expect(BROWSER_ELEMENT_SELECTION_SCRIPT).toContain('stopImmediatePropagation')
    expect(BROWSER_ELEMENT_SELECTION_SCRIPT).not.toContain('querySelector')
    expect(BROWSER_ELEMENT_SELECTION_SCRIPT).not.toContain('outerHTML')
    expect(BROWSER_ELEMENT_SELECTION_SCRIPT).not.toContain('.value')
  })

  test('Given a supported cancellation reason When building cleanup code Then only the fixed reason is embedded', () => {
    expect(buildBrowserElementSelectionCancelScript('control')).toContain('"control"')
    expect(() => buildBrowserElementSelectionCancelScript('arbitrary' as 'control')).toThrow()
  })
})

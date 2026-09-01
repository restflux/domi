import { describe, expect, test } from 'bun:test'
import { buildBrowserSemanticSnapshot } from './browser-observation-policy.ts'

describe('Browser Snapshot 观察策略', () => {
  test('Given form controls with values When building a semantic snapshot Then values are never exposed and hidden nodes are omitted', () => {
    let nextRef = 0
    const snapshot = buildBrowserSemanticSnapshot({
      nodes: [
        {
          nodeId: 'root',
          role: { value: 'RootWebArea' },
          name: { value: '账户页面' },
          backendDOMNodeId: 1,
          childIds: ['email', 'password', 'hidden', 'button'],
        },
        {
          nodeId: 'email',
          parentId: 'root',
          role: { value: 'textbox' },
          name: { value: '邮箱' },
          value: { value: 'secret@example.com' },
          dom: { nodeName: 'INPUT', attributes: ['type', 'email', 'placeholder', '请输入邮箱'] },
          backendDOMNodeId: 2,
        },
        {
          nodeId: 'password',
          parentId: 'root',
          role: { value: 'textbox' },
          name: { value: '密码' },
          value: { value: 'hunter2' },
          dom: { nodeName: 'INPUT', attributes: ['type', 'password'] },
          backendDOMNodeId: 3,
        },
        {
          nodeId: 'email-value',
          parentId: 'email',
          role: { value: 'StaticText' },
          name: { value: 'secret@example.com' },
          backendDOMNodeId: 6,
        },
        {
          nodeId: 'password-value',
          parentId: 'password',
          role: { value: 'StaticText' },
          name: { value: 'hunter2' },
          backendDOMNodeId: 7,
        },
        {
          nodeId: 'hidden',
          parentId: 'root',
          role: { value: 'StaticText' },
          name: { value: '不应出现' },
          properties: [{ name: 'hidden', value: { value: true } }],
          backendDOMNodeId: 4,
        },
        {
          nodeId: 'button',
          parentId: 'root',
          role: { value: 'button' },
          name: { value: '登录' },
          backendDOMNodeId: 5,
        },
      ],
      allocateRef: () => `e${++nextRef}`,
    })

    expect(snapshot.rootBackendDOMNodeId).toBe(1)
    expect(snapshot.nodes).toEqual([
      { ref: 'e1', role: 'textbox', name: '邮箱', placeholder: '请输入邮箱', empty: false, depth: 1 },
      { ref: 'e2', role: 'textbox', name: '密码', password: true, empty: false, depth: 1 },
      { ref: 'e3', role: 'button', name: '登录', depth: 1 },
    ])
    expect(JSON.stringify(snapshot)).not.toContain('secret@example.com')
    expect(JSON.stringify(snapshot)).not.toContain('hunter2')
    expect(JSON.stringify(snapshot)).not.toContain('不应出现')
  })

  test('Given explicit false selection and expansion states When observing Then their state is preserved', () => {
    const snapshot = buildBrowserSemanticSnapshot({
      nodes: [
        { nodeId: 'root', role: { value: 'RootWebArea' }, backendDOMNodeId: 1 },
        {
          nodeId: 'option',
          parentId: 'root',
          role: { value: 'option' },
          name: { value: '中国' },
          properties: [{ name: 'selected', value: { value: false } }],
          backendDOMNodeId: 2,
        },
        {
          nodeId: 'disclosure',
          parentId: 'root',
          role: { value: 'button' },
          name: { value: '高级选项' },
          properties: [{ name: 'expanded', value: { value: false } }],
          backendDOMNodeId: 3,
        },
      ],
      allocateRef: (backendDOMNodeId) => `e${backendDOMNodeId}`,
    })

    expect(snapshot.nodes).toEqual([
      { ref: 'e2', role: 'option', name: '中国', selected: false, depth: 1 },
      { ref: 'e3', role: 'button', name: '高级选项', expanded: false, depth: 1 },
    ])
  })

  test('Given an unlabeled input whose accessible name mirrors its value When observing Then the value is not mistaken for a label', () => {
    const snapshot = buildBrowserSemanticSnapshot({
      nodes: [
        { nodeId: 'root', role: { value: 'RootWebArea' }, backendDOMNodeId: 1 },
        {
          nodeId: 'token',
          parentId: 'root',
          role: { value: 'textbox' },
          name: { value: 'private-token-value' },
          value: { value: 'private-token-value' },
          backendDOMNodeId: 2,
        },
      ],
      allocateRef: () => 'e1',
    })

    expect(snapshot.nodes).toEqual([{ ref: 'e1', role: 'textbox', empty: false, depth: 1 }])
    expect(JSON.stringify(snapshot)).not.toContain('private-token-value')
  })

  test('Given an oversized accessibility tree When building a snapshot Then node and UTF-8 text limits fail closed', () => {
    const snapshot = buildBrowserSemanticSnapshot({
      nodes: [
        { nodeId: 'root', role: { value: 'RootWebArea' }, backendDOMNodeId: 1 },
        { nodeId: 'first', parentId: 'root', role: { value: 'button' }, name: { value: '第一个按钮' }, backendDOMNodeId: 2 },
        { nodeId: 'second', parentId: 'root', role: { value: 'button' }, name: { value: '第二个按钮' }, backendDOMNodeId: 3 },
        { nodeId: 'third', parentId: 'root', role: { value: 'button' }, name: { value: '第三个按钮' }, backendDOMNodeId: 4 },
      ],
      allocateRef: (backendDOMNodeId) => `e${backendDOMNodeId}`,
      maxNodes: 2,
      maxTextBytes: 26,
    })

    expect(snapshot.nodes).toHaveLength(2)
    expect(snapshot.textBytes).toBeLessThanOrEqual(26)
    expect(snapshot.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(snapshot.nodes), 'utf8')).toBeGreaterThan(snapshot.textBytes)
  })
})

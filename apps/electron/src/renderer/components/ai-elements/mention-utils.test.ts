import { describe, expect, test } from 'bun:test'
import {
  isMentionTriggerInsideUrl,
  resolveMentionSuggestionChar,
  shouldAllowMentionTrigger,
  shouldShowMentionSuggestion,
} from './mention-utils'

describe('Mention 协议字符兼容', () => {
  test('Given 旧草稿含非 slash chip When 仅注册 slash suggestion Then 保留节点自身字符', () => {
    expect(resolveMentionSuggestionChar('@', '/')).toBe('@')
    expect(resolveMentionSuggestionChar('#', '/')).toBe('#')
    expect(resolveMentionSuggestionChar('&', '/')).toBe('&')
  })

  test('Given 节点缺少字符 When 渲染 mention Then 使用 suggestion 或默认文件字符', () => {
    expect(resolveMentionSuggestionChar(undefined, '/')).toBe('/')
    expect(resolveMentionSuggestionChar(undefined)).toBe('@')
  })
})

function triggerOffset(text: string, trigger: string, occurrence = 0): number {
  let offset = -1
  for (let index = 0; index <= occurrence; index += 1) {
    offset = text.indexOf(trigger, offset + 1)
  }
  if (offset === -1) throw new Error(`测试文本中不存在第 ${occurrence + 1} 个触发符 ${trigger}: ${text}`)
  return offset
}

function allows(text: string, trigger: string, occurrence = 0, isCodeContext = false): boolean {
  return shouldAllowMentionTrigger({
    paragraphText: text,
    triggerOffset: triggerOffset(text, trigger, occurrence),
    trigger,
    isCodeContext,
  })
}

describe('Mention URL 识别', () => {
  test.each([
    ['https://example.com/path#section', '/', 0],
    ['https://example.com/path#section', '#', 0],
    ['ssh://git@example.com/owner/repo.git', '@', 0],
    ['ssh://git@example.com/owner/repo.git', '/', 2],
    ['https://example.com/image.png?size=1&download=1', '&', 0],
    ['git@github.com:owner/repo.git', '@', 0],
  ] as const)('Given URL %s When 检查 %s Then 识别为 URL 内触发符', (text, trigger, occurrence) => {
    const offset = triggerOffset(text, trigger, occurrence)
    expect(isMentionTriggerInsideUrl(text, offset)).toBe(true)
    expect(allows(text, trigger, occurrence)).toBe(false)
  })

  test('Given 普通中文后快捷引用 When 检查触发符 Then 不误判为 URL', () => {
    const text = '请看@README'
    expect(isMentionTriggerInsideUrl(text, triggerOffset(text, '@'))).toBe(false)
  })
})

describe('Mention 触发字符策略', () => {
  test.each([
    ['name@example.com', '@'],
    ['安装 @scope/package', '@'],
  ] as const)('Given 邮箱或 npm scope %s When 输入 @ Then 不触发文件菜单', (text, trigger) => {
    expect(allows(text, trigger)).toBe(false)
  })

  test.each([
    ['@README', '@'],
    ['请看@文件', '@'],
  ] as const)('Given 合法文件查询 %s When 输入 @ Then 允许触发', (text, trigger) => {
    expect(allows(text, trigger)).toBe(true)
  })

  test.each([
    ['C:/repo/src/file.ts', '/', 0],
    ['../src/file.ts', '/', 0],
    ['./src/file.ts', '/', 0],
    ['~/src/file.ts', '/', 0],
    ['/usr/bin/env', '/', 0],
    ['//server/share/file.txt', '/', 0],
    ['src/components/Button.tsx', '/', 0],
  ] as const)('Given 文件路径 %s When 输入 / Then 不触发 Skill 菜单', (text, trigger, occurrence) => {
    expect(allows(text, trigger, occurrence)).toBe(false)
  })

  test.each([
    ['C:\\repo\\@draft.png', '@'],
    ['C:\\repo\\#draft.md', '#'],
    ['src/components/#draft.ts', '#'],
    ['/home/user/&notes.txt', '&'],
  ] as const)('Given 路径包含其他触发符 %s When 输入 %s Then 仍不弹引用菜单', (text, trigger) => {
    expect(allows(text, trigger)).toBe(false)
  })

  test.each([
    ['/research', '/'],
    ['请用/research', '/'],
  ] as const)('Given 合法 Skill 查询 %s When 输入 / Then 允许触发', (text, trigger) => {
    expect(allows(text, trigger)).toBe(true)
  })

  test.each([
    ['# heading', '#'],
    ['修复 #123', '#'],
    ['颜色 #fff', '#'],
    ['颜色 #11223344', '#'],
  ] as const)('Given Markdown、Issue 或颜色 %s When 输入 # Then 不触发 MCP 菜单', (text, trigger) => {
    expect(allows(text, trigger)).toBe(false)
  })

  test.each([
    ['#github', '#'],
    ['请用#mcp-server', '#'],
  ] as const)('Given 合法 MCP 查询 %s When 输入 # Then 允许触发', (text, trigger) => {
    expect(allows(text, trigger)).toBe(true)
  })

  test.each([
    ['command && next', '&', 0],
    ['command && next', '&', 1],
    ['HTML &amp;', '&', 0],
    ['HTML &#123;', '&', 0],
    ['HTML &#x1f;', '&', 0],
  ] as const)('Given 运算符或 HTML entity %s When 输入 & Then 不触发会话菜单', (text, trigger, occurrence) => {
    expect(allows(text, trigger, occurrence)).toBe(false)
  })

  test('Given 合法会话查询 When 输入 & Then 允许触发', () => {
    expect(allows('&session-name', '&')).toBe(true)
  })

  test.each([
    ['~/Documents', '~'],
    ['～/Documents', '～'],
    ['~\\Documents', '~'],
  ] as const)('Given home 路径 %s When 输入波浪号 Then 不触发 Planning 菜单', (text, trigger) => {
    expect(allows(text, trigger)).toBe(false)
  })

  test.each([
    ['~todo', '~'],
    ['～日程', '～'],
  ] as const)('Given 合法 Planning 查询 %s When 输入波浪号 Then 允许触发', (text, trigger) => {
    expect(allows(text, trigger)).toBe(true)
  })

  test('Given code block 或 inline code When 输入触发符 Then 一律不弹菜单', () => {
    expect(allows('@README', '@', 0, true)).toBe(false)
    expect(allows('/research', '/', 0, true)).toBe(false)
  })
})

describe('Mention 输入事件策略', () => {
  test.each(['paste', 'drop'])('Given %s 事务 When 插入普通文本 Then 不弹 Mention 菜单', (uiEvent) => {
    expect(shouldShowMentionSuggestion(uiEvent)).toBe(false)
  })

  test.each([undefined, 'input', 'composition'])('Given 键盘或 IME 输入 %s When 输入快捷字符 Then 保持可触发', (uiEvent) => {
    expect(shouldShowMentionSuggestion(uiEvent)).toBe(true)
  })
})

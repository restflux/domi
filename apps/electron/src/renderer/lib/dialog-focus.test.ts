import { describe, expect, mock, test } from 'bun:test'
import { handleOptionalDialogCloseAutoFocus } from './dialog-focus'

describe('可选 Dialog 关闭焦点恢复', () => {
  test('Given Agent 传入恢复回调 When Dialog 完成关闭 Then 阻止默认回焦并聚焦输入框', () => {
    const preventDefault = mock(() => {})
    const restoreFocus = mock(() => {})

    handleOptionalDialogCloseAutoFocus({ preventDefault }, restoreFocus)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(restoreFocus).toHaveBeenCalledTimes(1)
  })

  test('Given 普通复用场景未传回调 When Dialog 完成关闭 Then 保留 Radix 默认焦点行为', () => {
    const preventDefault = mock(() => {})

    handleOptionalDialogCloseAutoFocus({ preventDefault })

    expect(preventDefault).not.toHaveBeenCalled()
  })
})

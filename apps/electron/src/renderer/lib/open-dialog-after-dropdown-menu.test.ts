import { describe, expect, test } from 'bun:test'
import { openDialogAfterDropdownMenu } from './open-dialog-after-dropdown-menu.ts'

describe('openDialogAfterDropdownMenu', () => {
  test('菜单选择阶段只安排打开，菜单关闭调度完成后才真正打开 Dialog', () => {
    let scheduled: (() => void) | undefined
    let opened = false

    openDialogAfterDropdownMenu(
      () => { opened = true },
      (callback) => { scheduled = callback },
    )

    expect(opened).toBe(false)
    expect(scheduled).toBeDefined()
    scheduled?.()
    expect(opened).toBe(true)
  })
})

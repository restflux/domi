import { describe, expect, test } from 'bun:test'
import { getComposerAttachmentDialogOptions } from './attachment-dialog-options'

describe('Composer attachment dialog options', () => {
  test('opens a multi-select file picker for file attachments', () => {
    expect(getComposerAttachmentDialogOptions('file')).toEqual({
      properties: ['openFile', 'multiSelections'],
      filters: expect.any(Array),
      title: '附加文件',
    })
  })

  test('opens a multi-select directory picker for folder attachments', () => {
    expect(getComposerAttachmentDialogOptions('directory')).toEqual({
      properties: ['openDirectory', 'multiSelections'],
      title: '附加文件夹',
    })
  })

  test('rejects unsupported picker kinds at the IPC boundary', () => {
    expect(() => getComposerAttachmentDialogOptions('mixed' as never)).toThrow('不支持的附件选择类型')
  })
})

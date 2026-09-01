import type { OpenDialogOptions } from 'electron'
import type { ComposerAttachmentKind } from '@domi/shared'

/** 文件选择对话框支持的过滤器。 */
export const FILE_FILTERS: NonNullable<OpenDialogOptions['filters']> = [
  {
    name: '支持的文件',
    extensions: [
      'png', 'jpg', 'jpeg', 'gif', 'webp',
      'pdf', 'txt', 'md', 'json', 'csv', 'xml', 'html',
      'doc', 'dot', 'docx', 'docm', 'dotx', 'dotm', 'wps', 'wpt', 'rtf',
      'xls', 'xlt', 'xlsx', 'xlsm', 'xltx', 'xltm', 'et', 'ett',
      'ppt', 'pot', 'pps', 'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'dps', 'dpt',
      'odt', 'odp', 'ods',
    ],
  },
  {
    name: '所有文件',
    extensions: ['*'],
  },
]

/** 根据 Composer 菜单中选择的内容类型构造原生选择器。 */
export function getComposerAttachmentDialogOptions(kind: ComposerAttachmentKind): OpenDialogOptions {
  if (kind === 'file') {
    return { properties: ['openFile', 'multiSelections'], filters: FILE_FILTERS, title: '附加文件' }
  }
  if (kind === 'directory') {
    return { properties: ['openDirectory', 'multiSelections'], title: '附加文件夹' }
  }
  throw new Error('不支持的附件选择类型')
}

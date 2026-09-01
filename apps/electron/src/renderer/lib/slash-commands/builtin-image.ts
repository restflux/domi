import { registerSlashCommand } from './registry'

/** 注册 Domi 生图快捷命令；选择后只填入输入框，发送仍由用户确认。 */
export function registerBuiltinImageSlashCommand(): void {
  registerSlashCommand({
    id: 'image',
    aliases: ['img', 'draw'],
    label: '生成图片',
    description: '输入描述后调用当前可用的生图工具生成图片',
    group: 'domi',
    behavior: 'insert',
    insertText: '/image ',
  })
}

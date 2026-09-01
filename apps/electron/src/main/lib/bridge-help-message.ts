const HELP_SECTIONS = [
  '【任务】/now 当前状态 · /stop (/s) 停止任务',
  '【会话】/new (/n) [标题] 新建 · /list (/ls) 查看列表 · /switch (/sw) <序号> 切换',
  '【项目】/workspace (/ws) [名称] 查看或选择',
  '【模型】/model (/m) [渠道] [模型] 查看或切换',
  '【帮助】/help (/h)',
] as const

/** 微信和钉钉共用的紧凑命令帮助；分组标记保证客户端压缩换行后仍可扫描。 */
export function formatBridgeHelpMessage(): string {
  return [
    '📋 Domi Bot 命令',
    '',
    ...HELP_SECTIONS,
    '',
    '首次使用可先发送 /workspace 选择项目。',
  ].join('\n')
}

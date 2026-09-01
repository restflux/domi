/**
 * Slash 命令体系入口。import 即注册内置命令；后续扩命令 = 在 builtin-*.ts 加文件。
 */
export * from './types'
export * from './registry'
export * from './execute'
export * from './builtin-session'
export * from './builtin-image'
import { registerBuiltinSlashCommands } from './builtin-session'
import { registerBuiltinImageSlashCommand } from './builtin-image'

registerBuiltinSlashCommands()
registerBuiltinImageSlashCommand()

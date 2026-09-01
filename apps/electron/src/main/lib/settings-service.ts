/**
 * 应用设置服务
 *
 * 绑定生产配置路径与崩溃安全写盘实现；可测试业务逻辑位于 settings-service-core.ts。
 */

import { getSettingsPath } from './config-paths'
import { writeJsonFileAtomic } from './safe-file'
import { createSettingsService } from './settings-service-core.ts'

export { resolveAgentRemoteDefaultWorkspaceId } from './settings-service-core.ts'

const settingsService = createSettingsService({
  getSettingsPath,
  writeJsonFileAtomic,
})

export const getSettings = settingsService.getSettings
export const updateSettings = settingsService.updateSettings

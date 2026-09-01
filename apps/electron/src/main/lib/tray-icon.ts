import { join } from 'node:path'

/**
 * 根据平台选择托盘图标。
 * macOS 使用可随菜单栏明暗自动着色的 Template；其他平台保留品牌彩色。
 */
export function resolveTrayIconPath(resourcesDir: string, platform: NodeJS.Platform): string {
  return platform === 'darwin'
    ? join(resourcesDir, 'domi-logos', 'iconTemplate.png')
    : join(resourcesDir, 'icon.png')
}

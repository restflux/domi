/**
 * Installer Manifest 客户端。
 *
 * Domi 直接维护第三方官方安装源，不依赖任何产品服务端或私有清单接口。
 */

import type { InstallerManifest, InstallerSource } from '@domi/shared'

const CACHE_TTL_MS = 5 * 60 * 1000

interface ManifestCache {
  data: InstallerManifest
  timestamp: number
}

let cache: ManifestCache | null = null

/**
 * 内置第三方官方安装源。sha256 留空时下载器会明确记录 warning；
 * 后续升级版本时应同步补齐官方校验值。
 */
const BUILTIN_MANIFEST: InstallerManifest = {
  installers: [
    {
      id: 'git-for-windows',
      platform: 'win32',
      arch: 'x64',
      version: '2.47.1',
      downloadUrl: '',
      fallbackUrl:
        'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe',
      sha256: '',
      sizeBytes: 66000000,
      filename: 'Git-2.47.1-64-bit.exe',
    },
    {
      id: 'git-for-windows',
      platform: 'win32',
      arch: 'arm64',
      version: '2.47.1',
      downloadUrl: '',
      fallbackUrl:
        'https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-arm64.exe',
      sha256: '',
      sizeBytes: 66000000,
      filename: 'Git-2.47.1-arm64.exe',
    },
    {
      id: 'nodejs',
      platform: 'win32',
      arch: 'x64',
      version: '22.13.1',
      downloadUrl: '',
      fallbackUrl: 'https://nodejs.org/dist/v22.13.1/node-v22.13.1-x64.msi',
      sha256: '',
      sizeBytes: 28000000,
      filename: 'node-v22.13.1-x64.msi',
    },
    {
      id: 'nodejs',
      platform: 'win32',
      arch: 'arm64',
      version: '22.13.1',
      downloadUrl: '',
      fallbackUrl: 'https://nodejs.org/dist/v22.13.1/node-v22.13.1-arm64.msi',
      sha256: '',
      sizeBytes: 28000000,
      filename: 'node-v22.13.1-arm64.msi',
    },
  ],
}

/** 返回 Domi 随版本发布并缓存的第三方官方安装源。 */
export async function fetchInstallerManifest(force = false): Promise<InstallerManifest> {
  if (!force && cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
    return cache.data
  }

  cache = { data: BUILTIN_MANIFEST, timestamp: Date.now() }
  return cache.data
}

/**
 * 从清单中挑出匹配指定 (id, arch) 的条目
 */
export function findInstallerSource(
  manifest: InstallerManifest,
  id: string,
  arch: 'x64' | 'arm64',
): InstallerSource | undefined {
  return manifest.installers.find((s) => s.id === id && s.arch === arch)
}

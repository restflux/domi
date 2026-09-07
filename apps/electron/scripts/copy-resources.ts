import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 使用跨平台文件 API，避免 Windows/Bun shell 的 cp 选项差异掩盖资源构建失败。
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(resolve(appDir, 'dist'), { recursive: true })
await cp(resolve(appDir, 'resources'), resolve(appDir, 'dist/resources'), { recursive: true })

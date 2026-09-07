import { resolve, join } from 'node:path'
import { findBundledRtk, findRtkExecutable, RTK_SUPPORTED_VERSION } from '../src/main/lib/rtk/rtk-bundled.ts'
import { createRtkService, runRtkProcess } from '../src/main/lib/rtk/rtk-service.ts'

// 构建/CI 显式 smoke；运行时不调用该脚本，不依赖系统 RTK。
const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--resources')) throw new Error('用法：verify-rtk.ts [--resources <打包资源目录>]')
const resourceDir = args[1] ? join(resolve(args[1]), 'rtk') : undefined
const service = createRtkService({
  findExecutable: resourceDir ? () => findBundledRtk(resourceDir, process.platform, process.arch) : findRtkExecutable,
  run: runRtkProcess,
})
const status = await service.inspect()
if (status.availability !== 'available' || status.version !== RTK_SUPPORTED_VERSION) throw new Error(`内置 RTK 不可用：${status.availability}`)
const raw = Array.from({ length: 30 }, (_, i) => `commit ${String(i).padStart(40, '0')}\nAuthor: Build <build@example.invalid>\nDate: Sat Sep 5 2026\n\n    Change ${i}\n`).join('\n')
const output = await service.filter('git-log', raw)
if (!output?.includes('Change') || Buffer.byteLength(output) >= Buffer.byteLength(raw)) throw new Error('内置 RTK pipe 过滤 smoke 失败')
console.log(`[RTK] 内置 ${status.version} smoke 通过：${resourceDir ?? '开发资源'}；Git log ${Buffer.byteLength(raw)} → ${Buffer.byteLength(output)} bytes`)

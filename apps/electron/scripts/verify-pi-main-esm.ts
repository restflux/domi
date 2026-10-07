#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const PI_ESM_ONLY_RUNTIME_PACKAGES = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-tui',
  '@earendil-works/pi-telemetry',
  '@earendil-works/chord',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-mcp',
  '@earendil-works/pi-codemode',
] as const

export const PI_REQUIRED_DYNAMIC_IMPORTS = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/utils/transcript',
  '@earendil-works/pi-ai/utils/validation',
  '@earendil-works/pi-mcp',
  '@earendil-works/pi-codemode',
] as const

export interface PiMainEsmBundleCheck {
  staticRequires: string[]
  dynamicImports: string[]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findStaticRequires(source: string): string[] {
  const found: string[] = []
  for (const packageName of PI_ESM_ONLY_RUNTIME_PACKAGES) {
    const pattern = new RegExp(`require\\(\\s*["']${escapeRegExp(packageName)}(?:/[^"']*)?["']\\s*\\)`, 'g')
    if (pattern.test(source)) found.push(packageName)
  }
  return found
}

function findDynamicImports(source: string): string[] {
  const found: string[] = []
  for (const packageName of PI_REQUIRED_DYNAMIC_IMPORTS) {
    const pattern = new RegExp(`import\\(\\s*["']${escapeRegExp(packageName)}["']\\s*\\)`)
    if (pattern.test(source)) found.push(packageName)
  }
  return found
}

export function inspectPiMainEsmBundle(source: string): PiMainEsmBundleCheck {
  return {
    staticRequires: findStaticRequires(source),
    dynamicImports: findDynamicImports(source),
  }
}

export function assertPiMainEsmBundle(source: string): PiMainEsmBundleCheck {
  const result = inspectPiMainEsmBundle(source)
  if (result.staticRequires.length > 0) {
    throw new Error(
      `[pi-main-esm] CommonJS 主进程不能静态 require Pi ESM 包: ${result.staticRequires.join(', ')}`,
    )
  }
  const missingDynamicImports = PI_REQUIRED_DYNAMIC_IMPORTS.filter(
    (packageName) => !result.dynamicImports.includes(packageName),
  )
  if (missingDynamicImports.length > 0) {
    throw new Error(
      `[pi-main-esm] 主进程缺少 Pi ESM dynamic import: ${missingDynamicImports.join(', ')}`,
    )
  }
  return result
}

function main(): void {
  const mainBundlePath = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(import.meta.dir, '../dist/main.cjs')
  if (!existsSync(mainBundlePath)) {
    throw new Error(`[pi-main-esm] 找不到主进程构建产物: ${mainBundlePath}`)
  }
  const result = assertPiMainEsmBundle(readFileSync(mainBundlePath, 'utf8'))
  console.log(`[pi-main-esm] ✓ main.cjs 保留 ${result.dynamicImports.length} 个 Pi ESM dynamic import，未发现静态 require`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

import { spawnSync } from 'node:child_process'

export type FileClipboardPlatform = NodeJS.Platform

export interface FileClipboardDependencies {
  platform?: FileClipboardPlatform
  runPowerShell?: (script: string, stdin: string) => Promise<void>
}

const WINDOWS_FILE_DROP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$encodedPayload = [Console]::In.ReadToEnd()
$payloadBytes = [Convert]::FromBase64String($encodedPayload)
$payload = [Text.Encoding]::UTF8.GetString($payloadBytes)
$paths = ConvertFrom-Json -InputObject $payload
$items = New-Object System.Collections.Specialized.StringCollection
foreach ($path in @($paths)) {
  [void]$items.Add([string]$path)
}
[System.Windows.Forms.Clipboard]::SetFileDropList($items)
`

async function runWindowsPowerShell(script: string, stdin: string): Promise<void> {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script],
    {
      input: stdin,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `PowerShell 退出码 ${result.status ?? 'unknown'}`)
  }
}

/** 将真实文件系统项写入系统文件剪贴板，而不是复制文件内容。 */
export async function copyFileSystemEntriesToClipboard(
  paths: string[],
  dependencies: FileClipboardDependencies = {},
): Promise<void> {
  const normalizedPaths = paths.filter((path): path is string => typeof path === 'string' && path.length > 0)
  if (normalizedPaths.length === 0) throw new Error('没有可复制的文件或文件夹')

  const platform = dependencies.platform ?? process.platform
  if (platform !== 'win32') {
    throw new Error('当前版本仅支持在 Windows 上复制文件或文件夹')
  }

  await (dependencies.runPowerShell ?? runWindowsPowerShell)(
    WINDOWS_FILE_DROP_SCRIPT,
    Buffer.from(JSON.stringify(normalizedPaths), 'utf8').toString('base64'),
  )
}

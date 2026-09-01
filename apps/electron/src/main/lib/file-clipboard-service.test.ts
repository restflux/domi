import { describe, expect, mock, test } from 'bun:test'
import { copyFileSystemEntriesToClipboard } from './file-clipboard-service.ts'

describe('copyFileSystemEntriesToClipboard', () => {
  test('Given Windows 文件和目录 When 复制到剪贴板 Then 通过 STA PowerShell 写入 FileDropList，路径只走 stdin', async () => {
    const runPowerShell = mock(async (_script: string, _stdin: string) => {})
    const paths = [
      'C:\\项目\\正式武器型号编码确认清单.xlsx',
      'C:\\项目\\导出目录',
      'C:\\项目\\a\"; Remove-Item C:\\important; #.txt',
    ]

    await copyFileSystemEntriesToClipboard(paths, {
      platform: 'win32',
      runPowerShell,
    })

    expect(runPowerShell).toHaveBeenCalledTimes(1)
    const [script, stdin] = runPowerShell.mock.calls[0]!
    expect(script).toContain('[System.Windows.Forms.Clipboard]::SetFileDropList')
    expect(script).toContain('[Console]::In.ReadToEnd()')
    expect(script).toContain('[Convert]::FromBase64String')
    expect(script).not.toContain(paths[2]!)
    const decodedPayload = Buffer.from(stdin, 'base64').toString('utf8')
    expect(JSON.parse(decodedPayload)).toEqual(paths)
  })
})

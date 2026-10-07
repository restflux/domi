import { describe, expect, test } from 'bun:test'
import { MAX_FILES, MAX_MANIFEST_BYTES, parseManifest, renderManifest, validateRelativePath } from './manifest'

describe('Worktree 本地文件清单', () => {
  test('保留注释和空行，只按明确相对文件路径去重', () => {
    const text = '# 本机配置\n\n.env.local\nconfig/local.json\n.env.local\n'
    expect(parseManifest(text)).toEqual(['.env.local', 'config/local.json'])
    expect(renderManifest(text, ['.env.local', 'new.json'])).toBe('# 本机配置\n\n.env.local\nnew.json\n')
  })

  test.each(['/etc/passwd', '../secret', 'dir/../../secret', 'C:/secret', 'dir\\secret', '*.env', ':(glob)file', '!file',
    'dir/[file]', './file', 'dir//file', 'dir/', '.git/config', 'dir/.GIT/config', 'node_modules/file', '.cache/file',
    'cache/file', '.venv/file', 'vendor/file', '.worktreeinclude', '.WORKTREEINCLUDE', 'file:stream', 'NUL', 'com1.txt',
    'name.', '#not-a-path', 'line\nfile'])('拒绝匹配语法和不安全路径 %s', path => {
    expect(() => validateRelativePath(path)).toThrow()
  })

  test('文件数与 UTF-8 字节数有限，注释和重复行也不能绕过文本限额', () => {
    expect(() => parseManifest(Array.from({ length: MAX_FILES + 1 }, (_, index) => `file-${index}`).join('\n'))).toThrow()
    expect(() => parseManifest(`#${'x'.repeat(MAX_MANIFEST_BYTES)}`)).toThrow()
    expect(() => renderManifest(`#${'x'.repeat(MAX_MANIFEST_BYTES - 1)}`, ['file'])).toThrow()
    expect(parseManifest('\uFEFF# 配置\r\n.env\r\n')).toEqual(['.env'])
  })
})

import { describe, expect, test } from 'bun:test'
import { normalizeMsysPath } from './workspace-boundary.ts'

describe('normalizeMsysPath', () => {
  test('converts Git Bash / MSYS drive paths to Windows drive paths', () => {
    expect(normalizeMsysPath('/g/foo')).toBe('G:/foo')
    expect(normalizeMsysPath('/c/Users/Lucky')).toBe('C:/Users/Lucky')
    expect(normalizeMsysPath('/d/x/y')).toBe('D:/x/y')
  })

  test('leaves non-drive POSIX paths and already-Windows paths unchanged', () => {
    expect(normalizeMsysPath('/usr/bin')).toBe('/usr/bin')
    expect(normalizeMsysPath('/tmp/x')).toBe('/tmp/x')
    expect(normalizeMsysPath('/home/user')).toBe('/home/user')
    expect(normalizeMsysPath('G:/foo')).toBe('G:/foo')
    expect(normalizeMsysPath('C:\\foo')).toBe('C:\\foo')
    expect(normalizeMsysPath('../domi/x')).toBe('../domi/x')
    expect(normalizeMsysPath('./x')).toBe('./x')
    expect(normalizeMsysPath('')).toBe('')
  })
})

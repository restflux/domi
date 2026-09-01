import { describe, expect, test } from 'bun:test'
import { entryLayers, parseGitNumstat, parseGitPorcelainV2, statusForGitCode } from './git-porcelain-v2.ts'

describe('porcelain v2 parser', () => {
  test('parses branch metadata and all change record kinds', () => {
    const output = [
      '# branch.oid abcdef0123456789',
      '# branch.head workbench',
      '# branch.upstream origin/workbench',
      '# branch.ab +2 -1',
      '1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb src/双层 file.ts',
      '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/new name.ts',
      'src/old name.ts',
      'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc src/conflict.ts',
      '? docs/新文件.md',
      '',
    ].join('\0')

    const parsed = parseGitPorcelainV2(output)

    expect(parsed.header).toEqual({
      branch: 'workbench',
      detached: false,
      unborn: false,
      headOid: 'abcdef0123456789',
      upstream: 'origin/workbench',
      ahead: 2,
      behind: 1,
    })
    expect(parsed.entries.map((entry) => ({
      path: entry.repositoryPath,
      previous: entry.previousRepositoryPath,
      layers: entryLayers(entry),
    }))).toEqual([
      { path: 'src/双层 file.ts', previous: undefined, layers: ['staged', 'unstaged'] },
      { path: 'src/new name.ts', previous: 'src/old name.ts', layers: ['staged'] },
      { path: 'src/conflict.ts', previous: undefined, layers: ['conflict'] },
      { path: 'docs/新文件.md', previous: undefined, layers: ['untracked'] },
    ])
  })

  test('parses detached and unborn headers', () => {
    const detached = parseGitPorcelainV2('# branch.oid abc\0# branch.head (detached)\0')
    expect(detached.header.branch).toBeNull()
    expect(detached.header.detached).toBeTrue()

    const unborn = parseGitPorcelainV2('# branch.oid (initial)\0# branch.head main\0')
    expect(unborn.header.branch).toBe('main')
    expect(unborn.header.unborn).toBeTrue()
    expect(unborn.header.headOid).toBeNull()
  })

  test('maps status codes and parses normal, binary and rename numstat', () => {
    expect(statusForGitCode('A')).toBe('added')
    expect(statusForGitCode('D')).toBe('deleted')
    expect(statusForGitCode('R')).toBe('renamed')
    expect(statusForGitCode('T')).toBe('type-changed')

    const stats = parseGitNumstat([
      '2\t1\tsrc/普通.ts',
      '-\t-\tassets/logo.png',
      '3\t4\t',
      'src/old.ts',
      'src/new.ts',
      '',
    ].join('\0'))
    expect(stats.get('src/普通.ts')).toEqual({ additions: 2, deletions: 1 })
    expect(stats.get('assets/logo.png')).toEqual({ additions: 0, deletions: 0 })
    expect(stats.get('src/new.ts')).toEqual({ additions: 3, deletions: 4 })
  })
})

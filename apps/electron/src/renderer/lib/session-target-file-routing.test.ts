import { describe, expect, test } from 'bun:test'
import {
  createSessionTargetFileRequest,
  getAgentFileSourceRoute,
  getAgentFileTreeRoot,
  resolveAgentSearchResultPath,
} from './session-target-file-routing.ts'
import { computeRevealAncestors, isPathUnderRoot } from '../components/file-browser/FileBrowser.tsx'
import {
  getDefaultAppTargetPath,
  getPreviewFileAccess,
  getToolPreviewBasePaths,
  selectPreviewTextContent,
} from '../components/diff/preview-open-path.ts'

describe('Session Target renderer file routing seam', () => {
  test('Given a pending plan When disk loading fails or resolves a same-name file Then the approved plan snapshot remains authoritative', () => {
    expect(selectPreviewTextContent(null, '# 当前计划')).toBe('# 当前计划')
    expect(selectPreviewTextContent('', '# 当前计划')).toBe('# 当前计划')
    expect(selectPreviewTextContent('# 同名旧计划', '# 当前计划')).toBe('# 当前计划')
    expect(selectPreviewTextContent('# 普通文件', undefined)).toBe('# 普通文件')
  })

  test('Given a relative preview path When opening the default app Then it keeps the same path for main-process resolution', () => {
    expect(getDefaultAppTargetPath({
      filePath: 'docs/report.md',
      previewOnly: true,
      basePaths: ['C:/domi/session-a'],
    }, 'D:/checkout')).toBe('docs/report.md')
  })

  test('Given a historical tool result When it opens a relative file Then the session workbench and attachments remain candidate roots', () => {
    expect(getToolPreviewBasePaths(
      'C:/domi/session-a',
      ['D:/attached', 'C:/domi/session-a'],
    )).toEqual([
      'C:/domi/session-a',
      'D:/attached',
    ])
  })

  test('Given an active Pi session When switching file-source tabs Then project uses the lease while session files use the private workbench', () => {
    expect(getAgentFileSourceRoute(true, 'project')).toEqual({
      usesSessionTarget: true,
      pathSpace: 'session-target',
    })
    expect(getAgentFileSourceRoute(true, 'session')).toEqual({
      usesSessionTarget: false,
      pathSpace: 'session-workbench',
    })
    expect(getPreviewFileAccess('session-a', {
      filePath: 'D:/managed/session/note.md',
      pathSpace: 'session-workbench',
    }, 'D:/managed/session')).toMatchObject({
      sessionId: 'session-a',
      pathSpace: 'session-workbench',
    })
  })

  test('Given a new unbound Pi session When project files are selected Then renderer browses the exact Local project until first send binds a target', () => {
    expect(getAgentFileSourceRoute(true, 'project', false)).toEqual({
      usesSessionTarget: false,
      pathSpace: 'session-local-project',
    })
    expect(getAgentFileTreeRoot(false, 'D:/local/project')).toBe('D:/local/project')
    expect(getPreviewFileAccess('session-new', {
      filePath: 'D:/local/project/README.md',
      pathSpace: 'session-local-project',
    }, 'D:/managed/session')).toMatchObject({
      sessionId: 'session-new',
      pathSpace: 'session-local-project',
    })
  })

  test('Given an active Pi Session Target When the file tree and search select a file Then renderer keeps only a normalized relative path', () => {
    expect(getAgentFileTreeRoot(true, 'D:/local/project')).toBe('.')
    expect(resolveAgentSearchResultPath({
      usesSessionTarget: true,
      entryPath: 'src\\feature\\file.ts',
      source: 'session',
      workspaceRoot: 'D:/local/project',
      sessionRoot: 'D:/managed/session',
    })).toBe('src/feature/file.ts')
    expect(createSessionTargetFileRequest('session-a', 'src\\feature\\file.ts')).toEqual({
      sessionId: 'session-a',
      relativePath: 'src/feature/file.ts',
    })
    expect(isPathUnderRoot('.', 'src/feature/file.ts')).toBeTrue()
    expect(computeRevealAncestors('.', 'src/feature/file.ts')).toEqual(new Set(['src', 'src/feature']))
  })

  test('Given an active Pi Session Target When renderer receives an absolute or parent path Then no file request is created', () => {
    expect(createSessionTargetFileRequest('session-a', 'D:/managed/session/private.ts')).toBeNull()
    expect(createSessionTargetFileRequest('session-a', '/managed/session/private.ts')).toBeNull()
    expect(createSessionTargetFileRequest('session-a', '../sibling/private.ts')).toBeNull()
    expect(createSessionTargetFileRequest('session-a', 'src/../../sibling/private.ts')).toBeNull()
  })

  test('Given the generic absolute-path file tree When search selects a file Then existing absolute path behavior remains unchanged', () => {
    expect(getAgentFileTreeRoot(false, 'D:/local/project')).toBe('D:/local/project')
    expect(resolveAgentSearchResultPath({
      usesSessionTarget: false,
      entryPath: 'src/file.ts',
      source: 'workspace',
      workspaceRoot: 'D:/local/project',
      sessionRoot: 'D:/session/files',
    })).toBe('D:/local/project/src/file.ts')
  })
})

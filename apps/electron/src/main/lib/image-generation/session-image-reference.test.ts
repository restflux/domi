import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatSessionImageReference, readSessionImageReference } from './session-image-reference'

const sessionId = 'd34a9595-e2f0-4bc1-bf84-47b8dff8fe31'
const anotherId = 'b34a9595-e2f0-4bc1-bf84-47b8dff8fe31'
const imageName = '858ecfe6-0c71-4d92-bdf7-9d07d364471a.png'

function withAttachments(run: (root: string, localPath: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'domi-session-image-'))
  try {
    mkdirSync(join(root, sessionId))
    writeFileSync(join(root, sessionId, imageName), 'session-image')
    run(root, `${sessionId}/${imageName}`)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('会话生成图后续编辑引用', () => {
  test('Given the current session generated an image When editing next turn Then both new handle and historical marker are readable', () => {
    withAttachments((root, localPath) => {
      for (const ref of [formatSessionImageReference(localPath), localPath]) {
        expect(readSessionImageReference(ref, sessionId, root)).toEqual({
          data: Buffer.from('session-image').toString('base64'), mimeType: 'image/png',
        })
      }
    })
  })

  test('Given another session, traversal or a symlink When referencing it Then it never becomes an editable image', () => {
    withAttachments((root, localPath) => {
      expect(() => readSessionImageReference(formatSessionImageReference(localPath), anotherId, root)).toThrow('当前会话')
      expect(() => readSessionImageReference(`${anotherId}/${imageName}`, sessionId, root)).toThrow('当前会话')
      expect(() => readSessionImageReference(`domi-session-image://${sessionId}/../${imageName}`, sessionId, root)).toThrow('无效')
      expect(() => readSessionImageReference(`domi-session-image://${sessionId}/00000000-0000-0000-0000-000000000000.png`, sessionId, root)).toThrow('无效')
      if (process.platform !== 'win32') {
        const link = join(root, sessionId, '00000000-0000-0000-0000-000000000000.png')
        symlinkSync(join(root, sessionId, imageName), link)
        expect(() => readSessionImageReference(`domi-session-image://${sessionId}/00000000-0000-0000-0000-000000000000.png`, sessionId, root)).toThrow('无效')
      }
      expect(readSessionImageReference('ordinary-project-image.png', sessionId, root)).toBeNull()
    })
  })
})

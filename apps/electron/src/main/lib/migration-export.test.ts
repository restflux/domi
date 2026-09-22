import { afterAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { randomBytes } from 'node:crypto'
import { initialMigrationPathMappings } from '../../renderer/lib/migration-path-mappings.ts'
import type { AgentWorkspace, CreateAgentWorkspaceInput } from '@domi/shared'

const root = mkdtempSync(join(tmpdir(), 'domi-export-test-'))
const workspace = { id: 'workspace', slug: 'workspace', name: '测试项目', createdAt: 1, updatedAt: 1 }
const workspaces: AgentWorkspace[] = [workspace]
const createdInputs: CreateAgentWorkspaceInput[] = []
const workspacePath = join(root, 'workspace')
mkdirSync(join(workspacePath, 'session'), { recursive: true })
writeFileSync(join(root, 'agent-sessions.json'), JSON.stringify({
  version: 2, sessions: [{ id: 'session', workspaceId: workspace.id }],
}))
writeFileSync(join(root, 'session.jsonl'), '{"role":"user","content":"测试"}\n')
const sessionFiles = ['report.md', 'image.png', '.context/notes.md', 'output/table.xlsx', 'dist/demo.html']
for (const file of sessionFiles) {
  mkdirSync(join(workspacePath, 'session', file, '..'), { recursive: true })
  writeFileSync(join(workspacePath, 'session', file), `会话文件:${file}`)
}
for (let i = 0; i < 16; i++) {
  writeFileSync(join(workspacePath, 'session', `${i}.txt`), Buffer.alloc(1024 * 1024, i))
}

mock.module('electron', () => ({ safeStorage: {} }))
mock.module('./agent-workspace-manager', () => ({
  listAgentWorkspaces: () => workspaces, getAgentWorkspace: (id: string) => workspaces.find((item) => item.id === id),
  getLocalProjectRootStatus: (path: string) => existsSync(path) && statSync(path).isDirectory() ? 'available' : 'missing',
  createAgentWorkspace: (input: CreateAgentWorkspaceInput) => {
    createdInputs.push(input)
    const created = { ...workspace, ...input, id: `created-${createdInputs.length}`, slug: `created-${createdInputs.length}` }
    workspaces.push(created)
    mkdirSync(join(root, created.slug), { recursive: true })
    return created
  },
  getAllWorkspaceSkills: () => [], getWorkspaceMcpConfig: () => ({ servers: {} }),
}))
mock.module('./channel-manager', () => ({ listChannels: () => [], decryptApiKey: () => '' }))
mock.module('./config-paths', () => ({
  getConfigDir: () => root,
  getChannelsPath: () => join(root, 'channels.json'),
  getConversationsIndexPath: () => join(root, 'conversations.json'),
  getConversationsDir: () => root,
  getConversationMessagesPath: (id: string) => join(root, `${id}.jsonl`),
  getAgentSessionsIndexPath: () => join(root, 'agent-sessions.json'),
  getAgentSessionsDir: () => root,
  getAgentSessionMessagesPath: (id: string) => join(root, `${id}.jsonl`),
  getAgentWorkspacePath: (slug: string) => join(root, slug),
  getAgentSessionWorkspacePath: (slug: string, id: string) => {
    const path = join(root, slug, id)
    mkdirSync(path, { recursive: true })
    return path
  },
  getWorkspaceMcpPath: () => join(workspacePath, 'mcp.json'),
  getWorkspaceSkillsDir: () => join(workspacePath, 'skills'),
  getInactiveSkillsDir: () => join(workspacePath, 'inactive-skills'),
  getSettingsPath: () => join(root, 'settings.json'),
  getUserProfilePath: () => join(root, 'user-profile.json'),
  getChatToolsConfigPath: () => join(root, 'chat-tools.json'),
}))

const { exportData, exportDataV2, parseImportFile, confirmImport } = await import('./migration-service.ts')
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('数据导出响应性', () => {
  test('Given 大量不可压缩文件 When 导出 Then 保留会话文件但不读取或打包依赖', async () => {
    const bulk = join(workspacePath, 'session', 'node_modules')
    mkdirSync(bulk)
    for (let i = 0; i < 24; i++) writeFileSync(join(bulk, `${i}.bin`), randomBytes(4 * 1024 * 1024))
    Bun.gc(true)
    const baseline = process.memoryUsage().arrayBuffers
    let peak = baseline
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers) }, 5)
    try {
      const outputPath = join(root, 'large.domi-backup')
      const started = performance.now()
      await exportDataV2({ mode: 'personal', components: ['sessions'], outputPath })
      const memoryMB = (peak - baseline) / 1024 / 1024
      console.log(`[导出性能测试] 96 MiB 随机文件，耗时 ${Math.round(performance.now() - started)} ms，额外 Buffer 峰值 ${Math.round(memoryMB)} MiB`)
      expect(memoryMB).toBeLessThan(64)
      expect(statSync(outputPath).size).toBeLessThan(1024 * 1024)
      expect(new AdmZip(outputPath).getEntries().some(entry => entry.entryName.includes('/node_modules/'))).toBe(false)
    } finally {
      clearInterval(timer)
      rmSync(bulk, { recursive: true, force: true })
    }
  }, 30000)

  for (const version of [1, 2]) {
    test(`Given 多文件会话 When v${version} 导出 Then 完成前事件循环仍可响应且归档完整`, async () => {
      const outputPath = join(root, `backup-v${version}.domi-backup`)
      let heartbeats = 0
      const timer = setInterval(() => { heartbeats++ }, 1)
      try {
        const options = { mode: 'personal' as const, components: ['sessions' as const], outputPath }
        const result = await (version === 1
          ? exportData({ ...options, workspaceId: workspace.id })
          : exportDataV2(options))
        expect(result.success).toBe(true)
        expect(heartbeats).toBeGreaterThan(0)
        const archive = new AdmZip(outputPath)
        expect(JSON.parse(archive.readAsText('manifest.json')).version).toBe(`${version}.0`)
        expect(archive.readAsText('sessions/agent/session.jsonl')).toContain('测试')
        for (const file of sessionFiles) expect(archive.readAsText(`sessions/workspace-data/session/${file}`)).toBe(`会话文件:${file}`)
        for (let i = 0; i < 16; i++) {
          expect(archive.readFile(`sessions/workspace-data/session/${i}.txt`)).toEqual(Buffer.alloc(1024 * 1024, i))
        }
      } finally {
        clearInterval(timer)
      }
    })
  }

  test('Given 已选择的 Skills 与 MCP When 团队分发 Then 只导出所选项目且剥离凭据', async () => {
    for (const name of ['selected', 'excluded']) {
      mkdirSync(join(workspacePath, 'skills', name), { recursive: true })
      writeFileSync(join(workspacePath, 'skills', name, 'SKILL.md'), name)
    }
    writeFileSync(join(workspacePath, 'mcp.json'), JSON.stringify({ servers: {
      selected: { type: 'http', url: 'https://example.com', headers: { Authorization: 'secret' } },
      excluded: { type: 'stdio', command: 'test' },
    } }))
    writeFileSync(join(root, 'settings.json'), '{"themeMode":"dark"}')
    const outputPath = join(root, 'team.domi-share')
    await exportDataV2({
      mode: 'share', components: ['skills', 'mcp'], outputPath,
      workspaceSelections: [{ workspaceId: workspace.id, skillSlugs: ['selected'], mcpServerNames: ['selected'] }],
    })
    const archive = new AdmZip(outputPath)
    expect(archive.readAsText('workspaces/workspace/skills/active/selected/SKILL.md')).toBe('selected')
    expect(archive.getEntry('workspaces/workspace/skills/active/excluded/SKILL.md')).toBeNull()
    const mcp = JSON.parse(archive.readAsText('workspaces/workspace/config/mcp.json'))
    expect(Object.keys(mcp.servers)).toEqual(['selected'])
    expect(mcp.servers.selected.headers.Authorization).toBe('')
    expect(archive.getEntry('auth/settings.json')).toBeNull()
  })

  test('Given 目录内存在失效链接 When 个人备份 Then 返回警告且其他文件完整', async () => {
    mkdirSync(join(workspacePath, 'skills', 'selected'), { recursive: true })
    const brokenLink = join(workspacePath, 'skills', 'selected', 'broken-link')
    symlinkSync(join(root, 'missing'), brokenLink, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const outputPath = join(root, 'partial.domi-backup')
      const result = await exportDataV2({ mode: 'personal', components: ['sessions', 'skills'], outputPath })
      expect(result.success).toBe(true)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings?.[0]).toContain('broken-link')
      const archive = new AdmZip(outputPath)
      expect(archive.readAsText('sessions/agent/session.jsonl')).toContain('测试')
    } finally {
      unlinkSync(brokenLink)
    }
  })

  for (const version of [1, 2]) {
    test(`Given 会话附件及未选会话附件 When v${version} 导出再导入 Then 仅恢复所选记录的附件且不覆盖已有附件`, async () => {
      const indexPath = join(root, 'agent-sessions.json')
      const previousIndex = readFileSync(indexPath, 'utf-8')
      writeFileSync(indexPath, JSON.stringify({ version: 2, sessions: [
        { id: 'session', workspaceId: workspace.id }, { id: 'excluded', workspaceId: workspace.id },
      ] }))
      writeFileSync(join(root, 'excluded.jsonl'), '{"role":"user","content":"未选会话"}\n')
      const attachmentDir = join(root, 'attachments', 'session')
      mkdirSync(attachmentDir, { recursive: true })
      writeFileSync(join(attachmentDir, 'image.png'), '图片内容')
      writeFileSync(join(attachmentDir, 'keep.txt'), '备份内容')
      mkdirSync(join(root, 'attachments', 'excluded'), { recursive: true })
      writeFileSync(join(root, 'attachments', 'excluded', 'private.txt'), '不导出')
      writeFileSync(join(root, 'conversations.json'), JSON.stringify({ version: 1, conversations: [{ id: 'chat' }] }))
      writeFileSync(join(root, 'chat.jsonl'), '{"role":"user","content":"聊天"}\n')
      mkdirSync(join(root, 'attachments', 'chat'), { recursive: true })
      writeFileSync(join(root, 'attachments', 'chat', 'document.txt'), '聊天附件')
      const outputPath = join(root, `attachments-v${version}.domi-backup`)
      const options = { mode: 'personal' as const, components: ['sessions' as const], outputPath, sessionIds: ['session', 'chat'] }
      await (version === 1 ? exportData({ ...options, workspaceId: workspace.id }) : exportDataV2(options))
      const archive = new AdmZip(outputPath)
      expect(archive.readAsText('sessions/attachments/session/image.png')).toBe('图片内容')
      expect(archive.getEntry('sessions/attachments/excluded/private.txt')).toBeNull()
      expect(archive.getEntry('sessions/agent/excluded.jsonl')).toBeNull()
      expect(archive.readAsText('sessions/attachments/chat/document.txt')).toBe('聊天附件')
      rmSync(join(root, 'attachments', 'chat', 'document.txt'))
      rmSync(join(attachmentDir, 'image.png'))
      for (const file of sessionFiles) rmSync(join(workspacePath, 'session', file))
      writeFileSync(join(workspacePath, 'session', 'keep.md'), '本机文档')
      writeFileSync(join(attachmentDir, 'keep.txt'), '本机内容')
      archive.addFile('sessions/workspace-data/session/conflict/child.txt', Buffer.from('备份目录'))
      archive.addFile('sessions/workspace-data/session/keep.md', Buffer.from('备份文档'))
      archive.writeZip(outputPath)
      writeFileSync(join(workspacePath, 'session', 'conflict'), '本机同名文件')
      const preview = await parseImportFile(outputPath)
      try {
        await confirmImport({
          tempDir: preview.tempDir, manifest: preview.manifest, pathMappings: {},
          workspaceMappings: [{ sourceSlug: workspace.slug, action: 'merge', targetWorkspaceId: workspace.id }],
        })
        for (const file of sessionFiles) expect(readFileSync(join(workspacePath, 'session', file), 'utf-8')).toBe(`会话文件:${file}`)
        expect(readFileSync(join(workspacePath, 'session', 'keep.md'), 'utf-8')).toBe('本机文档')
        expect(readFileSync(join(workspacePath, 'session', 'conflict'), 'utf-8')).toBe('本机同名文件')
        expect(readFileSync(join(root, 'attachments', 'chat', 'document.txt'), 'utf-8')).toBe('聊天附件')
        expect(readFileSync(join(attachmentDir, 'image.png'), 'utf-8')).toBe('图片内容')
        expect(readFileSync(join(attachmentDir, 'keep.txt'), 'utf-8')).toBe('本机内容')
      } finally {
        rmSync(preview.tempDir, { recursive: true, force: true })
        writeFileSync(indexPath, previousIndex)
        rmSync(join(workspacePath, 'session', 'conflict'), { force: true })
      }
    })
  }

  test('Given 嵌套依赖缓存及外部目录链接 When 导出 Then 保留会话产物且不带入外部项目', async () => {
    const sessionDir = join(workspacePath, 'session')
    const excluded = ['.context/runtime/node_modules/pkg/index.js', 'nested/.cache/data.bin', '.venv/lib/runtime.py']
    for (const file of excluded) {
      mkdirSync(join(sessionDir, file, '..'), { recursive: true })
      writeFileSync(join(sessionDir, file), '依赖缓存')
    }
    const external = join(root, 'external-project')
    mkdirSync(external)
    writeFileSync(join(external, 'private.txt'), '外部项目内容')
    const link = join(sessionDir, 'linked-project')
    symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const outputPath = join(root, 'filtered.domi-backup')
      const result = await exportDataV2({ mode: 'personal', components: ['sessions'], outputPath })
      const archive = new AdmZip(outputPath)
      for (const file of excluded) expect(archive.getEntry(`sessions/workspace-data/session/${file}`)).toBeNull()
      expect(archive.getEntries().some(entry => entry.entryName.includes('linked-project'))).toBe(false)
      expect(result.warnings?.some(warning => warning.includes('linked-project'))).toBe(true)
      for (const file of sessionFiles) expect(archive.readAsText(`sessions/workspace-data/session/${file}`)).toBe(`会话文件:${file}`)
    } finally { unlinkSync(link) }
  })

  test('Given 会话根目录是外部项目链接 When 导出 Then 跳过并警告而非打包项目', async () => {
    const indexPath = join(root, 'agent-sessions.json')
    const previousIndex = readFileSync(indexPath, 'utf-8')
    const link = join(workspacePath, 'linked-session')
    symlinkSync(join(root, 'external-project'), link, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(root, 'linked-session.jsonl'), '{"role":"user","content":"测试"}\n')
    writeFileSync(indexPath, JSON.stringify({ version: 2, sessions: [{ id: 'linked-session', workspaceId: workspace.id }] }))
    try {
      const outputPath = join(root, 'root-link.domi-backup')
      const result = await exportDataV2({ mode: 'personal', components: ['sessions'], outputPath })
      const archive = new AdmZip(outputPath)
      expect(archive.getEntry('sessions/agent/linked-session.jsonl')).not.toBeNull()
      expect(archive.getEntries().some(entry => entry.entryName.startsWith('sessions/workspace-data/'))).toBe(false)
      expect(result.warnings?.some(warning => warning.includes('linked-session'))).toBe(true)
    } finally {
      unlinkSync(link)
      writeFileSync(indexPath, previousIndex)
    }
  })

  test('Given 输出路径无法写入 When 导出 Then Promise 拒绝而非报告成功', async () => {
    const outputPath = join(root, 'blocked')
    writeFileSync(outputPath, '不能作为目录')
    await expect(exportDataV2({
      mode: 'share', components: [], outputPath: join(outputPath, 'backup.domi-share'),
    })).rejects.toBeDefined()
  })
})

describe('跨平台导入路径闭环', () => {
  for (const version of [1, 2]) {
    test(`Given v${version} 跨平台备份 When 预览并确认 Then 采用本机路径且允许修正无效映射后重试`, async () => {
      const sourcePlatform = platform() === 'win32' ? 'darwin' : 'win32'
      const sourceHomeDir = sourcePlatform === 'win32' ? 'C:\\Users\\Source' : '/Users/source'
      const zip = new AdmZip()
      const manifest = {
        version: `${version}.0`, mode: 'share', components: [],
        sourcePlatform, sourceHomeDir, workspaceId: workspace.id, workspaceSlug: workspace.slug,
        workspaces: version === 2 ? [{ workspaceId: workspace.id, workspaceSlug: workspace.slug, workspaceName: workspace.name }] : undefined,
      }
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
      const configPrefix = version === 2 ? 'workspaces/workspace/' : ''
      zip.addFile(`${configPrefix}config/workspace-config.json`, Buffer.from(JSON.stringify({ attachedDirectories: [sourceHomeDir] })))
      const filePath = join(root, `import-v${version}.domi-share`)
      zip.writeZip(filePath)
      const preview = await parseImportFile(filePath)
      try {
        expect(preview.crossPlatform).toBe(true)
        expect(preview.pathCheckResults).toEqual([{ path: sourceHomeDir, exists: false }])
        expect(initialMigrationPathMappings(preview.pathCheckResults)).toEqual({ [sourceHomeDir]: null })
        const configPath = join(workspacePath, 'config.json')
        const previous = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null
        await expect(confirmImport({
          tempDir: preview.tempDir, manifest: preview.manifest,
          pathMappings: { [sourceHomeDir]: join(root, 'missing-destination') },
        })).rejects.toThrow('映射路径不存在')
        expect(existsSync(preview.tempDir)).toBe(true)
        expect(existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null).toBe(previous)
        await confirmImport({
          tempDir: preview.tempDir, manifest: preview.manifest,
          pathMappings: { [sourceHomeDir]: homedir() },
          workspaceMappings: [{ sourceSlug: workspace.slug, action: 'merge', targetWorkspaceId: workspace.id }],
        })
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        expect(config.attachedDirectories).toContain(homedir())
        expect(config.attachedDirectories).not.toContain(sourceHomeDir)
      } finally {
        rmSync(preview.tempDir, { recursive: true, force: true })
      }
    })
  }

  test('Given 三个项目 When 为两个项目分别选目录并跳过第三个 Then 根目录和会话工作文件按项目隔离', async () => {
    const zip = new AdmZip()
    const ids = ['one', 'two', 'skip']
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({
      version: '2.0', mode: 'share', components: ['sessions'], sourcePlatform: platform(),
      workspaces: ids.map((id) => ({ workspaceId: id, workspaceSlug: id, workspaceName: id })),
    })))
    zip.addFile('sessions/agent-sessions-index.json', Buffer.from(JSON.stringify({
      version: 2, sessions: ids.map((id) => ({ id: `session-${id}`, workspaceId: id })),
    })))
    for (const id of ids) {
      zip.addFile(`sessions/agent/session-${id}.jsonl`, Buffer.from(id))
      zip.addFile(`sessions/workspace-data/session-${id}/note.txt`, Buffer.from(id))
    }
    const archivePath = join(root, 'multiple.domi-share')
    zip.writeZip(archivePath)
    const preview = await parseImportFile(archivePath)
    const selectedRoots = ['one', 'two'].map((name) => join(root, `code-${name}`))
    for (const path of selectedRoots) mkdirSync(path)
    await expect(confirmImport({ tempDir: preview.tempDir, manifest: preview.manifest, pathMappings: {} })).rejects.toThrow('明确选择')
    expect(createdInputs).toHaveLength(0)
    const mappings = [
      { sourceSlug: 'one', action: 'create' as const, projectRootPath: selectedRoots[0] },
      { sourceSlug: 'two', action: 'create' as const, projectRootPath: join(root, 'missing') },
      { sourceSlug: 'skip', action: 'skip' as const },
    ]
    await expect(confirmImport({ tempDir: preview.tempDir, manifest: preview.manifest, pathMappings: {}, workspaceMappings: mappings })).rejects.toThrow('项目目录不存在')
    expect(createdInputs).toHaveLength(0)
    mappings[1]!.projectRootPath = selectedRoots[1]
    await confirmImport({ tempDir: preview.tempDir, manifest: preview.manifest, pathMappings: {}, workspaceMappings: mappings })
    expect(createdInputs.map((input) => input.projectRootPath)).toEqual(selectedRoots)
    for (const [index, id] of ['one', 'two'].entries()) {
      expect(readFileSync(join(root, `created-${index + 1}`, `session-${id}`, 'note.txt'), 'utf-8')).toBe(id)
    }
    expect(existsSync(join(root, 'session-skip.jsonl'))).toBe(false)
    const index = JSON.parse(readFileSync(join(root, 'agent-sessions.json'), 'utf-8'))
    expect(index.sessions.find((session: { id: string }) => session.id === 'session-one').workspaceId).toBe('created-1')
    expect(index.sessions.find((session: { id: string }) => session.id === 'session-two').workspaceId).toBe('created-2')
    expect(index.sessions.some((session: { id: string }) => session.id === 'session-skip')).toBe(false)
  })
})

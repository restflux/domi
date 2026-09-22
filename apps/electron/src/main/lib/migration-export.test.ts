import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'

const root = mkdtempSync(join(tmpdir(), 'domi-export-test-'))
const workspace = { id: 'workspace', slug: 'workspace', name: '测试项目', createdAt: 1, updatedAt: 1 }
const workspacePath = join(root, 'workspace')
mkdirSync(join(workspacePath, 'session'), { recursive: true })
writeFileSync(join(root, 'agent-sessions.json'), JSON.stringify({
  version: 2, sessions: [{ id: 'session', workspaceId: workspace.id }],
}))
writeFileSync(join(root, 'session.jsonl'), '{"role":"user","content":"测试"}\n')
for (let i = 0; i < 16; i++) {
  writeFileSync(join(workspacePath, 'session', `${i}.txt`), Buffer.alloc(1024 * 1024, i))
}

mock.module('electron', () => ({ safeStorage: {} }))
mock.module('./agent-workspace-manager', () => ({
  listAgentWorkspaces: () => [workspace], getAgentWorkspace: () => workspace,
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
  getAgentWorkspacePath: () => workspacePath,
  getAgentSessionWorkspacePath: () => join(workspacePath, 'session'),
  getWorkspaceMcpPath: () => join(workspacePath, 'mcp.json'),
  getWorkspaceSkillsDir: () => join(workspacePath, 'skills'),
  getInactiveSkillsDir: () => join(workspacePath, 'inactive-skills'),
  getSettingsPath: () => join(root, 'settings.json'),
  getUserProfilePath: () => join(root, 'user-profile.json'),
  getChatToolsConfigPath: () => join(root, 'chat-tools.json'),
}))

const { exportData, exportDataV2 } = await import('./migration-service.ts')
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('数据导出响应性', () => {
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
    const brokenLink = join(workspacePath, 'session', 'broken-link')
    symlinkSync(join(root, 'missing'), brokenLink, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const outputPath = join(root, 'partial.domi-backup')
      const result = await exportDataV2({ mode: 'personal', components: ['sessions'], outputPath })
      expect(result.success).toBe(true)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings?.[0]).toContain('broken-link')
      const archive = new AdmZip(outputPath)
      expect(archive.readAsText('sessions/agent/session.jsonl')).toContain('测试')
    } finally {
      unlinkSync(brokenLink)
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

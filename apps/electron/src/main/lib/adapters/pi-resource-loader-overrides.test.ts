import { describe, expect, test } from 'bun:test'
import { createDomiAgentsFilesOverride } from './pi-resource-loader-overrides'

describe('Pi 项目指令自动发现隔离', () => {
  test('Given SDK 从 cwd/祖先/附加目录发现指令 When 应用 Domi override Then AGENTS 与 CLAUDE 全部过滤', () => {
    const override = createDomiAgentsFilesOverride()

    const result = override({
      agentsFiles: [
        { path: '/project/AGENTS.md', content: 'project' },
        { path: '/parent/CLAUDE.md', content: 'parent' },
        { path: '/additional/AGENTS.MD', content: 'additional' },
        { path: '/sdk/OTHER.md', content: 'keep' },
      ],
    })

    expect(result.agentsFiles).toEqual([{ path: '/sdk/OTHER.md', content: 'keep' }])
  })
})

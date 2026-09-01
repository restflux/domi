import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { SkillTriggerEvent, SkillUsageStats } from '@domi/shared'
import {
  detectSkillTrigger,
  createSkillTriggerRecorder,
  readSessionSkillTriggers,
  readWorkspaceSkillUsage,
  type SkillTriggerRoot,
  type SkillTriggerRecorderDeps,
} from './skill-trigger-recorder'

const WORKSPACE_SKILLS = 'C:\\data\\ws\\skills'
const GLOBAL_SKILLS = 'C:\\Users\\me\\.agents\\skills'

const ROOTS: readonly SkillTriggerRoot[] = [
  { root: WORKSPACE_SKILLS, source: 'workspace' },
  { root: GLOBAL_SKILLS, source: 'global' },
]

describe('detectSkillTrigger 纯函数', () => {
  test('命中工作区技能根目录下的 SKILL.md', () => {
    expect(detectSkillTrigger(join(WORKSPACE_SKILLS, 'tdd', 'SKILL.md'), ROOTS)).toEqual({
      slug: 'tdd',
      source: 'workspace',
    })
  })

  test('命中外部全局技能根目录下的 SKILL.md', () => {
    expect(detectSkillTrigger(join(GLOBAL_SKILLS, 'tdd', 'SKILL.md'), ROOTS)).toEqual({
      slug: 'tdd',
      source: 'global',
    })
  })

  test('技能目录内的资源子文件也视为触发', () => {
    expect(detectSkillTrigger(join(WORKSPACE_SKILLS, 'tdd', 'scripts', 'run.sh'), ROOTS)).toEqual({
      slug: 'tdd',
      source: 'workspace',
    })
  })

  test('深层嵌套文件只取第一段作为 slug', () => {
    expect(
      detectSkillTrigger(join(WORKSPACE_SKILLS, 'code-review', 'a', 'b', 'c.md'), ROOTS),
    ).toEqual({ slug: 'code-review', source: 'workspace' })
  })

  test('路径恰好等于技能根目录时不视为触发', () => {
    expect(detectSkillTrigger(WORKSPACE_SKILLS, ROOTS)).toBeNull()
  })

  test('前缀相似的兄弟目录不误命中(边界安全)', () => {
    expect(detectSkillTrigger('C:\\data\\ws\\skills-other\\x\\SKILL.md', ROOTS)).toBeNull()
  })

  test('技能根之外的普通文件返回 null', () => {
    expect(detectSkillTrigger('C:\\data\\src\\main.ts', ROOTS)).toBeNull()
    expect(detectSkillTrigger('', ROOTS)).toBeNull()
  })

  test('Windows 大小写不敏感匹配', () => {
    expect(detectSkillTrigger('C:\\DATA\\WS\\Skills\\TDD\\SKILL.md', ROOTS)).toEqual({
      slug: 'tdd',
      source: 'workspace',
    })
  })

  test('相对路径先解析再匹配', () => {
    expect(detectSkillTrigger(join(WORKSPACE_SKILLS, '..', 'skills-other', 'x.md'), ROOTS)).toBeNull()
  })
})

describe('技能触发记录器', () => {
  function buildRecorder(deps: Partial<SkillTriggerRecorderDeps> = {}): {
    recorder: ReturnType<typeof createSkillTriggerRecorder>
    appended: string[]
    written: Map<string, string>
    usagePath: string
  } {
    const appended: string[] = []
    const written = new Map<string, string>()
    const usagePath = 'C:\\data\\ws\\skill-usage.json'
    const sessionPath = 'C:\\data\\agent-sessions\\s1.skill-triggers.jsonl'

    const defaults: SkillTriggerRecorderDeps = {
      appendFileSync: (_path, data) => appended.push(data),
      readFileSync: (path) => written.get(path) ?? '{"skills":{}}',
      writeFileSync: (path, data) => written.set(path, data),
      existsSync: (path) => written.has(path),
    }
    const recorder = createSkillTriggerRecorder({
      sessionId: 's1',
      workspaceSlug: 'ws',
      skillRoots: ROOTS,
      skillNames: new Map([['tdd', '测试驱动开发']]),
      sessionTriggersPath: sessionPath,
      workspaceUsagePath: usagePath,
      now: () => 1_700_000_000_000,
      deps: { ...defaults, ...deps },
    })
    return { recorder, appended, written, usagePath }
  }

  test('命中技能文件时返回事件、追加 JSONL 并更新聚合', () => {
    const { recorder, appended, written, usagePath } = buildRecorder()
    const event = recorder.record(join(WORKSPACE_SKILLS, 'tdd', 'SKILL.md'), 'call-1')

    expect(event).not.toBeNull()
    expect(event?.skillSlug).toBe('tdd')
    expect(event?.skillName).toBe('测试驱动开发')
    expect(event?.source).toBe('workspace')
    expect(event?.toolCallId).toBe('call-1')
    expect(event?.timestamp).toBe(1_700_000_000_000)

    expect(appended).toHaveLength(1)
    const parsed: SkillTriggerEvent = JSON.parse(appended[0]!)
    expect(parsed.skillSlug).toBe('tdd')

    const usage = JSON.parse(written.get(usagePath)!) as { skills: Record<string, SkillUsageStats> }
    expect(usage.skills['workspace:tdd']?.triggerCount).toBe(1)
    expect(usage.skills['workspace:tdd']?.lastTriggeredAt).toBe(1_700_000_000_000)
  })

  test('同一 toolCallId 只记录一次', () => {
    const { recorder, appended } = buildRecorder()
    recorder.record(join(WORKSPACE_SKILLS, 'tdd', 'SKILL.md'), 'call-1')
    const second = recorder.record(join(WORKSPACE_SKILLS, 'tdd', 'extra.md'), 'call-1')
    expect(second).toBeNull()
    expect(appended).toHaveLength(1)
  })

  test('不同 toolCallId 累计聚合计数', () => {
    const { recorder, written, usagePath } = buildRecorder()
    recorder.record(join(WORKSPACE_SKILLS, 'tdd', 'SKILL.md'), 'call-1')
    recorder.record(join(WORKSPACE_SKILLS, 'tdd', 'SKILL.md'), 'call-2')
    const usage = JSON.parse(written.get(usagePath)!) as { skills: Record<string, SkillUsageStats> }
    expect(usage.skills['workspace:tdd']?.triggerCount).toBe(2)
  })

  test('同 slug 不同来源分开计数', () => {
    const { recorder, written, usagePath } = buildRecorder()
    recorder.record(join(WORKSPACE_SKILLS, 'tdd', 'SKILL.md'), 'call-1')
    recorder.record(join(GLOBAL_SKILLS, 'tdd', 'SKILL.md'), 'call-2')
    const usage = JSON.parse(written.get(usagePath)!) as { skills: Record<string, SkillUsageStats> }
    expect(usage.skills['workspace:tdd']?.triggerCount).toBe(1)
    expect(usage.skills['global:tdd']?.triggerCount).toBe(1)
  })

  test('非技能路径不记录且不写文件', () => {
    const { recorder, appended, written } = buildRecorder()
    const event = recorder.record('C:\\data\\src\\main.ts', 'call-1')
    expect(event).toBeNull()
    expect(appended).toHaveLength(0)
    expect(written.size).toBe(0)
  })

  test('聚合文件损坏时重建计数而不抛错', () => {
    const { recorder, written, usagePath } = buildRecorder()
    written.set(usagePath, '{invalid json')
    recorder.record(join(WORKSPACE_SKILLS, 'tdd', 'SKILL.md'), 'call-1')
    const usage = JSON.parse(written.get(usagePath)!) as { skills: Record<string, SkillUsageStats> }
    expect(usage.skills['workspace:tdd']?.triggerCount).toBe(1)
  })

  test('追加明细失败时静默降级,不影响返回事件', () => {
    const { recorder } = buildRecorder({
      appendFileSync: () => {
        throw new Error('disk full')
      },
    })
    const event = recorder.record(join(WORKSPACE_SKILLS, 'tdd', 'SKILL.md'), 'call-1')
    expect(event?.skillSlug).toBe('tdd')
  })

  test('聚合写入失败时静默降级', () => {
    const { recorder } = buildRecorder({
      writeFileSync: () => {
        throw new Error('disk full')
      },
    })
    const event = recorder.record(join(WORKSPACE_SKILLS, 'tdd', 'SKILL.md'), 'call-1')
    expect(event?.skillSlug).toBe('tdd')
  })
})

describe('读取函数', () => {
  test('readSessionSkillTriggers 逐行解析并容忍坏行', () => {
    const { mkdtempSync, writeFileSync, rmSync } = importFs()
    const dir = mkdtempSync(join(importOsTmp(), 'domi-skill-triggers-'))
    const file = join(dir, 's.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({
          sessionId: 's1',
          skillSlug: 'tdd',
          skillName: 'tdd',
          source: 'workspace',
          filePath: 'tdd/SKILL.md',
          toolCallId: 'call-1',
          timestamp: 1,
        }),
        'not-json',
        JSON.stringify({
          sessionId: 's1',
          skillSlug: 'diagnosing-bugs',
          skillName: 'diagnosing-bugs',
          source: 'global',
          filePath: 'diagnosing-bugs/SKILL.md',
          toolCallId: 'call-2',
          timestamp: 2,
        }),
        '',
      ].join('\n'),
      'utf-8',
    )
    const events = readSessionSkillTriggers(file)
    expect(events).toHaveLength(2)
    expect(events[0]?.skillSlug).toBe('tdd')
    expect(events[1]?.skillSlug).toBe('diagnosing-bugs')
    rmSync(dir, { recursive: true, force: true })
  })

  test('readSessionSkillTriggers 文件缺失返回空数组', () => {
    expect(readSessionSkillTriggers('C:\\missing\\no.jsonl')).toEqual([])
  })

  test('readWorkspaceSkillUsage 返回按计数降序的统计', () => {
    const { mkdtempSync, writeFileSync, rmSync } = importFs()
    const dir = mkdtempSync(join(importOsTmp(), 'domi-skill-usage-'))
    const file = join(dir, 'usage.json')
    writeFileSync(
      file,
      JSON.stringify({
        skills: {
          'workspace:tdd': { skillSlug: 'tdd', skillName: 'tdd', source: 'workspace', triggerCount: 3, lastTriggeredAt: 30 },
          'global:diagnosing-bugs': { skillSlug: 'diagnosing-bugs', skillName: 'diagnosing-bugs', source: 'global', triggerCount: 1, lastTriggeredAt: 10 },
        },
      }),
      'utf-8',
    )
    const stats = readWorkspaceSkillUsage(file)
    expect(stats[0]?.skillSlug).toBe('tdd')
    expect(stats).toHaveLength(2)
    rmSync(dir, { recursive: true, force: true })
  })

  test('readWorkspaceSkillUsage 文件缺失返回空数组', () => {
    expect(readWorkspaceSkillUsage('C:\\missing\\usage.json')).toEqual([])
  })
})

function importFs(): typeof import('node:fs') {
  return require('node:fs') as typeof import('node:fs')
}

function importOsTmp(): string {
  return (require('node:os') as typeof import('node:os')).tmpdir()
}

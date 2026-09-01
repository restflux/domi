import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readDefaultSkill(name: string): string {
  return readFileSync(resolve(import.meta.dir, `../../../default-skills/${name}/SKILL.md`), 'utf-8')
}

describe('Coding Fast Lane 默认 Skills', () => {
  test('Given a low-risk coding task When Skills are discovered Then writing-plans does not claim every multi-step change', () => {
    const skill = readDefaultSkill('writing-plans')

    expect(skill).toContain('version: "1.0.7"')
    expect(skill).toContain('Do NOT use for low-risk coding')
    expect(skill).toContain('用户明确要求实施计划')
    expect(skill).not.toContain('description: Use when you have a spec or requirements for a multi-step task, before touching code')
  })

  test('Given an approved plan without explicit checkpoints When executing Then batches continue without adding a user wait', () => {
    const skill = readDefaultSkill('executing-plans')

    expect(skill).toContain('version: "1.0.6"')
    expect(skill).toContain('默认连续执行')
    expect(skill).toContain('不要仅为了批次边界暂停等待用户')
  })

  test('Given ordinary planned work When executing Then the plan itself does not force Red/Green', () => {
    const writing = readDefaultSkill('writing-plans')
    const executing = readDefaultSkill('executing-plans')

    expect(writing).toContain('不得把普通功能和局部 bug 自动升级成完整 TDD')
    expect(executing).toContain('A plan does not itself trigger full TDD')
    expect(executing).toContain('same high-risk boundary')
    expect(executing).toContain('不要因为计划文本写了“Red/Green”就机械扩大流程')
  })
})

describe('Coding 技能包 v1 契约', () => {
  const codingSkills = [
    { slug: 'diagnosing-bugs', version: '1.0.1' },
    { slug: 'tdd', version: '1.0.1' },
    { slug: 'code-review', version: '1.0.0' },
    { slug: 'improve-codebase-architecture', version: '1.0.0' },
  ] as const

  for (const { slug, version } of codingSkills) {
    test(`Given ${slug} When 校验契约 Then frontmatter 完整、中文内容、MIT 出处、含负样本`, () => {
      const skill = readDefaultSkill(slug)

      // frontmatter 契约：name / description / version 缺一不可（version 驱动老用户升级分发）
      expect(skill).toMatch(/^---\r?\nname: /)
      expect(skill).toContain(`name: ${slug}`)
      expect(skill).toMatch(/\ndescription: .+/)
      expect(skill).toContain(`version: "${version}"`)
      // MIT 出处声明（混合来源改造的合规要求）
      expect(skill).toContain('mattpocock/skills')
      expect(skill).toContain('MIT')
      // 中文正文与防误触发负样本
      expect(skill).toMatch(/[\u4e00-\u9fa5]/)
      expect(skill).toContain('不要')
    })
  }

  test('Given diagnosing-bugs When 读取 description Then 难 bug 触发且简单报错不扩张流程', () => {
    const skill = readDefaultSkill('diagnosing-bugs')
    expect(skill).toContain('debug')
    expect(skill).toContain('无法稳定复现')
    expect(skill).toContain('不要仅因用户说“有 bug/报错”')
    expect(skill).toContain('建立反馈回路不等于自动触发完整 TDD')
    expect(skill).toContain('等高风险门槛')
  })

  test('Given tdd When 读取 description Then 仅按明确意图或高风险行为触发', () => {
    const skill = readDefaultSkill('tdd')
    const description = skill.match(/^description: (.+)$/m)?.[1] ?? ''

    expect(description).toContain('红绿重构')
    expect(description).toContain('Agent 判断')
    expect(description).toContain('高风险行为')
    expect(description).toContain('不得仅因任务是新功能或 bug 修复而触发')
    expect(description).toContain('普通 CRUD')
    expect(description).not.toContain('当用户要做新功能、修 bug')
    expect(skill).toContain('风险处于中间地带时')
    expect(skill).toContain('bun test')
  })

  test('Given code-review When 读取 description Then 覆盖审查触发信号且对接单 reviewer', () => {
    const skill = readDefaultSkill('code-review')
    expect(skill).toContain('审查')
    expect(skill).toContain('collaboration')
    expect(skill).toContain('一轮')
  })

  test('Given improve-codebase-architecture When 读取 description Then 覆盖架构触发信号且引用 ADR', () => {
    const skill = readDefaultSkill('improve-codebase-architecture')
    expect(skill).toContain('架构')
    expect(skill).toContain('ADR')
    expect(skill).toContain('CONTEXT.md')
  })
})

describe('高频默认 Skill 路由边界', () => {
  test('Given pure reminder When routing Then automation points to Domi Reminder instead of broad future-word matching', () => {
    const skill = readDefaultSkill('automation')
    const description = skill.match(/^description: (.+)$/m)?.[1] ?? ''

    expect(skill).toContain('version: "1.0.14"')
    expect(description).toContain('明确要求未来自动执行')
    expect(description).toContain('纯提醒、闹钟、倒计时应使用 Domi Reminder')
    expect(description).toContain('普通“以后/下次/持续”措辞')
    expect(skill).not.toContain('权限模式：默认 `bypassPermissions`')
    expect(skill).not.toContain('`permissionMode`（权限模式）')
  })

  test('Given ordinary task frustration When routing Then domi-coach does not claim it without Domi or long-term intent', () => {
    const skill = readDefaultSkill('domi-coach')
    const description = skill.match(/^description: (.+)$/m)?.[1] ?? ''

    expect(skill).toContain('version: "1.0.10"')
    expect(description).toContain('明确讨论 Domi/Agent/Skill/Chat 工具')
    expect(description).toContain('普通任务抱怨、一次性修改')
    expect(skill).toContain('普通一次性任务永远不要被知识维护建议打断')
  })

  test('Given ordinary how-to When routing Then find-skills answers directly and separates search from installation', () => {
    const skill = readDefaultSkill('find-skills')
    const description = skill.match(/^description: (.+)$/m)?.[1] ?? ''

    expect(skill).toContain('version: "1.0.2"')
    expect(description).toContain('explicitly asks to find, browse, compare, or install a Skill')
    expect(description).toContain('Do not trigger for ordinary “how do I do X”')
    expect(skill).toContain('未经用户明确确认，不得执行任何安装')
    expect(skill).toContain('不得使用 `-g -y`')
  })

  test('Given authenticated custom HTTP tool When configured Then tool-builder requires credential references', () => {
    const skill = readDefaultSkill('tool-builder')

    expect(skill).toContain('version: "1.0.3"')
    expect(skill).toContain('{{credential.<key>}}')
    expect(skill).toContain('URL 不支持凭据注入')
    expect(skill).not.toContain('"Authorization": "Bearer YOUR_API_KEY"')
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const workflow = readFileSync(
  join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'),
  'utf8',
)

describe('Domi Release Candidate workflow', () => {
  test('Linux 构建只生成 Actions artifacts，不触发 electron-builder 自动发布', () => {
    expect(workflow).toContain('run: bun run dist:linux -- --publish never')
  })

  test('Linux smoke 使用正式 sandbox 路径启动临时解包产物', () => {
    expect(workflow).toContain('sudo chown root:root "$chrome_sandbox"')
    expect(workflow).toContain('sudo chmod 4755 "$chrome_sandbox"')
    expect(workflow).not.toContain('--no-sandbox')
  })

  test('发布校验会执行 workflow 自身的发布边界测试', () => {
    expect(workflow).toContain('scripts/release-workflow.test.ts')
  })

  test('只有 Draft Pre-release job 获取 GitHub 发布 token', () => {
    expect(workflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g)).toHaveLength(1)
  })
})

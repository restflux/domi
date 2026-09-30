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

  test('tag 构建创建 Draft Release，默认不标记为 Pre-release', () => {
    expect(workflow).toContain('name: 创建 Draft Release')
    expect(workflow).toContain('if [[ "$is_draft" != "true" || "$is_prerelease" != "false" ]]')
    expect(workflow).toContain('拒绝覆盖非 Draft Release')
    expect(workflow).toContain('--draft')
    expect(workflow).not.toContain('--prerelease')
  })

  test('只有 Draft Release job 获取 GitHub 发布 token', () => {
    expect(workflow.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g)).toHaveLength(1)
  })

  test('macOS arm64 构建不自动发布且资产进入统一校验', () => {
    expect(workflow).toContain('runs-on: macos-latest')
    expect(workflow).toContain('run: bun run dist:mac -- --publish never')
    expect(workflow).toContain('name: domi-macos-arm64')
    expect(workflow).toContain('sha256sum --check SHA256SUMS-macos.txt')
    // arm64 需要 ad-hoc 签名才能启动，mac job 不禁用签名身份自动发现
    const macosJob = workflow.slice(workflow.indexOf('  macos:'), workflow.indexOf('  draft-release:'))
    expect(macosJob).not.toContain('CSC_IDENTITY_AUTO_DISCOVERY')
  })
})

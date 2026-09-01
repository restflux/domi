import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AuditWriter, type AuditSink } from './audit-writer.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempAuditDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'domi-audit-'))
  tempDirs.push(dir)
  return dir
}

describe('AuditWriter', () => {
  test('写入版本化 JSONL，并脱敏凭据、userinfo、token、环境变量和命令输出', async () => {
    const auditDir = await tempAuditDir()
    const writer = new AuditWriter({ auditDir })
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456'
    const opaqueSecret = 'plain-credential-value'

    expect(await writer.record({
      category: 'execution',
      action: 'command_finished',
      data: {
        apiKey: secret,
        headers: { Authorization: `Bearer ${secret}`, Cookie: `sid=${secret}`, 'X-API-Key': opaqueSecret },
        url: `https://user:pass@example.com/path?token=${secret}`,
        environment: { HOME: '/home/user', SECRET: secret },
        stdout: `${secret}\n${'x'.repeat(4_000)}`,
      },
    })).toEqual({ written: true })

    const evidence = await writer.readEvidence()
    expect(evidence.corruptLines).toBe(0)
    expect(evidence.records).toHaveLength(1)
    expect(evidence.records[0]).toMatchObject({ version: 1, category: 'execution', action: 'command_finished' })
    const persisted = JSON.stringify(evidence.records[0])
    expect(persisted).not.toContain(secret)
    expect(persisted).not.toContain(opaqueSecret)
    expect(persisted).not.toContain('user:pass')
    expect(persisted).not.toContain('/home/user')
    expect(persisted).toContain('[REDACTED]')
    expect(persisted.length).toBeLessThan(5_000)
  })

  test('明显 AWS、GitHub、sk、Bearer 与 JWT secret 的脱敏行为保持不变', async () => {
    const auditDir = await tempAuditDir()
    const writer = new AuditWriter({ auditDir })
    const secrets = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
      'sk-abcdefghijklmnop123456',
      'Bearer abcdefghijklmnop123456',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456',
    ]

    await writer.record({ category: 'test', action: 'redaction_regression', data: { output: secrets.join('\n') } })

    const persisted = JSON.stringify((await writer.readEvidence()).records)
    for (const secret of secrets) expect(persisted).not.toContain(secret)
    expect(persisted).toContain('Bearer [REDACTED]')
  })

  test('单条记录有硬上限，且并发 record 按调用顺序追加', async () => {
    const lines: string[] = []
    const sink: AuditSink = {
      async append(line) {
        await new Promise((resolve) => setTimeout(resolve, line.includes('first') ? 10 : 0))
        lines.push(line)
      },
    }
    const writer = new AuditWriter({ auditDir: await tempAuditDir(), sink, maxEventBytes: 1_024 })

    await Promise.all([
      writer.record({ category: 'test', action: 'first', data: { body: 'a'.repeat(20_000) } }),
      writer.record({ category: 'test', action: 'second', data: { body: 'ok' } }),
    ])

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('first')
    expect(lines[1]).toContain('second')
    expect(Buffer.byteLength(lines[0]!, 'utf8')).toBeLessThanOrEqual(1_025)
  })

  test('损坏行可见但不阻止读取后续证据，写失败返回稳定类别', async () => {
    const auditDir = await tempAuditDir()
    const writer = new AuditWriter({ auditDir })
    await writeFile(writer.filePath, '{broken json}', 'utf8')
    await writer.record({ category: 'managed_web_access', action: 'authorize', data: { decision: 'allow' } })

    expect(await writer.readEvidence()).toMatchObject({
      corruptLines: 1,
      records: [{ version: 1, category: 'managed_web_access' }],
    })

    const failingWriter = new AuditWriter({
      auditDir,
      sink: { append: async () => { throw new Error('contains-super-secret') } },
    })
    expect(await failingWriter.record({ category: 'test', action: 'fail', data: { token: 'super-secret' } })).toEqual({
      written: false,
      errorCategory: 'write_failed',
    })
  })
})

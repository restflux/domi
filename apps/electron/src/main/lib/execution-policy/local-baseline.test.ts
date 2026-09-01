import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureLocalBaseline } from './local-baseline.ts'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function run(cwd: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(await new Response(process.stderr).text())
}

describe('Local Baseline capture', () => {
  test('Given Git porcelain output When baseline is captured Then tracked dirty and untracked paths are preserved', async () => {
    const baseline = await captureLocalBaseline('C:\\repo', async () => ({
      exitCode: 0,
      stdout: ' M src/app.ts\0?? notes with spaces.txt\0',
      stderr: '',
    }))

    expect(baseline).toEqual({
      status: 'captured',
      paths: ['C:\\repo\\src\\app.ts', 'C:\\repo\\notes with spaces.txt'],
    })
  })

  test('Given Git status cannot be read When baseline is captured Then failure remains explicit for conservative policy', async () => {
    const baseline = await captureLocalBaseline('/repo', async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' }))

    expect(baseline).toMatchObject({ status: 'unknown', paths: [] })
  })

  test('Given a real Git checkout with tracked and untracked changes When the run starts Then both paths are captured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'domi-local-baseline-'))
    tempDirs.push(dir)
    await run(dir, ['init'])
    await run(dir, ['config', 'user.email', 'test@example.com'])
    await run(dir, ['config', 'user.name', 'Domi Test'])
    await writeFile(join(dir, 'tracked.txt'), 'before')
    await run(dir, ['add', 'tracked.txt'])
    await run(dir, ['commit', '-m', 'baseline'])
    await writeFile(join(dir, 'tracked.txt'), 'after')
    await writeFile(join(dir, 'untracked.txt'), 'new')

    const baseline = await captureLocalBaseline(dir)

    expect(baseline.status).toBe('captured')
    expect(baseline.paths).toContain(join(dir, 'tracked.txt'))
    expect(baseline.paths).toContain(join(dir, 'untracked.txt'))
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPiFocusedValidationTools } from './pi-focused-validation-tool.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-focused-validation-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'example.test.ts'), '')
  return root
}

const sdk = {
  defineTool<T>(tool: T): T { return tool },
}

describe('PlanFocusedValidation Pi product tool', () => {
  test('Given an Agent cwd When the tool plans validation Then projectRoot is host-fixed and only relative changedFiles are accepted from the model', async () => {
    const agentCwd = await createProject()
    const [tool] = buildPiFocusedValidationTools(sdk as never, { agentCwd }) as unknown as Array<{
      name: string
      parameters: { properties: Record<string, unknown> }
      execute: (id: string, params: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>
        details: Record<string, unknown>
      }>
    }>

    expect(tool!.name).toBe('PlanFocusedValidation')
    expect(Object.keys(tool!.parameters.properties)).toEqual(['changedFiles'])

    const result = await tool!.execute('tool-1', {
      changedFiles: ['src\\example.test.ts'],
      projectRoot: join(agentCwd, '..', 'spoofed'),
    })
    expect(result.details).toMatchObject({
      confidence: 'high',
      testFiles: ['src/example.test.ts'],
      command: 'bun test "src/example.test.ts"',
      affectedPackages: [],
      typecheckCommands: [],
      omittedTypecheckCount: 0,
    })
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.details)
  })

  test('Given a workspace source change When the tool plans validation Then it returns safe package typechecks without executing them', async () => {
    const agentCwd = await createProject()
    await writeFile(join(agentCwd, 'package.json'), JSON.stringify({
      workspaces: ['packages/*'],
      scripts: { test: 'bun test' },
    }))
    await mkdir(join(agentCwd, 'packages', 'shared', 'src'), { recursive: true })
    await writeFile(join(agentCwd, 'packages', 'shared', 'package.json'), JSON.stringify({
      name: '@fixture/shared',
      scripts: { typecheck: 'tsc --noEmit' },
    }))
    await writeFile(join(agentCwd, 'packages', 'shared', 'src', 'index.ts'), 'export {}\n')
    const [tool] = buildPiFocusedValidationTools(sdk as never, { agentCwd }) as unknown as Array<{
      execute: (id: string, params: { changedFiles: string[] }) => Promise<{ details: Record<string, unknown> }>
    }>

    expect((await tool!.execute('tool-1', { changedFiles: ['packages/shared/src/index.ts'] })).details)
      .toMatchObject({
        affectedPackages: [{ name: '@fixture/shared', path: 'packages/shared', relation: 'direct' }],
        typecheckCommands: ['bun run --cwd "packages/shared" typecheck'],
      })
  })

  test('Given no Agent cwd When builtin tools are built Then the focused planner is not exposed', () => {
    expect(buildPiFocusedValidationTools(sdk as never, {})).toEqual([])
  })

  test('Given an absolute changed file When the tool executes Then planner validation rejects it', async () => {
    const agentCwd = await createProject()
    const [tool] = buildPiFocusedValidationTools(sdk as never, { agentCwd }) as unknown as Array<{
      execute: (id: string, params: { changedFiles: string[] }) => Promise<unknown>
    }>

    await expect(tool!.execute('tool-1', { changedFiles: [join(agentCwd, 'src', 'example.test.ts')] }))
      .rejects.toThrow('changedFiles')
  })

  test('Given Pi aborts the tool call When planning starts Then the SDK signal cancels traversal', async () => {
    const agentCwd = await createProject()
    const [tool] = buildPiFocusedValidationTools(sdk as never, { agentCwd }) as unknown as Array<{
      execute: (id: string, params: { changedFiles: string[] }, signal: AbortSignal) => Promise<unknown>
    }>
    const controller = new AbortController()
    controller.abort()

    await expect(tool!.execute('tool-1', { changedFiles: ['src/example.ts'] }, controller.signal))
      .rejects.toThrow()
  })
})

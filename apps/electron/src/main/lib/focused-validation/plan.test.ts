import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  FOCUSED_VALIDATION_MAX_COMMAND_LENGTH,
  FOCUSED_VALIDATION_MAX_SCANNED_TEST_FILES,
  FOCUSED_VALIDATION_MAX_SINGLE_TEST_BYTES,
  FOCUSED_VALIDATION_MAX_TEST_FILES,
  FOCUSED_VALIDATION_MAX_WORKSPACE_PACKAGES,
  planFocusedValidation,
} from './plan.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createProject(files: Record<string, string>, testScript = 'bun test'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'focused-validation-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: testScript } }))
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, ...relativePath.split('/'))
    await mkdir(join(absolutePath, '..'), { recursive: true })
    await writeFile(absolutePath, content)
  }
  return root
}

async function createWorkspaceProject(files: Record<string, string>): Promise<string> {
  return createProject({
    'package.json': JSON.stringify({
      name: 'fixture-root',
      private: true,
      workspaces: ['packages/*', 'apps/*'],
      scripts: { test: 'bun test' },
    }),
    'packages/shared/package.json': JSON.stringify({
      name: '@fixture/shared',
      scripts: { typecheck: 'tsc --noEmit' },
    }),
    'apps/electron/package.json': JSON.stringify({
      name: '@fixture/electron',
      dependencies: { '@fixture/shared': 'workspace:*' },
      scripts: { typecheck: 'tsc --noEmit' },
    }),
    ...files,
  })
}

describe('planFocusedValidation', () => {
  test('Given a source change inside one workspace When planning Then its safe package typecheck is included without executing it', async () => {
    const projectRoot = await createWorkspaceProject({
      'apps/electron/src/main.ts': 'export const main = true\n',
    })

    expect(await planFocusedValidation({
      projectRoot,
      changedFiles: ['apps/electron/src/main.ts'],
    })).toMatchObject({
      confidence: 'high',
      affectedPackages: [{ name: '@fixture/electron', path: 'apps/electron', relation: 'direct' }],
      typecheckCommands: ['bun run --cwd "apps/electron" typecheck'],
      omittedTypecheckCount: 0,
    })
  })

  test('Given a shared workspace dependency changes When planning Then direct and transitive dependents are typechecked in dependency order', async () => {
    const projectRoot = await createWorkspaceProject({
      'packages/shared/src/index.ts': 'export const shared = true\n',
      'packages/core/package.json': JSON.stringify({
        name: '@fixture/core',
        dependencies: { '@fixture/shared': 'workspace:*' },
        scripts: { typecheck: 'tsc --noEmit' },
      }),
      'packages/core/src/index.ts': 'export const core = true\n',
      'apps/electron/package.json': JSON.stringify({
        name: '@fixture/electron',
        dependencies: { '@fixture/core': 'workspace:*' },
        scripts: { typecheck: 'tsc --noEmit' },
      }),
    })

    expect(await planFocusedValidation({
      projectRoot,
      changedFiles: ['packages/shared/src/index.ts'],
    })).toMatchObject({
      affectedPackages: [
        { name: '@fixture/shared', path: 'packages/shared', relation: 'direct' },
        { name: '@fixture/core', path: 'packages/core', relation: 'dependent' },
        { name: '@fixture/electron', path: 'apps/electron', relation: 'dependent' },
      ],
      typecheckCommands: [
        'bun run --cwd "packages/shared" typecheck',
        'bun run --cwd "packages/core" typecheck',
        'bun run --cwd "apps/electron" typecheck',
      ],
    })
  })

  test('Given a workspace package has an unsafe typecheck script When planning Then it is identified but no command is invented', async () => {
    const projectRoot = await createWorkspaceProject({
      'apps/electron/package.json': JSON.stringify({
        name: '@fixture/electron',
        scripts: { typecheck: 'tsc --noEmit && node scripts/postcheck.js' },
      }),
      'apps/electron/src/main.ts': 'export const main = true\n',
    })

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['apps/electron/src/main.ts'] }))
      .toMatchObject({
        confidence: 'none',
        affectedPackages: [{ name: '@fixture/electron', path: 'apps/electron', relation: 'direct' }],
        typecheckCommands: [],
        reasons: ['no-matching-tests', 'affected-packages', 'non-targetable-typecheck-script'],
      })
  })

  test('Given only part of an affected dependency closure has safe typechecks When planning Then confidence and omissions stay partial', async () => {
    const projectRoot = await createWorkspaceProject({
      'packages/shared/src/index.ts': 'export const shared = true\n',
      'apps/electron/package.json': JSON.stringify({
        name: '@fixture/electron',
        dependencies: { '@fixture/shared': 'workspace:*' },
        scripts: { typecheck: 'node scripts/check.js' },
      }),
    })

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['packages/shared/src/index.ts'] }))
      .toMatchObject({
        confidence: 'medium',
        affectedPackages: [
          { name: '@fixture/shared', path: 'packages/shared', relation: 'direct' },
          { name: '@fixture/electron', path: 'apps/electron', relation: 'dependent' },
        ],
        typecheckCommands: ['bun run --cwd "packages/shared" typecheck'],
        omittedTypecheckCount: 1,
        reasons: ['no-matching-tests', 'affected-packages', 'package-typecheck', 'non-targetable-typecheck-script'],
      })
  })

  test('Given a root configuration file changes When planning Then package scope is uncertain and no partial package typecheck is proposed', async () => {
    const projectRoot = await createWorkspaceProject({
      'tsconfig.json': '{}',
    })

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['tsconfig.json'] }))
      .toMatchObject({
        confidence: 'none',
        affectedPackages: [],
        typecheckCommands: [],
        reasons: ['no-matching-tests', 'root-scope-change'],
      })
  })

  test('Given a root configuration and a package source both change When planning Then uncertain root scope suppresses partial package typechecks', async () => {
    const projectRoot = await createWorkspaceProject({
      'tsconfig.json': '{}',
      'apps/electron/src/main.ts': 'export const main = true\n',
    })

    expect(await planFocusedValidation({
      projectRoot,
      changedFiles: ['tsconfig.json', 'apps/electron/src/main.ts'],
    })).toMatchObject({
      confidence: 'none',
      affectedPackages: [],
      typecheckCommands: [],
      reasons: ['no-matching-tests', 'root-scope-change'],
    })
  })

  test('Given a workspace path contains cross-shell syntax When planning Then no typecheck command is invented', async () => {
    const projectRoot = await createProject({
      'package.json': JSON.stringify({ workspaces: ['packages/*'], scripts: { test: 'bun test' } }),
      'packages/$unsafe/package.json': JSON.stringify({
        name: '@fixture/unsafe',
        scripts: { typecheck: 'tsc --noEmit' },
      }),
      'packages/$unsafe/src/index.ts': 'export {}\n',
    })

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['packages/$unsafe/src/index.ts'] }))
      .toMatchObject({
        confidence: 'none',
        affectedPackages: [{ name: '@fixture/unsafe', path: 'packages/$unsafe', relation: 'direct' }],
        typecheckCommands: [],
        reasons: ['no-matching-tests', 'affected-packages', 'non-targetable-typecheck-script'],
      })
  })

  test('Given an object-form workspace manifest When planning Then package discovery remains supported', async () => {
    const projectRoot = await createProject({
      'package.json': JSON.stringify({ workspaces: { packages: ['modules/*'] }, scripts: { test: 'bun test' } }),
      'modules/service/package.json': JSON.stringify({
        name: '@fixture/service',
        scripts: { typecheck: 'tsc --noEmit' },
      }),
      'modules/service/src/index.ts': 'export {}\n',
    })

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['modules/service/src/index.ts'] }))
      .toMatchObject({
        affectedPackages: [{ name: '@fixture/service', path: 'modules/service', relation: 'direct' }],
        typecheckCommands: ['bun run --cwd "modules/service" typecheck'],
      })
  })

  test('Given workspace discovery exceeds its package budget When planning Then package typechecks fail closed', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ workspaces: ['packages/*'], scripts: { test: 'bun test' } }),
    }
    for (let index = 0; index <= FOCUSED_VALIDATION_MAX_WORKSPACE_PACKAGES; index += 1) {
      const packagePath = `packages/package-${String(index).padStart(3, '0')}`
      files[`${packagePath}/package.json`] = JSON.stringify({
        name: `@fixture/package-${index}`,
        scripts: { typecheck: 'tsc --noEmit' },
      })
    }
    const projectRoot = await createProject(files)

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['packages/package-000/src/index.ts'] }))
      .toMatchObject({
        confidence: 'none',
        affectedPackages: [],
        typecheckCommands: [],
        reasons: ['no-matching-tests', 'workspace-scan-cap'],
      })
  })

  test('Given a changed workspace source file was deleted When planning Then its package typecheck is still planned', async () => {
    const projectRoot = await createWorkspaceProject({})

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['packages/shared/src/deleted.ts'] }))
      .toMatchObject({
        confidence: 'high',
        affectedPackages: [
          { name: '@fixture/shared', path: 'packages/shared', relation: 'direct' },
          { name: '@fixture/electron', path: 'apps/electron', relation: 'dependent' },
        ],
        typecheckCommands: [
          'bun run --cwd "packages/shared" typecheck',
          'bun run --cwd "apps/electron" typecheck',
        ],
      })
  })

  test('Given a changed test file When planning Then the test selects itself and produces a targetable Bun command', async () => {
    const projectRoot = await createProject({
      'src/example.test.ts': 'import { test } from "bun:test"\n',
    })

    expect(await planFocusedValidation({
      projectRoot,
      changedFiles: ['src/example.test.ts'],
    })).toMatchObject({
      confidence: 'high',
      testFiles: ['src/example.test.ts'],
      command: 'bun test "src/example.test.ts"',
      omittedTestCount: 0,
    })
  })

  test('Given a changed test was deleted When planning Then it is not returned as an executable target', async () => {
    const projectRoot = await createProject({})

    expect(await planFocusedValidation({
      projectRoot,
      changedFiles: ['src/deleted.test.ts'],
    })).toMatchObject({
      confidence: 'none',
      testFiles: [],
      command: null,
    })
  })

  test('Given a changed source file When a sibling test exists Then the sibling test is selected', async () => {
    const projectRoot = await createProject({
      'src/example.ts': 'export const value = 1\n',
      'src/example.test.ts': 'import { value } from "./example"\n',
    })

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['src/example.ts'] }))
      .toMatchObject({
        confidence: 'high',
        testFiles: ['src/example.test.ts'],
        command: 'bun test "src/example.test.ts"',
      })
  })

  test('Given a changed source and a sibling test with a different JS/TS extension When planning Then naming alone selects it', async () => {
    const projectRoot = await createProject({
      'src/widget.ts': 'export const Widget = null\n',
      'src/widget.test.tsx': 'test("widget", () => {})\n',
    })

    expect((await planFocusedValidation({ projectRoot, changedFiles: ['src/widget.ts'] })).testFiles)
      .toEqual(['src/widget.test.tsx'])
  })

  test('Given a changed source When a non-sibling test statically imports it relatively Then that direct test is selected', async () => {
    const projectRoot = await createProject({
      'src/example.ts': 'export const value = 1\n',
      'tests/example.spec.ts': 'import { value } from "../src/example"\n',
      'tests/dynamic.test.ts': 'await import("../src/example")\n',
    })

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['src/example.ts'] }))
      .toMatchObject({
        confidence: 'medium',
        testFiles: ['tests/example.spec.ts'],
        command: 'bun test "tests/example.spec.ts"',
      })
  })

  test('Given Windows separators and duplicate unordered changes When planning Then paths are normalized, deduplicated, and stably sorted', async () => {
    const projectRoot = await createProject({
      'src/a.test.ts': '',
      'src/z.test.ts': '',
    })

    const plan = await planFocusedValidation({
      projectRoot,
      changedFiles: ['src\\z.test.ts', 'src/a.test.ts', 'src\\z.test.ts'],
    })

    expect(plan.testFiles).toEqual(['src/a.test.ts', 'src/z.test.ts'])
    expect(plan.command).toBe('bun test "src/a.test.ts" "src/z.test.ts"')
  })

  test.each([
    ['absolute POSIX path', '/tmp/example.test.ts'],
    ['absolute Windows path', 'C:\\repo\\example.test.ts'],
    ['parent traversal', '../example.test.ts'],
    ['embedded parent traversal', 'src/../../example.test.ts'],
    ['NUL byte', 'src/example.test.ts\0ignored'],
  ])('Given an invalid %s When planning Then the planner rejects it before reading project files', async (_label, changedFile) => {
    await expect(planFocusedValidation({ projectRoot: 'unused', changedFiles: [changedFile] }))
      .rejects.toThrow('changedFiles')
  })

  test('Given a safe Bun test script with fixed flags When planning Then files are appended to that command', async () => {
    const projectRoot = await createProject({ 'src/example.test.ts': '' }, 'bun test --timeout 5000')

    expect((await planFocusedValidation({ projectRoot, changedFiles: ['src/example.test.ts'] })).command)
      .toBe('bun test --timeout 5000 "src/example.test.ts"')
  })

  test.each([
    'npm test',
    'bun run test:unit',
    'bun test && bun test integration',
    'bun test --watch',
  ])('Given a non-targetable root test script %s When planning Then no command is invented', async (testScript) => {
    const projectRoot = await createProject({ 'src/example.test.ts': '' }, testScript)

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['src/example.test.ts'] }))
      .toMatchObject({
        confidence: 'none',
        testFiles: ['src/example.test.ts'],
        command: null,
      })
  })

  test('Given no matching test When planning Then confidence is none and no successful validation is fabricated', async () => {
    const projectRoot = await createProject({ 'src/unrelated.ts': 'export {}\n' })

    expect(await planFocusedValidation({ projectRoot, changedFiles: ['src/unrelated.ts'] }))
      .toEqual({
        confidence: 'none',
        testFiles: [],
        command: null,
        omittedTestCount: 0,
        affectedPackages: [],
        typecheckCommands: [],
        omittedTypecheckCount: 0,
        reasons: ['no-matching-tests'],
      })
  })

  test('Given more matching tests than the test cap When planning Then the stable prefix is returned and omissions are explicit', async () => {
    const files = Object.fromEntries(Array.from(
      { length: FOCUSED_VALIDATION_MAX_TEST_FILES + 5 },
      (_, index) => [`tests/case-${String(index).padStart(2, '0')}.test.ts`, ''],
    ))
    const projectRoot = await createProject(files)

    const plan = await planFocusedValidation({ projectRoot, changedFiles: Object.keys(files).reverse() })

    expect(plan.testFiles).toHaveLength(FOCUSED_VALIDATION_MAX_TEST_FILES)
    expect(plan.testFiles[0]).toBe('tests/case-00.test.ts')
    expect(plan.omittedTestCount).toBe(5)
  })

  test('Given selected paths would exceed the command cap When planning Then the command and returned test list stay bounded together', async () => {
    const files = Object.fromEntries(Array.from(
      { length: FOCUSED_VALIDATION_MAX_TEST_FILES },
      (_, index) => [`tests/${String(index).padStart(2, '0')}-${'x'.repeat(210)}.test.ts`, ''],
    ))
    const projectRoot = await createProject(files)

    const plan = await planFocusedValidation({ projectRoot, changedFiles: Object.keys(files) })

    expect(plan.command!.length).toBeLessThanOrEqual(FOCUSED_VALIDATION_MAX_COMMAND_LENGTH)
    expect(plan.command).toBe(`bun test ${plan.testFiles.map(path => `"${path}"`).join(' ')}`)
    expect(plan.omittedTestCount).toBeGreaterThan(0)
  })

  test('Given a test path contains cross-shell expansion syntax When planning Then no executable command is generated for it', async () => {
    const testFile = 'tests/$([unsafe]).test.ts'
    const projectRoot = await createProject({ [testFile]: '' })

    expect(await planFocusedValidation({ projectRoot, changedFiles: [testFile] })).toEqual({
      confidence: 'none',
      testFiles: [],
      command: null,
      omittedTestCount: 1,
      affectedPackages: [],
      typecheckCommands: [],
      omittedTypecheckCount: 0,
      reasons: ['unsafe-test-path'],
    })
  })

  test('Given a repository has more test files than the scan budget When direct imports are inspected Then planning stays bounded and reports truncation', async () => {
    const files: Record<string, string> = { 'src/example.ts': 'export const value = 1\n' }
    for (let index = 0; index <= FOCUSED_VALIDATION_MAX_SCANNED_TEST_FILES; index += 1) {
      files[`tests/case-${String(index).padStart(4, '0')}.test.ts`] = ''
    }
    const projectRoot = await createProject(files)

    const plan = await planFocusedValidation({ projectRoot, changedFiles: ['src/example.ts'] })

    expect(plan.confidence).toBe('none')
    expect(plan.reasons).toContain('test-scan-cap')
    expect(plan.reasons).toContain('no-matching-tests')
  })

  test('Given a candidate test exceeds the per-file read budget When direct imports are inspected Then it is skipped without loading unbounded content', async () => {
    const projectRoot = await createProject({
      'src/example.ts': 'export const value = 1\n',
      'tests/huge.test.ts': 'x'.repeat(FOCUSED_VALIDATION_MAX_SINGLE_TEST_BYTES + 1),
    })

    const plan = await planFocusedValidation({ projectRoot, changedFiles: ['src/example.ts'] })

    expect(plan.confidence).toBe('none')
    expect(plan.reasons).toContain('test-scan-cap')
  })

  test('Given the caller aborts before planning When scanning would begin Then no project traversal occurs', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(planFocusedValidation({
      projectRoot: 'unused',
      changedFiles: ['src/example.ts'],
      signal: controller.signal,
    })).rejects.toThrow()
  })
})

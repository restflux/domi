import { spawn } from 'node:child_process'
import { isWithinWorkspace, resolvePortablePath, type PathCanonicalizer } from './workspace-boundary.ts'

export interface GitStatusResult {
  exitCode: number
  stdout: string
  stderr: string
}

export type GitStatusRunner = (workspaceRoot: string) => Promise<GitStatusResult>

export type LocalBaselineCapture = {
  status: 'captured'
  paths: string[]
} | {
  status: 'unknown'
  paths: []
  reason: string
}

async function runGitStatus(workspaceRoot: string): Promise<GitStatusResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ], { cwd: workspaceRoot, windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (exitCode) => resolve({
      exitCode: exitCode ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

function parsePorcelainPaths(stdout: string, workspaceRoot: string): string[] {
  const paths: string[] = []
  for (const entry of stdout.split('\0')) {
    if (!entry) continue
    const path = /^[ MADRCU?!]{2} /.test(entry) ? entry.slice(3) : entry
    if (!path) continue
    paths.push(resolvePortablePath(path, workspaceRoot))
  }
  return [...new Set(paths)]
}

/** 运行开始前捕获 Git tracked dirty 与 untracked 路径。失败必须显式保守处理。 */
export async function captureLocalBaseline(
  workspaceRoot: string,
  runStatus: GitStatusRunner = runGitStatus,
): Promise<LocalBaselineCapture> {
  try {
    const result = await runStatus(workspaceRoot)
    if (result.exitCode !== 0) {
      return { status: 'unknown', paths: [], reason: result.stderr.trim() || `git status exited ${result.exitCode}` }
    }
    return { status: 'captured', paths: parsePorcelainPaths(result.stdout, workspaceRoot) }
  } catch (error) {
    return {
      status: 'unknown',
      paths: [],
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function findDeletedLocalBaselinePath(input: {
  operation: 'read' | 'write' | 'delete'
  targetPaths: readonly string[]
  localBaselinePaths: readonly string[]
  cwd: string
  workspaceRoot: string
  canonicalize: PathCanonicalizer
}): Promise<string | undefined> {
  if (input.operation !== 'delete' || input.localBaselinePaths.length === 0) return undefined

  const resolvedCwd = resolvePortablePath(input.cwd, input.workspaceRoot)
  const canonicalTargets = await Promise.all(input.targetPaths.map((path) => (
    input.canonicalize(resolvePortablePath(path, resolvedCwd))
  )))
  const canonicalBaselinePaths = await Promise.all(input.localBaselinePaths.map((path) => (
    input.canonicalize(resolvePortablePath(path, input.workspaceRoot))
  )))

  return canonicalBaselinePaths.find((baselinePath) => (
    canonicalTargets.some((targetPath) => isWithinWorkspace(baselinePath, targetPath))
  ))
}

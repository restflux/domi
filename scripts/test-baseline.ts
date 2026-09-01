const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]/g
const GITHUB_WORKFLOW_COMMAND_PREFIX = /^::[a-zA-Z0-9_-]+(?: [^:]*)?::/

export interface TestFailureComparison {
  known: string[]
  resolved: string[]
  regressions: string[]
  unexpectedNonzeroExit: boolean
}

function normalizeLine(rawLine: string): string {
  return rawLine
    .replace(GITHUB_WORKFLOW_COMMAND_PREFIX, '')
    .trim()
}

export function normalizeTestOutput(output: string): string {
  return output.replace(ANSI_PATTERN, '').replaceAll('\\', '/')
}

export function extractTestFailures(output: string): string[] {
  const failures: string[] = []
  let currentFile = 'unknown'

  for (const rawLine of normalizeTestOutput(output).split(/\r?\n/)) {
    const line = normalizeLine(rawLine)
    if (/\.(?:test|spec)\.[cm]?[jt]sx?:$/.test(line)) {
      currentFile = line.slice(0, -1)
      continue
    }
    if (/^\d+ tests failed:$/.test(line)) break
    if (line === '# Unhandled error between tests') {
      failures.push(`${currentFile} :: [unhandled error]`)
      continue
    }
    const match = line.match(/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/)
    if (match?.[1]) failures.push(`${currentFile} :: ${match[1]}`)
  }

  return failures.sort()
}

function consumeMatches(source: string[], available: Map<string, number>): {
  matched: string[]
  unmatched: string[]
} {
  const matched: string[] = []
  const unmatched: string[] = []

  for (const failure of source) {
    const count = available.get(failure) ?? 0
    if (count > 0) {
      matched.push(failure)
      available.set(failure, count - 1)
    } else {
      unmatched.push(failure)
    }
  }

  return { matched, unmatched }
}

function toCounts(failures: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const failure of failures) counts.set(failure, (counts.get(failure) ?? 0) + 1)
  return counts
}

export function compareTestFailures(
  baselineFailures: string[],
  currentFailures: string[],
  exitCode: number,
): TestFailureComparison {
  const currentResult = consumeMatches(currentFailures, toCounts(baselineFailures))
  const baselineResult = consumeMatches(baselineFailures, toCounts(currentFailures))

  return {
    known: currentResult.matched,
    resolved: baselineResult.unmatched,
    regressions: currentResult.unmatched,
    unexpectedNonzeroExit: exitCode !== 0 && currentFailures.length === 0,
  }
}

import type { ShellAnalysis } from './shell-analysis.ts'
import { extractKnownReadOnlyCommandPaths, isKnownReadOnlyCommand } from './shell-command-classifier.ts'

export interface FileToolAction {
  kind: 'file'
  operation: 'read' | 'write' | 'delete'
  paths: string[]
}

export interface ShellToolAction {
  kind: 'shell'
  command: string
  paths: string[]
}

export interface UnknownToolAction {
  kind: 'unknown'
  paths: string[]
}

export type NormalizedToolAction = FileToolAction | ShellToolAction | UnknownToolAction

const PATH_KEYS = ['file_path', 'path', 'notebook_path', 'directory', 'cwd'] as const

function extractPaths(input: Record<string, unknown>): string[] {
  return PATH_KEYS.flatMap((key) => typeof input[key] === 'string' ? [input[key]] : [])
}

export function normalizeToolAction(
  toolName: string,
  input: Record<string, unknown>,
  shellAnalysis?: ShellAnalysis,
): NormalizedToolAction {
  const normalizedName = toolName.toLowerCase().replace(/[^a-z]/g, '')
  const paths = extractPaths(input)

  if (['bash', 'shell', 'powershell', 'command', 'terminalrun'].includes(normalizedName)) {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    return {
      kind: 'shell',
      command,
      paths: isKnownReadOnlyCommand(command, shellAnalysis)
        ? [...paths, ...extractKnownReadOnlyCommandPaths(command, shellAnalysis)]
        : paths,
    }
  }
  if (['read', 'view', 'glob', 'grep', 'find', 'list', 'ls'].includes(normalizedName)) {
    const patternPaths = ['glob', 'find'].includes(normalizedName) && typeof input.pattern === 'string'
      ? [input.pattern]
      : []
    return { kind: 'file', operation: 'read', paths: [...paths, ...patternPaths] }
  }
  if (['write', 'edit', 'multiedit', 'create', 'notebookedit'].includes(normalizedName)) {
    return { kind: 'file', operation: 'write', paths }
  }
  if (['delete', 'remove', 'unlink'].includes(normalizedName)) {
    return { kind: 'file', operation: 'delete', paths }
  }
  return { kind: 'unknown', paths }
}

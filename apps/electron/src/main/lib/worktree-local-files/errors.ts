export class WorktreeLocalFilesError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'WorktreeLocalFilesError'
  }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

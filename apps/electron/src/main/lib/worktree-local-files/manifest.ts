import { WorktreeLocalFilesError } from './errors.ts'
import { isLocalFileTemporaryPath } from './temporary-path.ts'

export const MANIFEST_NAME = '.worktreeinclude'
export const MAX_FILES = 100
export const MAX_MANIFEST_BYTES = 64 * 1024

// 只接受可移植的字面路径，避免 Windows ADS、Git pathspec 和目录匹配语义。
const FORBIDDEN_SEGMENTS = new Set([
  '.git', 'node_modules', 'bower_components', '.cache', 'cache', '__pycache__',
  '.venv', 'venv', 'vendor', '.bun', '.npm', '.pnpm-store', '.yarn', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.turbo', '.next', '.nuxt', '.parcel-cache',
])

export function validateRelativePath(path: string): string {
  const parts = path.split('/')
  if (!path || path.startsWith('#') || path !== path.trim() || path.length > 1024 || /[\\\x00-\x1f\x7f:*?\[\]{}!<>|]/u.test(path)
    || parts.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ')
      || FORBIDDEN_SEGMENTS.has(part.toLowerCase())
      || /~[0-9]/u.test(part)
      || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part))
    || path.toLowerCase() === MANIFEST_NAME || isLocalFileTemporaryPath(path)) {
    throw new WorktreeLocalFilesError('invalid_path', '清单只能包含明确的相对文件路径，不能包含受保护目录或匹配语法')
  }
  return path
}

export function validatePaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths.map(validateRelativePath))]
  if (new Set(unique.map(path => path.normalize('NFD').toLowerCase())).size !== unique.length) {
    throw new WorktreeLocalFilesError('invalid_path', '清单不能包含大小写或 Unicode 形式不同的同名文件')
  }
  if (unique.length > MAX_FILES) throw new WorktreeLocalFilesError('limit_exceeded', '本地文件清单最多包含 100 个文件')
  // 大小也限制去重前输入，避免海量重复条目消耗资源。
  if (paths.length > 1000 || Buffer.byteLength(paths.join('\n'), 'utf8') > MAX_MANIFEST_BYTES) {
    throw new WorktreeLocalFilesError('limit_exceeded', '本地文件清单超过大小限制')
  }
  return unique
}

export function parseManifest(text: string): string[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new WorktreeLocalFilesError('limit_exceeded', '本地文件清单超过大小限制')
  }
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  return validatePaths(lines.map(line => line.trim()).filter(line => line && !line.startsWith('#')))
}

export function renderManifest(previous: string, paths: readonly string[]): string {
  const selected = new Set(validatePaths(paths))
  const written = new Set<string>()
  const lines = previous.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  const output = lines.filter(line => {
    const path = line.trim()
    if (!path || path.startsWith('#')) return true
    if (!selected.has(path) || written.has(path)) return false
    written.add(path)
    return true
  })
  for (const path of selected) if (!written.has(path)) output.push(path)
  const text = output.length ? `${output.join('\n')}\n` : ''
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new WorktreeLocalFilesError('limit_exceeded', '本地文件清单超过大小限制')
  }
  return text
}

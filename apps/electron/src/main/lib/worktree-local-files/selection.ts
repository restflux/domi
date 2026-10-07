import { lstat, opendir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { WorktreeLocalFilesDirectory, WorktreeLocalFilesNode, WorktreeLocalFileSelection } from '@domi/shared/types'
import { assertParents, MAX_FILE_BYTES, type DirectoryIdentity } from './filesystem.ts'
import { readLocalFilesGitState, type LocalFilesGitState } from './git.ts'
import { validatePaths, validateRelativePath } from './manifest.ts'
import { isMissing, WorktreeLocalFilesError } from './errors.ts'

export const MAX_DIRECTORY_ENTRIES = 1000
export const MAX_SCAN_ENTRIES = 5000
const MAX_DEPTH = 32
const MAX_SCAN_MS = 8000

interface DirectoryProof extends DirectoryIdentity { mtimeMs: number; ctimeMs: number }
export interface LocalFileBrowserOptions {
  /** 仅用于测试目录被替换的竞争，不暴露到 IPC。 */
  beforeReadDirectory?(directory: string): void | Promise<void>
}

/** 元数据枚举也验证父级及目录身份；竞争结果不返回给 Renderer。 */
class LocalFilesScanner {
  private readonly proofs = new Map<string, DirectoryProof>()
  private readonly started = Date.now()
  private visited = 0

  constructor(private readonly root: string, private readonly git: LocalFilesGitState, private readonly options: LocalFileBrowserOptions) {}

  private budget(): void {
    if (++this.visited > MAX_SCAN_ENTRIES || Date.now() - this.started > MAX_SCAN_MS) {
      throw new WorktreeLocalFilesError('limit_exceeded', '文件扫描超过限额，请展开较小的文件夹后选择')
    }
  }

  async directory(relative: string): Promise<string> {
    if (relative) validateRelativePath(relative)
    const parts = relative ? relative.split('/') : []
    if (parts.length > MAX_DEPTH) throw new WorktreeLocalFilesError('limit_exceeded', '文件夹层级超过扫描限制')
    let path = this.root
    const parents: DirectoryIdentity[] = []
    for (let index = 0; index <= parts.length; index++) {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorktreeLocalFilesError('unsafe_file', '不能浏览链接或特殊文件')
      if (index > 0) {
        let nested = false
        try { await lstat(join(path, '.git')); nested = true } catch (error) { if (!isMissing(error)) throw error }
        if (nested) throw new WorktreeLocalFilesError('unsafe_file', '不能浏览嵌套 Git 仓库')
      }
      const proof = { path, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
      const previous = this.proofs.get(path)
      if (previous && !this.sameDirectory(previous, proof)) throw this.changed()
      this.proofs.set(path, proof)
      parents.push(proof)
      if (index < parts.length) path = join(path, parts[index]!)
    }
    await assertParents(parents)
    return path
  }

  private sameDirectory(left: DirectoryProof, right: Pick<DirectoryProof, 'dev' | 'ino' | 'mtimeMs' | 'ctimeMs'>): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
  }

  private changed(): WorktreeLocalFilesError {
    return new WorktreeLocalFilesError('file_changed', '项目文件夹在扫描期间发生变化，请刷新后重试')
  }

  async verify(): Promise<void> {
    await assertParents([...this.proofs.values()])
    for (const proof of this.proofs.values()) {
      if (Date.now() - this.started > MAX_SCAN_MS) throw new WorktreeLocalFilesError('limit_exceeded', '文件扫描超过时间限制，请选择更小的文件夹')
      const stat = await lstat(proof.path)
      if (!this.sameDirectory(proof, stat)) throw this.changed()
    }
  }

  async node(path: string, kind: WorktreeLocalFilesNode['kind']): Promise<WorktreeLocalFilesNode> {
    const base = { path, name: basename(path), kind }
    try {
      validateRelativePath(path)
      const stat = await lstat(join(this.root, path))
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        return { ...base, selectable: false, reason: '链接或特殊文件不可选择' }
      }
      const actualKind = stat.isDirectory() ? 'directory' : 'file'
      if (this.git.isTracked(path)) return { ...base, kind: actualKind, selectable: false, reason: '文件由 Git 管理，无需复制' }
      if (actualKind === 'directory') await this.directory(path)
      if (stat.isFile() && stat.size > MAX_FILE_BYTES) return { ...base, kind: actualKind, selectable: false, reason: '文件超过 4 MiB 限制' }
      return { ...base, kind: actualKind, selectable: true }
    } catch (error) {
      if (error instanceof WorktreeLocalFilesError && ['file_changed', 'limit_exceeded'].includes(error.code)) throw error
      return { ...base, selectable: false, reason: error instanceof WorktreeLocalFilesError ? error.message : '文件状态不可读取，请刷新后重试' }
    }
  }

  async walk(directory: string, visit: (node: WorktreeLocalFilesNode) => void): Promise<void> {
    for (const node of await this.children(directory)) {
      visit(node)
      if (node.kind === 'directory' && node.selectable) await this.walk(node.path, visit)
    }
  }

  async selectionNode(path: string): Promise<WorktreeLocalFilesNode> {
    this.budget()
    const parent = dirname(path)
    await this.directory(parent === '.' ? '' : parent)
    return this.node(path, 'file')
  }

  async children(relative: string): Promise<WorktreeLocalFilesNode[]> {
    const path = await this.directory(relative)
    const entries: WorktreeLocalFilesNode[] = []
    // 流式读取目录并限量，避免 readdir 一次分配任意大小的数组。
    await this.options.beforeReadDirectory?.(relative)
    await this.directory(relative)
    const directory = await opendir(path)
    try {
      await this.directory(relative)
      for await (const entry of directory) {
        this.budget()
        if (entries.length >= MAX_DIRECTORY_ENTRIES) throw new WorktreeLocalFilesError('limit_exceeded', '文件夹条目超过 1000 个，请选择更小的文件夹')
        const child = relative ? `${relative}/${entry.name}` : entry.name
        entries.push(await this.node(child, entry.isDirectory() ? 'directory' : 'file'))
      }
    } finally {
      await directory.close().catch(() => {})
    }
    await this.directory(relative)
    return entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
  }
}

export async function listLocalFileDirectory(root: string, directory: string, query = '', options: LocalFileBrowserOptions = {}): Promise<WorktreeLocalFilesDirectory> {
  if (directory) validateRelativePath(directory)
  if (query.length > 128 || /[\x00-\x1f\x7f]/u.test(query)) throw new WorktreeLocalFilesError('invalid_input', '搜索词无效或过长')
  const scanner = new LocalFilesScanner(root, await readLocalFilesGitState(root), options)
  const needle = query.trim().normalize('NFD').toLowerCase()
  let entries: WorktreeLocalFilesNode[]
  if (!needle) entries = await scanner.children(directory)
  else {
    entries = []
    await scanner.walk(directory, node => {
      if (node.path.normalize('NFD').toLowerCase().includes(needle)) entries.push(node)
      if (entries.length > MAX_DIRECTORY_ENTRIES) throw new WorktreeLocalFilesError('limit_exceeded', '搜索结果超过限额，请缩小搜索范围')
    })
  }
  await scanner.verify()
  return { directory, entries }
}

export async function resolveLocalFileSelection(root: string, paths: string[], existingPaths: string[],
  validate: (paths: string[]) => Promise<unknown>, options: LocalFileBrowserOptions = {}): Promise<WorktreeLocalFileSelection> {
  const roots = validatePaths(paths).sort((a, b) => a.length - b.length)
  const existing = validatePaths(existingPaths)
  const scanner = new LocalFilesScanner(root, await readLocalFilesGitState(root), options)
  const selected = new Set<string>()
  const skipped = new Map<string, string>()
  const covered: string[] = []
  const visit = (node: WorktreeLocalFilesNode): void => {
    if (!node.selectable) skipped.set(node.path, node.reason ?? '文件不可选择')
    else if (node.kind === 'file') {
      selected.add(node.path)
      // 超限是整次操作失败，不返回前100项作为隐式的部分选择。
      validatePaths([...new Set([...existing, ...selected])])
    }
  }
  for (const path of roots) {
    if (covered.some(parent => path.startsWith(`${parent}/`))) continue
    const node = await scanner.selectionNode(path)
    visit(node)
    if (node.kind === 'directory' && node.selectable) {
      await scanner.walk(path, visit)
      covered.push(path)
    }
  }
  await validate([...new Set([...existing, ...selected])])
  await scanner.verify()
  return { paths: [...selected], skipped: [...skipped].map(([path, reason]) => ({ path, reason })) }
}

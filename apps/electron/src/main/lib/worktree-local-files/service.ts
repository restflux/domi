import { createHash } from 'node:crypto'

import type { WorktreeLocalFileOverwrite, WorktreeLocalFilesCopyResult, WorktreeLocalFilesView, WorktreeLocalFilesDirectory, WorktreeLocalFileSelection } from '@domi/shared/types'
import { AuthorizationStore } from './authorization'
import { WorktreeLocalFilesError } from './errors'
import { canonicalRoot, MAX_FILE_BYTES, MAX_TOTAL_BYTES, readSnapshot, removeTemporary, safeLocation, writeTemporary, type FileSnapshot, type SafeLocation } from './filesystem'
import { assertUntracked } from './git'
import { MANIFEST_NAME, MAX_MANIFEST_BYTES, parseManifest, renderManifest, validatePaths } from './manifest'
import { publishFile, type PublishedFile } from './replace'
import { listLocalFileDirectory, resolveLocalFileSelection } from './selection.ts'

export { WorktreeLocalFilesError } from './errors'
export interface WorktreeLocalFilesProject { id: string; root: string }
export interface WorktreeLocalFilesPlan { paths: string[]; manifestVersion: string }
export interface WorktreeLocalFilesOptions {
  storagePath: string
  /** 仅用于宿主行为测试的确定性竞争注入，不暴露到 IPC。 */
  beforePublish?(path: string): void | Promise<void>
  beforeReadDirectory?(directory: string): void | Promise<void>
}
interface Manifest {
  text: string
  version: string
  paths: string[]
  location: SafeLocation
  snapshot: FileSnapshot | null
}
interface PlannedSources { id: string; root: string; fingerprints: Map<string, string> }
interface PreparedFile { path: string; location: SafeLocation; source: FileSnapshot; destination: SafeLocation; previous: FileSnapshot | null }

export class WorktreeLocalFilesService {
  private readonly authorization: AuthorizationStore
  private readonly plans = new WeakMap<WorktreeLocalFilesPlan, PlannedSources>()

  constructor(private readonly options: WorktreeLocalFilesOptions) { this.authorization = new AuthorizationStore(options.storagePath) }

  private async root(project: WorktreeLocalFilesProject): Promise<string> {
    if (!project.id || project.id.length > 256) throw new WorktreeLocalFilesError('invalid_project', '项目标识无效')
    return canonicalRoot(project.root)
  }

  private async manifest(root: string): Promise<Manifest> {
    const location = await safeLocation(root, MANIFEST_NAME)
    const snapshot = location.stat ? await readSnapshot(location, MAX_MANIFEST_BYTES) : null
    let text = ''
    if (snapshot) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes) } catch {
        throw new WorktreeLocalFilesError('invalid_manifest', '本地文件清单必须是有效 UTF-8 文本')
      }
    }
    const version = snapshot ? createHash('sha256').update(snapshot.bytes).digest('hex') : 'missing'
    return { text, version, paths: parseManifest(text), location, snapshot }
  }

  private async sourceLocations(root: string, paths: readonly string[]): Promise<SafeLocation[]> {
    await assertUntracked(root, paths)
    const locations: SafeLocation[] = []
    let total = 0
    for (const path of paths) {
      const location = await safeLocation(root, path)
      total += location.stat?.size ?? 0
      if ((location.stat?.size ?? 0) > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
        throw new WorktreeLocalFilesError('limit_exceeded', '本地文件超过单文件 4 MiB 或总计 32 MiB 的限制')
      }
      locations.push(location)
    }
    return locations
  }

  private assertVersion(manifest: Manifest, expectedVersion: string): void {
    if (manifest.version !== expectedVersion) throw new WorktreeLocalFilesError('manifest_changed', '本地文件清单已变化，请重新查看后确认')
  }

  async inspect(project: WorktreeLocalFilesProject): Promise<WorktreeLocalFilesView> {
    const root = await this.root(project)
    const manifest = await this.manifest(root)
    const approved = await this.authorization.approved(project.id, root)
    const locations = await this.sourceLocations(root, manifest.paths)
    return {
      projectId: project.id, manifestVersion: manifest.version,
      entries: manifest.paths.map((path, index) => ({ path, status: !locations[index]!.stat ? 'missing' : approved.has(path) ? 'ready' : 'unapproved' })),
    }
  }

  async save(project: WorktreeLocalFilesProject, paths: string[], expectedVersion: string): Promise<WorktreeLocalFilesView> {
    return this.authorization.withLock(async () => {
      const root = await this.root(project)
      const manifest = await this.manifest(root)
      this.assertVersion(manifest, expectedVersion)
      // 保存由用户明确触发并批准展示集合；损坏授权不能被写入覆盖。
      await this.authorization.approved(project.id, root)
      const selected = validatePaths(paths)
      const locations = await this.sourceLocations(root, selected)
      if (locations.some((location) => !location.stat)) throw new WorktreeLocalFilesError('missing_file', '清单包含不存在的源文件，不能保存并批准')
      const text = renderManifest(manifest.text, selected)
      const temporary = await writeTemporary(manifest.location, Buffer.from(text, 'utf8'), manifest.snapshot?.stat.mode ?? 0o600)
      try {
        this.assertVersion(await this.manifest(root), expectedVersion)
        const published = await publishFile(manifest.location, temporary, manifest.snapshot, Buffer.from(text, 'utf8'))
        try {
          await published.verify()
          await this.authorization.approve(project.id, root, selected)
          await published.verify()
          await published.finish()
        } catch (error) { await published.rollback(); throw error }
      } finally { await removeTemporary(manifest.location, temporary) }
      return this.inspect(project)
    })
  }

  async confirm(project: WorktreeLocalFilesProject, expectedVersion: string): Promise<WorktreeLocalFilesView> {
    return this.authorization.withLock(async () => {
      const root = await this.root(project)
      const manifest = await this.manifest(root)
      this.assertVersion(manifest, expectedVersion)
      const locations = await this.sourceLocations(root, manifest.paths)
      if (locations.some(location => !location.stat)) throw new WorktreeLocalFilesError('missing_file', '清单包含不存在的源文件，不能确认')
      // 检查后再次绑定同一个清单版本，不允许把外部编辑新增路径一起批准。
      this.assertVersion(await this.manifest(root), expectedVersion)
      await this.authorization.approve(project.id, root, manifest.paths)
      this.assertVersion(await this.manifest(root), expectedVersion)
      return this.inspect(project)
    })
  }

  async preflight(project: WorktreeLocalFilesProject, targetHeadOid?: string): Promise<WorktreeLocalFilesPlan> {
    const root = await this.root(project)
    const manifest = await this.manifest(root)
    const approved = manifest.paths.length ? await this.authorization.approved(project.id, root) : new Set<string>()
    const locations = manifest.paths.length ? await this.sourceLocations(root, manifest.paths) : []
    if (targetHeadOid && manifest.paths.length) await assertUntracked(root, manifest.paths, targetHeadOid)
    const fingerprints = new Map<string, string>()
    for (const [index, path] of manifest.paths.entries()) {
      if (!approved.has(path)) throw new WorktreeLocalFilesError('unapproved_file', '清单包含尚未在本机确认的文件')
      const snapshot = await readSnapshot(locations[index]!)
      fingerprints.set(path, snapshot.fingerprint)
    }
    this.assertVersion(await this.manifest(root), manifest.version)
    const plan = { paths: [...manifest.paths], manifestVersion: manifest.version }
    this.plans.set(plan, { id: project.id, root, fingerprints })
    return plan
  }

  async inspectTarget(targetRoot: string, paths: readonly string[]): Promise<Array<{ path: string; exists: boolean; fingerprint: string }>> {
    const root = await canonicalRoot(targetRoot)
    const selected = validatePaths(paths)
    await assertUntracked(root, selected)
    const entries: Array<{ path: string; exists: boolean; fingerprint: string }> = []
    for (const path of selected) {
      const location = await safeLocation(root, path)
      entries.push({ path, exists: !!location.stat, fingerprint: location.stat ? (await readSnapshot(location)).fingerprint : '' })
    }
    return entries
  }

  async copy(project: WorktreeLocalFilesProject, targetRoot: string, plan: WorktreeLocalFilesPlan,
    overwriteFiles: readonly WorktreeLocalFileOverwrite[] = []): Promise<WorktreeLocalFilesCopyResult> {
    return this.authorization.withLock(async () => {
      const root = await this.root(project)
      const target = await canonicalRoot(targetRoot)
      if (target === root) throw new WorktreeLocalFilesError('invalid_target', '不能向源项目自身准备本地文件')
      const planned = this.plans.get(plan)
      if (!planned || planned.id !== project.id || planned.root !== root) throw new WorktreeLocalFilesError('invalid_plan', '复制计划必须由本服务对当前项目预检生成')
      const manifest = await this.manifest(root)
      this.assertVersion(manifest, plan.manifestVersion)
      if (JSON.stringify(manifest.paths) !== JSON.stringify(plan.paths)) throw new WorktreeLocalFilesError('invalid_plan', '复制计划与当前清单不一致')
      const approved = await this.authorization.approved(project.id, root)
      if (plan.paths.some(path => !approved.has(path))) throw new WorktreeLocalFilesError('unapproved_file', '清单包含尚未在本机确认的文件')
      if (overwriteFiles.length > plan.paths.length) throw new WorktreeLocalFilesError('invalid_overwrite', '覆盖确认包含无效路径')
      const overwrites = new Map<string, string>()
      for (const file of overwriteFiles) {
        if (!plan.paths.includes(file.path) || !/^[a-f0-9]{64}$/u.test(file.expectedFingerprint) || overwrites.has(file.path)) {
          throw new WorktreeLocalFilesError('invalid_overwrite', '覆盖确认必须绑定清单内的唯一文件和有效指纹')
        }
        overwrites.set(file.path, file.expectedFingerprint)
      }
      await assertUntracked(target, plan.paths)
      const locations = await this.sourceLocations(root, plan.paths)
      const files: PreparedFile[] = []
      const skipped: string[] = []
      for (const [index, path] of plan.paths.entries()) {
        const location = locations[index]!
        const source = await readSnapshot(location)
        if (planned.fingerprints.get(path) !== source.fingerprint) throw new WorktreeLocalFilesError('file_changed', '源文件在预检后发生变化，请重新准备')
        const destination = await safeLocation(target, path)
        const previous = destination.stat ? await readSnapshot(destination) : null
        const expected = overwrites.get(path)
        if (expected && previous?.fingerprint !== expected) throw new WorktreeLocalFilesError('target_changed', '目标文件已变化，请重新确认覆盖')
        if (previous && !expected) { skipped.push(path); continue }
        files.push({ path, location, source, destination, previous })
      }
      const published: PublishedFile[] = []
      const temporaries: Array<{ path: string; location: SafeLocation }> = []
      try {
        for (const file of files) {
          file.destination = await safeLocation(target, file.path, true)
          const temporary = await writeTemporary(file.destination, file.source.bytes, file.source.stat.mode)
          temporaries.push({ path: temporary, location: file.destination })
        }
        await assertUntracked(root, plan.paths)
        await assertUntracked(target, plan.paths)
        this.assertVersion(await this.manifest(root), plan.manifestVersion)
        for (const [index, file] of files.entries()) {
          await this.options.beforePublish?.(file.path)
          const fresh = await readSnapshot(await safeLocation(root, file.path))
          if (fresh.fingerprint !== file.source.fingerprint) throw new WorktreeLocalFilesError('file_changed', '源文件在复制期间发生变化')
          published.push(await publishFile(file.destination, temporaries[index]!.path, file.previous, file.source.bytes))
        }
        for (const file of published) await file.verify()
        // 所有文件发布后再检查源和 Git 状态，失败则撤回本操作发布的 inode。
        for (const file of files) {
          if ((await readSnapshot(await safeLocation(root, file.path))).fingerprint !== file.source.fingerprint) {
            throw new WorktreeLocalFilesError('file_changed', '源文件在复制期间发生变化')
          }
        }
        await assertUntracked(root, plan.paths)
        await assertUntracked(target, plan.paths)
        this.assertVersion(await this.manifest(root), plan.manifestVersion)
      } catch (error) {
        for (const file of published.reverse()) await file.rollback()
        throw error
      } finally {
        for (const temporary of temporaries) await removeTemporary(temporary.location, temporary.path).catch(() => {})
      }
      for (const file of published) await file.finish()
      return { copied: files.map(file => file.path), skipped }
    })
  }

  async listDirectory(project: WorktreeLocalFilesProject, directory: string, query = ''): Promise<WorktreeLocalFilesDirectory> {
    return listLocalFileDirectory(await this.root(project), directory, query, this.options)
  }

  async resolveSelection(project: WorktreeLocalFilesProject, paths: string[], existingPaths: string[]): Promise<WorktreeLocalFileSelection> {
    const root = await this.root(project)
    return resolveLocalFileSelection(root, paths, existingPaths, selected => this.sourceLocations(root, selected), this.options)
  }



}

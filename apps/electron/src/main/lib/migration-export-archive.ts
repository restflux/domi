import archiver from 'archiver'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'

// 已压缩媒体直接存储，避免重复压缩占用 CPU；文本使用快速压缩。
const STORED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mp3', '.pdf', '.zip', '.gz', '.7z', '.docx', '.xlsx', '.pptx', '.domi-backup', '.domi-share'])

interface FileEntry extends archiver.ZipEntryData {
  sourcePath?: string
}

export class MigrationExportArchive {
  private readonly archive = archiver('zip', { zlib: { level: 1 } })
  private readonly temporaryPath: string
  private readonly completion: Promise<void>
  private failure: Error | undefined

  constructor(private readonly outputPath: string) {
    this.temporaryPath = `${outputPath}.${randomUUID()}.tmp`
    // 立即接住流错误；扫描目录期间也可能发生磁盘写入失败。
    this.archive.on('error', error => { this.failure = error })
    this.completion = pipeline(this.archive, createWriteStream(this.temporaryPath, { flags: 'wx', mode: 0o600 }))
      .catch((error: Error) => { this.failure = error })
  }

  checkError(): void {
    if (this.failure) throw this.failure
    if (this.archive.destroyed) throw new Error('备份输出流已关闭')
  }

  addFile(name: string, content: Buffer): void {
    this.checkError()
    this.archive.append(content, { name })
  }

  async addLocalFile(path: string, name: string): Promise<void> {
    this.checkError()
    if ([this.outputPath, this.temporaryPath].some(output => resolve(output).toLowerCase() === resolve(path).toLowerCase())) {
      throw new Error('备份文件不能包含导出目标本身')
    }
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`不支持备份非普通文件: ${path}`)
    this.checkError()
    // 每次只读取一个源文件；等待 entry 事件使文件读取、压缩及输出受流背压控制。
    await new Promise<void>((resolveEntry, reject) => {
      const source = createReadStream(path)
      const cleanup = (): void => {
        this.archive.off('entry', onEntry)
        this.archive.off('error', onError)
      }
      const onError = (error: Error): void => { source.destroy(); cleanup(); reject(error) }
      const onEntry = (entry: FileEntry): void => {
        if (entry.sourcePath === path) { cleanup(); resolveEntry() }
      }
      this.archive.on('entry', onEntry)
      this.archive.on('error', onError)
      source.on('error', error => this.archive.destroy(error))
      const entry: FileEntry = { name, sourcePath: path, date: info.mtime, mode: info.mode, store: STORED_EXTENSIONS.has(extname(path).toLowerCase()) }
      this.archive.append(source, entry)
    })
    this.checkError()
  }

  async finish(): Promise<void> {
    this.checkError()
    // 输出失败会销毁外层流，但 archiver 的 finalize 可能仍等待内部流；同时等待输出结果。
    await Promise.race([
      this.archive.finalize(),
      this.completion.then(() => { if (this.failure) throw this.failure }),
    ])
    await this.completion
    if (this.failure) throw this.failure
    await rename(this.temporaryPath, this.outputPath)
  }

  async dispose(): Promise<void> {
    this.archive.destroy()
    await this.completion
    await rm(this.temporaryPath, { force: true })
  }
}

export async function writeMigrationArchive(outputPath: string, collect: (archive: MigrationExportArchive) => Promise<void>): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true })
  const archive = new MigrationExportArchive(outputPath)
  try {
    await collect(archive)
    await archive.finish()
  } finally {
    await archive.dispose()
  }
}

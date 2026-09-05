import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Api, Model, ModelsRefreshOptions, ModelsRefreshResult } from '@earendil-works/pi-ai'
import { getSdkConfigDir } from '../config-paths'
import { runWithPiRequestProxyScope } from './pi-request-proxy'

interface CatalogRuntime {
  getModels(provider: string): readonly Model<Api>[]
  refresh(options: ModelsRefreshOptions): Promise<ModelsRefreshResult>
}

/** 目录查询不需要渠道凭据，也不应触发 OAuth 刷新或读取全局认证配置。 */
export const catalogCredentials = {
  async read() { return undefined },
  async list() { return [] },
  async modify() { return undefined },
  async delete() {},
}

/** Pi 负责目录协议与 JSON 缓存；这里只协调同进程查询及外部缓存更新。 */
export class PiRemoteModelCatalog {
  private runtime?: Promise<CatalogRuntime>
  private revision?: string
  private pending: Promise<void> = Promise.resolve()
  private readonly nextRefreshAt = new Map<string, number>()

  constructor(
    private readonly createRuntime: () => Promise<CatalogRuntime>,
    private readonly cacheRevision: () => Promise<string>,
  ) {}

  private load(): Promise<CatalogRuntime> {
    this.runtime ??= this.createRuntime().catch((error: unknown) => {
      this.runtime = undefined
      throw error
    })
    return this.runtime
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => {})
    return result
  }

  private async restoreCache(): Promise<CatalogRuntime> {
    const runtime = await this.load()
    const revision = await this.cacheRevision()
    if (revision !== this.revision) {
      const result = await runtime.refresh({ allowNetwork: false })
      if (!result.aborted && result.errors.size === 0) this.revision = revision
    }
    return runtime
  }

  async getModels(provider: string): Promise<readonly Model<Api>[]> {
    await this.enqueue(async () => { await this.restoreCache() })
    return (await this.load()).getModels(provider)
  }

  async refresh(providers: readonly string[], proxyUrl?: string, force = true): Promise<void> {
    if (providers.length === 0) return
    await this.enqueue(async () => {
      const due = [...new Set(providers)].filter((provider) => force || Date.now() >= (this.nextRefreshAt.get(provider) ?? 0))
      if (due.length === 0) return
      // 失败后一分钟内不在每次能力查询时重复阻塞；手动刷新始终可以重试。
      for (const provider of due) this.nextRefreshAt.set(provider, Date.now() + 60_000)
      // 先恢复整个缓存，避免刷新 OpenAI 后把同文件中尚未加载的 Codex 目录跳过。
      const runtime = await this.restoreCache()
      const signal = AbortSignal.timeout(15_000)
      const result = await runWithPiRequestProxyScope({ proxyUrl }, () => runtime.refresh({
        providers: due, allowNetwork: true, force, signal,
      }))
      // SDK 刷新失败仍保留缓存，不能清空中转模型或把旧目录冒充刚刷新成功。
      if (result.aborted || result.errors.size > 0) throw new Error('Pi 模型能力目录刷新失败，已保留已有目录')
      this.revision = undefined
      for (const provider of due) this.nextRefreshAt.set(provider, Date.now() + 4 * 60 * 60 * 1000)
    })
  }
}

export const piRemoteModelCatalog = new PiRemoteModelCatalog(
  async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
    const agentDir = getSdkConfigDir()
    return ModelRuntime.create({
      credentials: catalogCredentials,
      // Pi modelsPath=null 会改用内存 store，即使给了 modelsStorePath 也不会落盘。
      modelsPath: join(agentDir, 'models.json'),
      modelsStorePath: join(agentDir, 'models-store.json'),
      refreshOnCreate: false,
      allowModelNetwork: false,
    })
  },
  async () => {
    try {
      const info = await stat(join(getSdkConfigDir(), 'models-store.json'))
      return `${info.mtimeMs}:${info.size}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
  },
)

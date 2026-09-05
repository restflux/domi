import { join } from 'node:path'
import type { ModelsRefreshOptions, ModelsRefreshResult, Provider } from '@earendil-works/pi-ai'

/** 公共目录与推理认证隔离；禁止从全局配置读取凭据。 */
export const catalogCredentials = {
  async read() { return undefined },
  async list() { return [] },
  async modify() { return undefined },
  async delete() {},
}

/** 只暴露目录操作，不能将无认证的 provider 用于推理。 */
export async function createPiCatalogRuntime(agentDir: string) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const runtime = await ModelRuntime.create({
    credentials: catalogCredentials,
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  const installed = new Set<string>()
  const published = new Set<string>()

  function install(provider: Provider) {
    if (installed.has(provider.id) || !provider.refreshModels || provider.id === 'radius') return
    const refreshModels = provider.refreshModels
    runtime.registerNativeProvider({
      ...provider,
      // Pi 0.84 的 Models.refresh 先解析认证，再调用公共目录 hook。
      // 用 keyless auth 表达公共资源；原生目录 hook 不会发送此空 key。
      auth: { apiKey: {
        name: '公共模型目录',
        async resolve() { return { auth: { apiKey: '' } } },
      } },
      async refreshModels(context) {
        await refreshModels({
          ...context,
          credential: undefined,
          async publish(publication) {
            if (context.allowNetwork && publication.persist
              && ((publication.persist.lastModified ?? 0) <= 0 || publication.persist.models.length === 0)) {
              // Pi 会把 404/501 持久化为 lastModified=0；拒绝覆盖，避免下次离线恢复丢失旧目录。
              throw new Error('Pi 远端未提供有效模型目录，已保留已有目录')
            }
            const accepted = await context.publish(publication)
            // 404/501、跳过网络和未成功发布都不能被报成远端刷新成功。
            if (context.allowNetwork && accepted && publication.persist
              && (publication.persist.lastModified ?? 0) > 0
              && publication.persist.models.length > 0) {
              published.add(provider.id)
            }
            return accepted
          },
        })
      },
    })
    installed.add(provider.id)
  }

  return {
    getModels: (provider: string) => runtime.getModels(provider),
    async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
      if (!options.allowNetwork) return runtime.refresh(options)
      const providers = [...new Set(options.providers ?? [])]
      published.clear()
      for (const id of providers) {
        const provider = runtime.getProvider(id)
        if (provider) install(provider)
      }
      // registerNativeProvider 会安排离线同步，先等待它完成再启动网络阶段。
      await runtime.refresh({ allowNetwork: false })
      // 自动刷新节流由 PiRemoteModelCatalog 管理；进入这里必须确认远端响应。
      const result = await runtime.refresh({ ...options, force: true })
      const errors = new Map(result.errors)
      for (const id of providers) {
        if (!result.aborted && !errors.has(id) && !published.has(id)) {
          errors.set(id, new Error('Pi 目录未确认远端更新，继续使用已有目录'))
        }
      }
      return { ...result, errors }
    },
  }
}

import type {
  DefaultResourceLoader,
  ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import type { ExtensionTrustStore } from './pi-extension-trust.ts'

type PiResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]

interface PiResourceLoaderSdk {
  DefaultResourceLoader: new (options: PiResourceLoaderOptions) => ResourceLoader
}

type TrustedResourceLoaderOptions = Omit<
  PiResourceLoaderOptions,
  'additionalExtensionPaths' | 'noExtensions'
>

/**
 * ResourceLoader 的安全构造 seam：调用方不能提交路径，只能提交 Trust Store。
 * store 在任何外部 Extension 进入 Pi loader（并触发模块求值）之前完成 canonical path 与摘要复核。
 */
export function createTrustedPiResourceLoader(
  sdk: PiResourceLoaderSdk,
  trustStore: ExtensionTrustStore,
  projectRoot: string,
  options: TrustedResourceLoaderOptions,
): ResourceLoader {
  const additionalExtensionPaths = trustStore
    .resolveTrustedPaths(projectRoot)
    .map((extension) => extension.path)

  return new sdk.DefaultResourceLoader({
    ...options,
    noExtensions: true,
    additionalExtensionPaths,
  })
}

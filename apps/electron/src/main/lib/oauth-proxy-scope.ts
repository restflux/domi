import { runWithPiRequestProxyScope } from './adapters/pi-request-proxy'
import { getEffectiveProxyUrl } from './proxy-settings-service'

// EnvHttpProxyAgent 以 URL hostname 匹配 IPv6；方括号形式才能匹配 http://[::1]/。
const LOOPBACK_NO_PROXY_HOSTS = ['localhost', '127.0.0.1', '[::1]']

export function readNoProxyEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // 与 EnvHttpProxyAgent 保持相同的 lowercase 优先级。
  const noProxy = env.no_proxy ?? env.NO_PROXY
  return noProxy?.trim() || undefined
}

/** OAuth 浏览器回调必须直连本地 loopback，同时保留用户已有规则。 */
export function buildOAuthNoProxy(noProxy = readNoProxyEnvironment()): string {
  if (noProxy?.trim() === '*') return '*'

  const hosts = new Set(
    (noProxy ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  )
  for (const host of LOOPBACK_NO_PROXY_HOSTS) hosts.add(host)
  return [...hosts].join(',')
}

/**
 * 用 Domi 的应用代理执行 Pi OAuth 内部网络操作。
 * 外部系统浏览器不在此网络平面内；token exchange、polling 和 refresh 在 scope 内。
 */
export async function runWithOAuthProxyScope<T>(
  operation: () => Promise<T>,
  resolveProxyUrl: () => Promise<string | undefined> = getEffectiveProxyUrl,
): Promise<T> {
  return runWithPiRequestProxyScope({
    proxyUrl: await resolveProxyUrl(),
    noProxy: buildOAuthNoProxy(),
  }, operation)
}

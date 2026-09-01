/**
 * 判断当前用户消息是否需要 Chrome DevTools 浏览器能力。
 *
 * 这里有意偏向召回率：误命中只增加当前一轮的启动与 schema 成本，
 * 漏命中则会让已启用的浏览器能力看起来不可用。
 */

const CHINESE_BROWSER_STRONG_PATTERN = /浏览器|谷歌浏览器|开发者工具|开发者面板|浏览器调试|截图|截屏|浏览器控制台|控制台报错|网络抓包|抓包|网络面板|性能追踪|性能剖析|灯塔测试|可访问性快照|页面快照|DOM\s*快照/i

const CHINESE_BROWSER_ACTION_PATTERN = /(?:打开|访问|刷新|操作|截图|截屏|点击|输入|填写|检查).{0,12}(?:网页|页面|网站|元素|按钮|链接)|(?:网页|页面|网站).{0,12}(?:打开|访问|刷新|截图|截屏|点击|输入|填写|控制台|网络请求|网络面板|性能分析|调试)/

const ENGLISH_BROWSER_STRONG_PATTERN = /\b(?:browser|chrome|chromium|devtools|screenshot|lighthouse|viewport|localstorage|sessionstorage|cookies?)\b|\bbrowser\s+console\b|\bnetwork\s+(?:tab|panel|waterfall|capture)\b|\b(?:dom|accessibility|page)\s+snapshot\b|\bperformance\s+(?:trace|profile|panel|audit)\b/i

const ENGLISH_BROWSER_ACTION_PATTERN = /\b(?:open|visit|reload|inspect|capture)\s+(?:the\s+|this\s+|a\s+)?(?:web\s*page|website|page|element|button|link)\b|\b(?:click|type\s+into|interact\s+with)\s+(?:the\s+|this\s+|a\s+)?(?:page|element|button|link|input|form)\b/i

const BROWSER_LOCATION_PATTERN = /https?:\/\/|\b(?:localhost|127\.0\.0\.1)(?::\d+)?\b/i

function hasExplicitChromeDevtoolsIntent(message: string): boolean {
  return CHINESE_BROWSER_STRONG_PATTERN.test(message)
    || CHINESE_BROWSER_ACTION_PATTERN.test(message)
    || ENGLISH_BROWSER_STRONG_PATTERN.test(message)
    || ENGLISH_BROWSER_ACTION_PATTERN.test(message)
}

export function hasChromeDevtoolsIntent(userMessage: string): boolean {
  const message = userMessage.trim()
  if (!message) return false

  return hasExplicitChromeDevtoolsIntent(message) || BROWSER_LOCATION_PATTERN.test(message)
}

export function shouldInjectChromeDevtoolsMcp(
  userEnabled: boolean,
  userMessage: string,
  explicitlyMentioned = false,
): boolean {
  return userEnabled && (explicitlyMentioned || hasChromeDevtoolsIntent(userMessage))
}

export function shouldRequireChromeDevtoolsRestartForQueuedMessage(
  userEnabled: boolean,
  userMessage: string,
  explicitlyMentioned: boolean,
  activeSessionHasChromeTools: boolean,
): boolean {
  if (!userEnabled || activeSessionHasChromeTools) return false
  return explicitlyMentioned || hasExplicitChromeDevtoolsIntent(userMessage.trim())
}

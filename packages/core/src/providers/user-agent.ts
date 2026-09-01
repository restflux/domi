// Kimi Coding Plan 的既有白名单按该 wire identity 判断；仅保留传输兼容，不作为 Domi 产品身份。
const KIMI_COMPATIBILITY_REPO_URL = 'https://github.com/ErlichLiu/Proma'

let _domiCompatibilityVersion = '0.0.0'

export function setDomiCompatibilityVersion(version: string): void {
  _domiCompatibilityVersion = version
}

export function getDomiCompatibilityVersion(): string {
  return _domiCompatibilityVersion
}

export function getKimiCodingPlanUserAgent(version?: string): string {
  const v = version ?? _domiCompatibilityVersion
  return `Proma/${v} (+${KIMI_COMPATIBILITY_REPO_URL})`
}

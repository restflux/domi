const FRIENDLY_ERROR_MESSAGES: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /Pinned fact evidence validation failed|PiContextCompactorValidationError|evidence_validation_failed/i,
    message: '上下文压缩增强证据校验失败，未发送模型请求；请关闭实验开关后重试',
  },
  {
    pattern: /api key|unauthorized|invalid.*key|authentication/i,
    message: '请检查是否选择了正确的 Domi 供应渠道和模型',
  },
  {
    pattern: /validation|schema/i,
    message: 'API 请求格式校验失败，请重试或开启新会话',
  },
]

const MAX_ERROR_MESSAGE_LENGTH = 5000

export function friendlyPiErrorMessage(raw: string): string {
  const isLong = raw.length > MAX_ERROR_MESSAGE_LENGTH
  const sample = isLong ? raw.slice(0, MAX_ERROR_MESSAGE_LENGTH) : raw
  for (const { pattern, message } of FRIENDLY_ERROR_MESSAGES) {
    if (pattern.test(sample)) return message
  }
  return isLong
    ? sample + `\n\n[错误详情过长 (${(raw.length / 1024).toFixed(0)}KB)，已截断]`
    : raw
}

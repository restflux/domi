/**
 * Git / PR 归因兼容层。
 *
 * Domi 是独立的私人 Workbench，不应在用户仓库中注入上游 Proma 的推广标识。
 * 保留现有导出名和设置字段仅用于降低上游合并及旧配置兼容成本。
 */

/** Domi 始终关闭上游推广归因。 */
export const DEFAULT_GIT_ATTRIBUTION_ENABLED = false

/** 旧 Proma 标识，仅用于在禁止提示中识别并避免注入。 */
export const LEGACY_PROMA_OFFICIAL_URL = 'https://proma.cool'
export const LEGACY_PROMA_GITHUB_URL = 'https://github.com/proma-ai/Proma'
export const LEGACY_PROMA_COMMIT_TRAILER = 'Made-with: Proma'
export const LEGACY_PROMA_PR_ATTRIBUTION =
  `Made with [Proma](${LEGACY_PROMA_OFFICIAL_URL}) · [GitHub](${LEGACY_PROMA_GITHUB_URL})`

export interface GitAttributionConfig {
  /** 兼容旧配置；Domi 不会启用该值。 */
  enabled?: boolean
}

/** 无论旧设置为何值，Domi 都不注入上游推广归因。 */
export function isGitAttributionEnabled(
  _config?: GitAttributionConfig | boolean | null,
): boolean {
  return false
}

// Claude Agent SDK attribution sidecar migration was removed with the Pi-only clean cut.

/** 注入统一禁止规则，避免 Agent 自行添加上游 Proma 或其他产品推广标识。 */
export function buildGitAttributionPromptSection(_enabled: boolean): string {
  return `## Git / PR 标识

Domi 不在用户仓库中添加产品推广归因。当你创建 git commit 或 Pull Request / Merge Request 时：
- 不要添加 \`${LEGACY_PROMA_COMMIT_TRAILER}\`、\`${LEGACY_PROMA_PR_ATTRIBUTION}\`、\`Co-Authored-By: Proma\`、\`Generated with Proma\` 或其他产品推广标识
- 不要更改 author / committer 身份
- 只有用户当次明确要求某段归因文本时，才按用户给出的文本添加`
}

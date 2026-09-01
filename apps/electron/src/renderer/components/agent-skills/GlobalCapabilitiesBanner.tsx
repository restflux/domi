import * as React from 'react'
import { Globe2, Info } from 'lucide-react'
import type { GlobalAgentCapabilities } from '@domi/shared'
import { Switch } from '@/components/ui/switch'

interface GlobalCapabilitiesBannerProps {
  capabilities: GlobalAgentCapabilities
  onSkillsEnabledChange: (enabled: boolean) => void
  onMcpEnabledChange: (enabled: boolean) => void
}

export function GlobalCapabilitiesBanner({
  capabilities,
  onSkillsEnabledChange,
  onMcpEnabledChange,
}: GlobalCapabilitiesBannerProps): React.ReactElement {
  return (
    <div className="rounded-xl border border-violet-500/20 bg-violet-500/[0.045] p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/12 text-violet-500">
          <Globe2 size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">外部全局能力</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            只读接入已安装的用户级能力；仅 Pi 会话继承，当前项目的同名 Skill / MCP 优先。
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-lg bg-background/65 px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-foreground">全局 Skills</span>
            <span className="block truncate text-[11px] text-muted-foreground" title={capabilities.skillSourcePaths.join('\n')}>
              检测到 {capabilities.detectedSkills.length} 个 · Pi / .agents / Claude
            </span>
          </span>
          <Switch checked={capabilities.skillsEnabled} onCheckedChange={onSkillsEnabledChange} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg bg-background/65 px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-xs font-medium text-foreground">Pi 全局 MCP</span>
            <span className="block truncate text-[11px] text-muted-foreground" title={capabilities.mcpSourcePath}>
              检测到 {capabilities.detectedMcpServers.length} 个 · 顶层 mcpServers
            </span>
          </span>
          <Switch checked={capabilities.mcpEnabled} onCheckedChange={onMcpEnabledChange} />
        </label>
      </div>

      {capabilities.diagnostics.length > 0 && (
        <div className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-amber-700 dark:text-amber-400">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span title={capabilities.diagnostics.join('\n')}>
            {capabilities.diagnostics[0]}
            {capabilities.diagnostics.length > 1 ? `（另有 ${capabilities.diagnostics.length - 1} 条诊断）` : ''}
          </span>
        </div>
      )}
    </div>
  )
}

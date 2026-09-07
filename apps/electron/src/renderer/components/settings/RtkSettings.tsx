import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { loadRtkSettingsAtom, rtkSettingsAtom, setRtkEnabledAtom } from '@/atoms/rtk-atoms'
import { SettingsCard, SettingsSection, SettingsToggle } from './primitives'

const availabilityLabels = {
  'not-checked': '正在检查内置 RTK…',
  available: '内置 RTK 可用',
  'not-found': '内置 RTK 缺失或损坏，请重新安装 Domi。',
  unsupported: '当前平台暂不支持内置 RTK，命令将返回原始输出。',
  incompatible: '内置 RTK 版本不兼容，请重新安装 Domi。',
  error: '内置 RTK 暂不可用，命令将返回原始输出。',
}

export function RtkSettings(): React.ReactElement {
  const state = useAtomValue(rtkSettingsAtom)
  const load = useSetAtom(loadRtkSettingsAtom)
  const setEnabled = useSetAtom(setRtkEnabledAtom)
  useEffect(() => { void load() }, [load])
  const { status } = state
  const savedBytes = Math.max(0, status.originalBytes - status.returnedBytes)
  const percent = status.originalBytes > 0 ? savedBytes / status.originalBytes * 100 : 0
  return (
    <SettingsSection title="命令输出优化" description="使用内置 RTK 减少传给模型的命令输出，无需额外安装，完整原文仍可读取。">
      <SettingsCard>
        <SettingsToggle
          label="启用 RTK（实验性）"
          description="仅优化执行模式中受支持命令的成功输出；研究模式、失败输出及终端不受影响。关闭后从下一次调用恢复原始输出。"
          checked={state.enabled}
          disabled={!state.loaded || state.busy || (!state.enabled && status.availability !== 'available')}
          onCheckedChange={enabled => { void setEnabled(enabled) }}
        />
        <div className="space-y-3 px-4 pb-4 text-sm">
          <p className="text-muted-foreground" role="status">
            {availabilityLabels[status.availability]}{status.version ? ` · ${status.version}` : ''}
          </p>
          <p className="text-xs text-muted-foreground">支持部分 Git 状态/日志及类型检查、测试命令；不优化 bun test、任意脚本或已截断输出。</p>
          <p className="text-xs text-muted-foreground">
            本次应用运行：已优化 {status.optimizedCalls} 次 · 估算减少 {Math.ceil(savedBytes / 4).toLocaleString()} tokens · 输出减少 {percent.toFixed(1)}%
          </p>
          <p className="text-xs text-muted-foreground">统计含原文引用开销，不代表会话总用量或实际费用；重新打开此页面时刷新。</p>
          {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

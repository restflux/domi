import * as React from 'react'
import { useAtomValue } from 'jotai'
import { ThinkingOrb, type OrbState, type ThinkingOrbProps } from 'thinking-orbs'
import { resolvedThemeAtom } from '@/atoms/theme'

export type AgentActivityOrbProps = Omit<ThinkingOrbProps, 'theme'>

/** 主 Agent 运行时沿用的两种活动状态。 */
export const AGENT_RUNNING_ORB_STATES = ['composing', 'breathing'] as const

/**
 * Domi 的 Agent 活动动画。
 *
 * 显式使用应用已经解析好的主题，避免每个 Orb 都单独监听 DOM 主题变化。
 * 仅用于少量、重要且持续时间较长的 Agent 状态；按钮和列表加载仍使用 CSS Spinner。
 */
export function AgentActivityOrb(props: AgentActivityOrbProps): React.ReactElement {
  const theme = useAtomValue(resolvedThemeAtom)
  return <ThinkingOrb theme={theme} {...props} />
}

interface RotatingAgentActivityOrbProps extends Omit<AgentActivityOrbProps, 'state'> {
  states: readonly OrbState[]
  intervalMs?: number
}

/** 单实例轮换多个活动状态；页面隐藏或用户偏好减弱动态效果时停止轮换。 */
export function RotatingAgentActivityOrb({
  states,
  intervalMs = 5_500,
  style,
  ...props
}: RotatingAgentActivityOrbProps): React.ReactElement {
  const [index, setIndex] = React.useState(0)
  const [fading, setFading] = React.useState(false)
  const [reducedMotion, setReducedMotion] = React.useState(false)

  React.useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  React.useEffect(() => {
    if (states.length < 2 || reducedMotion) {
      setFading(false)
      return
    }

    let interval: number | undefined
    let fadeTimer: number | undefined
    let showTimer: number | undefined

    const stop = (): void => {
      if (interval !== undefined) window.clearInterval(interval)
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer)
      if (showTimer !== undefined) window.clearTimeout(showTimer)
      interval = undefined
      fadeTimer = undefined
      showTimer = undefined
    }
    const start = (): void => {
      stop()
      if (document.visibilityState === 'hidden') return
      interval = window.setInterval(() => {
        setFading(true)
        fadeTimer = window.setTimeout(() => {
          setIndex((current) => (current + 1) % states.length)
          showTimer = window.setTimeout(() => setFading(false), 40)
        }, 160)
      }, intervalMs)
    }
    const handleVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        stop()
        setFading(false)
      } else {
        start()
      }
    }

    start()
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [intervalMs, reducedMotion, states])

  const state = states[index % Math.max(1, states.length)] ?? 'working'

  return (
    <AgentActivityOrb
      state={state}
      style={{
        ...style,
        opacity: fading ? 0.25 : 1,
        transition: reducedMotion ? undefined : 'opacity 160ms ease',
      }}
      {...props}
    />
  )
}

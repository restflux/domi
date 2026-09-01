import type { BridgeInteractionView } from '../bridge-interaction-coordinator'

const CALLBACK_KIND = 'domi_bridge_interaction'

export interface FeishuInteractionActionValue {
  kind: typeof CALLBACK_KIND
  requestId: string
  actionId: string
}

export function parseFeishuInteractionActionValue(value: unknown): FeishuInteractionActionValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.kind !== CALLBACK_KIND) return null
  if (typeof record.requestId !== 'string' || record.requestId.length === 0 || record.requestId.length > 200) return null
  if (typeof record.actionId !== 'string' || record.actionId.length === 0 || record.actionId.length > 100) return null
  return {
    kind: CALLBACK_KIND,
    requestId: record.requestId,
    actionId: record.actionId,
  }
}

function markdown(content: string): Record<string, unknown> {
  return { tag: 'markdown', content }
}

export function buildFeishuInteractionCard(view: BridgeInteractionView): Record<string, unknown> {
  const content = [view.context, view.prompt].filter(Boolean).join('\n\n')
  const elements: Array<Record<string, unknown>> = [markdown(content)]
  const canUseButtons = !view.desktopOnly && !view.multiSelect && view.options.length > 0

  if (canUseButtons) {
    elements.push({
      tag: 'action',
      actions: view.options.map((option, index) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: option.label },
        type: index === 0 ? 'primary' : 'default',
        value: {
          kind: CALLBACK_KIND,
          requestId: view.requestId,
          actionId: option.actionId,
        } satisfies FeishuInteractionActionValue,
      })),
    })
    elements.push(markdown(`按钮不可用时，可直接回复序号：${view.options.map((option) => `${option.id}=${option.label}`).join(' · ')}`))
  } else if (!view.desktopOnly) {
    const hint = view.options.length > 0
      ? (view.multiSelect ? '直接回复多个序号，例如 1,3。' : '直接回复序号或完整选项文字。')
      : '直接回复内容即可。'
    elements.push(markdown([
      ...view.options.map((option) => `${option.id}. ${option.label}${option.description ? ` · ${option.description}` : ''}`),
      hint,
    ].join('\n')))
  } else {
    elements.push(markdown('此确认涉及宿主或权限边界，请回 Domi 桌面处理。'))
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: view.title },
      template: view.desktopOnly ? 'orange' : 'blue',
    },
    elements,
  }
}

export function buildFeishuInteractionResolvedCard(
  title: string,
  message: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'green',
    },
    elements: [markdown(message)],
  }
}

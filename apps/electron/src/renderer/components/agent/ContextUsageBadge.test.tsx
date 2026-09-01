import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextBreakdownDetails, ContextOperationalDetails, ContextUsageHeader } from './ContextUsageBadge.tsx'

describe('ContextUsageHeader', () => {
  test('标题与百分比位于同一基线，Token 数值独立位于右侧第二行', () => {
    const html = renderToStaticMarkup(
      <ContextUsageHeader
        percent={51}
        displayTokens={137_600}
        displayWindow={272_000}
        isEstimated
        isWarning={false}
      />,
    )

    expect(html).toContain('grid-cols-[1fr_auto]')
    expect(html).toContain('items-baseline')
    expect(html).toContain('上下文用量')
    expect(html).toContain('51%')
    expect(html).toContain('col-start-2')
    expect(html).toContain('≈137.6k / 272.0k')
    expect(html).not.toContain('items-end')
  })
})

describe('ContextOperationalDetails', () => {
  test('只显示缓存命中率和模型请求统计', () => {
    const html = renderToStaticMarkup(
      <ContextOperationalDetails
        sessionCacheMetrics={{
          inputTokens: 10_000,
          cacheReadTokens: 8_000,
          hitRate: 0.8,
          measuredRequests: 14,
          totalRequests: 16,
        }}
      />,
    )

    expect(html).toContain('缓存命中')
    expect(html).not.toContain('会话缓存命中率')
    expect(html).not.toContain('自动压缩阈值')
    expect(html).not.toContain('Token 加权')
    expect(html).toContain('80.0%')
    expect(html).toContain('统计 14/16 次请求')
    expect(html).not.toContain('非缓存输入')
    expect(html).not.toContain('缓存读取')
    expect(html).not.toContain('缓存写入')
    expect(html).not.toContain('输出')
    expect(html).not.toContain('本轮费用')
  })

  test('没有有效缓存样本时仍显示暂无数据而不是隐藏整行', () => {
    const html = renderToStaticMarkup(
      <ContextOperationalDetails
        sessionCacheMetrics={{
          inputTokens: 0,
          cacheReadTokens: 0,
          hitRate: undefined,
          measuredRequests: 0,
          totalRequests: 3,
        }}
      />,
    )

    expect(html).toContain('缓存命中')
    expect(html).not.toContain('Token 加权')
    expect(html).toContain('暂无数据')
    expect(html).toContain('统计 0/3 次请求')
  })

  test('完整 usage 的零缓存命中率显示为 0.0%', () => {
    const html = renderToStaticMarkup(
      <ContextOperationalDetails
        sessionCacheMetrics={{
          inputTokens: 10_000,
          cacheReadTokens: 0,
          hitRate: 0,
          measuredRequests: 1,
          totalRequests: 1,
        }}
      />,
    )

    expect(html).toContain('0.0%')
    expect(html).not.toContain('暂无数据')
  })
})

describe('ContextBreakdownDetails', () => {
  test('没有实时构成时显示下一次请求占位说明', () => {
    const html = renderToStaticMarkup(<ContextBreakdownDetails />)

    expect(html).toContain('上下文构成')
    expect(html).toContain('按实际请求结构估算')
    expect(html).toContain('构成数据将在下次模型请求后生成')
  })

  test('有实时构成时按 Token 从高到低显示五类构成', () => {
    const html = renderToStaticMarkup(<ContextBreakdownDetails items={[
      { key: 'mcp', label: 'MCP', tokens: 30_000, ratio: 0.3 },
      { key: 'conversation', label: '对话历史', tokens: 25_000, ratio: 0.25 },
      { key: 'system', label: '系统提示词', tokens: 20_000, ratio: 0.2 },
      { key: 'tools', label: '内置工具', tokens: 15_000, ratio: 0.15 },
      { key: 'skills', label: 'Skills', tokens: 10_000, ratio: 0.1 },
    ]} />)

    expect(html).toContain('系统提示词')
    expect(html).toContain('Skills')
    expect(html).toContain('MCP')
    expect(html).toContain('内置工具')
    expect(html).toContain('对话历史')
    expect(html).toContain('20.0k · 20.0%')
    expect(html.indexOf('MCP')).toBeLessThan(html.indexOf('对话历史'))
    expect(html.indexOf('对话历史')).toBeLessThan(html.indexOf('系统提示词'))
    expect(html.indexOf('系统提示词')).toBeLessThan(html.indexOf('内置工具'))
    expect(html.indexOf('内置工具')).toBeLessThan(html.indexOf('Skills'))
    expect(html).not.toContain('构成数据将在下次模型请求后生成')
  })
})

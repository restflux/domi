/**
 * McpServerForm - MCP 服务器创建/编辑表单
 *
 * 支持 stdio / http / sse 三种传输类型，
 * 复用设置原语组件实现卡片化布局。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import '@/i18n'
import { ArrowLeft, Loader2, CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { McpServerEntry, McpTransportType, WorkspaceMcpConfig } from '@domi/shared'
import {
  SettingsSection,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsToggle,
} from './primitives'

/** 编辑中的服务器 */
interface EditingServer {
  name: string
  entry: McpServerEntry
}

interface McpServerFormProps {
  /** 编辑模式传入已有服务器，创建模式传 null */
  server: EditingServer | null
  /** 当前工作区 slug */
  workspaceSlug: string
  onSaved: () => void
  onChanged?: () => void
  onCancel: () => void
}

/** 传输类型选项 */
const TRANSPORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'stdio', label: 'stdio（命令行）' },
  { value: 'http', label: 'HTTP（Streamable HTTP）' },
  { value: 'sse', label: 'SSE（Server-Sent Events）' },
]

/**
 * 解析多行文本为 key=value / key: value 的 Record
 *
 * 支持：
 * - KEY=VALUE（环境变量格式）
 * - Key: Value（HTTP 头格式）
 */
function parseKeyValueText(text: string, separator: '=' | ':'): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(separator)
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (key) result[key] = value
  }
  return result
}

/**
 * 将 Record 序列化为多行 key=value / key: value 文本
 */
function serializeKeyValueText(record: Record<string, string> | undefined, separator: '=' | ':'): string {
  if (!record) return ''
  return Object.entries(record)
    .map(([key, value]) => `${key}${separator}${separator === ':' ? ' ' : ''}${value}`)
    .join('\n')
}

interface McpFormValues {
  transportType: McpTransportType
  enabled: boolean
  trustReadOnlyAnnotations: boolean
  testResult: { success: boolean; message: string; timestamp?: number } | null
  isBuiltin: boolean
  command: string
  argsText: string
  envText: string
  timeoutStr: string
  url: string
  headersText: string
}

/** 根据当前表单值构建 McpServerEntry */
function buildEntryFromValues(values: McpFormValues, includeTestResult = false): McpServerEntry {
  const base: McpServerEntry = {
    type: values.transportType,
    enabled: values.enabled,
    ...(values.isBuiltin && { isBuiltin: true }),
    ...(values.trustReadOnlyAnnotations && { trustReadOnlyAnnotations: true }),
    ...(includeTestResult && values.testResult && {
      lastTestResult: {
        ...values.testResult,
        timestamp: values.testResult.timestamp ?? Date.now(),
      },
    }),
  }

  if (values.transportType === 'stdio') {
    base.command = values.command.trim()
    const args = values.argsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (args.length > 0) base.args = args
    const env = parseKeyValueText(values.envText, '=')
    if (Object.keys(env).length > 0) base.env = env
    const timeout = parseInt(values.timeoutStr, 10)
    if (!isNaN(timeout) && timeout > 0) base.timeout = timeout
  } else {
    base.url = values.url.trim()
    const headers = parseKeyValueText(values.headersText, ':')
    if (Object.keys(headers).length > 0) base.headers = headers
  }

  return base
}

export function McpServerForm({ server, workspaceSlug, onSaved, onChanged, onCancel }: McpServerFormProps): React.ReactElement {
  const { t } = useTranslation('settings')
  const isEdit = server !== null
  const isBuiltin = server?.entry.isBuiltin === true

  // 表单状态
  const [name, setName] = React.useState(server?.name ?? '')
  const [transportType, setTransportType] = React.useState<McpTransportType>(server?.entry.type ?? 'stdio')
  const [enabled, setEnabled] = React.useState(server?.entry.enabled ?? false) // 默认关闭
  const [trustReadOnlyAnnotations, setTrustReadOnlyAnnotations] = React.useState(
    server?.entry.trustReadOnlyAnnotations ?? false,
  )

  // stdio 字段
  const [command, setCommand] = React.useState(server?.entry.command ?? '')
  const [argsText, setArgsText] = React.useState(server?.entry.args?.join(', ') ?? '')
  const [envText, setEnvText] = React.useState(serializeKeyValueText(server?.entry.env, '='))
  const [timeoutStr, setTimeoutStr] = React.useState(
    server?.entry.timeout != null ? String(server.entry.timeout) : ''
  )

  // http/sse 字段
  const [url, setUrl] = React.useState(server?.entry.url ?? '')
  const [headersText, setHeadersText] = React.useState(serializeKeyValueText(server?.entry.headers, ':'))

  // UI 状态
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResult, setTestResult] = React.useState<{ success: boolean; message: string; timestamp?: number } | null>(
    server?.entry.lastTestResult ?? null
  )

  // 自动保存状态（仅编辑模式）
  const AUTO_SAVE_DELAY = 600
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstRenderRef = React.useRef(true)
  const mountedRef = React.useRef(true)
  const [saveStatus, setSaveStatus] = React.useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const lastSavedEnabledRef = React.useRef(server?.entry.enabled ?? false)
  const lastSavedTrustRef = React.useRef(server?.entry.trustReadOnlyAnnotations ?? false)

  // 保留最新表单值，供 unmount 时 flush 待保存变更
  const latestValuesRef = React.useRef({
    name, transportType, command, url, argsText, envText, headersText, timeoutStr,
    enabled, trustReadOnlyAnnotations, testResult, isBuiltin,
  })
  React.useEffect(() => {
    latestValuesRef.current = {
      name, transportType, command, url, argsText, envText, headersText, timeoutStr,
      enabled, trustReadOnlyAnnotations, testResult, isBuiltin,
    }
  }, [name, transportType, command, url, argsText, envText, headersText, timeoutStr, enabled, trustReadOnlyAnnotations, testResult, isBuiltin])

  // 监听配置改变，清空测试结果（避免展示过期的测试结果）
  React.useEffect(() => {
    if (!server) return // 新建时不需要清空

    // 检查关键配置是否改变（包括连接相关的所有字段）
    // 注意：server.entry.command/url 可能为 undefined，需要与空字符串统一比较
    const configChanged =
      transportType !== server.entry.type ||
      (transportType === 'stdio' && command !== (server.entry.command ?? '')) ||
      (transportType !== 'stdio' && url !== (server.entry.url ?? '')) ||
      argsText !== (server.entry.args?.join(', ') ?? '') ||
      envText !== serializeKeyValueText(server.entry.env, '=') ||
      headersText !== serializeKeyValueText(server.entry.headers, ':')

    if (configChanged) {
      setTestResult(null)
    }
  }, [transportType, command, url, argsText, envText, headersText, server])

  /** 构建 McpServerEntry */
  const buildEntry = (includeTestResult = false): McpServerEntry => {
    return buildEntryFromValues(
      {
        transportType,
        enabled,
        trustReadOnlyAnnotations,
        testResult,
        isBuiltin,
        command,
        argsText,
        envText,
        timeoutStr,
        url,
        headersText,
      },
      includeTestResult,
    )
  }

  const saveGenerationRef = React.useRef(0)

  /** 执行自动保存 */
  const doSaveEntry = React.useCallback(async (serverName: string, entry: McpServerEntry) => {
    const generation = ++saveGenerationRef.current
    try {
      const config = await window.electronAPI.getWorkspaceMcpConfig(workspaceSlug)
      const newConfig: WorkspaceMcpConfig = {
        servers: { ...config.servers, [serverName]: entry },
      }
      await window.electronAPI.saveWorkspaceMcpConfig(workspaceSlug, newConfig)
      if (generation === saveGenerationRef.current && mountedRef.current) {
        if (entry.enabled !== lastSavedEnabledRef.current
          || (entry.trustReadOnlyAnnotations ?? false) !== lastSavedTrustRef.current) {
          lastSavedEnabledRef.current = entry.enabled
          lastSavedTrustRef.current = entry.trustReadOnlyAnnotations ?? false
          onChanged?.()
        }
        setSaveStatus('saved')
        setTimeout(() => {
          if (generation === saveGenerationRef.current && mountedRef.current) {
            setSaveStatus('idle')
          }
        }, 3000)
      }
    } catch (error) {
      console.error('[MCP 表单] 自动保存失败:', error)
      if (generation === saveGenerationRef.current && mountedRef.current) {
        toast.error(t('mcpSaveFailed'))
        setSaveStatus('error')
      }
    }
  }, [workspaceSlug, onChanged])

  const doSaveEntryRef = React.useRef(doSaveEntry)
  React.useEffect(() => { doSaveEntryRef.current = doSaveEntry }, [doSaveEntry])

  // 编辑模式下监听字段变化，防抖自动保存
  React.useEffect(() => {
    if (!isEdit) return
    // 首次渲染跳过，避免加载时触发 auto-save
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      return
    }
    const serverName = name.trim()
    if (!serverName) return
    if (transportType === 'stdio' && !command.trim()) return
    if (transportType !== 'stdio' && !url.trim()) return
    setSaveStatus('idle')
    autoSaveTimerRef.current = setTimeout(() => {
      const vals = latestValuesRef.current
      const entry = buildEntryFromValues(vals, true)
      void doSaveEntryRef.current(vals.name.trim(), entry)
    }, AUTO_SAVE_DELAY)
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
      }
    }
  }, [
    isEdit,
    name,
    transportType,
    command,
    url,
    argsText,
    envText,
    headersText,
    timeoutStr,
    enabled,
    trustReadOnlyAnnotations,
    testResult,
  ])

  // 组件卸载时 flush 待保存的变更，并标记 unmounted
  React.useEffect(() => {
    return () => {
      mountedRef.current = false
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = null
        const vals = latestValuesRef.current
        const serverName = vals.name.trim()
        if (!serverName) return
        if (vals.transportType === 'stdio' && !vals.command.trim()) return
        if (vals.transportType !== 'stdio' && !vals.url.trim()) return
        const entry = buildEntryFromValues(vals, true)
        void doSaveEntryRef.current(serverName, entry)
      }
    }
  }, [])
  const handleTest = async (): Promise<void> => {
    const serverName = name.trim()
    if (!serverName) return

    // stdio 需要 command，http/sse 需要 url
    if (transportType === 'stdio' && !command.trim()) return
    if (transportType !== 'stdio' && !url.trim()) return

    setTesting(true)
    setTestResult(null)

    try {
      const entry = buildEntry(false) // 测试时不包含旧的测试结果
      const result = await window.electronAPI.testMcpServer(serverName, entry)
      setTestResult({
        success: result.success,
        message: result.message,
        timestamp: Date.now(),
      })
    } catch (error) {
      setTestResult({
        success: false,
        message: error instanceof Error ? error.message : t('connectionFailed'),
        timestamp: Date.now(),
      })
    } finally {
      setTesting(false)
    }
  }

  /** 提交表单（仅创建模式） */
  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (isEdit) return

    const serverName = name.trim()
    if (!serverName) return

    // stdio 需要 command，http/sse 需要 url
    if (transportType === 'stdio' && !command.trim()) return
    if (transportType !== 'stdio' && !url.trim()) return

    setSaving(true)
    try {
      // 读取现有配置
      const config = await window.electronAPI.getWorkspaceMcpConfig(workspaceSlug)
      const entry = buildEntry(true) // 保存时包含测试结果

      console.log(`[MCP 表单] 保存 MCP: ${serverName}, enabled: ${entry.enabled}, testResult: ${testResult?.success ?? '未测试'}`)

      const newConfig: WorkspaceMcpConfig = {
        servers: {
          ...config.servers,
          [serverName]: entry,
        },
      }
      await window.electronAPI.saveWorkspaceMcpConfig(workspaceSlug, newConfig)
      onSaved()
    } catch (error) {
      console.error('[MCP 表单] 保存失败:', error)
    } finally {
      setSaving(false)
    }
  }

  /** 判断表单是否可提交 */
  const canSubmit = (): boolean => {
    if (!name.trim()) return false
    if (transportType === 'stdio' && !command.trim()) return false
    if (transportType !== 'stdio' && !url.trim()) return false
    return true
  }

  /** 判断是否可以测试 */
  const canTest = (): boolean => {
    return canSubmit()
  }

  /** 返回/关闭：编辑模式下先 flush 待保存变更 */
  const handleCancel = async (): Promise<void> => {
    if (isEdit && autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current)
      autoSaveTimerRef.current = null
      const vals = latestValuesRef.current
      const serverName = vals.name.trim()
      if (serverName) {
        const isValid =
          (vals.transportType === 'stdio' && vals.command.trim()) ||
          (vals.transportType !== 'stdio' && vals.url.trim())
        if (isValid) {
          const entry = buildEntryFromValues(vals, true)
          await doSaveEntryRef.current(serverName, entry)
        }
      }
    }
    onCancel()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* 标题栏 + 操作按钮 */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" type="button" onClick={() => void handleCancel()}>
          <ArrowLeft size={18} />
        </Button>
        <h3 className="text-lg font-medium text-foreground flex-1">
          {isEdit ? t('mcpEdit') : t('mcpCreate')}
        </h3>
        {isEdit && (saveStatus === 'saved' || saveStatus === 'error') && (
          <div className={cn(
            'flex items-center gap-1.5 text-xs',
            saveStatus === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}>
            {saveStatus === 'saved' && <CheckCircle2 size={12} className="text-emerald-600" />}
            {saveStatus === 'error' && <XCircle size={12} />}
            <span>
              {saveStatus === 'saved' && t('saved')}
              {saveStatus === 'error' && t('mcpSaveFailed')}
            </span>
          </div>
        )}
        {!isEdit && (
          <Button size="sm" type="submit" disabled={saving || !canSubmit()}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            <span>{t('mcpCreate')}</span>
          </Button>
        )}
      </div>

      {/* 基本信息 */}
      <SettingsSection title={t('mcpBasicInfo')}>
        <SettingsCard>
          <SettingsInput
            label={t('mcpServerName')}
            value={name}
            onChange={setName}
            placeholder="e.g. github-mcp"
            required
            disabled={isEdit}
          />
          <SettingsSelect
            label={t('mcpTransport')}
            value={transportType}
            onValueChange={(v) => setTransportType(v as McpTransportType)}
            options={TRANSPORT_OPTIONS}
            placeholder={t('mcpTransport')}
            disabled={isBuiltin}
          />

          {/* stdio 专用字段 */}
          {transportType === 'stdio' && (
            <>
              <SettingsInput
                label={t('mcpCommand')}
                value={command}
                onChange={setCommand}
                placeholder="e.g. npx"
                required
                disabled={isBuiltin}
              />
              <SettingsInput
                label={t('mcpArguments')}
                value={argsText}
                onChange={setArgsText}
                placeholder="Comma-separated, e.g. -y, @modelcontextprotocol/server-github"
                description={t('mcpArgumentsDescription')}
                disabled={isBuiltin}
              />
              {/* 环境变量多行输入 */}
              <div className="px-4 py-3 space-y-2">
                <div>
                  <div className="text-sm font-medium text-foreground">{t('mcpEnvironment')}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{t('mcpEnvironmentDescription')}</div>
                </div>
                <textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder="GITHUB_TOKEN=ghp_xxx&#10;DEBUG=true"
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y font-mono"
                />
              </div>
              <SettingsInput
                label={t('mcpTimeout')}
                description={t('mcpTimeoutDescription')}
                value={timeoutStr}
                onChange={setTimeoutStr}
                placeholder="30"
                type="number"
              />
            </>
          )}

          {/* http/sse 专用字段 */}
          {transportType !== 'stdio' && (
            <>
              <SettingsInput
                label="URL"
                value={url}
                onChange={setUrl}
                placeholder="e.g. http://localhost:3000/mcp"
                required
              />
              {/* 请求头多行输入 */}
              <div className="px-4 py-3 space-y-2">
                <div>
                  <div className="text-sm font-medium text-foreground">{t('mcpHeaders')}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{t('mcpHeadersDescription')}</div>
                </div>
                <textarea
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder="Authorization: Bearer xxx&#10;X-Custom-Header: value"
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y font-mono"
                />
              </div>
            </>
          )}

          {/* 测试连接区域 */}
          <div className="px-4 py-3 space-y-3 border-t border-border">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-foreground">{t('mcpConnectionTest')}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Optional diagnostic tool; test results do not affect whether MCP is enabled
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={testing || !canTest()}
              >
                {testing && <Loader2 size={14} className="animate-spin" />}
                <span>{testing ? t('testing') : t('testConnection')}</span>
              </Button>
            </div>

            {/* 测试结果显示 */}
            {testResult && (
              <div
                className={cn(
                  'flex items-start gap-2 px-3 py-2 rounded-md text-sm',
                  testResult.success
                    ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                    : 'bg-red-500/10 text-red-700 dark:text-red-400'
                )}
              >
                {testResult.success ? (
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
                ) : (
                  <XCircle size={16} className="mt-0.5 shrink-0" />
                )}
                <div className="flex-1">
                  <div className="font-medium">
                    {testResult.success ? t('connectionPassed') : t('connectionFailed')}
                  </div>
                  <div className="text-xs mt-0.5 opacity-90">{testResult.message}</div>
                </div>
              </div>
            )}

            {/* 未测试警告 */}
            {!testResult && !testing && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-md text-sm bg-amber-500/10 text-amber-700 dark:text-amber-400">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <div className="text-xs">
                  {t('mcpNotTested')}
                </div>
              </div>
            )}
          </div>

          <SettingsToggle
            label={t('mcpTrustReadOnly')}
            description={t('mcpTrustReadOnlyDescription')}
            checked={trustReadOnlyAnnotations}
            onCheckedChange={setTrustReadOnlyAnnotations}
          />

          {/* 启用开关 */}
          <SettingsToggle
            label={t('mcpEnable')}
            description={
              testResult?.success
                ? t('mcpEnabledDescription')
                : t('mcpEnabledWarning')
            }
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </SettingsCard>
      </SettingsSection>
    </form>
  )
}

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const temporaryDirectories: string[] = []
const nodeRequire = createRequire(import.meta.url)
const repositoryRoot = resolve(import.meta.dir, '../../../../../..')
const rendererRoot = resolve(import.meta.dir, '../..')
const toolbarPath = resolve(import.meta.dir, 'RightWorkspaceToolbar.tsx')
const tooltipPath = resolve(rendererRoot, 'components/ui/tooltip.tsx')

interface ToolbarInteractionResult {
  initialExpanded: string | null
  openedExpanded: string | null
  browserVisible: boolean
  scratchVisible: boolean
  menuZIndex: number
  menuIsTopmost: boolean
  escapedExpanded: string | null
  selectedTool: string | null
  selectedExpanded: string | null
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function resolveElectronExecutable(): string {
  const electronPackageRoot = dirname(nodeRequire.resolve('electron/package.json'))
  if (process.platform === 'win32') {
    return join(electronPackageRoot, 'dist/electron.exe')
  }
  if (process.platform === 'darwin') {
    return join(electronPackageRoot, 'dist/Electron.app/Contents/MacOS/Electron')
  }
  return join(electronPackageRoot, 'dist/electron')
}

async function buildInteractionHarness(directory: string): Promise<void> {
  const browserEntryPath = join(directory, 'browser-entry.tsx')
  const mainEntryPath = join(directory, 'main.cjs')
  const htmlPath = join(directory, 'index.html')

  writeFileSync(browserEntryPath, `
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { RightWorkspaceToolbar } from ${JSON.stringify(toolbarPath.replaceAll('\\', '/'))}
import { TooltipProvider } from ${JSON.stringify(tooltipPath.replaceAll('\\', '/'))}

declare global {
  interface Window {
    __toolbarReady?: boolean
    __selectedTool?: string | null
  }
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <TooltipProvider>
    <div className="relative z-[60] h-screen bg-background p-4" data-testid="app-shell-workspace-layer">
      <div className="titlebar-drag-region" aria-hidden="true" />
      <RightWorkspaceToolbar
        tabs={[
          { id: 'files', tool: 'files', label: '文件', closeable: false },
          { id: 'changes', tool: 'changes', label: '改动', closeable: false },
        ]}
        activeTabId="files"
        scratchVisible={false}
        hasUnseenChanges={false}
        expandAvailable={true}
        expanded={false}
        onTabChange={() => {}}
        onCloseTab={() => {}}
        onAddBrowser={() => { window.__selectedTool = 'browser' }}
        onShowScratch={() => { window.__selectedTool = 'scratch' }}
        onToggleExpand={() => {}}
      />
    </div>
  </TooltipProvider>,
)
requestAnimationFrame(() => requestAnimationFrame(() => { window.__toolbarReady = true }))
`)

  writeFileSync(htmlPath, `<!doctype html><html><head><style>
html,body,#root{height:100%;margin:0;background:#111827;color:#f9fafb}
.relative{position:relative}.z\\-\\[60\\]{z-index:60}.z\\-\\[100\\]{z-index:100}.h-screen{height:100vh}
.bg-background{background:#111827}.p-4{padding:1rem}
.titlebar-drag-region{position:absolute;inset:0 0 auto 0;height:34px;pointer-events:none;-webkit-app-region:drag}
.titlebar-no-drag{-webkit-app-region:no-drag}
</style></head><body><div id="root"></div><script type="module" src="./browser-entry.js"></script></body></html>`)

  writeFileSync(mainEntryPath, `
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(window, expression, message) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return
    await sleep(20)
  }
  throw new Error(message)
}

async function getCenter(window, expression, message) {
  const point = await window.webContents.executeJavaScript(expression)
  if (!point) throw new Error(message)
  return point
}

async function click(window, point) {
  window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
  window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await sleep(80)
  window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  await window.loadFile(path.join(__dirname, 'index.html'))
  window.webContents.focus()
  await waitFor(window, 'window.__toolbarReady === true', '等待完整 Right Workspace Shell 挂载超时')

  const triggerExpression = ` + "`" + `(() => {
    const element = document.querySelector('button[aria-label="添加工具"]')
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()` + "`" + `
  const triggerPoint = await getCenter(window, triggerExpression, '未找到添加工具按钮')
  const initialExpanded = await window.webContents.executeJavaScript(
    "document.querySelector('button[aria-haspopup=menu]')?.getAttribute('aria-expanded') ?? null",
  )

  await click(window, triggerPoint)
  await waitFor(
    window,
    "document.querySelector('button[aria-haspopup=menu]')?.getAttribute('aria-expanded') === 'true'",
    '真实点击添加工具后菜单未打开',
  )

  const openedState = await window.webContents.executeJavaScript(` + "`" + `(() => {
    const trigger = document.querySelector('button[aria-label="添加工具"]')
    const menu = document.querySelector('[role="menu"]')
    if (!menu) return null
    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'))
    const browserItem = menuItems.find((item) => item.textContent?.includes('浏览器') && item.getAttribute('aria-label') !== '关闭浏览器')
    const scratchItem = menuItems.find((item) => item.textContent?.includes('草稿'))
    const rect = menu.getBoundingClientRect()
    const hitTarget = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      openedExpanded: trigger?.getAttribute('aria-expanded') ?? null,
      browserVisible: Boolean(browserItem),
      scratchVisible: Boolean(scratchItem),
      menuZIndex: Number.parseInt(getComputedStyle(menu).zIndex, 10),
      menuIsTopmost: hitTarget !== null && menu.contains(hitTarget),
    }
  })()` + "`" + `)
  if (!openedState) throw new Error('点击添加工具后未找到菜单内容')

  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await waitFor(
    window,
    "document.querySelector('button[aria-haspopup=menu]')?.getAttribute('aria-expanded') === 'false'",
    'Esc 后添加工具菜单未关闭',
  )
  const escapedExpanded = await window.webContents.executeJavaScript(
    "document.querySelector('button[aria-haspopup=menu]')?.getAttribute('aria-expanded') ?? null",
  )

  await click(window, triggerPoint)
  await waitFor(
    window,
    "document.querySelector('button[aria-haspopup=menu]')?.getAttribute('aria-expanded') === 'true'",
    '第二次真实点击添加工具后菜单未打开',
  )
  const browserPoint = await getCenter(window, ` + "`" + `(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((candidate) => candidate.textContent?.includes('浏览器') && candidate.getAttribute('aria-label') !== '关闭浏览器')
    if (!item) return null
    const rect = item.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()` + "`" + `, '重新打开菜单后未找到浏览器菜单项')
  await click(window, browserPoint)
  await waitFor(
    window,
    "window.__selectedTool === 'browser' && document.querySelector('button[aria-haspopup=menu]')?.getAttribute('aria-expanded') === 'false'",
    '真实选择浏览器后工具未切换或菜单未关闭',
  )

  const result = {
    initialExpanded,
    ...openedState,
    escapedExpanded,
    selectedTool: await window.webContents.executeJavaScript('window.__selectedTool ?? null'),
    selectedExpanded: await window.webContents.executeJavaScript(
      "document.querySelector('button[aria-haspopup=menu]')?.getAttribute('aria-expanded') ?? null",
    ),
  }
  process.stdout.write('TOOLBAR_RESULT:' + JSON.stringify({ result }) + '\\n')
  window.destroy()
  app.exit(0)
}).catch((error) => {
  process.stdout.write('TOOLBAR_RESULT:' + JSON.stringify({ error: String(error && error.stack ? error.stack : error) }) + '\\n')
  app.exit(1)
})
`)

  const buildResult = await Bun.build({
    entrypoints: [browserEntryPath],
    outdir: directory,
    target: 'browser',
    format: 'esm',
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    plugins: [{
      name: 'renderer-resolver',
      setup(builder) {
        builder.onResolve({ filter: /^@\// }, (args) => ({
          path: Bun.resolveSync(`./${args.path.slice(2)}`, rendererRoot),
        }))
        builder.onResolve({ filter: /^(?!@\/)(?:@[^/]+\/|[^./]).*/ }, (args) => ({
          path: Bun.resolveSync(args.path, repositoryRoot),
        }))
      },
    }],
  })

  if (!buildResult.success) {
    throw new Error(buildResult.logs.map((log) => log.message).join('\n'))
  }
}

test('完整 Right Workspace Shell 中真实点击添加工具后菜单位于最上层', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'domi-toolbar-interaction-'))
  temporaryDirectories.push(directory)
  await buildInteractionHarness(directory)

  const subprocess = Bun.spawn([resolveElectronExecutable(), join(directory, 'main.cjs')], {
    cwd: directory,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ])
  const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith('TOOLBAR_RESULT:'))

  expect(exitCode, stderr || stdout).toBe(0)
  expect(resultLine, stderr || stdout).toBeDefined()
  const payload = JSON.parse(resultLine!.slice('TOOLBAR_RESULT:'.length)) as {
    error?: string
    result?: ToolbarInteractionResult
  }
  expect(payload.error).toBeUndefined()
  expect(payload.result).toEqual({
    initialExpanded: 'false',
    openedExpanded: 'true',
    browserVisible: true,
    scratchVisible: true,
    menuZIndex: 100,
    menuIsTopmost: true,
    escapedExpanded: 'false',
    selectedTool: 'browser',
    selectedExpanded: 'false',
  })
}, 20_000)

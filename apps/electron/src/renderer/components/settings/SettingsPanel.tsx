/**
 * SettingsPanel - 设置面板
 *
 * 在应用主工作区中展示左侧导航和右侧 ScrollArea 内容区域。
 * 使用 Jotai atom 管理当前标签页状态，保持已有设置项与分组顺序。
 */

import * as React from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useTranslation } from 'react-i18next'
import '@/i18n'
import { cn } from "@/lib/utils";
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from "@/lib/platform";
import {
  Settings,
  Radio,
  Palette,
  Info,
  Globe,
  BookOpen,
  Wrench,
  Bot,
  GraduationCap,
  ArrowLeft,
  Keyboard,
  Mic,
  HardDriveDownload,
  HardDrive,
  Eye,
  BarChart3,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ShortcutKeycaps } from "@/components/shortcuts/ShortcutKeycaps";
import {
  settingsTabAtom,
  channelFormDirtyAtom,
  settingsCloseRequestedAtom,
  settingsOpenAtom,
  settingsPendingSessionNavigationAtom,
  type SettingsSessionNavigation,
} from "@/atoms/settings-tab";
import type { SettingsTab } from "@/atoms/settings-tab";
import { appModeAtom } from "@/atoms/app-mode";
import { activeViewAtom } from "@/atoms/active-view";
import { automationFormAtom } from "@/atoms/automation-atoms";
import { tabsAtom, activeTabIdAtom, openTab, TUTORIAL_TAB_ID } from "@/atoms/tab-atoms";
import { hasEnvironmentIssuesAtom } from "@/atoms/environment";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChannelSettings } from "./ChannelSettings";
import { GeneralSettings } from "./GeneralSettings";
import { ProxySettings } from "./ProxySettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { AboutSettings } from "./AboutSettings";
import { PromptSettings } from "./PromptSettings";
import { ToolSettings } from "./ToolSettings";
import { BotHubSettings } from "./BotHubSettings";
import { ShortcutSettings } from "./ShortcutSettings";
import { VoiceInputSettings } from "./VoiceInputSettings";
import { MigrationSettings } from "./MigrationSettings";
import { StorageSettings } from "./StorageSettings";
import { UsageStatsSettings } from "./UsageStatsSettings";
import { VisionRelaySettings } from "./VisionRelaySettings";
import { useOpenSession } from '@/hooks/useOpenSession'

/** 设置 Tab 定义 */
interface TabItem {
  id: SettingsTab;
  labelKey: string;
  icon: React.ReactNode;
}

/** 基础 Tabs（所有模式都有） */
const BASE_TABS: TabItem[] = [
  { id: "general", labelKey: "generalSettings", icon: <Settings size={16} /> },
  { id: "channels", labelKey: "modelConfig", icon: <Radio size={16} /> },
  { id: "vision-relay", labelKey: "visionAssistant", icon: <Eye size={16} /> },
  { id: "prompts", labelKey: "promptManagement", icon: <BookOpen size={16} /> },
  { id: "proxy", labelKey: "proxySettings", icon: <Globe size={16} /> },
];

const TOOLS_TAB: TabItem = {
  id: "tools",
  labelKey: "aiTools",
  icon: <Wrench size={16} />,
};
const BOTS_TAB: TabItem = {
  id: "bots",
  labelKey: "remoteConnections",
  icon: <Bot size={16} />,
};
const TUTORIAL_TAB: TabItem = {
  id: "tutorial",
  labelKey: "tutorial",
  icon: <GraduationCap size={16} />,
};
const SHORTCUTS_TAB: TabItem = {
  id: "shortcuts",
  labelKey: "shortcutManagement",
  icon: <Keyboard size={16} />,
};
const VOICE_INPUT_TAB: TabItem = {
  id: "voice-input",
  labelKey: "voiceInput",
  icon: <Mic size={16} />,
};
/** 尾部 Tabs */
const TAIL_TABS: TabItem[] = [
  { id: "migration", labelKey: "dataMigration", icon: <HardDriveDownload size={16} /> },
  { id: "storage", labelKey: "storageManagement", icon: <HardDrive size={16} /> },
  { id: "usage", labelKey: "usageStatistics", icon: <BarChart3 size={16} /> },
  { id: "appearance", labelKey: "appearanceSettings", icon: <Palette size={16} /> },
  { id: "about", labelKey: "aboutAndUpdates", icon: <Info size={16} /> },
];

/** 根据标签页 id 渲染对应内容 */
function renderTabContent(tab: SettingsTab): React.ReactElement {
  switch (tab) {
    case "general":
      return <GeneralSettings />;
    case "channels":
      return <ChannelSettings />;
    case "vision-relay":
      return <VisionRelaySettings />;
    case "prompts":
      return <PromptSettings />;
    case "proxy":
      return <ProxySettings />;
    case "tools":
      return <ToolSettings />;
    case "appearance":
      return <AppearanceSettings />;
    case "about":
      return <AboutSettings />;
    case "bots":
      return <BotHubSettings />;
    case "shortcuts":
      return <ShortcutSettings />;
    case "voice-input":
      return <VoiceInputSettings />;
    case "migration":
      return <MigrationSettings />;
    case "storage":
      return <StorageSettings />;
    case "usage":
      return <UsageStatsSettings />;
    default:
      // tutorial 等特殊 tab 由 handleTabChange 拦截打开主区 Tab，不会在此渲染
      return <GeneralSettings />;
  }
}

interface SettingsPanelProps {
  onClose?: () => void;
}

export function SettingsPanel({
  onClose,
}: SettingsPanelProps): React.ReactElement {
  const { t } = useTranslation('common')
  const [activeTab, setActiveTab] = useAtom(settingsTabAtom);
  const channelFormDirty = useAtomValue(channelFormDirtyAtom);
  const [closeRequested, setCloseRequested] = useAtom(settingsCloseRequestedAtom);
  const [pendingSessionNavigation, setPendingSessionNavigation] = useAtom(settingsPendingSessionNavigationAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setActiveView = useSetAtom(activeViewAtom);
  const setAutomationForm = useSetAtom(automationFormAtom);
  const appMode = useAtomValue(appModeAtom);
  const hasEnvironmentIssues = useAtomValue(hasEnvironmentIssuesAtom);
  const [mainTabs, setMainTabs] = useAtom(tabsAtom);
  const setMainActiveTabId = useSetAtom(activeTabIdAtom);
  const openSession = useOpenSession()
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  /** 统一的退出拦截对话框状态 */
  type PendingAction =
    | { type: 'tab'; tabId: SettingsTab }
    | { type: 'close' }
    | { type: 'session'; navigation: SettingsSessionNavigation }
    | null
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null)
  const showNavDialog = pendingAction !== null

  /** 执行待处理的操作 */
  const executePendingAction = (): void => {
    if (!pendingAction) return
    if (pendingAction.type === 'tab') {
      setActiveTab(pendingAction.tabId)
    } else if (pendingAction.type === 'session') {
      openSession(
        pendingAction.navigation.type,
        pendingAction.navigation.sessionId,
        pendingAction.navigation.title,
        { bypassSettingsGuard: true },
      )
    } else {
      onClose?.()
    }
    setPendingAction(null)
  }

  /** 取消待处理的操作 */
  const cancelPendingAction = (): void => {
    setPendingAction(null)
  }

  /** 切换标签页时检测是否有未保存内容，tutorial 特殊处理：打开 New Tab 并关闭设置 */
  const handleTabChange = (tabId: SettingsTab): void => {
    if (tabId === 'tutorial') {
      const result = openTab(mainTabs, { type: 'tutorial', sessionId: TUTORIAL_TAB_ID, title: 'Domi 使用教程' })
      setMainTabs(result.tabs)
      setMainActiveTabId(result.activeTabId)
      // Skills/Automations 会全屏覆盖 TabContent；打开教程时先清理表单并回到会话视图。
      setAutomationForm({ open: false, draft: null })
      setActiveView('conversations')
      setSettingsOpen(false)
      return
    }
    if (tabId === activeTab) return
    if (activeTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'tab', tabId })
      return
    }
    setActiveTab(tabId)
  }

  /** 关闭设置面板时检测是否有未保存内容 */
  const handleClose = React.useCallback((): void => {
    if (activeTab === 'channels' && channelFormDirty) {
      setPendingAction({ type: 'close' })
      return
    }
    onClose?.()
  }, [activeTab, channelFormDirty, onClose])

  /** 按 ESC 退出设置面板：window 级监听确保焦点在设置面板内任何位置（含 body）都生效；
   *  Radix 弹层（Select 下拉/AlertDialog/Popover 等）处理 ESC 时会 preventDefault，
   *  此时交给弹层自行关闭，不退出设置。 */
  React.useEffect(() => {
    const handleWindowKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      handleClose()
    }
    window.addEventListener('keydown', handleWindowKeyDown)
    return () => window.removeEventListener('keydown', handleWindowKeyDown)
  }, [handleClose])

  // 左侧会话点击在渠道表单有未保存内容时，由 useOpenSession 暂存目标并交给此处确认。
  React.useEffect(() => {
    if (!pendingSessionNavigation) return
    setPendingAction({ type: 'session', navigation: pendingSessionNavigation })
    setPendingSessionNavigation(null)
  }, [pendingSessionNavigation, setPendingSessionNavigation])

  // Cmd+W 等外部关闭请求：弹出确认对话框
  React.useEffect(() => {
    if (closeRequested && activeTab === 'channels') {
      setPendingAction({ type: 'close' })
      setCloseRequested(false)
    }
  }, [closeRequested, activeTab, setCloseRequested])

  // 工具 tab 两种模式都显示，Agent Skills / MCP 独立在侧边栏能力中心管理。
  const tabs = React.useMemo(() => {
    if (appMode === "agent") {
      return [
        ...BASE_TABS,
        TOOLS_TAB,
        VOICE_INPUT_TAB,
        BOTS_TAB,
        TUTORIAL_TAB,
        SHORTCUTS_TAB,
        ...TAIL_TABS,
      ];
    }
    return [
      ...BASE_TABS,
      TOOLS_TAB,
      VOICE_INPUT_TAB,
      BOTS_TAB,
      TUTORIAL_TAB,
      SHORTCUTS_TAB,
      ...TAIL_TABS,
    ];
  }, [appMode]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-content-area text-foreground">
      {/* 背景保持全宽；Windows 的 drag hitmask 必须避开右上角 WindowControls。 */}
      <div className="relative h-[35px] flex-shrink-0 bg-[hsl(var(--sidebar-surface))]">
        <div
          aria-hidden="true"
          className={cn(
            'titlebar-drag-region pointer-events-none absolute left-0 top-0 h-full',
            isWindows ? WINDOW_CONTROLS_INSET_RIGHT : 'right-0',
          )}
        />
      </div>

      {/* 主体：左导航 + 右内容 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧 Tab 导航 */}
        <div className="flex h-full min-h-0 w-[277px] flex-shrink-0 flex-col border-r border-border/80 bg-[hsl(var(--sidebar-surface))] dark:border-border/70">
          <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 pt-5 scrollbar-thin">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2.5 text-sm transition-colors",
                  activeTab === tab.id
                    ? "bg-muted text-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {tab.icon}
                <span>{t(tab.labelKey, { defaultValue: tab.labelKey })}</span>
                {tab.id === "about" && hasEnvironmentIssues && (
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                )}
              </button>
            ))}
          </nav>
          <div className="flex-shrink-0 p-3">
            <button
              onClick={handleClose}
              className="group flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
            >
              <ArrowLeft size={16} />
              <span>{t('back')}</span>
              <span className="ml-auto hidden group-hover:inline-flex">
                <ShortcutKeycaps accelerator="Esc" />
              </span>
            </button>
          </div>
        </div>

        {/* 右侧内容区域 */}
        <ScrollArea className="min-w-0 flex-1 bg-content-area">
          <div className="mx-auto w-full max-w-[1080px] px-5 py-8 pb-12 sm:px-8">
            {renderTabContent(activeTab)}
          </div>
        </ScrollArea>
      </div>

      {/* 退出拦截弹窗（侧边栏导航 / X 关闭 / Cmd+W） */}
      <AlertDialog open={showNavDialog} onOpenChange={(open) => { if (!open) cancelPendingAction() }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('discardChangesTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('discardChangesDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelPendingAction}>{t('stayOnPage')}</AlertDialogCancel>
            <AlertDialogAction onClick={executePendingAction}>{t('discardAndLeave')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

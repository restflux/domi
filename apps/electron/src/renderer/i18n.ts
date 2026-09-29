import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

export const SUPPORTED_LOCALES = ['zh-CN', 'en-US'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const defaultNS = 'common'

function defineNamespace<T extends Record<string, string>>(translations: T): { [K in keyof T]: string } {
  return translations
}

const common = defineNamespace({
  settings: '设置',
  work: 'Work',
  chat: 'Chat',
  workDescription: '操作项目、文件和工具，持续执行任务',
  chatDescription: '轻量问答、讨论和内容生成',
  generalSettings: '通用设置',
  modelConfig: '模型配置',
  visionAssistant: '视觉助手',
  promptManagement: '提示词管理',
  proxySettings: '代理设置',
  aiTools: 'AI 工具',
  remoteConnections: '远程连接',
  tutorial: 'Domi 教程',
  shortcutManagement: '快捷键管理',
  voiceInput: '语音输入',
  dataMigration: '数据迁移',
  storageManagement: '磁盘管理',
  usageStatistics: '用量统计',
  appearanceSettings: '外观设置',
  aboutAndUpdates: '关于/更新',
  back: '返回',
  cancel: '取消',
  confirm: '确认',
  language: '语言',
  simplifiedChinese: '简体中文',
  english: 'English',
  discardChangesTitle: '放弃未保存的更改？',
  discardChangesDescription: '当前渠道配置尚未保存，确定要离开吗？',
  stayOnPage: '留在当前页',
  discardAndLeave: '放弃并离开',
})

const settings = defineNamespace({
  appearanceTitle: '外观设置',
  appearanceDescription: '自定义应用的视觉风格',
  themeMode: '主题模式',
  zoom: '界面缩放',
  themeModeDescription: '选择应用的配色方案',
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
  markdownFontSize: 'Markdown 字号',
  markdownFontSizeDescription: '调整 AI 回复与 Markdown 编辑器的正文字号',
  small: '小',
  medium: '中',
  large: '大',
  zoomHintMac: '使用 ⌘+ 放大、⌘- 缩小、⌘0 恢复默认大小',
  zoomHintWindows: '使用 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复默认大小',
  generalTitle: '通用设置',
  generalDescription: '应用的基本配置',
  languageDescription: '选择应用界面语言',
  profileTitle: '用户档案',
  profileDescription: '设置你的头像和显示名称',
  uploadAvatar: '上传自定义图片',
  profileHint: '点击头像更换，点击名字编辑',
  desktopNotifications: '桌面通知',
  desktopNotificationsDescription: 'Agent 完成任务或需要操作时发送通知',
  attentionNotifications: '需要关注时通知',
  attentionNotificationsDescription: 'Agent 等待回答、批准、验收，或发生失败与冲突时立即通知',
  completionNotifications: '工作完成时通知',
  completionNotificationsDescription: '普通成功完成会在短时间内合并通知，子 Agent 单独完成不会打扰',
  notificationSound: '通知提示音',
  notificationSoundDescription: '需要关注、工作完成和任务/日程提醒触发时播放提示音',
  taskCompletionSound: '任务完成音效',
  permissionSound: '权限审批音效',
  planApprovalSound: '计划审批音效',
  reminderSound: '任务/日程提醒音效',
  autoArchive: '自动归档',
  autoArchiveDescription: '超过指定天数未更新的对话将自动归档（置顶对话除外）',
  disabled: '禁用',
  days: '{{count}} 天',
  previousQuestion: '返回上一条提问按钮',
  previousQuestionDescription: '向下浏览对话时显示返回上一条提问的按钮',
  longTextAttachment: '长文本粘贴转附件',
  longTextAttachmentDescription: '开启后，输入框粘贴超过 2000 字的文本会自动生成可预览编辑的附件',
  markdownInput: '输入框 Markdown 渲染',
  markdownInputDescription: '开启后，输入框中的 Markdown 语法（如 **粗体**、# 标题）会实时渲染为富文本；关闭后为纯文本模式，保留 @ 引用等功能',
  agentIsland: 'Agent 灵动岛',
  agentIslandDescription: '在 Mac 刘海屏显示需要接手的 Agent 与 1 小时内的待办/日程；外接无刘海屏默认不覆盖菜单栏',
  none: '无',
  preview: '试听',
})

const welcome = defineNamespace({
  greeting: '{{displayName}}，{{greeting}}',
  user: '用户',
  lateNight: '夜深了',
  morning: '早上好',
  afternoon: '下午好',
  evening: '晚上好',
  workTitle: '开始使用 Work',
  workDescription: '让 Domi 帮你完成编码、分析和自动化任务。',
})

type LocaleResources = {
  common: typeof common
  settings: typeof settings
  welcome: typeof welcome
}

export const resources = {
  'zh-CN': { common, settings, welcome },
  'en-US': {
    common: {
      settings: 'Settings',
      work: 'Work',
      chat: 'Chat',
      workDescription: 'Work with projects, files, and tools to complete tasks',
      chatDescription: 'Lightweight questions, discussions, and content generation',
      generalSettings: 'General',
      modelConfig: 'Models',
      visionAssistant: 'Vision Assistant',
      promptManagement: 'Prompts',
      proxySettings: 'Proxy',
      aiTools: 'AI Tools',
      remoteConnections: 'Remote Connections',
      tutorial: 'Domi Tutorial',
      shortcutManagement: 'Shortcuts',
      voiceInput: 'Voice Input',
      dataMigration: 'Data Migration',
      storageManagement: 'Storage',
      usageStatistics: 'Usage',
      appearanceSettings: 'Appearance',
      aboutAndUpdates: 'About / Updates',
      back: 'Back',
      cancel: 'Cancel',
      confirm: 'Confirm',
      language: 'Language',
      simplifiedChinese: '简体中文',
      english: 'English',
      discardChangesTitle: 'Discard unsaved changes?',
      discardChangesDescription: 'The current model configuration has not been saved. Leave this page?',
      stayOnPage: 'Stay on page',
      discardAndLeave: 'Discard and leave',
    },
    settings: {
      appearanceTitle: 'Appearance',
      appearanceDescription: 'Customize the visual style of the app',
      themeMode: 'Theme',
      zoom: 'Interface zoom',
      themeModeDescription: 'Choose the app color scheme',
      light: 'Light',
      dark: 'Dark',
      system: 'System',
      markdownFontSize: 'Markdown font size',
      markdownFontSizeDescription: 'Adjust the body size of AI replies and the Markdown editor',
      small: 'Small',
      medium: 'Medium',
      large: 'Large',
      zoomHintMac: 'Use ⌘+ to zoom in, ⌘- to zoom out, and ⌘0 to reset',
      zoomHintWindows: 'Use Ctrl++ to zoom in, Ctrl+- to zoom out, and Ctrl+0 to reset',
      generalTitle: 'General',
      generalDescription: 'Basic app configuration',
      languageDescription: 'Choose the app interface language',
      profileTitle: 'User profile',
      profileDescription: 'Set your avatar and display name',
      uploadAvatar: 'Upload custom image',
      profileHint: 'Click the avatar to change it, or click the name to edit',
      desktopNotifications: 'Desktop notifications',
      desktopNotificationsDescription: 'Notify you when an Agent completes a task or needs attention',
      attentionNotifications: 'Needs-attention notifications',
      attentionNotificationsDescription: 'Notify you when an Agent is waiting for an answer, approval, review, or encounters a failure or conflict',
      completionNotifications: 'Work-completed notifications',
      completionNotificationsDescription: 'Merge ordinary successful completions briefly; child Agent completions stay quiet',
      notificationSound: 'Notification sounds',
      notificationSoundDescription: 'Play a sound for attention, completion, and task/calendar reminders',
      taskCompletionSound: 'Task completion sound',
      permissionSound: 'Permission approval sound',
      planApprovalSound: 'Plan approval sound',
      reminderSound: 'Task/calendar reminder sound',
      autoArchive: 'Automatic archiving',
      autoArchiveDescription: 'Automatically archive conversations that have not been updated for the selected number of days (pinned conversations are excluded)',
      disabled: 'Disabled',
      days: '{{count}} days',
      previousQuestion: 'Previous-question button',
      previousQuestionDescription: 'Show a button to return to the previous question while browsing down a conversation',
      longTextAttachment: 'Paste long text as an attachment',
      longTextAttachmentDescription: 'When enabled, pasted text over 2,000 characters is automatically turned into a previewable, editable attachment',
      markdownInput: 'Markdown rendering in input',
      markdownInputDescription: 'When enabled, Markdown such as **bold** and # headings is rendered as rich text in the input; when disabled, plain-text mode keeps @ mentions and other features',
      agentIsland: 'Agent Island',
      agentIslandDescription: 'Show Agents needing attention and tasks/calendar items due within an hour in the Mac notch; on external displays without a notch, the menu bar is not covered by default',
      none: 'None',
      preview: 'Preview',
    },
    welcome: {
      greeting: '{{displayName}}, {{greeting}}',
      user: 'User',      lateNight: 'Good night',
      morning: 'Good morning',
      afternoon: 'Good afternoon',
      evening: 'Good evening',
      workTitle: 'Start with Work',
      workDescription: 'Let Domi help with coding, analysis, and automation tasks.',
    },
  } satisfies LocaleResources,
} satisfies Record<Locale, LocaleResources>

void i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    supportedLngs: SUPPORTED_LOCALES,
    defaultNS,
    ns: ['common', 'settings', 'welcome'],
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })

export default i18n

export function normalizeLocale(value: unknown): Locale {
  return value === 'en-US' ? 'en-US' : 'zh-CN'
}

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS
    resources: typeof resources['zh-CN']
  }
}

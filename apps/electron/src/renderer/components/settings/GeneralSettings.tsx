/**
 * GeneralSettings - 通用设置页
 *
 * 顶部：用户档案编辑（头像 + 用户名）
 * 下方：语言等通用设置
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Camera, ImagePlus, Volume2 } from 'lucide-react'
import Picker from '@emoji-mart/react'
import data from '@emoji-mart/data'
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
} from './primitives'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { UserAvatar } from '../chat/UserAvatar'
import { userProfileAtom } from '@/atoms/user-profile'
import {
  notificationsEnabledAtom,
  notificationSoundEnabledAtom,
  notificationSoundsAtom,
  workActivityAttentionNotificationsEnabledAtom,
  workActivityCompletionNotificationsEnabledAtom,
  updateNotificationsEnabled,
  updateNotificationSoundEnabled,
  updateWorkActivityAttentionNotificationsEnabled,
  updateWorkActivityCompletionNotificationsEnabled,
  updateNotificationSound,
  playNotificationSound,
  NOTIFICATION_SOUNDS,
  DEFAULT_NOTIFICATION_SOUNDS,
} from '@/atoms/notifications'
import {
  longTextPasteAsAttachmentEnabledAtom,
  richTextRenderingEnabledAtom,
  stickyUserMessageEnabledAtom,
  updateLongTextPasteAsAttachmentEnabled,
  updateRichTextRenderingEnabled,
  updateStickyUserMessageEnabled,
} from '@/atoms/ui-preferences'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import type { AppLanguage, NotificationSoundId, NotificationSoundType, NotificationSoundSettings } from '@/types/settings'
import { localeAtom } from '@/atoms/locale'
import i18n, { normalizeLocale } from '@/i18n'
import { ContextCompactorSettings } from './ContextCompactorSettings'
import { RtkSettings } from './RtkSettings'

/** emoji-mart 选择回调的 emoji 对象类型 */
interface EmojiMartEmoji {
  id: string
  name: string
  native: string
  unified: string
  keywords: string[]
  shortcodes: string
}

export function GeneralSettings(): React.ReactElement {
  const { t } = useTranslation(['common', 'settings'])
  const [locale, setLocale] = useAtom(localeAtom)
  const [userProfile, setUserProfile] = useAtom(userProfileAtom)
  const [notificationsEnabled, setNotificationsEnabled] = useAtom(notificationsEnabledAtom)
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useAtom(notificationSoundEnabledAtom)
  const [notificationSounds, setNotificationSounds] = useAtom(notificationSoundsAtom)
  const [attentionNotificationsEnabled, setAttentionNotificationsEnabled] = useAtom(workActivityAttentionNotificationsEnabledAtom)
  const [completionNotificationsEnabled, setCompletionNotificationsEnabled] = useAtom(workActivityCompletionNotificationsEnabledAtom)
  const [stickyUserMessageEnabled, setStickyUserMessageEnabled] = useAtom(stickyUserMessageEnabledAtom)

  const handleLanguageChange = React.useCallback((value: string): void => {
    const nextLocale = normalizeLocale(value) as AppLanguage
    setLocale(nextLocale)
    void i18n.changeLanguage(nextLocale)
    void window.electronAPI.updateSettings({ language: nextLocale })
  }, [setLocale])
  const [longTextPasteAsAttachmentEnabled, setLongTextPasteAsAttachmentEnabled] = useAtom(longTextPasteAsAttachmentEnabledAtom)
  const [richTextRenderingEnabled, setRichTextRenderingEnabled] = useAtom(richTextRenderingEnabledAtom)
  const [isEditingName, setIsEditingName] = React.useState(false)
  const [nameInput, setNameInput] = React.useState(userProfile.userName)
  const [showEmojiPicker, setShowEmojiPicker] = React.useState(false)
  const [archiveAfterDays, setArchiveAfterDays] = React.useState<number>(7)
  const [agentIslandEnabled, setAgentIslandEnabled] = React.useState(true)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // 加载归档天数与 Agent 灵动岛设置
  React.useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setArchiveAfterDays(settings.archiveAfterDays ?? 7)
      setAgentIslandEnabled(settings.agentIsland?.enabled ?? true)
    }).catch(console.error)
  }, [])

  /** 更新灵动岛开关 */
  const handleAgentIslandChange = async (checked: boolean): Promise<void> => {
    setAgentIslandEnabled(checked)
    try {
      await window.electronAPI.updateSettings({ agentIsland: { enabled: checked } })
    } catch (error) {
      console.error('[通用设置] 更新 Agent 灵动岛失败:', error)
      setAgentIslandEnabled(!checked)
    }
  }

  /** 更新归档天数 */
  const handleArchiveDaysChange = async (value: string): Promise<void> => {
    const days = parseInt(value, 10)
    setArchiveAfterDays(days)
    try {
      await window.electronAPI.updateSettings({ archiveAfterDays: days })
    } catch (error) {
      console.error('[通用设置] 更新归档天数失败:', error)
    }
  }

  /** 更新头像 */
  const handleAvatarChange = async (avatar: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateUserProfile({ avatar })
      setUserProfile(updated)
      setShowEmojiPicker(false)
    } catch (error) {
      console.error('[通用设置] 更新头像失败:', error)
    }
  }

  /** 上传图片作为头像 */
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      await handleAvatarChange(dataUrl)
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  /** 保存用户名 */
  const handleSaveName = async (): Promise<void> => {
    const trimmed = nameInput.trim()
    if (!trimmed) return

    try {
      const updated = await window.electronAPI.updateUserProfile({ userName: trimmed })
      setUserProfile(updated)
      setIsEditingName(false)
    } catch (error) {
      console.error('[通用设置] 更新用户名失败:', error)
    }
  }

  /** 用户名编辑键盘事件 */
  const handleNameKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      handleSaveName()
    } else if (e.key === 'Escape') {
      setNameInput(userProfile.userName)
      setIsEditingName(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 用户档案区域 */}
      <SettingsSection
        title={t('settings:profileTitle')}
        description={t('settings:profileDescription')}
      >
        <SettingsCard>
          <div className="flex items-center gap-5 px-4 py-4">
            {/* 头像 + Popover emoji 选择器 */}
            <Popover open={showEmojiPicker} onOpenChange={setShowEmojiPicker}>
              <PopoverTrigger asChild>
                <div className="relative group/avatar cursor-pointer">
                  <UserAvatar avatar={userProfile.avatar} size={64} />
                  {/* 编辑覆盖层 */}
                  <div
                    className={cn(
                      'absolute inset-0 rounded-[20%] flex items-center justify-center',
                      'bg-black/40 opacity-0 group-hover/avatar:opacity-100 transition-opacity'
                    )}
                  >
                    <Camera className="size-5 text-white" />
                  </div>
                </div>
              </PopoverTrigger>
              <PopoverContent
                side="right"
                align="start"
                sideOffset={12}
                className="w-auto p-0 border-none shadow-xl"
              >
                <Picker
                  data={data}
                  onEmojiSelect={(emoji: EmojiMartEmoji) => handleAvatarChange(emoji.native)}
                  locale="zh"
                  theme="auto"
                  previewPosition="none"
                  skinTonePosition="search"
                  perLine={8}
                />
                {/* 上传自定义图片 */}
                <div className="px-3 p-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className={cn(
                      'w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[13px]',
                      'text-foreground/60 hover:text-foreground hover:bg-foreground/[0.06] transition-colors'
                    )}
                  >
                    <ImagePlus className="size-4" />
                    {t('settings:uploadAvatar')}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="hidden"
                    onChange={handleImageUpload}
                  />
                </div>
              </PopoverContent>
            </Popover>

            {/* 用户名 */}
            <div className="flex-1 min-w-0">
              {isEditingName ? (
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onBlur={handleSaveName}
                  onKeyDown={handleNameKeyDown}
                  maxLength={30}
                  autoFocus
                  className={cn(
                    'text-lg font-semibold text-foreground bg-transparent border-b-2 border-primary',
                    'outline-none w-full max-w-[200px] pb-0.5'
                  )}
                />
              ) : (
                <button
                  onClick={() => {
                    setNameInput(userProfile.userName)
                    setIsEditingName(true)
                  }}
                  className="text-lg font-semibold text-foreground hover:text-primary transition-colors text-left"
                >
                  {userProfile.userName}
                </button>
              )}
              <p className="text-[12px] text-foreground/40 mt-0.5">
                {t('settings:profileHint')}
              </p>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* 通用设置 */}
      <SettingsSection
        title={t('settings:generalTitle')}
        description={t('settings:generalDescription')}
      >
        <SettingsCard>
          <SettingsRow
            label={t('common:language')}
            description={t('settings:languageDescription')}
          >
            <Select value={locale} onValueChange={handleLanguageChange}>
              <SelectTrigger className="h-8 w-[130px] text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh-CN">{t('common:simplifiedChinese')}</SelectItem>
                <SelectItem value="en-US">{t('common:english')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsToggle
            label={t('settings:desktopNotifications')}
            description={t('settings:desktopNotificationsDescription')}
            checked={notificationsEnabled}
            onCheckedChange={(checked) => {
              setNotificationsEnabled(checked)
              updateNotificationsEnabled(checked)
            }}
          />
          <SettingsToggle
            label={t('settings:attentionNotifications')}
            description={t('settings:attentionNotificationsDescription')}
            checked={attentionNotificationsEnabled}
            disabled={!notificationsEnabled}
            onCheckedChange={(checked) => {
              setAttentionNotificationsEnabled(checked)
              void updateWorkActivityAttentionNotificationsEnabled(checked)
            }}
          />
          <SettingsToggle
            label={t('settings:completionNotifications')}
            description={t('settings:completionNotificationsDescription')}
            checked={completionNotificationsEnabled}
            disabled={!notificationsEnabled}
            onCheckedChange={(checked) => {
              setCompletionNotificationsEnabled(checked)
              void updateWorkActivityCompletionNotificationsEnabled(checked)
            }}
          />
          <SettingsToggle
            label={t('settings:notificationSound')}
            description={t('settings:notificationSoundDescription')}
            checked={notificationSoundEnabled}
            disabled={!notificationsEnabled}
            onCheckedChange={(checked) => {
              setNotificationSoundEnabled(checked)
              updateNotificationSoundEnabled(checked)
            }}
          />
          <SoundPicker
            label={t('settings:taskCompletionSound')}
            type="taskComplete"
            sounds={notificationSounds}
            disabled={!notificationsEnabled || !notificationSoundEnabled}
            onSoundChange={async (type, soundId) => {
              const newSounds = await updateNotificationSound(type, soundId, notificationSounds)
              setNotificationSounds(newSounds)
            }}
          />
          <SoundPicker
            label={t('settings:permissionSound')}
            type="permissionRequest"
            sounds={notificationSounds}
            disabled={!notificationsEnabled || !notificationSoundEnabled}
            onSoundChange={async (type, soundId) => {
              const newSounds = await updateNotificationSound(type, soundId, notificationSounds)
              setNotificationSounds(newSounds)
            }}
          />
          <SoundPicker
            label={t('settings:planApprovalSound')}
            type="exitPlanMode"
            sounds={notificationSounds}
            disabled={!notificationsEnabled || !notificationSoundEnabled}
            onSoundChange={async (type, soundId) => {
              const newSounds = await updateNotificationSound(type, soundId, notificationSounds)
              setNotificationSounds(newSounds)
            }}
          />
          <SoundPicker
            label={t('settings:reminderSound')}
            type="planningReminder"
            sounds={notificationSounds}
            disabled={!notificationsEnabled || !notificationSoundEnabled}
            onSoundChange={async (type, soundId) => {
              const newSounds = await updateNotificationSound(type, soundId, notificationSounds)
              setNotificationSounds(newSounds)
            }}
          />
          <SettingsRow
            label={t('settings:autoArchive')}
            description={t('settings:autoArchiveDescription')}
          >
            <Select value={String(archiveAfterDays)} onValueChange={handleArchiveDaysChange}>
              <SelectTrigger className="w-[120px] h-8 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">{t('settings:disabled')}</SelectItem>
                <SelectItem value="7">{t('settings:days', { count: 7 })}</SelectItem>
                <SelectItem value="14">{t('settings:days', { count: 14 })}</SelectItem>
                <SelectItem value="30">{t('settings:days', { count: 30 })}</SelectItem>
                <SelectItem value="60">{t('settings:days', { count: 60 })}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsToggle
            label={t('settings:previousQuestion')}
            description={t('settings:previousQuestionDescription')}
            checked={stickyUserMessageEnabled}
            onCheckedChange={(checked) => {
              setStickyUserMessageEnabled(checked)
              updateStickyUserMessageEnabled(checked)
            }}
          />
          <SettingsToggle
            label={t('settings:longTextAttachment')}
            description={t('settings:longTextAttachmentDescription')}
            checked={longTextPasteAsAttachmentEnabled}
            onCheckedChange={(checked) => {
              setLongTextPasteAsAttachmentEnabled(checked)
              updateLongTextPasteAsAttachmentEnabled(checked)
            }}
          />
          <SettingsToggle
            label={t('settings:markdownInput')}
            description={t('settings:markdownInputDescription')}
            checked={richTextRenderingEnabled}
            onCheckedChange={(checked) => {
              setRichTextRenderingEnabled(checked)
              updateRichTextRenderingEnabled(checked)
            }}
          />
          <SettingsToggle
            label={t('settings:agentIsland')}
            description={t('settings:agentIslandDescription')}
            checked={agentIslandEnabled}
            onCheckedChange={(checked) => {
              void handleAgentIslandChange(checked)
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <ContextCompactorSettings />
      <RtkSettings />
    </div>
  )
}

// ===== SoundPicker 内部组件 =====

interface SoundPickerProps {
  label: string
  type: NotificationSoundType
  sounds: NotificationSoundSettings
  disabled: boolean
  onSoundChange: (type: NotificationSoundType, soundId: NotificationSoundId) => void
}

/** 单个场景的通知音选择器（下拉 + 试听按钮） */
function SoundPicker({ label, type, sounds, disabled, onSoundChange }: SoundPickerProps): React.ReactElement {
  const { t } = useTranslation('settings')
  const currentId = sounds[type] ?? DEFAULT_NOTIFICATION_SOUNDS[type]

  return (
    <SettingsRow label={label}>
      <div className="flex items-center gap-1.5">
        <Select
          value={currentId}
          onValueChange={(value) => onSoundChange(type, value as NotificationSoundId)}
          disabled={disabled}
        >
          <SelectTrigger className="w-[130px] h-8 text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NOTIFICATION_SOUNDS.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
            ))}
            <SelectItem value="none">{t('none')}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={disabled || currentId === 'none'}
          onClick={() => { void playNotificationSound(currentId) }}
          title={t('preview')}
        >
          <Volume2 size={14} />
        </Button>
      </div>
    </SettingsRow>
  )
}

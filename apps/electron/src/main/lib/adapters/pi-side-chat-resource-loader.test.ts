import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@earendil-works/pi-coding-agent'
import { createSideChatResourceLoader } from './pi-side-chat-resource-loader'

test('侧聊资源加载不求值外部扩展且不继承项目指令、Skills或追加提示词', async () => {
  const root = await mkdtemp(join(tmpdir(), 'domi-review-resources-'))
  try {
    const cwd = join(root, 'project')
    const agentDir = join(root, 'agent')
    for (const dir of [cwd, agentDir]) {
      await mkdir(join(dir, '.pi', 'extensions'), { recursive: true })
      await mkdir(join(dir, 'extensions'), { recursive: true })
      await mkdir(join(dir, 'skills', 'bad'), { recursive: true })
      await writeFile(join(dir, 'AGENTS.md'), 'PRIVATE_PARENT_REASONING')
      await writeFile(join(dir, 'SYSTEM.md'), 'PRIVATE_SYSTEM')
      await writeFile(join(dir, 'APPEND_SYSTEM.md'), 'PRIVATE_APPEND')
      await writeFile(join(dir, 'skills', 'bad', 'SKILL.md'), '---\nname: bad\ndescription: private\n---\nPRIVATE_SKILL')
      for (const target of [join(dir, 'extensions', 'bad.ts'), join(dir, '.pi', 'extensions', 'bad.ts')]) {
        await writeFile(target, 'throw new Error("EXTERNAL_EXTENSION_EVALUATED"); export default () => {}')
      }
    }
    const loader = createSideChatResourceLoader(sdk, { cwd, agentDir, settingsManager: sdk.SettingsManager.inMemory(), systemPrompt: '只读侧聊' })
    await loader.reload()
    expect(loader.getExtensions().extensions).toEqual([])
    expect(loader.getExtensions().errors).toEqual([])
    expect(loader.getSkills().skills).toEqual([])
    expect(loader.getAgentsFiles().agentsFiles).toEqual([])
    expect(loader.getSystemPrompt()).toBe('只读侧聊')
    expect(loader.getAppendSystemPrompt()).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

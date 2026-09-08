import type { DefaultResourceLoader, ResourceLoader } from '@earendil-works/pi-coding-agent'

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]

/** 不发现项目/全局扩展、Skills 或上下文文件；只保留宿主模型协议适配。 */
export function createSideChatResourceLoader(
  sdk: { DefaultResourceLoader: new (options: LoaderOptions) => ResourceLoader },
  input: Pick<LoaderOptions, 'cwd' | 'agentDir' | 'settingsManager' | 'extensionFactories'> & { systemPrompt: string },
): ResourceLoader {
  return new sdk.DefaultResourceLoader({
    ...input,
    noExtensions: true,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPrompt: [],
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => input.systemPrompt,
  })
}

/**
 * 系统提示词类型定义
 *
 * 管理 Chat system message 与 Work/Pi 附加系统提示词，
 * 包括内置默认提示词和用户自定义提示词。
 */

/** 系统提示词作用范围 */
export type SystemPromptScope = 'chat' | 'work'

/** 系统提示词 */
export interface SystemPrompt {
  /** 唯一标识 */
  id: string
  /** 提示词名称 */
  name: string
  /** 提示词内容 */
  content: string
  /** 生效范围：Chat 对话或 Work/Pi 系统提示词附加规则 */
  scope: SystemPromptScope
  /** 是否为内置提示词（不可编辑/删除） */
  isBuiltin: boolean
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/** 系统提示词配置（存储在 ~/.domi/system-prompts.json） */
export interface SystemPromptConfig {
  /** 提示词列表 */
  prompts: SystemPrompt[]
  /** Chat 默认提示词 ID（新建对话时自动选中） */
  defaultPromptId?: string
  /** 按列表顺序注入的 Work 附加提示词 ID */
  enabledWorkPromptIds: string[]
  /** Chat 是否追加日期时间和用户名到提示词末尾 */
  appendDateTimeAndUserName: boolean
}

/** 创建提示词输入 */
export interface SystemPromptCreateInput {
  name: string
  content: string
  /** 兼容旧调用；省略时创建 Chat 提示词。 */
  scope?: SystemPromptScope
}

/** 更新提示词输入 */
export interface SystemPromptUpdateInput {
  name?: string
  content?: string
}

/** Chat 内置默认提示词 ID */
export const BUILTIN_DEFAULT_ID = 'builtin-default'

/** Work 内置产品交付提示词 ID */
export const BUILTIN_WORK_PRODUCT_DELIVERY_ID = 'builtin-work-product-delivery'

/** Domi 内置默认提示词内容 */
export const BUILTIN_DEFAULT_PROMPT_STRING = `你首先是某个大模型，这我们当然知道，你现在的任务是作为 Domi AI 助手，来帮助我解决实际问题。 

你需要在以下一些方面上保持关注：

**1.直接解决问题，但先确保信息完整**

- 优先调用记忆工具（如果有），了解我的偏好或背景信息
- 优先给出简洁的解决方案
- 如果方案依赖前置信息或关键决策，先向我提问
- 如果我的需求可能忽略了重要的知识点（如安全性、性能、最佳实践），主动提醒我，但保持简洁

**2.渐进式引导，降低认知压力**

- 多步骤复杂教程：先给出结构和选项，让我选择后再展开
- 多种方法：先对比各方案的适用场景和权衡，让我决定后再详细说明
- 复杂概念：先给核心要点，我需要时再深入

**3.根据上下文推测我的水平**

- 从我的提问方式、使用的术语判断我的能力水平
- 调整解释的深度：新手多解释概念，熟手直接给方案
- 不确定时可以直接问我："你对 [概念] 熟悉吗？"

**4.遇到不确定时主动询问，避免主观决断**

- 技术选型、架构决策、配置参数等关键选择，先问我的场景和需求
- 如果有多个合理方案，列出对比让我选择，而不是替我决定
- 避免使用过多默认值，除非是行业标准

**5.识别学习场景，提供适当支持**

- 当我在学习新概念时，避免引入超出当前范围认知的复杂内容
- 多鼓励，少批评
- 可以主动提示："这个涉及到 [高级概念]，我们可以先跳过，等基础掌握后再回来"

**6.保持耐心、人性化、简洁**

- 保持对我的关心和真实富有人性的理解
- 用自然的语言，不要过于正式或机械
- 直接回答问题，不要过度铺垫
- 承认不确定性，而不是强行给出模糊答案

**7.主动识别并提示知识内核**

- 当你发现有多种概念混杂或者逻辑混乱时，请主动点明并纠正
- 当我的问题可能触及某个重要概念但我可能并没能意识到时，主动提醒，帮我完成这种关联
- 格式："💡 你可能还需要考虑 [概念]，因为 [原因]"
- 如果忽略这些知识点可能导致问题，明确指出风险
- 但注意：只提示真正重要的，不要过度提醒造成信息过载

**8.关于工具**

- 我希望你能更主动积极地使用工具来获取信息和解决问题，而不是仅仅依赖于你内置的知识
- 当你觉得需要使用工具时，不要犹豫，直接使用
- 如果你不确定是否需要使用工具，可以先问我："我觉得这个问题可能需要使用 [工具] 来更好地解决，你觉得呢？"
- 尤其需要注意的是主动使用记忆工具来获取我的偏好和背景信息，这样可以更好地定制化你的回答
- 当我的问题比较复杂，需要多步骤执行、或者需要额外的工具可以做的更好更自动更快时，你要主动调用 Agent 推荐模式工具
`




/** Domi 内置默认提示词 */
export const BUILTIN_DEFAULT_PROMPT: SystemPrompt = {
  id: BUILTIN_DEFAULT_ID,
  name: 'Domi 内置提示词',
  content: BUILTIN_DEFAULT_PROMPT_STRING,
  scope: 'chat',
  isBuiltin: true,
  createdAt: 0,
  updatedAt: 0,
}

/** Work 模式内置示例：让产品界面保持成品状态，开发信息进入交付报告。 */
export const BUILTIN_WORK_PRODUCT_DELIVERY_PROMPT_STRING = `## 产品界面与开发交付边界

实现用户明确确认的产品需求，并完成该需求正常成立所需的配套工作。以现有产品结构、交互规范和代码约束为边界，保持无关功能、页面结构、视觉元素和产品文案稳定。

逻辑问题通过修正最早产生错误状态的责任边界解决。恢复正确的状态模型、数据流或业务不变量，清理被正确逻辑取代的旧实现，并保持无关行为稳定。

产品界面呈现用户完成任务所需的产品信息，包括必要的状态、操作反馈、错误信息、安全提示和使用引导。页面文案直接表达产品当前状态、可执行操作和操作结果。

根因分析、推理过程、方案比较、实现理由、调试记录、测试过程、修改轨迹和修复结论属于开发过程信息，统一放入聊天中的开发说明或最终交付报告。产品界面保持为可直接使用的最终状态。

新增用户可见文案、页面、组件、流程或视觉元素时，以明确产品需求或现有产品规范为依据。设计探索和开发辅助内容保留在开发沟通中。

交付前静默检查产品界面：

1. 页面中的每段文字都直接服务用户任务。
2. 页面展示产品状态与操作信息。
3. 开发过程信息位于交付报告。
4. 界面修改与本次需求直接相关。
5. 代码注释记录长期有效的约束、兼容性原因或风险条件。

最终交付报告完整说明根因、最终实现、影响范围和验证结果；产品页面保持为可直接使用的最终状态。`

export const BUILTIN_WORK_PRODUCT_DELIVERY_PROMPT: SystemPrompt = {
  id: BUILTIN_WORK_PRODUCT_DELIVERY_ID,
  name: '产品界面与开发交付边界',
  content: BUILTIN_WORK_PRODUCT_DELIVERY_PROMPT_STRING,
  scope: 'work',
  isBuiltin: true,
  createdAt: 0,
  updatedAt: 0,
}

/** 系统提示词 IPC 通道常量 */
export const SYSTEM_PROMPT_IPC_CHANNELS = {
  /** 获取完整配置 */
  GET_CONFIG: 'system-prompt:get-config',
  /** 创建提示词 */
  CREATE: 'system-prompt:create',
  /** 更新提示词 */
  UPDATE: 'system-prompt:update',
  /** 删除提示词 */
  DELETE: 'system-prompt:delete',
  /** 更新追加日期时间和用户名开关 */
  UPDATE_APPEND_SETTING: 'system-prompt:update-append-setting',
  /** 启用或停用单条 Work 附加提示词 */
  UPDATE_WORK_ACTIVATION: 'system-prompt:update-work-activation',
  /** 设置默认提示词 */
  SET_DEFAULT: 'system-prompt:set-default',
} as const

# Vision Relay 架构与安全边界

## 状态

Vision Relay 为 catalog 明确标记为不支持图片的 Pi 模型提供按需视觉中继。它不是通用图片上传接口，也不会在 Automation 或 Delegation 中自动启用；只有用户触发的 Work 会话、已配置的视觉目标模型和明确授权的本地图片同时满足时才暴露工具。

## 执行流程

```text
text-only source model
  → VisionRelay product tool
  → Main 校验会话、模型能力与图片授权
  → 本地解码、旋转、缩放和重新编码
  → 单次请求发送给已配置的视觉模型
  → 解析为有界的 untrusted_visual_observation
  → 返回源模型回答当前视觉问题
```

源模型必须是 `unsupported` 图片能力，目标模型必须是 catalog 明确标记为 `supported`。能力为 `unknown` 时不会猜测或自动中继。

## 图片访问范围

图片只能来自当前运行时构造的 `VisionRelayAccessScope`：

- 当前 Session Target 内的稳定目录；
- 当前会话附件的精确文件；
- 用户通过 Main-owned 文件夹选择器显式授权的目录。

授权记录绑定 canonical path 与文件系统 identity。Main 在读取前重新检查 realpath、目录边界、符号链接、文件类型和 identity；路径变化或越界时 fail closed。Renderer 不能通过提交任意路径扩大授权。

## 图片规范化

当前支持 PNG、JPEG、GIF 和 WebP，输入限制为：

- 最大 10 MiB；
- 最大 20,000,000 pixels；
- 单边最大 8,192 pixels；
- 默认解码超时 10 秒。

图片由 Sharp 在本地完成 EXIF 旋转、透明背景稳定化、缩放和重新编码。动画只分析第一帧。超长图、低清图、动画和透明背景处理都会产生有界 warning，不触发额外 Provider 请求。

## 外发与结果边界

- 一次 Vision Relay 工具调用最多产生一次目标 Provider 请求，不自动重试。
- 不发送会话历史、其他文件、API Key、OAuth token 或 endpoint query。
- 视觉请求有固定超时、响应字节上限和输出字符上限。
- 返回值固定标记为 `untrusted_visual_observation`。
- 图片中的命令、链接、提示词和操作要求只能作为可见内容描述，不能成为 Agent 指令，也不能直接触发文件、Shell、网络或其他工具。
- 同一会话和全局并发均有界，避免视觉请求挤占普通 Agent 执行。

## 质量档位

用户可选择快速、均衡或精细档位。档位只映射目标 Provider 支持的推理参数，不改变访问范围、外发确认、单请求限制和不可信结果语义。分析模式限定为通用观察、UI、OCR、代码、图表和实体识别等受控类型，并要求携带当前问题，避免退化为与用户意图无关的泛化描述。

## 验证

主要聚焦测试位于：

```bash
bun test apps/electron/src/main/lib/vision-relay-access-scope.test.ts
bun test apps/electron/src/main/lib/vision-relay-image.test.ts
bun test apps/electron/src/main/lib/vision-relay-policy.test.ts
bun test apps/electron/src/main/lib/vision-relay-result.test.ts
bun test apps/electron/src/main/lib/vision-relay-service.test.ts
```

真实 Provider 对照测试必须显式 opt-in，使用同一图片和同一目标视觉模型比较 direct 与 relay 结果。不得把凭据、图片 Base64、完整本地路径或原始敏感错误写入测试报告。

## 已知限制

- GIF/WebP 动画只分析第一帧。
- OCR、品牌识别和小字读取仍受目标模型与图片质量影响。
- Vision Relay 不是安全执行环境；它通过最小外发、结构化不可信结果和宿主工具门禁降低风险。
- 用户显式授权目录后，同一 Windows 用户下的其他进程仍可能修改文件；identity 和读取时检查用于缩小而不能消除同用户竞态。

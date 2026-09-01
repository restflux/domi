# Security Policy

## Supported version

Domi 目前处于快速迭代阶段。安全修复以默认开发分支的最新代码为准；旧提交、个人构建和未维护的二进制版本不承诺单独回补。

## Private reporting

请不要通过公开 Issue、Discussion、PR、聊天截图或日志附件披露未修复漏洞。

首选使用 GitHub Private Vulnerability Reporting：

- https://github.com/restflux/domi/security/advisories/new

如果该入口不可用，请先通过仓库维护者的 GitHub 个人资料请求一个私下沟通渠道，不要在公开内容中发送漏洞细节。仓库公开前，维护者应在 **Settings → Security → Code security and analysis** 中确认 Private vulnerability reporting 已启用。

报告请提供：

- 受影响版本或 commit；
- 可复现步骤和必要的最小样例；
- 实际影响及攻击前置条件；
- 受影响平台；
- 建议修复方向（如有）。

请不要提交真实 API Key、OAuth token、用户会话、个人文件、完整本地路径或未脱敏日志。需要证明凭据泄露时，只提供类型、位置和经过脱敏的前后缀。

## Scope

优先处理以下问题：

- Execution Policy、Workflow、Session Target 或 Local Baseline 绕过；
- Managed Web 私网/redirect/secret 防护绕过；
- Pi Extension Trust、MCP、Skill 或工具授权绕过；
- 任意代码执行、路径逃逸、符号链接竞态或不安全反序列化；
- API Key、OAuth、会话、审计记录或备份泄露；
- Browser、Terminal、Automation、Collaboration 或远程 Bot 的跨会话权限混淆；
- 安装包、更新说明、原生依赖或第三方资源供应链问题。

普通功能缺陷、UI 问题、模型回答质量和需要用户主动安装不可信第三方扩展后才能发生的问题，通常不属于安全漏洞；仍可通过普通 Issue 报告，但不要附带秘密。

## Response expectations

维护者会尽快确认收到报告、评估影响并协调修复。修复发布前，请给维护者合理的处理时间。若问题影响凭据，维护者会优先要求轮换或吊销；删除 Git 内容不能替代凭据轮换。

Domi 的 Workspace Boundary、Managed Web、Full Access 提示和静态 Shell 分析不是 OS 或网络沙箱。Full Access 明确使用当前用户权限；同一系统用户下的恶意进程不在 Domi 能够完全防御的威胁模型内。

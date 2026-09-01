# 内置浏览器采用 WebContentsView 与 Main-owned 原子操作

## 状态

Accepted（2026-08-26），按当前实现更新。

## 背景

Domi 需要让用户和 Agent 查看并操作同一个可见页面，用于浏览公开网页、验证本地开发服务和提取受控页面信息。Renderer 直接持有任意 CDP、selector 或脚本接口会绕过 URL、Profile、权限和审计边界；使用隐藏外部 Chrome 又会让用户页面与 Agent 页面状态分叉。

## 决策

### 1. 页面由 Main-owned `WebContentsView` 承载

- Browser Session、Profile、导航、权限、缩放、布局和生命周期由 Main 持有。
- Renderer 只提交有界产品操作，不获得 `webContents`、CDP endpoint、任意 selector、XPath 或脚本执行能力。
- 页面显示在右侧工作区；切换工具只隐藏原生 View，显式关闭才释放 Session。

### 2. Profile 与 Work Session 隔离

- 交互式 owner 会话使用项目范围的浏览器 Profile。
- Automation、Delegation 等无人值守上下文不得静默继承用户登录态。
- Browser Session 记录所属 Agent Session 与 Session Target；目标变化后旧页面引用失效或标记为 stale。

### 3. 网络和权限策略由宿主执行

- 普通导航只允许公开 HTTP(S) 目标；每次 redirect 重新检查协议、凭据、主机和地址分类。
- 严格的 loopback URL 仅用于本地开发场景，不能借此放开任意私网、link-local 或 metadata 地址。
- 下载、外部协议、摄像头、麦克风、地理位置、通知和其他页面权限默认拒绝或进入明确产品流程。
- Managed Web 和 Browser Policy 不是 OS 或网络沙箱；DNS 解析与实际连接之间仍存在同用户环境无法彻底消除的 check/use 风险。

### 4. Agent 只使用短生命周期 ref 和原子操作

Main 在固定 isolated world 中生成有界语义 Snapshot，并签发只对当前页面身份和 navigation epoch 有效的短生命周期 ref。Agent 可以调用的操作限定为：

- 读取 Snapshot；
- 点击单个可交互 ref；
- 向非密码文本输入写入普通文本；
- 按固定方向和有限距离滚动；
- 提取单个 ref 的有界可见文本。

页面变化后旧 ref 失效。Snapshot 不采集表单值，不保存 selector / XPath，不返回 Cookie、脚本或完整 HTML。网页内容始终是不可信数据，不能改变任务、权限或 Session Target。

### 5. 元素引用由 Main 补齐页面身份

用户可在可见页面中选择单个元素，将有界文本和页面身份作为 Work 输入引用。Renderer 不能提交任意 selector 来伪造引用；引用不授予后续自动点击、输入或网络权限。

### 6. 外部影响保持显式

阅读和导航遵循 Managed Web 与 Workflow 边界。点击、输入等可能产生外部影响的操作必须来自当前用户触发的 Direct run，并经过宿主最终门禁和脱敏审计。凭据、支付、发布、删除和授权等高风险行为不能仅凭网页内容自动执行。

## Consequences

- 用户和 Agent 共享同一可见页面，同时 Browser Session 生命周期仍由宿主控制。
- 自动化能力比开放 CDP/Playwright API 更窄，但可以审计并阻止 stale ref、任意脚本和 Renderer 权限扩大。
- 高级 DevTools、复杂多 Tab 自动化和 OS Computer Use 不属于当前 Browser 原子操作契约，未来若引入需要新的独立决策。

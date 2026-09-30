# Domi 桌面安装包发布

Domi 的二进制发布范围是 Windows x64、Linux x64 与 macOS arm64。macOS 包为未签名（ad-hoc）构建：无 Developer ID 签名与 notarization，用户首次打开需右键「打开」跳过 Gatekeeper 提示；macOS x64 与正式签名/notarization 仍需真实证书与安装验证环境后再补。

发布流程只生成 GitHub Draft Release，不接入 Electron 自动更新，也不配置 electron-builder publish provider。维护者核对 Draft 中的安装包、校验和与发布说明后，才在 GitHub 页面手动公开为正式 Release。只有 alpha、beta、rc 或明确用于测试的版本才标记为 Pre-release。

## 发布资产

| 平台 | 资产 | 当前验证 |
| --- | --- | --- |
| Windows x64 | `Domi-<version>-windows-x64-setup.exe` | NSIS 打包、`win-unpacked/Domi.exe` 启动 smoke |
| macOS arm64 | `Domi-<version>-macos-arm64.dmg` | macOS runner 打包（ad-hoc 签名）、unpacked 应用启动 smoke |
| Linux x64 | `Domi-<version>-linux-x64.AppImage` | Linux runner 打包、unpacked 应用启动 smoke |
| Debian/Ubuntu x64 | `Domi-<version>-linux-x64.deb` | `dpkg-deb --info` 包结构检查 |
| 所有平台 | `SHA256SUMS.txt` | 合并 Windows 与 Linux 资产的 SHA-256 |

Windows 工作流支持 `WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD` Repository Secrets。CI 始终使用 `dist:win:release` 的标准 executable edit 与正式压缩；两项 Secrets 都已配置时继续完成 Authenticode 签名，未配置时 electron-builder 跳过签名。`dist:win:unsigned` 保留给本机缺少 Windows symlink 权限时生成等价的未签名公开发布包。签名状态与 GitHub 的 Pre-release 标记相互独立；未签名 Release Notes 必须保留 SmartScreen 提示。

## 版本定级与递增

版本使用 `major.minor.patch`，按变更语义选择递增级别，不按提交数量或数字位数自动进位。

| 变更类型 | 递增规则 | 示例 |
| --- | --- | --- |
| Bug 修复、小幅优化、不改变功能语义的调整 | patch +1 | `0.20.23 → 0.20.24` |
| 新增用户可见功能、实质性功能增强 | minor +1，patch 归零 | `0.20.23 → 0.21.0` |
| `0.x` 阶段的不兼容变更 | minor +1，并说明兼容性与迁移影响 | `0.20.23 → 0.21.0` |
| 产品与兼容性契约正式稳定 | 明确决策进入 `1.0.0` | 不自动触发 |
| `1.x` 及以后的不兼容变更 | major +1，minor 与 patch 归零 | `1.4.3 → 2.0.0` |
| 纯文档、测试或不影响产物的维护 | 不递增应用版本 | 保持不变 |

以一次交付或发布为单位统一递增：按该单位开始前的版本和全部变更中的最高影响级别确定目标版本。中间提交、checkpoint、验收后的修正不重复加号；如果范围扩大，从同一基线重新定级，而不是在已递增版本上连续加号。例如，基线为 `0.20.23` 的交付先修复问题、后新增功能，最终目标为 `0.21.0`，不是继续累加 patch。

根 `package.json` 与 `apps/electron/package.json` 的应用版本保持一致。内部 workspace 包按自身变更影响定级，无关包不跟随应用升版。修改默认 Skills 内容时，仍必须独立递增对应 `SKILL.md` frontmatter 的 `version`（patch +1），以保证老用户获得更新；该要求不依赖应用是否升版。

版本检查脚本只校验格式、应用版本一致性及 tag 匹配，不会自动判断变更级别或递增版本。发布前应人工确认定级与本次变更相符；递增版本本身不会创建 tag 或发布 Release。

## 发布前提

1. 目标提交已经合入并推送到 `origin/main`；不得从只存在于本机的提交发布。
2. 工作区没有未提交改动。
3. 根 `package.json` 与 `apps/electron/package.json` 使用相同版本。
4. 版本符合 semver，Release tag 必须严格使用 `v<version>`，例如 `v0.20.2`。
5. tag 构建的校验 job 会运行发布链路测试与类型检查，这是硬门槛；push CI 默认为快车道（类型检查、M0 测试、构建打包与启动 smoke），不要求等它全绿后再打 tag。全量测试基线每日定时运行，发布前如需全量确认，可在 Actions 手动触发一次 Domi CI（全量车道）。
6. 新增或修改打包/发布链路时，先完成 Release Candidate workflow 的手动试跑。
7. `README.md`、`README.en.md`、许可证和第三方声明与本次资产内容一致。

本地检查版本：

```bash
bun run scripts/verify-release-version.ts
```

## 先试跑 Release Candidate

在 GitHub Actions 中手动运行 **Domi Release Candidate** workflow，并选择准备发布的 `main`。手动运行只执行以下工作：

- 校验版本、测试与类型检查；
- 根据签名 Secrets 构建已签名或明确标注的未签名 Windows x64 安装包；
- 构建 Linux x64 AppImage 和 `.deb`；
- 执行平台 smoke；
- 将安装包和平台校验和保存为 14 天 Actions artifacts。

手动运行不会创建 tag，也不会创建或公开 GitHub Release。下载 artifacts，在干净环境中至少完成一次 Windows 安装/卸载和 Linux 启动检查。

## 创建发布 tag

确认目标提交已在 `origin/main` 后，从该提交创建带注释 tag：

```bash
git tag -a v0.20.2 -m "Domi v0.20.2"
git push origin v0.20.2
```

推送 `v*` tag 会再次运行完整构建。workflow 会校验 tag 版本与两个 package 版本一致；任何不一致都会在生成资产前失败。

## 检查 Draft Release

tag 构建全部通过后，workflow 使用 GitHub CLI：

1. 创建对应 tag 的 Draft Release；
2. 使用 GitHub 自动生成的 Release Notes 作为初稿；
3. 上传 Windows、Linux 和统一 SHA-256 文件；
4. 重跑时覆盖同名资产，不重复创建 Release。

公开前人工检查：

- 安装包版本、文件名与 tag 一致；
- Release 资产只包含 Windows x64、Linux x64 和 `SHA256SUMS.txt`；
- 在本地验证校验和；
- Release Notes 采用中英双版（先完整中文、分隔线后完整 English），说明主要功能、修复、支持平台和已知限制；
- 未签名 Windows 包明确说明 SmartScreen；
- 不承诺 macOS 二进制支持或自动更新。

Linux/macOS：

```bash
sha256sum --check SHA256SUMS.txt
```

Windows PowerShell 可逐个比较：

```powershell
Get-FileHash -Algorithm SHA256 .\Domi-<version>-windows-x64-setup.exe
```

确认无误后，在 GitHub Release 页面点击 **Publish release**，公开为正式 Release。只有版本号或发布目的明确属于 alpha、beta、rc 或测试版本时才勾选 **Set as a pre-release**。公开发布动作不由 workflow 自动执行。

## Windows 签名升级

获得 Windows 代码签名证书后，将证书和密码配置为 Repository Secrets：

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

不得把 PFX、密码、Base64 证书内容或云签名凭据写入仓库、workflow 日志、Issue 或 Release Notes。首次启用签名时，应检查安装程序和 `win-unpacked/Domi.exe` 的 Authenticode 状态，并重新做安装与启动验证。

## macOS 签名升级与 x64 扩展

当前 macOS arm64 已在真实 macOS runner 上构建、启动 smoke 并发布未签名（ad-hoc）DMG。后续升级条件：

- 获得证书后配置 Developer ID Application 签名、hardened runtime、entitlements，并完成 notarization 与 stapling；
- 发布说明更新为已签名；在此之前 macOS 包必须保留 Gatekeeper 右键「打开」提示；
- 需要 x64 支持时，先准备 x64 版 `macos-agent-island-helper` 并在 Intel Mac 上完成安装验证；
- 在干净 Mac 上验证 DMG 安装、首次启动和基本 Work 会话。

不从 Windows 交叉生成或上传未经验证的 macOS 安装包。

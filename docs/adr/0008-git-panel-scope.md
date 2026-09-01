# Git Panel 定位为会话日常闭环，非通用 Git 客户端

## 状态

Accepted。

右侧面板"文件改动"Tab（Changes Tab）升级为轻量 Git Panel：覆盖暂存/取消暂存、提交（含"提交并推送"）、丢弃改动、本地分支切换、pull/push，以及只读提交历史（可下钻至单提交 Diff）与 tag 徽章标注；明确不做创建分支、stash、rebase/merge 交互、冲突解决器、remote 管理、submodule——深度 Git 操作由用户的外部 VS Code 承担。面板能力边界参照 VS Code 源码管理的日常子集，以匹配用户既有交互习惯。

写操作一律作用于整个仓库工作区（不区分 Agent 写入与手动改动；暂存区本就是仓库级的），unseen 圆点等"Agent 本轮改动"可见性保留在查看层。未绑定活动会话的普通模式渲染路径冻结现状（只读 + 还原），不新增写操作，避免维护第二套基于物理路径的寻址。

所有写操作沿用 Repository ID 不透明契约（renderer 永不接触物理 checkout 路径，主进程持有 session target → checkout 映射）。实现延续主进程现有 `spawn('git', ...)` CLI 模式，不引入第三方 Git 库，以保留系统 git 的凭据存储、hooks 与 checkout 行为一致性。

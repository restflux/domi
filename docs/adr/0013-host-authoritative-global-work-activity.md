# Derive global Work Activity from host-authoritative facts

## 状态

Accepted。

Domi 的「工作动态」采用跨项目、宿主事实驱动的派生读模型，而不是把 Renderer 的 `running / blocked / completed` 指示点扩展成第二套会话状态系统。一个 Work Session 聚合父 Agent 会话及其全部委派后代；任一成员存在待处理事项时为 Attention Required，否则任一成员仍真实执行时为 Working，全部成员进入终态且无待处理事项时才为 Recently Completed。运行、待回答、待批准、交付验收、冲突、失败与 Automation 来源等事实由各自既有 owner 提供；工作动态只投影和呈现，不取得执行、权限或 Session Target 生命周期的所有权。

需要跨重启保留的只是用户层事实与短期呈现状态，例如未读事件、失败已知晓、最近完成保留期和通知去重键。启动时必须重新读取宿主的活跃运行、待处理请求、Session Target 交付状态和协作关系进行对账；不得根据上次保存的 `running` 标签宣称 Agent 仍在工作。待处理与未读相互独立：查看会话只能清除未读强调，不能解决回答、批准、冲突或验收动作。

这个边界使左侧概览、完整工作动态、Dock 角标与通知共享同一投影，同时避免它们绕过原会话执行、停止确认、Apply、Preview、验收、权限审批和 Automation 生命周期。普通 Chat 不进入 Work Activity；工具调用和进度任务只作为 Work Session 的阶段与详情证据，不成为顶层工作条目。

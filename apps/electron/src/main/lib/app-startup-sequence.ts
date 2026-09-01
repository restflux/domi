export interface AppStartupSequenceHooks {
  prepareWindow(): void | Promise<void>
  createWindow(): Promise<void>
  initializeServices(): Promise<void>
}

/**
 * 启动关键路径只负责把主窗口显示出来；可能受磁盘、外部命令或网络影响的服务初始化
 * 必须等窗口可见后再执行，避免用户双击应用后长时间没有任何反馈。
 */
export async function runAppStartupSequence(hooks: AppStartupSequenceHooks): Promise<void> {
  await hooks.prepareWindow()
  await hooks.createWindow()
  await hooks.initializeServices()
}

export interface FileBrowserRootIdentity {
  path: string
  scope: 'project' | 'session'
}

/**
 * 构造文件树物理根的稳定签名。
 * 常规文件变化不会改变签名；切换来源、项目或 Session Target 时才会改变。
 */
export function createFileBrowserRootSignature(roots: readonly FileBrowserRootIdentity[]): string {
  return JSON.stringify(roots.map(({ path, scope }) => [scope, path]))
}

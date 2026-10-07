/** 为宿主独立副本发布保留的命名空间；异常退出后的残留也不能进入交付。 */
export function isLocalFileTemporaryPath(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').at(-1) ?? ''
  return /^\.domi-local-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:tmp|previous)$/i.test(name)
}

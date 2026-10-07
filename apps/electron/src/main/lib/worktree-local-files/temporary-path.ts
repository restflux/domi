const HEX = '[0-9a-f]'
const UUID_GLOB = `${HEX.repeat(8)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(4)}-${HEX.repeat(12)}`

/** 为宿主独立副本发布保留的命名空间；异常退出后的残留也不能进入交付。 */
export function isLocalFileTemporaryPath(path: string): boolean {
  const name = path.replace(/\\/g, '/').split('/').at(-1) ?? ''
  return /^\.domi-local-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.(?:tmp|previous)$/i.test(name)
}

export const LOCAL_FILE_TEMPORARY_EXCLUDES = ['tmp', 'previous'].map((extension) =>
  `:(top,exclude,glob,icase)**/.domi-local-${UUID_GLOB}.${extension}`)

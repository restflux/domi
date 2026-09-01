/** Slice A 不向任意网页授予 Electron 页面权限；后续能力必须逐项设计并显式开放。 */
export function isBrowserPermissionAllowed(_permission: string): boolean {
  return false
}

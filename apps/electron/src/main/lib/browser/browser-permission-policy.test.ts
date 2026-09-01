import { describe, expect, test } from 'bun:test'
import { isBrowserPermissionAllowed } from './browser-permission-policy.ts'

describe('浏览器页面权限策略', () => {
  test('Given any page permission request When checking Slice A policy Then it is denied', () => {
    for (const permission of ['media', 'notifications', 'geolocation', 'clipboard-read', 'usb', 'serial', 'midi', 'display-capture']) {
      expect(isBrowserPermissionAllowed(permission)).toBe(false)
    }
  })
})

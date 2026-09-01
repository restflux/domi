import { join } from 'node:path'
import { AuditWriter } from '../audit/audit-writer.ts'
import { getConfigDir } from '../config-paths.ts'
import { ManagedWebAccessPolicy } from './managed-web-access-policy.ts'
import { ManagedWebAccess } from './managed-web-access.ts'

let managedWebAccess: ManagedWebAccess | undefined

/** 获取宿主统一的 Managed Web Access guard 与 audit 实例。 */
export function getManagedWebAccess(): ManagedWebAccess {
  if (!managedWebAccess) {
    managedWebAccess = new ManagedWebAccess({
      policy: new ManagedWebAccessPolicy(),
      auditWriter: new AuditWriter({ auditDir: join(getConfigDir(), 'audit') }),
    })
  }
  return managedWebAccess
}

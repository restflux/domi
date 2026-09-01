import { expect, test } from 'bun:test'
import * as shared from '../../../../../packages/shared/src/index.ts'
import { AgentPermissionService } from './agent-permission-service.ts'

test('Pi permission facade exposes no legacy SDK classifier or session whitelist entry points', () => {
  const service = new AgentPermissionService() as unknown as Record<string, unknown>

  expect(service.createCanUseTool).toBeUndefined()
  expect(service.clearSessionWhitelist).toBeUndefined()
})

test('shared package no longer exports the raw-string legacy permission classifier', () => {
  const exports = shared as unknown as Record<string, unknown>

  expect(exports.SAFE_TOOLS).toBeUndefined()
  expect(exports.SAFE_BASH_PATTERNS).toBeUndefined()
  expect(exports.DANGEROUS_COMMANDS).toBeUndefined()
  expect(exports.hasDangerousStructure).toBeUndefined()
  expect(exports.isSafeBashCommand).toBeUndefined()
  expect(exports.isDangerousCommand).toBeUndefined()
})

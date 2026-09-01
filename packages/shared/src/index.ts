/**
 * @domi/shared - Shared types, configs and utilities
 */

export * from './types/index'
export * from './config/index'
export * from './utils/index'
// Legacy raw-string permission rules were removed; Shell authorization lives in Electron Execution Policy.
export * from './constants/direct-workflow.ts'
export * from './constants/pi-extension-trust.ts'
export * from './constants/pi-run-timing.ts'
export * from './constants/session-checkout.ts'
export * from './constants/browser.ts'
export * from './constants/terminal.ts'
export * from './work-activity-projector.ts'

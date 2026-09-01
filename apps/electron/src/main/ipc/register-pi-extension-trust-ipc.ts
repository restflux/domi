import type { IpcMain } from 'electron'
import {
  PI_EXTENSION_TRUST_IPC_CHANNELS,
  type ApprovePiExtensionCandidateInput,
  type ListPiExtensionTrustInput,
  type PickPiExtensionCandidateInput,
  type PiExtensionTrustApi,
  type RevokePiExtensionTrustInput,
} from '@domi/shared'

/** 只负责把 typed IPC command 转发给主进程 service。 */
export function registerPiExtensionTrustIpc(
  ipc: Pick<IpcMain, 'handle'>,
  service: PiExtensionTrustApi,
): void {
  ipc.handle(
    PI_EXTENSION_TRUST_IPC_CHANNELS.PICK_CANDIDATE,
    (_, input: PickPiExtensionCandidateInput) => service.pickCandidate(input),
  )
  ipc.handle(
    PI_EXTENSION_TRUST_IPC_CHANNELS.LIST,
    (_, input: ListPiExtensionTrustInput) => service.list(input),
  )
  ipc.handle(
    PI_EXTENSION_TRUST_IPC_CHANNELS.APPROVE,
    (_, input: ApprovePiExtensionCandidateInput) => service.approve(input),
  )
  ipc.handle(
    PI_EXTENSION_TRUST_IPC_CHANNELS.REVOKE,
    (_, input: RevokePiExtensionTrustInput) => service.revoke(input),
  )
}

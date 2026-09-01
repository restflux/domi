export type PiExtensionCandidateKind = 'file' | 'directory'

export type PiExtensionTrustStatus = 'valid' | 'stale' | 'missing' | 'invalid'

export interface PickPiExtensionCandidateInput {
  workspaceId: string
  kind: PiExtensionCandidateKind
}

export interface PiExtensionCandidatePreview {
  /** 主进程内存中候选记录的短期、一次性引用；不是本地路径。 */
  candidateToken: string
  path: string
  digest: string
  kind: PiExtensionCandidateKind
}

export interface ListPiExtensionTrustInput {
  workspaceId: string
}

export interface ApprovePiExtensionCandidateInput {
  workspaceId: string
  candidateToken: string
}

export interface RevokePiExtensionTrustInput {
  workspaceId: string
  extensionId: string
}

export interface PiExtensionTrustEntry {
  extensionId: string
  path: string
  digest: string
  approvedAt: string
  status: PiExtensionTrustStatus
}

export interface PiExtensionTrustApi {
  pickCandidate: (input: PickPiExtensionCandidateInput) => Promise<PiExtensionCandidatePreview | null>
  list: (input: ListPiExtensionTrustInput) => Promise<PiExtensionTrustEntry[]>
  approve: (input: ApprovePiExtensionCandidateInput) => Promise<PiExtensionTrustEntry>
  revoke: (input: RevokePiExtensionTrustInput) => Promise<void>
}

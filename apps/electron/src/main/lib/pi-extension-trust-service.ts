import { randomUUID } from 'node:crypto'
import type {
  ApprovePiExtensionCandidateInput,
  ListPiExtensionTrustInput,
  PickPiExtensionCandidateInput,
  PiExtensionCandidateKind,
  PiExtensionCandidatePreview,
  PiExtensionTrustEntry,
  RevokePiExtensionTrustInput,
} from '@domi/shared'
import type {
  ExtensionInspection,
  ExtensionTrustStore,
} from './adapters/pi-extension-trust.ts'

const DEFAULT_CANDIDATE_TTL_MS = 5 * 60 * 1_000

export interface PiExtensionWorkspaceResolution {
  workspaceId: string
  projectId: string
  projectRoot: string
}

export interface PiExtensionTrustServiceOptions {
  store: ExtensionTrustStore
  picker: (kind: PiExtensionCandidateKind) => Promise<string | null>
  workspaceResolver: (workspaceId: string) => PiExtensionWorkspaceResolution | undefined
  tokenFactory?: () => string
  now?: () => number
  candidateTtlMs?: number
}

interface PendingCandidate {
  projectId: string
  inspection: ExtensionInspection
  expiresAt: number
}

function toTrustEntry(entry: {
  extensionId: string
  path: string
  digest: string
  approvedAt: string
  status: PiExtensionTrustEntry['status']
}): PiExtensionTrustEntry {
  return {
    extensionId: entry.extensionId,
    path: entry.path,
    digest: entry.digest,
    approvedAt: entry.approvedAt,
    status: entry.status,
  }
}

/**
 * Renderer 只能持有短期 opaque token。所有路径选择、项目解析与最终摘要复核都留在主进程。
 */
export class PiExtensionTrustService {
  private readonly candidates = new Map<string, PendingCandidate>()
  private readonly tokenFactory: () => string
  private readonly now: () => number
  private readonly candidateTtlMs: number

  constructor(private readonly options: PiExtensionTrustServiceOptions) {
    this.tokenFactory = options.tokenFactory ?? randomUUID
    this.now = options.now ?? Date.now
    this.candidateTtlMs = options.candidateTtlMs ?? DEFAULT_CANDIDATE_TTL_MS
  }

  async pickCandidate(input: PickPiExtensionCandidateInput): Promise<PiExtensionCandidatePreview | null> {
    const workspace = this.resolveWorkspace(input.workspaceId)
    const selectedPath = await this.options.picker(input.kind)
    if (!selectedPath) return null

    const inspection = this.options.store.inspect({
      projectRoot: workspace.projectRoot,
      path: selectedPath,
    })
    if (inspection.kind !== input.kind) throw new Error('选择的候选类型不匹配')

    const candidateToken = this.tokenFactory()
    if (!candidateToken || this.candidates.has(candidateToken)) throw new Error('无法创建候选 token')
    this.candidates.set(candidateToken, {
      projectId: workspace.projectId,
      inspection,
      expiresAt: this.now() + this.candidateTtlMs,
    })

    return {
      candidateToken,
      path: inspection.path,
      digest: inspection.digest,
      kind: inspection.kind,
    }
  }

  async list(input: ListPiExtensionTrustInput): Promise<PiExtensionTrustEntry[]> {
    const workspace = this.resolveWorkspace(input.workspaceId)
    return this.options.store.list(workspace.projectRoot).map(toTrustEntry)
  }

  async approve(input: ApprovePiExtensionCandidateInput): Promise<PiExtensionTrustEntry> {
    const workspace = this.resolveWorkspace(input.workspaceId)
    const pending = this.candidates.get(input.candidateToken)
    this.candidates.delete(input.candidateToken)
    if (!pending || pending.expiresAt < this.now()) throw new Error('候选已失效，请重新选择')
    if (pending.projectId !== workspace.projectId) throw new Error('候选不属于当前项目')

    const approved = this.options.store.approve({
      projectRoot: workspace.projectRoot,
      path: pending.inspection.path,
    }, pending.inspection)
    return toTrustEntry(approved)
  }

  async revoke(input: RevokePiExtensionTrustInput): Promise<void> {
    const workspace = this.resolveWorkspace(input.workspaceId)
    this.options.store.revoke(workspace.projectRoot, input.extensionId)
  }

  private resolveWorkspace(workspaceId: string): PiExtensionWorkspaceResolution {
    const workspace = this.options.workspaceResolver(workspaceId)
    if (!workspace) throw new Error('项目不存在')
    return workspace
  }
}

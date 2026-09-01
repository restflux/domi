# Split permission interaction from policy resolution

## Status

Accepted.

Domi previously kept two authorization systems inside `AgentPermissionService`. The production Pi path used `PiExecutionController` and `ExecutionPolicy`, while an unused legacy `createCanUseTool()` path still maintained a session whitelist and classified raw Bash strings through `packages/shared/src/constants/permission-rules.ts`. Even without a production caller, that second interpretation could be accidentally reconnected and violate Canonical Shell Analysis.

The permission architecture now has one authorization owner and several narrow interaction components:

- `ExecutionPolicy` computes normalized facts and resolves them through the closed `PolicyResolution` union: `allow`, `require-approval`, or `deny`.
- `AgentPermissionService` is only a facade over user interaction and host transactions. It does not parse Shell, classify risk, or maintain allow-always rules.
- `BlockingPermissionApprovalStore` owns pending Promise lifecycles for one-time approvals.
- `DeferredPermissionApprovalStore` owns persisted, snapshot-bound Worktree and Local Maintenance transactions.
- `SessionCapabilityApprovalService` keeps the legacy process-local Git push capability compatibility isolated from ordinary Full Access execution.
- `permission-request-factory.ts` owns request presentation metadata and bounded product-input acceptance.

The unused `createCanUseTool()` entry point, session tool/Bash whitelist, base-command extraction, and raw-string shared permission rules are removed. `@domi/shared` no longer exports command classifiers. All Shell authorization must flow through the Canonical Shell Analysis owned by Electron Execution Policy.

`alwaysAllow` remains in the renderer/IPC response shape for wire compatibility, but the Pi permission facade intentionally ignores it. Policy approvals are single-use unless a dedicated host capability implements a separately bounded grant.

ADR 0011 now defines Full Access as `bypassPermissions`: generic risk facts, including Local Baseline and protected-looking path heuristics, are audit-only and do not open Policy approval. This architecture still keeps Local writeback/delivery transactions, Session Target ownership, managed Worktree/workbench lifecycle, product confirmations, and Extension Trust as host-owned boundaries outside the generic resolver.

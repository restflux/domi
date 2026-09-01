# Separate Agent workflow from execution policy

## Status

Accepted.

## Context

Planning and permission authority answer different questions. Approving a plan means the proposed sequence is acceptable; it does not grant broader filesystem, process, network or Git authority.

## Decision

Domi models Workflow independently from Execution Policy:

- Workflow is `Direct` or `Plan First`.
- Execution Policy is `Controlled`, `Autonomous` or explicitly selected `Full Access`.
- New sessions default to `Controlled + Direct`.
- Approving a Plan First proposal returns to Direct while preserving the previously selected Execution Policy.
- Full Access requires explicit user selection and an unsandboxed-execution warning. It aligns with Pi `bypassPermissions` for ordinary policy risks, while host-owned Session Target, Local writeback, delivery, maintenance, extension trust and product-confirmation boundaries remain authoritative.

Legacy persisted values are migrated only through typed compatibility rules. Plan approval never writes a legacy permission mode or widens authority.

## Consequences

- Users can require planning without accepting broader execution rights.
- Permission UI and workflow UI can evolve independently.
- Every tool invocation still passes through the host's final authorization and Session Target checks.

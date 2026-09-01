# ADR 0016: Research and Execute are the only persistent Work modes

- Status: Accepted
- Date: 2026-09-01
- Supersedes: the user-facing execution-policy selector described by ADR 0011
- Refines: ADR 0005

## Context

Domi previously exposed two independent selectors: an Execution Policy with Controlled, Autonomous, and Full Access, plus a Workflow with Direct and Plan First. Although the separation was structurally sound, users had to reason about combinations that did not correspond to distinct daily jobs. The product already relied on host-owned boundaries for Local delivery, Worktree ownership, external publication, Extension Trust, and other consequential transactions, so changing a generic permission tier could not safely authorize those operations anyway.

The three policy levels also obscured the actual user decision:

- investigate without changing the project; or
- let the Agent edit, run, and validate.

## Decision

Domi exposes exactly two persistent Work modes:

### Research

Research uses the internal `read-only` Workflow. It allows proven local reads, planning, Managed Web, and bounded host-managed browser research. Project writes and ordinary process side effects are unavailable.

When a task needs writes, Research may request a **Temporary Execute Lease**. The lease:

- is bound to the exact Agent run token;
- does not change the persistent session mode;
- is cleared only by that run's terminal event; and
- returns the session to Research automatically.

### Execute

Execute uses the internal `direct` Workflow and the current OS user's permissions. It is the default for new sessions. Domi does not provide an OS sandbox, and the UI must state that directly.

Execute removes generic low-value permission prompts for ordinary coding work. It does not bypass host-owned transactions, including:

- Isolated-to-Local Preview/finalize delivery;
- Local Maintenance;
- Session Target ownership and revision checks;
- destructive lifecycle or managed Worktree integrity operations;
- external publication and narrowly scoped capability grants;
- Pi Extension Trust; and
- product confirmations that require explicit user intent.

### Internal compatibility

`ExecutionPolicyMode` and historical Controlled / Autonomous / Full Access values remain migration and audit inputs. Current session normalization always produces the unsandboxed execution policy; they are not user-selectable modes.

`direct`, `read-only`, and `plan-first` remain internal Workflow values. Plan First is a run lifecycle, not a third persistent mode: approval resumes under the session's existing Research or Execute semantics and never grants execution by itself.

## Consequences

- The mode selector and documentation discuss Research, Execute, and Temporary Execute only.
- New sessions default to Execute and explicitly disclose the lack of an OS sandbox.
- Workflow remains independent from host-owned lifecycle and trust boundaries, preserving ADR 0005's central decision.
- ADR 0011 remains authoritative for Canonical Shell Analysis and Execute's trust semantics, but its explicit user-facing Full Access selection is superseded.
- Tests must treat legacy policy values as migration fixtures rather than current product options.
- Future permission work must add a precise host capability or transaction boundary instead of reintroducing a generic three-level policy selector.

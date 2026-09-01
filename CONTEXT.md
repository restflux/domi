# Personal Coding Workbench

This context defines the product language and long-lived domain boundaries for the open-source Domi Personal Coding Workbench.

## Language

**Domi**:
The product name and independent installation identity of the Personal Coding Workbench.
_Avoid_: Proma, Domi AI, 多米

**Personal Coding Workbench**:
A local-first desktop workbench for user-owned Chat, Agent execution, project context, automation and delivery workflows.
_Avoid_: General-purpose IDE, hosted Agent service, upstream Proma edition

**Agent Runtime**:
Pi, the only execution runtime for Agent sessions in the Personal Coding Workbench. Anthropic and Claude remain model/provider choices, not alternate runtimes.
_Avoid_: Primary Runtime, Legacy Runtime, dual-runtime parity, runtime selector

**Work Activity**:
The cross-project operational view labeled "工作动态" that keeps manual and automated Agent work visible until it no longer needs awareness or action. Ordinary Chat conversations are outside this view.
_Avoid_: AI 工作, 工作面板, Work Dashboard, Chat activity

**Work Session**:
The top-level unit in Work Activity: one Agent session together with its delegated descendant sessions, treated as a single aggregate for status and completion.
_Avoid_: Tool call, progress task, individual delegated Agent row

**Work State**:
The user-facing classification of a Work Session derived from its whole collaboration tree and unresolved user actions: Attention Required, Working, or Recently Completed.
_Avoid_: Stream state, unread state, parent-session state

**Attention Required**:
The Work State for a Work Session that needs a user action to continue or settle, or has a failure or interruption that has not been acknowledged.
_Avoid_: Blocked only, unread, notification

**Working**:
The Work State for a Work Session whose collaboration tree still has active execution and has no higher-priority Attention Required condition.
_Avoid_: Parent session is streaming, tool is running

**Recently Completed**:
The temporary Work State for a terminal Work Session with no unresolved user action. It preserves short-term awareness without turning Work Activity into session history.
_Avoid_: Archived history, successful only, Agent stopped emitting

**Pending Action**:
An objective unresolved action associated with a Work Session, such as answering, approving, reviewing, or resolving a conflict. Viewing the session does not resolve it.
_Avoid_: Unread, unseen completion, notification badge

**Unread Work Event**:
A Work Activity event the user has not yet viewed; it controls visual emphasis and notification presence but never replaces or clears a Pending Action.
_Avoid_: Pending action, blocked state, unresolved work

**Agent Knowledge Compatibility**:
Writable Domi-managed `AGENTS.md` and `.claude/memory`, safe migration or read-only fallback from legacy managed `CLAUDE.md`, plus read-only compatibility with external `~/.claude/skills`. These compatibility formats do not imply a Claude Agent SDK execution path.
_Avoid_: Claude Runtime, fallback runtime, Claude session migration

**Workbench Installation**:
An installation of Domi with its own application identifier, name and data directory, independent from a Proma installation. Domi does not consume Proma's official updater; source builds and separately distributed binaries use an explicit manual update path.
_Avoid_: Proma update, shared profile, in-place patch

**Primary Platform**:
Windows, where the Personal Coding Workbench is developed and fully validated.
_Avoid_: Windows-only platform

**Compatibility Platform**:
An operating system kept architecturally compatible without the same release or regression guarantees as the Primary Platform. macOS is compatibility-tested when practical; Linux is best-effort until packaging and validation are added.
_Avoid_: Fully supported platform

**Editor Context Bridge**:
An optional local connector that exchanges selected code, diagnostics, file locations, and navigation requests with an external editor. It does not embed an editor or make the Personal Coding Workbench depend on a specific IDE.
_Avoid_: Embedded editor, VS Code binding, IDE replacement

**Session Target**:
The checkout in which an Agent session reads, edits, and validates code. A session targets either the user's Local Checkout or a Domi-managed Isolated Checkout.
_Avoid_: Workspace mode, execution mode

**Local Checkout**:
The user's existing project checkout, where Agent changes are immediately visible alongside the user's own work.
_Avoid_: Main branch, primary worktree

**Isolated Checkout**:
A Domi-managed Git worktree associated with an Agent session so its changes remain separate until the user integrates or discards them.
_Avoid_: Sandbox, temporary clone

**Session Base**:
The commit from which an Isolated Checkout is created. It defaults to the Local Checkout's current `HEAD` and excludes uncommitted local changes.
_Avoid_: Current working tree, copied workspace

**Git Panel**:
The view inside the Changes Tab that presents the session target's Git working-tree state and supports daily operations—staging, committing, branch switching, pull/push, and read-only commit history and tag browsing. It follows VS Code source-control interaction habits.
_Avoid_: SCM panel, source-control panel, Git client

**Changes Tab**:
The right-side panel tab whose UI label is "文件改动". It hosts the Git Panel when the session target is a Git repository and falls back to the Session File Change List otherwise. Its name stays unchanged by the Git Panel upgrade.
_Avoid_: Git tab, changes view

**Session File Change List**:
The fallback rendering of the Changes Tab when the session target is not a Git repository: a list of files the Agent session wrote, grouped into current and earlier runs.
_Avoid_: Project file list, file browser, changes list

**Apply**:
The user-approved projection of one Isolated Checkout task into the current Local Checkout as a durable, reversible Preview.

**Repository ID**:
An opaque, non-path identifier used by the Renderer to address a Git repository; the main process owns the mapping from session target to physical checkout paths. All Git Panel read and write operations go through this mapping.
_Avoid_: Repository path, git root as renderer input Every successful Apply retains a receipt for complete withdrawal or single-commit finalization; there is no independent untracked Apply layer. It stops for explicit conflict resolution rather than silently overwriting local work.
_Avoid_: Merge, auto-commit, handoff, bare Local patch

**Workspace Boundary**:
The permitted side-effect area consisting of the Session Target and explicitly managed temporary locations. It limits where tools may write but is not by itself an operating-system sandbox.
_Avoid_: Worktree isolation, full system access

**Controlled Execution**:
Execution within the Workspace Boundary where routine coding operations proceed automatically and boundary crossings or high-risk actions require approval. It is the default for projects that have not been trusted.
_Avoid_: Plan mode, manual mode

**Autonomous Execution**:
Low-friction execution within the Workspace Boundary where routine coding, build, and validation actions do not request approval. It does not grant unrestricted access to the whole computer.
_Avoid_: Bypass permissions, full access, YOLO mode

**Full Access Execution**:
An explicitly selected, unsandboxed Pi execution policy aligned with Claude Code `bypassPermissions`. Generic Execution Policy risk heuristics—including sensitive/path-name classification, opaque or unavailable parsers, dynamic deletion, Local Baseline evidence, destructive Git, external impact, network and interpreters—become audit-only and do not prompt. It is never the default and Plan approval never enables it. Workflow remains independent. Domi still enforces host-owned lifecycle boundaries directly: Isolated-to-Local writeback transactions, target ownership, managed Worktree/workbench integrity, product confirmation transactions and Extension Trust.
_Avoid_: Autonomous Execution, trusted project, sandbox, generic risk approval

**Canonical Shell Analysis**:
The single structured interpretation of one Shell source string used by Workflow, Execution Policy, Session Target guards, Git/network/deletion/path classification, and read-only hardening. Bash uses `unbash`; nested PowerShell source uses `tree-sitter-powershell` and is never parsed as Bash. It identifies real executable stages, static argv, redirects, assignments, operators, dialect, provenance, and bounded nested execution. Literal argv text can never be reinterpreted as executable by a downstream policy; uncertain input is reported as opaque or invalid rather than assigned a fabricated risk category. PowerShell variable-derived deletion targets are only security-positive when canonical paths remain inside a host-provided managed root such as the current session workbench `.context`.
_Avoid_: Regex command splitting, keyword scanning, multiple parser opinions

**Policy Resolution**:
The pure, closed decision produced from normalized authorization facts: `allow`, `require-approval`, or `deny`, each with a stable decision code. Execution Policy owns this decision; permission interaction services may present or persist it but must not reclassify tools, Shell text, or risk.
_Avoid_: Approval UI as classifier, session command whitelist, parallel permission engine

**Session Capability Grant**:
A process-local, revocable authorization for one narrowly described host capability. The original ordinary Git push grant is retained only as compatibility/history after Full Access adopted direct trust semantics; new Full Access Agent runs do not expose or require it. Future grants must remain bound to precise session, checkout, repository and operation provenance.
_Avoid_: Trusted project, permanent whitelist, Full Access, generic allow-always

**Local Baseline**:
The Local Checkout state captured when an Agent run begins, including pre-existing tracked and untracked changes. Controlled and Autonomous use it for destructive-operation approval. Full Access accepts ordinary tool risk instead of prompting on baseline heuristics; in Isolated sessions, explicit writes to the real Local Checkout remain blocked by the host and must use Apply, Finish or Local Maintenance.
_Avoid_: Git base, Session Base, checkpoint

**Local Maintenance Transaction**:
A snapshot-bound, user-approved lease that lets an Isolated Checkout session repair the real Local Checkout through bounded host tools without changing its Session Target. Approval must durably queue and automatically resume the interrupted Agent task—even if the owner view mounts later—and must not leave an active transaction waiting for the user to send another message. Every transaction preserves recovery artifacts and requires explicit completion or recovery.
_Avoid_: Extra execution permission, unrestricted Local shell, silent target switch

**Managed Web Access**:
Domi-mediated search and retrieval of public HTTP(S) resources with secret filtering, private-network blocking, redirect rechecks, and audit records. It is available without per-domain approval, but it is not a network sandbox and the first version does not pin a previously resolved address against DNS rebinding.
_Avoid_: Unrestricted network access, browser automation

**Process Network Access**:
Outbound access initiated by an Agent-run process such as a package manager, Git, shell script, or downloaded executable. Known project endpoints may be allowed while new destinations require approval.
_Avoid_: Web search, model API traffic

**Direct Workflow**:
A session workflow in which the Agent may execute immediately under the selected execution policy, while retaining the ability to enter planning when needed.
_Avoid_: Autonomous Execution, bypass mode

**Plan First**:
A session workflow that remains read-only until the user approves the proposed plan, then resumes under the execution policy selected before planning.
_Avoid_: Plan permission, full-auto approval

**Verification Gate**:
A Domi-controlled set of deterministic project checks selected from the final change scope and required before isolated changes become Ready to Apply. The user may explicitly override a failure, but the result remains Unverified.
_Avoid_: Model self-check, CI pipeline, optional test suggestion

**Verification Level**:
The minimum verification strength required by a change: Quick for narrow low-risk changes, Standard for ordinary feature changes, or Full for broad and high-risk changes. The Agent may raise this level but cannot lower it.
_Avoid_: Timeout, model confidence, test count

**Ready to Apply**:
An Isolated Checkout state whose required Verification Level has passed and whose changes can be reviewed and transferred to the Local Checkout.
_Avoid_: Agent finished, tests probably pass

**Unverified**:
A visible result state created when required verification fails, is cancelled, or is explicitly bypassed. It must not be represented as Ready to Apply.
_Avoid_: Probably safe, soft pass

**Verification Profile**:
The user-approved project checks and minimal change-to-level rules used by the Verification Gate. Domi stores it privately by default and may export it into the repository when the user wants to share it.
_Avoid_: Model-generated command, CI configuration

**Baseline Failure**:
A verification failure reproducible at the Session Base and therefore not introduced by the current Agent changes. It remains visible but does not block Ready to Apply.
_Avoid_: Accepted regression, ignored failure

**Regression**:
A verification failure introduced or worsened relative to the Session Base. Regressions block Ready to Apply unless the user explicitly accepts an Unverified result.
_Avoid_: Any failing test, Baseline Failure

**Repair Cycle**:
One bounded attempt in which verification evidence for a Regression is returned to the Agent, the Agent edits the change, and the failed checks run again. Automatic repair stops after two cycles or earlier when progress stalls or scope expands unexpectedly.
_Avoid_: Infinite retry, model retry

**Trusted Extension**:
A Pi Extension whose canonical local path and SHA-256 content digest the user has explicitly authorized to execute for one project. Project trust, Skill trust, and MCP enablement do not implicitly confer Extension trust; content changes require a new approval.
_Avoid_: Discovered extension, installed Skill, enabled MCP

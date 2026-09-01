# Pi-only Agent Runtime

## Status

Accepted — 2026-08-05. Supersedes ADR 0001.

Amended — 2026-08-27. Domi-managed project instructions moved from `CLAUDE.md` to the model-neutral `AGENTS.md`; `.claude/memory` remains unchanged.

## Context

Domi previously carried two Agent execution paths: Pi Agent SDK and Claude Agent SDK. Pi had become the only path receiving Session Target, Execution Policy, Workflow, Automation, Collaboration, Planning, MCP, Managed Web, Extension Trust, Session Tree, queueing, and audit capabilities. The retained Claude runtime added a large native binary, packaging cost, runtime selectors, duplicated tool wrappers, and branching across persistence, IPC, renderer, bridges, and tests.

The current production and development metadata contain only Pi sessions and no persisted Automations requiring runtime migration. Anthropic and Claude models remain available through the Provider layer. Domi keeps a managed `AGENTS.md` instruction file and `.claude/memory` knowledge files, plus read-only compatibility with external `~/.claude/skills`. A legacy managed `CLAUDE.md` is migration input rather than the primary instruction file.

## Decision

Domi uses Pi as its only Agent execution runtime.

- New sessions, Automations, bridges, collaboration children, and worktree handoffs always execute through `PiAgentAdapter`.
- Runtime selectors and persisted runtime fields are removed. Session index v2 marks completed Pi-only migration: pre-cut indexes normally require explicit `agentRuntime: "pi"` before the field is deleted. A local v1 index produced by an interrupted Pi-only migration may recover a missing runtime only when both typed Pi Execution Controls (`executionPolicy` and `workflow`) are present and valid; ambiguous missing values and every explicit non-Pi value remain rejected. Imported backups and Automation migration keep the stricter fail-closed rule.
- Claude adapter, runtime router, Claude-specific MCP wrappers, native process cleanup, SDK dependencies, platform packages, lockfile entries, runtime sync roots, esbuild externals, and packaging rules are removed.
- Feishu group history and Nano Banana are exposed through runtime-neutral business functions wrapped as Pi custom tools.
- Anthropic / Claude model providers, model identities, logos, and Chat support remain.
- Domi-managed `AGENTS.md` is the writable project-instruction store; `.claude/memory` remains the writable Auto Memory store. A legacy managed `CLAUDE.md` is migrated only when safe, while conflicts and invalid files are preserved. External Claude global Skills remain a read-only compatibility source.
- Existing internal protocol names such as `SDKMessage`, `sdkSessionId`, JSONL envelopes, and `@domi/*` are not renamed as part of this change.

## Consequences

- There is one execution, permission, tool, and Session Target model to develop and test.
- Windows packaged runtime size drops by the removed Claude runtime closure; the packaged tree must contain no `claude-agent-sdk*` or `claude.exe`.
- Old backups containing non-Pi Agent runtime metadata are incompatible and must fail explicitly rather than silently resume with the wrong SDK. Local startup additionally recognizes the narrow interrupted-migration marker above so a partially upgraded Pi index cannot crash the entire application.
- Pi's transitive `@anthropic-ai/sdk` is allowed because it supports Anthropic providers; the acceptance criterion is removal of Claude Agent SDK runtime packages, not removal of every Anthropic package.

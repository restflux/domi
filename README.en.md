# Domi

Domi is a local-first Personal Coding Workbench. It brings multi-model Chat, executable Work sessions, project files, terminals, an in-app browser, Skills, MCP, Automation, tasks, and calendars into one Electron desktop application.

> Domi is under active development, with its first public version line starting at **0.20.0**. Source builds are currently the primary distribution path. The project does not provide automatic installation or updates and does not connect to another product's release channel.

[中文 README](./README.md) · [User Guide](./tutorial/tutorial-v2.md) · [Engineering Docs](./docs/README.md) · [Contributing](./CONTRIBUTING.md)

![A Domi Work session edits code in an isolated Worktree while showing the live Diff](./docs/images/readme/work-session.webp)

<p align="center"><sub>A Work session keeps running in an isolated Worktree while file changes and Diffs remain visible.</sub></p>

## Core capabilities

- **Coding-focused Work sessions**: the Pi Agent Runtime can investigate code, edit files, run tests, start services, and complete multi-step tasks.
- **Research and Execute workflows**: Research keeps the project read-only and may request Execute Once; Execute modifies and validates directly.
- **Isolated Worktree delivery**: each session can use Local or a Domi-managed Isolated Checkout, with Checkpoints, Preview, acceptance commits, provably safe withdrawal, recovery, and handoff.
- **Lightweight Git workflow**: inspect status and diffs, stage or unstage, commit, sync, switch branches, and browse recent history from the changes panel.
- **Integrated coding workspace**: multi-instance Right Workspace tabs host file previews, Scratch Pad, visible PTYs, Agent Runs, detected service URLs, and the in-app browser.
- **Long-task continuity**: background sessions, live Steering, Follow-up queues, native Pi context compaction, session handoff, and Collaboration child sessions.
- **Multi-model Chat**: Anthropic, OpenAI, Google, DeepSeek, Kimi, Zhipu, MiniMax, Doubao, Qwen, and custom compatible endpoints.
- **Local-first extensibility**: conversations, configuration, Skills, MCP, audit, Automation, and Planning remain local, with custom Chat HTTP tools and Feishu integration.

## Quick start

### Requirements

- [Bun](https://bun.sh/)
- Git
- An Electron build environment for your platform

Windows is the required CI platform. Linux runs type checks, while macOS is covered by a manual compatibility job.

### Run from source

```bash
bun install --frozen-lockfile
bun run dev
```

To run the development processes separately:

```bash
cd apps/electron
bun run dev:vite
# In another terminal
bun run dev:electron
```

### Build and test

```bash
bun test
bun run typecheck
bun run electron:build
```

Build a local Windows verification package:

```bash
cd apps/electron
bun run dist:win:fast
```

`dist:win:fast` creates an unsigned local verification build. Signed or public distribution must explicitly use the release channel. See the [engineering documentation](./docs/README.md).

## Coding-focused Work workflow

### Research and Execute

The UI exposes two persistent workflows. Both run with the current OS user permissions; Domi does not provide an OS sandbox:

- **Research**: investigates code, documentation, and webpages through a read-only Workflow. When writes are needed, it can request Execute Once for the current run and automatically returns to Research afterward.
- **Execute**: edits the project, runs commands, and validates results directly. Writing back to Local, destructive Git, external publication, and Extension Trust remain separately confirmed host transactions.

### Isolated Worktree delivery

A Work session may use the Local Checkout directly or a Domi-managed Isolated Worktree:

- the Agent edits, tests, and starts services without overwriting unfinished Local work;
- Checkpoints retain intermediate results, while Ready for Review records the acceptance context;
- Preview projects only the task layer into Local for real-environment acceptance, then finalizes it as one commit;
- Preview withdrawal verifies that Local, the branch, and history still match the delivery snapshot and fails closed when safety cannot be proven;
- conflict preflight, recovery state, retention, bulk cleanup, and cross-session handoff are host-tracked;
- when owner and inherited sessions share a target, delivery, cleanup, and Local writes remain owner-only.

![Domi previews isolated Worktree changes into Local with options to confirm or safely withdraw](./docs/images/readme/worktree-preview.webp)

<p align="center"><sub>Task changes are Previewed into Local for acceptance before they are finalized or safely withdrawn.</sub></p>

### Git, terminal, and browser

- the changes panel provides a lightweight Git loop rather than a full Git client;
- the terminal supports multiple PTYs, shell profiles, isolation between user terminals and Agent Runs, and local service URL detection;
- the browser exposes a visible page with bounded Snapshot/ref, click, ordinary text input, scroll, and text extraction operations;
- Right Workspace keeps multiple file, Browser, Terminal, Preview, and helper tabs alive together.

### Long-task continuity

Follow-up requests can be queued without interrupting the Agent's current step. Background sessions, Steering, context compaction, and cross-session handoff keep longer tasks moving.

![Domi runs a task in an isolated Worktree while an additional request waits in the Follow-up queue](./docs/images/readme/follow-up-worktree.webp)

<p align="center"><sub>The active Worktree, live progress, and Follow-up queue remain together in one session.</sub></p>

### Security boundaries

- shell authorization uses structured analysis and fails closed when parsing is uncertain;
- Managed Web and Browser restrict private networks, credentials, redirects, and interaction surfaces, but are not a network sandbox;
- Session Target, Local Baseline, Worktree ownership, and external-impact confirmation cannot be bypassed by switching Research or Execute;
- user shells and Agent-visible terminal runs remain isolated from one another.

See [`docs/adr/`](./docs/adr/) and [`SECURITY.md`](./SECURITY.md) for architecture and threat boundaries.

## Local data

Production builds use `~/.domi/`; development builds use `~/.domi-dev/`:

```text
~/.domi/
├── channels.json
├── conversations.json
├── conversations/
├── agent-sessions.json
├── agent-sessions/
├── agent-workspaces/
├── attachments/
├── planning.db
├── settings.json
└── sdk-config/
```

- Channel credentials are encrypted with Electron `safeStorage`.
- Conversations primarily use JSON / JSONL; local planning uses `planning.db`.
- Domi never reads another product's data directory automatically. Legacy data is available only through explicit migration.
- Domi does not inject product promotion attribution into user repositories.

## Monorepo

Domi is a Bun workspace:

```text
domi/
├── apps/
│   ├── cli/            # Domi CLI and progressive session reading
│   └── electron/       # Electron Main, Preload, and Renderer
├── packages/
│   ├── core/           # Provider adapters and highlighting
│   ├── session-core/   # Canonical session parsing and export
│   ├── shared/         # Shared types, config, and IPC constants
│   └── ui/             # Shared React UI components
├── docs/adr/           # Architecture Decision Records
└── scripts/            # Build, test, and repository gates
```

Internal workspace packages use `@domi/*`. They are monorepo identities and are not a claim that packages have been published to npm.

Common commands:

```bash
bun run dev
bun run typecheck
bun test
bun run electron:build
```

Before changing code, read [`AGENTS.md`](./AGENTS.md), [`CONTEXT.md`](./CONTEXT.md), and [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Documentation

- [Domi User Guide](./tutorial/tutorial-v2.md)
- [Engineering documentation](./docs/README.md)
- [Domain language](./CONTEXT.md)
- [Architecture decisions](./docs/adr/README.md)
- [Security policy](./SECURITY.md)
- [Third-party notices](./THIRD_PARTY_NOTICES.md)

## Contributing and security

Issues and pull requests are welcome. Run the most relevant tests before submitting changes, and expand validation when shared types, root configuration, packaging, or cross-package interfaces are affected.

Do not report vulnerabilities in public issues. Follow [`SECURITY.md`](./SECURITY.md) and use GitHub Private Vulnerability Reporting.

## Origin and license

Domi evolved from [Proma](https://github.com/proma-ai/Proma) and includes substantial product, runtime, and security-boundary changes. Copyright remains with the respective upstream and later contributors. See [`NOTICE`](./NOTICE) and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for attribution.

This project is licensed under the [GNU Affero General Public License v3.0](./LICENSE). Use, modification, distribution, and network deployment of modified versions are subject to the corresponding-source obligations of AGPL-3.0.

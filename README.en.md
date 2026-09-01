# Domi

Domi is a local-first Personal Coding Workbench. It brings multi-model Chat, executable Work sessions, project files, terminals, an in-app browser, Skills, MCP, Automation, tasks, and calendars into one Electron desktop application.

> Domi is under active development. Source builds are currently the primary distribution path. The project does not provide automatic installation or updates and does not connect to another product's release channel.

[中文 README](./README.md) · [User Guide](./tutorial/tutorial-v2.md) · [Engineering Docs](./docs/README.md) · [Contributing](./CONTRIBUTING.md)

## Core capabilities

- **Multi-model Chat**: Anthropic, OpenAI, Google, DeepSeek, Kimi, Zhipu, MiniMax, Doubao, Qwen, and custom compatible endpoints.
- **Work sessions**: powered by the Pi Agent Runtime to inspect and modify projects, run tests, use tools, and complete multi-step work.
- **Execution controls**: Execution Policy and Workflow are independent; permission strength, Plan First, and Session Target never elevate one another implicitly.
- **Integrated workspace**: file tree, diffs, Preview, Scratch Pad, terminal, and browser live in one desktop window.
- **Local-first storage**: conversations, configuration, Skills, MCP, audit records, and most state remain on the local machine; tasks and calendars use local SQLite.
- **Extensibility**: workspace Skills, MCP servers, custom Chat HTTP tools, Automation, Collaboration, and Feishu integration.
- **Concurrent sessions**: global event listeners and session-scoped state allow background Work sessions to keep running.

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

## Work security model

Domi separates what may be executed from how work proceeds:

- **Execution Policy**: Controlled, Autonomous, or Full Access.
- **Workflow**: Direct or Plan First; restricted preparation allows only proven reads and bounded host-managed capabilities.
- **Session Target**: a Local Checkout or a Domi-managed Isolated Checkout.

Important boundaries:

- Full Access runs with the current OS user permissions; it is not an OS sandbox.
- Approving a plan changes Workflow only and never elevates Execution Policy.
- Writing an Isolated Checkout back to Local, destructive Git, external publication, and Extension Trust remain host-controlled transactions.
- Shell decisions use structured analysis and fail closed when parsing is uncertain.
- Browser and Managed Web controls restrict private networks, credentials, redirects, and interaction surfaces, but they are not a network sandbox.
- User shells and Agent-visible terminal runs remain isolated from one another.

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

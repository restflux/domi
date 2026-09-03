# Domi

[![Built on Pi Agent Runtime](https://img.shields.io/badge/Agent_Runtime-Pi-7C3AED)](https://github.com/earendil-works/pi)

Domi is a desktop workbench built on the open-source [Pi](https://github.com/earendil-works/pi) project. It brings an AI coding agent, project files, a terminal, Git, an in-app browser, tasks, and calendars into one application, so you do not have to keep switching between tools. Pi powers the agent in Work sessions, while Domi provides the desktop interface, project management, safety controls, and the complete flow from editing code to saving approved changes.

> Domi is under active development, with its first public version line starting at **0.20.0**. Windows and Linux prerelease installers are distributed through GitHub Releases. The project does not provide automatic installation or updates and does not connect to another product's release channel.

[中文 README](./README.md) · [User Guide](./tutorial/tutorial-v2.md) · [Engineering Docs](./docs/README.md) · [Contributing](./CONTRIBUTING.md)

![Domi edits code in a separate task copy and shows the changes on the right](./docs/images/readme/work-session.webp)

<p align="center"><sub>The agent can keep working while you review every file it changes.</sub></p>

## Core capabilities

- **A coding agent powered by Pi**: [Pi](https://github.com/earendil-works/pi) can read a project, edit code, run tests, start services, and complete multi-step tasks.
- **Research first or execute directly**: Research only inspects the project and asks before editing; Execute can make and validate changes immediately.
- **Make changes without disturbing current work**: create a separate Git Worktree for a task, review and try the result, then decide whether to save it back to the original project.
- **Common Git actions built in**: review changes, stage, commit, sync, switch branches, and browse recent history.
- **One desktop workspace**: keep files, notes, terminals, running services, and the browser open together and switch between them quickly.
- **Keep long tasks moving**: tasks can run in the background, accept additional requests while running, and pass their context to a new session when needed.
- **Use your preferred model**: connect Anthropic, OpenAI, Google, DeepSeek, Kimi, Zhipu, MiniMax, Doubao, Qwen, or a compatible endpoint.
- **Keep data on your machine**: sessions, settings, extensions, automations, tasks, and calendars are stored locally by default, with support for MCP, custom Chat HTTP tools, and Feishu.

## Quick start

### Requirements

- [Bun](https://bun.sh/)
- Git
- An Electron build environment for your platform

Windows is the required CI platform. Linux release packages are built and launch-tested in GitHub Actions, while macOS is covered by a manual compatibility job.

### Download prerelease packages

Download the current prerelease from [GitHub Releases](https://github.com/restflux/domi/releases):

- **Windows x64:** download `Domi-<version>-windows-x64-setup.exe`. The installer is currently unsigned, so Windows SmartScreen may display a “Windows protected your PC” warning. Verify the Release source and `SHA256SUMS.txt` before deciding whether to run it.
- **Linux x64 AppImage:** download `Domi-<version>-linux-x64.AppImage`, make it executable, then run it: `chmod +x Domi-*.AppImage`.
- **Linux x64 Debian/Ubuntu:** download `Domi-<version>-linux-x64.deb` and install it with your system installer or `sudo apt install ./Domi-*.deb`.
- **macOS:** no prebuilt package is published until it can be tested on real Mac hardware; build from source for now.

Domi does not include automatic updates. Return to Releases for upgrades and verify downloaded assets against the included `SHA256SUMS.txt`.

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

Build local Windows verification and release-candidate packages:

```bash
cd apps/electron
bun run dist:win:fast      # fast local verification
bun run dist:win:unsigned  # unsigned prerelease with normal compression
bun run dist:win:release   # signed release after code-signing setup
```

`dist:win:fast` is for local verification only. Public unsigned installers must use `dist:win:unsigned` and be clearly marked as prereleases. See the [release documentation](./docs/releasing.md).

## Use Domi for coding tasks

### Research first or execute directly

Domi offers two ways to work. Both use the permissions of your current OS user and are not the same as running inside an operating-system sandbox:

- **Research**: reads code, documentation, and webpages without changing the project. If an edit becomes necessary, Domi asks for approval and returns to read-only mode when the task ends.
- **Execute**: edits the project, runs commands, and checks the result directly. Sensitive actions such as writing back to the original project, destructive Git operations, external publishing, or enabling extensions still require separate confirmation.

### Make changes without disturbing local code

A Work session can operate directly in the current project or create a separate task copy using Git Worktree:

- the agent can edit, test, and start services in the separate copy without overwriting unfinished local changes;
- progress can be saved at important stages so interrupted work can continue;
- when the task is ready, all changes are shown together for review;
- you can temporarily try the changes in the original project, save them as one commit when satisfied, or safely withdraw them;
- Domi handles conflict checks, task recovery, and cleanup of task copies.

![Domi lets you try changes from a separate task copy in the original project before saving or withdrawing them](./docs/images/readme/worktree-preview.webp)

<p align="center"><sub>Try the changes in the original project first, then save them when everything looks right.</sub></p>

### Git, terminal, and browser

- review file changes and perform common Git actions such as staging, committing, syncing, and switching branches;
- run multiple commands in the built-in terminal and open detected local development services;
- let the agent click, type, scroll, and read content in a browser page you can see, within a limited interaction scope;
- keep files, browser pages, terminals, and other tools open together in the right workspace.

### Continue long tasks

You can add more requests while the agent is working. New requests wait their turn instead of interrupting the current step. Tasks can run in the background, and when a task becomes too long or needs to move to another project, Domi can summarize the existing context for a new session to continue.

![Domi continues a task while accepting additional requests](./docs/images/readme/follow-up-worktree.webp)

<p align="center"><sub>The task keeps running, and additional requests are handled in order.</sub></p>

### Safety notes

- Domi checks the structure of commands before running them and blocks execution when it cannot determine that they are safe;
- web access limits private networks, credentials, redirects, and what the agent may interact with, but it is not a complete network sandbox;
- sensitive actions such as writing back to the original project, destructive Git operations, and external publishing cannot bypass confirmation;
- terminals opened by you remain separate from terminals used by the agent.

See [`docs/adr/`](./docs/adr/) and [`SECURITY.md`](./SECURITY.md) for full architecture and security details.

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

Domi uses the open-source [Pi](https://github.com/earendil-works/pi) project to power its AI coding agent, then adds the desktop experience, project management, safety controls, and change-delivery workflow around it.

Domi evolved from [Proma](https://github.com/proma-ai/Proma) and includes substantial product, runtime, and security-boundary changes. Copyright remains with the respective upstream and later contributors. See [`NOTICE`](./NOTICE) and [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for attribution.

This project is licensed under the [GNU Affero General Public License v3.0](./LICENSE). Use, modification, distribution, and network deployment of modified versions are subject to the corresponding-source obligations of AGPL-3.0.

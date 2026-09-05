# Third-Party Notices

Domi is distributed under AGPL-3.0. This file records third-party material that is copied into the repository, patched locally, bundled into the desktop application, or otherwise needs a visible attribution beyond the dependency metadata in `package.json` and `bun.lock`.

This list is a distribution notice, not a replacement for the complete license text shipped by each dependency. Package versions are fixed by `bun.lock`; when a version changes, verify its license again.

## Upstream application source

### Proma

- Source: https://github.com/proma-ai/Proma
- License: GNU Affero General Public License v3.0
- Use in Domi: Domi evolved from Proma and retains portions of its Electron application. Current workspace packages use `@domi/*`; only explicit legacy import and provider wire-compatibility paths retain historical identifiers.
- Copyright: retained upstream notices remain attributable to their respective authors, including Erlich Liu and Proma contributors.

Domi's root [`LICENSE`](./LICENSE) contains the AGPL-3.0 terms.

## Patched runtime dependencies

### Pi Agent Runtime

- Source: https://github.com/earendil-works/pi
- Packages: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`
- License: MIT
- Copyright: © 2025 Mario Zechner and contributors
- Local modifications: `patches/@earendil-works%2Fpi-*.patch`
- License copy: `third-party-licenses/MIT-Pi.txt`

### node-pty

- Source: https://github.com/microsoft/node-pty
- License: MIT
- Copyright notices: Christopher Jeffrey, Daniel Imms, Microsoft Corporation and contributors
- Local modification: `patches/node-pty@1.1.0.patch`
- Bundled third-party component: winpty, MIT, © Ryan Prichard and contributors
- License copy: `third-party-licenses/MIT-node-pty.txt`

## Model and provider brand icons

### LobeHub Icons

- Package: `@lobehub/icons-static-svg@1.94.0` (build-time dependency; only imported SVGs are bundled)
- Source: https://github.com/lobehub/lobe-icons
- Package source revision: `fbd2d56e3f734e889f1373e71c8368cc4e60e0d7`
- License: MIT, as declared by the package manifest and bundled README
- Copyright: © 2023 LobeHub, as stated in the bundled README
- License text: `third-party-licenses/MIT-LobeHub-icons.txt`
- Usage: model and channel brand SVGs in `apps/electron/src/renderer/lib/model-logo.ts`; SVG artwork is unmodified, monochrome icons are inverted in dark mode.
- Brand names and logos remain trademarks of their respective owners; the MIT code license does not grant trademark rights or imply endorsement.
- The default Domi mark and existing composite Gemini / generic embedding icons retain their existing provenance; they are not LobeHub assets.

## Bundled default Skills

### Guizang PPT Skill

- Source: https://github.com/op7418/guizang-ppt-skill
- Bundled path: `apps/electron/default-skills/guizang-ppt-skill/`
- License of the imported snapshot: MIT
- Copyright: © 2026 op7418 (歸藏)
- Complete imported license: `apps/electron/default-skills/guizang-ppt-skill/LICENSE`

The Skill also vendors `assets/motion.min.js` from Motion 11.11.17:

- Source: https://github.com/motiondivision/motionone
- License: MIT
- Copyright: © 2018 Framer B.V.
- License copy: `third-party-licenses/MIT-Motion.txt`

### Skill Creator

- Source: https://github.com/anthropics/skills/tree/main/skills/skill-creator
- Bundled path: `apps/electron/default-skills/skill-creator/`
- License: Apache License 2.0
- Complete imported license: `apps/electron/default-skills/skill-creator/LICENSE.txt`

### Matt Pocock Skills adaptations

- Source: https://github.com/mattpocock/skills
- License: MIT
- Copyright: © 2026 Matt Pocock
- Adapted paths:
  - `apps/electron/default-skills/code-review/SKILL.md`
  - `apps/electron/default-skills/diagnosing-bugs/SKILL.md`
  - `apps/electron/default-skills/improve-codebase-architecture/SKILL.md`
  - `apps/electron/default-skills/tdd/SKILL.md`
- License copy: `third-party-licenses/MIT-Matt-Pocock-Skills.txt`

The remaining bundled default Skills are maintained as part of Domi and are covered by the repository AGPL-3.0 license unless a Skill directory contains its own license file.

## User-interface assets

### Lobe Icons

- Source: https://github.com/lobehub/lobe-icons
- License: MIT
- Copyright: © 2023 LobeHub
- Use in Domi: AI/provider/model brand icon assets under `apps/electron/src/renderer/assets/models/`.
- License copy: `third-party-licenses/MIT-Lobe-Icons.txt`

Provider names, logos and other brand marks remain trademarks of their respective owners. Their inclusion identifies interoperable services and does not imply endorsement.

### Inter

- Source package: `@fontsource-variable/inter`
- Source: https://github.com/fontsource/font-files
- License: SIL Open Font License 1.1
- Use in Domi: bundled renderer font files.
- License copy: `third-party-licenses/OFL-1.1-Inter.txt`

Domi logos and generated theme preview images are project assets distributed under AGPL-3.0.

## Notable bundled runtime libraries

The desktop package also contains the following runtime components. Their package license files remain in the synchronized runtime dependency tree unless the package's own build layout embeds the notice elsewhere.

| Component | License | Source |
| --- | --- | --- |
| Electron | MIT; bundled Chromium third-party notices | https://github.com/electron/electron |
| DOMPurify | Apache-2.0 or MPL-2.0 | https://github.com/cure53/DOMPurify |
| PDF.js (`pdfjs-dist`) | Apache-2.0 | https://github.com/mozilla/pdf.js |
| Beautiful Mermaid | MIT | https://github.com/lukilabs/beautiful-mermaid |
| ELK / `elkjs` | EPL-2.0 | https://github.com/kieler/elkjs |
| khroma | MIT | https://github.com/fabiospampinato/khroma |
| Mermaid | MIT | https://github.com/mermaid-js/mermaid |
| Shiki | MIT | https://github.com/shikijs/shiki |
| sharp | Apache-2.0 | https://github.com/lovell/sharp |
| libvips 8.18.3 DLLs distributed through `@img/sharp-win32-x64` | LGPL-3.0-or-later | https://github.com/libvips/libvips |

| xterm.js / `@xterm/*` | MIT | https://github.com/xtermjs/xterm.js |

Build-time-only datasets and tools are not copied into Domi's application package unless referenced by a bundled artifact. For example, `caniuse-lite` is CC-BY-4.0 build data used through the frontend toolchain.

Repository-maintained copies of the licenses required for vendored or bundled material are under `third-party-licenses/`. Electron and synchronized npm runtime dependencies additionally retain the license files shipped by those projects.

## Maintenance

Before adding a vendored file, default Skill, native binary, font, icon collection or copied source module:

1. record its source URL and exact license;
2. preserve its copyright and license file when required;
3. add or update this notice;
4. verify that commercial redistribution and modification are permitted;
5. do not copy material with an unknown, non-commercial or source-available-only license.

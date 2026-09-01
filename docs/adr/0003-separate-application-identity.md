# Give Domi a separate application identity

## Status

Accepted.

## Context

Domi evolved from Proma but must coexist with upstream installations without sharing mutable application state or update channels. Renaming every internal protocol identifier would create compatibility risk without improving user-visible separation.

## Decision

Domi uses its own product name, application identifier, Chromium `userData` directory, configuration roots (`~/.domi/` and `~/.domi-dev/`), CLI name and export extensions. It does not connect to Proma's official updater or release channel and never reads or writes `~/.proma/` automatically.

Legacy Proma backups may be imported only through an explicit migration flow. Internal `@domi/*` package names, IPC/protocol identifiers and explicitly supported legacy file formats remain unchanged where renaming would break compatibility or increase upstream-integration cost.

## Consequences

- Domi and Proma can be installed on the same machine without sharing a writable profile.
- Updates and data migrations are explicit rather than inherited from upstream.
- Contributors must distinguish user-visible branding from internal compatibility names.

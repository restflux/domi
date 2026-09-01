# Require explicit trust for Pi Extensions

## Status

Accepted.

## Context

Pi Extensions execute local code with the Domi process's current-user privileges. Automatic discovery, project trust, Skill trust and MCP enablement are therefore insufficient authorization to evaluate an external extension module.

## Decision

Built-in inline extensions remain available. External Pi Extensions require an explicit per-project approval bound to their canonical local path and SHA-256 content digest. Directory candidates hash their recursive contents; changed content, missing or invalid paths and a corrupt trust store fail closed before the path is offered to Pi's ResourceLoader.

The current product supports only user-selected local files or directories. It does not automatically install npm/git packages or provide an extension marketplace.

## Consequences

- Project, Skill and MCP trust cannot implicitly authorize local code execution.
- Content changes invalidate the previous approval.
- The trust check reduces accidental execution but is not an OS sandbox and cannot eliminate every same-user check/use race.

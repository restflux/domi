# Use bounded session capability grants for ordinary Git push

## Status

Partially superseded by ADR 0011. The bounded host capability remains available for an explicitly requested ordinary push, while generic Full Access Bash follows ADR 0011's trust semantics.

Domi keeps Execution Policy separate from Workflow and retains host-owned hard gates for Local Baseline changes and external side effects. Requiring a blocking approval for every destructive Git command and every `git push`, however, made `Full Access + owner Isolated Checkout` unsuitable for uninterrupted work: restoring a generated file interrupted the run, and a user-requested push often blocked only after a long task had finished.

We distinguish two classes of operation.

1. **Internal managed Worktree operations**: under Full Access, a host Bash tool owned by the current Isolated Checkout may run destructive Git operations without approval. The execution controller has already fixed the Session Target and prevents Bash from switching cwd, git-dir, work-tree, or writing the real Local Checkout. Local and inherited checkouts retain the existing hard gate.
2. **Ordinary push to the source branch**: a user may explicitly grant the current session one narrow capability before long work begins. The grant is bound to session ID, checkout ID, canonical repository root, configured remote name, SHA-256 of the unique remote push URL, and the source branch ref. The Agent must consume it through the host-owned `GitPushWithSessionTrust` product tool; generic Bash `git push` continues to require single approval. The host runner fixes the Git argv, disables hooks, follow-tags and configured push options, and supplies exactly one `HEAD:<source-branch>` refspec.

The grant is process-local and revocable. It expires on application restart, session deletion, checkout/source/remote changes, or downgrade from Full Access. Renderer receives only a credential-safe view and may revoke by `grantId`; it cannot create or widen a grant. Every automatic use is recorded as a session-scoped policy decision without logging complete commands, absolute Worktree paths, or remote URLs.

The following remain single-use approvals and cannot use this grant: Bash push, force/force-with-lease, delete, mirror, all/tags/follow-tags, multiple refspecs, explicit URL remotes, Local writeback, Local Maintenance, release, package publish, deploy/infrastructure operations, Extension Trust, and third-party data transmission. Remotes with multiple push URLs, mirror mode, or custom receive-pack are not eligible. Automation, delegation, inherited Worktrees, Local Checkout, Controlled, and Autonomous do not create or consume an interactive ordinary-push grant.

This decision narrows the blanket statements in ADR 0005 and the initial execution-control plan that every destructive Git operation and every push must always receive a single approval. Local Baseline and broad external-impact protections remain unchanged.

A residual check/use race remains between revalidating Git configuration and the host Git process resolving the remote. Domi does not claim OS-level isolation against another process running as the same Windows user. Any mismatch observed before execution fails closed and revokes the stale grant.

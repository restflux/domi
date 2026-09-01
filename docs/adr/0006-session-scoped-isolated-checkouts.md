# Use session-scoped isolated checkouts with unstaged Apply

## Status

Accepted.

A coding session explicitly targets either the user's Local Checkout or one Domi-managed Isolated Checkout based on the Local `HEAD`. Isolated changes remain separate until the user applies them into the current Local Checkout as uncommitted changes or discards them; this favors safe parallel work and user-owned commit history over automatic branches, commits, or pull requests.

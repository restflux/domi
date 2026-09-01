# Use Canonical Shell Analysis and explicit Full Access trust

## Status

Accepted.

Domi previously classified one Bash source string several times. Workflow used a quote-aware reader, while Execution Policy and Session Target guards also split the original string with regular expressions. The same quoted text could therefore be proven literal by Workflow and later reinterpreted as executable syntax. A grep pattern containing `git restore` and an escaped `|` was incorrectly classified as destructive Git and opened a permission request under Full Access.

Domi now parses Shell input through one **Canonical Shell Analysis** module. Bash is backed by `unbash`; nested `powershell.exe -Command` source is parsed by the MIT `tree-sitter-powershell` grammar through `web-tree-sitter` rather than being reinterpreted as Bash. The module returns executable stages with static argv, environment assignments, redirects, source ranges, provenance, dialect, control operators and bounded nested wrapper/substitution analysis. Its result is `static`, `opaque`, or `invalid` with stable reason codes.

The following invariant is mandatory:

> Once Canonical Shell Analysis identifies source text as a literal argv value, no downstream policy may reinterpret that text as an executable stage.

Workflow, Execution Policy, Session Target guards, Git/network/deletion/path classification and read-only command hardening consume this analysis. Security-positive decisions require a complete static analysis. Partial ASTs retain explicitly proven executable facts for host hard gates, but they cannot prove an operation safe. When no executable fact can be established, Domi reports an opaque or invalid Shell analysis instead of inventing a specific category from keywords or literal argv text.

Full Access adopts the same trust meaning as Claude Code `bypassPermissions`. It remains an explicit, warned, unsandboxed selection and Plan approval never enables or elevates it. Generic Execution Policy facts—including sensitive or control-looking path names, Workspace Boundary crossings, Local Baseline evidence, dynamic deletion, destructive Git, external impact, process network access, interpreters, opaque Shell structure and parser failure—do not open approval UI under Full Access. The analysis is retained for audit and for host guards that identify Domi-owned lifecycle structure; failure to prove a command safe is not itself a Full Access denial or prompt.

Full Access does not change Workflow and does not bypass host-owned lifecycle transactions. An Isolated Checkout still cannot explicitly write the real Local Checkout through ordinary file or Shell tools; Apply, Finish and Local Maintenance remain snapshot-bound product confirmations. Inherited targets cannot perform destructive Git because ownership cannot be granted by a generic approval. Commands cannot redirect cwd, `git-dir` or `work-tree` outside the fixed managed target, and a session workbench cannot contain a non-Domi-managed Git worktree. Extension Trust remains a pre-evaluation trust boundary. These checks are implemented from canonical target identity, ownership and transaction state rather than path basename or directory-name heuristics.

PowerShell variable evaluation remains deliberately bounded for Canonical Analysis and Controlled/Autonomous decisions. Sequential fixed-string assignment and `Join-Path` may expose concrete targets; unknown variables, runtime expressions and parser gaps remain opaque in those modes. Under Full Access these facts are audit-only unless they expose an explicit Domi lifecycle boundary such as a known Local Checkout target or a workbench-contained `git worktree add` destination.

Read Only and Plan First treat productive inspection as a first-class path rather than forcing every query into one primitive command. Canonical Bash analysis may authorize finite pure-stdout pipelines when every stage belongs to the bounded read subset. That subset includes stdout-only `sed` selection/substitution and inline `awk` filtering or aggregation; Domi injects GNU sed/awk `--sandbox` before execution so command execution, file redirection and extension loading remain disabled. Canonical PowerShell analysis may mark a complete `-NoProfile -Command` source read-only when its AST contains only approved read cmdlets and expression-only `Where-Object` / `ForEach-Object` blocks; Domi also injects `-NonInteractive`. Parser gaps, arbitrary method invocation, process launch, external scripts, writes and ordinary file redirection still fail closed. When a Shell read is rejected, the Agent is directed to use built-in Read/Grep/Find/LS or split the query instead of retrying across interpreters.

The previous ordinary-push session grant tools are no longer exposed to new Agent runs. Their process-local implementation and IPC representation may remain temporarily for compatibility, but they are not required for Full Access and cannot widen it.

This decision supersedes ADR 0015 wherever that earlier decision requires generic Bash push, publish or deploy to receive approval under Full Access. ADR 0015 remains the historical and implementation record for the narrower host-owned ordinary-push capability.

Full Access has no OS or network sandbox. Static Shell analysis cannot intercept side effects hidden inside arbitrary scripts or executables, and Domi no longer claims that it does. Controlled and Autonomous continue to fail closed on unknown Shell structure and known external/process effects.

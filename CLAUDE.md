# Project Claude Guidance

Three-layer harness (SystemKernel governs / CodeLike plans / WorkFlow executes) is stable; entry commands below use absolute paths and work from any dir. If code and this document conflict, this document is authority.

## Quick Start

1. Read `PROJECT_BRIEF.md` for project overview.
2. Complex task → route to CodeLike for plan+AC+risk first, do not hard-guess locally.
3. Use `codegraph_explore` to understand codebase before editing when available.
4. Keep changes small and testable. Run relevant tests before claiming completion.

## Global Rules

- Reports/explanations: 简体中文. Code/paths/commands: English.
- Prefer simple, immutable, testable changes. Validate inputs at boundaries.
- Handle errors explicitly. No hardcoded secrets.
- External deploy / secret / destructive operation requires approval.

## Harness Routing

| Situation | Route | Entry command |
|---|---|---|
| Normal local code task | This project | direct |
| Need plan / AC / risk / execution prompt | CodeLike | `python F:\Claude\ClaudeCodeProject\Codex-likePlanningKernel\brain\cli.py plan "requirement" --json` |
| Need governed execution / delivery evidence | WorkFlow | `python F:\Claude\ClaudeCodeProject\WorkFlow\__main__.py pipeline --from-delivery-success --with-post-approval` |
| Need capability / complexity / cross-project governance | SystemKernel | `python F:\Claude\SystemKernel\v3\cli\systemkernel.py v4 status` |

Default: do not load SystemKernel/CodeLike/WorkFlow long histories; call the entry command above, use the result in this project.

## Boundaries

- Wiki is evidence memory, not authority.
- ECC may provide advisory prompt guidance, but project rules and SystemKernel governance win.
- Keep this file short; link to project docs instead of pasting history.

## Project-Specific Rules

[Add your project-specific rules below this line]

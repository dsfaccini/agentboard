# AGENTS.md

- Bun 1.x, TypeScript 5.x, React 18, Hono, xterm.js, Zustand, Tailwind.
- This is a **fork** of `gbasin/agentboard`. Read [FORK.md](./FORK.md) before
  syncing with upstream, evaluating an upstream change, or touching tmux/pty
  lifecycle code — it lists what's ours (preserve it), the sync verdicts, and the
  pty-leak watch-list from the 2026-06-16 incident.

## Commands

```
bun run dev        # frontend + backend
bun run build      # production build
bun run lint       # oxlint
bun run typecheck  # tsc --noEmit
bun run test       # unit tests
```

Run `bun run lint && bun run typecheck && bun run test` after changes.

Always test via **`bun run test`**, not `bun test <file>` directly: the runner
sets `NO_PROXY` for loopback so integration tests can reach their spawned
localhost servers. Run directly and `waitForHealth` hangs under David's `sfw`
package-manager proxy (see FORK.md → How we work).

## How It Works

- Single tmux session (default: `agentboard`) with one window per project
- Backend discovers windows, streams terminal output via WebSocket
- Parses Claude/Codex JSONL logs from `~/.claude/projects/` and `~/.codex/sessions/` for status
- Status: unknown -> working -> waiting (derived from log events)

## Structure

- src/server/     Hono backend, WebSocket, tmux/pty management, log parsing
  - `src/server/SessionManager.ts` - tmux window discovery, log parsing, status detection
  - `src/server/index.ts` - Hono routes, WebSocket handling
- src/client/     React frontend, xterm.js terminal, Zustand stores
  - `src/client/App.tsx` - main UI, keyboard shortcuts
  - `src/client/components/Terminal.tsx` - xterm.js wrapper
- src/shared/     Shared types

- Data directory: `~/.agentboard/` contains `agentboard.db` (session data) and `agentboard.log`

## Git

- **Commit straight to `master`. No PRs in our fork** — David merges everything
  onto our own `master` (this overrides the default "branch first on the default
  branch"). Use a short-lived branch only to stage a risky multi-commit change,
  then fast-forward `master` and delete the branch.
- Check `git status`/`git diff` before commits
- Atomic commits; push only when asked
- Never destructive ops (`reset --hard`, `force push`) without explicit consent
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Commit early and often — make small, incremental commits as you work rather than one large commit at the end.

## Critical Thinking

- Read more code when stuck
- Document unexpected behavior
- Call out conflicts between instructions

## Engineering

- Small files (<500 LOC), descriptive paths, current header comments
- Fix root causes, not symptoms
- Simplicity > cleverness (even if it means bigger refactors)
- Aim for 100% test coverage

## UI Testing

- Use the `dev-browser` skill for testing web UI changes. Headless browser
automation with Playwright. Start server, take screenshots, verify DOM state.

# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

### PM2 (this machine)

Served by PM2 process `pi-web`; ecosystem file `/Users/sam/.pm2/ecosystem.config.cjs` (`cwd` this repo, `script` `bin/pi-web.js`). Code changes need a production build and restart:

```bash
npm run build
pm2 restart pi-web
```

### Dev server troubleshooting

- Reuse a healthy listener on 30141 (`lsof -nP -iTCP:30141 -sTCP:LISTEN`). A second `next dev` cannot switch ports — both fight `.next/dev/lock`.
- Browser `Module ... factory is not available` is usually a stale Turbopack/HMR tab. Reload first; restart only if a fresh page *and* server-side checks fail. Stop the exact process, move `.next` to a `mktemp -d` backup, then `npm run dev`.
- Do not use `next dev --webpack` (`undici` / `node:console` breaks). Dev is Turbopack.
- `next dev` may append a generated `BEGIN:nextjs-agent-rules` block to this file — leave it out of unrelated commits.

---

## Architecture

Session browsing is read-only (SDK `SessionManager` + `lib/session-reader.ts`) — no `AgentSession`. Sending a message calls `startRpcSession()` in `lib/rpc-manager.ts`, which creates an in-process `AgentSession`. SSE is `GET /api/agent/[id]/events`.

Key files: `lib/rpc-manager.ts`, `lib/session-reader.ts`, `lib/normalize.ts`, `lib/path-security.ts`, `lib/worktree.ts`, `lib/model-scope.ts`, `hooks/useAgentSession.ts`.

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
One `AgentSessionWrapper` per session id in `globalThis.__piSessions` (survives hot-reload; a module `Map` does not). Idle timeout 10 minutes. Concurrent `startRpcSession()` calls share `globalThis.__piStartLocks`.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` mutates inner state in-place — after fork, `inner.sessionId` is the *new* id. Leaving the wrapper under the old id corrupts later forks/`parentSession`. `send("fork")` must capture `newSessionId` then `this.destroy()`. The next request for the original id reloads from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork on user message): new `.jsonl`, sidebar child via `parentSession`.
- **In-session branch** (Continue / BranchNavigator): `navigate_tree` in the same file. Switch with `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` is display metadata only. Safe to `writeFileSync` the whole file (used when cascade-reparenting children on delete).

### ToolCall field normalization
File format: `{type:"toolCall", id, name, arguments}`. UI type: `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` — used on file load and streaming.

### New session tool preset
`POST /api/agent/new` takes `toolNames[]`, persisted as versioned `pi-web:tool-selection`. No entry = legacy (Pi default). Empty array = Chat only: resolves before services, loads no extensions/skills/prompts/themes, replaces the base prompt with discovered context files. Crossing Chat-only rebuilds the wrapper; nonempty preset changes update in place. Subagents persist tools + skill/extension switches in `resourceSnapshot`; extensions cannot expose reserved `Agent` / `get_subagent_result` / `steer_subagent`. See `docs/adr/0002-chat-only-tool-selection.md`.

Browser `localStorage` last preset initializes *fresh* composers only. Existing sessions use live `get_tools` or Pi default.

### Model defaults / `enabledModels`
`GET /api/models` `defaultModel` comes from `~/.pi/agent/settings.json`. Explicit browser model/thinking is applied atomically at AgentSession construction; `lib/startup-preferences.ts` persists effective values without replaying `set_model`/`set_thinking_level`. Implicit `enabledModels` fallbacks and thinking pins are not persisted.

`enabledModels` uses Pi `--models` syntax (globs, fuzzy match, optional `:thinkingLevel`). Never compare as literal strings — `lib/model-scope.ts` uses SDK `resolveModelScopeWithDiagnostics()`, falling back to all models if nothing matches. `startRpcSession()` passes initial model, thinking pin, and `scopedModels` atomically.

### SSE, compaction, running state
On `ChatWindow` mount, `GET /api/agent/[id]`; if `isStreaming`, reconnect SSE and sync `thinkingLevel` / `isCompacting`. Accept both `compaction_*` and `auto_compaction_*`. Manual compact is a blocking POST.

Sidebar polls `/api/agent/running` every 2.5s while visible. `useAgentSession`: SSE is primary and opens before each prompt. `prompt_done` completes the UI stage but idle SSE stays 30s for reuse. `agent_start` cancels that timer; `agent_settled` finishes extension-injected runs with no wrapper `prompt_done`. Do **not** close on the first `agent_end` (retries/compaction/queued messages). Reconcile via periodic GET plus `visibilitychange`/`online`. Ignore late events from an old monotonic run id.

### Worktrees and project grouping
`lib/worktree.ts` maps linked worktree top-levels to main-repo `projectRoot` so the sidebar groups them. New worktrees: `<repoRoot>-worktrees/<sanitized-branch>` (`git worktree add -b` if the branch is new). Dirty remove → `409 { dirty: true }`. Sessions whose cwd was a removed worktree infer back to the main project.

Git prints POSIX paths even on Windows — run them through `toNativePath()` (`lib/paths.ts`). Compare with `samePath()`, never `===` (raw equality made `isTopLevel` always false on Windows). Branch names keep slashes. `/api/worktrees` resolves `currentWorktreePath` server-side; the sidebar must use that identity.

### File access allow-list
`/api/files` is not a general FS browser. Roots: session cwds, project roots, `~/pi-cwd-*`, plus `allowFileRoot()` (also called from cwd validate/default-cwd/worktrees). `isPathWithinRoots()` in `lib/path-security.ts` is the security boundary (re-resolve + case-fold). Keep that one implementation.

### Plugins and skills
`/api/plugins`: Pi `SettingsManager` + `DefaultPackageManager`. Disable writes empty `extensions/skills/prompts/themes` for that package. `/api/skills`: `DefaultResourceLoader` (same view as runtime). Toggle only `disable-model-invocation` on `SKILL.md`. Install: `npx skills add ... --agent pi` (project installs use selected cwd).

### Built-in subagents
`builtInEnabled` in `~/.pi/agent/agents/settings.json`, default `false`; malformed fails closed. Inline factory always present but registers no tools while disabled; user must reload the session after toggling. When enabled, only a legacy `pi-subagents` extension that registers reserved tools is removed. Runtime `Agent` dispatch re-checks the setting. See `docs/adr/0003-built-in-subagent-toggle.md`.

### Auth and model config
Provider listing is capability-driven (`lib/provider-listing.ts`), never by id — dual-auth providers (anthropic, github-copilot today; the set changes) must appear once. After any auth change, refresh *both* lists. `auth.json` holds one credential per provider; delete via `removeStoredCredentialIfType()` under Pi's file lock. OAuth/device/manual: `GET /api/auth/login/[provider]`; manual code POSTs to a short-lived `globalThis.__piLoginCallbacks` token. Status endpoints must never return the raw key. Test route is `app/api/models-config/test/route.ts` — `app/api/models/test/` does not exist.

### Completion sound / export HTML
`hooks/useAudio.ts`: `pi-sound-enabled` in `localStorage`, one `AudioContext`, unlock from a user gesture (`ChatInput`); play from `ChatWindow` `onAgentEnd`. Export patches Pi's recursive tree helpers to iterative ones so deep sessions do not overflow the stack.

---

## Pi Session File Format

`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

Entry types: `session` (header, includes `parentSession`), `model_change`, `message` (user/assistant/toolResult), `compaction`, `session_info` (user-defined name). `entryIds[]` in `SessionContext` is parallel to `messages[]` — used for fork and `navigate_tree`.

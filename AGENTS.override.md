# Local override

This file replaces `AGENTS.md` in this directory for the prompt. Still read and follow `./AGENTS.md` (architecture, file map, topic notes). This file wins where they disagree.

## Reload after code changes

This checkout is served by pm2 process `sam-pi-web` (`bin/pi-web.js` → `next start`). It does not hot-reload.

After you finish changing project code — including a rollback, revert, or checkout that puts code back — run this once before the task is done:

```bash
npm run build && pm2 restart sam-pi-web
```

That rebuilds `.next/` and loads it. Do not skip it, and do not stop at `npm run dev` or a page refresh.

- Run it once at the end of the change, not after every intermediate edit.
- It applies to source the running server loads (app, components, lib, hooks, config, public assets) and to rolling those back.
- It does not apply to agent-instruction markdown only (`AGENTS.md`, this file, `docs/agents/`).
- This overrides the "Never run `next build` during dev" note in `AGENTS.md` for this checkout.

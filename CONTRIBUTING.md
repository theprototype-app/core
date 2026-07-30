# Contributing to theprototype.app

Thanks for wanting to build on this! The project is unusually friendly to
AI-assisted contributions — the conventions below exist so that humans AND their
agents can land changes that hold up.

## Quick start

```bash
npm i --legacy-peer-deps    # three vs postprocessing peer conflict, known
npm run dev                 # https dev server on :5173
```

Open two browser windows, connect them with the peer ID, and you have a
two-peer session on your desk.

## Before you write code

1. **Read [CLAUDE.md](CLAUDE.md).** It's the architecture map, the replication
   golden rules, and a long list of hard-won gotchas. If you use Claude Code (or
   any agent), it will pick it up automatically; `static/llms.txt` carries the
   same pointers for other tools.
2. **The one rule that matters**: everything a user does must be visible to
   connected peers. Every mutation = apply locally + broadcast; receivers apply
   without re-broadcasting. `.claude/skills/peer-feature/SKILL.md` is the
   checklist for adding a replicated feature.
3. **Modules**: if your idea is self-contained play content (a game, a tool, an
   instrument), build it as a module instead of a core change — see
   [MODULES.md](MODULES.md). Modules are the easiest first contribution.

## Verifying changes

- `npm run e2e -- <suite name>` — the committed Playwright suite
  (`tests/e2e/`); every feature ships with one, and UI changes must update the
  suites they break in the same commit. `.claude/skills/e2e-verify/SKILL.md`
  documents the recipe (incl. two-peer tests).
- `npm run build` must pass and `npx svelte-check` must add **no new errors**
  over the current baseline (CI enforces this).
- VR changes: verify the math/state headlessly where possible and say clearly
  in the PR what needs an on-device check.

## PRs

- Branch off `main`; one focused change per PR.
- Commit style: `[feat]/[fix] lowercase summary` + body bullets.
- Screenshots/clips for anything visual. Playwright can capture them.
- Look at issues labeled **good first issue** if you want a scoped entry point.

## Questions

GitHub Discussions for ideas/help, issues for bugs (template asks for repro
steps — two-browser repros are gold). Please don't report security issues
publicly — see [SECURITY.md](SECURITY.md).

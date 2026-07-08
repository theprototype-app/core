---
name: e2e-verify
description: Verify theprototype.app changes end-to-end with Playwright — single-page and two-peer (PeerJS cloud) recipes, the debugStores hook, and known flakes. Use before committing any feature.
---

# E2E verification recipe for theprototype.app

## Setup

1. `npm run dev` in the background (vite on `https://localhost:5173`, mkcert TLS).
2. Playwright (chromium) from any scratch dir; always
   `browser.newContext({ ignoreHTTPSErrors: true })`.
3. **Init script for every context** (kills the blocking disclaimer toast and exposes stores):

```js
await ctx.addInitScript(() => {
  localStorage.setItem('debugStores', 'true');
  localStorage.setItem('hasSeenDisclaimer', 'true');
});
```

`debugStores` makes App.svelte publish `window.__stores` = all stores + the modules
`meshEdit`, `vrControls`, `autosave`, `voiceChat`, `annotationsHandler`. Read a store:

```js
const value = await page.evaluate(() =>
  new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children.length))()));
```

## Single-page flow

- `goto(url, { waitUntil: 'domcontentloaded' })` (NOT networkidle — peerjs sockets never idle),
  then `waitForSelector('i.fa-circle-nodes')` + ~4s for hydration (clicks before hydration
  are silently lost).
- UI anchors: hamburger `.burger button` (sidebar has Primitives/Building blocks/Lights
  dropdowns — re-expand after reopening); bottom nav icons `i.fa-list-ul` (object list `O`),
  `i.fa-circle-nodes` (flow `N`), `i.fa-message` (chat `C`); properties drawer `#sidebar6`;
  object rows `#object-list p[id]`; viewport right-click = `page.mouse.click(x, y, {button:'right'})`
  on empty canvas (e.g. 200,550) — a real click, `dispatchEvent('contextmenu')` has no coords.
- Context menus render `role="menuitem"`; group items CONTAIN their submenu text — filter
  with anchored regex `/^Exact label$/` (+ `.last()` if needed), hover the group first.
- Gizmo drags: create a cube via sidebar → gizmo center ≈ (640, 560) at default camera;
  drag the Y arrow from ≈(640, 495) up. Screenshot first when aiming.

## Two-peer flow (real replication)

Use `https://theprototype.app:5173/` — hosts-mapped to 127.0.0.1, and the `.app` hostname
makes peerjs use the **public cloud** (localhost would try ws://localhost:9001 and fail).

```js
const A = await setupPage(browser); // read own id: __stores.peers → p.peer.id
const B = await setupPage(browser); // separate browser CONTEXT per peer
await B.page.locator('input[placeholder="Enter peer ID to connect"]').fill(A.id);
await B.page.getByRole('button', { name: 'Connect', exact: true }).click();
await A.page.getByRole('button', { name: 'Approve' }).click({ timeout: 30000 });
await A.page.waitForTimeout(8000); // WebRTC channel + handshake
```

Late-joiner checks: connect a third context AFTER mutations and assert the handshake
snapshot arrived (objects/nodes/annotations). Voice tests: launch chromium with
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` (auto-grant + tone,
which trips speaking detection).

## Known flakes / traps

- First run after adding a new dependency: vite re-optimizes and reloads the page mid-test
  ("Execution context destroyed") — rerun once.
- Overlays intercept clicks: open properties drawer covers the right ~320px; toasts sit top
  center; modals block everything behind (close them before clicking approve toasts).
- HMR mid-run breaks hydration timing — don't edit sources while a test runs.
- PowerShell mangles emoji when rewriting test files — edit them with node/fs instead.

## Definition of done

Feature test green + `npm run build` passes + `npx svelte-check` adds no NEW errors
(baseline is legacy noise; check your files by grepping the output for their names).
Two-peer verification is required for anything touching replication.

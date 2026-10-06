// 36 F11 (36-fb-graphs) — EVERY GAME'S MAIN GRAPH IS TIDY, measured on the drawn cards.
//
// For each game scene: install its modules, load it, open the node editor on Main, and lint the
// cards as xyflow DREW them ($lib/graphLayout lintGraph over measured sizes + handle bounds):
// no card overlaps another, no wire passes through a card, no frame clash. Writes a 1080p shot
// of every Main graph (framed — the F10 open) in dark and light.
//
//   GAMES_DIR   folder holding <slug>/scene.tpscene or <slug>.tpscene (default: the lane staging)
//   GAMES       comma list (default: all twelve)
//   MODULES_DIR packed module zips (default: the sibling modules checkout)
//   SHOTS       where the PNGs go (default: none)   SHOT_TAG  file-name tag (e.g. before / after)
//   DUMP_MODEL  write each game's measured {boxes, wires} model there (offline layout work)
//   LINT_REPORT=1  report only (the BEFORE pass): never fails, prints every problem
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const ALL = ['mini-golf', 'football', 'dungeon-realms', 'escape-room', 'marble-maze', 'sky-run', 'target-toss', 'towers', 'waves', 'untangle', 'stars-room', 'jam-room'];
const GAMES = (process.env.GAMES || ALL.join(',')).split(',').filter(Boolean);
const DIR = process.env.GAMES_DIR || path.resolve(__dirname, '../../../cloud-lane-30-staging/36-fb-graphs/games');
const MODS =
	process.env.MODULES_DIR ||
	[path.resolve(__dirname, '../../../modules-lane-36-fb-graphs'), path.resolve(__dirname, '../../../modules')].find((d) => fs.existsSync(d));
const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'after';
const REPORT = !!process.env.LINT_REPORT;

function sceneFile(slug) {
	return [path.join(DIR, slug, 'scene.tpscene'), path.join(DIR, slug + '.tpscene')].find((p) => fs.existsSync(p));
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const table = [];
	for (const [gi, slug] of GAMES.entries()) {
		const file = sceneFile(slug);
		if (!file) {
			console.log(`SKIP ${slug}: no scene in ${DIR}`);
			continue;
		}
		for (const theme of SHOTS ? ['dark', 'light'] : ['dark']) {
			const A = await h.setupPage(browser, slug, { context: { viewport: { width: 1920, height: 1080 } }, storage: { flowDockHeight: '864', theme } });
			const p = A.page;
			const payload = await p.evaluate(async (arr) => window.__stores.sessions.readSessionZip(new Uint8Array(arr).buffer).then((pl) => ({ modules: pl.modules ?? [] })), Array.from(fs.readFileSync(file)));
			for (const m of payload.modules) {
				const zip = MODS && path.join(MODS, m.id + '.zip');
				if (!zip || !fs.existsSync(zip)) continue;
				await p.evaluate(() => window.__stores.modulesOpen.set(true));
				await p.waitForTimeout(400);
				await p.getByRole('tab', { name: /^User/ }).click();
				await p.locator('#install-module-zip').setInputFiles({ name: m.id + '.zip', mimeType: 'application/zip', buffer: fs.readFileSync(zip) });
				await h.eventually(() => p.evaluate(() => window.__stores.moduleSDK.loadedModules.map((x) => x.id)), (ids) => ids.includes(m.id), `${slug}: ${m.id} installed`, 20000);
				await p.evaluate(() => window.__stores.modulesOpen.set(false));
				await p.waitForTimeout(200);
			}
			await p.evaluate(async (arr) => {
				const s = window.__stores;
				const pl = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
				await s.sessions.applySession(pl, { backup: false });
			}, Array.from(fs.readFileSync(file)));
			await p.waitForTimeout(2500);
			if (!(await p.evaluate(() => !!document.querySelector('.svelteFlow .svelte-flow__pane')))) {
				await p.locator('p[title="Node editor (N)"]').click();
			}
			await p.waitForTimeout(2500);
			// the Main graph, framed (the F10 open)
			await p.evaluate(() => window.__stores.objectActions.deselectObject());
			await p.evaluate(() => window.__stores.activeGraphId.set('scene'));
			await p.waitForTimeout(1500);
			const r = await p.evaluate(() => {
				const m = window.__flowTidy.model();
				const l = window.__flowTidy.lint();
				const name = (id) => {
					const b = document.querySelector(`.svelte-flow__node[data-id="${CSS.escape(id)}"]`);
					return (b?.textContent ?? id).replace(/\s+/g, ' ').trim().slice(0, 28);
				};
				return {
					cards: m.boxes.length,
					wires: m.wires.length,
					overlaps: l.overlaps.map((o) => name(o.a) + ' × ' + name(o.b)),
					wireHits: l.wireHits.map((w) => w.wire + ' → ' + name(w.box)),
					frames: l.frameOverlaps.map((o) => o.a + ' × ' + o.b)
				};
			});
			if (theme === 'dark' && process.env.DUMP_MODEL) {
				// the measured geometry, for iterating the layout offline (scripts / vitest)
				fs.mkdirSync(process.env.DUMP_MODEL, { recursive: true });
				fs.writeFileSync(path.join(process.env.DUMP_MODEL, slug + '.json'), JSON.stringify(await p.evaluate(() => window.__flowTidy.model())));
			}
			if (theme === 'dark') {
				table.push({ slug, ...r });
				const ok = !r.overlaps.length && !r.wireHits.length && !r.frames.length;
				const line = `${slug}: ${r.cards} cards, ${r.wires} wires — ${r.overlaps.length} overlaps, ${r.wireHits.length} wires through cards, ${r.frames.length} frame clashes`;
				if (REPORT) console.log((ok ? 'CLEAN ' : 'DIRTY ') + line + (ok ? '' : '\n    overlaps: ' + JSON.stringify(r.overlaps) + '\n    wireHits: ' + JSON.stringify(r.wireHits)));
				else h.check(ok, line + (ok ? '' : ' ' + JSON.stringify({ o: r.overlaps.slice(0, 6), w: r.wireHits.slice(0, 6) })));
			}
			if (SHOTS) {
				fs.mkdirSync(SHOTS, { recursive: true });
				const nn = String(gi + 1).padStart(2, '0');
				await p.screenshot({ path: path.join(SHOTS, `${nn}-${TAG}-${slug}-${theme}.png`) });
			}
			await A.ctx.close();
		}
	}
	if (SHOTS) fs.writeFileSync(path.join(SHOTS, `lint-${TAG}.json`), JSON.stringify(table, null, '\t'));
	await h.finish(browser);
});

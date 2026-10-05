// tests/e2e/tools/graph-shots.cjs — roadmap 36 (36-dataflow audit, reused by 36-games-graphs for
// before/after): load each authored game .tpscene, open the Node editor large, fit the Main graph
// and screenshot it. Not a test — it checks nothing; it records what a user SEES.
//
//   APP_URL=https://theprototype.app:5329/ SHOTS=<dir> node tests/e2e/tools/graph-shots.cjs a.tpscene …
// Module-backed games install their module from MODULES_REPO's zips first (as the suites do),
// so module nodes draw as their real cards rather than "install the module".
const h = require('../helpers.cjs');
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2).filter((a) => a.endsWith('.tpscene'));
const SHOTS = process.env.SHOTS || '.';
const EXTERNAL = { 'dungeon-realms': ['dungeon', 'dungeon-realms'], football: ['football'], untangle: ['untangle'], waves: ['health', 'waves'], 'jam-room': ['music-fx', 'music-lab'] };

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1920, height: 1080 } } });
	const page = A.page;
	let i = 0;
	for (const file of files) {
		i++;
		const slug = path.basename(path.dirname(file)) === 'games' ? path.basename(file, '.tpscene') : path.basename(path.dirname(file));
		for (const id of EXTERNAL[slug] ?? []) await h.installModule(A, id).catch(() => false);
		const bytes = Array.from(fs.readFileSync(file));
		await page.evaluate(async (arr) => {
			const s = window.__stores;
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			await s.sessions.applySession(payload, { backup: false });
		}, bytes);
		await page.waitForTimeout(2500);
		const open = await page.evaluate(() => !!document.querySelector('.svelte-flow__pane'));
		if (!open) await page.locator('p[title="Node editor (N)"]').click();
		await page.waitForTimeout(1500);
		// a tall dock (80% of the window is its clamp) so the graph is readable, then fit it
		await page.evaluate(() => window.__stores.bottomDock?.dockHeight?.set(900));
		await page.waitForTimeout(600);
		await page.evaluate(() => window.__flowViewport?.fitView?.({ padding: 0.05 }));
		await page.waitForTimeout(800);
		const name = String(i).padStart(2, '0') + '-' + (process.env.SHOT_TAG || 'before') + '-' + slug + '.png';
		await page.screenshot({ path: path.join(SHOTS, name) });
		console.log('shot', name);
	}
	await browser.close();
});

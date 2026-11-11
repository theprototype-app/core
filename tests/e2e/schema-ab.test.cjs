// 101 F2 step 4: real scenes LOOK THE SAME and load UNCHANGED with the object schema in front of
// the loaders. Per scene (every template, the 1.65 capture, and every scene under SCENES_DIR):
//   · the load check changes nothing (loadGuard totals stay 0: no field, material, image or object
//     dropped) — checked on every build that has the hook;
//   · the first frame after the load (frozen clock, the scene's saved view, a chrome-free clip) is
//     compared with the same scene's frame from the BASE build.
// Two runs: AB_WRITE=1 against the base build writes <AB_DIR>/<slug>.png; then the lane run compares.
//
// Run: APP_URL=https://theprototype.app:7023/ AB_WRITE=1 AB_DIR=<dir> node tests/e2e/schema-ab.test.cjs   (base snapshot)
//      APP_URL=https://theprototype.app:7022/ AB_DIR=<dir> node tests/e2e/schema-ab.test.cjs              (lane)
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const WRITE = process.env.AB_WRITE === '1';
const DIR = path.resolve(process.env.AB_DIR || path.join(ROOT, 'test-results/101-schema/ab'));
const MAX_CHANGED = Number(process.env.MAX_CHANGED || 0.002); // share of the clip whose RGB moved by > 24
const T0 = 1791200000000;
const CLIP = { x: 190, y: 110, width: 900, height: 500 };

/** @param {string} dir @returns {string[]} */
function scenesIn(dir) {
	if (!dir || !fs.existsSync(dir)) return [];
	/** @type {string[]} */
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...scenesIn(p));
		else if (e.name.endsWith('.tpscene')) out.push(p);
	}
	return out.sort();
}

const files = [
	...scenesIn(path.join(ROOT, 'static/templates')),
	path.join(ROOT, 'tests/fixtures/schema-1.65/capture.tpscene'),
	...scenesIn(process.env.SCENES_DIR || '')
].filter((f) => fs.existsSync(f));
/** a readable, unique slug per file @param {string} f */
const slugOf = (f) => path.relative(ROOT, f).replace(/^\.\.\/+/g, '').replace(/[^\w.-]+/g, '_').replace(/_scene\.tpscene$|\.tpscene$/, '');

h.run(async () => {
	h.check(files.length >= 6, `premise: scenes to compare (${files.length})`);
	fs.mkdirSync(DIR, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } }, storage: { 'water:quality': 'high', autoQuality: 'false' } });
	await A.ctx.addInitScript((t) => {
		Date.now = () => t;
	}, T0);
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK && !!window.__stores.sessions, null, { timeout: 60000 });
	/** @type {string[]} */
	const rows = [];
	let worst = 0;
	for (const file of files) {
		const slug = slugOf(file);
		const bytes = Array.from(fs.readFileSync(file));
		const totals = await A.page.evaluate(async (arr) => {
			const s = window.__stores;
			s.loadGuard?.resetLoadGuard?.();
			if (await new Promise((r) => s.physics.simulating.subscribe(r)())) s.physics.stopSimulation();
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			if (payload.physics) delete payload.physics.simOnLoad;
			await s.sessions.applySession(payload, { backup: false });
			s.objectActions.deselectObject?.();
			return s.loadGuard?.loadGuardTotals?.() ?? null;
		}, bytes);
		await A.page.waitForTimeout(4000);
		const png = await A.page.screenshot({ clip: CLIP });
		const changedTotals = totals ? Object.entries(totals).filter(([, v]) => v > 0) : [];
		if (totals) h.check(changedTotals.length === 0, `${slug}: the load check changed nothing (${JSON.stringify(totals)})`);
		const gold = path.join(DIR, slug + '.png');
		if (WRITE) {
			fs.writeFileSync(gold, png);
			rows.push(`| ${slug} | written | ${totals ? JSON.stringify(totals) : 'no hook'} |`);
			continue;
		}
		fs.writeFileSync(path.join(DIR, slug + '-lane.png'), png);
		if (!fs.existsSync(gold)) {
			h.check(false, `${slug}: no base frame (run with AB_WRITE=1 on the base build)`);
			continue;
		}
		const d = await h.frameDelta(A.page, fs.readFileSync(gold), png, 24, 0);
		worst = Math.max(worst, d.fraction);
		rows.push(`| ${slug} | ${(d.fraction * 100).toFixed(3)}% | ${d.mean.toFixed(3)} | ${totals ? JSON.stringify(totals) : 'no hook'} |`);
		h.check(d.fraction <= MAX_CHANGED, `${slug}: same first frame as the base (${(d.fraction * 100).toFixed(3)}% changed, max ${(MAX_CHANGED * 100).toFixed(1)}%)`);
	}
	fs.writeFileSync(
		path.join(DIR, WRITE ? 'base.md' : 'ab.md'),
		`# 101-schema A/B (${WRITE ? 'base frames' : 'lane vs base'})\n\nFrozen Date.now(), the scene's saved view, clip ${CLIP.width}x${CLIP.height}; changed = RGB moved by > 24.\n\n| scene | changed | mean | load check totals |\n|---|---|---|---|\n${rows.join('\n')}\n\nworst: ${(worst * 100).toFixed(3)}%\n`
	);
	await h.finish(browser);
});

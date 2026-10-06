// 36-fb-water S11: water / sim scenes SAVED ON 1.22 load on this build and LOOK THE SAME.
// Fixtures: tests/fixtures/scenes-1.22/*.tpscene — the 1.22-authored examples (scenes repo
// 68853cc, appVersion 1.20/1.22). Goldens: tests/fixtures/golden-1.22/<slug>.png, captured ON a
// v1.22.0 build (GOLDEN_WRITE=1 against it). Time is frozen the version-independent way —
// Date.now() is pinned before the app boots, and the water clock is Date.now() + offset on
// every version — so waves, ripples and bubbles hold still on both builds.
//
// Per scene: the frame (a chrome-free centre clip, the scene's own saved view) may differ from
// the golden in at most MAX_CHANGED of its pixels. Two scenes are REPORTED, not gated:
//   jelly-room      the jellies rendered BLACK on 1.22 (F14) — the difference is the fix
//   fluid-tank-toy  the particle fluid steps on real time, so two runs never match pixel-exact
// The whole table goes to MIGRATION_OUT/migration.md.
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, '../fixtures/scenes-1.22');
const GOLD = path.join(__dirname, '../fixtures/golden-1.22');
const WRITE = process.env.GOLDEN_WRITE === '1';
const OUT = process.env.MIGRATION_OUT || '';
const MAX_CHANGED = Number(process.env.MAX_CHANGED || 0.03); // share of the clip
const GATED = ['aquarium', 'pool-party', 'island-ocean'];
const REPORT = ['jelly-room', 'fluid-tank-toy'];
const T0 = 1791200000000; // a fixed wall clock: the same water phase on every build
const CLIP = { x: 190, y: 110, width: 900, height: 500 };

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } }, storage: { 'water:quality': 'high' } });
	await A.ctx.addInitScript((t) => {
		Date.now = () => t;
	}, T0);
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await A.page.waitForFunction(() => window.__stores && !!window.__stores.moduleSDK, { timeout: 30000 });
	await A.page.evaluate(() => window.__stores.waterPrefs?.waterQuality?.set?.('high'));
	/** @type {string[]} */
	const rows = [];
	if (WRITE) fs.mkdirSync(GOLD, { recursive: true });
	if (OUT) fs.mkdirSync(OUT, { recursive: true });
	for (const slug of [...GATED, ...REPORT]) {
		const bytes = Array.from(fs.readFileSync(path.join(FIX, slug + '.tpscene')));
		await A.page.evaluate(async (arr) => {
			const s = window.__stores;
			if (await new Promise((r) => s.physics.simulating.subscribe(r)())) s.physics.stopSimulation();
			const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
			// the 1.22 behaviour for the golden run: nothing starts by itself on any build
			if (payload.physics) delete payload.physics.simOnLoad;
			await s.sessions.applySession(payload, { backup: false });
			s.objectActions.deselectObject?.();
		}, bytes);
		await A.page.waitForTimeout(5000);
		// the scene's own saved view (applied by the load), whatever the version
		const png = await A.page.screenshot({ clip: CLIP });
		const goldFile = path.join(GOLD, slug + '.png');
		if (WRITE) {
			fs.writeFileSync(goldFile, png);
			console.log('wrote golden', slug);
			continue;
		}
		if (OUT) fs.writeFileSync(path.join(OUT, slug + '-now.png'), png);
		if (!fs.existsSync(goldFile)) {
			h.check(false, `${slug}: no golden (capture with GOLDEN_WRITE=1 on v1.22.0)`);
			continue;
		}
		const d = await h.frameDelta(A.page, fs.readFileSync(goldFile), png, 24);
		rows.push(`| ${slug} | ${(d.fraction * 100).toFixed(2)}% | ${d.mean.toFixed(2)} | ${GATED.includes(slug) ? (d.fraction <= MAX_CHANGED ? 'same' : '**DIFFERENT**') : 'reported'} |`);
		if (GATED.includes(slug))
			h.check(d.fraction <= MAX_CHANGED, `${slug} (saved on 1.22) looks the same: ${(d.fraction * 100).toFixed(2)}% of the frame changed (max ${(MAX_CHANGED * 100).toFixed(0)}%)`);
		else console.log(`REPORT ${slug}: ${(d.fraction * 100).toFixed(2)}% changed (not gated: ${slug === 'jelly-room' ? 'black on 1.22 — the F14 fix' : 'the fluid steps on real time'})`);
	}
	if (OUT && rows.length)
		fs.writeFileSync(
			path.join(OUT, 'migration.md'),
			`# 1.22 scenes on this build (S11)\n\nGolden = v1.22.0, frozen Date.now(), the scene's saved view, clip ${CLIP.width}x${CLIP.height}. ` +
				`Changed = pixels whose RGB moved by more than 24.\n\n| scene | changed | mean delta | verdict |\n|---|---|---|---|\n${rows.join('\n')}\n`
		);
	await h.finish(browser);
});

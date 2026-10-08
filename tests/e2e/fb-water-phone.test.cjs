// 36-fb-water F27: water + fluid on a PHONE (emulated: 412x915, DPR 3, mobile UA, touch, CPU x4).
//   1. after the load settles and frames are steady, the quality level steps back UP: the fluid
//      tanks draw their smooth screen-space surface (ssfRuns > 0) and Aquarium refracts (the water
//      left the Quest tier) — 36-int-124's regression probe as a check;
//   2. every quality level (pinned through the game-quality seam): a screenshot of both scenes
//      and a perf row (calls, triangles, p50/p95 at CPU x4) -> PHONE_OUT/perf-phone.md;
//   3. a game's Quality preset that simplifies the water is not announced (40 F12: the automatic
//      drops are AutoQualityNotice's, suite auto-quality-notice).
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const { startRecorder, readScene } = require('../../scripts/perfProbe.cjs');

const OUT = process.env.PHONE_OUT || '';
const LEVELS = (process.env.LEVELS || '0,2,4,6,9').split(',').map(Number);
const SC = [process.env.FBW_SCENES, path.resolve(__dirname, '../../../scenes-lane-36-fb-water/examples')].filter(Boolean).find((d) => fs.existsSync(/** @type {string} */ (d)));
const PHONE = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; PKH110) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36' };

/** @param {any} page @param {string} slug */
async function load(page, slug) {
	const bytes = Array.from(fs.readFileSync(path.join(/** @type {string} */ (SC), slug, 'scene.tpscene')));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
}
/** @param {any} page */
const state = (page) =>
	page.evaluate(() => {
		const S = window.__stores;
		let q;
		S.qualityGovernor.qualityState.subscribe((v) => (q = v))();
		const w = S.waterRuntime.waterDebug?.();
		return { level: q?.level, reason: q?.reason, phone: S.qualityGovernor.phoneQuality(), hz: S.qualityGovernor.phoneRefreshHz?.() ?? null, water: w?.tier ?? null, prepass: w?.prepass?.frame ?? null, tanks: S.sim.fluidDebug().map((t) => ({ mode: t.mode, ssfRuns: t.ssfRuns })) };
	});

h.run(async () => {
	if (OUT) fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'phone', { context: PHONE });
	const cdp = await A.page.context().newCDPSession(A.page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
	h.check((await state(A.page)).phone === true, 'the app judges this device a phone');

	// ── 1. the level steps back up after the load: SSF + refraction on a phone ────────────────
	await load(A.page, 'fluid-tank-toy');
	const fluidUp = await h
		.eventually(() => state(A.page), (s) => s.level <= 4 && s.tanks.length === 2 && s.tanks.every((t) => t.mode === 'ssf' && t.ssfRuns > 0), 'Fluid tank toy: after the load the level is back at the phone start or better and both tanks draw SSF', 60000)
		.then(() => true)
		.catch(() => false);
	console.log('fluid', JSON.stringify(await state(A.page)));
	if (OUT) await A.page.screenshot({ path: path.join(OUT, '70-phone-fluid-tank-toy-auto.png') });
	await load(A.page, 'aquarium');
	await h.eventually(() => state(A.page), (s) => s.water && s.water !== 'quest' && s.level <= 4, 'Aquarium on a phone: the water refracts (screen-space tier) at the phone level', 60000);
	// THE REGRESSION (36-int-124's probe): on steady frames the level must STAY there — batch 6
	// read 4 at load and 9 thirty seconds later (frames timed off the callback clock read a 60 fps
	// panel as 72 Hz with a late p95), so a check at one instant cannot see it
	/** @type {number[]} */
	const held = [];
	for (let i = 0; i < 12; i++) {
		await A.page.waitForTimeout(3000);
		const s = await state(A.page);
		held.push(s.level);
		if (i % 4 === 3) console.log('aquarium hold', JSON.stringify(s));
	}
	const after = await state(A.page);
	h.check(after.hz === 60, `the phone is judged against the 60 Hz the page really presents at (${after.hz})`);
	h.check(Math.max(...held) <= 4 && after.water !== 'quest', `Aquarium holds the phone level for 36 s on steady frames (levels ${held.join(',')}, water ${after.water})`);
	if (OUT) await A.page.screenshot({ path: path.join(OUT, '71-phone-aquarium-auto.png') });
	void fluidUp;

	// ── 2. every quality level: shots + perf rows ─────────────────────────────────────────────
	/** @type {string[]} */
	const rows = [];
	for (const slug of ['aquarium', 'fluid-tank-toy']) {
		await load(A.page, slug);
		await A.page.waitForTimeout(4000);
		for (const level of LEVELS) {
			await A.page.evaluate((l) => window.__stores.qualityGovernor.applyGameQuality(l, 'level ' + l), level);
			await A.page.waitForTimeout(2500);
			await A.page.evaluate(startRecorder);
			await A.page.waitForTimeout(4000);
			const r = await A.page.evaluate(readScene);
			const s = await state(A.page);
			rows.push(`| ${slug} | ${level} | ${s.water ?? ''} | ${s.tanks.map((t) => t.mode).join(' + ')} | ${r.medianCalls} | ${r.medianTriangles} | ${r.p50?.toFixed(1)} / ${r.p95?.toFixed(1)} | ${r.bufferPx} Mpx |`);
			if (OUT) await A.page.screenshot({ path: path.join(OUT, `phone-${slug}-L${level}.png`) });
		}
		await A.page.evaluate(() => window.__stores.qualityGovernor.applyGameQuality(null));
	}
	if (OUT)
		fs.writeFileSync(
			path.join(OUT, 'perf-phone.md'),
			`# Phone profile (412x915, DPR 3, mobile UA, CPU x4) — water + fluid per quality level (36-fb-water F27)\n\n| scene | level | water tier | fluid | calls | triangles | p50 / p95 ms | buffer |\n|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`
		);
	console.log(rows.join('\n'));

	// ── 3. 40 F12: the old "Simplified water" strip became AutoQualityNotice (one toast per
	// automatic drop, suite auto-quality-notice). What stays here: a game's own Quality preset is
	// an explicit choice, so pinning a level that simplifies the water is NOT announced
	await A.ctx.close();
	const A2 = await h.setupPage(browser, 'phone-notice', { context: PHONE });
	await load(A2.page, 'aquarium');
	await A2.page.waitForTimeout(3000);
	await A2.page.evaluate(() => window.__stores.qualityGovernor.applyGameQuality(6, 'test'));
	await h.eventually(() => state(A2.page), (s) => s.water === 'quest', 'a pinned level 6: the water is simplified', 8000);
	await A2.page.waitForTimeout(1500);
	h.check((await A2.page.$('#simplified-water-notice')) === null, 'the old strip is gone');
	h.check(!(await A2.page.evaluate(() => [...document.querySelectorAll('.tp-toast-text')].some((e) => /^Lowered water quality/.test(e.textContent ?? '')))), 'a game preset is not announced as an automatic drop');
	if (OUT) await A2.page.screenshot({ path: path.join(OUT, '72-phone-game-preset-no-notice.png') });
	await A2.page.evaluate(() => window.__stores.qualityGovernor.applyGameQuality(null));
	h.check((await h.pageErrors(A2)).length === 0, 'no page errors');
	await h.finish(browser);
});

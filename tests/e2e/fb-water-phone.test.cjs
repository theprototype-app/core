// 36-fb-water F27: water + fluid on a PHONE (emulated: 412x915, DPR 3, mobile UA, touch, CPU x4).
//   1. after the load settles and frames are steady, the quality level steps back UP: the fluid
//      tanks draw their smooth screen-space surface (ssfRuns > 0) and Aquarium refracts (the water
//      left the Quest tier) — 36-int-124's regression probe as a check;
//   2. every quality level (pinned through the game-quality seam): a screenshot of both scenes
//      and a perf row (calls, triangles, p50/p95 at CPU x4) -> PHONE_OUT/perf-phone.md;
//   3. the one-time "Simplified water" notice: shown when quality takes refraction away, dismiss
//      works, once per session, never in Play.
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
		return { level: q?.level, reason: q?.reason, phone: S.qualityGovernor.phoneQuality(), water: w?.tier ?? null, prepass: w?.prepass?.frame ?? null, tanks: S.sim.fluidDebug().map((t) => ({ mode: t.mode, ssfRuns: t.ssfRuns })) };
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
	console.log('aquarium', JSON.stringify(await state(A.page)));
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

	// ── 3. the one-time notice — on a FRESH page: the level sweep above already used this
	// session's one notice (correctly), and the component remembers that for the page's life
	h.check((await A.page.evaluate(() => sessionStorage.getItem('water:simplifiedNoticeSeen'))) === '1', 'the sweep\'s first simplified level used the session\'s notice');
	await A.ctx.close();
	const B = await h.setupPage(browser, 'phone-notice', { context: PHONE });
	const A2 = B;
	await load(A2.page, 'aquarium');
	await A2.page.waitForTimeout(3000);
	// in Play first: never shown there
	await A2.page.evaluate(() => {
		window.__stores.isLocked.set(true);
		window.__stores.qualityGovernor.applyGameQuality(6, 'test');
	});
	await A2.page.waitForTimeout(1500);
	h.check((await A2.page.$('#simplified-water-notice')) === null, 'no notice while playing');
	await A2.page.evaluate(() => window.__stores.isLocked.set(null));
	const note = await A2.page.waitForSelector('#simplified-water-notice', { timeout: 5000 }).catch(() => null);
	h.check(!!note, 'leaving Play, the notice says the water was simplified');
	const text = note ? await note.textContent() : '';
	h.check(/Simplified water for this device/.test(text) && /Water quality/.test(text), `...and where to give refraction back ("${text?.trim()}")`);
	if (OUT && note)
		for (const t of ['dark', 'light']) {
			await A2.page.evaluate((th) => window.__stores.themes.theme.set(th), t);
			await A2.page.waitForTimeout(300);
			await A2.page.screenshot({ path: path.join(OUT, `72-phone-simplified-notice-${t}.png`) });
		}
	await A2.page.evaluate(() => window.__stores.themes.theme.set('dark'));
	await A2.page.click('#simplified-water-notice .sw-x').catch(() => {});
	await A2.page.waitForTimeout(400);
	h.check((await A2.page.$('#simplified-water-notice')) === null, 'dismiss hides it');
	// once per session: down to full and back to simplified -> no second notice
	await A2.page.evaluate(() => window.__stores.qualityGovernor.applyGameQuality(0, 'test'));
	await A2.page.waitForTimeout(1000);
	await A2.page.evaluate(() => window.__stores.qualityGovernor.applyGameQuality(6, 'test'));
	await A2.page.waitForTimeout(1500);
	h.check((await A2.page.$('#simplified-water-notice')) === null, 'once per session: it does not come back');
	await A2.page.evaluate(() => window.__stores.qualityGovernor.applyGameQuality(null));
	h.check((await h.pageErrors(A2)).length === 0, 'no page errors');
	await h.finish(browser);
});

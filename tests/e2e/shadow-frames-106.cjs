// 106 S0 — THE SHADOW COST TABLE: per device, three scenes (small / castle-type / large terrain), what is drawn
// today (inventory) and the frame cost at each shadow level (Basic, Soft, Far, Off). Not a suite: a measurement
// driver (the cinematic-frames-100 shape). The page half is shadow-s0-106.page.js (the HONOR runs the same
// text through raw CDP: test-results/106-shadows/honor/).
//
//   Deck (own Chromium, uncapped, alone):
//     APP_URL=https://theprototype.app:7200/ e2e-slot --local --exclusive --wait 9000 --dev $PWD 7200 -- \
//       env DEVICE=deck node tests/e2e/shadow-frames-106.cjs
//   PC (real Chrome through the device lab): ~/.code/lanes-30/after-106/106-shadows/lab/run-pc.mjs --driver this
//
// env: SCENES (product-shot,castle-courtyard,race), LEVELS (basic,soft,far,off,basic), SAMPLE_MS (6000),
//      OUT (test-results/106-shadows/frames), DEVICE, W x H (1920 x 1080 on a local launch), CDP (port)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.APP_URL || 'https://theprototype.app:7200/';
const CDP = process.env.CDP || '';
const DEVICE = process.env.DEVICE || (CDP ? 'pc' : 'deck');
const SCENES = (process.env.SCENES || 'product-shot,castle-courtyard,race').split(',').filter(Boolean);
const LEVELS = (process.env.LEVELS || 'basic,soft,far,off,basic').split(',').filter(Boolean);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 6000);
// TIER=pc prices Soft / Far on a device the tier table caps (S0 only; the setting itself never does this)
const TIER = process.env.TIER || '';
const W = Number(process.env.W || 1920), H = Number(process.env.H || 1080);
const OUT = process.env.OUT || path.join(process.cwd(), 'test-results/106-shadows/frames');
fs.mkdirSync(OUT, { recursive: true });
const PAGE_SRC = fs.readFileSync(path.join(__dirname, 'shadow-s0-106.page.js'), 'utf8');
const log = (...a) => console.log('[s0]', ...a);
const result = { device: DEVICE, at: new Date().toISOString(), url: URL, sampleMs: SAMPLE_MS, scenes: {} };
const save = () => fs.writeFileSync(path.join(OUT, `frames-${DEVICE}.json`), JSON.stringify(result, null, 1));

(async () => {
	let browser, context;
	if (CDP) {
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`);
		context = await browser.newContext({ viewport: null });
	} else {
		browser = await chromium.launch({
			args: ['--use-gl=angle', '--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit']
		});
		context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: W, height: H } });
	}
	await context.addInitScript(() => {
		try {
			for (const [k, v] of [['debugStores', 'true'], ['hasSeenDisclaimer', 'true'], ['hasSeenWelcome', 'true'], ['perfReports:offered', 'no'], ['errorReports:send', 'false']]) localStorage.setItem(k, v);
		} catch {
			/* storage blocked */
		}
	});
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)));
	page.on('console', (m) => {
		if (m.type() === 'error' || /\[shadows\]/.test(m.text())) errors.push(('console: ' + m.text()).slice(0, 300));
	});
	let rc = 1;
	try {
		await page.goto(URL, { timeout: 180000 });
		await page.waitForFunction(() => !!window.__stores?.environment?.setSceneShadowLevel && !!window.__stores?.globalRenderer, null, { timeout: 240000 });
		await page.waitForTimeout(4000);
		await page.keyboard.press('Escape').catch(() => {});
		await page.evaluate(PAGE_SRC);
		for (const slug of SCENES) {
			const S = { load: await page.evaluate((slug) => window.__s0.load(slug), slug), rows: [] };
			result.scenes[slug] = S;
			log('load', slug, JSON.stringify({ ok: S.load.ok, objects: S.load.objects }));
			S.inventory = await page.evaluate(() => window.__s0.inventory());
			log(slug, 'inventory', JSON.stringify(S.inventory).slice(0, 900));
			save();
			for (const level of LEVELS) {
				const row = await page.evaluate(([level, pose, sampleMs, tier]) => window.__s0.measure(level, { pose, sampleMs, tier }), [level, S.load.pose, SAMPLE_MS, TIER]);
				row.shot = `${DEVICE}-${slug}-${level}-${S.rows.length}.png`;
				await page.screenshot({ path: path.join(OUT, row.shot) });
				S.rows.push(row);
				log(slug, level, JSON.stringify({ drawn: row.drawn, raf: row.raf, forced: row.forced, contact: row.contact, lights: row.lights }));
				save();
			}
			await page.evaluate(() => window.__stores.environment.setSceneShadowLevel('basic'));
		}
		rc = 0;
	} catch (e) {
		log('ERROR', String(e.message || e).slice(0, 600));
	} finally {
		result.errors = errors.slice(0, 50);
		save();
		log('errors', errors.length, JSON.stringify(errors.slice(0, 8)));
		await context.close().catch(() => {});
		if (!CDP) await browser.close().catch(() => {});
	}
	process.exit(rc);
})();

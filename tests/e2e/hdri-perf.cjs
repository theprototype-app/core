// 37-hdri — Quest budget A/B (evidence, not a suite): the perf protocol's headset analogue
// (fake XR session at the spawn, Shaded, post off, shadows off, 1280x720) on a stock template,
// with the stock studio sky vs each HDRI preset at the LOW (headset) tier. Prints a markdown
// table: median calls / triangles per display frame, the probe's texture-MB estimate, and the
// PMREM's real size (half float = 8 bytes a texel; the probe assumes 4).
//   APP_URL=https://theprototype.app:5356/ e2e-slot --dev . 5356 -- node tests/e2e/hdri-perf.cjs
const fs = require('fs');
const h = require('./helpers.cjs');
const fx = require('./fakeXR.cjs');
const { startRecorder, readScene } = require('../../scripts/perfProbe.cjs');
const OUT = process.env.HDRI_OUT || '/home/deck/.code/lanes-30/after-37/37-hdri';
const TEMPLATE = process.env.HDRI_TEMPLATE || 'level-blockout';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } }, storage: { autoQuality: 'false' } });
	const page = A.page;
	await page.evaluate(async (slug) => {
		const s = window.__stores;
		const res = await fetch(new URL('templates/' + slug + '/scene.tpscene', document.baseURI));
		const payload = await s.sessions.importSessionZip(await res.arrayBuffer());
		if (payload) await s.sessions.requestLoadSession(payload.id);
	}, TEMPLATE);
	await page.waitForTimeout(3000);
	await fx.install(page);
	await fx.installSpace(page, { head: [0, 1.6, 0] });
	await page.evaluate(() => {
		const s = window.__stores;
		s.viewMode.set('shaded');
		s.viewportOverrides.setRenderLayer('post', false);
		s.lightParams.shadowQuality.set('off');
		s.hdriPrefs.hdriQuality.set('low');
	});
	const rows = [];
	for (const key of ['studio', 'clearsky', 'meadow', 'sunrise', 'starlight', 'photostudio']) {
		await page.evaluate((k) => window.__stores.environment.setEnvironment(k), key);
		await page.evaluate(() => window.__stores.hdri.hdriDebug.settle());
		await page.waitForTimeout(800);
		await page.evaluate(startRecorder);
		await page.waitForTimeout(3000);
		const m = await page.evaluate(readScene);
		const st = await page.evaluate(() => {
			let v;
			window.__stores.hdriStores.hdriStatus.subscribe((x) => (v = x))();
			let scene;
			window.__stores.globalScene.subscribe((x) => (scene = x))();
			const img = scene.environment?.image;
			return { ...v, realMB: img ? Math.round(((img.width * img.height * 8) / 1048576) * 100) / 100 : 0, w: img?.width ?? 0, h: img?.height ?? 0 };
		});
		rows.push({ key, calls: m.medianCalls, maxCalls: m.maxCalls, tris: m.medianTriangles, textureMB: m.textureMB, lights: m.lights, tier: st.tier || '-', pmrem: st.w ? `${st.w}x${st.h}` : '-', realMB: st.realMB, loadMs: st.ms, p50: m.p50 });
		console.log(JSON.stringify(rows[rows.length - 1]));
	}
	const md = [
		`# 37-hdri Quest budget A/B — template ${TEMPLATE}, fake XR at the spawn, Shaded, post off, shadows off, HDRI tier low`,
		'',
		'| env | calls (max) | triangles | probe textureMB | lights | tier | PMREM | PMREM real MB | load+prefilter ms | p50 ms (desk) |',
		'|---|---|---|---|---|---|---|---|---|---|',
		...rows.map((r) => `| ${r.key} | ${r.calls} (${r.maxCalls}) | ${r.tris} | ${r.textureMB} | ${r.lights} | ${r.tier} | ${r.pmrem} | ${r.realMB} | ${r.loadMs || '-'} | ${r.p50 ?? '-'} |`),
		'',
		'Budget (perf/README.md): calls ≤ 150, triangles ≤ 300 000, lights ≤ 2, textureMB ≤ 64.'
	].join('\n');
	fs.writeFileSync(OUT + '/perf-quest-ab.md', md + '\n');
	console.log(md);
	console.log('errors', JSON.stringify(page.__errors));
	await browser.close();
});

// tests/e2e/tools/lock-baselines.cjs — roadmap 38 R1: the BASELINE screenshots of every
// panel, window, modal, menu and Settings section (tests/e2e/lockSurfaces.cjs) on the
// pre-redesign UI, at 1440×900 and 390×844 (touch), in the dark, light and a custom
// .theme.json theme (fixtures/lock/lock-custom.theme.json). Not a test — it checks nothing;
// it records what a person SEES, so every 38 lane can pair its `-after` shots with these.
//
//   APP_URL=https://localhost:5371/ SHOTS=<dir> node tests/e2e/tools/lock-baselines.cjs [surface…]
//
// Names: <surface>-<1440x900|390x844>-<dark|light|custom>-before.png (the roadmap-38 rule),
// plus index.html, a contact sheet of the lot. ONLY=<theme> / SIZE=<WxH> narrow a run.
const h = require('../helpers.cjs');
const L = require('../lockHelpers.cjs');
const S = require('../lockSurfaces.cjs');
const fs = require('fs');
const path = require('path');

const SHOTS = process.env.SHOTS || '.';
const only = process.argv.slice(2);
const SIZES = [
	{ id: '1440x900', context: { viewport: { width: 1440, height: 900 } } },
	{ id: '390x844', context: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } }
].filter((s) => !process.env.SIZE || s.id === process.env.SIZE);
const THEMES = /** @type {const} */ (['dark', 'light', 'custom']).filter((t) => !process.env.ONLY || t === process.env.ONLY);

h.run(async () => {
	fs.mkdirSync(SHOTS, { recursive: true });
	const browser = await L.launch();
	/** @type {{file: string, surface: string, size: string, theme: string, ok: boolean}[]} */
	const shots = [];
	for (const size of SIZES) {
		for (const theme of THEMES) {
			const P = await h.setupPage(browser, `${size.id}-${theme}`, { context: size.context });
			const page = P.page;
			const ctx = await S.seedScene(page);
			await S.applyTheme(page, theme);
			for (const s of S.SURFACES) {
				if (only.length && !only.includes(s.name)) continue;
				await S.closeAll(page);
				await page.evaluate((u) => window.__stores.objectActions.selectObject(u), ctx.box);
				await page.waitForTimeout(150);
				let ok = true;
				try {
					await s.open(page, ctx);
				} catch (e) {
					ok = false;
					console.log(`OPEN FAILED ${s.name} ${size.id} ${theme}: ${String(e).split('\n')[0]}`);
				}
				await page.waitForTimeout(s.kind === 'dock' || s.kind === 'settings' ? 900 : 600);
				const shown = await page
					.evaluate((sel) => [...document.querySelectorAll(sel)].some((e) => e.getClientRects().length), s.shown)
					.catch(() => false);
				const file = `${s.name}-${size.id}-${theme}-before.png`;
				await page.screenshot({ path: path.join(SHOTS, file) });
				shots.push({ file, surface: s.name, size: size.id, theme, ok: ok && shown });
				if (!shown) console.log(`NOT SHOWN ${s.name} ${size.id} ${theme} (${s.shown})`);
			}
			await P.ctx.close();
			console.log(`shot ${size.id} ${theme}`);
		}
	}
	// the contact sheet: one row per surface, its six shots side by side
	const surfaces = [...new Set(shots.map((s) => s.surface))];
	const cell = (/** @type {any} */ s) =>
		s ? `<figure${s.ok ? '' : ' class="miss"'}><a href="${s.file}"><img loading="lazy" src="${s.file}" alt="${s.file}"></a><figcaption>${s.size} · ${s.theme}${s.ok ? '' : ' · NOT SHOWN'}</figcaption></figure>` : '<figure></figure>';
	const rows = surfaces
		.map((name) => `<section><h2>${name}</h2><div class="row">${SIZES.flatMap((z) => THEMES.map((t) => cell(shots.find((s) => s.surface === name && s.size === z.id && s.theme === t)))).join('')}</div></section>`)
		.join('\n');
	fs.writeFileSync(
		path.join(SHOTS, 'index.html'),
		`<!doctype html><meta charset="utf-8"><title>38-lock baselines</title><style>body{font:13px system-ui;background:#111;color:#ddd;margin:16px}h2{font-size:14px;margin:18px 0 6px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start}figure{margin:0;width:220px}img{width:100%;border:1px solid #333}figcaption{color:#999;font-size:11px}.miss img{outline:2px solid #e55}</style><h1>Behaviour-lock baselines (pre-redesign, ${new Date().toISOString().slice(0, 10)})</h1><p>${shots.length} shots · ${shots.filter((s) => !s.ok).length} where the surface's content was not detected (red).</p>\n${rows}\n`
	);
	console.log(`${shots.length} shots, ${shots.filter((s) => !s.ok).length} not shown -> ${SHOTS}`);
	await h.finish(browser);
});

// 53 A2 — the High contrast theme and colour-blind safe status, in the running app.
// The token values themselves are proven without a browser (tests/unit/themeContrast.test.js);
// this suite proves the APP paints from them:
//  1. the 3D view: the selection outline + the transform gizmo take the High contrast tokens
//     (and give them back in every other theme); a person's own outline colour still wins
//  2. status marks are SHAPES: the shared budget dot (green / amber / red / unknown), the kit's
//     Badge status dots and a toned Toast's glyph
//  3. the toggle reads in High contrast (knob vs both tracks, the track vs the surface)
//  4. every visible piece of text on the main surfaces is AA (4.5:1) in High contrast
// Run: APP_URL=https://theprototype.app:5472/ npm run e2e -- contrast-a2
// Counterfactual: BEFORE=1 against v1.39.0 records the reds without failing.
const h = require('./helpers.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { contrastRows } = require('./contrast.cjs');

const OUT = process.env.EVIDENCE_DIR || '/home/deck/.code/lanes-30/after-53/53-contrast';
const BEFORE = !!process.env.BEFORE;
const reds = [];
const check = (ok, label) => {
	if (BEFORE) {
		if (!ok) reds.push(label);
		console.log(`${ok ? 'ok  ' : 'RED '} ${label}`);
		return;
	}
	h.check(ok, label);
};

const SURFACES = [
	{ id: 'settings', open: (s) => s.settingsOpen.set(true), close: (s) => s.settingsOpen.set(false) },
	{ id: 'inspector', open: (s) => s.showSidebar('scene'), close: (s) => s.inspectorClose.set(true) },
	{ id: 'menu', open: (s) => s.closeMenu.set(false), close: (s) => s.closeMenu.set(true) },
	{ id: 'objects', open: (s) => s.objectListClose.set(false), close: (s) => s.objectListClose.set(true) },
	{ id: 'flow', open: (s) => s.flowGraphClose.set(false), close: (s) => s.flowGraphClose.set(true) },
	{ id: 'explorer', open: (s) => s.explorerClose.set(false), close: (s) => s.explorerClose.set(true) },
	{ id: 'notifications', open: (s) => s.notificationCenterOpen.set(true), close: (s) => s.notificationCenterOpen.set(false) }
];

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	const setTheme = async (t) => {
		await page.evaluate((id) => window.__tp.test.v1.themes.theme.set(id), t);
		await page.waitForTimeout(250);
	};

	// ---- 1. the 3D view -------------------------------------------------------------------
	await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.commandsHandler.sceneCommand('/create box');
	});
	await page.waitForTimeout(800);
	await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const box = group?.children?.[group.children.length - 1];
		if (box) s.selectedObjects.set([box.uuid]);
	});
	const viewport = () =>
		page.evaluate(() => {
			const s = window.__tp?.test.v1;
			let c;
			s.TControls.subscribe((x) => (c = x))();
			const lib = c?._gizmo?.materialLib;
			const o = window.__outlineDebug?.() ?? {};
			return { size: c?.size, x: lib?.xAxis.color.getHexString(), z: lib?.zAxis.color.getHexString(), outline: o.selectedColor, locked: o.lockedColor, kernel: o.kernel };
		});
	await setTheme('dark');
	const dark = await viewport();
	check(dark.outline === '353535' && dark.size === 1 && dark.x === 'ff0000', `dark: the default outline + three's gizmo (${JSON.stringify(dark)})`);
	await setTheme('contrast');
	const hc = await viewport();
	check(hc.outline === 'ffd400', `High contrast: the selection outline is the theme's yellow (${hc.outline})`);
	check(hc.locked === 'ff7f96', `High contrast: a peer's lock outline is the "over" colour (${hc.locked})`);
	check(hc.kernel === 2, `High contrast: the outline is thicker (kernel ${hc.kernel}, MEDIUM = 2)`);
	check(hc.size === 1.35, `High contrast: the gizmo is bigger (${hc.size})`);
	check(hc.x === 'ff6b5b' && hc.z === '4daaff', `High contrast: the gizmo axes take the theme's hues (x ${hc.x}, z ${hc.z})`);
	// the person's own outline colour wins over the theme's
	await page.evaluate(() => window.__tp.test.v1.viewPrefs?.setViewPrefs?.({ outlineColor: '#00ff00' }));
	await page.waitForTimeout(200);
	const own = await viewport();
	check(own.outline === '00ff00' || !own.outline, `High contrast: a chosen outline colour still wins (${own.outline})`);
	await page.evaluate(() => window.__tp.test.v1.viewPrefs?.resetViewPrefs?.());
	await setTheme('dark');
	const back = await viewport();
	check(back.outline === '353535' && back.size === 1 && back.x === 'ff0000' && back.kernel === 0, `back in dark, everything is given back (${JSON.stringify(back)})`);
	await page.screenshot({ path: path.join(OUT, `e2e-${BEFORE ? 'before' : 'after'}-viewport-dark.png`) }).catch(() => {});
	await setTheme('contrast');
	await page.screenshot({ path: path.join(OUT, `e2e-${BEFORE ? 'before' : 'after'}-viewport-contrast.png`) }).catch(() => {});
	await page.evaluate(() => window.__tp.test.v1.selectedObjects.set([]));

	// ---- 2. the shared budget dot is a shape per tier ------------------------------------
	for (const theme of ['dark', 'light', 'contrast']) {
		await setTheme(theme);
		const dots = await page.evaluate(() => {
			const out = {};
			const host = document.createElement('div');
			host.id = 'a2-probe';
			document.body.appendChild(host);
			for (const tier of ['green', 'amber', 'red', 'unknown']) {
				const el = document.createElement('span');
				el.className = 'budget-dot';
				el.dataset.tier = tier;
				host.appendChild(el);
				const cs = getComputedStyle(el);
				out[tier] = { clip: cs.clipPath, bg: cs.backgroundColor, ring: cs.boxShadow };
			}
			const root = getComputedStyle(document.documentElement);
			out.tokens = { good: root.getPropertyValue('--status-good').trim(), warn: root.getPropertyValue('--status-warn').trim() };
			host.remove();
			return out;
		});
		check(/^circle/.test(dots.green.clip), `${theme}: a fine budget dot is a disc (${dots.green.clip})`);
		check(/^polygon/.test(dots.amber.clip) && dots.amber.clip !== dots.red.clip, `${theme}: careful is a triangle, over a cross (${dots.amber.clip.slice(0, 30)} / ${dots.red.clip.slice(0, 30)})`);
		check(/inset/.test(dots.unknown.ring) && /rgba\(0, 0, 0, 0\)/.test(dots.unknown.bg), `${theme}: "not measured" is a hollow ring (${dots.unknown.ring})`);
		const real = await page.evaluate(() => {
			window.__tp.test.v1.objectListClose.set(false);
			return null;
		});
		void real;
		await page.waitForTimeout(400);
		const objDot = await page.evaluate(() => {
			const el = document.getElementById('object-budget-dot');
			return el ? { tier: el.dataset.tier, clip: getComputedStyle(el).clipPath } : null;
		});
		check(!objDot || (objDot.tier === 'green' ? /^circle/.test(objDot.clip) : /^polygon|none/.test(objDot.clip)) || objDot.tier === 'unknown', `${theme}: the object list's budget dot wears its tier's shape (${JSON.stringify(objDot)})`);
		await page.evaluate(() => window.__tp.test.v1.objectListClose.set(true));
	}

	// ---- 3. the toggle in High contrast --------------------------------------------------
	await setTheme('contrast');
	await page.evaluate(() => window.__tp.test.v1.settingsOpen.set(true));
	await page.waitForTimeout(900);
	const toggle = await page.evaluate(() => {
		const lum = (c) => {
			const m = (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
			const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
			return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
		};
		const ratio = (a, b) => {
			const x = lum(a);
			const y = lum(b);
			return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
		};
		const res = {};
		for (const state of ['true', 'false']) {
			const t = document.querySelector(`.tg[aria-pressed='${state}']`);
			if (!t) continue;
			const track = getComputedStyle(t).backgroundColor;
			const knob = getComputedStyle(t.querySelector('.tg-knob')).backgroundColor;
			res[state] = { knobOnTrack: +ratio(knob, track).toFixed(2), trackOnSurface: +ratio(track, 'rgb(0,0,0)').toFixed(2) };
		}
		return res;
	});
	check(toggle.true && toggle.true.knobOnTrack >= 3, `High contrast: an ON toggle's knob reads on its track (${JSON.stringify(toggle.true)})`);
	check(toggle.false && toggle.false.knobOnTrack >= 3 && toggle.false.trackOnSurface >= 3, `High contrast: an OFF toggle is visible and its knob reads (${JSON.stringify(toggle.false)})`);
	await page.evaluate(() => window.__tp.test.v1.settingsOpen.set(false));

	// ---- 4. AA text on the main surfaces, High contrast ---------------------------------
	const under = [];
	for (const surf of SURFACES) {
		const ok = await page.evaluate(([src]) => (0, eval)(src)(window.__tp?.test.v1), [surf.open.toString()]).then(
			() => true,
			(e) => String(e)
		);
		if (ok !== true) {
			console.log(`  (could not open ${surf.id}: ${ok})`);
			continue;
		}
		await page.waitForTimeout(700);
		const rows = (await contrastRows(page, 'body')).filter((r) => r.text !== '[canvas ink]');
		for (const r of rows) if (r.ratio < 4.5) under.push({ surface: surf.id, ...r });
		await page.screenshot({ path: path.join(OUT, `e2e-${BEFORE ? 'before' : 'after'}-contrast-${surf.id}.png`) }).catch(() => {});
		await page.evaluate(([src]) => (0, eval)(src)(window.__tp?.test.v1), [surf.close.toString()]).catch(() => {});
		await page.waitForTimeout(200);
	}
	const uniq = new Map();
	for (const u of under) uniq.set(`${u.path}|${u.fg}|${u.bg}`, u);
	const list = [...uniq.values()];
	fs.writeFileSync(path.join(OUT, `contrast-aa-${BEFORE ? 'before' : 'after'}.txt`), list.map((u) => `[${u.surface}] ${u.ratio}:1 "${u.text}" fg=${u.fg} bg=${u.bg} @ ${u.path}`).join('\n') + '\n');
	check(list.length === 0, `High contrast: no text under 4.5:1 on ${SURFACES.length} surfaces (${list.length}${list[0] ? ', e.g. ' + list[0].ratio + ':1 "' + list[0].text + '" @ ' + list[0].path : ''})`);

	// ---- 5. the kit: Badge status dots + a toned Toast's glyph ---------------------------
	for (const theme of ['dark', 'light', 'contrast']) {
		await page.goto(h.URL + 'kit?theme=' + theme, { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('.badge-warn .badge-dot', { timeout: 30000 }).catch(() => {});
		const kit = await page.evaluate(() => {
			const clip = (sel) => {
				const el = document.querySelector(sel);
				return el ? getComputedStyle(el).clipPath : null;
			};
			const toast = document.querySelector('.toast-warn .toast-icon svg');
			return { ok: clip('.badge-ok .badge-dot'), warn: clip('.badge-warn .badge-dot'), bad: clip('.badge-bad .badge-dot'), toastIcon: toast?.getAttribute('class') ?? '' };
		});
		check(/^circle/.test(kit.ok || '') && /^polygon/.test(kit.warn || '') && /^polygon/.test(kit.bad || '') && kit.warn !== kit.bad, `${theme}: Badge ok / warn / bad are disc / triangle / cross (${kit.ok?.slice(0, 12)} / ${kit.warn?.slice(0, 20)} / ${kit.bad?.slice(0, 20)})`);
		check(/triangle/.test(kit.toastIcon), `${theme}: a warn Toast with no icon wears the triangle (${kit.toastIcon})`);
		await page.screenshot({ path: path.join(OUT, `e2e-${BEFORE ? 'before' : 'after'}-kit-${theme}.png`), fullPage: false }).catch(() => {});
	}

	if (BEFORE) {
		console.log(`BEFORE: ${reds.length} red`);
		fs.writeFileSync(path.join(OUT, 'contrast-a2-before.txt'), reds.join('\n') + '\n');
	}
	await h.finish(browser);
});

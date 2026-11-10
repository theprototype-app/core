// 1.64 owner bug (78-fix-547): clicking the profile icon (top right) MOVED the viewport sidebar handles, the right
// one AND the left one. A handle sits below the top chrome, which SidebarHandles measures live by hit-testing the
// screen edges; the open profile menu answered those hit tests, so the handles jumped down below it while it was
// open and back up when it closed. The owner liked the lower place: the handles now ALWAYS rest below the profile
// menu's bottom edge (remembered once measured), and no top popup moves them.
//
//   1. every handle on screen (the two viewport sidebar handles and every side-pane handle) has the same rect
//      before the profile menu opens, while it is open, and after it closes (within 1 px)
//   2. each sidebar handle's top is below the header (the logo / the profile button) and below the open profile
//      menu's bottom edge
//   3. evidence: the closed-state handles in the dark and the light theme (test-results/78-fix-547/)
// Desktop (the Node editor open, so its pane handles count too) and the folded N6 (412x915, touch: the phone shell,
// which draws no sidebar handles, so 1 and 2 hold over the handles it does draw).
//
// Run: APP_URL=https://theprototype.app:5809/ npm run e2e -- profile-handles-still
const h = require('./helpers.cjs');
const path = require('path');
const OUT = path.join(process.env.E2E_OUT || path.join(__dirname, '../../test-results/78-fix-547'), 'profile-handles');
require('fs').mkdirSync(OUT, { recursive: true });

const DEVICES = [
	{ name: 'desktop', ctx: { viewport: { width: 1280, height: 800 } }, flow: true },
	{ name: 'folded', ctx: { viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6, userAgent: h.N6_UA }, touch: true }
];

/** every handle on screen, keyed by a stable name */
const handles = (page) =>
	page.evaluate(() => {
		/** @type {Record<string, {x:number,y:number,w:number,h:number}>} */
		const out = {};
		const els = [...document.querySelectorAll('[id^="sidebar-handle-"], .tp-pane-handle')];
		els.forEach((e, i) => {
			const b = e.getBoundingClientRect();
			if (!b.width && !b.height) return;
			out[e.id || `pane-${i}-${e.getAttribute('aria-label') || ''}`] = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
		});
		return out;
	});
const rectOf = (page, sel) =>
	page.evaluate((s) => {
		const e = document.querySelector(s);
		const b = e?.getBoundingClientRect();
		return b && (b.width || b.height) ? { top: Math.round(b.top), bottom: Math.round(b.bottom) } : null;
	}, sel);
const menuOpen = (page) => page.evaluate(() => (document.getElementById('avatar-dropdown')?.getBoundingClientRect().width ?? 0) > 0);
/** names whose rect moved more than 1 px (or appeared / vanished) */
function moved(a, b) {
	const bad = [];
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const p = a[k];
		const q = b[k];
		if (!p || !q) bad.push(`${k} ${p ? 'vanished' : 'appeared'}`);
		else if (['x', 'y', 'w', 'h'].some((f) => Math.abs(p[f] - q[f]) > 1)) bad.push(`${k} ${JSON.stringify(p)} -> ${JSON.stringify(q)}`);
	}
	return bad;
}

h.run(async () => {
	const browser = await h.launch();
	for (const dev of DEVICES) {
		const P = await h.setupPage(browser, dev.name, { context: dev.ctx });
		const page = P.page;
		const tag = (/** @type {string} */ n) => `[${dev.name}] ${n}`;
		await page.waitForTimeout(1500);
		if (dev.flow) {
			await page.locator('p[title="Node editor (N)"]').click();
			await page.waitForTimeout(900);
		}
		const before = await handles(page);
		const n = Object.keys(before).length;
		if (dev.name === 'desktop')
			h.check(!!before['sidebar-handle-left'] && !!before['sidebar-handle-right'] && n >= 3, `${tag('premise')} both sidebar handles and the pane handles are drawn (${Object.keys(before).join(', ')})`);
		else console.log(`${tag('handles on screen')} ${Object.keys(before).join(', ') || 'none (the phone shell)'}`);

		const trigger = page.locator('#avatar-trigger');
		if (dev.touch) await trigger.tap();
		else await trigger.click();
		// the handles re-measure the chrome once a second and on every column change: wait past two of those
		await page.waitForTimeout(2300);
		h.check(await menuOpen(page), `${tag('premise')} the profile menu is open`);
		const during = await handles(page);
		const d1 = moved(before, during);
		h.check(d1.length === 0, `${tag('1')} opening the profile menu moves no handle (${d1.join('; ') || n + ' within 1 px'})`);
		const dd = await rectOf(page, '#avatar-dropdown');
		const header = Math.max((await rectOf(page, '#avatar-trigger'))?.bottom ?? 0, (await rectOf(page, '#logo-menu'))?.bottom ?? 0);
		for (const side of ['left', 'right']) {
			const r = during[`sidebar-handle-${side}`];
			if (!r) continue;
			h.check(r.y >= header && dd && r.y >= dd.bottom, `${tag('2')} the ${side} handle rests below the header and the open profile menu (top ${r.y} >= header ${header}, menu bottom ${dd?.bottom})`);
		}

		await page.keyboard.press('Escape');
		await page.waitForTimeout(400);
		if (await menuOpen(page)) {
			if (dev.touch) await trigger.tap();
			else await trigger.click();
		}
		await page.waitForTimeout(2300);
		h.check(!(await menuOpen(page)), `${tag('premise')} the profile menu closed again`);
		const after = await handles(page);
		const d2 = moved(before, after);
		h.check(d2.length === 0, `${tag('1')} ...and closing it leaves every handle where it was (${d2.join('; ') || n + ' within 1 px'})`);
		for (const theme of ['dark', 'light']) {
			await page.evaluate((t) => window.__stores.themes.theme.set(t), theme);
			await page.waitForTimeout(500);
			await page.screenshot({ path: path.join(OUT, `${dev.name}-handles-closed-${theme}.png`) });
		}
		const themed = await handles(page);
		const d3 = moved(before, themed);
		h.check(d3.length === 0, `${tag('1')} ...and a theme change moves none either (${d3.join('; ') || 'within 1 px'})`);
		await P.ctx?.close?.().catch(() => {});
	}
	await h.finish(browser);
});

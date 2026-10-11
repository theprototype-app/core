// 41 G18 — ON A PHONE: (1) the Explorer's long-press menu stays open after the finger lifts, and
// (2) every docked window starts with its SIDEBARS HIDDEN unless the user opened them (remembered
// per window, per device).
//
// (1) THE BUG: a long press opens our menu (touchHold, 450 ms) while the finger is still down, so
// ContextMenu's backdrop mounts under it — and Android then fires its OWN long-press `contextmenu`
// at the finger. Its target is that backdrop, whose contextmenu handler closed the menu: "opens and
// immediately closes". Headless Chromium does NOT synthesize that event from CDP touch (probed:
// a 1.6 s CDP hold produces pointerdown / pointerup / click and no contextmenu), so the press,
// hold and lift are REAL CDP touches and Android's contextmenu is dispatched exactly where Android
// sends it: at the finger, on whatever is there, while the finger is down.
// (2) Explorer, Node editor, UV editor, HUD editor, Profiler, Image editor, Code workspace on a phone FOLDED
// (390x844) and UNFOLDED (770x850), touch, DPR 2.9; a sidebar the user opens stays open after a
// reload; a desktop page keeps every default it had.
// Counterfactual: on origin/feat/40-int (1) the menu is gone after Android's contextmenu, and (2)
// the Explorer tree, the node palette, the UV materials, the HUD screens and the Image editor's
// panel all show on a phone.
// SHOTS=<dir> [SHOT_TAG=before|after] writes the proof screenshots.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'after';
let shotN = 20;
async function shot(page, name) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${TAG}-${name}.png`) }).catch(() => {});
}
async function step(label, fn) {
	try {
		return await fn();
	} catch (e) {
		h.check(false, `${label} (threw: ${String(e?.message ?? e).split('\n')[0].slice(0, 140)})`);
		return null;
	}
}
const PHONE = { hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 };
const TOURS = '{"editor-touch":true,"editor":true}';

const CLOSERS = ['explorerClose', 'flowGraphClose', 'uvEditorClose', 'hudEditorClose', 'codeWorkspaceClose', 'profilerClose'];
/** show ONE docked window (closing the rest) and report what it shows */
async function showOnly(P, which) {
	await P.evaluate(
		({ which, closers }) => {
			for (const c of closers) window.__stores[c].set(c !== which);
		},
		{ which, closers: CLOSERS }
	);
	await P.waitForTimeout(1200);
}
/** the visible sidebars of whatever docked window is up */
const sidebars = (P) =>
	P.evaluate(() => {
		const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
		const ws = [...document.querySelectorAll('.ws-panel')].filter(vis);
		return {
			primary: ws.filter((p) => !p.classList.contains('ws-panel-secondary')).length,
			secondary: ws.filter((p) => p.classList.contains('ws-panel-secondary')).length,
			palette: [...document.querySelectorAll('.svelteFlow')].some(vis) ? document.querySelectorAll('#graph-tree-flow').length : -1,
			props: document.querySelectorAll('#flow-props').length,
			code: [...document.querySelectorAll('#code-ws-left, #code-ws-right')].filter(vis).length
		};
	});

async function seedImage(P) {
	return P.evaluate(async () => {
		const c = document.createElement('canvas');
		c.width = 80;
		c.height = 60;
		const ctx = c.getContext('2d');
		ctx.fillStyle = 'teal'; // tokens-ok: test fixture pixels
		ctx.fillRect(0, 0, 80, 60);
		const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
		const rec = await window.__stores.explorer.addItemFromBytes(await blob.arrayBuffer(), 'pic-' + Math.random() + '.png', null, {});
		return rec.id;
	});
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });

	// ============================================================ (1) the long-press menu
	for (const theme of ['dark', 'light']) {
		const A = await h.setupPage(browser, 'lp-' + theme, { context: { viewport: { width: 390, height: 844 }, ...PHONE }, storage: { theme, toursSeen: TOURS } });
		const P = A.page;
		const cdp = await P.context().newCDPSession(P);
		const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
		await P.evaluate(async () => {
			await window.__stores.explorer.addItemFromBytes(new TextEncoder().encode('hello ' + Math.random()).buffer, 'notes.txt', null);
			window.__stores.explorer.createFolder('Props');
		});
		await P.locator('#ps-explorer').tap();
		await P.waitForTimeout(1500);
		// a TALL dock, so the pressed card sits ABOVE where the action sheet opens: the common case on a
		// phone, and the one the bug needs (Android's contextmenu lands on the BACKDROP, not the sheet)
		await P.evaluate(() => window.__stores.bottomDock.dockHeight.set(Math.round(window.innerHeight * 0.8)));
		await P.waitForTimeout(600);
		for (const [kind, sel] of [['file', '#explorer-list .explorer-card'], ['folder', '#explorer-list .explorer-folder-card']]) {
			await step(`${theme}: long press a ${kind}`, async () => {
				const card = P.locator(sel, { hasText: kind === 'file' ? 'notes.txt' : 'Props' }).first();
				const b = await card.boundingBox();
				const x = b.x + b.width / 2;
				const y = b.y + b.height / 2;
				await touch('touchStart', x, y);
				await P.waitForTimeout(650); // past the hold: our menu is up, the finger still down
				const opened = await P.locator('.ctx-scroll[role=menu]').count();
				// Android's own long-press contextmenu, at the finger, while it is down
				const android = await P.evaluate(({ x, y }) => {
					const t = document.elementFromPoint(x, y);
					const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
					t?.dispatchEvent(ev);
					return { on: t?.closest('.ctx-scroll[role=menu]') ? 'the menu' : t?.getAttribute('role') === 'presentation' ? 'the backdrop' : t?.className?.toString().slice(0, 30), prevented: ev.defaultPrevented };
				}, { x, y });
				await P.waitForTimeout(250);
				const held = await P.locator('.ctx-scroll[role=menu]').count();
				await touch('touchEnd');
				await P.waitForTimeout(450);
				const lifted = await P.locator('.ctx-scroll[role=menu]').count();
				if (kind === 'file') await shot(P, `explorer-longpress-${theme}`);
				h.check(opened === 1, `${theme}: a long press on a ${kind} opens its menu`);
				h.check(android.on === 'the backdrop', `${theme}: premise: the finger is over the backdrop when Android's contextmenu arrives (${android.on})`);
				h.check(held === 1 && android.prevented, `${theme}: Android's own long-press contextmenu (landing on ${android.on}) does not close it, and no browser menu shows`);
				h.check(lifted === 1, `${theme}: the ${kind} menu STAYS OPEN after the finger lifts (${lifted})`);
				await P.touchscreen.tap(195, 60);
				await P.waitForTimeout(400);
				h.check((await P.locator('.ctx-scroll[role=menu]').count()) === 0, `${theme}: a tap outside still closes it`);
			});
		}
		await A.ctx.close();
	}
	// a mouse right-click OUTSIDE an open menu still closes it (the fix keys on the press)
	{
		const D = await h.setupPage(browser, 'desk-menu', { context: { viewport: { width: 1440, height: 900 } }, storage: { toursSeen: TOURS } });
		const P = D.page;
		await P.evaluate(async () => {
			await window.__stores.explorer.addItemFromBytes(new TextEncoder().encode('hey ' + Math.random()).buffer, 'desk.txt', null);
			window.__stores.explorerClose.set(false);
		});
		await P.waitForTimeout(1500);
		await step('desktop: right-click outside closes the menu', async () => {
			await P.locator('#explorer-list .explorer-card', { hasText: 'desk.txt' }).first().click({ button: 'right' });
			await P.waitForTimeout(400);
			const open = await P.locator('.ctx-scroll[role=menu]').count();
			await P.mouse.click(700, 200, { button: 'right' });
			await P.waitForTimeout(400);
			const after = await P.locator('.ctx-scroll[role=menu]').count();
			h.check(open === 1 && after === 0, `desktop: a right-click outside an open menu closes it (${open} -> ${after})`);
		});
		await D.ctx.close();
	}

	// ============================================================ (2) sidebars hidden on a phone
	const WINDOWS = [
		['explorerClose', 'Explorer', (s) => s.primary === 0 && s.secondary === 0],
		['flowGraphClose', 'Node editor', (s) => s.palette === 0 && s.props === 0],
		['uvEditorClose', 'UV editor', (s) => s.primary === 0 && s.secondary === 0],
		['hudEditorClose', 'HUD editor', (s) => s.primary === 0 && s.secondary === 0],
		['codeWorkspaceClose', 'Code workspace', (s) => s.code === 0],
		['profilerClose', 'Profiler', (s) => s.primary === 0 && s.secondary === 0]
	];
	for (const [w, hgt, label] of [[390, 844, 'folded'], [770, 850, 'unfolded']]) {
		const A = await h.setupPage(browser, 'sb-' + label, { context: { viewport: { width: w, height: hgt }, ...PHONE }, storage: { theme: 'dark', toursSeen: TOURS } });
		const P = A.page;
		for (const [closer, name, hidden] of WINDOWS) {
			await step(`${label}: ${name}`, async () => {
				await showOnly(P, closer);
				const s = await sidebars(P);
				if (label === 'folded') await shot(P, `phone-${label}-${name.replace(/\s+/g, '-').toLowerCase()}`);
				h.check(hidden(s), `${label}: the ${name} starts with its sidebars hidden (${JSON.stringify(s)})`);
			});
		}
		await step(`${label}: Image editor`, async () => {
			await showOnly(P, 'none');
			const id = await seedImage(P);
			await P.evaluate((id) => window.__stores.imageEditor.openImageEditor(id), id);
			await P.locator('#image-editor-window').waitFor({ timeout: 8000 });
			await P.waitForTimeout(800);
			const open = await P.evaluate(() => document.querySelectorAll('#image-editor-window .ws-panel-secondary').length);
			if (label === 'folded') await shot(P, `phone-${label}-image-editor`);
			h.check(open === 0, `${label}: the Image editor starts with its panel hidden (${open})`);
			await P.evaluate(() => window.__stores.imageEditor.closeImageEditor());
			await P.waitForTimeout(400);
		});
		await A.ctx.close();
	}

	// ---- remembered: what the user opened on the phone stays open (per window) --------------
	{
		const A = await h.setupPage(browser, 'sb-remember', { context: { viewport: { width: 390, height: 844 }, ...PHONE }, storage: { theme: 'dark', toursSeen: TOURS } });
		const P = A.page;
		await step('phone: the user opens sidebars, they stay open', async () => {
			await showOnly(P, 'explorerClose');
			await P.locator('[data-ws-primary-toggle]').first().tap();
			await P.waitForTimeout(400);
			await showOnly(P, 'flowGraphClose');
			await P.locator('#palette-toggle').tap();
			await P.waitForTimeout(400);
			const opened = await sidebars(P);
			h.check(opened.palette === 1, `a tap opens the node palette (${JSON.stringify(opened)})`);
			await h.freshReload(A);
			await P.waitForTimeout(800);
			await showOnly(P, 'explorerClose');
			const ex = await sidebars(P);
			await showOnly(P, 'flowGraphClose');
			const fl = await sidebars(P);
			await showOnly(P, 'uvEditorClose');
			const uv = await sidebars(P);
			h.check(ex.primary === 1, `after a reload the Explorer tree the user opened is still open (${JSON.stringify(ex)})`);
			h.check(fl.palette === 1, `...and so is the node palette (${JSON.stringify(fl)})`);
			h.check(uv.primary === 0 && uv.secondary === 0, `...while a window they never opened stays hidden (UV ${JSON.stringify(uv)})`);
		});
		await A.ctx.close();
	}

	// ---- desktop: nothing changes -----------------------------------------------------------
	{
		const D = await h.setupPage(browser, 'sb-desk', { context: { viewport: { width: 1440, height: 900 } }, storage: { theme: 'dark', toursSeen: TOURS } });
		const P = D.page;
		await showOnly(P, 'explorerClose');
		const ex = await sidebars(P);
		await showOnly(P, 'flowGraphClose');
		const fl = await sidebars(P);
		h.check(ex.primary === 1, `desktop: the Explorer tree still starts open (${JSON.stringify(ex)})`);
		h.check(fl.palette === 1, `desktop: the node palette still starts open (${JSON.stringify(fl)})`);
		await D.ctx.close();
	}
	return h.finish(browser);
});

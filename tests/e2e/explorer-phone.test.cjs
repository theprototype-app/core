// 40 F3 — THE EXPLORER ON A PHONE (390x844, touch, REAL touch events through CDP):
//   - a LONG PRESS on a file or folder opens its menu as the phone action sheet, never the
//     browser's own long-press (Android started a NATIVE drag of the card — the ghost in
//     long-press-explorer-file); the callout is off on Explorer items only;
//   - hold, then MOVE: the menu gives way to the touch pick-up (the drag still works);
//   - the rename field's selected text reads in dark AND light (the kit's accent pair);
//   - the docked toolbar scrolls sideways (ui/ScrollStrip) so the project name is reachable.
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;

function lum(hex) {
	const c = hex.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => Number(v) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	for (const theme of ['dark', 'light']) {
		const A = await h.setupPage(browser, 'phone-' + theme, {
			context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
			storage: { theme, toursSeen: '{"editor-touch":true,"editor":true}' }
		});
		const P = A.page;
		const cdp = await P.context().newCDPSession(P);
		const down = (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
		const moveTo = (x, y) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
		const up = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		// an action sheet closes on a tap on its backdrop (a phone has no Escape key)
		const closeSheet = async () => {
			if ((await P.locator('.ctx-scroll[role=menu]').count()) === 0) return;
			await P.touchscreen.tap(195, 60);
			await P.waitForTimeout(400);
		};
		await P.evaluate(async () => {
			const ex = window.__stores.explorer;
			ex.createFolder('Props');
			await ex.addItemFromBytes(new TextEncoder().encode('hello ' + Math.random()).buffer, 'notes.txt', null);
			window.__nativeDrags = 0;
			window.addEventListener('dragstart', (e) => { if (!e.defaultPrevented) window.__nativeDrags++; });
		});
		await P.locator('#ps-explorer').tap();
		await P.waitForTimeout(1500);
		const card = P.locator('#explorer-list .explorer-card', { hasText: 'notes.txt' }).first();
		const folderCard = P.locator('#explorer-list .explorer-folder-card', { hasText: 'Props' }).first();
		h.check((await card.count()) === 1 && (await folderCard.count()) === 1, `${theme}: the seeded file and folder show in the docked Explorer`);
		// (Chromium drops -webkit-touch-callout itself — iOS honours it — so the marker + user-select are read)
		const callout = await card.evaluate((el) => ({ hold: el.dataset.touchHold, select: getComputedStyle(el).userSelect }));
		h.check(callout.hold === '1' && callout.select === 'none', `${theme}: Explorer items take over the long press and the text-select callout (${JSON.stringify(callout)})`);
		const outside = await P.evaluate(() => document.querySelectorAll('[data-touch-hold]:not(#explorer-list *)').length);
		h.check(outside === 0, `${theme}: ...on Explorer items only, not the app (${outside})`);

		// ---- long press a FILE: the phone action sheet ----------------------------------------
		const b = await card.boundingBox();
		await down(b.x + b.width / 2, b.y + b.height / 2);
		await P.waitForTimeout(100);
		// the browser's own touch contextmenu (Android fires one on a long press) belongs to the
		// hold: swallowed in capture, so the card's handler never opens a menu of its own
		const swallowed = await card.evaluate(async (el) => {
			const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
			el.dispatchEvent(ev);
			await new Promise((r) => setTimeout(r, 120));
			return { prevented: ev.defaultPrevented, menus: document.querySelectorAll('.ctx-scroll[role=menu]').length };
		});
		await P.waitForTimeout(600);
		await up();
		await P.waitForTimeout(500);
		const sheet = await P.evaluate(() => {
			const m = document.querySelector('.ctx-scroll[role=menu]');
			if (!m) return null;
			const r = m.getBoundingClientRect();
			return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), text: m.textContent.slice(0, 200), menus: document.querySelectorAll('.ctx-scroll[role=menu]').length };
		});
		h.check(!!sheet && sheet.left === 0 && sheet.right === 390 && sheet.bottom >= 760, `${theme}: a long press on a file opens its menu as a bottom action sheet (${JSON.stringify(sheet && { ...sheet, text: undefined })})`);
		h.check(!!sheet && /Rename/.test(sheet.text) && sheet.menus === 1, `${theme}: ...the FILE's menu, once (${sheet?.menus})`);
		h.check(swallowed.prevented && swallowed.menus === 0, `${theme}: the browser's own touch contextmenu is swallowed — no menu until the hold (${JSON.stringify(swallowed)})`);
		h.check((await P.evaluate(() => window.__nativeDrags)) === 0, `${theme}: no native drag starts from the long press`);

		// ---- rename: the selected text is readable ---------------------------------------------
		await P.locator('.ctx-scroll[role=menu] [role=menuitem]', { hasText: /Rename/ }).first().tap();
		await P.waitForTimeout(500);
		const sel = await P.evaluate(() => {
			const i = document.querySelector('input.ex-edit');
			if (!i) return null;
			const s = getComputedStyle(i, '::selection');
			return { bg: s.backgroundColor, fg: s.color, focused: document.activeElement === i, selected: i.selectionEnd - i.selectionStart };
		});
		h.check(!!sel && sel.focused && sel.selected > 0, `${theme}: Rename opens the inline field with the name selected (${JSON.stringify(sel)})`);
		const ratio = sel ? contrast(sel.fg, sel.bg) : 0;
		h.check(ratio >= 4.5, `${theme}: the selected text contrasts with its selection colour (${ratio.toFixed(2)}:1, ${sel?.fg} on ${sel?.bg})`);
		await P.keyboard.press('Escape');
		await P.waitForTimeout(400);

		// ---- long press a FOLDER --------------------------------------------------------------
		const f = await folderCard.boundingBox();
		await down(f.x + f.width / 2, f.y + f.height / 2);
		await P.waitForTimeout(700);
		await up();
		await P.waitForTimeout(500);
		const fmenu = await P.evaluate(() => document.querySelector('.ctx-scroll[role=menu]')?.textContent ?? '');
		h.check(/Properties/.test(fmenu) && /Rename/.test(fmenu), `${theme}: a long press on a folder opens the folder's action sheet (${fmenu.slice(0, 80)})`);
		await closeSheet();
		h.check((await P.locator('.ctx-scroll[role=menu]').count()) === 0, `${theme}: premise: the menu closed`);

		// ---- hold, then MOVE: the menu gives way to the pick-up --------------------------------
		const b2 = await card.boundingBox();
		await down(b2.x + b2.width / 2, b2.y + b2.height / 2);
		await P.waitForTimeout(700);
		const menuWhileHeld = await P.locator('.ctx-scroll[role=menu]').count();
		for (let i = 1; i <= 8; i++) await moveTo(b2.x + b2.width / 2, b2.y + b2.height / 2 - i * 20);
		await P.waitForTimeout(200);
		const mid = await P.evaluate(() => ({ menus: document.querySelectorAll('.ctx-scroll[role=menu]').length, ghost: !!document.getElementById('explorer-touch-ghost') }));
		await up();
		await P.waitForTimeout(400);
		await closeSheet();
		h.check(menuWhileHeld === 1 && mid.menus === 0 && mid.ghost, `${theme}: hold then move: the menu closes and the card is picked up (${menuWhileHeld} -> ${JSON.stringify(mid)})`);

		// ---- the toolbar scrolls sideways; the project name is reachable -----------------------
		const strip = await P.evaluate(() => {
			const s = document.getElementById('explorer-dock-strip');
			const idc = document.getElementById('explorer-identity');
			if (!s || !idc) return null;
			return { over: s.scrollWidth - s.clientWidth, idW: idc.getBoundingClientRect().width };
		});
		h.check(!!strip && strip.over > 0, `${theme}: the docked toolbar is a sideways strip that overflows on a phone (${JSON.stringify(strip)})`);
		const sr = await P.locator('#explorer-dock-strip').boundingBox();
		await down(sr.x + sr.width - 20, sr.y + sr.height / 2);
		for (let i = 1; i <= 10; i++) await moveTo(sr.x + sr.width - 20 - i * 30, sr.y + sr.height / 2);
		await up();
		await P.waitForTimeout(400);
		const after = await P.evaluate(() => {
			const s = document.getElementById('explorer-dock-strip');
			const idc = document.getElementById('explorer-identity');
			const sr = s.getBoundingClientRect();
			const ir = idc.getBoundingClientRect();
			const names = [...idc.querySelectorAll('.truncate')].map((n) => n.scrollWidth <= n.clientWidth + 1);
			return { scrollLeft: s.scrollLeft, inside: ir.left >= sr.left - 1 && ir.right <= sr.right + 1, full: names.every(Boolean) };
		});
		h.check(after.scrollLeft > 0 && after.inside && after.full, `${theme}: a finger scrolls the strip and the project name shows whole (${JSON.stringify(after)})`);
		await A.ctx.close();
	}
	await h.finish(browser);
});

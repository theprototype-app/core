// 41 G12 — NOTES ON A PHONE: A NOTE IS A PAGE OF THE NOTES SHEET.
// The user: "notes on mobile, when open a note, the drawer closes and I cannot traverse through
// other by clicking previous/next, and when note closes i have to again open drawer for notes".
// OPPO N6 FOLDED (390x896, DPR 2.9, touch; real CDP touches):
//   - tapping a note in the Notes drawer opens its card OVER the drawer at the drawer's height,
//     and the drawer stays OPEN underneath;
//   - the card walks the note's group with ‹ › (pin order, wrapping) and says where it is (n/N);
//   - closing the card (✕, or swiping it down) returns to the list — the drawer is still there
//     with its scroll position, nothing to re-open;
//   - the grab bar resizes the notes sheet: the card and the drawer stay one height.
// Then the desktop: the side drawer and the anchored card are unchanged, and the card's ‹ › walk too.
const h = require('./helpers.cjs');

const store = (name) => `(() => { let v; window.__stores.${name}.subscribe((x) => (v = x))(); return v; })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOT_DIR || '';

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'folded', {
		context: { viewport: { width: 390, height: 896 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.9 },
		storage: { toursSeen: '{"editor-touch":true,"editor":true}' }
	});
	const P = A.page;
	const cdp = await P.context().newCDPSession(P);
	const T = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
	const tap = async (x, y) => {
		await T('touchStart', [{ x, y, id: 1 }]);
		await sleep(40);
		await T('touchEnd', []);
	};
	const drag = async (x, y0, y1, steps = 10) => {
		await T('touchStart', [{ x, y: y0, id: 1 }]);
		for (let i = 1; i <= steps; i++) {
			await T('touchMove', [{ x, y: y0 + ((y1 - y0) * i) / steps, id: 1 }]);
			await sleep(16);
		}
		await sleep(120);
		await T('touchEnd', []);
	};
	const read = (expr) => P.evaluate(expr);
	const rect = (sel) =>
		P.evaluate((s) => {
			const e = document.querySelector(s);
			if (!e) return null;
			const r = e.getBoundingClientRect();
			return r.width || r.height ? { x: r.x, y: r.y, w: r.width, h: r.height, top: r.top, bottom: r.bottom } : null;
		}, sel);
	const tapSel = async (sel) => {
		const b = await rect(sel);
		if (!b) return false;
		await tap(b.x + b.w / 2, b.y + b.h / 2);
		return true;
	};
	h.check(await read(() => document.documentElement.classList.contains('phone-shell')), 'the phone shell is mounted (N6 folded)');

	// 14 notes: 4 labelled "mech" (so a group walk has neighbours), the rest General — enough to scroll
	const ids = await P.evaluate(async () => {
		const s = window.__stores;
		for (let i = 0; i < 4; i++) s.commandsHandler.sceneCommand('/create box');
		let g;
		for (let t = 0; t < 100; t++) {
			s.objectsGroup.subscribe((v) => (g = v))();
			if (g?.children?.length >= 4) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		const out = [];
		for (let i = 0; i < 14; i++) {
			s.annotationsHandler.addAnnotation(g.children[i % g.children.length].uuid);
			let list;
			s.annotationsHandler.annotations.subscribe((v) => (list = v))();
			const a = list[list.length - 1];
			out.push(a?.id);
		}
		s.annotationsHandler.activeAnnotation.set(null);
		let list;
		s.annotationsHandler.annotations.subscribe((v) => (list = v))();
		list.forEach((a, i) => s.annotationsHandler.setAnnotation({ ...a, name: `Note ${i + 1}`, text: `Description of note ${i + 1}`, label: i % 3 === 0 ? 'mech' : '' }));
		return list.map((a) => a.id);
	});
	h.check(ids.length === 14, `premise: 14 notes (${ids.length})`);
	await P.waitForTimeout(600);

	// ---- open the drawer, scroll it, open a note ------------------------------------------
	await P.evaluate(() => window.__stores.notesDrawerOpen.set(true));
	await P.waitForTimeout(900);
	const drawer0 = await rect('#notes-drawer');
	h.check(!!drawer0, `the Notes drawer opens (${JSON.stringify(drawer0)})`);
	const scrolled = await P.evaluate(() => {
		const b = document.querySelector('#notes-drawer .notes-body');
		b.scrollTop = 120;
		return b.scrollTop;
	});
	h.check(scrolled > 40, `premise: the notes list scrolls (scrollTop ${scrolled})`);
	await P.waitForTimeout(300);
	if (SHOTS) await P.screenshot({ path: `${SHOTS}/g12-folded-1-list.png` });
	// the first visible "mech" note row
	const row = await P.evaluate(() => {
		const rows = [...document.querySelectorAll('#notes-drawer .notes-row')];
		const body = document.querySelector('#notes-drawer .notes-body').getBoundingClientRect();
		const r = rows.map((el) => ({ el, b: el.getBoundingClientRect() })).find((x) => x.b.top > body.top + 4 && x.b.bottom < body.bottom - 4 && /Note (1|4|7|10|13)\b/.test(x.el.textContent || ''));
		const btn = r?.el.querySelector('button');
		const b = btn?.getBoundingClientRect();
		return b ? { x: b.x + Math.min(60, b.width / 2), y: b.y + b.height / 2, text: (r.el.textContent || '').trim().slice(0, 30) } : null;
	});
	h.check(!!row, `premise: a "mech" note row is visible (${row?.text})`);
	await tap(row.x, row.y);
	await P.waitForTimeout(900);
	const active1 = await read(`${store('annotationsHandler.activeAnnotation')}?.id`);
	h.check(!!active1, 'tapping a note opens its card');
	h.check(await read(store('notesDrawerOpen')), 'the Notes drawer stays OPEN while the note is open (drill-in, not a replacement)');
	const card = await rect('.note-card');
	const drawer1 = await rect('#notes-drawer');
	h.check(!!card && !!drawer1 && Math.abs(card.top - drawer1.top) < 3 && Math.abs(card.bottom - drawer1.bottom) < 3, `the card covers the drawer exactly — a page of the same sheet (card ${Math.round(card?.top)}-${Math.round(card?.bottom)}, drawer ${Math.round(drawer1?.top)}-${Math.round(drawer1?.bottom)})`);
	if (SHOTS) {
		await P.screenshot({ path: `${SHOTS}/g12-folded-2-note-dark.png` });
		await P.evaluate(() => window.__stores.themes?.theme?.set('light'));
		await P.waitForTimeout(500);
		await P.screenshot({ path: `${SHOTS}/g12-folded-2-note-light.png` });
		await P.evaluate(() => window.__stores.themes?.theme?.set('dark'));
		await P.waitForTimeout(300);
	}

	// ---- ‹ › walk the group --------------------------------------------------------------
	const walk = await P.evaluate(() => {
		let list;
		window.__stores.annotationsHandler.annotations.subscribe((v) => (list = v))();
		let act;
		window.__stores.annotationsHandler.activeAnnotation.subscribe((v) => (act = v))();
		return window.__stores.annotationsHandler.noteGroupWalk(list, act.id);
	});
	h.check(walk.label === 'mech' && walk.ids.length === 5, `premise: the open note is in "mech" (5 notes) — ${walk.label} ${walk.ids.length}`);
	const posText = () => P.evaluate(() => document.querySelector('.note-card .note-pos')?.textContent?.trim() ?? null);
	h.check((await posText()) === `${walk.index + 1}/5`, `the card says where it is in its group (${await posText()})`);
	h.check(await tapSel('#note-next'), 'the card has a Next button');
	await P.waitForTimeout(700);
	h.check((await read(`${store('annotationsHandler.activeAnnotation')}?.id`)) === walk.next, 'Next opens the next note of the group in the same card');
	h.check(await read(store('notesDrawerOpen')), '...and the drawer is still open under it');
	h.check(await tapSel('#note-prev'), 'the card has a Previous button');
	await P.waitForTimeout(700);
	h.check((await read(`${store('annotationsHandler.activeAnnotation')}?.id`)) === active1, 'Previous goes back to the first note');
	// wrap: walk Previous from the first of the group lands on the last
	await P.evaluate((id) => window.__stores.annotationsHandler.openAnnotation(id, 'view'), walk.ids[0]);
	await P.waitForTimeout(500);
	await tapSel('#note-prev');
	await P.waitForTimeout(600);
	h.check((await read(`${store('annotationsHandler.activeAnnotation')}?.id`)) === walk.ids[walk.ids.length - 1], 'Previous from the first note wraps to the last of the group (the drawer arrows\' walk)');
	h.check((await posText()) === '5/5', `...and reads 5/5 (${await posText()})`);

	// ---- ✕ returns to the list as it was --------------------------------------------------
	await tapSel('.note-card .note-head button[aria-label^="Close note"]');
	await P.waitForTimeout(700);
	h.check(!(await rect('.note-card')), 'Close closes the note');
	h.check(await read(store('notesDrawerOpen')), '...and returns to the list: the drawer is open, nothing to re-open');
	const keptScroll = await P.evaluate(() => document.querySelector('#notes-drawer .notes-body')?.scrollTop ?? -1);
	h.check(keptScroll > 40, `...at the scroll position it was left at (scrollTop ${keptScroll})`);
	if (SHOTS) await P.screenshot({ path: `${SHOTS}/g12-folded-3-back-to-list.png` });

	// ---- swipe the card down: back to the list too ----------------------------------------
	await P.evaluate((id) => window.__stores.annotationsHandler.openAnnotation(id, 'view'), walk.ids[1]);
	await P.waitForTimeout(800);
	const grip = await rect('.note-card [data-sheet-grip]');
	h.check(!!grip, 'the phone card wears the sheet grab bar');
	if (grip) {
		await drag(grip.x + grip.w / 2, grip.y + grip.h / 2, 890, 14);
		await P.waitForTimeout(800);
		h.check(!(await rect('.note-card')) && (await read(store('notesDrawerOpen'))), 'swiping the card down closes the note and leaves the list open');
	}
	// ---- the grab bar resizes the ONE notes sheet --------------------------------------------
	await P.evaluate((id) => window.__stores.annotationsHandler.openAnnotation(id, 'view'), walk.ids[2]);
	await P.waitForTimeout(800);
	const g2 = await rect('.note-card [data-sheet-grip]');
	const c0 = await rect('.note-card');
	await drag(g2.x + g2.w / 2, g2.y + g2.h / 2, g2.y + g2.h / 2 - 120);
	await P.waitForTimeout(600);
	const c1 = await rect('.note-card');
	const d1 = await rect('#notes-drawer');
	h.check(c1 && c1.h - c0.h > 60, `the card's grab bar resizes it (${Math.round(c0.h)} -> ${Math.round(c1?.h ?? 0)})`);
	await P.evaluate(() => window.__stores.annotationsHandler.activeAnnotation.set(null));
	await P.waitForTimeout(500);
	const d2 = await rect('#notes-drawer');
	h.check(d2 && Math.abs(d2.h - c1.h) < 3, `...and the drawer under it is the same height — one sheet (${Math.round(c1?.h ?? 0)} vs ${Math.round(d2?.h ?? 0)})`);
	void d1;

	// ---- a note opened from its PIN (drawer closed) is still a sheet with ‹ › -------------------
	await P.evaluate(() => window.__stores.notesDrawerOpen.set(false));
	await P.waitForTimeout(400);
	await P.evaluate((id) => window.__stores.annotationsHandler.openAnnotation(id, 'view'), walk.ids[0]);
	await P.waitForTimeout(700);
	h.check(!!(await rect('#note-next')), 'a note opened without the drawer also walks its group (‹ ›)');
	await P.evaluate(() => window.__stores.annotationsHandler.activeAnnotation.set(null));

	// ---- desktop: unchanged side drawer, anchored card, the same walk ---------------------------
	const D = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1440, height: 900 } } });
	const Q = D.page;
	await Q.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		for (let i = 0; i < 3; i++) s.annotationsHandler.addAnnotation(g.children[0].uuid);
		s.annotationsHandler.activeAnnotation.set(null);
		s.notesDrawerOpen.set(true);
	});
	await Q.waitForTimeout(900);
	const dd = await Q.evaluate(() => { const r = document.getElementById('notes-drawer').getBoundingClientRect(); return { left: r.left, w: r.width }; });
	h.check(dd.left > 1000 && dd.w <= 330, `desktop: the notes drawer is still the right side drawer (${JSON.stringify(dd)})`);
	await Q.locator('#notes-drawer .notes-row button').first().click();
	await Q.waitForTimeout(800);
	const dc = await Q.evaluate(() => { const c = document.querySelector('.note-card'); return c ? { sheet: c.classList.contains('note-sheet'), next: !!document.getElementById('note-next') } : null; });
	h.check(!!dc && !dc.sheet && dc.next, `desktop: the card is the anchored card (not a sheet) and walks the group too (${JSON.stringify(dc)})`);
	h.check(await Q.evaluate(store('notesDrawerOpen')), 'desktop: the drawer stays open beside the card (as before)');

	await h.finish(browser);
});

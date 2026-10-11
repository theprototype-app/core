// 41 G12 — NOTES ON A PHONE: A NOTE IS A PAGE OF THE NOTES SHEET.
// The user: "notes on mobile, when open a note, the drawer closes and I cannot traverse through
// other by clicking previous/next, and when note closes i have to again open drawer for notes".
// OPPO N6 FOLDED (390x896, DPR 2.9, touch; real CDP touches):
//   - tapping a note in the Notes drawer opens its card OVER the drawer at the drawer's height,
//     and the drawer stays OPEN underneath;
//   - the card walks ALL the notes with ‹ › (pin order, wrapping) and says where it is (n/N) —
//     opened from the drawer AND opened by tapping a note's pin in the scene (orchestrator: "whenever
//     ANY note is open ... previous/next must move through all the notes");
//   - closing the card (✕, or swiping it down) returns to where it came from: the list (still
//     there with its scroll position, nothing to re-open), or the scene (no drawer opened for you);
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
		const ah = s.annotationsHandler;
		for (let i = 0; i < 14; i++) {
			// addAnnotation opens a DRAFT; setAnnotation stores it (the notes-v2 recipe)
			ah.addAnnotation(g.children[i % g.children.length].uuid, [(i % 5) * 1.2 - 2.4, 1 + Math.floor(i / 5) * 0.8, 0]);
			let cur;
			ah.activeAnnotation.subscribe((v) => (cur = v))();
			ah.setAnnotation({ ...cur.draft, name: `Note ${i + 1}`, text: `Description of note ${i + 1}`, label: i % 3 === 0 ? 'mech' : '' });
		}
		ah.activeAnnotation.set(null);
		let list;
		ah.annotations.subscribe((v) => (list = v))();
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
	// the first fully visible note row
	const row = await P.evaluate(() => {
		const rows = [...document.querySelectorAll('#notes-drawer .notes-row')];
		const body = document.querySelector('#notes-drawer .notes-body').getBoundingClientRect();
		const r = rows.map((el) => ({ el, b: el.getBoundingClientRect() })).find((x) => x.b.top > body.top + 4 && x.b.bottom < body.bottom - 4);
		const btn = r?.el.querySelector('button');
		const b = btn?.getBoundingClientRect();
		return b ? { x: b.x + Math.min(60, b.width / 2), y: b.y + b.height / 2, text: (r.el.textContent || '').trim().slice(0, 30) } : null;
	});
	h.check(!!row, `premise: a note row is visible (${row?.text})`);
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

	// ---- ‹ › walk ALL the notes (pin order, wrapping) ---------------------------------------
	const walkOf = () =>
		P.evaluate(() => {
			let list;
			window.__stores.annotationsHandler.annotations.subscribe((v) => (list = v))();
			let act;
			window.__stores.annotationsHandler.activeAnnotation.subscribe((v) => (act = v))();
			return act?.id ? window.__stores.annotationsHandler.noteWalk(list, act.id) : null;
		});
	const activeId = () => read(`${store('annotationsHandler.activeAnnotation')}?.id`);
	const walk = await walkOf();
	h.check(walk && walk.ids.length === 14, `premise: the walk covers all 14 notes (${walk?.ids.length})`);
	const posText = () => P.evaluate(() => document.querySelector('.note-card .note-pos')?.textContent?.trim() ?? null);
	h.check((await posText()) === `${walk.index + 1}/14`, `the card says where it is among all the notes (${await posText()})`);
	h.check(await tapSel('#note-next'), 'the card has a Next button');
	await P.waitForTimeout(700);
	h.check((await activeId()) === walk.ids[walk.index + 1], 'Next opens the next note in pin order in the same card (not only its label group)');
	h.check(await read(store('notesDrawerOpen')), '...and the drawer is still open under it');
	h.check(await tapSel('#note-prev'), 'the card has a Previous button');
	await P.waitForTimeout(700);
	h.check((await activeId()) === active1, 'Previous goes back to the first note');
	// wrap both ways
	await P.evaluate((id) => window.__stores.annotationsHandler.openAnnotation(id, 'view'), walk.ids[0]);
	await P.waitForTimeout(500);
	await tapSel('#note-prev');
	await P.waitForTimeout(600);
	h.check((await activeId()) === walk.ids[13], 'Previous from note 1 wraps to note 14');
	h.check((await posText()) === '14/14', `...and reads 14/14 (${await posText()})`);
	await tapSel('#note-next');
	await P.waitForTimeout(600);
	h.check((await activeId()) === walk.ids[0], 'Next from note 14 wraps to note 1');

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

	// ---- OPENED FROM THE SCENE: tap a note's pin marker (the drawer closed) ---------------------
	await P.evaluate(() => window.__stores.notesDrawerOpen.set(false));
	await P.waitForTimeout(500);
	/** the first single-note marker badge on screen (a cluster is tapped open first) */
	const markerBadge = async () => {
		for (let round = 0; round < 3; round++) {
			const b = await P.evaluate(() => {
				const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.top > 70 && r.bottom < innerHeight - 160 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.marker-badge') === e; };
				const one = [...document.querySelectorAll('.marker-badge:not(.is-cluster)')].find(vis);
				const any = one || [...document.querySelectorAll('.marker-badge.is-cluster')].find(vis);
				if (!any) return null;
				const r = any.getBoundingClientRect();
				return { x: r.x + r.width / 2, y: r.y + r.height / 2, cluster: !one, n: one ? Number(one.querySelector('.marker-num')?.textContent) : 0 };
			});
			if (!b || !b.cluster) return b;
			await tap(b.x, b.y);
			await P.waitForTimeout(500);
		}
		return null;
	};
	const pin = await markerBadge();
	h.check(!!pin && pin.n > 0, `premise: a note's pin marker is on screen to tap (${JSON.stringify(pin)})`);
	if (pin) {
		await tap(pin.x, pin.y);
		await P.waitForTimeout(900);
		const fromScene = await activeId();
		h.check(fromScene === walk.ids[pin.n - 1], `tapping pin #${pin.n} in the scene opens that note`);
		h.check(!(await read(store('notesDrawerOpen'))), '...without opening the Notes drawer');
		// G20: with a selection, the strip rides ABOVE the note card from this entry too (never under or on it)
		const sc = await P.evaluate(() => {
			const st = document.getElementById('ps-strip')?.getBoundingClientRect();
			const c = document.querySelector('.note-card')?.getBoundingClientRect();
			return st && c ? { strip: Math.round(st.bottom), card: Math.round(c.top), h: st.height } : null;
		});
		if (sc && sc.h > 0) h.check(sc.strip <= sc.card + 1, `...and the selection strip rides above the card (${JSON.stringify(sc)})`);
		if (SHOTS) await P.screenshot({ path: `${SHOTS}/g12-folded-4-from-scene.png` });
		h.check((await posText()) === `${pin.n}/14`, `...and the card walks ALL the notes from there (${await posText()})`);
		await tapSel('#note-next');
		await P.waitForTimeout(700);
		h.check((await activeId()) === walk.ids[pin.n % 14], `Next (opened from the scene) goes to note ${(pin.n % 14) + 1}`);
		await tapSel('#note-prev');
		await tapSel('#note-prev');
		await P.waitForTimeout(800);
		h.check((await activeId()) === walk.ids[(pin.n - 2 + 14) % 14], 'Previous twice goes one before the tapped note');
		await tapSel('.note-card .note-head button[aria-label^="Close note"]');
		await P.waitForTimeout(700);
		h.check(!(await rect('.note-card')) && !(await read(store('notesDrawerOpen'))), 'closing returns to where it came from: the scene (no drawer opened for you)');
	}

	// ---- desktop: unchanged side drawer, anchored card, the same walk ---------------------------
	const D = await h.setupPage(browser, 'desktop', { context: { viewport: { width: 1440, height: 900 } } });
	const Q = D.page;
	await Q.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		for (let i = 0; i < 3; i++) {
			s.annotationsHandler.addAnnotation(g.children[0].uuid, [i * 1.5 - 1.5, 1.2, 0]);
			let cur;
			s.annotationsHandler.activeAnnotation.subscribe((v) => (cur = v))();
			s.annotationsHandler.setAnnotation({ ...cur.draft, name: `Desk note ${i + 1}`, text: 'x' });
		}
		s.annotationsHandler.activeAnnotation.set(null);
		s.notesDrawerOpen.set(true);
	});
	await Q.waitForTimeout(900);
	const dd = await Q.evaluate(() => { const r = document.getElementById('notes-drawer').getBoundingClientRect(); return { left: r.left, w: r.width }; });
	h.check(dd.left > 1000 && dd.w <= 330, `desktop: the notes drawer is still the right side drawer (${JSON.stringify(dd)})`);
	await Q.locator('#notes-drawer .notes-row button').first().click();
	await Q.waitForTimeout(800);
	const dc = await Q.evaluate(() => { const c = document.querySelector('.note-card'); return c ? { sheet: c.classList.contains('note-sheet'), next: !!document.getElementById('note-next'), pos: c.querySelector('.note-pos')?.textContent?.trim() } : null; });
	h.check(!!dc && !dc.sheet && dc.next && dc.pos === '1/3', `desktop: the card is the anchored card (not a sheet) and walks all the notes (${JSON.stringify(dc)})`);
	h.check(await Q.evaluate(store('notesDrawerOpen')), 'desktop: the drawer stays open beside the card (as before)');
	// desktop, opened from the SCENE: click a pin marker with the drawer closed
	await Q.evaluate(() => { window.__stores.annotationsHandler.activeAnnotation.set(null); window.__stores.notesDrawerOpen.set(false); });
	await Q.waitForTimeout(600);
	let badge = await Q.evaluate(() => { const e = [...document.querySelectorAll('.marker-badge')].find((b) => b.getBoundingClientRect().width > 0); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, cluster: e.classList.contains('is-cluster') }; });
	if (badge?.cluster) {
		await Q.mouse.click(badge.x, badge.y);
		await Q.waitForTimeout(500);
		badge = await Q.evaluate(() => { const e = [...document.querySelectorAll('.marker-badge:not(.is-cluster)')].find((b) => b.getBoundingClientRect().width > 0); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
	}
	h.check(!!badge, 'desktop premise: a pin marker to click');
	if (badge) {
		await Q.mouse.click(badge.x, badge.y);
		await Q.waitForTimeout(800);
		const before = await Q.evaluate(`${store('annotationsHandler.activeAnnotation')}?.id`);
		h.check(!!before && !(await Q.evaluate(store('notesDrawerOpen'))), 'desktop: clicking a pin in the scene opens its note (no drawer)');
		await Q.locator('#note-next').click();
		await Q.waitForTimeout(700);
		const after = await Q.evaluate(`${store('annotationsHandler.activeAnnotation')}?.id`);
		h.check(!!after && after !== before, 'desktop: Next walks to another note from a scene-opened card');
		await Q.locator('.note-card .note-head button[aria-label^="Close note"]').click();
		await Q.waitForTimeout(500);
		h.check(!(await Q.evaluate(() => !!document.querySelector('.note-card'))) && !(await Q.evaluate(store('notesDrawerOpen'))), 'desktop: closing returns to the scene');
	}

	await h.finish(browser);
});

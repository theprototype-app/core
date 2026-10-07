// 38 R1 — THE SCRUB-FIELD LOCK (SPEC §0, first bullet). `ui/DragRow.svelte` and every scrub
// input keep behaving EXACTLY as they do today through the UI redesign: drag on the label or
// the value to scrub, Shift = fine (x0.1), Ctrl = snap, a 3 px dead zone so a click stays a
// click, click to type with LIVE updates, Enter commits and blurs, Escape reverts and blurs,
// Tab walks to the next field, ArrowUp/Down step one minor unit (Ctrl x10, Shift x100), the
// WHEEL does nothing, one gesture = ONE undo step, the edit is broadcast WHILE it happens,
// min/max clamp, and unit fields follow Settings › Scene › Length/Angle (with typed
// suffixes).
//
// `fieldContract` is the whole contract for one field; the suite runs it on the object
// transforms (position/rotation/scale), inspector values (light intensity, render order),
// shader vector components and the Animation window's fields. The two-peer half (the remote
// SEES the scrub live) is lock-dragrow-sync. The census of every scrub field per surface is
// lock-dragrow-census.
//
// PropRow (SPEC §2) WRAPS DragRow, so `.dn-wrap` / `.dn-input` are the contract's handles;
// if a redesign renames them, change DRAG_WRAP/DRAG_INPUT in lockHelpers.cjs — nothing here.
const h = require('./helpers.cjs');
const L = require('./lockHelpers.cjs');

const near = (/** @type {number} */ a, /** @type {number} */ b, eps = 1e-6) => Math.abs(a - b) <= eps;
const fmt = (/** @type {any} */ v) => (typeof v === 'number' ? +v.toFixed(5) : v);

/** new undo entries recorded so far (see lockHelpers.installUndoCounter) @param {any} page */
const undoDepth = (page) => L.undoEntries(page);
/** @param {any} page */
const activeId = (page) => page.evaluate(() => {
	const a = /** @type {any} */ (document.activeElement);
	return a ? { tag: a.tagName, id: a.id, aria: a.getAttribute('aria-label'), dn: !!a.closest?.('.dn-wrap'), text: a.value } : null;
});
/** move the pointer somewhere harmless and drop focus without pressing anything @param {any} page */
async function blurAll(page) {
	await page.evaluate(() => /** @type {any} */ (document.activeElement)?.blur?.());
	await page.waitForTimeout(60);
}

/**
 * THE CONTRACT for one scrub field.
 * @param {any} page
 * @param {{
 *   name: string, root: string, index: number,
 *   read: () => Promise<number>,      // the MODEL value (internal units)
 *   step: number, snap?: number,      // DragRow props (internal units per px / snap grid)
 *   factor?: number,                  // internal units per DISPLAYED unit (1 unless a unit field)
 *   min?: number, max?: number,
 *   typed?: string, typedValue?: number,  // something to type and the model value it means
 *   message?: string,                 // the wire type a live edit broadcasts
 *   messageAtEnd?: boolean,           // gesture-bracketed: one message on release, none during
 *   nextId?: string,                  // the id of the input Tab reaches
 *   undoSteps?: number|'per-change',  // undo steps a scrub records (1 by contract)
 *   focusAfterScrub?: boolean,        // label-wrapped: the release focuses the field
 *   typedUndoSteps?: number,          // undo steps a 2-keystroke typed edit records (locked as measured)
 *   nextAria?: string|null,           // what Tab reaches (aria-label of the next field), null = skip
 *   noUndo?: boolean,                 // a field that records no history at all (locked)
 *   staleAfterUndo?: boolean,         // KNOWN Q2: the field keeps the pre-undo number
 *   refresh?: () => Promise<any>,     // re-read the model into the row after an undo
 *   tol?: number
 * }} f
 */
async function fieldContract(page, f) {
	const t = `${f.name}:`;
	const input = L.fieldInput(page, f.root, f.index);
	const factor = f.factor ?? 1;
	const tol = f.tol ?? Math.max(f.step * 3, 0.011 * factor);
	await blurAll(page);
	// centred, not merely "in view": a sticky panel header covers the top of the scroller
	await input.evaluate((/** @type {any} */ el) => el.scrollIntoView({ block: 'center' }));
	await page.waitForTimeout(100);

	// --- presence + the unit/label chrome -------------------------------------------------
	h.check(await input.count() === 1, `${t} the scrub field is there`);
	// nothing may sit over the field (a leftover popup, a toast): the press must land on it
	const hit = await page.locator(f.root + ' ' + L.DRAG_WRAP).nth(f.index).evaluate((/** @type {any} */ w) => {
		const r = w.getBoundingClientRect();
		const at = document.elementFromPoint(r.x + Math.min(10, r.width / 4), r.y + r.height / 2);
		return { ok: !!at && w.contains(at), at: at ? at.tagName + '.' + String(at.className).slice(0, 40) : null };
	});
	h.check(hit.ok, `${t} the field is not covered (${hit.at})`);
	if (!hit.ok && process.env.LOCK_SHOTS) await page.screenshot({ path: `${process.env.LOCK_SHOTS}/covered-${f.name.replace(/\W+/g, '-')}.png` });
	h.check((await input.getAttribute('inputmode')) === 'decimal', `${t} it is a decimal text field (numeric keypad on touch)`);

	// --- a plain scrub: +40 px = 40 * step --------------------------------------------------
	let v0 = await f.read();
	const depth0 = await undoDepth(page);
	const sent0 = await page.evaluate(() => /** @type {any} */ (window).__lockSent.length);
	// a HELD scrub first: the edit must be live (model + broadcast) BEFORE the release
	const field = page.locator(f.root + ' ' + L.DRAG_WRAP).nth(f.index);
	const box = await field.boundingBox();
	const x = box.x + Math.min(10, box.width / 4);
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + 40, y, { steps: 10 });
	await page.waitForTimeout(120);
	const midValue = await f.read();
	const midSent = await page.evaluate((s0) => /** @type {any} */ (window).__lockSent.slice(s0), sent0);
	await page.mouse.up();
	let expect = v0 + 40 * f.step;
	if (f.max !== undefined) expect = Math.min(f.max, expect);
	h.check(near(midValue, expect, tol), `${t} scrubbing +40px moves the value LIVE, before release: ${fmt(v0)} -> ${fmt(midValue)} (want ~${fmt(expect)})`);
	if (f.message && !f.messageAtEnd) h.check(midSent.includes(f.message), `${t} the edit is broadcast WHILE scrubbing (${f.message} sent ${midSent.filter((m) => m === f.message).length}x before release)`);
	if (f.message && f.messageAtEnd) {
		// a gesture-bracketed field: ONE message when the scrub ends, none while it runs
		h.check(!midSent.includes(f.message), `${t} a gesture field sends nothing while scrubbing (${midSent.filter((m) => m === f.message).length})`);
		await page.waitForTimeout(150);
		const endSent = await page.evaluate((s0) => /** @type {any} */ (window).__lockSent.slice(s0), sent0);
		h.check(endSent.filter((m) => m === f.message).length === 1, `${t} and ONE ${f.message} when it ends (${endSent.filter((m) => m === f.message).length})`);
	}
	const v1 = await f.read();
	h.check(near(v1, midValue, tol), `${t} releasing keeps the scrubbed value (no snap-back): ${fmt(v1)}`);
	if (f.focusAfterScrub) {
		// a field wrapped in a <label> (Animation window, shader node rows): the release is a
		// click on the label, which focuses its input — so after a scrub the field is in
		// typing mode there, and only there. Locked as it behaves today.
		h.check((await activeId(page))?.dn === true, `${t} after a scrub the field keeps focus (label-wrapped)`);
		// DragRow's select-all runs a frame after focus and would take focus back from an
		// immediate blur
		await page.waitForTimeout(120);
		await blurAll(page);
	} else h.check((await activeId(page))?.dn !== true, `${t} a scrub does not leave the field in typing mode`);
	await page.waitForTimeout(700);
	const scrubSteps = (await undoDepth(page)) - depth0;
	let undoCount = f.undoSteps ?? 1;
	if (f.undoSteps === 'per-change') {
		// KNOWN (QUESTIONS-38-lock Q3): this field records one undo entry PER CHANGE, so a
		// scrub is as many steps as it had pointer moves. Locked as measured.
		h.check(scrubSteps >= 2, `${t} KNOWN Q3: a scrub records one undo entry per change, not one per gesture (${scrubSteps})`);
		undoCount = scrubSteps;
	} else if (!f.noUndo) h.check(scrubSteps === undoCount, `${t} the whole scrub is ${undoCount} undo step(s) (recorded ${scrubSteps})`);
	else h.check(scrubSteps === 0, `${t} records no undo entry (locked: ${scrubSteps})`);
	if (!f.noUndo) {
		const shown = await input.inputValue();
		const dBefore = await undoDepth(page);
		for (let i = 0; i < undoCount; i++) await page.keyboard.press('Control+z');
		await page.waitForTimeout(250);
		if (process.env.LOCK_DEBUG) console.log(`  ${t} undo x${undoCount}: depth ${dBefore} -> ${await undoDepth(page)}, active ${JSON.stringify(await activeId(page))}`);
		h.check(near(await f.read(), v0, 1e-6), `${t} Ctrl+Z puts it back exactly: ${fmt(await f.read())} (was ${fmt(v0)})`);
		if (f.staleAfterUndo) {
			// KNOWN (QUESTIONS-38-lock Q2): the Inspector's transform rows are not poked by an
			// undo, so the field keeps showing the pre-undo number until something refreshes the
			// selection. Locked AS IS — a redesign must not change it silently; fixing it is a
			// behaviour change of its own.
			h.check((await input.inputValue()) === shown, `${t} KNOWN Q2: after Ctrl+Z the field still shows ${shown} until the next refresh (shows ${await input.inputValue()})`);
		}
		if (f.refresh) await f.refresh();
	}

	// --- Shift = fine (x0.1) -----------------------------------------------------------------
	v0 = await f.read();
	await L.scrub(page, f.root, f.index, 60, { shift: true });
	await page.waitForTimeout(150);
	expect = v0 + 6 * f.step;
	if (f.max !== undefined) expect = Math.min(f.max, expect);
	h.check(near(await f.read(), expect, Math.max(f.step, 0.011 * factor, f.tol ?? 0)), `${t} Shift scrubs at a tenth of the speed: +60px -> ${fmt((await f.read()) - v0)} (want ~${fmt(6 * f.step)})`);
	await page.waitForTimeout(650);

	// --- Ctrl = snap ------------------------------------------------------------------------
	if (f.snap) {
		await L.scrub(page, f.root, f.index, 37, { ctrl: true });
		await page.waitForTimeout(150);
		const vs = await f.read();
		const onGrid = near(Math.round(vs / f.snap) * f.snap, vs, 0.011 * factor);
		h.check(onGrid, `${t} Ctrl snaps the scrub to multiples of ${fmt(f.snap)}: ${fmt(vs)}`);
		await page.waitForTimeout(650);
	}

	// --- the dead zone + click-to-type -------------------------------------------------------
	await blurAll(page);
	v0 = await f.read();
	const b2 = await field.boundingBox();
	await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
	await page.mouse.down();
	await page.mouse.move(b2.x + b2.width / 2 + 2, b2.y + b2.height / 2, { steps: 2 });
	await page.mouse.up();
	await page.waitForTimeout(120);
	h.check(near(await f.read(), v0), `${t} a 2px wiggle is inside the dead zone — nothing moves`);
	const act = await activeId(page);
	h.check(act?.dn === true, `${t} a click that did not scrub puts the caret in the field (click to type)`);
	const sel = await input.evaluate((/** @type {any} */ el) => ({ s: el.selectionStart, e: el.selectionEnd, n: el.value.length }));
	h.check(sel.s === 0 && sel.e === sel.n && sel.n > 0, `${t} and selects the whole value so typing replaces it (${sel.s}..${sel.e} of ${sel.n})`);

	// --- typing applies LIVE, Enter commits + blurs -------------------------------------------
	const typed = f.typed ?? '1.5';
	const typedValue = f.typedValue ?? 1.5 * factor;
	const depthT = await undoDepth(page);
	await page.keyboard.type(typed, { delay: 40 });
	await page.waitForTimeout(120);
	h.check(near(await f.read(), typedValue, 1e-6 + 0.0051 * factor), `${t} typing "${typed}" applies live, no Enter needed: ${fmt(await f.read())} (want ${fmt(typedValue)})`);
	await page.keyboard.press('Enter');
	await page.waitForTimeout(120);
	h.check((await activeId(page))?.dn !== true, `${t} Enter leaves the field`);
	h.check(near(await f.read(), typedValue, 1e-6 + 0.0051 * factor), `${t} and keeps the typed value`);
	await page.waitForTimeout(700);
	const typedSteps = (await undoDepth(page)) - depthT;
	if (!f.noUndo && f.typedUndoSteps !== undefined)
		h.check(typedSteps === f.typedUndoSteps, `${t} a typed edit records ${f.typedUndoSteps} undo step(s) (recorded ${typedSteps})`);

	// --- Escape reverts to the value you started with, then blurs ------------------------------
	const vEsc = await f.read();
	await input.click();
	await page.waitForTimeout(80);
	await page.keyboard.type('7', { delay: 30 });
	await page.waitForTimeout(80);
	const during = await f.read();
	await page.keyboard.press('Escape');
	await page.waitForTimeout(150);
	h.check(!near(during, vEsc), `${t} (premise) the typed 7 was live before Escape: ${fmt(during)}`);
	// KNOWN (QUESTIONS-38-lock Q1): DragRow's Escape commits the entry value and blurs — and
	// the blur fires the browser's `change` with the TYPED text still in the box (the reset
	// of the text lands a render later), so a typed edit is re-committed. Escape reverts
	// ARROW steps (asserted below) and not typing. Locked as it behaves today.
	h.check(near(await f.read(), during, 1e-6), `${t} KNOWN Q1: Escape after TYPING keeps the typed value (change-on-blur re-commits it): ${fmt(await f.read())}`);
	h.check((await activeId(page))?.dn !== true, `${t} Escape leaves the field`);
	await page.waitForTimeout(650);

	// --- arrow steps: one minor unit, Ctrl x10, Shift x100 --------------------------------------
	await input.click();
	await page.waitForTimeout(80);
	const dispDec = await input.evaluate((/** @type {any} */ el) => (el.value.split('.')[1] ?? '').length);
	const minorDisp = dispDec > 0 ? Math.pow(10, -dispDec) : 1;
	const readDisp = async () => Number(await input.inputValue());
	// start from a value with room on both sides
	const a0 = await readDisp();
	await page.keyboard.press('ArrowUp');
	const a1 = await readDisp();
	await page.keyboard.press('Control+ArrowUp');
	const a2 = await readDisp();
	await page.keyboard.press('Shift+ArrowUp');
	const a3 = await readDisp();
	await page.keyboard.press('ArrowDown');
	const a4 = await readDisp();
	const room = f.max === undefined || (f.max / factor) - a0 > 120 * minorDisp;
	if (room) {
		h.check(near(a1 - a0, minorDisp, minorDisp / 10), `${t} ArrowUp steps one minor unit (${fmt(minorDisp)}): ${fmt(a0)} -> ${fmt(a1)}`);
		h.check(near(a2 - a1, 10 * minorDisp, minorDisp / 10), `${t} Ctrl+ArrowUp steps x10: -> ${fmt(a2)}`);
		h.check(near(a3 - a2, 100 * minorDisp, minorDisp / 10), `${t} Shift+ArrowUp steps x100: -> ${fmt(a3)}`);
		h.check(near(a3 - a4, minorDisp, minorDisp / 10), `${t} ArrowDown steps back one: -> ${fmt(a4)}`);
	} else {
		h.check(a1 >= a0 && a3 <= f.max / factor + 1e-9, `${t} arrow steps stop at the max (${fmt(a3)} <= ${fmt(f.max / factor)})`);
	}
	h.check(near(await f.read(), a4 * factor, 0.0051 * factor + 1e-9), `${t} the arrows write the model live: ${fmt(await f.read())}`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(150);
	h.check(near(await readDisp(), a0, minorDisp / 10), `${t} Escape after arrow steps reverts the field: ${fmt(await readDisp())}`);
	h.check(near(await f.read(), a0 * factor, 0.0051 * factor + 1e-9), `${t} and the model: ${fmt(await f.read())}`);

	// --- Tab walks to the next field, Shift+Tab back -------------------------------------------
	if (f.nextAria !== null) {
		await input.click();
		await page.waitForTimeout(80);
		await page.keyboard.press('Tab');
		await page.waitForTimeout(80);
		const next = await activeId(page);
		const ok = f.nextId ? next?.id === f.nextId : f.nextAria === undefined ? next && !(next.dn && next.text === (await input.inputValue()) && next.aria === (await input.getAttribute('aria-label'))) : next?.aria === f.nextAria;
		h.check(!!ok, `${t} Tab moves focus to the next control (${JSON.stringify(next?.aria ?? next?.id ?? next?.tag)}${f.nextAria ? ', want ' + f.nextAria : ''})`);
		await page.keyboard.press('Shift+Tab');
		await page.waitForTimeout(80);
		const back = await activeId(page);
		h.check(back?.dn === true && back.aria === (await input.getAttribute('aria-label')), `${t} Shift+Tab comes back to it`);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(100);
	}

	// --- the wheel does nothing (no wheel behaviour today — locked) -------------------------
	await blurAll(page);
	const w0 = await f.read();
	const wb = await field.boundingBox();
	await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height / 2);
	// down then up: the panel scrolls (that is the panel, not the field) and comes back
	await page.mouse.wheel(0, 240);
	await page.waitForTimeout(150);
	await page.mouse.wheel(0, -240);
	await page.waitForTimeout(150);
	h.check(near(await f.read(), w0), `${t} the mouse wheel over the field changes nothing (DragRow has no wheel gesture)`);

	// --- clamping ------------------------------------------------------------------------------
	for (const [bound, val] of [['min', f.min], ['max', f.max]]) {
		if (val === undefined) continue;
		const beyond = bound === 'min' ? val / factor - 50 : val / factor + 50;
		await input.click();
		await page.waitForTimeout(60);
		await page.keyboard.type(String(beyond), { delay: 20 });
		await page.keyboard.press('Enter');
		await page.waitForTimeout(150);
		h.check(near(await f.read(), val, 1e-6), `${t} typing ${beyond} clamps to the ${bound} ${fmt(val)}: ${fmt(await f.read())}`);
		// a scrub far past the bound clamps too
		await L.scrub(page, f.root, f.index, bound === 'min' ? -900 : 900);
		await page.waitForTimeout(150);
		h.check(near(await f.read(), val, 1e-6), `${t} a scrub far past the ${bound} stops at it: ${fmt(await f.read())}`);
		await page.waitForTimeout(650);
	}
	await blurAll(page);
}

/** the selected object's transform component @param {any} page @param {string} field @param {string} axis */
const transformReader = (page, field, axis) => () =>
	page.evaluate(
		({ field, axis }) => new Promise((r) => window.__stores.selectedObject.subscribe((o) => r(o?.[field]?.[axis]))()),
		{ field, axis }
	);

h.run(async () => {
	const browser = await L.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await L.installProbes(page);
	await L.installUndoCounter(page);

	// ---- 1. OBJECT TRANSFORMS --------------------------------------------------------------
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1500);
	const box = await page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const b = g.children.find((c) => c.name === 'Box') ?? g.children[g.children.length - 1];
		window.__stores.objectActions.selectObject(b.uuid, true);
		// park it: a fresh /create box is dynamic and the suite must not race a fall
		b.position.set(0, 1, 0);
		b.rotation.set(0, 0, 0);
		b.scale.set(1, 1, 1);
		b.updateMatrix();
		return b.uuid;
	});
	await page.waitForTimeout(800);
	await page.locator('#inspector-position').waitFor({ state: 'visible', timeout: 10000 });
	const pokeSelection = () => page.evaluate(() => window.__stores.selectedObject.update((v) => v));

	// the rows themselves: three axes each, labelled, the unit on display
	const rows = await page.evaluate(() =>
		['position', 'rotation', 'scale'].map((k) => ({
			k,
			labels: [...document.querySelectorAll(`#inspector-${k} .dn-label`)].map((e) => e.textContent?.trim()),
			units: [...document.querySelectorAll(`#inspector-${k} .dn-unit`)].map((e) => e.textContent?.trim())
		}))
	);
	for (const r of rows) h.check(JSON.stringify(r.labels) === '["X","Y","Z"]', `${r.k} has X/Y/Z scrub fields (${JSON.stringify(r.labels)})`);
	h.check(rows[0].units.every((u) => u === 'm'), `position shows its length unit (${JSON.stringify(rows[0].units)})`);
	h.check(rows[1].units.every((u) => u === '°'), `rotation shows its angle unit (${JSON.stringify(rows[1].units)})`);
	h.check(rows[2].units.length === 0, 'scale is unitless');

	await fieldContract(page, {
		name: 'position X', root: '#inspector-position', index: 0, read: transformReader(page, 'position', 'x'),
		step: 0.02, snap: 0.5, message: 'move', typed: '1.37', typedValue: 1.37, typedUndoSteps: 1, nextAria: 'Y', staleAfterUndo: true, refresh: pokeSelection
	});
	await fieldContract(page, {
		name: 'rotation Y', root: '#inspector-rotation', index: 1, read: transformReader(page, 'rotation', 'y'),
		step: 0.01, snap: Math.PI / 12, factor: Math.PI / 180, message: 'move', typed: '33', typedValue: (33 * Math.PI) / 180, typedUndoSteps: 1, nextAria: 'Z', tol: 0.04, refresh: pokeSelection
	});
	await fieldContract(page, {
		name: 'scale Z', root: '#inspector-scale', index: 2, read: transformReader(page, 'scale', 'z'),
		step: 0.01, snap: 0.1, message: 'move', typed: '2.3', typedValue: 2.3, typedUndoSteps: 1, refresh: pokeSelection
	});

	// ---- 2. UNITS: Settings › Scene › Length / Angle and typed suffixes -----------------------
	const posX = transformReader(page, 'position', 'x');
	const rotY = transformReader(page, 'rotation', 'y');
	const setUnit = (/** @type {string} */ kind, /** @type {string} */ unit) =>
		page.evaluate(({ kind, unit }) => window.__stores.units[kind === 'length' ? 'lengthUnit' : 'angleUnit'].set(unit), { kind, unit });
	const typeInto = async (/** @type {string} */ root, /** @type {number} */ i, /** @type {string} */ text) => {
		await L.fieldInput(page, root, i).click();
		await page.waitForTimeout(60);
		await page.keyboard.type(text, { delay: 20 });
		await page.keyboard.press('Enter');
		await page.waitForTimeout(200);
	};
	await typeInto('#inspector-position', 0, '0.12');
	await setUnit('length', 'cm');
	await page.waitForTimeout(250);
	h.check((await L.fieldText(page, '#inspector-position', 0)) === '12', `in centimetres 0.12 m reads 12 (${await L.fieldText(page, '#inspector-position', 0)})`);
	h.check((await page.locator('#inspector-position .dn-unit').first().textContent())?.trim() === 'cm', 'and the field says cm');
	await typeInto('#inspector-position', 0, '50');
	h.check(near(await posX(), 0.5, 1e-9), `a bare number is read in the unit on display: 50 (cm) = ${fmt(await posX())} m`);
	await typeInto('#inspector-position', 0, '4in');
	h.check(near(await posX(), 0.1016, 1e-6), `a typed suffix wins: 4in = ${fmt(await posX())} m`);
	await setUnit('length', 'mm');
	await page.waitForTimeout(200);
	h.check((await L.fieldText(page, '#inspector-position', 0)) === '102', `in millimetres it reads 102 (${await L.fieldText(page, '#inspector-position', 0)})`);
	await setUnit('length', 'm');
	await typeInto('#inspector-position', 0, '12cm');
	h.check(near(await posX(), 0.12, 1e-9), `back in metres, "12cm" = ${fmt(await posX())} m`);
	await setUnit('angle', 'rad');
	await typeInto('#inspector-rotation', 1, '90deg');
	h.check(near(await rotY(), Math.PI / 2, 1e-6), `angle in radians, "90deg" = ${fmt(await rotY())} rad`);
	h.check((await L.fieldText(page, '#inspector-rotation', 1)) === '1.57', `and the field shows radians (${await L.fieldText(page, '#inspector-rotation', 1)})`);
	await setUnit('angle', 'deg');
	await page.waitForTimeout(200);
	h.check((await L.fieldText(page, '#inspector-rotation', 1)) === '90.0', `in degrees it reads 90.0 (${await L.fieldText(page, '#inspector-rotation', 1)})`);
	// the Settings rows drive the same stores (the inventory lock covers the rows; this ties them to the field)
	await page.evaluate(() => {
		window.__stores.settingsSection.set('scene');
		window.__stores.settingsOpen.set(true);
	});
	await page.locator('#length-unit').waitFor({ state: 'visible', timeout: 10000 });
	await page.locator('#length-unit').click();
	await page.locator('[role=listbox]:visible [role=option]', { hasText: /cm|centi/i }).first().click();
	await page.waitForTimeout(200);
	h.check((await L.storeValue(page, 'units.lengthUnit')) === 'cm', 'Settings › Scene › Length sets the unit the fields use');
	await page.locator('#length-unit').click();
	await page.locator('[role=listbox]:visible [role=option]').first().click();
	await page.waitForTimeout(150);
	h.check((await L.storeValue(page, 'units.lengthUnit')) === 'm', 'and back to metres');
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(300);

	// ---- 3. INSPECTOR VALUES: render order (integer), light intensity (min 0) -------------------
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), box);
	await page.locator('#inspector-render-order').waitFor({ state: 'visible', timeout: 10000 });
	await fieldContract(page, {
		name: 'render order', root: '*:has(> .dn-wrap > #inspector-render-order)', index: 0, step: 0.2, snap: 5,
		read: () => page.evaluate(() => new Promise((r) => window.__stores.selectedObject.subscribe((o) => r(o?.renderOrder))())),
		typed: '3', typedValue: 3, nextAria: undefined, noUndo: true, tol: 0.6
	});

	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/light directional'));
	await page.waitForTimeout(1200);
	await page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const l = g.children.find((c) => c.type === 'DirectionalLight');
		window.__stores.objectActions.selectObject(l.uuid, true);
	});
	await page.waitForTimeout(700);
	await page.locator('#inspector-intensity').waitFor({ state: 'visible', timeout: 10000 });
	await fieldContract(page, {
		name: 'light intensity', root: '#inspector-intensity', index: 0, step: 0.02, snap: 0.5, min: 0,
		read: () => page.evaluate(() => new Promise((r) => window.__stores.selectedObject.subscribe((o) => r(o?.intensity))())),
		typed: '2.5', typedValue: 2.5, message: 'object', noUndo: true
	});

	// ---- 4. SHADER VECTOR INPUTS ------------------------------------------------------------------
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u, true), box);
	await page.waitForTimeout(400);
	await page.evaluate((u) => {
		const S = window.__stores;
		S.shaderGraph.setShaderGraphFor(u, {
			nodes: [
				{ id: 'tl', type: 'tilingOffset', position: { x: 70, y: 60 }, data: {} },
				{ id: 'sf', type: 'surface', position: { x: 380, y: 90 }, data: {} }
			],
			edges: [{ id: 'e1', source: 'tl', sourceHandle: 'out', target: 'sf', targetHandle: 'albedo' }]
		});
		S.shaderEditorClose?.set?.(false);
		S.bottomDock.activateDock('shader');
	}, box);
	await page.locator('#shader-editor .shader-vec').first().waitFor({ state: 'visible', timeout: 15000 });
	const tiling = (/** @type {number} */ i) => () =>
		page.evaluate(
			({ u, i }) => new Promise((r) => window.__stores.shaderGraph.shaderGraphs.subscribe((all) => r(Number((all[u]?.nodes ?? []).find((n) => n.type === 'tilingOffset')?.data?.tiling?.[i] ?? 1)))()),
			{ u: box, i }
		);
	const vecCount = await page.locator('#shader-editor .shader-vec .dn-input').count();
	h.check(vecCount === 4, `the Tiling & offset node edits its two vec2 params as four scrub fields (${vecCount})`);
	await fieldContract(page, {
		name: 'shader vec2 x', root: '#shader-editor .shader-vec', index: 0, read: tiling(0),
		step: 0.005, typed: '3', typedValue: 3, message: 'shadergraph', nextAria: 'y', tol: 0.02, focusAfterScrub: true, undoSteps: 2
	});

	// ---- 5. ANIMATION FIELDS ------------------------------------------------------------------------
	await page.evaluate((u) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', u);
		s.animationClose.set(false);
		s.bottomDock.activateDock('animation');
		const tid = s.animationPreview.addTrack(u, 'pos.y', obj);
		s.animationPreview.updateTrack(u, tid, { from: 0, to: 4 });
		s.animationPreview.updateAnim(u, { duration: 2, loop: 'loop' });
	}, box);
	await page.locator('#animation-speed').waitFor({ state: 'visible', timeout: 10000 });
	const anim = (/** @type {string} */ key) => () =>
		page.evaluate(
			({ u, key }) => {
				const s = window.__stores;
				let set;
				s.animationPreview.animations.subscribe((v) => (set = v))();
				const doc = set?.[u];
				const clip = doc?.clips?.[doc.active];
				if (key === 'speed') {
					let pb;
					s.animationPreview.playback.subscribe((v) => (pb = v))();
					return Number(pb?.[u]?.speed ?? clip?.speed ?? 1);
				}
				// fps/step are absent until set: the clip then runs at the editor default
				const fallback = key === 'fps' ? Number(localStorage.getItem('animationFps')) || 30 : key === 'step' ? 0 : NaN;
				return Number(clip?.[key] ?? fallback);
			},
			{ u: box, key }
		);
	await fieldContract(page, { name: 'animation length', root: 'label:has(#animation-length)', index: 0, read: anim('duration'), step: 0.01, min: 0.1, typed: '3', typedValue: 3, message: 'animdata', focusAfterScrub: true, undoSteps: 'per-change' });
	await fieldContract(page, { name: 'animation speed', root: 'label:has(#animation-speed)', index: 0, read: anim('speed'), step: 0.01, min: 0.1, max: 8, typed: '2', typedValue: 2, noUndo: true, nextAria: null, focusAfterScrub: true });
	await fieldContract(page, { name: 'animation fps', root: 'label:has(#animation-fps)', index: 0, read: anim('fps'), step: 0.25, min: 1, max: 240, typed: '24', typedValue: 24, tol: 1.01, focusAfterScrub: true, undoSteps: 'per-change' });
	await fieldContract(page, { name: 'animation step', root: 'label:has(#animation-step)', index: 0, read: anim('step'), step: 0.25, min: 0, max: 240, typed: '2', typedValue: 2, tol: 1.01, nextAria: null, focusAfterScrub: true, undoSteps: 'per-change' });

	// key time / value: put the clip back to 2 s at normal speed (the clamp checks above left
	// it at its extremes), then select the first key of the track in the dope sheet
	await page.evaluate((u) => {
		const s = window.__stores.animationPreview;
		s.updateAnim(u, { duration: 2, fps: 30, step: 0 });
		s.setSpeed(u, 1);
	}, box);
	await page.waitForTimeout(300);
	await page.locator('#animation-fit').click();
	await page.waitForTimeout(200);
	const keyRect = page.locator('#animation-dock svg rect[transform^="rotate(45"]').nth(1);
	await keyRect.waitFor({ state: 'visible', timeout: 10000 });
	const kb = await keyRect.boundingBox();
	await page.mouse.click(kb.x + kb.width / 2, kb.y + kb.height / 2);
	await page.locator('#animation-key-time').waitFor({ state: 'visible', timeout: 5000 }).catch(async (e) => {
		if (process.env.LOCK_SHOTS) await page.screenshot({ path: `${process.env.LOCK_SHOTS}/anim-key.png` });
		throw e;
	});
	const key0 = (/** @type {'t'|'v'} */ k) => () =>
		page.evaluate(
			({ u, k }) => {
				let set;
				window.__stores.animationPreview.animations.subscribe((v) => (set = v))();
				const clip = set?.[u]?.clips?.[set[u].active];
				return Number(clip?.tracks?.[0]?.keys?.[1]?.[k] ?? NaN);
			},
			{ u: box, k }
		);
	h.check(Number.isFinite(await key0('v')()), 'premise — the track has keys to edit');
	h.check((await page.evaluate(() => /** @type {any} */ (window).__animationDebug?.selKeys?.() ?? [])).length === 1, 'a click on a key selects it (its time/value fields show)');
	await fieldContract(page, { name: 'key value', root: 'label:has(#animation-key-value)', index: 0, read: key0('v'), step: 0.01, typed: '0.5', typedValue: 0.5, message: 'animdata', messageAtEnd: true, nextAria: undefined, focusAfterScrub: true });
	await fieldContract(page, { name: 'key time', root: 'label:has(#animation-key-time)', index: 0, read: key0('t'), step: 0.005, min: 0, typed: '1.25', typedValue: 1.25, message: 'animdata', messageAtEnd: true, nextId: 'animation-key-value', focusAfterScrub: true, tol: 0.03 });

	await h.finish(browser);
});

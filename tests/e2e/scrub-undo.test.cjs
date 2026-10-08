// 37 R26 — SCRUB FIELDS AND UNDO (the three bugs the 38 behaviour lock found, QUESTIONS-38-lock
// Q1-Q3). Every scrub field — the Inspector's transforms and values, a shader vector, the
// Animation window's fields — must:
//   Q3  record ONE undo step per scrub and ONE per typed edit (focus -> Enter), however many
//       changes the gesture wrote, and however slowly it was typed;
//   Q1  put the value back when Escape is pressed after TYPING (it kept the typed value: the
//       blur's `change` re-committed the text still in the box), and leave no undo step;
//   Q2  show the restored number the moment Ctrl+Z lands (the transform rows kept the
//       pre-undo number until something refreshed the selection).
// Counted as NEW history entries, never the stack length: the history LIMIT evicts one old
// entry per new one, so a long session hides the count (the lock's own counter).
const h = require('./helpers.cjs');

const DRAG_WRAP = '.dn-wrap';
const DRAG_INPUT = '.dn-input';

const near = (/** @type {number} */ a, /** @type {number} */ b, eps = 1e-6) => Math.abs(a - b) <= eps;
const fmt = (/** @type {any} */ v) => (typeof v === 'number' ? +v.toFixed(5) : v);

/** @param {any} page */
async function installUndoCounter(page) {
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__r26Seen = new WeakSet();
		w.__r26New = 0;
		w.__stores.history.undoStack.subscribe((/** @type {any[]} */ stack) => {
			for (const e of stack)
				if (e && typeof e === 'object' && !w.__r26Seen.has(e)) {
					w.__r26Seen.add(e);
					w.__r26New++;
				}
		});
	});
}
/** @param {any} page @returns {Promise<number>} */
const undoEntries = (page) => page.evaluate(() => /** @type {any} */ (window).__r26New);
/** @param {any} page */
const blurAll = async (page) => {
	await page.evaluate(() => /** @type {any} */ (document.activeElement)?.blur?.());
	await page.waitForTimeout(60);
};
/** @param {any} page @param {string} root @param {number} index */
const fieldInput = (page, root, index) => page.locator(root + ' ' + DRAG_WRAP).nth(index).locator(DRAG_INPUT);

/** @param {any} page @param {string} root @param {number} index @param {number} dx */
async function scrub(page, root, index, dx) {
	const field = page.locator(root + ' ' + DRAG_WRAP).nth(index);
	await field.evaluate((/** @type {any} */ el) => el.scrollIntoView({ block: 'center' }));
	await page.waitForTimeout(80);
	const box = await field.boundingBox();
	const x = box.x + Math.min(10, box.width / 4);
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx, y, { steps: 12 });
	await page.mouse.up();
}

/** focus the field by a click that does not scrub @param {any} page @param {string} root @param {number} index */
async function clickToType(page, root, index) {
	await blurAll(page);
	await fieldInput(page, root, index).evaluate((/** @type {any} */ el) => el.scrollIntoView({ block: 'center' }));
	await fieldInput(page, root, index).click();
	await page.waitForTimeout(120); // DragRow selects the whole value a frame after focus
}

/**
 * The R26 contract for one field.
 * @param {any} page
 * @param {{ name: string, root: string, index: number, read: () => Promise<number>, typed: string,
 *   typedValue: number, slowTyped?: [string, string, number], shows?: (v: number) => number, tol?: number }} f
 */
async function contract(page, f) {
	const t = `${f.name}:`;
	const input = fieldInput(page, f.root, f.index);
	const tol = f.tol ?? 1e-6;
	h.check((await input.count()) === 1, `${t} the field is there`);

	// --- Q3: a scrub is ONE step, and one Ctrl+Z undoes all of it ---------------------------
	await blurAll(page);
	const v0 = await f.read();
	let d0 = await undoEntries(page);
	await scrub(page, f.root, f.index, 40);
	await page.waitForTimeout(150);
	await blurAll(page); // a label-wrapped field takes focus on the release
	await page.waitForTimeout(700); // the Inspector seals a transform gesture 500ms after it
	const v1 = await f.read();
	h.check(!near(v1, v0, tol), `${t} (premise) the scrub moved the value: ${fmt(v0)} -> ${fmt(v1)}`);
	const scrubSteps = (await undoEntries(page)) - d0;
	h.check(scrubSteps === 1, `${t} a whole scrub is ONE undo step (recorded ${scrubSteps})`);
	await page.keyboard.press('Control+z');
	await page.waitForTimeout(80);
	h.check(near(await f.read(), v0, tol), `${t} one Ctrl+Z puts the scrub back: ${fmt(await f.read())} (was ${fmt(v0)})`);
	// --- Q2: the field shows the restored number now, with nothing poking the selection -----
	if (f.shows) {
		const text = Number(await input.inputValue());
		h.check(near(text, f.shows(v0), 0.0051), `${t} right after Ctrl+Z the field shows the restored value: ${text} (want ${fmt(f.shows(v0))})`);
	}
	await page.keyboard.press('Control+y'); // carry on from the scrubbed value
	await page.waitForTimeout(150);
	h.check(near(await f.read(), v1, tol), `${t} and redo brings the scrub back: ${fmt(await f.read())}`);

	// --- Q3: a typed edit (two keystrokes, live) is ONE step -------------------------------
	const vT = await f.read();
	d0 = await undoEntries(page);
	await clickToType(page, f.root, f.index);
	await page.keyboard.type(f.typed, { delay: 40 });
	await page.keyboard.press('Enter');
	await page.waitForTimeout(700);
	h.check(near(await f.read(), f.typedValue, 1e-3), `${t} (premise) typing "${f.typed}" set ${fmt(await f.read())}`);
	const typedSteps = (await undoEntries(page)) - d0;
	h.check(typedSteps === 1, `${t} a typed edit is ONE undo step (recorded ${typedSteps})`);
	await page.keyboard.press('Control+z');
	await page.waitForTimeout(80);
	h.check(near(await f.read(), vT, tol), `${t} one Ctrl+Z undoes the whole typed edit: ${fmt(await f.read())} (was ${fmt(vT)})`);
	if (f.shows) {
		const text = Number(await input.inputValue());
		h.check(near(text, f.shows(vT), 0.0051), `${t} and the field shows it: ${text}`);
	}

	// typing slower than any debounce in between is still one edit
	if (f.slowTyped) {
		const [a, b, want] = f.slowTyped;
		const vS = await f.read();
		d0 = await undoEntries(page);
		await clickToType(page, f.root, f.index);
		await page.keyboard.type(a);
		await page.waitForTimeout(800);
		await page.keyboard.type(b);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(700);
		h.check(near(await f.read(), want, 1e-3), `${t} (premise) slow typing set ${fmt(await f.read())}`);
		const slowSteps = (await undoEntries(page)) - d0;
		h.check(slowSteps === 1, `${t} typing with a pause between keys is still ONE step (recorded ${slowSteps})`);
		await page.keyboard.press('Control+z');
		await page.waitForTimeout(80);
		h.check(near(await f.read(), vS, tol), `${t} and one Ctrl+Z undoes it: ${fmt(await f.read())}`);
	}

	// --- Q1: Escape after TYPING reverts, and leaves no step --------------------------------
	const vE = await f.read();
	await markStack(page);
	await clickToType(page, f.root, f.index);
	await page.keyboard.type('7', { delay: 30 });
	await page.waitForTimeout(100);
	const during = await f.read();
	h.check(!near(during, vE, tol), `${t} (premise) the typed 7 applied live: ${fmt(during)}`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(700);
	h.check(near(await f.read(), vE, tol), `${t} Escape after typing reverts to the value before editing: ${fmt(await f.read())} (was ${fmt(vE)})`);
	h.check((await page.evaluate(() => !!document.activeElement?.closest?.('.dn-wrap'))) === false, `${t} Escape leaves the field`);
	if (f.shows) {
		const text = Number(await input.inputValue());
		h.check(near(text, f.shows(vE), 0.0051), `${t} and the field shows it: ${text}`);
	}
	const added = await stackAdded(page);
	h.check(added === 0, `${t} an edit Escape took back leaves no undo step (${added} new on the stack)`);
	await blurAll(page);
}

/** remember which entries are on the undo stack now @param {any} page */
function markStack(page) {
	return page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__stores.history.undoStack.subscribe((/** @type {any[]} */ s) => (w.__r26Mark = new Set(s)))();
	});
}
/** entries on the undo stack that were not there at markStack (eviction-proof) @param {any} page */
function stackAdded(page) {
	return page.evaluate(() => {
		const w = /** @type {any} */ (window);
		let stack = /** @type {any[]} */ ([]);
		w.__stores.history.undoStack.subscribe((/** @type {any[]} */ s) => (stack = s))();
		return stack.filter((e) => !w.__r26Mark.has(e)).length;
	});
}

/** the selected object's transform component @param {any} page @param {string} field @param {string} axis */
const transformReader = (page, field, axis) => () =>
	page.evaluate(({ field, axis }) => new Promise((r) => window.__stores.selectedObject.subscribe((o) => r(o?.[field]?.[axis]))()), { field, axis });

h.run(async () => {
	const browser = await h.launch({ args: [...h.GPU_ARGS] });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await installUndoCounter(page);

	// ---- the Inspector: transforms ---------------------------------------------------------
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1500);
	const box = await page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const b = g.children.find((c) => c.name === 'Box') ?? g.children[g.children.length - 1];
		window.__stores.objectActions.selectObject(b.uuid, true);
		b.position.set(0, 1, 0); // park it: a fresh /create box is dynamic
		b.rotation.set(0, 0, 0);
		b.scale.set(1, 1, 1);
		b.updateMatrix();
		return b.uuid;
	});
	await page.waitForTimeout(800);
	await page.locator('#inspector-position').waitFor({ state: 'visible', timeout: 10000 });
	// show the parked pose, so every check starts from what the rows say
	await page.evaluate(() => window.__stores.selectedObject.update((v) => v));
	await page.waitForTimeout(150);

	await contract(page, {
		name: 'position X', root: '#inspector-position', index: 0, read: transformReader(page, 'position', 'x'),
		typed: '1.37', typedValue: 1.37, slowTyped: ['2', '5', 25], shows: (v) => v
	});
	await contract(page, {
		name: 'rotation Y', root: '#inspector-rotation', index: 1, read: transformReader(page, 'rotation', 'y'),
		typed: '33', typedValue: (33 * Math.PI) / 180, shows: (v) => (v * 180) / Math.PI, tol: 1e-4
	});
	await contract(page, {
		name: 'scale Z', root: '#inspector-scale', index: 2, read: transformReader(page, 'scale', 'z'),
		typed: '2.3', typedValue: 2.3, shows: (v) => v
	});

	// ---- the Inspector: values that recorded no undo at all -------------------------------
	await contract(page, {
		name: 'render order', root: '*:has(> .dn-wrap > #inspector-render-order)', index: 0, typed: '12', typedValue: 12,
		read: () => page.evaluate(() => new Promise((r) => window.__stores.selectedObject.subscribe((o) => r(o?.renderOrder))())),
		shows: (v) => v
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
	await contract(page, {
		name: 'light intensity', root: '#inspector-intensity', index: 0, typed: '2.5', typedValue: 2.5,
		read: () => page.evaluate(() => new Promise((r) => window.__stores.selectedObject.subscribe((o) => r(o?.intensity))())),
		shows: (v) => v
	});

	// ---- a light's range slider: one DRAG of the range is one step too --------------------
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/light point'));
	await page.waitForTimeout(1200);
	await page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const l = g.children.find((c) => c.type === 'PointLight');
		window.__stores.objectActions.selectObject(l.uuid, true);
	});
	await page.waitForTimeout(700);
	const range = page.locator('input[type=range][aria-label="Distance"]').first();
	await range.waitFor({ state: 'visible', timeout: 10000 });
	await range.evaluate((/** @type {any} */ el) => el.scrollIntoView({ block: 'center' }));
	const distance = () => page.evaluate(() => new Promise((r) => window.__stores.selectedObject.subscribe((o) => r(o?.distance))()));
	const dist0 = await distance();
	let dr0 = await undoEntries(page);
	const rb = await range.boundingBox();
	await page.mouse.move(rb.x + rb.width * 0.1, rb.y + rb.height / 2);
	await page.mouse.down();
	await page.mouse.move(rb.x + rb.width * 0.6, rb.y + rb.height / 2, { steps: 10 });
	await page.mouse.up();
	// 37-int-127: the light rows record through 1.26's (R1) multi-light seal, 500 ms after the last change
	await page.waitForTimeout(800);
	h.check(!near(await distance(), dist0), `light distance slider: (premise) the drag moved it: ${fmt(dist0)} -> ${fmt(await distance())}`);
	const rangeSteps = (await undoEntries(page)) - dr0;
	h.check(rangeSteps === 1, `light distance slider: a whole drag of the range is ONE undo step (recorded ${rangeSteps})`);
	await blurAll(page);
	await page.keyboard.press('Control+z');
	await page.waitForTimeout(150);
	h.check(near(await distance(), dist0), `light distance slider: one Ctrl+Z puts it back: ${fmt(await distance())} (was ${fmt(dist0)})`);
	// 37-int-127: Ctrl+Z pressed BEFORE that seal fires undoes the drag just made (history runs the
	// pending seals first) — not the step before it (the light's creation)
	{
		const before = await distance();
		const stackLen = () => page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((/** @type {any[]} */ st) => r(st.length))()));
		const stack0 = await stackLen();
		const rb2 = await range.boundingBox();
		await page.mouse.move(rb2.x + rb2.width * 0.2, rb2.y + rb2.height / 2);
		await page.mouse.down();
		await page.mouse.move(rb2.x + rb2.width * 0.7, rb2.y + rb2.height / 2, { steps: 8 });
		await page.mouse.up();
		const moved = await distance();
		await page.evaluate(() => window.__stores.history.undo());
		await page.waitForTimeout(700);
		h.check(!near(moved, before) && near(await distance(), before), `light distance slider: an immediate Ctrl+Z undoes the drag just made: ${fmt(before)} -> ${fmt(moved)} -> ${fmt(await distance())}`);
		const stack1 = await stackLen();
		h.check(stack1 === stack0 && (await range.count()) === 1, `light distance slider: and nothing older was undone (undo stack ${stack1} vs ${stack0} before the drag; the light is still there)`);
	}
	await contract(page, {
		name: 'light distance box', root: ':is(.ui-row, .pr):has(> input[type=range][aria-label="Distance"])', // 38 R5: SliderRow draws a PropRow (.pr) index: 0, typed: '12', typedValue: 12,
		read: distance, shows: (v) => v
	});

	// ---- a shader vector (it recorded two steps per scrub) --------------------------------
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
	await contract(page, {
		name: 'shader vec2 x', root: '#shader-editor .shader-vec', index: 0, typed: '3', typedValue: 3,
		read: () =>
			page.evaluate(
				(u) => new Promise((r) => window.__stores.shaderGraph.shaderGraphs.subscribe((all) => r(Number((all[u]?.nodes ?? []).find((n) => n.type === 'tilingOffset')?.data?.tiling?.[0] ?? 1)))()),
				box
			)
	});

	// ---- the Animation window (length/fps/step: one step PER CHANGE; speed: none) -----------
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
				const fallback = key === 'fps' ? Number(localStorage.getItem('animationFps')) || 30 : key === 'step' ? 0 : NaN;
				return Number(clip?.[key] ?? fallback);
			},
			{ u: box, key }
		);
	await contract(page, { name: 'animation length', root: 'label:has(#animation-length)', index: 0, read: anim('duration'), typed: '3', typedValue: 3 });
	await contract(page, { name: 'animation speed', root: 'label:has(#animation-speed)', index: 0, read: anim('speed'), typed: '2', typedValue: 2 });
	await contract(page, { name: 'animation fps', root: 'label:has(#animation-fps)', index: 0, read: anim('fps'), typed: '24', typedValue: 24 });
	await contract(page, { name: 'animation step', root: 'label:has(#animation-step)', index: 0, read: anim('step'), typed: '2', typedValue: 2 });

	await h.finish(browser);
});

// 42 I4 — a pinned Properties sidebar must not move when its CONTENT swaps.
//
// The report: "when pinned properties sidebar and deselecting/selecting object it shakes a bit,
// because it opens 'configure scene' and then 'object properties' … this animation is required only
// if the sidebar was closed". showSidebar closed the open panel and reopened it 50 ms later, so a
// select after a deselect (Scene -> Properties) replayed the fly-in; the other direction never
// closed it, which is why it only shook one way.
//
// The measurement is the one the eye makes: the panel's rect, sampled on EVERY frame (rAF) across
// the gesture, plus whether the element was replaced (a remount is the close/reopen). The guard
// that keeps the fix honest is section 3: opening from CLOSED still slides.
const h = require('./helpers.cjs');

/** start a per-frame sampler of #inspector's left edge (and element identity) */
function startSampler(page) {
	return page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__swapSamples = [];
		w.__swapFirst = document.querySelector('#inspector');
		w.__swapOn = true;
		const tick = () => {
			if (!w.__swapOn) return;
			const el = document.querySelector('#inspector');
			const r = el?.getBoundingClientRect();
			w.__swapSamples.push({ left: r ? Math.round(r.left * 10) / 10 : null, same: el === w.__swapFirst, there: !!el });
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
}
/** stop it and summarise */
function stopSampler(page) {
	return page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__swapOn = false;
		const s = w.__swapSamples;
		const lefts = s.map((x) => x.left).filter((x) => x != null);
		return {
			frames: s.length,
			missing: s.filter((x) => !x.there).length,
			replaced: s.filter((x) => x.there && !x.same).length,
			spread: lefts.length ? Math.max(...lefts) - Math.min(...lefts) : -1,
			first: lefts[0],
			last: lefts[lefts.length - 1]
		};
	});
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });

	await A.page.evaluate(async () => {
		const w = /** @type {any} */ (window).__stores;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		await new Promise((r) => setTimeout(r, 400));
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		/** @type {any} */ (window).__box = g.children[g.children.length - 1];
		w.objectActions.deselectObject();
		w.inspectorPinned.set(true);
		w.showSidebar('scene');
	});
	await A.page.waitForTimeout(900);
	const premise = await A.page.evaluate(() => {
		const w = /** @type {any} */ (window).__stores;
		const get = (s) => new Promise((r) => s.subscribe(r)());
		return Promise.all([get(w.inspectorClose), get(w.inspectorKind)]).then(([c, k]) => ({ open: !c, kind: k }));
	});
	h.check(premise.open && premise.kind === 'scene', `premise: pinned panel open on Configure Scene (${JSON.stringify(premise)})`);

	// ---------- 1. select (Scene -> Properties): the reported direction ----------
	await startSampler(A.page);
	await A.page.evaluate(() => /** @type {any} */ (window).__stores.objectActions.selectObject(/** @type {any} */ (window).__box.uuid));
	await A.page.waitForTimeout(700);
	const sel = await stopSampler(A.page);
	const kindAfterSelect = await A.page.evaluate(() => new Promise((r) => /** @type {any} */ (window).__stores.inspectorKind.subscribe(r)()));
	// showhide-v8 (owner R2, 2026-11-09): selecting no longer swaps Configure Scene for Properties — the two are tabs of
	// their own, and the open Configure Scene stays in front; the no-motion checks below still hold
	h.check(kindAfterSelect === 'scene', `premise: selecting leaves Configure Scene in front (v8: no swap) (${kindAfterSelect})`);
	h.check(sel.frames >= 10, `premise: sampled every frame across the gesture (${sel.frames} frames)`);
	h.check(sel.missing === 0 && sel.replaced === 0, `select: the panel was never closed or replaced (missing ${sel.missing}, replaced ${sel.replaced})`);
	h.check(sel.spread < 1, `select: the panel did not move on any frame (spread ${sel.spread}px, ${sel.first} -> ${sel.last})`);

	// ---------- 2. deselect (Properties -> Scene): the direction that was already right ----------
	await startSampler(A.page);
	await A.page.evaluate(() => /** @type {any} */ (window).__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(700);
	const desel = await stopSampler(A.page);
	h.check(desel.missing === 0 && desel.replaced === 0 && desel.spread < 1, `deselect: still no motion (spread ${desel.spread}, replaced ${desel.replaced})`);

	// ---------- 3. a panel opening from CLOSED still slides in ----------
	// showhide-v8: Properties and Configure Scene are two tabs over one Inspector, and closing the front one shows the
	// other; close BOTH so the column really is closed before it opens again
	await A.page.evaluate(() => {
		const sb = /** @type {any} */ (window).__stores.sidebars;
		sb.closeInspectorTab('scene');
		sb.closeInspectorTab('inspector');
	});
	await A.page.waitForTimeout(500);
	h.check((await A.page.locator('#inspector').count()) === 0 || (await A.page.evaluate(() => new Promise((r) => /** @type {any} */ (window).__stores.inspectorClose.subscribe(r)()))) === true, 'premise: the Inspector column is closed (both tabs)');
	await startSampler(A.page);
	await A.page.evaluate(() => /** @type {any} */ (window).__stores.showSidebar('scene'));
	await A.page.waitForTimeout(800);
	const opened = await stopSampler(A.page);
	h.check(opened.spread > 60, `opening from closed keeps its slide (moved ${opened.spread}px over ${opened.frames} frames)`);

	// ---------- 4. the explicit open on a pinned, open panel (double-click path) is a swap too ----------
	await startSampler(A.page);
	await A.page.evaluate(() => /** @type {any} */ (window).__stores.objectActions.selectObject(/** @type {any} */ (window).__box.uuid, true));
	await A.page.waitForTimeout(700);
	const dbl = await stopSampler(A.page);
	h.check(dbl.replaced === 0 && dbl.spread < 1, `explicit Properties on an open Scene panel swaps in place (spread ${dbl.spread}, replaced ${dbl.replaced})`);

	await h.finish(browser);
});

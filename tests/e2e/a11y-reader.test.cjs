// 53-reader (A4) — SCREEN-READER BASICS: the two live regions (polite for toasts and selections,
// assertive for errors), a selection announced as "<name>, <type>", and the object list as an
// ARIA tree (role=tree/treeitem with aria-level/selected/expanded and a row NAME). Keys are
// 53-keyboard's; this suite asserts only what a reader is told.
//
// Counterfactual: red on v1.39.0 (no live regions, no aria-level, rows named from their buttons).
//
// Run: APP_URL=https://theprototype.app:5474/ npm run e2e -- a11y-reader
const h = require('./helpers.cjs');

/** @param {any} page */
const live = (page) =>
	page.evaluate(() => {
		const p = document.querySelector('#a11y-live-polite');
		const a = document.querySelector('#a11y-live-assertive');
		return {
			polite: p ? { role: p.getAttribute('role'), live: p.getAttribute('aria-live'), text: p.textContent?.trim() ?? '' } : null,
			assertive: a ? { role: a.getAttribute('role'), live: a.getAttribute('aria-live'), text: a.textContent?.trim() ?? '' } : null
		};
	});

/** wait until a region says `want` (string or RegExp) @param {any} page @param {'polite'|'assertive'} which @param {string|RegExp} want @param {string} label */
async function hears(page, which, want, label) {
	const ok = (/** @type {any} */ r) => {
		const t = r?.[which]?.text ?? '';
		return typeof want === 'string' ? t === want : want.test(t);
	};
	const got = await h.eventually(() => live(page), ok, label, 4000).catch(() => null);
	const last = got ?? (await live(page));
	h.check(ok(last), `${label} (heard "${last?.[which]?.text ?? '(no region)'}")`);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;

	// ---- 1. the regions ----------------------------------------------------------------------
	const r0 = await live(page);
	h.check(r0.polite?.role === 'status' && r0.polite?.live === 'polite', `1.1 a POLITE live region exists (role=status) (${JSON.stringify(r0.polite)})`);
	h.check(r0.assertive?.role === 'alert' && r0.assertive?.live === 'assertive', `1.2 an ASSERTIVE live region exists (role=alert) (${JSON.stringify(r0.assertive)})`);

	// ---- 2. toasts ---------------------------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.showToast('Saved "Arena".'));
	await hears(page, 'polite', 'Saved "Arena".', '2.1 a toast is read politely');
	await page.evaluate(() => window.__tp.test.v1.showToast('Could not load the scene file'));
	await hears(page, 'assertive', 'Could not load the scene file', '2.2 an error toast is read ASSERTIVELY');
	const politeAfterError = (await live(page)).polite?.text;
	h.check(politeAfterError === 'Saved "Arena".', `2.3 the error did not go to the polite region (${politeAfterError})`);
	await page.evaluate(() => window.__tp.test.v1.showToastById('a11y-progress', 'Exporting 1 of 3'));
	await hears(page, 'polite', 'Exporting 1 of 3', '2.4 an id’d card is read');
	await page.evaluate(() => window.__tp.test.v1.showToastById('a11y-progress', 'Exporting 2 of 3'));
	await hears(page, 'polite', 'Exporting 2 of 3', '2.5 …and read again when it updates in place');
	await page.evaluate(() => {
		window.__tp.test.v1.toastsInDrawerOnly.set(true);
		window.__tp.test.v1.showToast('Copied 3 objects');
	});
	await hears(page, 'polite', 'Copied 3 objects', '2.6 a toast hidden from the viewport (toasts in drawer only) is still read');
	await page.evaluate(() => {
		window.__tp.test.v1.toastsInDrawerOnly.set(false);
		window.__tp.test.v1.clearToast();
	});

	// ---- 3. selection ------------------------------------------------------------------------
	await page.evaluate(() => {
		const s = window.__tp?.test.v1;
		s.commandsHandler.sceneCommand('/create box');
		s.commandsHandler.sceneCommand('/create sphere');
	});
	await page.waitForTimeout(1200);
	const objs = await page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		return g.children.filter((c) => c.isMesh).map((c) => ({ uuid: c.uuid, name: c.name, gtype: c.userData?.geometryParams?.gtype }));
	});
	h.check(objs.length >= 2, `3.0 premise: two meshes in the scene (${JSON.stringify(objs)})`);
	const [box, ball] = objs;
	await page.evaluate((u) => window.__tp.test.v1.objectActions.applySelectionSet([u], false), box.uuid);
	await hears(page, 'polite', `${box.name}, ${String(box.gtype ?? 'box').toLowerCase()}`, '3.1 selecting an object announces "<name>, <type>"');
	await page.evaluate((u) => window.__tp.test.v1.objectActions.applySelectionSet(u, false), [box.uuid, ball.uuid]);
	await hears(page, 'polite', '2 objects selected', '3.2 a multi-selection announces the count');
	await page.evaluate(() => window.__tp.test.v1.objectActions.applySelectionSet([], false));
	await hears(page, 'polite', 'Nothing selected', '3.3 deselecting says so');
	// a burst of writes in one gesture is ONE sentence
	const spoken = await page.evaluate(
		(u) =>
			new Promise((resolve) => {
				const s = window.__tp?.test.v1;
				const said = [];
				const off = s.a11yAnnounce.politeAnnouncement.subscribe((t) => t && said.push(t));
				s.objectActions.applySelectionSet([u[0]], false);
				s.objectActions.applySelectionSet([u[0], u[1]], false);
				s.objectActions.applySelectionSet([u[1]], false);
				setTimeout(() => {
					off();
					resolve(said);
				}, 600);
			}),
		[box.uuid, ball.uuid]
	);
	h.check(spoken.length === 2 && spoken[1] === `${ball.name}, ${String(ball.gtype ?? 'sphere').toLowerCase()}`, `3.4 three selection writes in one task = ONE announcement of where it landed (${JSON.stringify(spoken)})`);

	// ---- 4. the object list is a tree ----------------------------------------------------------
	await page.evaluate(() => window.__tp.test.v1.objectListClose.set(false));
	await page.waitForTimeout(600);
	const tree = await page.evaluate(() => {
		const t = document.querySelector('#object-tree');
		return t ? { role: t.getAttribute('role'), multi: t.getAttribute('aria-multiselectable'), label: t.getAttribute('aria-label') } : null;
	});
	h.check(tree?.role === 'tree' && tree?.label === 'Objects', `4.1 the list is role=tree named "Objects" (${JSON.stringify(tree)})`);
	h.check(tree?.multi === 'true', `4.2 it says it is multi-selectable (${tree?.multi})`);
	// a group holding the box and the sphere: the group at level 1, its members at level 2
	// (groupSelection needs two or more selected)
	const groupUuid = await page.evaluate((u) => {
		const s = window.__tp?.test.v1;
		s.objectActions.applySelectionSet(u, false);
		return s.objectActions.groupSelection();
	}, [box.uuid, ball.uuid]);
	h.check(typeof groupUuid === 'string', `4.2b premise: the two meshes were grouped (${groupUuid})`);
	await page.waitForTimeout(600);
	await page.evaluate((g) => {
		const s = window.__tp?.test.v1;
		s.expandedObjects.update((set) => new Set([...set, g]));
		s.objectActions.applySelectionSet([g], false);
	}, groupUuid);
	await page.waitForTimeout(600);
	const rows = await page.evaluate(
		([g, b, sph]) => {
			const row = (/** @type {string} */ id) => {
				const el = document.getElementById(id);
				return el ? { role: el.getAttribute('role'), level: el.getAttribute('aria-level'), selected: el.getAttribute('aria-selected'), expanded: el.getAttribute('aria-expanded'), label: el.getAttribute('aria-label') } : null;
			};
			return { group: row(g), box: row(b), ball: row(sph) };
		},
		[groupUuid, box.uuid, ball.uuid]
	);
	console.log('  rows', JSON.stringify(rows));
	h.check(rows.group?.role === 'treeitem' && rows.box?.role === 'treeitem', '4.3 every row is a treeitem');
	h.check(rows.group?.level === '1', `4.4 the top-level group row is aria-level 1 (${rows.group?.level})`);
	h.check(rows.box?.level === '2' && rows.ball?.level === '2', `4.5 the objects inside the group are aria-level 2 (${rows.box?.level}, ${rows.ball?.level})`);
	h.check(rows.group?.expanded === 'true' && rows.ball?.expanded == null, `4.6 the open group says expanded, a leaf says nothing (${rows.group?.expanded}, ${rows.ball?.expanded})`);
	h.check(rows.group?.selected === 'true' && rows.ball?.selected === 'false', `4.7 aria-selected follows the selection (${rows.group?.selected}, ${rows.ball?.selected})`);
	// 80a K6: a row we hold also says so (its chip), after the states that describe the object
	h.check(/, group(, held by me)?$/.test(rows.group?.label ?? '') && rows.ball?.label === `${ball.name}, ${String(ball.gtype ?? 'sphere').toLowerCase()}`, `4.8 a row is NAMED "<name>, <type>", not by its buttons (${rows.group?.label} / ${rows.ball?.label})`);
	// a real click on a row: the reader hears the pick
	await page.locator(`[id="${ball.uuid}"] .row-name`).click();
	await hears(page, 'polite', `${ball.name}, ${String(ball.gtype ?? 'sphere').toLowerCase()}`, '4.9 a real click on a row announces the object');
	await page.evaluate((u) => window.__tp.test.v1.objectActions.toggleObjectVisibility(u), ball.uuid);
	await page.waitForTimeout(400);
	const hiddenLabel = await page.getAttribute(`[id="${ball.uuid}"]`, 'aria-label');
	h.check(/, hidden(, held by me)?$/.test(hiddenLabel ?? ''), `4.10 a hidden object's row says "hidden" (${hiddenLabel})`);

	await h.finish(browser);
});

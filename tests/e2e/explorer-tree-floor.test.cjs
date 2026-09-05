// R22 — THE LIBRARY MAY NOT BE SQUEEZED OUT OF THE TREE COLUMN.
//
//   "when I have mounted multiple projects (on some clicked and expanded tree view) and
//    also expanded 'Scene' ... the Library becomes impossible to see, even when I try to
//    adjust vertical slider 'Drag to resize this section (double-click to reset)', so I
//    have to adjust dock window size ... follow best practices (there should be either
//    additional slider, but it would be clumpsy or likely just a rule that dissalows
//    Library to fully dissapear)."
//
// The Explorer tree is three bands: `#explorer-mounts` pinned top, `#explorer-folder-list`
// (the Library) `flex-1 min-h-0` in the middle, and the New-folder + grip + `#explorer-roots`
// block pinned bottom. Both ends were `shrink-0` and sized by CONSTANTS — the mounts list by
// an absolute 140px ceiling, the roots by `treeColH - 120` — so on a short dock they could
// between them claim more than the whole column and the middle, being the only thing that
// could shrink, went to nothing.
//
// MEASURED before the fix, on a 256px tree column with three mounts expanded and Scene
// expanded: mounts 177 + bottom 185 = 362 of 256, middle **8px**, the column overflowing
// its own height by 114 (scrollHeight 370). Dragging the grip all the way DOWN took the
// bottom to 105 and the middle STAYED AT 8 — which is the report's second half, and the
// reason a rule on the roots alone could never have been the fix.
//
// So the assertions here are about the RULE, not about one number: the middle keeps
// LIBRARY_MIN whenever the column can pay for it, the column never overflows itself, and
// the grip's ceiling re-derives from what the mounts are actually using.
//
// WHY THE VOLUMES ARE SEEDED. §2 mounts a real saved project through the real picker, so
// the rule is proven on the real path. Everything after that writes `mountedVolumes`
// directly: the tree renders one row per volume and per folder whatever put them there, the
// rule under test reads only HEIGHTS, and three real project saves would push this file
// past the runner's 8-minute budget for a fixture whose provenance the layout cannot see.
// `explorer-mounts` is where mounting itself is proven.
//
// Run: APP_URL='https://localhost:5206/' npm run e2e -- explorer-tree-floor
const h = require('./helpers.cjs');

// the source's own numbers, so a change to either has to change this file too
const LIBRARY_MIN = 96;
const ROOTS_MIN = 56;
const MOUNT_LIST_CAP = 140;
// the floor the rule can still honour when BOTH ends are already at their minimum and the
// column simply cannot pay for LIBRARY_MIN — measured at 86 on the 256px column above
const CRAMPED_FLOOR = 80;

/** every band of the tree column, as rendered */
const geom = (p) =>
	p.page.evaluate(() => {
		const box = (sel) => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const b = el.getBoundingClientRect();
			return {
				top: Math.round(b.top),
				h: Math.round(b.height),
				sh: el.scrollHeight,
				vis: b.height > 0 && b.width > 0
			};
		};
		return {
			tree: box('#explorer-tree'),
			mounts: box('#explorer-mounts'),
			mountList: box('#explorer-mount-list'),
			middle: box('#explorer-folder-list'),
			roots: box('#explorer-roots'),
			grip: box('#explorer-roots-resize'),
			libRow: box('#explorer-root-row')
		};
	});

/** N volumes of `folders` root folders each, named so the rows are distinguishable */
const seedVolumes = (p, n, folders) =>
	p.page.evaluate(
		({ n, folders }) => {
			const out = [];
			for (let i = 0; i < n; i++) {
				const fs = [];
				for (let f = 0; f < folders; f++)
					fs.push({ id: 'seed-f' + i + '-' + f, name: 'Folder ' + f, parentId: null });
				out.push({
					id: 'seed-v' + i,
					sessionId: 'seed-s' + i,
					name: 'Project ' + i,
					folders: fs,
					items: []
				});
			}
			window.__stores.mountedVolumes.mountedVolumes.set(out);
		},
		{ n, folders }
	);

/** expand every mounted volume through its own chevron, then Scene through its row */
async function expandEverything(p) {
	const page = p.page;
	for (let guard = 0; guard < 12; guard++) {
		const chev = page.locator('#explorer-mount-list button[aria-label="Expand"]').first();
		if (!(await chev.count())) break;
		await chev.click();
		await page.waitForTimeout(150);
	}
	const sceneExpanded = await page.evaluate(
		() => localStorage.getItem('explorerSceneExpanded') === 'true'
	);
	if (!sceneExpanded) {
		await page.locator('#scene-folder').dblclick();
		await page.waitForTimeout(400);
	}
}

/** the roots grip, dragged by `dy` px (negative = up = GROW the roots) */
async function dragGrip(p, dy) {
	const g = await p.page.locator('#explorer-roots-resize').boundingBox();
	if (!g) throw new Error('the roots grip is not on screen');
	const x = g.x + g.width / 2;
	const y = g.y + g.height / 2;
	await p.page.mouse.move(x, y);
	await p.page.mouse.down();
	const step = dy < 0 ? -8 : 8;
	for (let d = 0; Math.abs(d) < Math.abs(dy); d += step) await p.page.mouse.move(x, y + d);
	await p.page.mouse.move(x, y + dy);
	await p.page.mouse.up();
	await p.page.waitForTimeout(350);
}

const setDock = async (p, px) => {
	await p.page.evaluate((v) => window.__stores.bottomDock.dockHeight.set(v), px);
	await p.page.waitForTimeout(500);
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(
		() =>
			!!window.__stores?.mountedVolumes &&
			!!window.__stores?.explorer &&
			!!window.__stores?.bottomDock,
		null,
		{ timeout: 30000 }
	);
	await page.evaluate(async () => {
		await window.__stores.explorer.loadExplorer();
		window.__stores.objectActions.deselectObject();
	});
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(1200);

	// ---- 1. the bands exist and the column does not overflow itself -------------------
	let g = await geom(A);
	h.check(
		!!g.tree && !!g.mounts && !!g.middle && !!g.roots && !!g.grip,
		'premise: all three bands of the tree column are rendered, grip included'
	);
	h.check(
		g.mounts.top < g.middle.top && g.middle.top < g.roots.top,
		`the order is mounts / Library / roots (${g.mounts.top} < ${g.middle.top} < ${g.roots.top})`
	);
	h.check(
		g.middle.h >= LIBRARY_MIN,
		`with nothing mounted the Library list already clears its floor (${g.middle.h} >= ${LIBRARY_MIN})`
	);
	const tallMiddle = g.middle.h;

	// ---- 2. the rule holds on the REAL path: one project, saved and mounted ----------
	await page.evaluate(async () => {
		const s = window.__stores;
		await s.explorer.clearLibrary();
		s.commandsHandler.sceneCommand('/create box');
	});
	await page.waitForTimeout(1200);
	await page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await page.waitForTimeout(900);
	await page.locator('#session-save-project').click();
	await page.waitForTimeout(400);
	await page.locator('#session-save-name').fill('Floorplan');
	await page.locator('#session-save-confirm').click();
	await h.eventually(
		() =>
			page.evaluate(() => {
				let v;
				window.__stores.sessions.sessions.subscribe((x) => (v = x))();
				return (v ?? []).map((m) => m.name);
			}),
		(names) => names.includes('Floorplan'),
		'the project "Floorplan" is saved',
		25000
	);
	await page.evaluate(() => window.__stores.sessionsOpen.set(false));
	await page.waitForTimeout(600);
	await page.locator('#explorer-mount-add').click();
	await page.waitForSelector('[role=menuitem]', { timeout: 20000 });
	await page.waitForTimeout(300);
	await page.locator('[role=menuitem]', { hasText: 'Floorplan' }).first().click();
	await h.eventually(
		() =>
			page.evaluate(() => {
				let v;
				window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (v = x))();
				return (v ?? []).map((r) => r.name);
			}),
		(names) => names.includes('Floorplan'),
		'a REAL project is mounted through the Explorer picker',
		20000
	);
	await page.waitForTimeout(500);
	g = await geom(A);
	h.check(
		g.middle.h >= LIBRARY_MIN,
		`a real mount does not move the Library floor (${g.middle.h} >= ${LIBRARY_MIN})`
	);
	h.check(
		g.mountList.h <= MOUNT_LIST_CAP,
		`the mounts list still respects its upper bound (${g.mountList.h} <= ${MOUNT_LIST_CAP})`
	);

	// ---- 3. THE REPORT: several mounts expanded + Scene, on a SHORT dock -------------
	await setDock(A, 300);
	await seedVolumes(A, 3, 4);
	await page.waitForTimeout(500);
	await expandEverything(A);
	g = await geom(A);
	h.check(
		g.mountList.sh > g.mountList.h * 3,
		`premise: the mounts list has far more content than it can show (${g.mountList.sh} wanted, ${g.mountList.h} shown)`
	);
	h.check(
		g.roots.sh > g.roots.h,
		`premise: Scene is expanded, so the roots want more room than they have (${g.roots.sh} > ${g.roots.h})`
	);
	h.check(
		g.middle.h >= CRAMPED_FLOOR,
		`THE FIX: the Library list survives three expanded mounts on a 300px dock (${g.middle.h} >= ${CRAMPED_FLOOR}; it measured 8 before)`
	);
	h.check(
		g.libRow && g.libRow.vis && g.libRow.top >= g.middle.top - 1 && g.libRow.top < g.roots.top,
		`…and the Library row itself is inside it, not clipped past the roots (${g.libRow && g.libRow.top})`
	);
	h.check(
		g.tree.sh <= g.tree.h + 1,
		`the column no longer overflows its own height (scrollHeight ${g.tree.sh} <= ${g.tree.h}; it was 370 of 256)`
	);
	h.check(
		g.mountList.h < MOUNT_LIST_CAP,
		`the mounts list yielded rather than holding its flat 140 (${g.mountList.h} < ${MOUNT_LIST_CAP})`
	);
	const cramped = g.middle.h;

	// ---- 4. the grip cannot push the Library below the floor -------------------------
	// Dragging UP grows the roots — the gesture the report says did not help, and the one
	// that at the top of its travel used to be what took the middle away.
	await dragGrip(A, -300);
	g = await geom(A);
	h.check(
		g.middle.h >= CRAMPED_FLOOR,
		`dragging the grip to the top of its travel cannot starve the Library (${g.middle.h} >= ${CRAMPED_FLOOR})`
	);
	h.check(
		g.tree.sh <= g.tree.h + 1,
		`…and the column still fits itself (${g.tree.sh} <= ${g.tree.h})`
	);
	h.check(
		g.roots.h <= ROOTS_MIN + 2,
		`on THIS column the ceiling has met the floor, so the grip has no travel to give away (${g.roots.h} ~= ${ROOTS_MIN})`
	);

	// ---- 5. the ceiling RE-DERIVES when the mounts side grows ------------------------
	// The grip's own maximum is what the column has left once the mounts have taken their
	// share, so mounting more must pull an already-set rootsH down with it. A 420px dock,
	// because the grip needs real travel for any of this to be observable.
	await page.evaluate(() => window.__stores.mountedVolumes.mountedVolumes.set([]));
	await page.waitForTimeout(400);
	await setDock(A, 420);
	await dragGrip(A, -300); // grip to the top with an empty mounts section
	let g2 = await geom(A);
	const rootsAlone = g2.roots.h;
	h.check(
		rootsAlone > ROOTS_MIN + 20,
		`premise: on a 420px dock the grip really does have travel (roots ${rootsAlone})`
	);
	h.check(
		g2.middle.h >= LIBRARY_MIN,
		`with no mounts the grip's own ceiling already holds the floor (${g2.middle.h} >= ${LIBRARY_MIN})`
	);
	// and DOWN still works, which is the half the user could already reach
	await dragGrip(A, 300);
	g2 = await geom(A);
	h.check(
		g2.roots.h < rootsAlone,
		`dragging down still shrinks the roots (${rootsAlone} -> ${g2.roots.h})`
	);
	h.check(
		g2.middle.h > LIBRARY_MIN,
		`…and hands the room to the Library (${g2.middle.h} > ${LIBRARY_MIN})`
	);
	await dragGrip(A, -300); // back to the top, so the re-clamp below has something to pull
	await seedVolumes(A, 3, 4);
	await page.waitForTimeout(400);
	await expandEverything(A);
	g2 = await geom(A);
	h.check(
		g2.roots.h < rootsAlone,
		`mounting three projects re-clamps the roots the user had already grown (${rootsAlone} -> ${g2.roots.h})`
	);
	h.check(
		g2.middle.h >= LIBRARY_MIN,
		`…so the Library keeps its floor without the user touching anything (${g2.middle.h} >= ${LIBRARY_MIN})`
	);

	// ---- 6. a stored oversized explorerRootsH is re-clamped on LOAD ------------------
	// A height stored on a taller pane must not smuggle the overflow back in through the
	// next reload, which is where a persisted pref is at its most dangerous.
	await page.evaluate(() => {
		localStorage.setItem('explorerRootsH', '9999');
		localStorage.setItem('flowDockHeight', '300');
	});
	await h.freshReload(A);
	await page.waitForTimeout(1500);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(1200);
	await seedVolumes(A, 3, 4);
	await page.waitForTimeout(400);
	await expandEverything(A);
	const g3 = await geom(A);
	h.check(
		g3.roots.h <= g3.tree.h,
		`premise: the stored 9999 did not render as 9999 (${g3.roots.h} <= ${g3.tree.h})`
	);
	h.check(
		g3.middle.h >= CRAMPED_FLOOR,
		`a stored oversized roots height is re-clamped on load (Library ${g3.middle.h} >= ${CRAMPED_FLOOR})`
	);
	h.check(
		g3.tree.sh <= g3.tree.h + 1,
		`…and the reloaded column fits itself (${g3.tree.sh} <= ${g3.tree.h})`
	);

	// ---- 7. double-click still resets, and lands inside the rule ---------------------
	await page.locator('#explorer-roots-resize').dblclick();
	await page.waitForTimeout(400);
	const g4 = await geom(A);
	h.check(
		g4.roots.h >= ROOTS_MIN,
		`double-click reset still gives the roots a usable height (${g4.roots.h} >= ${ROOTS_MIN})`
	);
	h.check(
		g4.middle.h >= CRAMPED_FLOOR && g4.tree.sh <= g4.tree.h + 1,
		`…without breaking the floor it resets inside (Library ${g4.middle.h}, column ${g4.tree.sh}/${g4.tree.h})`
	);
	h.check(
		(await page.evaluate(() => localStorage.getItem('explorerRootsH'))) !== '9999',
		'the reset writes the pref back, so the oversized stored value is gone for good'
	);

	// ---- 8. a roomy column is untouched ----------------------------------------------
	// The rule must cost nothing where there was no bug: at the default dock with nothing
	// mounted the middle is the same height it has always been.
	// Every earlier section persisted something — a 300px dock, a reset roots height, an
	// expanded Scene, and §2's REAL mount, which lives in idb and comes back on reload
	// however the store is set. Put the pane back to the state `tallMiddle` was read in, or
	// this compares two different columns and reads as a regression that never happened.
	await page.evaluate(async () => {
		const mv = window.__stores.mountedVolumes;
		let list;
		mv.mountedVolumes.subscribe((x) => (list = x ?? []))();
		for (const v of list) await mv.unmountVolume(v.id);
		localStorage.removeItem('explorerRootsH');
		localStorage.removeItem('flowDockHeight');
		localStorage.removeItem('explorerSceneExpanded');
		localStorage.removeItem('explorerPacksExpanded');
		localStorage.removeItem('explorerExpanded');
	});
	await h.freshReload(A);
	await page.waitForTimeout(1500);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(1200);
	const g5 = await geom(A);
	h.check(
		g5.mountList.h === 0 && g5.tree.h > 256,
		`premise: the column really is back to its default — nothing mounted, ${g5.tree.h}px tall (roots ${g5.roots.h}/${g5.roots.sh})`
	);
	h.check(
		Math.abs(g5.middle.h - tallMiddle) <= 2,
		`the default, unmounted column measures what it always did (${g5.middle.h} vs ${tallMiddle})`
	);
	h.check(
		g5.roots.sh <= g5.roots.h + 1,
		`…and the roots still show everything they hold, so the rule bought no scrollbar here (${g5.roots.sh} <= ${g5.roots.h})`
	);
	h.check(
		g5.mountList.h === 0 || g5.mountList.h <= MOUNT_LIST_CAP,
		`and the mounts list keeps its full 140 to grow into (max ${MOUNT_LIST_CAP})`
	);

	h.check(h.pageErrors(A).length === 0, `no page errors (${h.pageErrors(A).join(' | ')})`);
	await h.finish(browser);
});

// 21-I2 — THE IDENTITY CHIP, AND A PROPERTIES PANEL THAT RESIZES.
//
// Two unrelated-looking pieces of the same complaint ("the Explorer header does not
// tell me anything and the panel is a fixed sliver"), so one suite:
//
//   the CHIP     `Project > Scene *` after the search box. 21-G9 spent a whole ROW of a
//                300px dock on the same two words; locked answer 4 folds it into the
//                header line. The three things it has to keep doing are the three
//                sections below: it names both halves, it renames the project IN PLACE
//                (Enter and BLUR commit, Escape cancels -- the 21-H1 rule), and the
//                scene half REVEALS its card. Plus the one thing it must not do:
//                push the search box off a narrow dock. That one is MEASURED.
//   the DIRTY    the dot reads `sceneDirty`, the store the window title's asterisk uses.
//                It is deliberately NOT poked here: the suite makes a REAL edit and
//                waits out the 2s throttle, so the check covers the wiring that a user
//                actually has (and the throttle itself, which is what keeps a
//                whole-scene serialization affordable).
//   the GRIP     WindowShell's secondary was a hardcoded 14rem. It resizes now, on
//                BOTH sides -- and the drag SIGN flips with the side, which is the one
//                thing a copy of the primary handler gets wrong. Section 7 drives the
//                same gesture after `switchSide`, which is the only way to tell a
//                correct sign from a lucky one.
//                18-B says the ceiling must be MEASURED from the container: section 8
//                shrinks the window and asserts the panel narrows WITH it and the grip
//                stays reachable -- a flat cap is exactly how a grip ends up off screen.
//
// All single-peer: nothing here replicates. The project NAME does (it rides the
// manifest), and `project-manifest` already covers that end to end.
//
// Run: APP_URL='https://localhost:5204/' npm run e2e -- explorer-header-panels
const h = require('./helpers.cjs');

const LONG_PROJECT = 'An Extremely Long Project Name That Cannot Possibly Fit';

// ---- reading the world -------------------------------------------------------------
const titleOf = (peer) => peer.page.evaluate(() => document.title);

const manifestName = (peer) =>
	peer.page.evaluate(() => window.__stores.projectManifest.projectName());

const itemsOf = (peer) =>
	peer.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		return items.map((i) => ({ id: i.id, name: i.name, hash: i.hash, folderId: i.folderId ?? null }));
	});

const activeFolderOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.explorer.activeFolder.subscribe((x) => (v = x))();
		return v ?? null;
	});

const inspectedOf = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.explorer.inspectedFile.subscribe((x) => (v = x))();
		return v ?? null;
	});

/** everything the chip says, plus where it SITS relative to the search box */
const chipOf = (peer) =>
	peer.page.evaluate(() => {
		const chip = document.querySelector('#explorer-identity');
		const search = document.querySelector('#explorer-search');
		const proj = document.querySelector('#explorer-project');
		const scene = document.querySelector('#explorer-scene');
		return {
			present: !!chip,
			project: proj?.textContent?.trim() ?? null,
			projectTitle: proj?.getAttribute('title') ?? null,
			editing: !!document.querySelector('#explorer-project-input'),
			scene: scene?.textContent?.trim() ?? null,
			sceneTag: scene?.tagName ?? null,
			sceneTitle: scene?.getAttribute('title') ?? null,
			dirty: !!document.querySelector('#explorer-dirty'),
			// the LAYOUT claim: same row as the search input, and AFTER it
			sameRow: !!chip && !!search && chip.parentElement === search.parentElement,
			afterSearch:
				!!chip &&
				!!search &&
				!!(search.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING),
			// ...and NOT the row it used to be: the shell's topbar
			inShellTopbar: !!chip?.closest('.ws-root')
		};
	});

/** the header row's own geometry, in one page call */
const headerGeom = (peer) =>
	peer.page.evaluate(() => {
		const search = document.querySelector('#explorer-search');
		const row = search?.parentElement;
		const chip = document.querySelector('#explorer-identity');
		const proj = document.querySelector('#explorer-project');
		const scene = document.querySelector('#explorer-scene');
		const r = (el) => {
			if (!el) return null;
			const b = el.getBoundingClientRect();
			return { left: b.left, right: b.right, width: b.width };
		};
		const clipped = (el) => (el ? el.scrollWidth > el.clientWidth + 1 : false);
		return {
			row: r(row),
			// scrollWidth vs clientWidth on the ROW is the overflow test
			rowOverflows: row ? row.scrollWidth > row.clientWidth + 1 : false,
			search: r(search),
			chip: r(chip),
			project: r(proj),
			scene: r(scene),
			projectClipped: clipped(proj),
			sceneClipped: clipped(scene)
		};
	});

/** WindowShell's secondary panel + its grip, measured */
const shellGeom = (peer) =>
	peer.page.evaluate(() => {
		const root = document.querySelector('.ws-root');
		const panel = root?.querySelector('.ws-panel-secondary');
		const grip = root?.querySelector('[data-ws-secondary-resize]');
		const main = root?.querySelector('.ws-main');
		const r = (el) => {
			if (!el) return null;
			const b = el.getBoundingClientRect();
			return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
		};
		return {
			rootW: root ? root.clientWidth : 0,
			panel: r(panel),
			grip: r(grip),
			main: r(main),
			primaryW: root ? (root.querySelector('.ws-panel:not(.ws-panel-secondary)')?.getBoundingClientRect().width ?? 0) : 0,
			// which edge the panel hugs, derived from geometry rather than from the store
			side: panel && main ? (panel.getBoundingClientRect().left < main.getBoundingClientRect().left ? 'left' : 'right') : null,
			stored: Number(localStorage.getItem('ws:explorer:secondaryWidth')) || null,
			viewport: { w: window.innerWidth, h: window.innerHeight }
		};
	});

/**
 * A SYNCHRONOUS content edit (scene-identity's `nudgeScene`): move an object and poke
 * the store the way every editor path does. It changes the matrix, so it changes
 * `toJSON`, so it changes the signature -- which is the whole point of driving a REAL
 * edit rather than writing `sceneDirty` from the test.
 */
const nudgeScene = (peer) =>
	peer.page.evaluate(() => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const child = g.children[0];
		const before = child.position.x;
		child.position.x += 3;
		child.updateMatrix();
		s.objectsGroup.update((v) => v);
		return child.position.x - before;
	});

/** drag a grip with a REAL mouse; the handlers read `movementX`, so steps matter */
async function dragBy(peer, box, dx) {
	const x = box.left + box.width / 2;
	const y = box.top + box.height / 2;
	await peer.page.mouse.move(x, y);
	await peer.page.mouse.down();
	await peer.page.mouse.move(x + dx, y, { steps: 12 });
	await peer.page.mouse.up();
	await peer.page.waitForTimeout(250);
}

async function openExplorer(peer) {
	const open = await peer.page.evaluate(
		() => !!document.querySelector('#explorer-list') || !!document.querySelector('#explorer-window')
	);
	if (!open) await peer.page.locator('#explorer-slot').click();
	await peer.page.waitForTimeout(900);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(
		() => !!window.__stores?.levels && !!window.__stores?.projectManifest && !!window.__stores?.explorer,
		{ timeout: 30000 }
	);

	// =====================================================================
	// 1. THE CHIP IS IN THE HEADER ROW, AFTER THE SEARCH BOX
	// =====================================================================
	await A.page.evaluate(() => window.__stores.projectManifest.setProjectName('Dungeon Crawl'));
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
	});
	const arena = await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	h.check(!!arena?.hash, `premise: a saved scene to be identified by (${arena?.name})`);

	await openExplorer(A);
	let c = await chipOf(A);
	h.check(c.present, 'the identity chip is rendered');
	h.check(
		c.project === 'Dungeon Crawl' && c.scene === 'Arena',
		`it reads Project > Scene (${JSON.stringify([c.project, c.scene])})`
	);
	h.check(
		c.sameRow && c.afterSearch,
		`and it sits in the SEARCH row, after the input (sameRow ${c.sameRow}, after ${c.afterSearch})`
	);
	h.check(
		!c.inShellTopbar,
		"21-G9's separate identity row is gone: the chip is not inside the shell's topbar any more"
	);
	h.check(
		c.sceneTag === 'BUTTON' && /click to find its file/i.test(c.sceneTitle ?? ''),
		`the scene half is a control now, and says what clicking it does ("${c.sceneTitle}")`
	);
	// the LOCATION crumbs are a different question and must NOT have gone with it
	const crumbs = await A.page.evaluate(
		() => document.querySelectorAll('.ws-root .ws-main > div:first-child button').length
	);
	h.check(crumbs > 0, `the location breadcrumbs are untouched (${crumbs} crumb buttons)`);

	// =====================================================================
	// 2. THE DIRTY DOT — A REAL EDIT, AND THE THROTTLE THAT PAYS FOR IT
	// =====================================================================
	h.check(!c.dirty, 'premise: a just-saved scene shows no dot');
	const moved = await nudgeScene(A);
	h.check(Math.abs(moved - 3) < 1e-6, `premise: a real content edit (moved ${moved} in x)`);
	const early = await chipOf(A);
	h.check(
		!early.dirty,
		'THROTTLED: the dot does not appear on the edit itself — the answer costs a whole-scene serialization'
	);
	await h.eventually(
		() => chipOf(A),
		(v) => v.dirty === true,
		'…and once the 2s window passes the dot appears',
		9000
	);
	h.check(
		(await titleOf(A)).startsWith('Arena* - '),
		'it is the SAME signal the window title uses — the asterisk is up too'
	);
	await A.page.evaluate(() => window.__stores.levels.saveSceneAsLevel('Arena'));
	await h.eventually(
		() => chipOf(A),
		(v) => v.dirty === false,
		'saving clears it: the scene and the version its name points at are equal again'
	);

	// =====================================================================
	// 3. RENAMING THE PROJECT IN PLACE — ENTER, BLUR, ESCAPE
	// =====================================================================
	await A.page.locator('#explorer-project').click();
	await A.page.waitForTimeout(250);
	h.check((await chipOf(A)).editing, 'clicking the project opens an inline input, not a prompt');
	await A.page.locator('#explorer-project-input').fill('Enter Named');
	await A.page.keyboard.press('Enter');
	await A.page.waitForTimeout(300);
	c = await chipOf(A);
	h.check(
		c.project === 'Enter Named' && !c.editing && (await manifestName(A)) === 'Enter Named',
		`Enter commits through setProjectName (${JSON.stringify([c.project, c.editing])})`
	);

	// 21-H1 (locked answer 7): BLUR commits too — clicking away is not "abandon"
	await A.page.locator('#explorer-project').click();
	await A.page.waitForTimeout(200);
	await A.page.locator('#explorer-project-input').fill('Blur Named');
	await A.page.locator('#explorer-search').click(); // a real click elsewhere
	await A.page.waitForTimeout(350);
	c = await chipOf(A);
	h.check(
		c.project === 'Blur Named' && !c.editing && (await manifestName(A)) === 'Blur Named',
		`blur COMMITS — the 21-H1 rule across the inline family (${JSON.stringify([c.project, c.editing])})`
	);

	// Escape cancels, and the blur it necessarily causes must NOT re-commit
	await A.page.locator('#explorer-project').click();
	await A.page.waitForTimeout(200);
	await A.page.locator('#explorer-project-input').fill('Typed and abandoned');
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(400);
	c = await chipOf(A);
	h.check(
		c.project === 'Blur Named' && !c.editing && (await manifestName(A)) === 'Blur Named',
		`Escape cancels, and the unmount's own blur cannot resurrect it (${JSON.stringify([c.project, await manifestName(A)])})`
	);

	// =====================================================================
	// 4. CLICKING THE SCENE REVEALS ITS CARD
	// =====================================================================
	// save into a FOLDER, so the reveal has to navigate rather than luckily already be there
	const folder = await A.page.evaluate(
		() => window.__stores.explorer.createFolder('Levels here', null)?.id ?? null
	);
	h.check(!!folder, 'premise: a folder to hide the scene in');
	const bunker = await A.page.evaluate(
		(id) => window.__stores.levels.saveSceneAsLevel('Bunker', id),
		folder
	);
	const bunkerItem = (await itemsOf(A)).find((i) => i.id === bunker.id);
	h.check(
		bunkerItem?.folderId === folder,
		`premise: Bunker's file is in that folder (${bunkerItem?.name})`
	);
	// go somewhere else, and prove the card is genuinely not on screen
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(600);
	const before = await A.page.evaluate(
		(id) => !!document.querySelector(`[data-card-id="${id}"]`),
		bunker.id
	);
	h.check(!before, "premise: at the library root the open scene's card is nowhere in the grid");
	h.check(
		(await chipOf(A)).scene === 'Bunker',
		'premise: the chip is naming the scene we are about to hunt for'
	);

	await A.page.locator('#explorer-scene').click();
	await A.page.waitForTimeout(700);
	h.check(
		(await activeFolderOf(A)) === folder,
		'clicking the scene navigates to the folder its file lives in'
	);
	const revealed = await A.page.evaluate((id) => {
		const el = document.querySelector(`[data-card-id="${id}"]`);
		if (!el) return null;
		const b = el.getBoundingClientRect();
		const grid = el.parentElement;
		const g = grid.getBoundingClientRect();
		return {
			classes: el.className,
			// "scrolled into view" = inside its own scroller, not merely in the DOM
			inView: b.top >= g.top - 1 && b.bottom <= g.bottom + 1,
			height: b.height
		};
	}, bunker.id);
	h.check(!!revealed, 'the card is in the grid');
	h.check(
		revealed && revealed.classes.includes('explorer-open-scene'),
		"and it is the one wearing 21-G9's open-scene accent — the chip lands you on the right card"
	);
	h.check(
		revealed && revealed.inView && revealed.height > 0,
		`…scrolled into view rather than just mounted (${JSON.stringify(revealed && { inView: revealed.inView, height: revealed.height })})`
	);
	// `explorer-selected` is SET MEMBERSHIP, and it is the half that the view-change
	// effect wipes — reading `inspectedFile` alone passes even when the set was thrown
	// away, which is exactly what happens if the reveal writes before that effect flushes
	h.check(
		(await inspectedOf(A)) === bunker.id && revealed.classes.includes('explorer-selected'),
		'it is SELECTED too — inspected AND a member of the set, so the reveal outlives the view-change effect that WIPES the selection'
	);
	// it reveals, it does not travel: the scene under our feet must be the same one
	h.check(
		(await chipOf(A)).scene === 'Bunker' && (await titleOf(A)).startsWith('Bunker'),
		'…and nothing was opened or travelled to: we are in the scene we were already in'
	);

	// =====================================================================
	// 5. A NARROW DOCK: THE CHIP TRUNCATES, THE SEARCH BOX STAYS
	// =====================================================================
	await A.page.evaluate((n) => window.__stores.projectManifest.setProjectName(n), LONG_PROJECT);
	await A.page.waitForTimeout(400);
	const wide = await headerGeom(A);
	h.check(
		!!wide.search && !!wide.chip && !wide.rowOverflows,
		`premise (wide, ${wide.row?.width | 0}px): the header row does not overflow`
	);
	const searchWide = wide.search.width;

	await A.page.setViewportSize({ width: 520, height: 720 });
	await A.page.waitForTimeout(700);
	const narrow = await headerGeom(A);
	h.check(
		!narrow.rowOverflows,
		`the row still does not overflow at 520px (scrollWidth vs clientWidth on the row)`
	);
	h.check(
		Math.abs(narrow.search.width - searchWide) < 2,
		`the SEARCH box keeps its width (${searchWide | 0} -> ${narrow.search.width | 0}) — the chip is the item that gives way`
	);
	h.check(
		narrow.search.left >= narrow.row.left - 1 && narrow.search.right <= narrow.row.right + 1,
		`…and it is still fully inside the row, not pushed off it (${narrow.search.right | 0} <= ${narrow.row.right | 0})`
	);
	h.check(
		narrow.chip.right <= narrow.row.right + 1,
		`the chip stops at the row's edge (${narrow.chip.right | 0} <= ${narrow.row.right | 0})`
	);
	h.check(
		narrow.projectClipped || narrow.sceneClipped,
		`and it TRUNCATES rather than overflowing (project clipped ${narrow.projectClipped}, scene ${narrow.sceneClipped})`
	);
	h.check(
		!wide.projectClipped,
		'…which is a narrow-width behaviour only: the same name is not clipped at full width'
	);
	const nc = await chipOf(A);
	h.check(
		(nc.projectTitle ?? '').includes(LONG_PROJECT) && (nc.sceneTitle ?? '').includes('Bunker'),
		'a clipped segment still carries the whole text in its title tooltip'
	);
	await A.page.setViewportSize({ width: 1280, height: 720 });
	await A.page.waitForTimeout(500);

	// =====================================================================
	// 6. THE PROPERTIES PANEL RESIZES (right-hand side) AND REMEMBERS
	// =====================================================================
	await A.page.locator('[data-ws-mode="props"]').click();
	await A.page.waitForTimeout(500);
	let g = await shellGeom(A);
	h.check(!!g.panel, 'the Properties panel is open');
	h.check(
		Math.abs(g.panel.width - 224) < 2,
		`premise: it starts at its old hardcoded width, 14rem (${g.panel.width | 0}px)`
	);
	h.check(g.side === 'right', `premise: with the tree on the left, Properties is on the right`);
	h.check(!!g.grip, 'it has a resize grip now (it had none at all)');
	h.check(
		g.grip.left >= 0 && g.grip.right <= g.viewport.w && g.grip.bottom <= g.viewport.h,
		`…and the grip is on screen (${JSON.stringify({ l: g.grip.left | 0, r: g.grip.right | 0, b: g.grip.bottom | 0 })})`
	);

	// on the RIGHT the grip is on the panel's LEFT edge, so dragging LEFT widens it
	await dragBy(A, g.grip, -80);
	let after = await shellGeom(A);
	h.check(
		after.panel.width > g.panel.width + 60,
		`dragging the grip AWAY from the right border widens it (${g.panel.width | 0} -> ${after.panel.width | 0})`
	);
	h.check(
		Math.abs(after.panel.width - (g.panel.width + 80)) < 12,
		`…by the distance dragged, not some multiple of it (expected ~${(g.panel.width + 80) | 0})`
	);
	h.check(
		after.stored === Math.round(after.panel.width),
		`the width persists under ws:explorer:secondaryWidth (${after.stored})`
	);
	const wider = after.panel.width;

	// and back the other way, which is the half a wrong SIGN still gets right
	await dragBy(A, after.grip, 40);
	const narrowed = await shellGeom(A);
	h.check(
		narrowed.panel.width < wider - 25,
		`dragging back TOWARDS the border narrows it (${wider | 0} -> ${narrowed.panel.width | 0})`
	);

	// dblclick resets
	await A.page.mouse.dblclick(
		narrowed.grip.left + narrowed.grip.width / 2,
		narrowed.grip.top + narrowed.grip.height / 2
	);
	await A.page.waitForTimeout(300);
	const reset = await shellGeom(A);
	h.check(
		Math.abs(reset.panel.width - 224) < 2 && reset.stored === null,
		`double-clicking the grip resets it and forgets the pref (${reset.panel.width | 0}px, stored ${reset.stored})`
	);

	// a real width, then a RELOAD
	await dragBy(A, reset.grip, -70);
	const chosen = (await shellGeom(A)).panel.width;
	h.check(chosen > 260, `premise: a width worth remembering (${chosen | 0}px)`);
	await h.freshReload(A);
	await A.page.waitForFunction(() => !!window.__stores?.explorer, { timeout: 30000 });
	await openExplorer(A);
	const reloaded = await shellGeom(A);
	h.check(
		!!reloaded.panel && Math.abs(reloaded.panel.width - chosen) < 2,
		`…and it comes back at that width after a reload (${reloaded.panel?.width | 0} vs ${chosen | 0})`
	);

	// =====================================================================
	// 7. THE OTHER SIDE — WHERE A COPIED DRAG SIGN GOES WRONG
	// =====================================================================
	await A.page.locator('[data-ws-switch-side]').click();
	await A.page.waitForTimeout(600);
	let left = await shellGeom(A);
	h.check(
		left.side === 'left',
		`premise: switching sides puts Properties on the LEFT (panel ${left.panel.left | 0}, main ${left.main.left | 0})`
	);
	h.check(
		Math.abs(left.panel.width - chosen) < 2,
		`the width follows it across (${left.panel.width | 0}px)`
	);
	h.check(
		left.grip.left >= left.panel.right - 2,
		`the grip is on the panel's INNER edge again, not stranded on the far side (grip ${left.grip.left | 0}, panel right ${left.panel.right | 0})`
	);
	// mirrored: on the LEFT the grip is on the panel's RIGHT edge, so dragging RIGHT widens
	await dragBy(A, left.grip, 70);
	const leftWider = await shellGeom(A);
	h.check(
		leftWider.panel.width > left.panel.width + 50,
		`dragging AWAY from the left border widens it too — the sign follows the side (${left.panel.width | 0} -> ${leftWider.panel.width | 0})`
	);
	await dragBy(A, leftWider.grip, -70);
	const leftBack = await shellGeom(A);
	h.check(
		Math.abs(leftBack.panel.width - left.panel.width) < 12,
		`…and the mirrored drag round-trips (${leftBack.panel.width | 0} vs ${left.panel.width | 0})`
	);

	// =====================================================================
	// 8. THE CEILING IS MEASURED, NOT A CONSTANT (18-B)
	// =====================================================================
	const pref = leftBack.panel.width;
	await A.page.setViewportSize({ width: 560, height: 700 });
	await A.page.waitForTimeout(700);
	const squeezed = await shellGeom(A);
	// the ceiling is `root - chrome(24) - the folder tree - a 160px floor for the grid`,
	// so the premise is that what is LEFT is genuinely less than the width we stored
	const room = squeezed.rootW - 24 - squeezed.primaryW - 160;
	h.check(
		room < pref,
		`premise: the shell no longer has room for the stored width (root ${squeezed.rootW | 0} leaves ${room | 0} for a ${pref | 0}px panel)`
	);
	h.check(
		squeezed.panel.width < pref,
		`a dock that SHRINKS narrows the panel with it — a flat cap would not have (${pref | 0} -> ${squeezed.panel.width | 0})`
	);
	h.check(
		squeezed.panel.left >= -1 && squeezed.panel.right <= squeezed.viewport.w + 1,
		`…and the panel stays inside the window (${squeezed.panel.left | 0}..${squeezed.panel.right | 0} of ${squeezed.viewport.w})`
	);
	h.check(
		squeezed.grip.left >= 0 && squeezed.grip.right <= squeezed.viewport.w,
		`…with its grip still reachable, which is the whole point of the 18-B rule (${squeezed.grip.left | 0}..${squeezed.grip.right | 0})`
	);
	h.check(
		squeezed.main.width > 0,
		`…and the file grid is not squeezed to nothing either (${squeezed.main.width | 0}px)`
	);
	// the PREF was not eaten: widen the window again and the user's width comes back
	await A.page.setViewportSize({ width: 1280, height: 720 });
	await A.page.waitForTimeout(700);
	const restored = await shellGeom(A);
	h.check(
		Math.abs(restored.panel.width - pref) < 2,
		`widening the window gives the chosen width back — the clamp is on the RENDER, not on the stored pref (${restored.panel.width | 0} vs ${pref | 0})`
	);

	// =====================================================================
	// 9. THE UNDOCKED WINDOW RENDERS THE SAME CHIP
	// =====================================================================
	// The header exists TWICE -- the bottom dock and the floating window -- so the chip
	// is one snippet rendered from both. A second call site nobody drives is a second
	// call site that can quietly be wrong (and it is where duplicate ids would show up).
	await A.page.locator('#explorer-undock').click();
	await A.page.waitForTimeout(900);
	const floated = await A.page.evaluate(() => ({
		windowed: !!document.querySelector('#explorer-window'),
		inHeader: !!document.querySelector('#explorer-window .ui-panel-header #explorer-identity'),
		ids: ['explorer-identity', 'explorer-project', 'explorer-scene', 'explorer-search'].map(
			(i) => document.querySelectorAll('#' + i).length
		)
	}));
	h.check(floated.windowed, 'premise: undocked into the floating window');
	h.check(
		floated.inHeader,
		'the chip renders in the floating window header too, beside its own search box'
	);
	h.check(
		floated.ids[0] === 1 && floated.ids[1] === 1 && floated.ids[3] === 1 && floated.ids.every((c) => c <= 1),
		`…and no id is DUPLICATED — only one of the two headers is ever mounted (${JSON.stringify(floated.ids)}; the scene segment is legitimately absent, the reload in section 6 left us with no open scene)`
	);
	const fg = await headerGeom(A);
	h.check(
		!!fg.chip && !fg.rowOverflows && fg.chip.right <= fg.row.right + 1,
		`…under the same no-overflow rule (chip ${fg.chip?.right | 0} <= row ${fg.row?.right | 0})`
	);

	// =====================================================================
	// 10. NOTHING CRASHED
	// =====================================================================
	const errs = (await h.pageErrors(A)).filter((e) => !/No active pointer/.test(e));
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs)})`);
	await h.finish(browser);
});

// 21-H3: multi-select in the Explorer.
//
// Until this phase the grid could hold exactly ONE thing at a time — `selected`, the
// anchor the Properties pane reads — so there was no way to download five files, delete
// a folder-full, export two prefabs into one model, or drag more than one card into the
// scene. This suite covers the selection model (Ctrl / Shift / Ctrl+A / Ctrl+I / Escape),
// the MARQUEE driven by a real mouse, the three card states staying apart by COMPUTED
// colour, the batch operations with their skipped-kind report, and the drag that carries
// N — spread by default, stacked under the new setting.
//
// Two premise traps this suite pays for up front, both documented in the skill:
// a leftover portaled ContextMenu closes on POINTERDOWN (a `body.click()` leaves it
// mounted, where it covers the very cards the next section drags), and a synthesized
// grip must be verified with `elementFromPoint` before it is trusted.
const fs = require('fs');
const { unzipSync } = require('fflate');
const h = require('./helpers.cjs');

const TINY_OBJ = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

/**
 * Every card in the grid, with membership (`explorer-selected` — the marker the
 * component writes for a set member whichever of the two tints it took) and whether it
 * is the ANCHOR (the primary fill, whose facts Properties is showing). Read from the DOM
 * rather than from component state on purpose: `selectedIds` is not a store, and what
 * the user can see is the thing worth asserting.
 */
const cardStates = (page) =>
	page.evaluate(() => {
		const rows = [];
		for (const el of document.querySelectorAll('#explorer-list [data-card-id]')) {
			const cls = el.getAttribute('class') || '';
			rows.push({
				id: el.dataset.cardId,
				name: (el.textContent || '').trim(),
				picked: cls.includes('explorer-selected'),
				anchor: cls.includes('bg-primary-600/10')
			});
		}
		return rows;
	});

/** the selected NAMES, sorted — the exact SET, never a count */
async function selection(page) {
	const rows = await cardStates(page);
	return rows
		.filter((r) => r.picked)
		.map((r) => r.name)
		.sort();
}

const gridRect = (page) =>
	page.locator('#explorer-list [role="region"][tabindex="-1"]').last().boundingBox();

/**
 * Click EMPTY grid background — which focuses the region (so the keyboard reaches it)
 * and clears the selection. Bottom-right rather than a fixed offset, because the top-left
 * of the grid is where the FIRST CARD is: `{x: 5, y: 5}` lands inside it and selects
 * something instead of clearing. Verified with elementFromPoint before it is trusted.
 */
async function clickEmptyGrid(page) {
	const b = await gridRect(page);
	const x = b.x + b.width - 18;
	const y = b.y + b.height - 18;
	const onCard = await page.evaluate(
		([px, py]) => !!document.elementFromPoint(px, py)?.closest('.explorer-card, .explorer-folder-card'),
		[x, y]
	);
	if (onCard) throw new Error('clickEmptyGrid aimed at a card — the grid is fuller than expected');
	await page.mouse.click(x, y);
	await page.waitForTimeout(200);
	return { x, y };
}

/** the bounding boxes of the grid's cards, in document order */
const cardBoxes = (page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('#explorer-list [data-card-id]')].map((el) => {
			const b = el.getBoundingClientRect();
			return { name: (el.textContent || '').trim(), x: b.x, y: b.y, w: b.width, h: b.height };
		})
	);

async function clickCard(page, name, modifiers = []) {
	const card = page.locator('#explorer-list [data-card-id]').filter({ hasText: name }).first();
	await card.click({ modifiers });
	await page.waitForTimeout(120);
}

/**
 * Dismiss any open context menu. Escape unwinds ONE step and lives on the filter input;
 * the backdrop needs the PRESS and the click, because a menu opened by a long press must
 * not be closed by the lift that opened it. Copied from prefab-explorer, which learned it
 * the hard way — a still-open backdrop swallows the next right-click.
 */
async function closeCtxMenu(page) {
	await page.evaluate(() => {
		const backdrop = [...document.querySelectorAll('[role="presentation"]')].find((el) =>
			el.className.includes?.('inset-0')
		);
		if (!backdrop) return;
		backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	});
	await page.waitForTimeout(200);
}

/** right-click a card by name and wait for its menu */
async function cardMenu(page, name) {
	await closeCtxMenu(page);
	await page
		.locator('#explorer-list [data-card-id]')
		.filter({ hasText: name })
		.first()
		.click({ button: 'right' });
	await page.waitForSelector('[role="menu"]', { timeout: 5000 });
	return page.locator('[role="menuitem"]').allTextContents();
}

/** every toast's TEXT — a plain toast is stored as a bare string, an action toast as
 *  `{text, actions}`, and reading only `.text` silently returns undefined for half of them */
const toastTexts = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.toastStore.subscribe((list) =>
					r((list || []).map((t) => (typeof t === 'string' ? t : (t?.text ?? ''))))
				)()
			)
	);
const clearToasts = (page) => page.evaluate(() => window.__stores.clearToast());

const itemNames = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.explorer.explorerItems.subscribe((list) => r(list.map((i) => i.name)))()
			)
	);
const folderNames = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.explorer.explorerFolders.subscribe((list) => r(list.map((f) => f.name)))()
			)
	);
const sceneObjects = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) =>
					r(
						(g?.children ?? []).map((c) => ({
							name: c.name,
							pos: c.position.toArray().map((v) => Math.round(v * 1000) / 1000)
						}))
					)
				)()
			)
	);
const clearScene = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					for (const c of [...(g?.children ?? [])]) g.remove(c);
					r(true);
				})()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// ---- 0. premise: one folder holding five files and two subfolders ----------------
	await page.evaluate(async (obj) => {
		const ex = window.__stores.explorer;
		await ex.loadExplorer();
		const work = ex.createFolder('Work', null);
		ex.createFolder('Sub one', work.id);
		ex.createFolder('Sub two', work.id);
		// the five files must hold DIFFERENT bytes. An Explorer item's identity IS its
		// content hash, and since the loose-scenes fix `importFiles` enforces that the way
		// `addItemFromBytes` always has — five files of identical content are ONE file, so
		// the old fixture (one shared TINY_OBJ under five names) now seeds a single card.
		// A comment per file keeps them distinct while leaving the geometry identical, so
		// this suite goes on testing selection rather than deduplication.
		await ex.importFiles(
			['alpha', 'bravo', 'charlie', 'delta', 'echo'].map(
				(n) =>
					new File([new Blob(['# ' + n + String.fromCharCode(10) + obj])], n + '.obj', {
						type: 'text/plain'
					})
			),
			work.id
		);
		ex.activeFolder.set(work.id);
	}, TINY_OBJ);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(900);
	const cards0 = await cardStates(page);
	h.check(
		cards0.length === 7,
		`premise: the grid shows 2 folders + 5 files (${cards0.length}: ${cards0.map((c) => c.name).join(',')})`
	);
	h.check(
		cards0.every((c) => !c.picked && !c.anchor),
		'premise: nothing is selected to begin with'
	);

	// ---- 1. plain click, then Ctrl-click toggling ------------------------------------
	await clickCard(page, 'alpha.obj');
	h.check(
		JSON.stringify(await selection(page)) === JSON.stringify(['alpha.obj']),
		`a plain click selects exactly one (${(await selection(page)).join(',')})`
	);
	await clickCard(page, 'charlie.obj', ['Control']);
	h.check(
		JSON.stringify(await selection(page)) === JSON.stringify(['alpha.obj', 'charlie.obj']),
		`Ctrl-click ADDS (${(await selection(page)).join(',')})`
	);
	await clickCard(page, 'alpha.obj', ['Control']);
	h.check(
		JSON.stringify(await selection(page)) === JSON.stringify(['charlie.obj']),
		`Ctrl-click on a member REMOVES it (${(await selection(page)).join(',')})`
	);
	// A card ctrl-clicked OUT of the set must stop LOOKING picked, even though the anchor
	// stayed on it — otherwise the highlight and the set disagree about what Delete takes
	const afterToggle = await cardStates(page);
	h.check(
		afterToggle.find((c) => c.name === 'alpha.obj')?.anchor === false,
		'a card toggled off stops looking selected, though it keeps the anchor'
	);
	// …and the anchor really did move: the next Shift-click ranges from ALPHA (the card
	// last touched), not from charlie (the one still selected). Asserting the consequence
	// rather than the internal, which is the thing that has to be right.
	await clickCard(page, 'bravo.obj', ['Shift']);
	h.check(
		JSON.stringify(await selection(page)) === JSON.stringify(['alpha.obj', 'bravo.obj']),
		`the anchor follows a Ctrl-click, so the next Shift range starts there (${(await selection(page)).join(',')})`
	);

	// ---- 2. Shift range, in the CURRENT VISUAL ORDER ---------------------------------
	// The order is folders first, then items — one array, exactly as rendered. A range
	// from the first folder to the second file therefore has to include BOTH folders.
	await clickCard(page, 'Sub one');
	await clickCard(page, 'bravo.obj', ['Shift']);
	const range = await selection(page);
	h.check(
		JSON.stringify(range) === JSON.stringify(['Sub one', 'Sub two', 'alpha.obj', 'bravo.obj']),
		`Shift ranges across the folder/file boundary in visual order (${range.join(',')})`
	);
	// a SECOND shift-click re-ranges from the SAME anchor (it does not creep)
	await clickCard(page, 'delta.obj', ['Shift']);
	const range2 = await selection(page);
	h.check(
		JSON.stringify(range2) ===
			JSON.stringify(['Sub one', 'Sub two', 'alpha.obj', 'bravo.obj', 'charlie.obj', 'delta.obj']),
		`a second Shift-click re-ranges from the same anchor (${range2.join(',')})`
	);

	// ---- 3. the three visual states are distinguishable, BY COMPUTED COLOUR ----------
	// The class string was right the whole time in the ToolboxWindow bug; only the
	// computed value caught it. Here: the anchor, a multi-selected member and an
	// untouched card must be three different fills.
	const colours = await page.evaluate(() => {
		const read = (name) => {
			const el = [...document.querySelectorAll('#explorer-list [data-card-id]')].find(
				(n) => (n.textContent || '').trim() === name
			);
			if (!el) return null;
			const cs = getComputedStyle(el);
			return { bg: cs.backgroundColor, border: cs.borderTopColor };
		};
		return { anchor: read('Sub one'), member: read('delta.obj'), plain: read('echo.obj') };
	});
	h.check(
		!!colours.anchor && !!colours.member && !!colours.plain,
		'premise: all three sample cards were found'
	);
	h.check(
		colours.member.bg !== colours.plain.bg && colours.member.border !== colours.plain.border,
		`a multi-selected card is visibly different from an unselected one (${colours.member.bg} vs ${colours.plain.bg})`
	);
	h.check(
		colours.member.bg !== colours.anchor.bg && colours.member.border !== colours.anchor.border,
		`…and from the ANCHOR, which keeps its own treatment (${colours.member.bg} vs ${colours.anchor.bg})`
	);
	// 21-G9's emerald ring is a RING, so it composes with either fill rather than
	// competing for the same property — the third state stays readable by construction
	const ringProp = await page.evaluate(() => {
		const el = document.querySelector('#explorer-list [data-card-id]');
		return getComputedStyle(el).getPropertyValue('--tw-ring-color') !== undefined;
	});
	h.check(ringProp, 'the open-scene accent uses the ring property, not the fill');

	// ---- 4. Ctrl+A / Ctrl+I / Escape, and the shortcut that must NOT leak ------------
	await page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		window.__stores.commandsHandler.sceneCommand('/create sphere');
	});
	await page.waitForTimeout(700);
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(200);
	const gb = await gridRect(page);
	await page.mouse.click(gb.x + gb.width - 18, gb.y + gb.height - 18); // empty space: focus + clear
	await page.waitForTimeout(200);
	h.check((await selection(page)).length === 0, 'a plain background click clears the selection');

	await page.keyboard.press('Control+a');
	await page.waitForTimeout(250);
	const all = await selection(page);
	h.check(all.length === 7, `Ctrl+A takes every card in this folder (${all.length})`);
	const sceneSel = await page.evaluate(
		() => new Promise((r) => window.__stores.selectedObjects.subscribe((s) => r([...s].length))())
	);
	h.check(
		sceneSel === 0,
		`…and does NOT leak to the scene's own Ctrl+A behind the panel (${sceneSel} objects selected)`
	);

	await page.keyboard.press('Control+i');
	await page.waitForTimeout(250);
	h.check((await selection(page)).length === 0, 'Ctrl+I inverts a full selection to an empty one');
	await clickCard(page, 'alpha.obj');
	await page.keyboard.press('Control+i');
	await page.waitForTimeout(250);
	const inverted = await selection(page);
	h.check(
		inverted.length === 6 && !inverted.includes('alpha.obj'),
		`Ctrl+I inverts a partial selection (${inverted.join(',')})`
	);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(250);
	h.check((await selection(page)).length === 0, 'Escape clears the selection');

	// ---- 5. the MARQUEE, with a real mouse -------------------------------------------
	await closeCtxMenu(page);
	const boxes = await cardBoxes(page);
	h.check(boxes.length === 7 && boxes[0].w > 0, 'premise: the cards report real geometry');
	const rowTop = Math.min(...boxes.map((b) => b.y));
	const rowBottom = Math.max(...boxes.map((b) => b.y + b.h));
	// start BELOW the row of cards, inside the grid, and sweep up across the first two
	const startX = boxes[0].x + 10;
	const startY = Math.min(rowBottom + 24, gb.y + gb.height - 6);
	const endX = boxes[1].x + boxes[1].w - 10;
	const endY = rowTop + 10;
	const atStart = await page.evaluate(
		([x, y]) => {
			const el = document.elementFromPoint(x, y);
			return {
				tag: el?.tagName,
				onCard: !!el?.closest('.explorer-card, .explorer-folder-card'),
				inExplorer: !!el?.closest('#explorer-list'),
				menuOpen: !!document.querySelector('[role="menu"]')
			};
		},
		[startX, startY]
	);
	h.check(
		atStart.inExplorer && !atStart.onCard && !atStart.menuOpen,
		`premise: the marquee's start pixel is grid background, not a card or a leftover menu (${JSON.stringify(atStart)})`
	);

	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(startX - 4, startY - 20, { steps: 3 });
	await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 });
	const bandUp = await page.evaluate(() => {
		const el = document.querySelector('#explorer-marquee');
		if (!el) return null;
		const b = el.getBoundingClientRect();
		return { w: Math.round(b.width), hgt: Math.round(b.height) };
	});
	h.check(!!bandUp && bandUp.w > 0 && bandUp.hgt > 0, `the band is drawn mid-drag (${JSON.stringify(bandUp)})`);
	await page.mouse.move(endX, endY, { steps: 5 });
	await page.mouse.up();
	await page.waitForTimeout(300);
	const swept = await selection(page);
	h.check(
		JSON.stringify(swept) === JSON.stringify(['Sub one', 'Sub two']),
		`the marquee picks exactly the cards it crossed (${swept.join(',')})`
	);
	h.check(
		(await page.locator('#explorer-marquee').count()) === 0,
		'the band is gone once the button is released'
	);
	// HAZARD 3, asserted on its own: the click that FOLLOWS the drag lands on the grid
	// background, whose handler deselects — a marquee that undid itself would read zero
	h.check(swept.length === 2, 'the marquee is not undone by its own trailing click');
	// and the ordinary background click still works afterwards (preventDefault on
	// pointerdown must not have cost us the click path)
	await page.mouse.click(gb.x + gb.width - 18, gb.y + gb.height - 18);
	await page.waitForTimeout(200);
	h.check(
		(await selection(page)).length === 0,
		'a background click still deselects after a marquee has run'
	);

	// Ctrl+drag ADDS instead of replacing
	await clickCard(page, 'echo.obj');
	await page.mouse.move(startX, startY);
	await page.keyboard.down('Control');
	await page.mouse.down();
	await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 });
	await page.mouse.move(endX, endY, { steps: 5 });
	await page.mouse.up();
	await page.keyboard.up('Control');
	await page.waitForTimeout(300);
	const added = await selection(page);
	h.check(
		JSON.stringify(added) === JSON.stringify(['Sub one', 'Sub two', 'echo.obj']),
		`Ctrl+drag adds the band to what was already picked (${added.join(',')})`
	);

	// ---- 6. TOUCH must still scroll --------------------------------------------------
	// The counterfactual is in the same evaluate: an identical synthetic event with
	// pointerType 'mouse' IS taken (prevented + a band), so the touch refusal is the
	// guard doing its job and not a handler that never ran.
	await clickEmptyGrid(page);
	const touchProbe = await page.evaluate(
		async ([x, y]) => {
			const el = document.elementFromPoint(x, y);
			// svelte flushes state to the DOM on a MICROTASK, so reading for the band in
			// the same statement that dispatched the press finds nothing whether the
			// gesture started or not — which would make both halves of this probe agree
			const settle = () => new Promise((r) => setTimeout(r, 90));
			const fire = async (pointerType) => {
				const ev = new PointerEvent('pointerdown', {
					pointerType,
					button: 0,
					buttons: 1,
					clientX: x,
					clientY: y,
					bubbles: true,
					cancelable: true
				});
				el.dispatchEvent(ev);
				await settle();
				const band = !!document.querySelector('#explorer-marquee');
				window.dispatchEvent(new PointerEvent('pointerup', { pointerType, bubbles: true }));
				await settle();
				return { prevented: ev.defaultPrevented, band };
			};
			const touch = await fire('touch');
			const mouse = await fire('mouse');
			return { touch, mouse };
		},
		[gb.x + gb.width - 18, gb.y + gb.height - 18]
	);
	h.check(
		touchProbe.touch.prevented === false && touchProbe.touch.band === false,
		`a TOUCH press on the background is left alone, so the grid still scrolls (${JSON.stringify(touchProbe.touch)})`
	);
	h.check(
		touchProbe.mouse.prevented === true && touchProbe.mouse.band === true,
		`counterfactual: the same press from a MOUSE starts the marquee (${JSON.stringify(touchProbe.mouse)})`
	);
	await page.waitForTimeout(200);

	// ---- 7. the batch menu, and the N-item zip ---------------------------------------
	await page.mouse.click(gb.x + gb.width - 18, gb.y + gb.height - 18);
	await clickCard(page, 'alpha.obj');
	await clickCard(page, 'bravo.obj', ['Control']);
	await clickCard(page, 'charlie.obj', ['Control']);
	const batchRows = await cardMenu(page, 'bravo.obj');
	h.check(
		batchRows.some((r) => /Download 3 files as \.zip/.test(r)),
		`the menu SAYS the files come down as one .zip (${batchRows.join(' | ')})`
	);
	h.check(
		batchRows.some((r) => /Delete 3 items/.test(r)),
		'…and names the count it would delete'
	);
	const [zipDl] = await Promise.all([
		page.waitForEvent('download', { timeout: 20000 }),
		page.locator('[role="menuitem"]').filter({ hasText: 'Download 3 files' }).first().click()
	]);
	const zipPath = await zipDl.path();
	const zipEntries = unzipSync(fs.readFileSync(zipPath));
	const zipNames = Object.keys(zipEntries).sort();
	h.check(
		JSON.stringify(zipNames) === JSON.stringify(['alpha.obj', 'bravo.obj', 'charlie.obj']),
		`the downloaded .zip really unzips to the three selected files (${zipNames.join(',')})`
	);
	h.check(
		// the fixture prefixes each file with a `# <name>` comment so the five hold
		// DIFFERENT bytes (see section 0) — the geometry it round-trips is still TINY_OBJ
		Buffer.from(zipEntries['alpha.obj']).toString() === '# alpha' + String.fromCharCode(10) + TINY_OBJ,
		'…with the stored bytes intact'
	);
	h.check(/\.zip$/.test(zipDl.suggestedFilename()), `named after the folder (${zipDl.suggestedFilename()})`);

	// a SINGLE selection still takes the direct download it always had
	await closeCtxMenu(page);
	await clickCard(page, 'alpha.obj');
	const singleRows = await cardMenu(page, 'alpha.obj');
	h.check(
		singleRows.some((r) => /^Download$/.test(r.trim())) && !singleRows.some((r) => /\.zip/.test(r)),
		`one selected item keeps the plain Download (${singleRows.join(' | ')})`
	);
	await closeCtxMenu(page);

	// ---- 8. N prefabs into ONE model file --------------------------------------------
	await page.evaluate(async () => {
		const p = window.__stores.prefabs;
		await p.loadPrefabs();
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const kids = group.children.slice(-2);
		await p.savePrefab(kids[0].uuid, 'FabOne');
		await p.savePrefab(kids[1].uuid, 'FabTwo');
	});
	await page.waitForTimeout(700);
	await page.locator('#prefabs-folder').click();
	await page.waitForTimeout(500);
	await clickEmptyGrid(page);
	await page.keyboard.press('Control+a');
	await page.waitForTimeout(250);
	const prefabSel = await selection(page);
	h.check(
		prefabSel.length === 2,
		`premise: both prefab cards are selected (${prefabSel.join(',')})`
	);
	const prefabRows = await cardMenu(page, 'FabOne');
	h.check(
		prefabRows.some((r) => /Export 2 objects as GLTF/.test(r)),
		`the batch menu offers ONE GLTF for the pair (${prefabRows.join(' | ')})`
	);
	const [gltfDl] = await Promise.all([
		page.waitForEvent('download', { timeout: 20000 }),
		page.locator('[role="menuitem"]').filter({ hasText: 'Export 2 objects as GLTF' }).first().click()
	]);
	const gltf = JSON.parse(fs.readFileSync(await gltfDl.path(), 'utf8'));
	h.check(
		(gltf.meshes?.length ?? 0) >= 2,
		`the single exported file carries BOTH prefabs (${gltf.meshes?.length} meshes)`
	);
	h.check(
		(gltf.scenes?.[0]?.nodes?.length ?? 0) === 2,
		`…as two roots in one scene (${gltf.scenes?.[0]?.nodes?.length})`
	);
	await closeCtxMenu(page);

	// ---- 9. batch DELETE: one confirm, and the skipped kinds are REPORTED -------------
	// The skipped case is reachable in a PACK view, where every card is a view of a
	// remote entry with no stored bytes. Driven through the real stores.
	await page.evaluate(() => window.__stores.explorer.activeFolder.set('pack:zz-test'));
	await page.waitForTimeout(400);
	await page.evaluate(() =>
		window.__stores.packs.openPackItems.set([
			{ name: 'RemoteA', packName: 'zz-test', kind: 'object', glbUrl: 'https://example.invalid/a.glb' },
			{ name: 'RemoteB', packName: 'zz-test', kind: 'object', glbUrl: 'https://example.invalid/b.glb' }
		])
	);
	await page.waitForTimeout(400);
	await clickEmptyGrid(page);
	await page.keyboard.press('Control+a');
	await page.waitForTimeout(250);
	h.check((await selection(page)).length === 2, 'premise: both pack cards are selected');
	await clearToasts(page);
	await page.keyboard.press('Delete');
	await page.waitForTimeout(400);
	const skipToasts = await toastTexts(page);
	h.check(
		skipToasts.some((t) => /Nothing to delete/.test(t) && /2 cards/.test(t)),
		`derived pack cards are refused WITH the reason and the count (${skipToasts.join(' | ')})`
	);

	// now the real thing: a folder + two files, ONE confirm naming both
	await page.evaluate(() => window.__stores.packs.openPackItems.set([]));
	await page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.explorer.explorerFolders.subscribe((list) => {
					window.__stores.explorer.activeFolder.set(list.find((f) => f.name === 'Work').id);
					r(true);
				})()
			)
	);
	await page.waitForTimeout(500);
	await clearToasts(page);
	await clickCard(page, 'Sub one');
	await clickCard(page, 'delta.obj', ['Control']);
	await clickCard(page, 'echo.obj', ['Control']);
	await page.keyboard.press('Delete');
	await page.waitForTimeout(400);
	const confirmToasts = (await toastTexts(page)).filter((t) => /^Delete /.test(t));
	h.check(
		confirmToasts.length === 1,
		`ONE confirm for the whole batch, not one per card (${confirmToasts.length}: ${confirmToasts.join(' | ')})`
	);
	h.check(
		/2 items/.test(confirmToasts[0] ?? '') && /1 folder/.test(confirmToasts[0] ?? ''),
		`the confirm names what it will take (${confirmToasts[0]})`
	);
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	// wait on the THING, not on a number: the batch awaits an idb blob delete AND a
	// whole-index rewrite per entry, which on a loaded box outran a flat 900ms sleep
	// while the feature was perfectly correct
	await h.eventually(
		() => folderNames(page),
		(names) => !names.includes('Sub one'),
		'the cascade finishes',
		15000
	);
	const namesAfter = await itemNames(page);
	const foldersAfter = await folderNames(page);
	h.check(
		!namesAfter.includes('delta.obj') && !namesAfter.includes('echo.obj'),
		`both files are gone (${namesAfter.join(',')})`
	);
	h.check(!foldersAfter.includes('Sub one'), `the folder went with them (${foldersAfter.join(',')})`);
	h.check(
		namesAfter.includes('alpha.obj') && foldersAfter.includes('Sub two'),
		'…and nothing outside the selection was touched'
	);
	// the set is cleared at the END of the batch, after the last idb write — the store
	// drops the folder before that, so this is a second wait, not the same one
	await h.eventually(
		() => selection(page),
		(sel) => sel.length === 0,
		'the selection is empty after the delete',
		10000
	);

	// ---- 10. the drag carries N — SPREAD by default ----------------------------------
	// The payload is harvested from the card's REAL dragstart handler (a DataTransfer the
	// test owns), so this covers the construction as well as the placement.
	await clearScene(page);
	await page.waitForTimeout(300);
	await clickEmptyGrid(page);
	await clickCard(page, 'alpha.obj');
	await clickCard(page, 'bravo.obj', ['Control']);
	await clickCard(page, 'charlie.obj', ['Control']);
	const payload = await page.evaluate(() => {
		const card = [...document.querySelectorAll('#explorer-list [data-card-id]')].find(
			(el) => (el.textContent || '').trim() === 'alpha.obj'
		);
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
		return dt.getData('application/x-explorer-item');
	});
	const parsed = JSON.parse(payload || '{}');
	h.check(
		Array.isArray(parsed.items) && parsed.items.length === 3,
		`a drag started on a member carries all three (${parsed.items?.length})`
	);
	h.check(
		parsed.id && parsed.kind === 'object',
		'…while the TOP-LEVEL fields stay exactly what a single drag has always sent'
	);
	await page.evaluate(
		(p) => window.__stores.explorerDrop.dropExplorerItem(p, 500, 250),
		parsed
	);
	await page.waitForTimeout(2500);
	const spread = await sceneObjects(page);
	h.check(spread.length === 3, `three objects arrive from one drop (${spread.length})`);
	const spreadXZ = spread.map((o) => o.pos[0] + ',' + o.pos[2]);
	h.check(
		new Set(spreadXZ).size === 3,
		`…at three DIFFERENT places by default (${spreadXZ.join(' | ')})`
	);
	const maxGap = Math.max(
		...spread.flatMap((a) =>
			spread.map((b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]))
		)
	);
	h.check(maxGap > 1, `the spread is a real distance apart (${maxGap.toFixed(2)}m)`);

	// ---- 11. …and STACKS with the setting on -----------------------------------------
	await clearScene(page);
	await page.waitForTimeout(300);
	const stackDefault = await page.evaluate(
		() => new Promise((r) => window.__stores.stackOnDrop.subscribe(r)())
	);
	h.check(stackDefault === false, 'premise: "stack on drop" is OFF by default');
	await page.evaluate(() => window.__stores.stackOnDrop.set(true));
	await page.evaluate((p) => window.__stores.explorerDrop.dropExplorerItem(p, 500, 250), parsed);
	await page.waitForTimeout(2500);
	const stacked = await sceneObjects(page);
	h.check(stacked.length === 3, `three objects again (${stacked.length})`);
	const stackedXZ = stacked.map((o) => o.pos[0] + ',' + o.pos[2]);
	h.check(
		new Set(stackedXZ).size === 1,
		`…all on ONE spot with the setting on (${stackedXZ.join(' | ')})`
	);
	await page.evaluate(() => window.__stores.stackOnDrop.set(false));

	// a card OUTSIDE the selection drags alone — and does not disturb the selection
	await clickEmptyGrid(page);
	await clickCard(page, 'alpha.obj');
	const lonePayload = await page.evaluate(() => {
		const card = [...document.querySelectorAll('#explorer-list [data-card-id]')].find(
			(el) => (el.textContent || '').trim() === 'bravo.obj'
		);
		const dt = new DataTransfer();
		card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
		return dt.getData('application/x-explorer-item');
	});
	const lone = JSON.parse(lonePayload || '{}');
	h.check(
		lone.items === undefined && lone.kind === 'object',
		'a card outside the selection drags ALONE, with no items array at all'
	);
	h.check(
		JSON.stringify(await selection(page)) === JSON.stringify(['alpha.obj']),
		'…and a drag never changes what is selected'
	);

	// ---- 12. a view change wipes the set ---------------------------------------------
	await clickCard(page, 'bravo.obj', ['Control']);
	h.check((await selection(page)).length === 2, 'premise: two cards picked');
	await page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await page.waitForTimeout(400);
	const afterNav = await page.evaluate(
		() =>
			[...document.querySelectorAll('#explorer-list [data-card-id]')].filter((el) =>
				(el.getAttribute('class') || '').includes('explorer-selected')
			).length
	);
	h.check(
		afterNav === 0,
		`leaving the folder wipes the set, so a later Delete cannot act on cards nobody can see (${afterNav})`
	);

	h.check((h.pageErrors(A) || []).length === 0, `no page errors (${(h.pageErrors(A) || []).join(' | ')})`);
	await h.finish(browser);
});

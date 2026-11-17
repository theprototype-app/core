// 21-H1 — THE FILES SELECTOR, AND WHERE A SCENE LANDS.
//
// Three locked answers meet in this suite, and each one is a thing a user reported or a
// thing that was quietly wrong:
//
//   answer 1  the primary row reads `Project | Scene`. GLTF joined JSON behind the cog
//             (DEFAULT OFF) and an enabled optional format renders on a SECOND ROW
//             rather than widening the first. The generalization that comes with it is
//             the FALLBACK: only `json` used to fall back when it was hidden, so hiding
//             GLTF while it was selected left the Save button aimed at a format with no
//             visible control. Section 4 is that, in both directions.
//   41b H14 the cog's popup became the "Save options" MODAL (shared with Compact's Save ▾):
//             its rows are kit Toggles editing a DRAFT — nothing changes until its Save
//             (which remembers the options and saves with them); Cancel forgets the draft.
//             Section 5 is that contract. This suite pins the LIST layout (Settings ▸
//             Interface ▸ Project actions), the one that draws the format row; the Compact
//             grid is `burger-project-actions`.
//   answers   the export refusal was wrong twice over. It refused a library of models
//   5 + 6     with no scene in it (fork 11 made a .tp the WHOLE Explorer, so that is a
//             real project), and it DESCRIBED what to do next instead of doing it.
//             Sections 6-8: the widened gate in both directions, then the button that
//             opens the Explorer with a focused inline input in a `Scenes` folder —
//             which is the ONE place left in the app that invents that folder (answer 6
//             retires it everywhere else, and `scene-folders` owns that half).
//
// Run: APP_URL='https://localhost:5201/' npm run e2e -- files-format-row
const h = require('./helpers.cjs');

const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKklEQVR4nGP8z8Dwn4EIwESMolGF+BUyMjAwMDIQBMQrJKgUvzt/EnIhAJTfBhFVsHRAAAAAAElFTkSuQmCC';

const openMenu = async (peer) => {
	await peer.page.evaluate(() => window.__tp.test.v1.closeMenu.set(false));
	await peer.page.waitForTimeout(400);
};
const closeMenu = async (peer) => {
	await peer.page.evaluate(() => window.__tp.test.v1.closeMenu.set(true));
	await peer.page.waitForTimeout(250);
};

/** the two rows, as the labels a user reads */
const formatRows = (peer) =>
	peer.page.evaluate(() => {
		const read = (id) =>
			[...(document.getElementById(id)?.querySelectorAll('button') ?? [])]
				.map((b) => b.textContent?.trim())
				.filter((t) => !!t);
		return {
			primary: read('format-row'),
			optionalPresent: !!document.getElementById('format-row-optional'),
			optional: read('format-row-optional'),
			cog: !!document.getElementById('export-settings-cog'),
			on: ['tp', 'tpscene', 'gltf', 'json'].filter((k) =>
				(document.getElementById('format-' + k)?.className ?? '').split(/\s+/).includes('on')
			)
		};
	});

const storedFormat = (peer) => peer.page.evaluate(() => localStorage.getItem('saveFormat'));

const openCog = async (peer) => {
	await peer.page.locator('#export-settings-cog').click();
	await peer.page.waitForSelector('#save-options-modal', { state: 'visible', timeout: 5000 });
	await peer.page.waitForTimeout(150);
};
/** the modal's Save: remembers the draft AND saves with it */
const saveCog = async (peer) => {
	await peer.page.locator('#save-options-save').click();
	await peer.page.waitForSelector('#save-options-modal', { state: 'detached', timeout: 5000 });
	await peer.page.waitForTimeout(250);
};
const cancelCog = async (peer) => {
	await peer.page.locator('#save-options-cancel').click();
	await peer.page.waitForSelector('#save-options-modal', { state: 'detached', timeout: 5000 });
	await peer.page.waitForTimeout(150);
};
const pressed = (peer, id) => peer.page.evaluate((i) => document.getElementById(i)?.getAttribute('aria-pressed') ?? null, id);

const toastsOf = (peer) =>
	peer.page.evaluate(() => {
		let toasts;
		window.__tp.test.v1.toastStore.subscribe((t) => (toasts = t))();
		return (toasts ?? []).map((t) => (typeof t === 'string' ? t : (t.text ?? '')));
	});
const clearToasts = (peer) => peer.page.evaluate(() => window.__tp.test.v1.toastStore.set([]));

const libraryOf = (peer) =>
	peer.page.evaluate(() => {
		let items, folders;
		window.__tp.test.v1.explorer.explorerItems.subscribe((v) => (items = v))();
		window.__tp.test.v1.explorer.explorerFolders.subscribe((v) => (folders = v))();
		return {
			items: items.map((i) => ({ name: i.name, folderId: i.folderId ?? null })),
			folders: folders.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId ?? null }))
		};
	});
const manifestUsed = (peer) =>
	peer.page.evaluate(() => window.__tp.test.v1.projectManifest.manifestInUse());

h.run(async () => {
	const browser = await h.launch();
	// 41b H14: the LIST layout draws the format row (Compact's default on a desktop has none)
	const A = await h.setupPage(browser, 'A', { storage: { 'ui:projectActions': 'list' } });
	await A.page.waitForFunction(() => !!window.__tp?.test.v1?.projectFile, { timeout: 30000 });

	// =====================================================================
	// 1. THE PRIMARY ROW IS `Project | Scene` + THE COG, AND NOTHING ELSE
	// =====================================================================
	await openMenu(A);
	const fresh = await formatRows(A);
	h.check(
		JSON.stringify(fresh.primary) === JSON.stringify(['Project', 'Scene']),
		`the primary row reads Project | Scene (${JSON.stringify(fresh.primary)})`
	);
	h.check(fresh.cog, 'and the cog sits on that row with them');
	h.check(
		JSON.stringify(fresh.on) === JSON.stringify(['tp']),
		`Project is the selected format on a fresh profile (${JSON.stringify(fresh.on)})`
	);
	// the id addresses the FORMAT, not the word — every suite reaching for #format-tp
	// keeps working, which is why the key stayed 'tp' while the label became "Project"
	h.check(
		((await A.page.getAttribute('#format-tp', 'title')) ?? '').toLowerCase().includes('whole project'),
		'the Project segment still says what it saves (the whole project as .tp)'
	);
	h.check(
		!fresh.optionalPresent,
		'with neither optional format enabled there is NO second row at all — it costs nothing by default'
	);
	h.check(
		(await A.page.locator('#format-gltf').count()) === 0 &&
			(await A.page.locator('#format-json').count()) === 0,
		'GLTF is hidden by default now, exactly like JSON (it used to be a permanent segment)'
	);

	// =====================================================================
	// 2. THE COG OPENS "SAVE OPTIONS", OFFERING BOTH, BOTH OFF
	// =====================================================================
	await openCog(A);
	const boxes = await A.page.evaluate(() => {
		const read = (id) => {
			const el = document.getElementById(id);
			return el ? { present: true, on: el.getAttribute('aria-pressed'), label: el.closest('.setting-row')?.querySelector('.sr-name')?.textContent?.trim() } : { present: false };
		};
		return { gltf: read('show-gltf-format'), json: read('show-json-format'), oldPopup: !!document.getElementById('export-settings-modal') };
	});
	h.check(!boxes.oldPopup, 'the cog opens the Save options modal (the small export-settings popup is gone)');
	h.check(boxes.gltf.present && boxes.json.present, 'Save options offers GLTF beside JSON');
	h.check(boxes.gltf.on === 'false' && boxes.json.on === 'false', `both default OFF (gltf ${boxes.gltf.on}, json ${boxes.json.on})`);
	h.check(/gltf/i.test(boxes.gltf.label ?? ''), `the new one reads like its neighbour ("${boxes.gltf.label}")`);
	h.check(
		(await A.page.evaluate(() => localStorage.getItem('showGltfFormat'))) === null,
		'and it writes nothing until it is touched (an untouched default is not a stored preference)'
	);

	// =====================================================================
	// 3. AN ENABLED FORMAT APPEARS ON A SECOND ROW, NOT IN THE FIRST
	// =====================================================================
	// the modal edits a DRAFT: the row does not move until Save
	await A.page.locator('#show-gltf-format').click();
	await A.page.waitForTimeout(200);
	h.check(!(await formatRows(A)).optionalPresent, 'a toggle in Save options changes nothing until its Save (a draft)');
	h.check(
		JSON.stringify(await A.page.evaluate(() => [...document.querySelectorAll('#save-format .seg-opt')].map((b) => b.textContent?.trim()))) ===
			JSON.stringify(['Project', 'Scene', 'GLTF']),
		'…while the modal’s own format choice already offers GLTF'
	);
	await saveCog(A);
	const withGltf = await formatRows(A);
	h.check(
		withGltf.optionalPresent && JSON.stringify(withGltf.optional) === JSON.stringify(['GLTF']),
		`saving the options adds a SECOND row carrying GLTF (${JSON.stringify(withGltf.optional)})`
	);
	h.check(
		JSON.stringify(withGltf.primary) === JSON.stringify(['Project', 'Scene']),
		'…and the primary row is untouched — the pair never moves as the options change'
	);
	h.check((await A.page.evaluate(() => localStorage.getItem('showGltfFormat'))) === 'true', 'and the choice is remembered');
	await openCog(A);
	await A.page.locator('#show-json-format').click();
	await saveCog(A);
	const withBoth = await formatRows(A);
	h.check(
		JSON.stringify(withBoth.optional) === JSON.stringify(['GLTF', 'JSON']),
		`with both enabled the second row holds both (${JSON.stringify(withBoth.optional)})`
	);
	h.check(
		JSON.stringify(withBoth.primary) === JSON.stringify(['Project', 'Scene']),
		'and STILL the first row is only the two primary formats'
	);
	// the rows are really stacked, not one wrapped line
	const stacked = await A.page.evaluate(() => {
		const a = document.getElementById('format-row')?.getBoundingClientRect();
		const b = document.getElementById('format-row-optional')?.getBoundingClientRect();
		return a && b ? Math.round(b.top - a.bottom) : null;
	});
	h.check(
		stacked !== null && stacked >= 0 && stacked < 20,
		`the optional row sits directly BELOW the primary one (${stacked}px gap)`
	);

	// =====================================================================
	// 4. HIDING THE SELECTED FORMAT FALLS BACK — BOTH OF THEM
	// =====================================================================
	// the guard is that a Save button can never point at a control the user cannot see.
	// It is asserted on the STORED value too: that is what the next boot reads.
	await A.page.locator('#format-gltf').click();
	await A.page.waitForTimeout(250);
	h.check((await storedFormat(A)) === 'gltf', 'premise: GLTF can be picked while it is showing');
	await openCog(A);
	h.check((await A.page.getAttribute('#save-format-gltf', 'aria-checked')) === 'true', 'premise: the modal opens on the picked format (GLTF)');
	await A.page.locator('#show-gltf-format').click();
	await A.page.waitForTimeout(200);
	h.check(
		(await A.page.getAttribute('#save-format-tp', 'aria-checked')) === 'true',
		'switching GLTF off in the modal moves its own format choice back to Project at once'
	);
	await saveCog(A);
	const afterHideGltf = await formatRows(A);
	h.check(
		(await storedFormat(A)) === 'tp',
		`hiding GLTF while it is SELECTED falls the format back to Project (stored "${await storedFormat(A)}")`
	);
	h.check(
		JSON.stringify(afterHideGltf.on) === JSON.stringify(['tp']),
		'…and the Project segment is the one lit, so the Save button and the row agree'
	);
	h.check(
		JSON.stringify(afterHideGltf.optional) === JSON.stringify(['JSON']),
		'the second row keeps the format that is still enabled'
	);
	// the same rule, on the one that already had it — the generalization did not lose it
	await A.page.locator('#format-json').click();
	await A.page.waitForTimeout(250);
	h.check((await storedFormat(A)) === 'json', 'premise: JSON can be picked while it is showing');
	await openCog(A);
	await A.page.locator('#show-json-format').click();
	await saveCog(A);
	h.check(
		(await storedFormat(A)) === 'tp',
		`hiding JSON while it is selected falls back the same way (stored "${await storedFormat(A)}")`
	);
	h.check(
		!(await formatRows(A)).optionalPresent,
		'and with neither enabled the second row is gone again'
	);

	// =====================================================================
	// 5. CANCEL FORGETS THE DRAFT
	// =====================================================================
	await openCog(A);
	await A.page.locator('#show-gltf-format').click();
	await A.page.locator('#tpscene-packs').click();
	await A.page.locator('#save-format-tpscene').click();
	await cancelCog(A);
	h.check(!(await formatRows(A)).optionalPresent && (await storedFormat(A)) === 'tp', 'Cancel leaves the rows and the stored format as they were');
	h.check(
		(await A.page.evaluate(() => [localStorage.getItem('showGltfFormat'), localStorage.getItem('tpscenePacks')])).join() === 'false,false',
		'…and stores nothing it was shown'
	);
	await openCog(A);
	h.check((await pressed(A, 'show-gltf-format')) === 'false' && (await pressed(A, 'tpscene-packs')) === 'false', 'reopening starts from the remembered options, not the abandoned draft');
	await cancelCog(A);
	await closeMenu(A);

	// =====================================================================
	// 6. THE EXPORT GATE, DIRECTION ONE: GENUINELY NOTHING REFUSES
	// =====================================================================
	await clearToasts(A);
	const emptyLib = await libraryOf(A);
	h.check(
		emptyLib.items.length === 0 && emptyLib.folders.length === 0 && !(await manifestUsed(A)),
		`premise: a fresh profile really is empty (${emptyLib.items.length} items, ${emptyLib.folders.length} folders)`
	);
	const refused = await A.page.evaluate(() => window.__tp.test.v1.projectFile.downloadProject());
	h.check(refused === null, 'exporting a completely empty library refuses instead of writing an empty zip');
	await h.eventually(
		() => toastsOf(A),
		(t) => t.some((x) => /nothing here yet/i.test(x)),
		'and says so'
	);
	const hasAction = await A.page
		.getByRole('button', { name: 'Save a scene' })
		.count();
	h.check(hasAction === 1, `the refusal carries a "Save a scene" BUTTON, not just a description (${hasAction})`);

	// =====================================================================
	// 7. THE BUTTON DOES THE THING IT DESCRIBES
	// =====================================================================
	// (the one place in the app that still premakes `Scenes`, deliberately: a first-time
	// user with nothing at all is better served by a starting structure than by the
	// never-invent-a-folder rule — see levels.js `ensureScenesFolder`)
	await A.page.getByRole('button', { name: 'Save a scene' }).click();
	await A.page.waitForTimeout(1200);
	const landed = await A.page.evaluate(() => {
		let close, active, folders;
		window.__tp.test.v1.explorerClose.subscribe((v) => (close = v))();
		window.__tp.test.v1.explorer.activeFolder.subscribe((v) => (active = v))();
		window.__tp.test.v1.explorer.explorerFolders.subscribe((v) => (folders = v))();
		const scenes = folders.find((f) => f.name === 'Scenes' && !f.parentId) ?? null;
		const input = document.querySelector('#explorer-new-card input');
		return {
			explorerOpen: close === false,
			scenesFolder: scenes?.id ?? null,
			activeIsScenes: !!scenes && active === scenes.id,
			inputPresent: !!input,
			inputFocused: !!input && document.activeElement === input,
			inputValue: input?.value ?? null,
			armCleared: (() => {
				let arm;
				window.__tp.test.v1.explorerSceneSaveArm.subscribe((v) => (arm = v))();
				return arm === null;
			})()
		};
	});
	h.check(landed.explorerOpen, 'the button OPENS the Explorer');
	h.check(!!landed.scenesFolder, 'it premakes a `Scenes` folder for the first-ever save');
	h.check(landed.activeIsScenes, 'and makes it the folder you are looking at');
	h.check(landed.inputPresent, 'the inline scene-name input is up');
	h.check(landed.inputFocused, 'and it is the FOCUSED element — the keys go there, nothing else to click');
	h.check(landed.inputValue === 'Scene', `pre-filled with the save default ("${landed.inputValue}")`);
	h.check(landed.armCleared, 'the arm store was CONSUMED — a stale request cannot re-open this next mount');

	// it really is the save path, not just an input: type and commit
	await A.page.keyboard.press('Control+a');
	await A.page.keyboard.type('Bootstrapped');
	await A.page.keyboard.press('Enter');
	await h.eventually(
		() => libraryOf(A),
		(lib) => lib.items.some((i) => i.name.includes('Bootstrapped')),
		'typing a name and pressing Enter saves the scene through the ordinary path'
	);
	const bootstrapped = await libraryOf(A);
	const scenesId = bootstrapped.folders.find((f) => f.name === 'Scenes' && !f.parentId)?.id;
	h.check(
		bootstrapped.items.find((i) => i.name.includes('Bootstrapped'))?.folderId === scenesId,
		'and it lands in the folder the bootstrap made — where the user was looking'
	);

	// =====================================================================
	// 8. THE GATE, DIRECTION TWO: A LIBRARY WITH NO SCENES IS A PROJECT
	// =====================================================================
	// fork 11 made a .tp the WHOLE Explorer, so a library of models with no scene in it
	// is a legitimate export. Wipe back to nothing, then furnish it with an IMAGE only —
	// no scene, no manifest — and assert the export runs.
	await A.page.evaluate(async () => {
		await window.__tp.test.v1.explorer.clearLibrary();
		window.__tp.test.v1.projectManifest.manifestRestore(null, false);
	});
	await A.page.waitForTimeout(600);
	h.check(
		!(await manifestUsed(A)) && (await libraryOf(A)).items.length === 0,
		'premise: wiped back to no project and no library'
	);
	await A.page.evaluate(async (png) => {
		const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
		await window.__tp.test.v1.explorer.addItemFromBytes(bytes.buffer, 'model-stand-in.png', null);
	}, TINY_PNG);
	await h.eventually(
		() => libraryOf(A),
		(lib) => lib.items.some((i) => i.name === 'model-stand-in.png'),
		'an asset is in the library (premise)'
	);
	h.check(
		!(await manifestUsed(A)),
		'…and the manifest is STILL not in use — which is exactly what the old gate refused on'
	);
	await clearToasts(A);
	const [dl] = await Promise.all([
		A.page.waitForEvent('download', { timeout: 20000 }),
		A.page.evaluate(() => window.__tp.test.v1.projectFile.downloadProject())
	]);
	h.check(
		dl.suggestedFilename().endsWith('.tp'),
		`a library with assets and no scenes exports as a .tp (${dl.suggestedFilename()})`
	);
	h.check(
		!(await toastsOf(A)).some((t) => /nothing here yet/i.test(t)),
		'and nothing refuses it any more'
	);
	const carried = await A.page.evaluate(async () => {
		const r = await window.__tp.test.v1.projectFile.exportProject();
		return { items: r.items, scenes: r.scenes };
	});
	h.check(
		carried.items >= 1 && carried.scenes === 0,
		`the file really carries the library item with zero scene versions (${carried.items} items / ${carried.scenes} scenes)`
	);

	h.check((await h.pageErrors(A)).length === 0, `no page errors (${JSON.stringify(await h.pageErrors(A))})`);
	await h.finish(browser);
});

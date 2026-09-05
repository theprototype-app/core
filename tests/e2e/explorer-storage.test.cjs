// R22 ROUND 13 P2 — THE STORAGE BREAKDOWN.
//
// "clicking on space consumed can open a modal with estimated size (what consumed how
// much space: saves sessions, scenes etc.) as a list and allow to cleanup per items or
// entire store, multiselect (checkboxes themed)."
//
//  §1  the ARITHMETIC identity: every category plus `unaccounted` is exactly the
//      browser's own `estimate.used`. That is the whole honesty of the panel — an origin
//      quota covers more than this app, so the sum has to name the remainder rather than
//      quietly absorbing it.
//  §2  CLASSIFICATION: nine populations seeded into one flat idb store come back in nine
//      categories, and the two splits the plan singles out actually split — library files
//      from hidden versions (which shelf the record is on) and saved scenes from saved
//      projects (`payload.library`).
//  §3  REFUSED, WITH A REASON: the library index, the project manifest and a version the
//      project still points at. All three carry a sentence, all three are refused by
//      `reclaimRow` as well as by the UI — the disabled tick is a courtesy, the leaf is
//      the rule. THE BREAK/RESTORE GUARD LIVES HERE (§3b).
//  §4  a real delete frees the BYTES and the ROW disappears.
//  §5  MULTISELECT ACROSS CATEGORIES: one reclaim spanning a library file, a session and
//      a prefab.
//  §6  THE REAL UI, driven through the real opener — a suite that only reads stores
//      cannot see a modal that crashed on mount.
//  §7  three ENTRY POINTS, because the header chip yields below 700px.
//
// Run: APP_URL='https://localhost:5207/' npm run e2e -- explorer-storage
const h = require('./helpers.cjs');

/** run a fresh scan in the page and hand back the whole shape */
const scan = (p) =>
	p.page.evaluate(async () => {
		const s = await window.__stores.storageUsage.scanStorage();
		return {
			at: s.at,
			estimate: s.estimate,
			accounted: s.accounted,
			unaccounted: s.unaccounted,
			keys: s.keys,
			categories: s.categories.map((c) => ({
				key: c.key,
				label: c.label,
				note: c.note,
				bytes: c.bytes,
				rows: c.rows.map((r) => ({
					id: r.id,
					label: r.label,
					sub: r.sub ?? null,
					bytes: r.bytes,
					removable: r.removable,
					reason: r.reason ?? null,
					kind: r.kind
				}))
			}))
		};
	});

/** @param {any} s @param {string} key */
const cat = (s, key) => s.categories.find((c) => c.key === key);
/** every row across every category */
const rows = (s) => s.categories.flatMap((c) => c.rows.map((r) => ({ ...r, category: c.key })));
/** @param {any} s @param {string} label */
const rowByLabel = (s, label) => rows(s).find((r) => r.label === label);

/** reclaim ONE row, addressed by its label, and report what the leaf says it freed */
const reclaimLabel = (p, label) =>
	p.page.evaluate(async (want) => {
		const s = await window.__stores.storageUsage.scanStorage();
		const row = s.categories.flatMap((c) => c.rows).find((r) => r.label === want);
		if (!row) return { found: false };
		const freed = await window.__stores.storageUsage.reclaimRow(row);
		return { found: true, freed, removable: row.removable };
	}, label);

const idbKeys = (p) => p.page.evaluate(() => window.__stores.idb.idbKeys().then((k) => k.map(String)));

const seedFiles = (p, names, folderId = null) =>
	p.page.evaluate(
		async ({ list, dir }) => {
			const e = window.__stores.explorer;
			const out = [];
			for (const n of list) {
				// a body big enough that its bytes are unambiguous next to the JSON records
				const body = new TextEncoder().encode(n + '|' + 'x'.repeat(4000)).buffer;
				const item = await e.addItemFromBytes(body, n, dir);
				out.push({ id: item.id, hash: item.hash, size: item.size });
			}
			return out;
		},
		{ list: names, dir: folderId }
	);

const wipe = (p) =>
	p.page.evaluate(async () => {
		await window.__stores.explorer.clearLibrary();
		const pm = window.__stores.projectManifest;
		pm.projectManifest.update((m) => ({
			...m,
			scenes: {},
			deleted: [],
			removed: { items: {}, folders: {} }
		}));
		// every saved session too, so §2's counts are about what THIS run seeded
		const list = await window.__stores.idb.idbKeys();
		for (const k of list) if (String(k).startsWith('session:')) await window.__stores.idb.idbDelete(String(k));
		await window.__stores.sessions.loadSessions();
		for (const p of (() => {
			let v;
			window.__stores.prefabs.prefabs.subscribe((x) => (v = x))();
			return v;
		})())
			await window.__stores.prefabs.removePrefab(p.id);
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(
		() => !!window.__stores?.storageUsage && !!window.__stores?.explorer && !!window.__stores?.sessions,
		null,
		{ timeout: 30000 }
	);
	h.check(true, 'premise: the storageUsage leaf is reachable through the debug hook');
	await page.evaluate(() => window.__stores.explorer.loadExplorer());
	await page.evaluate(() => window.__stores.sharedLibrary.keepRecycleBin.set(true));
	await page.waitForTimeout(400);
	await wipe(A);
	await page.waitForTimeout(300);

	// ---- 1. the arithmetic identity ---------------------------------------------------
	const s0 = await scan(A);
	h.check(!!s0.estimate, 'premise: this browser implements navigator.storage.estimate()');
	h.check(s0.keys > 0, 'the scan read the one idb store (' + s0.keys + ' keys)');
	const sumOfCats = s0.categories.reduce((n, c) => n + c.bytes, 0);
	h.check(
		sumOfCats === s0.accounted,
		'the categories sum to `accounted` (' + sumOfCats + ' === ' + s0.accounted + ')'
	);
	h.check(
		s0.accounted + s0.unaccounted === s0.estimate.used,
		'accounted + unaccounted === the browser reading, exactly (' +
			s0.accounted +
			' + ' +
			s0.unaccounted +
			' === ' +
			s0.estimate.used +
			')'
	);
	h.check(
		s0.categories.every((c) => c.rows.reduce((n, r) => n + r.bytes, 0) === c.bytes),
		'and every category is the sum of its own rows, so no byte is claimed twice'
	);
	h.check(
		s0.categories.every((c) => typeof c.note === 'string' && c.note.length > 20),
		'every category says what deleting it costs — the question a person freeing space is asking'
	);
	// the ESTIMATE is a whole-origin quota, so a row cannot claim the whole of it
	h.check(
		s0.accounted <= s0.estimate.used || s0.unaccounted < 0,
		'a sum over our own records never silently exceeds the reading without saying so'
	);

	// ---- 2. classification ------------------------------------------------------------
	const files = await seedFiles(A, ['keeper.txt', 'spare.txt', 'binned.txt']);
	// THREE versions of one scene, which is what it takes to produce both hidden cases at
	// once. `hideOldVersions` reconciles BOTH directions (21-G7 fork 10), so the POINTER is
	// pulled back onto the visible shelf and only the earlier ones stay hidden — a fixture
	// that publishes a single version therefore has nothing hidden at all, measured.
	// With "versions kept" at 2 the newest two are keepable, so of the two hidden rows one
	// is refused and one is not: the refusal is about the POINTER, not about the shelf.
	await page.evaluate(() => window.__stores.projectManifest.keepVersionsSetting.set(2));
	const [stale, version, pointer] = await seedFiles(A, [
		'Arena-v0.tpscene',
		'Arena-v1.tpscene',
		'Arena-v2.tpscene'
	]);
	await page.evaluate(
		({ hashes, ids }) => {
			const pm = window.__stores.projectManifest;
			for (const hash of hashes) pm.publishSceneVersion('Arena', hash);
			for (const id of ids) window.__stores.explorer.setItemHidden(id, true);
		},
		{
			hashes: [stale.hash, version.hash, pointer.hash],
			ids: [stale.id, version.id, pointer.id]
		}
	);
	// the RECYCLE BIN: the app's own delete, so the row lands where a user's would
	await page.evaluate((id) => window.__stores.sharedLibrary.deleteSharedItem(id), files[2].id);
	// a saved scene and a saved project — one record type, told apart by payload.library
	await page.evaluate(async () => {
		await window.__stores.sessions.saveSession('A saved scene');
		await window.__stores.sessions.saveSessionWithLibrary('A saved project');
	});
	// a prefab and an environment preset
	await page.evaluate(async () => {
		await window.__stores.prefabs.addPrefabRecord({
			id: 'storage-suite-prefab',
			name: 'Suite prefab',
			createdAt: Date.now(),
			element: { type: 'Mesh', name: 'x' }
		});
		await window.__stores.environment.saveEnvPreset('Suite preset');
	});
	await page.waitForTimeout(800);

	const s1 = await scan(A);
	h.check(
		cat(s1, 'library').rows.some((r) => r.label === 'keeper.txt'),
		'a library file lands in Library files'
	);
	h.check(
		cat(s1, 'versions').rows.some((r) => r.label === 'Arena-v1.tpscene'),
		'a HIDDEN scene version lands in Old scene versions — the shelf, not the key, is the split'
	);
	h.check(
		cat(s1, 'library').rows.some((r) => r.label === 'Arena-v2.tpscene'),
		'...while the version the project POINTS at is an ordinary library file (hideOldVersions unhides it)'
	);
	h.check(
		cat(s1, 'bin').rows.some((r) => r.label === 'binned.txt'),
		'a file in the recycle bin lands in Deleted files, not among the versions on the same shelf'
	);
	h.check(
		cat(s1, 'scenes').rows.some((r) => r.label === 'A saved scene'),
		'a session with no library lands in Saved scenes'
	);
	h.check(
		cat(s1, 'projects').rows.some((r) => r.label === 'A saved project'),
		'...and one carrying a library lands in Saved projects (`payload.library` is the discriminator)'
	);
	h.check(
		cat(s1, 'prefabs').rows.some((r) => r.label === 'Suite prefab'),
		'one idb key holding many prefabs becomes one ROW PER PREFAB'
	);
	h.check(
		cat(s1, 'presets').rows.some((r) => r.label === 'Suite preset'),
		'an environment preset gets its own row, named as the user named it'
	);
	h.check(
		cat(s1, 'structure').rows.length === 2,
		'the two STRUCTURE keys are listed rather than hidden (' + cat(s1, 'structure').rows.length + ')'
	);
	const keeperRow = rowByLabel(s1, 'keeper.txt');
	h.check(
		Math.abs(keeperRow.bytes - files[0].size) <= 2,
		'a file row reports its REAL blob size (' + keeperRow.bytes + ' vs ' + files[0].size + ')'
	);
	const projectRow = rowByLabel(s1, 'A saved project');
	const sceneRow = rowByLabel(s1, 'A saved scene');
	h.check(
		projectRow.bytes > sceneRow.bytes,
		'a project entry is larger than a scene one — it carries the library (' +
			projectRow.bytes +
			' > ' +
			sceneRow.bytes +
			')'
	);
	// the identity has to survive a store with real content in it
	h.check(
		s1.accounted + s1.unaccounted === s1.estimate.used,
		'the identity still holds with nine populations stored (' + s1.accounted + ' accounted)'
	);
	h.check(
		rows(s1).length === new Set(rows(s1).map((r) => r.id)).size,
		'every row id is unique, so a {#each} over them cannot throw (' + rows(s1).length + ' rows)'
	);

	// ---- 3. refused, with a reason ----------------------------------------------------
	const indexRow = cat(s1, 'structure').rows.find((r) => r.label === 'Library index');
	const manifestRow = cat(s1, 'structure').rows.find((r) => r.label === 'Project manifest');
	h.check(!indexRow.removable, 'the library index cannot be removed');
	h.check(
		!!indexRow.reason && /index|library/i.test(indexRow.reason),
		'...and it SAYS why rather than being absent (' + String(indexRow.reason).slice(0, 60) + '…)'
	);
	h.check(!manifestRow.removable, 'the project manifest cannot be removed');
	h.check(!!manifestRow.reason, '...and it says why too');
	h.check(
		rows(s1).every((r) => r.removable || (r.reason && r.reason.length > 20)),
		'EVERY refused row carries a sentence — the disabled-Watch-button convention'
	);
	h.check(
		rows(s1).some((r) => r.removable),
		'premise: most rows are removable, so the refusals are the exception and not the rule'
	);

	// ---- 3a. a version the project POINTS AT is refused -------------------------------
	const keptRow = rowByLabel(s1, 'Arena-v1.tpscene');
	const staleRow = rowByLabel(s1, 'Arena-v0.tpscene');
	h.check(
		!keptRow.removable,
		'a version inside keepableHashes() is refused — it is what "the latest of Arena" MEANS'
	);
	h.check(
		!!keptRow.reason && /point|pin|version/i.test(keptRow.reason),
		'...naming the manifest as the reason (' + String(keptRow.reason).slice(0, 60) + '…)'
	);
	h.check(
		staleRow.removable,
		'a hidden version NOTHING points at is removable — the refusal is about the pointer, not the shelf'
	);
	// the leaf refuses it too, not only the UI
	const refused = await reclaimLabel(A, 'Arena-v1.tpscene');
	h.check(refused.found && refused.freed === 0, 'reclaimRow refuses it as well — the tick is a courtesy, the leaf is the rule');
	const afterRefusal = await scan(A);
	h.check(
		!!rowByLabel(afterRefusal, 'Arena-v1.tpscene'),
		'...and the kept version is still there afterwards'
	);
	const refusedIndex = await reclaimLabel(A, 'Library index');
	h.check(refusedIndex.freed === 0, 'the index is refused by the leaf too');
	h.check(
		(await idbKeys(A)).includes('explorer:index'),
		'...and its key is untouched'
	);

	// ---- 3b. THE BREAK/RESTORE GUARD -------------------------------------------------
	// Prove the refusal is doing work by asking the SAME question with the pointer
	// removed: drop Arena's history, and the very same row must become removable. If
	// `keepableHashes` were not consulted, both readings would be identical — which is
	// exactly the counterfactual a passing check on its own cannot distinguish.
	await page.evaluate(() =>
		window.__stores.projectManifest.projectManifest.update((m) => ({ ...m, scenes: {} }))
	);
	await page.waitForTimeout(200);
	const noPointer = await scan(A);
	h.check(
		rowByLabel(noPointer, 'Arena-v1.tpscene').removable,
		'COUNTERFACTUAL: with the manifest pointer gone the same row is removable — the refusal reads keepableHashes(), it is not a constant'
	);
	await page.evaluate(
		({ hashes }) => {
			const pm = window.__stores.projectManifest;
			for (const hash of hashes) pm.publishSceneVersion('Arena', hash);
		},
		// BOTH, in order: re-publishing only v1 would make IT the pointer, which unhides it
		{ hashes: [version.hash, pointer.hash] }
	);
	await page.waitForTimeout(200);
	h.check(
		!rowByLabel(await scan(A), 'Arena-v1.tpscene').removable,
		'...and refused again once it is pointed at, so the rule tracks the project'
	);

	// ---- 4. a real delete frees the bytes AND the row goes ----------------------------
	const before = await scan(A);
	const spareBytes = rowByLabel(before, 'spare.txt').bytes;
	const keysBefore = await idbKeys(A);
	const done = await reclaimLabel(A, 'spare.txt');
	await page.waitForTimeout(400);
	const after = await scan(A);
	h.check(done.freed === spareBytes, 'reclaiming a file reports the bytes it held (' + done.freed + ')');
	h.check(!rowByLabel(after, 'spare.txt'), '...the row is gone from the next scan');
	const libBefore = cat(before, 'library').bytes;
	const libAfter = cat(after, 'library').bytes;
	h.check(
		libAfter === libBefore - spareBytes,
		'...Library files drops by exactly that (' + libBefore + ' -> ' + libAfter + ')'
	);
	// The TOTAL drops by MORE, and that is right rather than sloppy: `deleteItem` rewrites
	// the library index, which loses the row describing the file. Asserting an exact total
	// here would be asserting that a reclaim leaves the index untouched - the one thing it
	// must not do.
	h.check(
		before.accounted - after.accounted >= spareBytes,
		'...and the total drops by at least that, the index having shrunk with it (' +
			(before.accounted - after.accounted) +
			' >= ' +
			spareBytes +
			')'
	);
	h.check(
		cat(after, 'structure').bytes < cat(before, 'structure').bytes,
		'...visible as the index row itself getting smaller (' +
			cat(before, 'structure').bytes +
			' -> ' +
			cat(after, 'structure').bytes +
			')'
	);
	const keysAfter = await idbKeys(A);
	h.check(
		keysBefore.length - keysAfter.length === 1,
		'...one idb key really left the store (' + keysBefore.length + ' -> ' + keysAfter.length + ')'
	);
	h.check(
		!(await page.evaluate(() => {
			let items;
			window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
			return items.some((i) => i.name === 'spare.txt');
		})),
		'...and it went through the OWNING deleter, so the library index agrees it is gone'
	);
	h.check(
		(await idbKeys(A)).includes('explorer:index'),
		'...while the index itself survives — a reclaim is not a wipe'
	);

	// ---- 5. multiselect across categories --------------------------------------------
	const multi = await page.evaluate(async () => {
		const su = window.__stores.storageUsage;
		const s = await su.scanStorage();
		const all = s.categories.flatMap((c) => c.rows.map((r) => ({ ...r })));
		const want = ['keeper.txt', 'A saved scene', 'Suite prefab'];
		const picked = want.map((w) => all.find((r) => r.label === w)).filter(Boolean);
		const promised = su.selectionBytes(picked);
		const result = await su.reclaimRows(picked);
		const left = result.scan.categories.flatMap((c) => c.rows).map((r) => r.label);
		return {
			pickedCategories: picked.length,
			promised,
			freed: result.freed,
			leftovers: want.filter((w) => left.includes(w))
		};
	});
	h.check(multi.pickedCategories === 3, 'premise: three rows picked from three different categories');
	h.check(multi.leftovers.length === 0, 'one reclaim removed all three (' + multi.leftovers.join(', ') + ')');
	h.check(
		multi.freed === multi.promised,
		'and it freed exactly what the footer promised (' + multi.freed + ' === ' + multi.promised + ')'
	);
	h.check(
		(await scan(A)).categories.every((c) => c.bytes >= 0),
		'the re-scan reclaimRows returns is a real scan, not the stale one'
	);

	// ---- 6. THE REAL UI ---------------------------------------------------------------
	// re-seed something to look at, then drive the REAL opener. A suite that pokes the
	// store cannot see a component that crashed on mount.
	await seedFiles(A, ['ui-one.txt', 'ui-two.txt']);
	await page.waitForTimeout(400);
	await page.locator('#explorer-slot').click();
	await page.waitForTimeout(900);
	const chip = page.locator('#explorer-storage');
	h.check((await chip.count()) === 1, 'the header carries the space-consumed reading');
	h.check(
		(await chip.evaluate((el) => el.tagName)) === 'BUTTON',
		'...and it is a BUTTON now, not a passive span'
	);
	await chip.click();
	// WAIT FOR THE THING. Opening fires a fresh scan, and that scan reads every session
	// payload in full — on a headless box it lands well after any sleep worth writing, so
	// a fixed wait here measured the PREVIOUS scan and read one library row where there
	// were three. The panel is honest either way (it shows the last reading until the new
	// one arrives); the suite has to wait for the reading it is about to assert on.
	await h.eventually(
		() =>
			page.evaluate(() => {
				let sc;
				window.__stores.storageUsage.storageScan.subscribe((v) => (sc = v))();
				return (sc?.categories ?? []).find((c) => c.key === 'library')?.rows.length ?? -1;
			}),
		(n) => n === 3,
		'opening the panel runs a FRESH scan, which picks up files added since the last one',
		20000
	);
	h.check((await page.locator('#storage-modal').count()) === 1, 'clicking it opens the breakdown');
	h.check(
		await page.locator('#storage-summary').isVisible(),
		'...with the summary line rendered'
	);
	const honesty = await page.locator('#storage-summary').innerText();
	h.check(
		/estimate|everything else|overhead/i.test(honesty),
		'...saying the reading covers more than the library (' + honesty.replace(/\s+/g, ' ').slice(0, 80) + '…)'
	);
	h.check(
		(await page.locator('[data-storage-group]').count()) > 1,
		'the list is GROUPED — "saves sessions, scenes etc." is a request for categories'
	);

	// ---- 6a. COLLAPSED BY DEFAULT, AND THE HEAD READS AS A HEAD -----------------------
	// Flat, a group's title sat in the same visual register as its own rows and the list
	// read as one long run of items with headings mixed into it. Every check below opens
	// through the REAL chevron: a fold is a view state, so a suite that poked a store
	// could not tell a working control from a working store.
	const foldState = () =>
		page.evaluate(() => {
			const g = document.querySelector('[data-storage-group="library"]');
			if (!g) return null;
			const head = g.querySelector('.storage-group-head');
			const name = g.querySelector('.storage-group-name');
			const row = g.querySelector('.storage-row');
			return {
				open: g.getAttribute('data-open'),
				body: !!g.querySelector('.storage-group-body'),
				rows: g.querySelectorAll('.storage-row').length,
				expanded: g.querySelector('.storage-group-toggle')?.getAttribute('aria-expanded'),
				headBg: head ? getComputedStyle(head).backgroundColor : null,
				cardBg: getComputedStyle(g).backgroundColor,
				nameWeight: name ? Number(getComputedStyle(name).fontWeight) : -1,
				rowWeight: row ? Number(getComputedStyle(row).fontWeight) : -1,
				headH: head ? Math.round(head.getBoundingClientRect().height) : -1,
				groupH: Math.round(g.getBoundingClientRect().height)
			};
		});
	const f0 = await foldState();
	h.check(!!f0, 'premise: the Library group is on screen');
	h.check(f0.open === 'false' && !f0.body, 'every group starts COLLAPSED');
	h.check(f0.rows === 0, '...so none of its rows are rendered yet (' + f0.rows + ')');
	h.check(f0.expanded === 'false', '...and the toggle says so to a screen reader');
	h.check(
		Math.abs(f0.groupH - f0.headH) <= 3,
		'a shut group is exactly its one head line (' + f0.groupH + 'px card vs ' + f0.headH + 'px head)'
	);
	// the head must not sit in the same register as its rows — assert the COMPUTED colour
	h.check(
		!!f0.headBg && f0.headBg !== f0.cardBg && !/, 0\)$/.test(f0.headBg),
		'the head owns its own surface, a step off the card (' + f0.headBg + ' vs ' + f0.cardBg + ')'
	);
	h.check(f0.nameWeight >= 700, '...and its name carries header weight (' + f0.nameWeight + ')');
	await page.locator('#storage-group-toggle-library').click();
	await page.waitForTimeout(350);
	const f1 = await foldState();
	h.check(f1.open === 'true' && f1.body, 'the chevron expands it');
	h.check(f1.rows === 3, '...and the rows appear (' + f1.rows + ')');
	h.check(
		f1.nameWeight > f1.rowWeight && f1.rowWeight > 0,
		'the head still outweighs its rows once open (' + f1.nameWeight + ' vs ' + f1.rowWeight + ')'
	);
	// the refused-row checks below read INSIDE the structure group, so open that too
	h.check(
		(await page.locator('#storage-group-toggle-structure').count()) === 1,
		'premise: the Project structure group is on screen'
	);
	await page.locator('#storage-group-toggle-structure').click();
	await page.waitForTimeout(350);

	// THEMED checkboxes: assert the COMPUTED colour, never the class string. flowbite
	// paints the checked state with `background-color: currentColor !important`, so the
	// fill rides `color` — a right-looking class was the whole bug last time.
	const tick = await page.evaluate(() => {
		const el = document.querySelector('#storage-modal input.tp-check');
		if (!el) return null;
		const cs = getComputedStyle(el);
		const root = getComputedStyle(document.documentElement);
		return {
			color: cs.color,
			appearance: cs.appearance,
			accent: (root.getPropertyValue('--accent') || '').trim()
		};
	});
	h.check(!!tick, 'the rows carry real tp-check checkboxes');
	h.check(
		!!tick && tick.color !== 'rgb(37, 99, 235)' && /^rgb/.test(tick.color),
		'...whose computed COLOUR is the theme accent and not flowbite blue (' + (tick ? tick.color : 'n/a') + ')'
	);

	// a refused row's control is disabled AND its reason is on screen
	const refusedUi = await page.evaluate(() => {
		const li = [...document.querySelectorAll('[data-storage-row]')].find(
			(el) => el.getAttribute('data-removable') === 'false'
		);
		if (!li) return null;
		const box = li.querySelector('input.tp-check');
		return {
			disabled: !!box?.disabled,
			reason: (li.querySelector('.storage-row-reason')?.textContent ?? '').trim()
		};
	});
	h.check(!!refusedUi, 'premise: the modal is showing at least one refused row');
	h.check(!!refusedUi && refusedUi.disabled, 'a non-removable row cannot be ticked');
	h.check(
		!!refusedUi && refusedUi.reason.length > 20,
		'...and the reason is RENDERED beside it, not only in a tooltip (' + String(refusedUi?.reason).slice(0, 50) + '…)'
	);

	// per-category select-all ticks only what can go, and the footer names the bytes
	const groupState = () =>
		page.evaluate(() => {
			const read = (key) => {
				const g = document.querySelector('[data-storage-group="' + key + '"]');
				if (!g) return null;
				const boxes = [...g.querySelectorAll('.storage-row input.tp-check')];
				return {
					bytes: Number(g.querySelector('.storage-group-bytes')?.getAttribute('data-bytes') ?? -1),
					rows: boxes.length,
					checked: boxes.filter((b) => b.checked).length,
					headDisabled: !!g.querySelector('.storage-group-tick input')?.disabled
				};
			};
			return {
				library: read('library'),
				structure: read('structure'),
				reclaimDisabled: !!document.querySelector('#storage-reclaim')?.disabled
			};
		});
	await page.waitForTimeout(500);
	const g0 = await groupState();
	h.check(g0.library.rows >= 2, 'premise: the Library group is showing several rows (' + g0.library.rows + ')');
	h.check(g0.library.bytes > 0, 'premise: it has real bytes to free (' + g0.library.bytes + ')');
	h.check(g0.reclaimDisabled, 'Reclaim starts disabled - nothing is ticked yet');
	h.check(
		g0.structure.headDisabled,
		'a group where NOTHING can be removed offers a DISABLED select-all rather than a lie'
	);
	await page.locator('#storage-group-check-library').click();
	await page.waitForTimeout(400);
	const g1 = await groupState();
	h.check(
		g1.library.checked === g0.library.rows,
		'a group select-all ticks every row in it (' + g1.library.checked + ' of ' + g0.library.rows + ')'
	);
	h.check(g1.structure.checked === 0, 'and nothing outside that group (structure: ' + g1.structure.checked + ')');
	h.check(!g1.reclaimDisabled, '...which enables Reclaim');
	const footer = await page.locator('#storage-selection').innerText();
	h.check(footer.includes('would be freed'), 'the footer names the bytes about to be freed (' + footer.trim() + ')');
	h.check(
		footer.includes(String(g0.library.rows)),
		'...and counts what is ticked (' + g0.library.rows + ' rows)'
	);

	// ---- 6b. A SELECTION SURVIVES A SCAN THAT CHANGES NOTHING -------------------------
	// THE RECLAIM-ENABLEMENT GUARD, and the reported bug in one line. The invalidation
	// used to be keyed on `scan.at` — a fresh clock reading on EVERY scan — so any scan
	// emptied `picked`, and `openStorageModal` ALWAYS starts one while the panel is
	// already interactive on the previous reading. MEASURED: ticks vanished and Reclaim
	// went back to disabled over a row list identical to the one they were made against.
	// It is keyed on the ROWS now: an id the new scan still lists stays ticked.
	const atBefore = await page.evaluate(() => {
		let sc;
		window.__stores.storageUsage.storageScan.subscribe((v) => (sc = v))();
		return sc?.at ?? 0;
	});
	await page.evaluate(() => void window.__stores.storageUsage.scanStorage());
	await h.eventually(
		() =>
			page.evaluate(() => {
				let sc;
				window.__stores.storageUsage.storageScan.subscribe((v) => (sc = v))();
				return sc?.at ?? 0;
			}),
		(at) => at !== atBefore,
		'premise: a SECOND scan completed over the same rows',
		20000
	);
	await page.waitForTimeout(600);
	const g2 = await groupState();
	h.check(
		g2.library.rows === g0.library.rows,
		'premise: that scan changed nothing — same rows (' + g2.library.rows + ')'
	);
	h.check(
		g2.library.checked === g0.library.rows,
		'a re-scan that changes nothing KEEPS the ticks (' + g2.library.checked + ' of ' + g0.library.rows + ')'
	);
	h.check(!g2.reclaimDisabled, '...so Reclaim stays ENABLED — the reported bug');

	// ---- 6b2. COLLAPSING IS NOT DESELECTING -------------------------------------------
	await page.locator('#storage-group-toggle-library').click();
	await page.waitForTimeout(350);
	const folded = await page.evaluate(() => {
		const g = document.querySelector('[data-storage-group="library"]');
		return {
			open: g?.getAttribute('data-open'),
			rowsInDom: g?.querySelectorAll('.storage-row').length ?? -1,
			headTick: !!g?.querySelector('.storage-group-tick input')?.checked,
			picked: Number(g?.querySelector('.storage-group-count')?.getAttribute('data-picked') ?? -1),
			footer: (document.querySelector('#storage-selection')?.innerText ?? '').trim(),
			reclaimDisabled: !!document.querySelector('#storage-reclaim')?.disabled
		};
	});
	h.check(
		folded.open === 'false' && folded.rowsInDom === 0,
		'premise: the ticked group is folded away again'
	);
	h.check(folded.headTick, 'the select-all tick stays ticked while collapsed');
	h.check(
		folded.picked === g0.library.rows,
		'...and the head says how many are selected behind the fold (' + folded.picked + ')'
	);
	h.check(!folded.reclaimDisabled, 'a folded selection still counts — Reclaim stays enabled');
	h.check(
		folded.footer.includes(String(g0.library.rows)),
		'...and the footer still counts them (' + folded.footer + ')'
	);
	await page.locator('#storage-group-toggle-library').click();
	await page.waitForTimeout(350);

	// the act goes through ConfirmModal — the one truly modal dialog, for the one
	// blocking decision in this feature
	await page.locator('#storage-reclaim').click();
	await page.waitForTimeout(500);
	const dlg = await page.evaluate(() => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((x) => (d = x))();
		return d ? { title: d.title, message: d.message } : null;
	});
	h.check(!!dlg, 'Reclaim asks first, through the app-wide confirm');
	h.check(
		!!dlg && /\d/.test(dlg.title) && /this machine|peers/i.test(dlg.message),
		'...naming the bytes and saying it is local (' + (dlg ? dlg.title : 'n/a') + ')'
	);
	await page.locator('#confirm-dialog-cancel').click();
	await page.waitForTimeout(400);
	h.check(
		(await page.evaluate(() => {
			let items;
			window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
			return items.length;
		})) === 3,
		'cancelling removes nothing'
	);
	await page.locator('#storage-reclaim').click();
	await page.waitForTimeout(400);
	await page.locator('#confirm-dialog-ok').click();
	// three deletes and a re-scan, each one a real idb round trip
	await h.eventually(
		() =>
			page.evaluate(() => {
				let items;
				window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
				return items.length;
			}),
		(n) => n === 0,
		'confirming reclaims the WHOLE group, not the first row of it',
		20000
	);
	await h.eventually(
		() =>
			page.evaluate(() => {
				let sc;
				window.__stores.storageUsage.storageScan.subscribe((v) => (sc = v))();
				return (sc?.categories ?? []).find((c) => c.key === 'library')?.rows.length ?? -1;
			}),
		(n) => n === 0,
		'...and the panel re-scans itself, so the rows really disappear from it',
		20000
	);

	// ---- 6c. A DISABLED CONTROL IS NOT A BLOCKED ONE, AND AN ENABLED ONE IS NEITHER ---
	// flowbite's Button theme paints its disabled variant `cursor-not-allowed opacity-50`
	// (buttons/theme.js:140) and NEVER TAKES IT OFF: `Button.svelte:34` destructures
	// `const { base, ... } = $derived(button({ ..., disabled: isDisabled }))`, and a
	// destructuring declaration evaluates its object once, so the class string is frozen at
	// whatever the button mounted as. The `disabled` ATTRIBUTE beside it is a separate,
	// genuinely reactive derived. Both buttons here are born disabled - the modal opens with
	// a scan running and nothing ticked - so both wore the blocked cursor and the fade
	// permanently, in every state, which is the two reports read as one bug.
	//
	// So every check below reads the COMPUTED style, never the class string: the class
	// string is wrong in both directions and would report the feature working while it was
	// broken. The rules key off `:disabled` / `:not(:disabled)`, the half that is reactive.
	const reclaimCursor = await page.evaluate(() => {
		const b = document.querySelector('#storage-reclaim');
		return b
			? { disabled: !!b.disabled, cursor: getComputedStyle(b).cursor, opacity: getComputedStyle(b).opacity }
			: null;
	});
	h.check(
		!!reclaimCursor && reclaimCursor.disabled,
		'premise: with nothing ticked, Reclaim is disabled (and stays that way)'
	);
	h.check(
		!!reclaimCursor && reclaimCursor.cursor === 'default',
		'...and it shows a neutral cursor, not "blocked" (' + (reclaimCursor || {}).cursor + ')'
	);
	// ...but the FADE stays on Reclaim, and that is the half the user kept: "there is
	// nothing to do yet" is a real state and this button has no label change to say it.
	h.check(
		!!reclaimCursor && Number(reclaimCursor.opacity) < 0.9,
		'...while the GREY stays - nothing ticked is a real state, and the grey is what says so (' +
			(reclaimCursor || {}).opacity +
			')'
	);

	// ---- 6c2. AND IT COMES BACK IN FULL THE MOMENT SOMETHING IS TICKED ----------------
	// The user's words were "when any checkbox in modal selected remove opacity-50". With a
	// selection the button is ENABLED, so flowbite paints no disabled variant and there is
	// nothing to remove - which means this check is really an assertion about the SELECTION
	// surviving to the button. That is the shape of the bug this round already found once
	// (a landing scan emptied `picked` under it), so the guard is worth its two lines.
	// 6b reclaimed the whole Library group, so the panel is currently down to rows it
	// REFUSES - seed one back and re-scan, or the premise below is vacuously false and the
	// check that follows would be reading a button nothing could ever enable.
	await page.evaluate(async () => {
		const e = window.__stores.explorer;
		await e.addItemFromBytes(new TextEncoder().encode('opacity probe').buffer, 'opacity-probe.txt', null);
		await window.__stores.storageUsage.scanStorage();
	});
	await page.waitForTimeout(600);
	const pickables = await page.evaluate(() => {
		let sc;
		window.__stores.storageUsage.storageScan.subscribe((v) => (sc = v))();
		return (sc?.categories ?? []).flatMap((c) => c.rows).filter((r) => r.removable).length;
	});
	h.check(pickables > 0, 'premise: something in the panel can be ticked again (' + pickables + ')');
	await page.locator('#storage-select-all').click();
	await page.waitForTimeout(400);
	const reclaimPicked = await page.evaluate(() => {
		const b = document.querySelector('#storage-reclaim');
		return b
			? { disabled: !!b.disabled, opacity: getComputedStyle(b).opacity, cursor: getComputedStyle(b).cursor }
			: null;
	});
	h.check(
		!!reclaimPicked && !reclaimPicked.disabled,
		'ticking anything ENABLES Reclaim - the selection reaches the button'
	);
	h.check(
		!!reclaimPicked && reclaimPicked.opacity === '1',
		'...and it renders at full strength, with no leftover fade (' + (reclaimPicked || {}).opacity + ')'
	);
	h.check(
		!!reclaimPicked && reclaimPicked.cursor === 'pointer',
		'...and offers a pointer, not the blocked cursor it was born wearing (' +
			(reclaimPicked || {}).cursor +
			')'
	);
	// THE COUNTERFACTUAL, measured in-page: the CLASS STRING still says disabled on both
	// buttons in every state. That is the bug these three checks stand on, and it is also
	// why none of them may assert a class.
	const staleClasses = await page.evaluate(() => {
		const cls = (id) => document.querySelector(id)?.className ?? '';
		return {
			reclaim: /opacity-50/.test(cls('#storage-reclaim')) && /cursor-not-allowed/.test(cls('#storage-reclaim')),
			rescan: /opacity-50/.test(cls('#storage-rescan')) && /cursor-not-allowed/.test(cls('#storage-rescan'))
		};
	});
	h.check(
		staleClasses.reclaim && staleClasses.rescan,
		'...while the CLASS STRING on both still says disabled - flowbite freezes it at mount, ' +
			'so a class assertion here would read the feature as broken'
	);
	await page.locator('#storage-select-all').click();
	await page.waitForTimeout(350);
	h.check(
		await page.evaluate(() => !!document.querySelector('#storage-reclaim')?.disabled),
		'...and un-ticking puts it back, so the two states really are different'
	);

	await page.locator('#storage-rescan').click();
	await page
		.waitForFunction(() => !!document.querySelector('#storage-rescan')?.disabled, null, {
			timeout: 10000
		})
		.catch(() => {});
	const rescanCursor = await page.evaluate(() => {
		const b = document.querySelector('#storage-rescan');
		return b
			? {
					disabled: !!b.disabled,
					cursor: getComputedStyle(b).cursor,
					opacity: getComputedStyle(b).opacity,
					label: (b.innerText || '').trim()
				}
			: null;
	});
	h.check(
		!!rescanCursor && rescanCursor.disabled,
		'premise: Rescan disables itself while the scan it started runs (' + (rescanCursor || {}).label + ')'
	);
	h.check(
		!!rescanCursor && rescanCursor.cursor === 'default',
		'a disabled Rescan shows a neutral cursor, not "blocked" (' + (rescanCursor || {}).cursor + ')'
	);
	// ...AND NO FADE AT ALL, which is where Rescan parts company with Reclaim. It is
	// disabled only because the thing it does is ALREADY HAPPENING, and it says that in its
	// own label; a fade on top of that repeats it in the vocabulary of refusal.
	h.check(
		!!rescanCursor && rescanCursor.opacity === '1',
		'...and it is not faded either - "Reading..." already says why it is disabled (' +
			(rescanCursor || {}).opacity +
			')'
	);
	await h.eventually(
		() =>
			page.evaluate(() => {
				let v;
				window.__stores.storageUsage.storageScanning.subscribe((x) => (v = x))();
				return v;
			}),
		(v) => v === false,
		'...and it comes back once the scan finishes',
		20000
	);
	await page.waitForTimeout(400);
	const rescanLive = await page.evaluate(() => {
		const b = document.querySelector('#storage-rescan');
		return b
			? { disabled: !!b.disabled, cursor: getComputedStyle(b).cursor, opacity: getComputedStyle(b).opacity }
			: null;
	});
	h.check(!!rescanLive && !rescanLive.disabled, 'premise: Rescan is live again');
	h.check(
		!!rescanLive && rescanLive.cursor === 'pointer' && rescanLive.opacity === '1',
		'...and a LIVE Rescan looks live - pointer, full strength (' +
			(rescanLive || {}).cursor +
			', ' +
			(rescanLive || {}).opacity +
			')'
	);

	// ---- 7. three entry points --------------------------------------------------------
	await page.evaluate(() => window.__stores.storageUsage.storageModalOpen.set(false));
	await page.waitForTimeout(400);
	// (a) the chip — already proven above. (b) the Explorer background menu.
	await page.evaluate(() => {
		const grid = document.querySelector('#explorer-grid');
		const box = grid.getBoundingClientRect();
		grid.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				clientX: Math.round(box.left + box.width / 2),
				clientY: Math.round(box.top + box.height - 12)
			})
		);
	});
	await page.waitForTimeout(400);
	const menuRows = await page.evaluate(() =>
		[...document.querySelectorAll('[role="menuitem"]')].map((r) => r.innerText.trim())
	);
	h.check(
		menuRows.some((r) => /Storage used/i.test(r)),
		'the Explorer background menu offers it too — the chip is hidden below a 700px header (' +
			menuRows.length +
			' rows)'
	);
	await page.getByRole('menuitem', { name: /Storage used/i }).click();
	await page.waitForTimeout(1200);
	h.check(
		(await page.locator('#storage-modal').count()) === 1,
		'...and it opens the SAME modal, not a second concept'
	);
	await page.evaluate(() => window.__stores.storageUsage.storageModalOpen.set(false));
	await page.waitForTimeout(300);

	// (c) Settings ▸ Explorer
	// through the app's OWN deep link, not a second concept: an AccordionItem renders its
	// body only while it is open, so a suite that merely opens Settings finds no row at all
	await page.evaluate(() => {
		window.__stores.settingsSection.set('explorer');
		window.__stores.settingsOpen.set(true);
	});
	await page.waitForTimeout(900);
	const settingsBtn = page.locator('#settings-storage');
	h.check((await settingsBtn.count()) === 1, 'Settings has a row for it as well — where somebody goes looking');
	const inExplorerSection = await page.evaluate(() => {
		const btn = document.querySelector('#settings-storage');
		const section = btn?.closest('[data-accordion-item], li, div');
		// the recycle-bin switch is the marker for the Explorer accordion
		let el = btn;
		for (let i = 0; i < 12 && el; i++) {
			if (el.querySelector?.('#recycle-bin')) return true;
			el = el.parentElement;
		}
		return !!section && false;
	});
	h.check(inExplorerSection, 'and it lives in the EXPLORER section, beside the other file rules');
	await settingsBtn.click();
	await page.waitForTimeout(1200);
	h.check((await page.locator('#storage-modal').count()) === 1, 'the Settings row opens the same modal');
	await page.evaluate(() => {
		window.__stores.storageUsage.storageModalOpen.set(false);
		window.__stores.settingsOpen.set(false);
	});
	await page.waitForTimeout(400);

	h.check(
		(h.pageErrors(A) || []).length === 0,
		'no page errors (' + (h.pageErrors(A) || []).join(' | ') + ')'
	);
	await h.finish(browser);
});

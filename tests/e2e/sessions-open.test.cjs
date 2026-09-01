// R22 ROUND 13 — THE SESSIONS ROW: ICONS, OPEN, AND A .tp THAT LANDS IN SESSIONS.
//
// Four reports, one row:
//
//   "Change emojis ▶,⤵ to Lucid icons inside modal"
//   "Instead of 'Load' for items put 'Open'"
//   "When add .tp file using 'import session file' button from Sessions modal should just
//    add another item in Sessions 'projects', same as when importing .tpscene, fix it as
//    now it imports it as a folder inside projets Library"
//   "import session file, when chosen in '+ Mount project...' Explorer button, it should
//    automatically also mount this session file, not just import"
//
// The two-peer half of "Open" (a project open LEAVES the session first) is its own file,
// `sessions-open-peers` — signaling is slow and this suite has to stay inside the runner's
// 8-minute budget.
//
// Run: APP_URL='https://localhost:5206/' npm run e2e -- sessions-open
const h = require('./helpers.cjs');

/** the saved entries, as the manager's own store sees them */
const metas = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.sessions.sessions.subscribe((x) => (v = x))();
		return (v ?? []).map((m) => ({ id: m.id, name: m.name, lib: m.hasLibrary, files: m.libraryCount }));
	});

const openSessions = async (p) => {
	await p.page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await p.page.waitForTimeout(900);
};

/** whatever ConfirmModal is showing — the boolean form and the choices form both */
const dialog = (p) =>
	p.page.evaluate(() => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
		return d
			? {
					title: d.title,
					message: d.message,
					confirm: d.confirmLabel,
					choices: (d.choices ?? []).map((/** @type {any} */ c) => c.value)
				}
			: null;
	});
/** answer it: false = cancel (a choices dialog resolves null), a string = that choice */
const answer = (p, value) =>
	p.page.evaluate((v) => window.__stores.confirmDialog.resolveConfirm(v), value);

/** where the app thinks it is — the identity chip and the window title both read this */
const level = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v ?? null;
	});

const libraryOf = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerItems.subscribe((x) => (v = x))();
		return (v ?? []).map((i) => i.name);
	});

/** the mounted roots, as the Explorer draws them above Library */
const volsOf = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.mountedVolumes.mountedVolumes.subscribe((x) => (v = x))();
		return (v ?? []).map((r) => ({ id: r.id, sessionId: r.sessionId, name: r.name, items: (r.items ?? []).length }));
	});

const foldersOf = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.explorer.explorerFolders.subscribe((x) => (v = x))();
		return (v ?? []).map((f) => f.name);
	});

async function openExplorer(p) {
	const open = await p.page.evaluate(
		() => !!document.querySelector('#explorer-list') || !!document.querySelector('#explorer-window')
	);
	if (!open) await p.page.locator('#explorer-slot').click();
	await p.page.waitForTimeout(900);
}

/**
 * Press Open on one row and settle. The SCENE guard may or may not speak first — after a
 * load the world either matches the payload it came from or does not — so this answers it
 * when it is there and reports which happened, rather than assuming a verdict that depends
 * on a whole-scene serialization.
 */
async function pressOpen(p, name) {
	await p.page.locator('#session-view-list').click();
	await p.page.waitForTimeout(400);
	const row = p.page.locator('#session-list .session-row').filter({ hasText: name }).first();
	await row.locator('.session-load').click();
	await p.page.waitForTimeout(700);
	const first = await dialog(p);
	if (first && (first.choices ?? []).length) {
		await answer(p, 'open');
		await p.page.waitForTimeout(600);
		return { guard: first, next: await dialog(p) };
	}
	return { guard: null, next: first };
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.sessions && !!window.__stores?.explorer, null, {
		timeout: 30000
	});
	await page.evaluate(async () => {
		await window.__stores.explorer.loadExplorer();
		await window.__stores.explorer.clearLibrary();
	});
	await page.waitForTimeout(500);

	// one scene worth saving, and one file so the project entry is a real project
	await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		s.objectActions.deselectObject();
		await s.explorer.addItemFromBytes(new TextEncoder().encode('notes').buffer, 'readme.txt', null);
	});
	await page.waitForTimeout(900);
	await page.evaluate(async () => {
		const s = window.__stores.sessions;
		s.saveSession('Wharf');
		await new Promise((r) => setTimeout(r, 400));
		await s.saveSessionWithLibrary('Depot');
	});
	await page.waitForTimeout(900);
	const saved = await metas(A);
	h.check(
		saved.length === 2 && saved.some((m) => m.name === 'Wharf' && !m.lib) && saved.some((m) => m.name === 'Depot' && m.lib),
		`premise: a SCENE entry and a PROJECT entry are saved (${JSON.stringify(saved.map((m) => [m.name, m.lib]))})`
	);

	// ---- 1. THE GLYPHS ARE GONE, in BOTH views ---------------------------------------
	// The view is a REMEMBERED pref and only LIST rows carry `.session-row`, so each half
	// is pinned rather than inherited from whatever the last suite left in localStorage.
	await openSessions(A);
	const readRow = (selector) =>
		page.evaluate((sel) => {
			const row = document.querySelector(sel);
			if (!row) return null;
			const btn = (cls) => row.querySelector(cls);
			const read = (cls) => {
				const el = btn(cls);
				if (!el) return null;
				const icon = el.querySelector('svg');
				return {
					text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
					svg: el.querySelectorAll('svg').length,
					// "inherits currentColor" is exactly this equality, and it is what a
					// hardcoded gray would break while still LOOKING like an icon
					stroke: icon ? getComputedStyle(icon).stroke : '',
					color: getComputedStyle(el).color
				};
			};
			return {
				glyphs: /[▶⤵⧉✕]/.test(row.textContent || ''),
				load: read('.session-load'),
				mount: read('.session-mount'),
				imports: read('.session-import'),
				del: read('button[aria-label="Delete"]')
			};
		}, selector);

	await page.locator('#session-view-list').click();
	await page.waitForTimeout(500);
	const listRow = await readRow('#session-list .session-row');
	h.check(!!listRow, 'premise: the LIST view draws rows');
	h.check(!listRow.glyphs, 'no ▶ ⤵ ⧉ ✕ is left anywhere in a list row');
	h.check(
		listRow.load?.svg === 1 && listRow.imports?.svg === 1 && listRow.del?.svg === 1,
		`every action button carries a real icon instead (${JSON.stringify([listRow.load?.svg, listRow.imports?.svg, listRow.del?.svg])})`
	);
	// icons inherit `currentColor` — the app's rule, and the one thing a hardcoded fill
	// would break silently (it would still LOOK like an icon in a screenshot)
	h.check(
		!!listRow.load?.stroke && listRow.load.stroke === listRow.load.color,
		`…drawn in the button's own colour, never a hardcoded one (${listRow.load?.stroke} vs ${listRow.load?.color})`
	);

	await page.locator('#session-view-grid').click();
	await page.waitForTimeout(500);
	const cardRow = await readRow('.session-card');
	h.check(!!cardRow, 'premise: the GRID view draws cards');
	h.check(!cardRow.glyphs, 'and no glyph is left in a grid card either');
	h.check(
		cardRow.load?.svg === 1 && cardRow.imports?.svg === 1 && cardRow.del?.svg === 1,
		`the same three buttons carry the same three icons there (${JSON.stringify([cardRow.load?.svg, cardRow.imports?.svg, cardRow.del?.svg])})`
	);

	// the WORDS are untouched by the icon change — this is what the round-11 checks read
	h.check(
		/Import (files|objects)/.test(cardRow.imports?.text ?? ''),
		`the import button still says what it does (${cardRow.imports?.text})`
	);

	// a PROJECT card is the only one offered a Mount, and it wears the mount icon
	const mount = await page.evaluate(() => {
		const card = [...document.querySelectorAll('.session-card')].find((c) => /Project/.test(c.textContent || ''));
		const other = [...document.querySelectorAll('.session-card')].find((c) => !/Project/.test(c.textContent || ''));
		const btn = card?.querySelector('.session-mount');
		return {
			project: btn ? { text: (btn.textContent || '').trim(), svg: btn.querySelectorAll('svg').length } : null,
			scene: other ? other.querySelectorAll('.session-mount').length : -1
		};
	});
	h.check(
		mount.project?.svg === 1 && /^Mount$/.test(mount.project?.text ?? ''),
		`Mount lost its ⧉ and kept its word (${JSON.stringify(mount.project)})`
	);
	h.check(mount.scene === 0, 'a SCENE entry is still offered no Mount at all');

	// ---- 2. "Open", AND THE GUARD IT NOW GOES THROUGH --------------------------------
	// Load replaced the world in silence. Open asks the same question the Explorer's own
	// scene card asks, through the same `sceneOpenGuard` — one copy, three callers.
	await page.locator('#session-view-list').click();
	await page.waitForTimeout(500);
	const label = await page.evaluate(() =>
		document.querySelector('#session-list .session-load')?.textContent?.trim()
	);
	h.check(label === 'Open', `the button says Open, not Load (${label})`);

	// the scene on screen has never been saved and is not empty, so a replace risks it
	const wharf = page.locator('#session-list .session-row').filter({ hasText: 'Wharf' }).first();
	await wharf.locator('.session-load').click();
	await page.waitForTimeout(700);
	const asked = await dialog(A);
	h.check(asked?.title === 'Open "Wharf"?', `it asks before replacing the world (${asked?.title})`);
	h.check(
		(asked?.choices ?? []).join(',') === 'save,open',
		`…and it is the guard's own dialog, not a second copy of the question (${JSON.stringify(asked?.choices)})`
	);
	h.check(
		/never been saved/.test(asked?.message ?? ''),
		`…which knows this scene has no identity to be dirty against (${(asked?.message ?? '').slice(0, 48)})`
	);

	// CANCEL means nothing happened, and the manager is still where it was
	await answer(A, false);
	await page.waitForTimeout(900);
	const cancelled = await page.evaluate(() => {
		let open;
		window.__stores.sessionsOpen.subscribe((v) => (open = v))();
		return open;
	});
	h.check(cancelled === true, 'cancelling leaves the manager open, exactly where it was');
	h.check((await level(A)) === null, 'and nothing was loaded');

	// ---- 3. THE MARKER: opened from Sessions, not from the library --------------------
	await wharf.locator('.session-load').click();
	await page.waitForTimeout(700);
	await answer(A, 'open');
	// WAIT ON THE THING, never a fixed sleep: applySession stashes a "Backup before …"
	// entry first, which is a whole-scene serialization plus a rendered thumbnail
	await h.eventually(
		() => level(A),
		(v) => v?.name === 'Wharf (from Sessions)',
		'the scene identity names it and says where it came from',
		20000
	);
	const at = await level(A);
	h.check(
		at?.hash === '' && at?.unsaved === true,
		`…as a loose scene: no hash, not a member of the project (${JSON.stringify({ hash: at?.hash, unsaved: at?.unsaved })})`
	);
	h.check(
		typeof at?.signature === 'string' && at.signature.length > 10,
		'…carrying the payload’s own content signature, so the dirty dot means something'
	);
	const title = await page.evaluate(() => document.title);
	h.check(/^Wharf \(from Sessions\) - /.test(title), `the window title says the same thing (${title})`);
	await openExplorer(A);
	const chip = await page.evaluate(() => document.querySelector('#explorer-scene')?.textContent?.trim());
	h.check(
		chip === 'Wharf (from Sessions)',
		`and so does the Explorer's identity chip, beside the project name (${chip})`
	);

	// ---- 4. A PROJECT IS A DIFFERENT OPEN, and it warns on its own terms --------------
	await openSessions(A);
	const depot = await pressOpen(A, 'Depot');
	h.check(
		depot.next?.title === 'Open project "Depot"?',
		`a project entry warns before it replaces anything (${depot.next?.title})`
	);
	h.check(
		/replaces the scene on screen/.test(depot.next?.message ?? '') &&
			/1 saved file/.test(depot.next?.message ?? ''),
		`…saying what it will do to the scene AND to the Explorer (${(depot.next?.message ?? '').slice(0, 70)})`
	);
	h.check(
		depot.next?.confirm === 'Open project' && !/leave the session/i.test(depot.next?.message ?? ''),
		`with nobody connected it says nothing about leaving one (${depot.next?.confirm})`
	);
	await answer(A, false);
	await page.waitForTimeout(900);
	h.check(
		(await level(A))?.name === 'Wharf (from Sessions)',
		'cancelling a project open leaves the open scene alone'
	);

	const again = await pressOpen(A, 'Depot');
	h.check(!!again.next, 'premise: the warning is asked again on a second press');
	await answer(A, true);
	await h.eventually(
		() => level(A),
		(v) => v?.name === 'Depot (from Sessions)',
		'accepting opens it, and the identity follows',
		20000
	);
	h.check(
		(await libraryOf(A)).includes('readme.txt'),
		`…with the project's own files back in the Explorer (${JSON.stringify(await libraryOf(A))})`
	);

	// ---- 5. A .tp CHOSEN HERE BECOMES A SESSIONS ENTRY, not a library folder ---------
	// The bytes come from `exportProjectFromSession`, so this is the round trip through
	// the writer/reader pair: download a project out of this list, hand it back to the
	// list's own Import button, and get the project back.
	await openSessions(A);
	const depotId = (await metas(A)).find((m) => m.name === 'Depot')?.id;
	h.check(!!depotId, 'premise: the Depot entry is still there to export');
	const b64 = await page.evaluate(async (id) => {
		const payload = await window.__stores.sessions.getSession(id);
		const out = await window.__stores.projectFile.exportProjectFromSession(payload);
		if (!out) return null;
		// CHUNKED on the page side: String.fromCharCode(...bytes) over a whole zip
		// overflows the argument stack, which reads as a mysteriously empty export
		let s = '';
		const b = out.bytes;
		for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
		return btoa(s);
	}, depotId);
	h.check(!!b64 && b64.length > 200, `premise: a .tp was written out of the saved record (${b64?.length} b64 chars)`);

	const foldersBefore = await foldersOf(A);
	await page.locator('#session-import-file').setInputFiles({
		name: 'Harbour.tp',
		mimeType: 'application/zip',
		buffer: Buffer.from(b64, 'base64')
	});
	await h.eventually(
		() => metas(A),
		(list) => list.some((m) => m.name === 'Harbour' && m.lib),
		'a .tp imported HERE lands as a project entry in this list',
		20000
	);
	const harbour = (await metas(A)).find((m) => m.name === 'Harbour');
	h.check(
		harbour?.files === 1,
		`…carrying the project's library, not just its scene (${harbour?.files} file)`
	);
	h.check(
		harbour?.name === 'Harbour',
		'…named after the FILE you picked, which is 21-I’s rule for a .tp'
	);
	// THE OTHER HALF, and the reason this was reported: it must NOT become a folder. An
	// absence check needs its presence half, and the entry above is it.
	const foldersAfter = await foldersOf(A);
	h.check(
		!foldersAfter.includes('Harbour') && foldersAfter.length === foldersBefore.length,
		`…and NOT as a folder in the Library, which is the other button's job (${JSON.stringify(foldersAfter)})`
	);
	// it opens like any other project entry — which is the whole point of it being one
	const reopened = await pressOpen(A, 'Harbour');
	h.check(
		reopened.next?.title === 'Open project "Harbour"?',
		`the imported entry behaves as a project (${reopened.next?.title})`
	);
	await answer(A, false);
	await page.waitForTimeout(600);

	await page.evaluate(() => window.__stores.sessionsOpen.set(false));
	await page.waitForTimeout(900);

	// ---- 6. THE MOUNT PICKER'S IMPORT ROW MOUNTS WHAT IT IMPORTS ---------------------
	// "it should automatically also mount this session file, not just import (do not change
	// 'Import project (.tp)…' text in context menu)". The label is therefore asserted
	// EXACTLY, and the behaviour behind it is the round-13 Sessions importer plus a mount.
	await openExplorer(A);
	const foldersBeforeMount = await foldersOf(A);
	const volsBefore = await volsOf(A);
	await page.locator('#explorer-mount-add').click();
	await page.waitForSelector('[role=menuitem]', { timeout: 20000 });
	await page.waitForTimeout(300);
	const pickerRows = await page.evaluate(() =>
		[...document.querySelectorAll('[role=menuitem]')].map((el) => el.innerText.trim()).filter(Boolean)
	);
	h.check(
		pickerRows.some((r) => r === 'Import project (.tp)…'),
		`the row's text is untouched, exactly as asked (${JSON.stringify(pickerRows.filter((r) => /Import/.test(r)))})`
	);
	const [chooser] = await Promise.all([
		page.waitForEvent('filechooser', { timeout: 15000 }),
		page.locator('[role=menuitem]', { hasText: 'Import project' }).first().click()
	]);
	h.check(!!chooser, 'clicking it still opens a real file picker');
	await chooser.setFiles({
		name: 'Wharfside.tp',
		mimeType: 'application/zip',
		buffer: Buffer.from(b64, 'base64')
	});
	await h.eventually(
		() => metas(A),
		(list) => list.some((m) => m.name === 'Wharfside' && m.lib),
		'the file is imported as a saved PROJECT — which is what a mount can read',
		25000
	);
	await h.eventually(
		() => volsOf(A),
		(list) => list.some((v) => v.name === 'Wharfside'),
		'…and it is MOUNTED straight away, with no second gesture',
		25000
	);
	const volsAfter = await volsOf(A);
	const entry = (await metas(A)).find((m) => m.name === 'Wharfside');
	const vol = volsAfter.find((v) => v.name === 'Wharfside');
	h.check(
		vol?.sessionId === entry?.id,
		'…and the mount reads the entry that was just written, not some other one'
	);
	h.check(
		volsAfter.length === volsBefore.length + 1,
		`exactly one new root appeared (${volsBefore.length} -> ${volsAfter.length})`
	);
	// a root you mounted and cannot see is a button that appears to have done nothing.
	// WAIT ON IT: the volume lands in the store inside `mountVolume`, and the walk-in is the
	// line after it — reading once can win that race by a tick
	await h.eventually(
		() =>
			page.evaluate(() => {
				let v;
				window.__stores.explorer.activeFolder.subscribe((x) => (v = x))();
				return v ?? null;
			}),
		(v) => typeof v === 'string' && v.startsWith('vol:'),
		'…and the Explorer walks you into it',
		15000
	);
	// THE LIBRARY IS UNTOUCHED: furnishing a folder is the other button's job, and doing
	// both would put every byte in two places
	const foldersAfterMount = await foldersOf(A);
	h.check(
		!foldersAfterMount.includes('Wharfside') && foldersAfterMount.length === foldersBeforeMount.length,
		`…without furnishing the Library behind your back (${JSON.stringify(foldersAfterMount)})`
	);

	await h.finish(browser);
});

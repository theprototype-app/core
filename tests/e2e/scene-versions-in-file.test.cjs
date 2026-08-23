// 21-I5 REVISED — PER-SCENE VERSION DOWNLOADS (and the save-name template).
//
// WHAT CHANGED AND WHY THIS SUITE WAS REWRITTEN RATHER THAN DELETED. The first 21-I5
// build put "Version history" in the Export Settings cog and bundled a `versions/`
// section into the working `.tpscene`. The user reported that ticking it produced no
// versions, and the cause was structural: `saveTpScene` exports whatever is in the
// viewport, so a scene that is not a NAMED project scene has no manifest entry, no
// history to look up, and the box silently wrote nothing. An option that cannot answer
// its own question belongs on a different path — the Explorer's scene CARD, where the
// name and the history are unambiguous.
//
// So this suite now proves three things in place of the old write side:
//
//   the removal      no scene checkbox, no `versions` option, and `exportSessionZip`
//                    ignores one even if a caller passes it (§2)
//   the honesty      a file from the INTERIM build still says what it carries — that
//                    load-side toast is deliberately KEPT (§3)
//   the replacement  the card menu offers "Download all versions (.zip)" only for a
//                    scene that HAS more than one (§4), the archive is real (§5), a
//                    pruned version is counted (§6), and one row downloads exactly its
//                    own version (§7)
//
// Sections 0 and 8 are unchanged: the save-name template is a separate half of 21-I5
// that this revision does not touch, and the resolver is a leaf, so §0 imports the ESM
// directly (the shader-compile precedent) with no browser at all.
//
// EVERY archive claim is asserted on REAL DOWNLOADED BYTES, unzipped in node with
// fflate (the project-file precedent) — reading what the app produced is the only way to
// know the file is a file and not a shape that happens to survive our own parser. And
// because a scene item's HASH *is* the sha256 of its stored bytes, "these are that
// version's bytes" is checkable exactly, not approximately.
//
// No peers, no signaling: this is a file feature, and a dial would only add flakiness.
// Run: APP_URL='https://localhost:5193/' npm run e2e -- scene-versions-in-file
const h = require('./helpers.cjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { unzipSync, zipSync, strFromU8 } = require('fflate');

const srcUrl = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', f)).href;

/** fflate hands out typed-array VIEWS over a shared buffer — slice by
 * byteOffset..byteLength before hashing, or the digest is of the whole archive */
const sha256 = (view) =>
	crypto
		.createHash('sha256')
		.update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
		.digest('hex');

// ---- page helpers -------------------------------------------------------------------

const makeBox = (peer) =>
	peer.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		window.__stores.objectActions.deselectObject();
	});

const manifestOf = (peer) =>
	peer.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});

const libraryCount = (peer) =>
	peer.page.evaluate(() => {
		let v = 0;
		let hid = 0;
		window.__stores.explorer.explorerItems.subscribe((l) => (v = l.length))();
		window.__stores.explorer.hiddenItems.subscribe((l) => (hid = l.length))();
		return v + hid;
	});

// a plain toast is a STRING in the stack; only an action toast is an object. Scan the
// WHOLE stack, never the last entry — this box emits peer-server toasts throughout a run
const toastTexts = (peer) =>
	peer.page.evaluate(() => {
		let list;
		window.__stores.toastStore.subscribe((t) => (list = t))();
		return (list ?? []).map((t) => (typeof t === 'string' ? t : (t.text ?? '')));
	});

const clearToasts = (peer) => peer.page.evaluate(() => window.__stores.toastStore.set([]));

const menuRows = (peer) =>
	peer.page.evaluate(() =>
		[...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
			.map((el) => el.textContent?.trim())
			.filter(Boolean)
	);

/** Export the CURRENT scene as a .tpscene and bring the bytes back over the bridge.
 * base64 CHUNKED on the page side — `String.fromCharCode(...bytes)` over a whole zip
 * overflows the argument stack, which reads as a mysteriously empty export. */
const exportScene = (peer, opts) =>
	peer.page.evaluate(async (opts) => {
		const s = window.__stores.sessions;
		const payload = s.buildSessionPayload('Scene export');
		const zip = await s.exportSessionZip(payload, opts);
		let str = '';
		for (let i = 0; i < zip.length; i += 8192)
			str += String.fromCharCode.apply(null, zip.subarray(i, i + 8192));
		return { b64: btoa(str), versions: zip.versions, skippedVersions: zip.skippedVersions };
	}, opts);

const unzipB64 = (b64) => unzipSync(new Uint8Array(Buffer.from(b64, 'base64')));

/** Whatever gesture `act` performs, come back with the file it produced. */
async function grabDownload(peer, act) {
	const [download] = await Promise.all([peer.page.waitForEvent('download', { timeout: 20000 }), act()]);
	const file = await download.path();
	return { name: download.suggestedFilename(), bytes: file ? new Uint8Array(fs.readFileSync(file)) : null };
}

/** right-click a card and read the menu it opens */
async function cardMenu(peer, title) {
	await peer.page.locator(`.explorer-card[title="${title}"]`).click({ button: 'right' });
	await peer.page.waitForTimeout(350);
	return menuRows(peer);
}

h.run(async () => {
	// =====================================================================
	// 0. THE SAVE-NAME TEMPLATE + THE VERSION STAMP — pure, no browser
	// =====================================================================
	const { resolveSaveName, fileNameBase, versionStamp, DEFAULT_TEMPLATE, NAMELESS_TEMPLATE } =
		await import(srcUrl('saveName.js'));
	// a fixed instant, so every expectation below is derivable rather than "whatever ran"
	const at = new Date(Date.UTC(2026, 7, 22, 10, 11, 12, 345));

	h.check(DEFAULT_TEMPLATE === '[name]', `the default template is the name itself (${DEFAULT_TEMPLATE})`);
	h.check(
		resolveSaveName(DEFAULT_TEMPLATE, 'Arena', at) === 'Arena',
		'a named save under the default template is just its name'
	);

	// THE COUNTERFACTUAL for the no-name fallback: the OLD expression, computed here, so
	// the check cannot be satisfied by editing a pinned string into agreement
	const oldShape = 'ThePrototype-' + at.toISOString().replace(/[T:.Z]/g, '-') + 'UTC';
	const nameless = resolveSaveName(DEFAULT_TEMPLATE, '', at);
	h.check(
		nameless === oldShape,
		`no name falls back to the PRE-21-I5 shape, character for character (${nameless})`
	);
	h.check(
		resolveSaveName(NAMELESS_TEMPLATE, '', at) === oldShape,
		'…which is exactly what the fallback template resolves to'
	);
	h.check(resolveSaveName('[name]', '   ', at) === oldShape, 'a whitespace-only name is no name');

	// the DD/MM/YY ordering the user asked the description to show
	const ddmmyy = resolveSaveName('[name]-[DD]-[MM]-[YY]', 'Arena', at);
	h.check(ddmmyy === 'Arena-22-08-26', `DD/MM/YY ordering resolves in that order (${ddmmyy})`);
	const full = resolveSaveName('[name]_[YYYY][MM][DD]_[HH][mm][ss][ms]', 'Arena', at);
	h.check(
		full === 'Arena_20260822_101112345',
		`every date token is UTC and zero-padded, [ms] to three (${full})`
	);

	// a template that never asks for a name is usable WITHOUT one — the fallback must
	// fire on the missing TOKEN VALUE, not merely on the missing name
	h.check(
		resolveSaveName('Scene-[YYYY]', '', at) === 'Scene-2026',
		'a template with no [name] token works for an unnamed thing'
	);
	// …and one that resolves to nothing at all still produces a filename
	h.check(
		resolveSaveName('...', 'Arena', at) === oldShape,
		'a template that sanitises away falls back rather than naming a file ""'
	);

	const dirty = resolveSaveName('[name]', 'a/b:c*d?e"f<g>h|i', at);
	h.check(
		!/[\\/:*?"<>|]/.test(dirty) && dirty.length > 0,
		`the filesystem sanitiser still runs over the resolved name (${dirty})`
	);
	h.check(
		fileNameBase('Dungeon Crawl') === 'Dungeon Crawl' && fileNameBase('...') === '',
		'fileNameBase keeps a normal name and empties an unusable one (the 21-G9 contract)'
	);

	// the VERSION STAMP — the one piece the Explorer archive and the panel row share
	const stamp = versionStamp(at.getTime());
	h.check(
		stamp === '2026-08-22T10-11-12.345Z',
		`versionStamp is the ISO instant with its colons removed (${stamp})`
	);
	h.check(
		!/[\\/:*?"<>|]/.test(stamp) && stamp.startsWith('2026-'),
		'…so it is legal in a Windows filename AND still sorts chronologically as text'
	);
	// two versions a second apart must not collide, and the date must not be "now"
	const later = versionStamp(at.getTime() + 1000);
	h.check(
		later !== stamp && later > stamp,
		`a later version stamps later, as a plain string comparison (${later})`
	);
	const thisYear = String(new Date().getUTCFullYear());
	h.check(
		versionStamp(0).startsWith(thisYear) && versionStamp(NaN).startsWith(thisYear),
		`a missing or zero createdAt falls back to NOW, never to 1970 (${versionStamp(0).slice(0, 10)})`
	);

	// =====================================================================
	// the browser half
	// =====================================================================
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.saveName && !!window.__stores?.levels, {
		timeout: 30000
	});

	h.check(
		(await A.page.evaluate(() => {
			const a = window.__stores.projectFile.projectFileBase('a/b:c  d');
			const b = window.__stores.saveName.fileNameBase('a/b:c  d');
			return a === b && a === 'a-b-c d';
		})) === true,
		'projectFileBase and fileNameBase are ONE sanitiser (21-I5 moved the body, kept the name)'
	);

	// ---- 1. two scenes: one with a history, one without -----------------
	// 21-H1: a save invents no folder, so both land at the library root
	await makeBox(A);
	const v1 = await A.page.evaluate(async () => {
		const item = await window.__stores.levels.saveSceneAsLevel('Arena');
		return item?.hash ?? null;
	});
	await makeBox(A); // the scene is now different from what v1 holds
	const v2 = await A.page.evaluate(async () => {
		const item = await window.__stores.levels.saveSceneAsLevel('Arena');
		return item?.hash ?? null;
	});
	// hideOldVersions is what a real save does — one card per scene name
	await A.page.evaluate(() => window.__stores.levels.hideOldVersions('Arena'));
	await makeBox(A);
	const solo = await A.page.evaluate(async () => {
		const item = await window.__stores.levels.saveSceneAsLevel('Solo');
		return item?.hash ?? null;
	});

	const m = await manifestOf(A);
	h.check(
		!!v1 && !!v2 && v1 !== v2 && m.scenes?.Arena?.history?.length === 2,
		`premise: Arena has TWO versions with distinct hashes (${String(v1).slice(0, 6)} -> ${String(v2).slice(0, 6)})`
	);
	h.check(
		!!solo && m.scenes?.Solo?.history?.length === 1,
		'premise: Solo has exactly ONE — the control for the menu rule below'
	);
	h.check(
		(await A.page.evaluate(
			([a, b]) => !!window.__stores.explorer.itemByHash(a) && !!window.__stores.explorer.itemByHash(b),
			[v1, v2]
		)) === true,
		'premise: this machine still HOLDS the bytes of both (itemByHash searches the hidden shelf)'
	);

	// BACKDATE v1's item so every date below is provably the version's OWN createdAt and
	// not the moment of export — two saves seconds apart could not tell them apart
	const backdated = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
	await A.page.evaluate(
		([hash, when]) => {
			const e = window.__stores.explorer;
			const fix = (list) => list.map((it) => (it.hash === hash ? { ...it, createdAt: when } : it));
			e.explorerItems.update(fix);
			e.hiddenItems.update(fix);
		},
		[v1, backdated]
	);

	// =====================================================================
	// 2. THE WRITE SIDE IS GONE
	// =====================================================================
	// the cog, through the real opener (the Sidebar menu has to be open for it to exist)
	await A.page.evaluate(() => window.__stores.closeMenu.set(false));
	await A.page.waitForTimeout(400);
	await A.page.locator('#export-settings-cog').click();
	await A.page.waitForTimeout(300);
	const cog = await A.page.evaluate(() => ({
		open: !!document.getElementById('export-settings-modal'),
		scene: !!document.getElementById('tpscene-versions'),
		project: !!document.getElementById('tp-project-versions'),
		boxes: [...document.querySelectorAll('#export-settings-modal input[type="checkbox"]')].map(
			(el) => el.id || '(unnamed)'
		)
	}));
	h.check(cog.open, 'premise: the export-settings popup really opened');
	h.check(
		!cog.scene,
		`the SCENE "Version history" checkbox is gone from the cog (${JSON.stringify(cog.boxes)})`
	);
	h.check(
		cog.project,
		'…and the PROJECT (.tp) one remains — it gates machinery with its own proper import'
	);
	await A.page.locator('#export-settings-modal button', { hasText: 'Close' }).last().click();
	await A.page.evaluate(() => window.__stores.closeMenu.set(true));
	await A.page.waitForTimeout(250);

	h.check(
		(await A.page.evaluate(() => 'versions' in window.__stores.fileHandler.tpsceneOptions())) === false,
		'`tpsceneOptions()` no longer carries a `versions` key at all'
	);

	// ---- 21-I (user): THE .tp GATE COVERS THE DOCUMENT, NOT ONLY THE BYTES ------------
	// REPORTED: with "Scene version history" off, the project still had versions in it.
	// The bytes were gated; the MANIFEST was not — so the file claimed every version while
	// carrying one, and opening it showed rows that all said "Not held". A manifest naming
	// hashes the zip does not contain is the dead-pointer shape 21-G3 forbids.
	const gateProbe = async (versions) =>
		A.page.evaluate(async (v) => {
			const r = await window.__stores.projectFile.exportProject({ versions: v });
			let s = '';
			for (let i = 0; i < r.bytes.length; i += 8192)
				s += String.fromCharCode.apply(null, r.bytes.subarray(i, i + 8192));
			return { b64: btoa(s), scenes: r.scenes, omittedVersions: r.omittedVersions };
		}, versions);
	const readClaim = (b64) => {
		const zip = unzipSync(new Uint8Array(Buffer.from(b64, 'base64')));
		const doc = JSON.parse(strFromU8(zip['project.json']));
		const carried = new Set(
			Object.keys(zip)
				.filter((n) => n.startsWith('scenes/'))
				.map((n) => n.slice('scenes/'.length).replace(/\.tpscene$/, ''))
		);
		const claimed = Object.values(doc.manifest.scenes).flatMap((e) => e.history);
		return { claimed, carried, doc };
	};
	const on = readClaim((await gateProbe(true)).b64);
	h.check(
		on.claimed.length > 1 && on.claimed.every((h2) => on.carried.has(h2)),
		`history ON: it claims every version and CARRIES each one (${on.claimed.length} claimed, ${on.carried.size} carried)`
	);
	const offRun = await gateProbe(false);
	const off = readClaim(offRun.b64);
	h.check(
		off.claimed.length < on.claimed.length && off.claimed.every((h2) => off.carried.has(h2)),
		`history OFF: it claims ONLY what it carries — no dead pointers (${off.claimed.length} claimed, ${off.carried.size} carried)`
	);
	h.check(
		Object.values(off.doc.manifest.scenes).every((e) => e.history.length === 1),
		'…one version per scene in the document, which is what "only the latest" means to a reader'
	);
	h.check(
		offRun.omittedVersions > 0,
		`…and the file still SAYS how many it was told to leave out (${offRun.omittedVersions})`
	);
	h.check(
		(await A.page.evaluate(() => {
			localStorage.setItem('tpsceneVersions', 'true'); // a stale preference from the interim build
			return 'versions' in window.__stores.fileHandler.tpsceneOptions();
		})) === false,
		'…and a LEFTOVER localStorage flag from the interim build is inert'
	);

	// the option is not merely unreachable from the UI — the writer is gone. Passing it
	// explicitly (which is what the removed cog did) must still produce no section.
	const forced = await exportScene(A, {
		assets: true,
		packs: false,
		flow: true,
		versions: true,
		sceneName: 'Arena'
	});
	const zipForced = unzipB64(forced.b64);
	h.check(
		Object.keys(zipForced).filter((k) => k.startsWith('versions/')).length === 0,
		`even an explicit versions:true writes NO versions/ section (${Object.keys(zipForced).join(', ')})`
	);
	h.check(
		forced.versions === undefined && forced.skippedVersions === undefined,
		'…and the returned bytes carry no version counts — the tagging went with it'
	);
	h.check(
		!!zipForced['session.json'] && JSON.parse(strFromU8(zipForced['session.json'])).format === 1,
		'SESSION_FORMAT stays 1 — nothing about the file shape changed on the way out'
	);

	// =====================================================================
	// 3. THE LOAD-SIDE HONESTY TOAST SURVIVES
	// =====================================================================
	// Files from the interim build EXIST on people's disks. Craft one out of a REAL
	// export (so its session.json is genuinely loadable) with a versions/ entry added.
	const inner = zipForced;
	const crafted = zipSync(
		{
			...Object.fromEntries(
				Object.entries(inner).map(([k, v]) => [
					k,
					new Uint8Array(Buffer.from(v.buffer, v.byteOffset, v.byteLength))
				])
			),
			['versions/' + versionStamp(backdated) + '-' + String(v1).slice(0, 8) + '.tpscene']:
				new Uint8Array(Buffer.from(forced.b64, 'base64')),
			['versions/' + versionStamp(backdated + 1000) + '-deadbeef.tpscene']: new Uint8Array(
				Buffer.from(forced.b64, 'base64')
			)
		},
		{ level: 6 }
	);
	const craftedB64 = Buffer.from(crafted).toString('base64');
	const libBefore = await libraryCount(A);
	await clearToasts(A);
	const read = await A.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const payload = await window.__stores.sessions.readSessionZip(bytes.buffer);
		return payload?.name ?? null;
	}, craftedB64);
	const noted = await toastTexts(A);
	h.check(read === 'Scene export', `an interim-build file still LOADS its session.json (${read})`);
	h.check(
		noted.some((t) => /also carries 2 saved versions/.test(t) && /unzip/.test(t)),
		`the honesty toast is KEPT and names the count ("${noted.find((t) => /also carries/.test(t)) ?? '—'}")`
	);
	h.check(
		(await libraryCount(A)) === libBefore,
		`nothing entered the library from versions/ — there was never a read side (${libBefore} items before and after)`
	);

	// =====================================================================
	// 4. THE MENU ENTRY — present for a history, absent without one
	// =====================================================================
	await A.page.locator('#explorer-slot').click();
	await A.page.waitForTimeout(700);
	await A.page.evaluate(() => window.__stores.explorer.activeFolder.set(null));
	await A.page.waitForTimeout(500);
	const cards = await A.page.evaluate(() =>
		[...document.querySelectorAll('.explorer-card')].map((el) => el.getAttribute('title'))
	);
	h.check(
		cards.filter((t) => t === 'Arena.tpscene').length === 1 &&
			cards.filter((t) => t === 'Solo.tpscene').length === 1,
		`premise: one card each for Arena and Solo (${JSON.stringify(cards)})`
	);

	const soloRows = await cardMenu(A, 'Solo.tpscene');
	h.check(
		soloRows.some((r) => r.startsWith('Download (.tpscene)')),
		`a single-version scene offers the plain Download (${JSON.stringify(soloRows)})`
	);
	h.check(
		!soloRows.some((r) => /Download all versions/.test(r)),
		'…and NOT "Download all versions" — a one-file zip is a worse Download'
	);
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);

	const arenaRows = await cardMenu(A, 'Arena.tpscene');
	// USER (the contract CHANGED, and this section records the change rather than being
	// deleted): the all-versions archive moved OUT of this menu and INTO the Version
	// history header, before the count it acts on. It sat one row under Download and
	// read as a second Download, and its subject IS that history.
	h.check(
		!arenaRows.some((r) => /Download all versions/.test(r)),
		`the item menu no longer carries the archive (${JSON.stringify(arenaRows)})`
	);
	h.check(
		arenaRows.some((r) => r.startsWith('Download (.tpscene)')) &&
			arenaRows.some((r) => r.startsWith('Version history')),
		'…while Download and Version history stay exactly where they were'
	);
	// …and it is REACHABLE in its new home, which is what makes this a move rather than
	// a removal: right-click, Version history, and the panel that now owns it.
	await A.page.keyboard.press('Escape');
	await A.page.waitForTimeout(250);
	await cardMenu(A, 'Arena.tpscene');
	await A.page
		.locator('[role="menu"] [role="menuitem"]')
		.filter({ hasText: 'Version history' })
		.first()
		.click();
	await A.page.waitForTimeout(600);
	h.check(
		(await A.page.locator('#version-download-all').count()) === 1,
		'…offered in the Version history header instead'
	);

	// =====================================================================
	// 5. THE ARCHIVE, ON REAL BYTES
	// =====================================================================
	await clearToasts(A);
	// the archive button lives in the Version history header now. A properties pane
	// scrolls, so make sure the thing we are about to click is actually reachable —
	// otherwise Playwright waits on actionability and `waitForEvent` times out first,
	// which reads as "the download never happened" rather than "the click never landed".
	const archiveBtn = A.page.locator('#version-download-all');
	await archiveBtn.scrollIntoViewIfNeeded();
	h.check(await archiveBtn.isVisible(), 'premise: the archive button is on screen');
	const bulk = await grabDownload(A, () => archiveBtn.click());
	h.check(bulk.name === 'Arena-versions.zip', `the archive is named from the SCENE (${bulk.name})`);
	h.check(!!bulk.bytes && bulk.bytes.length > 0, `the download produced bytes (${bulk.bytes?.length})`);
	const arch = unzipSync(bulk.bytes);
	const names = Object.keys(arch).sort();
	h.check(
		names.length === 2,
		`one entry per HELD version, and only those (${names.length}: ${JSON.stringify(names)})`
	);
	h.check(
		names.every((n) => n.endsWith('.tpscene')) && names.every((n) => !/[\\/:*?"<>|]/.test(n)),
		'every entry is a .tpscene whose name carries no character a Windows filename forbids'
	);
	// THE DATE IS THE VERSION'S OWN. v1 was backdated to January; the export ran now.
	const isoOfV1 = versionStamp(backdated);
	h.check(
		names.some((n) => n === isoOfV1 + '-' + String(v1).slice(0, 8) + '.tpscene'),
		`the ISO date is the version's OWN createdAt plus a short hash (${names.find((n) => n.startsWith('2026-01')) ?? '—'})`
	);
	// THE COUNTERFACTUAL, and it has to be this one: v2 really was saved seconds before
	// the export, so "no entry is dated near now" is FALSE for a correct implementation.
	// What a "stamped at export time" bug produces is two entries with the SAME date —
	// so the claim is that the two months DIFFER, one of them being v1's backdate.
	const months = names.map((n) => n.slice(0, 7));
	h.check(
		months[0] === versionStamp(backdated).slice(0, 7) &&
			months[1] === versionStamp(Date.now()).slice(0, 7) &&
			months[0] !== months[1],
		`two versions, two DIFFERENT dates — a stamp taken at export time would make them identical (${JSON.stringify(months)})`
	);
	h.check(
		names[0] < names[1] && names[0].startsWith(isoOfV1.slice(0, 7)),
		`ISO first means a plain listing sorts oldest first (${names[0].slice(0, 10)} before ${names[1].slice(0, 10)})`
	);
	// each entry is a real .tpscene — its OWN session.json, not renamed rubbish
	const inners = names.map((n) => {
		const e = unzipSync(arch[n]);
		return e['session.json'] ? JSON.parse(strFromU8(e['session.json'])) : null;
	});
	h.check(
		inners.every((d) => !!d && d.format === 1),
		`every entry unzips to its own session.json (names: ${JSON.stringify(inners.map((d) => d?.name))})`
	);
	// and they are EXACTLY those versions: a scene item's hash IS the sha256 of its bytes
	const archHashes = names.map((n) => sha256(arch[n])).sort();
	h.check(
		JSON.stringify(archHashes) === JSON.stringify([v1, v2].sort()),
		'the bytes of each entry hash to the version it is named after — byte-exact, not similar'
	);
	const bulkToast = await toastTexts(A);
	h.check(
		bulkToast.some((t) => /Downloaded 2 versions of Arena as a \.zip/.test(t)),
		`the toast reports the count and the scene ("${bulkToast.find((t) => /Downloaded/.test(t)) ?? '—'}")`
	);
	h.check(
		!bulkToast.some((t) => /left out/.test(t)),
		'…and says nothing about anything missing, because nothing was'
	);

	// =====================================================================
	// 6. A PRUNED VERSION IS COUNTED, NEVER SILENT
	// =====================================================================
	// deleting the item is exactly what pruneSceneVersions does, so this is the real state
	await A.page.evaluate(async (hash) => {
		const item = window.__stores.explorer.itemByHash(hash);
		if (item) await window.__stores.explorer.deleteItem(item.id);
	}, v1);
	h.check(
		(await A.page.evaluate((hash) => !window.__stores.explorer.itemByHash(hash), v1)) === true &&
			(await manifestOf(A)).scenes.Arena.history.length === 2,
		'v1 bytes pruned locally — and its hash is STILL in the manifest history (fork 4)'
	);
	await A.page.waitForTimeout(400);
	await clearToasts(A);
	// the archive moved into the Version history header — reach it the way a user does
	await cardMenu(A, 'Arena.tpscene');
	await A.page
		.locator('[role="menu"] [role="menuitem"]')
		.filter({ hasText: 'Version history' })
		.first()
		.click();
	await A.page.waitForTimeout(600);
	const prunedBtn = A.page.locator('#version-download-all');
	await prunedBtn.scrollIntoViewIfNeeded();
	const pruned = await grabDownload(A, () => prunedBtn.click());
	const prunedNames = Object.keys(unzipSync(pruned.bytes));
	const prunedToast = await toastTexts(A);
	h.check(
		prunedNames.length === 1 && sha256(unzipSync(pruned.bytes)[prunedNames[0]]) === v2,
		`the archive carries only what is held (${prunedNames.length} entry: ${prunedNames[0]})`
	);
	h.check(
		prunedToast.some((t) => /Downloaded 1 version of Arena/.test(t) && /1 whose bytes are not on this machine was left out/.test(t)),
		`and the toast REPORTS the one it could not write ("${prunedToast.find((t) => /Downloaded/.test(t)) ?? '—'}")`
	);
	// the same claim, in the archive's new home: it is offered off the HISTORY, not off
	// the bytes, so pruning one version locally must not retire it
	h.check(
		(await A.page.locator('#version-download-all').count()) === 1,
		'the archive stays offered — the manifest still records two versions, and a peer may hold the other'
	);

	// =====================================================================
	// 7. ONE ROW, ONE VERSION — the Version history panel
	// =====================================================================
	// §6 used to leave a card menu open as a side effect of its last assertion; that
	// assertion now reads the panel instead, so this section opens its own menu.
	await cardMenu(A, 'Arena.tpscene');
	await A.page
		.locator('[role="menu"]')
		.getByText('Version history', { exact: false })
		.first()
		.click();
	await A.page.waitForTimeout(600);
	h.check(await A.page.locator('#version-history').isVisible(), 'premise: the panel opened');
	const rows = await A.page.evaluate(() =>
		[...document.querySelectorAll('#version-history .vh-row')].map((row) => ({
			hash: row.getAttribute('data-hash'),
			held: !row.querySelector('.vh-badge-away'),
			download: !!row.querySelector('.vh-download'),
			disabled: !!row.querySelector('.vh-download')?.disabled,
			label: row.querySelector('.vh-download')?.getAttribute('aria-label') ?? null
		}))
	);
	h.check(
		rows.length === 2 && rows.every((r) => r.download),
		`every row has a download button, held or not (${rows.length} rows)`
	);
	h.check(
		rows.every((r) => !!r.label),
		`the icon-only button carries an aria-label (${JSON.stringify(rows.map((r) => r.label))})`
	);
	const heldRow = rows.find((r) => r.held);
	const awayRow = rows.find((r) => !r.held);
	h.check(
		!!heldRow && !heldRow.disabled,
		`the row we hold bytes for is enabled (${String(heldRow?.hash).slice(0, 6)})`
	);
	h.check(
		!!awayRow && awayRow.disabled,
		`the "Not held" row is DISABLED rather than absent, so the state is visible (${String(awayRow?.hash).slice(0, 6)})`
	);
	// the expected filename is DERIVED from the version's own stored createdAt, so this
	// cannot pass by matching a loose shape that a "now" stamp would also satisfy
	const heldCreated = await A.page.evaluate(
		(hash) => window.__stores.explorer.itemByHash(hash)?.createdAt ?? 0,
		heldRow.hash
	);
	const one = await grabDownload(A, () =>
		A.page.locator(`#version-history .vh-row[data-hash="${heldRow.hash}"] .vh-download`).click()
	);
	h.check(
		one.name === 'Arena-' + versionStamp(heldCreated) + '.tpscene',
		`the file is named from the scene plus THAT version's own date (${one.name})`
	);
	h.check(
		!!one.bytes && sha256(one.bytes) === heldRow.hash,
		`and its bytes are exactly that version's — the sha256 IS the version id (${sha256(one.bytes ?? new Uint8Array()).slice(0, 8)} vs ${String(heldRow.hash).slice(0, 8)})`
	);
	const rowInner = unzipSync(one.bytes);
	h.check(
		!!rowInner['session.json'] && JSON.parse(strFromU8(rowInner['session.json'])).format === 1,
		'a single-row download is an ordinary loadable .tpscene, not a fragment'
	);

	// =====================================================================
	// 8. THE TEMPLATE AT A REAL SAVE PATH (unchanged by this revision)
	// =====================================================================
	const nameOf = async () => (await grabDownload(A, () => A.page.evaluate(() => window.__stores.fileHandler.save('tpscene')))).name;
	// the open scene is whatever the last save/travel left us on — pin it so the
	// expectation is derivable rather than "whatever ran"
	await A.page.evaluate(() =>
		window.__stores.levels.currentLevel.set({ name: 'Arena', hash: 'x', at: Date.now() })
	);
	const defaultName = await nameOf();
	h.check(
		defaultName === 'Arena.tpscene',
		`a scene save is named after the scene under the default template (${defaultName})`
	);
	await A.page.evaluate(() => window.__stores.saveName.saveNameTemplate.set('[name]-[DD]-[MM]-[YY]'));
	const stamped = await nameOf();
	h.check(
		/^Arena-\d\d-\d\d-\d\d\.tpscene$/.test(stamped),
		`…and the template reaches that path (${stamped})`
	);
	// no name = the old shape, at the same save path
	await A.page.evaluate(() => {
		window.__stores.saveName.saveNameTemplate.set('[name]');
		window.__stores.levels.currentLevel.set(null);
	});
	const unnamed = await nameOf();
	h.check(
		/^ThePrototype-\d{4}-\d\d-\d\d-\d\d-\d\d-\d\d-\d{3}-UTC\.tpscene$/.test(unnamed),
		`an unsaved scene keeps the pre-21-I5 timestamp name (${unnamed})`
	);

	h.check((await h.pageErrors(A)).length === 0, 'no page errors through the whole run');
	await h.finish(browser);
});

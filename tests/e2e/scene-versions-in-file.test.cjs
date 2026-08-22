// 21-I5 — VERSIONS INSIDE THE FILE, AND THE SAVE-NAME TEMPLATE.
//
// THE MODEL, in one line: versions live inside the FILE for transport and outside it in
// the content-addressed STORE, and the bundle is EXPORT-ONLY — nothing reads it back.
// That asymmetry is the whole safety argument: bundling history into a working file
// would change that file's hash on every save, which would invalidate the manifest
// pointer and travel-by-hash, so the read side simply does not exist. The suite has to
// prove BOTH halves — that the section is really written, and that loading a file which
// has one changes nothing about the library.
//
// The archive is asserted in NODE with fflate, never through the app's own reader (the
// project-file precedent): reading the bytes the app produced is the only way to know
// the file is a file and not a shape that happens to survive our own parser.
//
// The template half needs no browser at all — `saveName.js` is a leaf whose resolver is
// a pure function of (template, name, Date) — so section 0 imports the ESM directly
// (the shader-compile precedent) and computes the OLD filename expression in-test as the
// counterfactual, rather than pinning a string somebody could edit into agreement.
//
// No peers, no signaling: this is a file feature, and a dial would only add flakiness.
// Run: APP_URL='https://localhost:5193/' npm run e2e -- scene-versions-in-file
const h = require('./helpers.cjs');
const path = require('path');
const { pathToFileURL } = require('url');
const { unzipSync, strFromU8 } = require('fflate');

const srcUrl = (f) => pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', f)).href;

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

const objectCount = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g?.children.length ?? 0;
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

h.run(async () => {
	// =====================================================================
	// 0. THE SAVE-NAME TEMPLATE — a pure resolver, no browser
	// =====================================================================
	const { resolveSaveName, fileNameBase, DEFAULT_TEMPLATE, NAMELESS_TEMPLATE } = await import(
		srcUrl('saveName.js')
	);
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
	h.check(
		resolveSaveName('[name]', '   ', at) === oldShape,
		'a whitespace-only name is no name'
	);

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

	// =====================================================================
	// the browser half
	// =====================================================================
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	await A.page.waitForFunction(() => !!window.__stores?.saveName, { timeout: 30000 });

	h.check(
		(await A.page.evaluate(() => {
			const a = window.__stores.projectFile.projectFileBase('a/b:c  d');
			const b = window.__stores.saveName.fileNameBase('a/b:c  d');
			return a === b && a === 'a-b-c d';
		})) === true,
		'projectFileBase and fileNameBase are ONE sanitiser (21-I5 moved the body, kept the name)'
	);

	// ---- 1. a scene with a real two-entry history -----------------------
	await makeBox(A);
	const folder = await A.page.evaluate(
		() => window.__stores.explorer.createFolder('Scenes', null)?.id ?? null
	);
	const v1 = await A.page.evaluate(async (f) => {
		const item = await window.__stores.levels.saveSceneAsLevel('Arena', f);
		return item?.hash ?? null;
	}, folder);
	await makeBox(A); // the scene is now different from what v1 holds
	const v2 = await A.page.evaluate(async (f) => {
		const item = await window.__stores.levels.saveSceneAsLevel('Arena', f);
		return item?.hash ?? null;
	}, folder);
	// hideOldVersions is what a real save does; folding v1 away also keeps the .tp
	// section counts below unambiguous (a VISIBLE old version would ride items/ too)
	await A.page.evaluate(() => window.__stores.levels.hideOldVersions('Arena'));

	const m = await manifestOf(A);
	h.check(
		!!v1 && !!v2 && v1 !== v2 && m.scenes?.Arena?.history?.length === 2,
		`premise: Arena has TWO versions with distinct hashes (${String(v1).slice(0, 6)} -> ${String(v2).slice(0, 6)})`
	);
	h.check(
		(await A.page.evaluate(
			([a, b]) => !!window.__stores.explorer.itemByHash(a) && !!window.__stores.explorer.itemByHash(b),
			[v1, v2]
		)) === true,
		'premise: this machine still HOLDS the bytes of both (itemByHash searches the hidden shelf)'
	);

	// BACKDATE v1's item so the entry-name date is provably the version's OWN createdAt
	// and not the moment of export — two saves seconds apart could not tell them apart
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

	// ---- 2. ABSENT BY DEFAULT ------------------------------------------
	const off = await exportScene(A, { assets: true, packs: false, flow: true, sceneName: 'Arena' });
	const zipOff = unzipB64(off.b64);
	h.check(
		Object.keys(zipOff).filter((k) => k.startsWith('versions/')).length === 0 && off.versions === 0,
		`with the option unset the file has NO versions/ section (${Object.keys(zipOff).length} entries)`
	);
	h.check(
		(await A.page.evaluate(() => window.__stores.fileHandler.tpsceneOptions().versions)) === false,
		'…and the cog preference itself defaults to OFF (locked answer 1)'
	);

	// ---- 3. PRESENT WITH THE OPTION ON ---------------------------------
	const on = await exportScene(A, {
		assets: true,
		packs: false,
		flow: true,
		versions: true,
		sceneName: 'Arena'
	});
	const zipOn = unzipB64(on.b64);
	const vnames = Object.keys(zipOn).filter((k) => k.startsWith('versions/')).sort();
	h.check(
		vnames.length === 2 && on.versions === 2 && on.skippedVersions === 0,
		`the option writes one entry per HELD version (${vnames.length} entries, ${on.versions} reported)`
	);
	h.check(
		vnames.some((n) => n.includes(v1)) && vnames.some((n) => n.includes(v2)),
		'each entry is addressed by its content hash'
	);
	const isoOfV1 = new Date(backdated).toISOString().replace(/:/g, '-');
	const v1entry = vnames.find((n) => n.includes(v1));
	h.check(
		v1entry === 'versions/' + isoOfV1 + '-' + v1 + '.tpscene',
		`the ISO date is the version's OWN createdAt, not the export moment (${v1entry})`
	);
	h.check(
		vnames.every((n) => !/[:*?"<>|]/.test(n)) && vnames.every((n) => n.endsWith('.tpscene')),
		'the entry names carry no character a Windows filename forbids'
	);
	// a versions/ entry is a real .tpscene, not renamed rubbish
	const innerV1 = unzipSync(zipOn[v1entry]);
	const innerDoc = innerV1['session.json'] ? JSON.parse(strFromU8(innerV1['session.json'])) : null;
	h.check(
		!!innerDoc && innerDoc.name === 'Arena',
		`a versions/ entry is an ordinary .tpscene with its own session.json (name "${innerDoc?.name}")`
	);
	h.check(
		!!zipOn['session.json'] &&
			JSON.parse(strFromU8(zipOn['session.json'])).format === 1,
		'SESSION_FORMAT stays 1 — the section is additive and an older build ignores it'
	);

	// ---- 4. A PRUNED VERSION IS COUNTED, NEVER SILENT ------------------
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
	const pruned = await exportScene(A, {
		assets: true,
		packs: false,
		flow: true,
		versions: true,
		sceneName: 'Arena'
	});
	const zipPruned = unzipB64(pruned.b64);
	h.check(
		Object.keys(zipPruned).filter((k) => k.startsWith('versions/')).length === 1 &&
			pruned.versions === 1 &&
			pruned.skippedVersions === 1,
		`a version whose bytes are gone is REPORTED, not silently missing (${pruned.versions} carried / ${pruned.skippedVersions} skipped)`
	);

	// ---- 5. LOADING ONE CHANGES NOTHING (the export-only ruling) -------
	const libBefore = await libraryCount(A);
	const objBefore = await objectCount(A);
	await clearToasts(A);
	const read = await A.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const payload = await window.__stores.sessions.readSessionZip(bytes.buffer);
		return { name: payload?.name ?? null, objects: (payload?.objects ?? []).length };
	}, on.b64);
	// the OUTER session.json is the live scene (buildSessionPayload's slot label), while
	// the versions/ entries above are named 'Arena' — which is the whole point: the file
	// opens as what you exported, not as one of its own history entries
	h.check(
		read.name === 'Scene export' && read.objects === objBefore && objBefore > 0,
		`loading a bundled file reads session.json — the CURRENT scene (${read.objects} objects)`
	);
	const noted = await toastTexts(A);
	h.check(
		noted.some((t) => /also carries 2 saved versions/.test(t) && /unzip/.test(t)),
		`the honesty toast names how many versions ride along and says they are not loaded ("${noted.find((t) => /also carries/.test(t)) ?? '—'}")`
	);
	h.check(
		(await libraryCount(A)) === libBefore,
		`NOTHING entered the library from versions/ — there is no import side (${libBefore} items before and after)`
	);

	await clearToasts(A);
	const imported = await A.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const payload = await window.__stores.sessions.importSessionZip(bytes.buffer);
		return payload?.name ?? null;
	}, on.b64);
	const importToasts = await toastTexts(A);
	h.check(
		imported === 'Scene export' && importToasts.some((t) => /also carries 2 saved versions/.test(t)),
		'the IMPORT path says it too — one message, both doors'
	);
	h.check(
		(await libraryCount(A)) === libBefore,
		'…and still nothing from versions/ reached the library'
	);

	// ---- 6. THE .tp GATE: pointer-only vs the full history --------------
	const full2 = await A.page.evaluate(() =>
		window.__stores.projectFile.exportProject({ versions: true }).then((r) => ({
			scenes: r.scenes,
			omitted: r.omittedVersions,
			skipped: r.skippedScenes
		}))
	);
	const gated = await A.page.evaluate(() =>
		window.__stores.projectFile.exportProject({ versions: false }).then((r) => {
			let str = '';
			for (let i = 0; i < r.bytes.length; i += 8192)
				str += String.fromCharCode.apply(null, r.bytes.subarray(i, i + 8192));
			return { b64: btoa(str), scenes: r.scenes, omitted: r.omittedVersions };
		})
	);
	// v1's bytes were pruned in section 4, so ON carries v2 and reports v1 as skipped
	h.check(
		full2.scenes === 1 && full2.skipped === 1 && full2.omitted === 0,
		`ON exports every kept version it holds and omits nothing on purpose (${full2.scenes} carried, ${full2.omitted} omitted)`
	);
	h.check(
		gated.scenes === 1 && gated.omitted === 1,
		`OFF exports the POINTER only and says what it left out (${gated.scenes} carried, ${gated.omitted} omitted)`
	);
	const zipTp = unzipB64(gated.b64);
	const doc = JSON.parse(strFromU8(zipTp['project.json']));
	h.check(
		!!zipTp['scenes/' + v2 + '.tpscene'] && !zipTp['scenes/' + v1 + '.tpscene'],
		'the gated file carries the pointer version and no older one'
	);
	h.check(
		doc.manifest.scenes.Arena.history.length === 2 && doc.skipped?.omittedVersions === 1,
		'the manifest history is UNTOUCHED by the gate, and project.json says what was left out'
	);
	h.check(
		(await A.page.evaluate(() => window.__stores.projectFile.projectVersionsEnabled())) === true,
		'the .tp preference defaults to ON (locked answer 2 — a .tp has carried history since 21-G3)'
	);

	// ---- 7. THE TEMPLATE AT A REAL SAVE PATH ---------------------------
	// the real opener: fileHandler.save('tpscene') is what the Sidebar's Save button calls
	const nameOf = async () => {
		const [download] = await Promise.all([
			A.page.waitForEvent('download', { timeout: 15000 }),
			A.page.evaluate(() => window.__stores.fileHandler.save('tpscene'))
		]);
		return download.suggestedFilename();
	};
	const defaultName = await nameOf();
	h.check(
		defaultName === 'Arena.tpscene',
		`a scene save is named after the scene under the default template (${defaultName})`
	);
	await A.page.evaluate(() =>
		window.__stores.saveName.saveNameTemplate.set('[name]-[DD]-[MM]-[YY]')
	);
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

// R22 ROUND 13 P1 — A PROJECT DOWNLOADS AS A PROJECT FILE.
//
// The user's report: ".tpscene only available as download for projects, its wrong, should
// be .tp (project files) to download." Round 12's own comment recorded why it shipped that
// way and drew the wrong conclusion from it: `exportProject` reads the LIVE stores, so
// nothing could write a .tp from a SAVED record — and the answer to that is the missing
// writer, not the wrong label. So this suite is about `exportProjectFromSession`.
//
// THE GUARD THAT MATTERS IS A ROUND TRIP, and it is asserted FILE BY FILE, never by a byte
// count and never by a count alone. Section 4 proves why: a writer that emits the document
// rows and forgets to put their bytes in the zip passes every count check there is — three
// item rows, one scene, the right names — and produces a project whose every file is
// missing. So each row is followed to a real zip entry, that entry's SHA-256 is compared
// with the hash the row claims, and both importers are then asked to produce the same files
// back by name and by hash on machines that have never met the exporter.
//
// Both import paths, because they land things in different places and only one installs the
// manifest: `openProject` REPLACES (page B) and `importProjectAsFolder` FURNISHES (page C).
//
// No peers: a file is the offline half of the project story, and a dial would only add
// flakiness to a check about bytes.
// Run: APP_URL='https://localhost:5206/' npm run e2e -- session-download-formats
const h = require('./helpers.cjs');
const { unzipSync, strFromU8 } = require('fflate');
const crypto = require('crypto');

const sha256 = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');

// ---- moving bytes across the CDP bridge --------------------------------------------
// base64, CHUNKED on the page side: String.fromCharCode(...wholeZip) overflows the
// argument stack, which reads as a mysteriously empty export rather than a bridge problem.
// Written out at each call site rather than injected as source, because a page-side eval
// is one more thing that can fail for reasons that have nothing to do with the feature.

const openSessions = async (p) => {
	await p.page.evaluate(() => window.__stores.sessionsOpen.set(true));
	await p.page.waitForTimeout(900);
};

const metas = (p) =>
	p.page.evaluate(() => {
		let v;
		window.__stores.sessions.sessions.subscribe((x) => (v = x))();
		return (v ?? []).map((m) => ({ id: m.id, name: m.name, lib: m.hasLibrary, files: m.libraryCount }));
	});

const libraryOf = (p) =>
	p.page.evaluate(() => {
		let items;
		window.__stores.explorer.explorerItems.subscribe((v) => (items = v))();
		let folders;
		window.__stores.explorer.explorerFolders.subscribe((v) => (folders = v))();
		const nameOf = (id) => folders.find((f) => f.id === id)?.name ?? null;
		return {
			items: items.map((i) => ({ name: i.name, hash: i.hash, kind: i.kind, folder: nameOf(i.folderId) })),
			folders: folders.map((f) => ({ name: f.name, parent: nameOf(f.parentId) }))
		};
	});

const manifestOf = (p) =>
	p.page.evaluate(() => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m;
	});

// the OPEN warning BLOCKS openProject — answer it while the page awaits
const answerOpenConfirm = async (peer) => {
	await h.eventually(
		() =>
			peer.page.evaluate(() => {
				let d;
				window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
				return d?.title ?? null;
			}),
		(t) => typeof t === 'string' && t.startsWith('Open project'),
		'the OPEN warning dialog appeared (fork 12: open replaces, warned)'
	);
	await peer.page.evaluate(() => window.__stores.confirmDialog.resolveConfirm(true));
};

/** the three library files, in a real tree: one at the root, two inside Props/Metal */
const FILES = [
  { name: 'readme.txt', text: 'r13 p1 readme', folder: null },
  { name: 'bolt.txt', text: 'r13 p1 bolt bytes', folder: 'Metal' },
  { name: 'plate.txt', text: 'r13 p1 plate bytes', folder: 'Metal' }
];

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1440, height: 900 } } });
	const page = A.page;
	await page.waitForFunction(
		() => !!window.__stores?.sessions && !!window.__stores?.projectFile && !!window.__stores?.explorer,
		null,
		{ timeout: 30000 }
	);
	await page.evaluate(async () => {
		await window.__stores.explorer.loadExplorer();
		await window.__stores.explorer.clearLibrary();
		await window.__stores.sessions.loadSessions();
	});
	await page.waitForTimeout(500);

	// =====================================================================
	// 1. SEED — a scene worth saving and a library worth carrying
	// =====================================================================
	await page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		window.__stores.objectActions.deselectObject();
	});
	const seeded = await page.evaluate(async (files) => {
		const s = window.__stores;
		const props = s.explorer.createFolder('Props', null);
		const metal = s.explorer.createFolder('Metal', props?.id ?? null);
		const out = [];
		for (const f of files) {
			const bytes = new TextEncoder().encode(f.text).buffer;
			const item = await s.explorer.addItemFromBytes(
				bytes,
				f.name,
				f.folder === 'Metal' ? (metal?.id ?? null) : null
			);
			out.push({ name: item.name, hash: item.hash });
		}
		return { items: out, props: props?.id ?? null, metal: metal?.id ?? null };
	}, FILES);
	h.check(
		seeded.items.length === 3 && !!seeded.props && !!seeded.metal,
		`premise: three library files in a two-deep folder tree (${seeded.items.map((i) => i.name).join(', ')})`
	);
	const worldSize = await page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return (g?.children ?? []).length;
	});
	h.check(worldSize > 0, `premise: the scene has content to carry (${worldSize} objects)`);

	// =====================================================================
	// 2. SAVE BOTH KINDS THROUGH THE REAL UI
	// =====================================================================
	await openSessions(A);
	await page.locator('#session-save-project').click();
	await page.waitForTimeout(300);
	await page.locator('#session-save-name').fill('Depot Project');
	await page.locator('#session-save-confirm').click();
	await h.eventually(() => metas(A), (l) => l.some((m) => m.lib), 'the project save lands', 25000);
	await page.locator('#session-save').click();
	await page.waitForTimeout(300);
	await page.locator('#session-save-name').fill('Depot Scene');
	await page.locator('#session-save-confirm').click();
	await h.eventually(() => metas(A), (l) => l.length === 2, 'the scene save lands beside it', 25000);
	const saved = await metas(A);
	const project = saved.find((m) => m.lib);
	const scene = saved.find((m) => !m.lib);
	h.check(
		!!project && project.files === 3 && !!scene,
		`premise: one PROJECT entry carrying three files, and one SCENE entry (${JSON.stringify(saved.map((m) => [m.name, m.files]))})`
	);

	// =====================================================================
	// 3. THE BUTTONS — the reported bug, per entry kind
	// =====================================================================
	const cardButtons = (label) =>
		page.evaluate((label) => {
			const card = [...document.querySelectorAll('.session-card')].find((c) =>
				(c.textContent || '').includes(label)
			);
			if (!card) return null;
			return [...card.querySelectorAll('button')].map((b) => ({
				text: (b.textContent || '').trim(),
				cls: b.className,
				title: b.getAttribute('title') || ''
			}));
		}, label);
	const projCard = await cardButtons('Depot Project');
	const sceneCard = await cardButtons('Depot Scene');
	h.check(
		!!projCard && projCard.some((b) => /session-download-project/.test(b.cls) && b.text === '.tp'),
		`THE FIX: a project card offers .tp (${JSON.stringify((projCard ?? []).map((b) => b.text))})`
	);
	h.check(
		!!projCard && !projCard.some((b) => /session-download-scene/.test(b.cls)),
		'…and no longer offers .tpscene, which was the report'
	);
	h.check(
		!!sceneCard &&
			sceneCard.some((b) => /session-download-scene/.test(b.cls) && b.text === '.tpscene') &&
			!sceneCard.some((b) => /session-download-project/.test(b.cls)),
		`a SCENE card keeps .tpscene and is not offered .tp (${JSON.stringify((sceneCard ?? []).map((b) => b.text))})`
	);
	h.check(
		(projCard ?? []).some((b) => b.text === '.json') && (sceneCard ?? []).some((b) => b.text === '.json'),
		'.json stays on both — it is the bug-report format and dropping it would take something away'
	);
	const tpTitle = (projCard ?? []).find((b) => b.text === '.tp')?.title ?? '';
	h.check(
		/\.tp\b/.test(tpTitle) && /librar/i.test(tpTitle) && /project/i.test(tpTitle),
		`the .tp tooltip says what the file IS (${tpTitle.slice(0, 72)}…)`
	);
	const scTitle = (sceneCard ?? []).find((b) => b.text === '.tpscene')?.title ?? '';
	h.check(
		!/for a project/i.test(scTitle),
		`…and the .tpscene tooltip no longer claims it carries "(for a project) its library files" (${scTitle.slice(0, 72)}…)`
	);

	// the LIST view renders the same fork — two sites, one rule
	await page.locator('#session-view-list').click();
	await page.waitForTimeout(500);
	const rowClasses = await page.evaluate(() =>
		[...document.querySelectorAll('#session-list .session-row')].map((r) => ({
			text: (r.textContent || '').slice(0, 40),
			project: !!r.querySelector('.session-download-project'),
			scene: !!r.querySelector('.session-download-scene')
		}))
	);
	h.check(
		rowClasses.length === 2 &&
			rowClasses.filter((r) => r.project).length === 1 &&
			rowClasses.filter((r) => r.scene).length === 1,
		`the list rows fork the same way as the cards (${JSON.stringify(rowClasses.map((r) => [r.project, r.scene]))})`
	);
	await page.locator('#session-view-grid').click();
	await page.waitForTimeout(400);

	// and it really downloads one, with the right extension
	const [dl] = await Promise.all([
		page.waitForEvent('download', { timeout: 30000 }),
		page
			.locator('.session-card')
			.filter({ hasText: 'Depot Project' })
			.locator('.session-download-project')
			.first()
			.click()
	]);
	h.check(
		/\.tp$/.test(dl.suggestedFilename()) && !/\.tpscene$/.test(dl.suggestedFilename()),
		`the real button downloads a .tp (${dl.suggestedFilename()})`
	);
	await page.evaluate(() => window.__stores.sessionsOpen.set(false));
	await page.waitForTimeout(300);

	// =====================================================================
	// 4. THE ARCHIVE, FILE BY FILE
	// =====================================================================
	const exported = await page.evaluate(async (id) => {
		const s = window.__stores;
		const payload = await s.sessions.getSession(id);
		const out = await s.projectFile.exportProjectFromSession(payload);
		let b64 = '';
		for (let i = 0; i < out.bytes.length; i += 8192)
			b64 += String.fromCharCode.apply(null, out.bytes.subarray(i, i + 8192));
		return {
			b64: btoa(b64),
			name: out.name,
			scenes: out.scenes,
			items: out.items,
			skippedItems: out.skippedItems,
			size: out.bytes.length
		};
	}, project.id);
	h.check(
		exported.scenes === 1 && exported.items === 3 && exported.skippedItems === 0,
		`the writer reports one scene, three items, nothing skipped (${exported.scenes}/${exported.items}/${exported.skippedItems}, ${exported.size} bytes)`
	);
	h.check(exported.name === 'Depot Project', `…named after the saved entry (${exported.name})`);

	const zip = unzipSync(new Uint8Array(Buffer.from(exported.b64, 'base64')));
	const names = Object.keys(zip).sort();
	h.check(!!zip['project.json'], `project.json is at the archive root (${names.length} entries)`);
	const doc = JSON.parse(strFromU8(zip['project.json']));
	h.check(
		doc.format === 3 && typeof doc.appVersion === 'string' && doc.appVersion.length > 0,
		`it is a PROJECT_FORMAT 3 file with appVersion provenance (${doc.format}, ${doc.appVersion})`
	);
	h.check(doc.name === 'Depot Project', `and it carries the project name (${doc.name})`);

	// the SCENE — one entry, whose hash is the hash of the bytes it names
	const sceneKeys = names.filter((n) => n.startsWith('scenes/'));
	h.check(sceneKeys.length === 1, `one scenes/ entry, the record's own scene (${sceneKeys.join(', ')})`);
	const sceneRow = (doc.scenes ?? [])[0];
	h.check(
		!!sceneRow && !!zip[sceneRow.file] && sha256(zip[sceneRow.file]) === sceneRow.hash,
		`the scene row points at real bytes whose SHA-256 IS its claimed hash (${String(sceneRow?.hash).slice(0, 12)})`
	);
	h.check(
		sceneRow?.name === 'Depot Project.tpscene',
		`…and names it with a .tpscene extension, which is what kindOf reads to call it a scene (${sceneRow?.name})`
	);
	const inner = unzipSync(zip[sceneRow.file]);
	h.check(
		!!inner['session.json'] &&
			JSON.parse(strFromU8(inner['session.json'])).name === 'Depot Project',
		'a scenes/ entry is an ordinary .tpscene — session.json inside, named'
	);
	// THE LIBRARY MUST NOT BE IN THERE TWICE. Round 12 taught exportSessionZip to write a
	// project payload's library out as real `library/` entries, so handing it the payload
	// whole would put every file in this archive twice and double the file's size.
	h.check(
		!('library' in JSON.parse(strFromU8(inner['session.json']))) &&
			!Object.keys(inner).some((k) => k.startsWith('library/')),
		`…and it is a SCENE bundle: the library was stripped, so nothing is carried twice (${Object.keys(inner).sort().join(', ')})`
	);

	// THE MANIFEST — one scene, a one-entry history, and NO fabricated shared index
	const mScenes = Object.keys(doc.manifest?.scenes ?? {});
	h.check(
		mScenes.length === 1 && mScenes[0] === 'Depot Project',
		`the synthesized manifest claims exactly the one scene it carries (${JSON.stringify(mScenes)})`
	);
	h.check(
		JSON.stringify(doc.manifest.scenes['Depot Project'].history) === JSON.stringify([sceneRow.hash]),
		'its history is the one version a session record HAS — a snapshot, not a history'
	);
	h.check(
		!('folders' in doc.manifest) && !('items' in doc.manifest),
		`manifest.folders/items are ABSENT — a saved row carries no share flag, so claiming the SHARED index would be a fabrication (${Object.keys(doc.manifest).sort().join(',')})`
	);
	h.check(
		Array.isArray(doc.manifest.assets) && doc.manifest.assets.length === 0,
		'and it tracks no manifest assets, because a session record tracks none'
	);
	h.check(
		doc.skipped &&
			doc.skipped.scenes === 0 &&
			doc.skipped.assets === 0 &&
			doc.skipped.omittedVersions === 0 &&
			doc.skipped.omittedScenes === 0 &&
			doc.skipped.items === 0,
		`the file says out loud that it left nothing behind (${JSON.stringify(doc.skipped)})`
	);

	// THE LIBRARY — every row followed to bytes, and every byte hashed
	h.check(
		Array.isArray(doc.items) && doc.items.length === 3,
		`three item rows, one per library file (${(doc.items ?? []).length})`
	);
	const rowFails = (doc.items ?? []).filter(
		(row) => !zip[row.file] || sha256(zip[row.file]) !== row.hash
	);
	h.check(
		rowFails.length === 0,
		`EVERY item row points at a real zip entry whose SHA-256 is its claimed hash (${rowFails.length} bad rows of ${(doc.items ?? []).length})`
	);
	const wanted = FILES.map((f) => f.name).sort().join(',');
	h.check(
		(doc.items ?? []).map((r) => r.name).sort().join(',') === wanted,
		`by NAME, file by file: ${(doc.items ?? []).map((r) => r.name).sort().join(',')}`
	);
	const textOf = (name) => {
		const row = (doc.items ?? []).find((r) => r.name === name);
		return row && zip[row.file] ? strFromU8(zip[row.file]) : null;
	};
	const contentFails = FILES.filter((f) => textOf(f.name) !== f.text);
	h.check(
		contentFails.length === 0,
		`…and by CONTENT: each entry's bytes are the bytes that were imported (${contentFails.map((f) => f.name).join(', ') || 'all three match'})`
	);
	h.check(
		Array.isArray(doc.folders) &&
			doc.folders.some((f) => f.name === 'Props' && f.parentId === null) &&
			doc.folders.some((f) => f.name === 'Metal' && f.parentId !== null),
		`the folder TREE rides top-level, nesting intact (${JSON.stringify((doc.folders ?? []).map((f) => f.name))})`
	);
	const metalRow = (doc.folders ?? []).find((f) => f.name === 'Metal');
	const inMetal = (doc.items ?? []).filter((r) => r.folderId === metalRow?.id).map((r) => r.name).sort();
	h.check(
		JSON.stringify(inMetal) === '["bolt.txt","plate.txt"]',
		`and the items keep their PLACEMENT in it (${JSON.stringify(inMetal)})`
	);

	// =====================================================================
	// 5. ROUND TRIP ONE — openProject on a machine that has never met A
	// =====================================================================
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.projectFile, { timeout: 30000 });
	await B.page.evaluate(() => window.__stores.explorer.loadExplorer());
	const beforeB = await libraryOf(B);
	h.check(
		beforeB.items.length === 0 && beforeB.folders.length === 0,
		`PREMISE: B is a genuinely fresh machine (${beforeB.items.length} items, ${beforeB.folders.length} folders)`
	);
	const pendingOpen = B.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return await window.__stores.projectFile.openProject(bytes.buffer);
	}, exported.b64);
	await answerOpenConfirm(B);
	const openedB = await pendingOpen;
	h.check(
		!!openedB && openedB.items === 3 && openedB.scenes === 1,
		`open restored three library items and the scene (${JSON.stringify(openedB)})`
	);
	const libB = await libraryOf(B);
	const missingB = FILES.filter(
		(f) => !libB.items.some((i) => i.name === f.name && i.folder === f.folder)
	);
	h.check(
		missingB.length === 0,
		`FILE BY FILE: every library file is on B, in its own folder (${missingB.map((f) => f.name).join(', ') || 'all three'})`
	);
	const hashFailsB = seeded.items.filter((s) => !libB.items.some((i) => i.hash === s.hash));
	h.check(
		hashFailsB.length === 0,
		`…and by HASH, which is byte identity by construction (${hashFailsB.length} unresolved of ${seeded.items.length})`
	);
	h.check(
		libB.items.some((i) => i.name === 'Depot Project.tpscene' && i.kind === 'scene' && i.hash === sceneRow.hash),
		`the record's own scene arrived as a scene item (${libB.items.map((i) => i.name).join(', ')})`
	);
	h.check(
		libB.folders.some((f) => f.name === 'Props' && f.parent === null) &&
			libB.folders.some((f) => f.name === 'Metal' && f.parent === 'Props'),
		`the folder tree came back with its nesting (${JSON.stringify(libB.folders)})`
	);
	const mB = await manifestOf(B);
	h.check(
		Object.keys(mB.scenes).join(',') === 'Depot Project' &&
			mB.scenes['Depot Project'].history[0] === sceneRow.hash,
		`and B's manifest names the scene, pointing at the hash it holds (${JSON.stringify(Object.keys(mB.scenes))})`
	);
	h.check(
		mB.name === 'Depot Project',
		`…under the project's name, which is what the Explorer header reads (${mB.name})`
	);
	// the scene resolves, which is the whole point of a project file
	h.check(
		(await B.page.evaluate((hash) => !!window.__stores.explorer.itemByHash(hash), sceneRow.hash)) === true,
		'the manifest pointer RESOLVES in B\'s library — no dead pointer, the rule projectFile\'s header states'
	);

	// =====================================================================
	// 6. ROUND TRIP TWO — importProjectAsFolder FURNISHES, and installs nothing
	// =====================================================================
	const C = await h.setupPage(browser, 'C');
	await C.page.waitForFunction(() => !!window.__stores?.projectFile, { timeout: 30000 });
	await C.page.evaluate(() => window.__stores.explorer.loadExplorer());
	const beforeC = await libraryOf(C);
	h.check(beforeC.items.length === 0, 'PREMISE: C is fresh too');
	const importedC = await C.page.evaluate(async (b64) => {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return await window.__stores.projectFile.importProjectAsFolder(bytes.buffer, {
			fileName: 'Depot Project.tp'
		});
	}, exported.b64);
	h.check(
		!!importedC && importedC.items === 3 && importedC.scenes === 1,
		`import furnished three items and the scene (${JSON.stringify(importedC)})`
	);
	const libC = await libraryOf(C);
	const missingC = FILES.filter((f) => !libC.items.some((i) => i.name === f.name));
	h.check(
		missingC.length === 0,
		`FILE BY FILE on the furnish path too (${missingC.map((f) => f.name).join(', ') || 'all three'})`
	);
	const hashFailsC = seeded.items.filter((s) => !libC.items.some((i) => i.hash === s.hash));
	h.check(hashFailsC.length === 0, `…every hash resolves (${hashFailsC.length} unresolved)`);
	h.check(
		libC.folders.some((f) => f.name === 'Depot Project' && f.parent === null) &&
			libC.folders.some((f) => f.name === 'Props' && f.parent === 'Depot Project'),
		`…under ONE folder named after the file, the 21-I ruling (${JSON.stringify(libC.folders.map((f) => [f.name, f.parent]))})`
	);
	h.check(
		libC.items.some((i) => i.name === 'Depot Project.tpscene'),
		'and the scene came with it'
	);
	const mC = await manifestOf(C);
	h.check(
		Object.keys(mC.scenes).length === 0 && !mC.name,
		`IMPORT installs no manifest — furnishing is not switching projects (${JSON.stringify(Object.keys(mC.scenes))}, name "${mC.name}")`
	);

	// =====================================================================
	// 7. THE PAYLOAD IS THE ONLY SOURCE — no live store is read
	// =====================================================================
	// Change the world and the library out from under it, then export the SAME record
	// again: the file must be about what was saved, not about what is on screen. This is
	// the property that makes the writer correct at all, and it is invisible to any check
	// that exports while the two happen to agree.
	const afterEdit = await page.evaluate(
		async (id) => {
			const s = window.__stores;
			s.commandsHandler.sceneCommand('/create sphere');
			await new Promise((r) => setTimeout(r, 1200));
			const bytes = new TextEncoder().encode('a file saved AFTER the project was').buffer;
			await s.explorer.addItemFromBytes(bytes, 'later.txt', null);
			const payload = await s.sessions.getSession(id);
			const out = await s.projectFile.exportProjectFromSession(payload);
			let items;
			s.explorer.explorerItems.subscribe((v) => (items = v))();
			let b64 = '';
			for (let i = 0; i < out.bytes.length; i += 8192)
				b64 += String.fromCharCode.apply(null, out.bytes.subarray(i, i + 8192));
			return { b64: btoa(b64), items: out.items, live: items.map((i) => i.name) };
		},
		project.id
	);
	h.check(
		afterEdit.live.includes('later.txt') && afterEdit.live.length === 4,
		`premise: the LIVE library moved on (${afterEdit.live.join(', ')})`
	);
	const zip2 = unzipSync(new Uint8Array(Buffer.from(afterEdit.b64, 'base64')));
	const doc2 = JSON.parse(strFromU8(zip2['project.json']));
	h.check(
		afterEdit.items === 3 && !(doc2.items ?? []).some((r) => r.name === 'later.txt'),
		`the second export is still the SAVED project — three items, and later.txt is not in it (${(doc2.items ?? []).map((r) => r.name).join(', ')})`
	);

	await h.finish(browser);
});

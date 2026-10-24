// Roadmap 66 S4b — `import_file`, the agent's door for files made on its own machine, on two real peers.
// A is a person's page (the host), B an agent's page (safeStorage `agentApi`, what the bridge sets). The
// file is the REAL Pixling 0.3.1 output (tests/e2e/fixtures/pixling, rendered on the Deck by the recipe in
// the docs): a 1024×192 walk sheet of 64×48 frames plus the spec it was built from.
//   1  tools() offers import_file with its schema; the agent imports the sheet + spec into the session
//   2  the host sees Explorer ▸ Generated/knight_walk.png + knight_walk.pixling.json (shared rows) and the
//      card: nearest filtering, one frame of the sheet, facing the camera about Y
//   3  a chunked upload (the bridge's large-file path) lands as one file in a nested folder
//   4  a viewer's agent is REFUSED and nothing is created anywhere
//   5  the host's AI window has ONE line for the import; its Undo removes the card on both pages and bins
//      the files it created
//
// Run: APP_URL='https://theprototype.app:5495/' npm run e2e -- import-file
const h = require('./helpers.cjs');
const fs = require('node:fs');
const path = require('node:path');

const FIX = path.join(__dirname, 'fixtures', 'pixling');
const SHEET = fs.readFileSync(path.join(FIX, 'knight_walk.png')).toString('base64');
const SPEC = JSON.parse(fs.readFileSync(path.join(FIX, 'knight.pixling.json'), 'utf8'));
const SHEET_JSON = fs.readFileSync(path.join(FIX, 'knight_walk.sheet.json')).toString('base64');

const inPage = (peer, body, arg) =>
	peer.page.evaluate(
		([src, a]) => {
			let pc = null;
			window.__stores.peers.subscribe((v) => (pc = v))();
			return Object.getPrototypeOf(async function () {}).constructor('s', 'pc', 'arg', src)(window.__stores, pc, a);
		},
		[body, arg ?? null]
	);
const read = (peer, store) => inPage(peer, `let v; s.${store}.subscribe((x) => (v = x))(); return v;`);

/** poll `fn` until `pred` holds or the time is up; returns the LAST value (h.eventually returns nothing) */
async function poll(fn, pred, timeout = 15000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (pred(last)) return last;
		await new Promise((r) => setTimeout(r, 400));
	}
	return last;
}

/** the Explorer as a peer sees it: visible rows with their folder path */
const library = (peer) =>
	inPage(
		peer,
		`let items, folders; s.explorer.explorerItems.subscribe((v) => (items = v))(); s.explorer.explorerFolders.subscribe((v) => (folders = v))();
		 const byId = new Map((folders ?? []).map((f) => [f.id, f]));
		 const pathOf = (id) => { const out = []; let f = byId.get(id); while (f) { out.unshift(f.name); f = byId.get(f.parentId); } return out.join('/'); };
		 return (items ?? []).map((i) => ({ name: i.name, hash: i.hash, folder: pathOf(i.folderId), share: i.share ?? 'local' }));`
	);

/** the card as a page holds it: map filtering + window, facing, the stored card record */
const cardOn = (peer, uuid) =>
	inPage(
		peer,
		`let g; s.objectsGroup.subscribe((v) => (g = v))(); const o = g?.getObjectByProperty('uuid', arg);
		 if (!o) return null; const m = Array.isArray(o.material) ? o.material[0] : o.material; const t = m?.map;
		 return { name: o.name, map: !!t, image: !!t?.image, mag: t?.magFilter, min: t?.minFilter,
		   repeat: t ? [t.repeat.x, t.repeat.y] : null, offset: t ? [t.offset.x, t.offset.y] : null,
		   card: o.userData?.imageCard ?? null };`,
		uuid
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B', { storage: { agentApi: '1' } });
	await B.page.waitForFunction(() => !!window.tpAgent, null, { timeout: 30000 });
	await h.connect(B, A);
	const joined = await poll(() => B.page.evaluate(() => window.tpAgent.status()), (x) => x?.joined, 20000);
	h.check(joined?.joined === true && joined.canEdit === true, 'premise: the agent page joined A and can edit');

	// ---- 1. the tool and the import -------------------------------------------------------------
	const tool = (await B.page.evaluate(() => window.tpAgent.tools())).find((t) => t.function?.name === 'import_file');
	const props = tool?.function?.parameters?.properties ?? {};
	h.check(!!tool && ['data', 'chunk', 'spec', 'folder', 'frame', 'filter', 'facing', 'path'].every((k) => k in props), 'tools() offers import_file with its full schema');
	const depth0 = await B.page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));
	const res = await B.page.evaluate(
		(a) => window.tpAgent.exec('import_file', a),
		{ data: SHEET, name: 'knight_walk', spec: SPEC, frame: { w: 64, h: 48, col: 0, row: 0 }, facing: 'camera-y', source: 'pixling 0.3.1 build specs/knight.json --clips walk --dirs S,E,N,W', licence: 'own work' }
	);
	h.check(!res?.error, `the import succeeded (${JSON.stringify(res).slice(0, 160)})`);
	h.check(res?.file?.name === 'knight_walk.png' && res.file.kind === 'png' && res.file.folder === 'Generated', `the file is Generated/knight_walk.png, a PNG by its bytes (${JSON.stringify(res?.file)})`);
	h.check(res?.spec?.name === 'knight_walk.pixling.json', `the spec is stored beside it as knight_walk.pixling.json (${res?.spec?.name})`);
	h.check(res?.pixels?.w === 1024 && res.pixels.h === 192, `the sheet is 1024×192 (${JSON.stringify(res?.pixels)})`);
	h.check(res?.filter === 'nearest' && !!res.uuid, `placed as a card with nearest filtering by default (a spec = pixel art) (${res?.filter})`);
	h.check(Math.abs(res?.size?.width / res?.size?.height - 64 / 48) < 0.01, `the card has the FRAME's aspect, not the sheet's (${JSON.stringify(res?.size)})`);
	const depth1 = await B.page.evaluate(() => new Promise((r) => window.__stores.history.undoStack.subscribe((v) => r(v.length))()));
	h.check(depth1 === depth0 + 1, `ONE undo entry for the whole import (${depth0} -> ${depth1})`);

	// ---- 2. what the host sees ------------------------------------------------------------------
	const libA = await poll(() => library(A), (l) => l.some((i) => i.name === 'knight_walk.png') && l.some((i) => i.name === 'knight_walk.pixling.json'), 20000);
	const sheetRow = libA.find((i) => i.name === 'knight_walk.png');
	const specRow = libA.find((i) => i.name === 'knight_walk.pixling.json');
	h.check(sheetRow?.folder === 'Generated' && specRow?.folder === 'Generated', `A's Explorer has both files in Generated (${JSON.stringify([sheetRow, specRow])})`);
	h.check(sheetRow?.hash === res?.file?.hash && specRow?.hash === res?.spec?.hash, 'by the same content hashes the agent reported');
	const libB = await library(B);
	h.check(libB.filter((i) => i.name.startsWith('knight_walk')).every((i) => i.share === 'mine'), `the agent's rows are shared (${JSON.stringify(libB.filter((i) => i.name.startsWith('knight_walk')).map((i) => i.share))})`);
	const cardA = await poll(() => cardOn(A, res?.uuid), (c) => !!c?.image, 20000);
	h.check(!!cardA, `the card reached A by uuid (${JSON.stringify(cardA)?.slice(0, 200)})`);
	h.check(cardA?.card?.hash === res?.file?.hash && cardA.card.specName === 'knight_walk.pixling.json' && cardA.card.facing === 'camera-y', `the card names its sheet and spec (${JSON.stringify(cardA?.card)?.slice(0, 200)})`);
	h.check(cardA?.mag === 1003 && cardA?.min === 1003, `A draws it with NEAREST filtering (mag ${cardA?.mag}, min ${cardA?.min})`);
	h.check(Math.abs(cardA?.repeat?.[0] - 64 / 1024) < 1e-4 && Math.abs(cardA?.repeat?.[1] - 48 / 192) < 1e-4, `A shows ONE frame of the sheet (repeat ${JSON.stringify(cardA?.repeat)})`);
	h.check(Math.abs(cardA?.offset?.[1] - 0.75) < 1e-4 && Math.abs(cardA?.offset?.[0]) < 1e-4, `the top-left frame (row 0 = top) (offset ${JSON.stringify(cardA?.offset)})`);
	// facing: A's card runs the per-viewer hook — for a camera at (5, 3, 0) it draws turned about Y toward it,
	// while the authored pose (what the wire, saves and undo see) stays put
	const facing = await inPage(
		A,
		`let g; s.objectsGroup.subscribe((v) => (g = v))(); const o = g.getObjectByProperty('uuid', arg); if (!o) return null;
		 await new Promise((r) => setTimeout(r, 300));
		 o.updateMatrixWorld(true); const cam = { matrixWorld: o.matrixWorld.clone().makeTranslation(5, 3, 0) };
		 const p = { x: o.matrixWorld.elements[12], z: o.matrixWorld.elements[14] };
		 o.onBeforeRender(null, null, cam); const e = o.matrixWorld.elements;
		 const drawn = Math.atan2(e[8], e[0]), tilt = Math.abs(e[9]);
		 o.updateMatrixWorld(true);
		 return { hook: o.onBeforeRender.name, drawn, tilt, want: Math.atan2(5 - p.x, 0 - p.z), authored: o.rotation.y };`,
		res?.uuid
	);
	h.check(facing?.hook === 'faceCamera', `A installed the facing hook on the arriving card (${facing?.hook})`);
	h.check(!!facing && Math.abs(facing.drawn - facing.want) < 1e-3 && facing.tilt < 1e-6, `camera-y: drawn turned toward the camera about Y only (${JSON.stringify(facing)})`);
	h.check(!!facing && Math.abs(facing.authored) < 1e-6, 'the authored rotation is untouched (the turn is per viewer)');

	// ---- 3. a chunked upload into a nested folder -------------------------------------------------
	const cut = Math.floor(SHEET_JSON.length / 3 / 4) * 4;
	const parts = [SHEET_JSON.slice(0, cut), SHEET_JSON.slice(cut, 2 * cut), SHEET_JSON.slice(2 * cut)];
	/** @type {any[]} */
	const answers = [];
	for (let i = 0; i < 3; i++)
		answers.push(await B.page.evaluate((a) => window.tpAgent.exec('import_file', a), { data: parts[i], chunk: { id: 'sheetjson', index: i, total: 3 }, ...(i === 2 ? { name: 'knight_walk.frames', folder: 'Generated/meta' } : {}) }));
	h.check(answers[0]?.partial && answers[1]?.partial && answers[1].received === 2, `the first two chunks are kept, not imported (${JSON.stringify(answers.slice(0, 2))})`);
	h.check(answers[2]?.file?.kind === 'json' && answers[2].file.name === 'knight_walk.frames.json' && answers[2].file.folder === 'Generated/meta' && !answers[2].uuid, `the last chunk imports the JSON into Generated/meta, no card (${JSON.stringify(answers[2]?.file)})`);
	const metaA = await poll(() => library(A), (l) => l.some((i) => i.name === 'knight_walk.frames.json'), 20000);
	h.check(metaA.find((i) => i.name === 'knight_walk.frames.json')?.folder === 'Generated/meta', 'A files it in the nested folder too');
	const chunkLines = await poll(() => read(A, 'agentLog.agentLog'), (log) => log?.some((e) => /knight_walk\.frames\.json/.test(e.text)), 15000);
	h.check((chunkLines ?? []).filter((e) => e.tool === 'import_file').length === 2, `the chunks made no log lines of their own (2 import lines: ${JSON.stringify((chunkLines ?? []).map((e) => e.text))})`);

	// ---- 4. a viewer's agent is refused -----------------------------------------------------------
	const objsBefore = await inPage(A, `let g; s.objectsGroup.subscribe((v) => (g = v))(); return g.children.length;`);
	const libBefore = (await library(B)).length;
	await B.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set({ myId: 'x', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole() {} }));
	const refused = await B.page.evaluate((a) => window.tpAgent.exec('import_file', a), { data: SHEET, name: 'viewer_try', spec: SPEC });
	h.check(refused?.refused === true && /view/i.test(refused.error ?? ''), `a viewer's import_file is REFUSED with a reason (${(refused?.error ?? '').slice(0, 80)})`);
	await B.page.evaluate(() => window.__stores.cloudHooks.rolesInfo.set(null));
	await B.page.waitForTimeout(1500);
	h.check((await library(B)).length === libBefore && !(await library(A)).some((i) => i.name.startsWith('viewer_try')), 'nothing was filed on either page');
	h.check((await inPage(A, `let g; s.objectsGroup.subscribe((v) => (g = v))(); return g.children.length;`)) === objsBefore, 'and nothing was placed');

	// ---- 5. one line, one Undo, both pages --------------------------------------------------------
	await inPage(A, "s.aiAssistantHidden.set('')");
	const lineEl = A.page.locator('#agent-log .alog-line', { hasText: 'imported knight_walk.png + its spec and placed it in the scene' });
	await lineEl.waitFor({ timeout: 8000 }).catch(() => {});
	h.check((await lineEl.count()) === 1, "A's AI window shows ONE line for the import");
	await lineEl.locator('.alog-undo').dispatchEvent('click');
	const goneA = await poll(() => cardOn(A, res?.uuid), (c) => c === null, 15000);
	h.check(goneA === null, "the line's Undo removed the card on A");
	h.check((await cardOn(B, res?.uuid)) === null, '…and on the agent page');
	const binnedA = await poll(() => library(A), (l) => !l.some((i) => i.name === 'knight_walk.png' || i.name === 'knight_walk.pixling.json'), 15000);
	h.check(!binnedA.some((i) => i.name === 'knight_walk.png' || i.name === 'knight_walk.pixling.json'), "the files the import created left A's Explorer (to the Deleted bin)");
	h.check(!(await library(B)).some((i) => i.name === 'knight_walk.png'), "…and the agent's");
	h.check(binnedA.some((i) => i.name === 'knight_walk.frames.json'), 'the separate chunked import is untouched');
	const deleted = await inPage(A, `let m; s.projectManifest.projectManifest.subscribe((v) => (m = v))(); return (m?.deleted ?? []).map((d) => d.name);`).catch(() => null);
	h.check(!deleted || deleted.includes('knight_walk.png'), `the Deleted log names the sheet (${JSON.stringify(deleted)})`);
	h.check(!!(await poll(() => read(A, 'agentLog.agentLog'), (log) => log?.some((e) => e.tool === 'import_file' && e.undone), 10000))?.some((e) => e.undone), 'the line reads undone');

	h.check((await h.pageErrors(A)).length === 0 && (await h.pageErrors(B)).length === 0, `no page errors (${JSON.stringify([...h.pageErrors(A), ...h.pageErrors(B)])})`);
	await h.finish(browser);
});

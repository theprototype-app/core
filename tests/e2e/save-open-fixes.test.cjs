// ROADMAP 56 C14-C17 — the save/open fixes (owner's phone and preview-55).
//
//   1. C14: a project download is typed as plain bytes (Android Chrome renames a zip-typed `.tp` to `.tp.zip`);
//   2. C15: burger Save with a dirty scene names it and offers Save scene and project / without; Cancel saves nothing;
//   3. C16: the file remembers the open scene; opening it lands there with the edits, a missing scene = the old answer;
//   4. C17: "Review versions..." un-minimizes the dock and lands; no copy here = says so and offers the fetch.
//
// Run: APP_URL='https://localhost:5437/' npm run e2e -- save-open-fixes
const fs = require('fs');
const h = require('./helpers.cjs');
const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate');

const stores = (p, fn, arg) => p.page.evaluate(fn, arg);
const level = (p) =>
	stores(p, () => {
		let v;
		window.__stores.levels.currentLevel.subscribe((x) => (v = x))();
		return v?.name ?? null;
	});
const dialog = (p) =>
	stores(p, () => {
		let d;
		window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
		return d ? { title: d.title, message: d.message, choices: (d.choices ?? []).map((c) => c.value) } : null;
	});
const history = (p, name) =>
	stores(p, (n) => {
		let m;
		window.__stores.projectManifest.projectManifest.subscribe((v) => (m = v))();
		return m.scenes[n]?.history ?? [];
	}, name);
const objectCount = (p) => stores(p, () => window.__stores.objectsGroup && (() => {
	let g;
	window.__stores.objectsGroup.subscribe((v) => (g = v))();
	return g?.children?.length ?? 0;
})());
const createObject = (p, what) =>
	stores(p, async (w) => {
		window.__stores.commandsHandler.sceneCommand('/create ' + w);
		await new Promise((r) => setTimeout(r, 1300));
		window.__stores.objectActions.deselectObject();
	}, what);
const notes = (p) =>
	stores(p, () => {
		let n;
		window.__stores.notifications.subscribe((v) => (n = v))();
		return (n ?? []).map((x) => x.text ?? x.message ?? String(x));
	});

/** the burger's Save row, format Project; `answer` = the question's button, null = no question expected */
async function burgerSave(p, answer) {
	await stores(p, () => {
		window.__stores.saveOptions.setSaveOptions({ format: 'tp' });
		window.__stores.closeMenu.set(false);
	});
	await p.page.waitForSelector('#sidebar70', { timeout: 20000 });
	await p.page.waitForTimeout(350);
	const save = p.page.locator('#sidebar70 #project-save, #sidebar70 #save-project').first();
	const download = answer === 'cancel' ? null : p.page.waitForEvent('download', { timeout: 60000 });
	await save.click();
	if (answer) {
		await p.page.waitForFunction(() => {
			let d;
			window.__stores.confirmDialog.confirmDialog.subscribe((v) => (d = v))();
			return !!d;
		}, null, { timeout: 20000 });
	}
	const asked = answer ? await dialog(p) : null;
	if (answer) await p.page.locator(answer === 'cancel' ? '#confirm-dialog-cancel' : '#confirm-dialog-' + answer).click();
	const file = download ? await download : null;
	await stores(p, () => window.__stores.closeMenu.set(true));
	if (!file) return { asked, name: null, bytes: null };
	const at = await file.path();
	return { asked, name: file.suggestedFilename(), bytes: fs.readFileSync(at) };
}

/** open bytes through openProject, accepting its confirm */
async function openFile(p, bytes) {
	const running = stores(p, async (b64) => {
		const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		return !!(await window.__stores.projectFile.openProject(raw.buffer));
	}, Buffer.from(bytes).toString('base64'));
	await p.page.waitForSelector('#confirm-dialog-ok', { timeout: 30000 });
	const asked = await dialog(p);
	await p.page.locator('#confirm-dialog-ok').click();
	const ok = await running;
	return { asked, ok };
}

h.run(async () => {
	const browser = await h.launch();
	const P = await h.setupPage(browser, 'P');
	await P.page.waitForFunction(() => !!window.__stores?.projectFile && !!window.__stores?.levels && !!window.__stores?.saveOptions, null, { timeout: 60000 });
	await P.page.evaluate(() => {
		const original = URL.createObjectURL.bind(URL);
		window.__blobTypes = [];
		URL.createObjectURL = (b) => {
			window.__blobTypes.push(b.type);
			return original(b);
		};
	});
	await stores(P, async () => {
		const s = window.__stores;
		await s.explorer.loadExplorer();
		await s.explorer.clearLibrary();
		s.levels.currentLevel.set(null);
	});

	// two saved scenes; Alpha open with a clean state
	await createObject(P, 'box');
	await stores(P, () => window.__stores.levels.saveSceneAsLevel('Beta', null));
	await createObject(P, 'box');
	await stores(P, () => window.__stores.levels.saveSceneAsLevel('Alpha', null));
	h.check((await level(P)) === 'Alpha', 'premise: Alpha is the open scene');

	// ---- clean scene: no question ------------------------------------------------------------------
	const clean = await burgerSave(P, null);
	h.check(/\.tp$/.test(clean.name), `a clean scene saves straight away, as a .tp (${clean.name})`);

	// ---- C14 ---------------------------------------------------------------------------------------
	const types = await stores(P, () => window.__blobTypes);
	h.check(types.at(-1) === 'application/octet-stream', `C14: the .tp download is plain bytes, not a zip type (${types.at(-1)})`);

	// ---- C15: Cancel, then without, then with ------------------------------------------------------
	await createObject(P, 'sphere');
	const before = (await history(P, 'Alpha')).length;
	const cancelled = await burgerSave(P, 'cancel');
	h.check(cancelled.asked?.message.includes('"Alpha"') && cancelled.asked.choices.join() === 'scene,without', `C15: the question names the scene, Save scene and project first (${JSON.stringify(cancelled.asked)})`);
	h.check((await history(P, 'Alpha')).length === before, 'C15: Cancel saves nothing');

	const without = await burgerSave(P, 'without');
	h.check(without.name && (await history(P, 'Alpha')).length === before, 'C15: "without these changes" writes the project and no new scene version');

	const count = await objectCount(P);
	const withScene = await burgerSave(P, 'scene');
	h.check(withScene.name && (await history(P, 'Alpha')).length === before + 1, 'C15: "Save scene and project" saves a new version of the scene into the file');
	const doc = JSON.parse(strFromU8(unzipSync(new Uint8Array(withScene.bytes))['project.json']));
	h.check(doc.lastScene === 'Alpha', `C16: the file remembers the open scene (${doc.lastScene})`);

	// ---- C16: reopen -------------------------------------------------------------------------------
	await stores(P, () => window.__stores.levels.travelToScene('Beta'));
	await h.eventually(() => level(P), (n) => n === 'Beta', 'premise: travelled away to Beta', 60000);
	const reopened = await openFile(P, withScene.bytes);
	h.check(reopened.ok && reopened.asked.message.includes('"Alpha"'), `C16: the open question says where it lands (${reopened.asked?.message})`);
	await h.eventually(() => level(P), (n) => n === 'Alpha', 'C16: opening the project reopens the last scene', 60000);
	await h.eventually(() => objectCount(P), (n) => n === count, `C16: with the edits (${count} objects)`, 30000);

	// a file whose last scene is gone: the old answer
	const entries = unzipSync(new Uint8Array(withScene.bytes));
	const gone = { ...doc, lastScene: 'Nowhere' };
	const rewritten = zipSync({ ...entries, 'project.json': strToU8(JSON.stringify(gone)) });
	await stores(P, () => window.__stores.levels.currentLevel.set(null));
	const fallback = await openFile(P, rewritten);
	h.check(fallback.ok && fallback.asked.message.includes('The scene on screen stays'), 'C16: a missing last scene falls back (the scene on screen stays)');
	h.check((await level(P)) === null, 'C16: ...and nothing is travelled to');

	// ---- C17 ---------------------------------------------------------------------------------------
	const diverge = (name, first, mine, theirs) =>
		stores(P, ({ name, first, mine, theirs }) => {
			const m = window.__stores.projectManifest;
			m.publishSceneVersion(name, mine);
			m.applyRemoteManifest({ manifest: { name: '', scenes: { [name]: { history: [first, theirs], pinned: [] } }, assets: [], changedAt: Date.now() + 60000 } });
		}, { name, first, mine, theirs });
	const saved = await stores(P, async () => (await window.__stores.levels.saveSceneAsLevel('Arena'))?.hash);
	await stores(P, () => {
		window.__stores.explorerClose.set(true);
		window.__stores.bottomDock.dockMinimized.set(true);
	});
	await diverge('Arena', saved, 'h-local2', 'peer-a2');
	await P.page.locator('#confirm-dialog-history-0').click({ timeout: 20000 });
	await P.page.locator('#version-history').waitFor({ state: 'visible', timeout: 30000 });
	h.check(await P.page.locator('#version-history').isVisible(), 'C17: Review versions lands on the history, from a closed Explorer and a minimized dock');

	await stores(P, () => window.__stores.projectManifest.publishSceneVersion('Ghost', 'ghost-1'));
	await diverge('Ghost', 'ghost-1', 'ghost-mine', 'ghost-theirs');
	await P.page.locator('#confirm-dialog-history-0').click({ timeout: 20000 });
	await h.eventually(() => notes(P), (n) => n.some((t) => t.includes('No copy of "Ghost"')), 'C17: no copy here says so', 20000);
	const fetch = P.page.locator('.tp-toast button', { hasText: 'Fetch it' });
	h.check((await fetch.count()) >= 1, 'C17: ...and offers to fetch it from the peer');

	const errs = await h.pageErrors(P);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs)})`);
	await h.finish(browser);
});

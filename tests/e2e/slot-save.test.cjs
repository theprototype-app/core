// 105-slot-save-fix: a primitive with an added material slot keeps every face through every save path, a scene saved
// broken by an older build loads with its faces back, an old scene that was fine loads unchanged, and the two-peer +
// reload paths agree. Optional STOCK_URL (e.g. https://theprototype.pages.dev/ = the newest release): a file saved by
// this build opens there with every face (SKIP line when unset — the int battery runs without it).
//
// Counterfactual: run against the release before the fix (APP_URL=https://theprototype.pages.dev/) and sections
// 1-4 and 6-7 go red (8 of 12 triangles draw nothing after the reopen).
const h = require('./helpers.cjs');

/** the box's draw state, by name @param {any} peer @param {string} name */
const state = (peer, name) =>
	peer.page.evaluate(async (name) => {
		const w = window.__tp.test.v1;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		/** @type {any} */ let o = null;
		g.traverse((/** @type {any} */ n) => (o ??= n.isMesh && n.name === name ? n : null));
		if (!o) return null;
		const mats = Array.isArray(o.material) ? o.material : [o.material];
		const geo = o.geometry;
		const count = geo.index ? geo.index.count : geo.attributes.position.count;
		let perTri = '';
		let drawNothing = 0;
		for (let t = 0; t < count / 3; t++) {
			const at = t * 3;
			const grp = (geo.groups || []).find((/** @type {any} */ x) => at >= x.start && at < x.start + x.count);
			const s = Array.isArray(o.material) ? (grp ? grp.materialIndex || 0 : -1) : 0;
			perTri += s < 0 ? '-' : String(s);
			if (s < 0 || s >= mats.length) drawNothing++;
		}
		return { uuid: o.uuid, geometry: geo.type, slots: mats.length, groups: (geo.groups || []).length, perTri, drawNothing, tris: count / 3 };
	}, name);

const NAME = 'SlotCrate';
const good = (/** @type {any} */ s) => !!s && s.slots === 2 && s.tris === 12 && s.drawNothing === 0 && s.perTri === '000000000000';

/** the box's picture (a chrome-free square on it) @param {any} peer */
async function frameOf(peer) {
	await peer.page.evaluate(() => window.__tp.test.v1.pokeScene?.());
	await peer.page.waitForTimeout(900);
	return h.grabFrame(peer, await h.centeredClip(peer, [0, 0.5, 0], 200));
}

/** load a payload here, no backup stash @param {any} peer @param {any} payload @param {boolean} [replicate] */
const load = (peer, payload, replicate = false) =>
	peer.page.evaluate(
		async ({ payload, replicate }) => window.__tp.test.v1.sessions.applySession(payload, { backup: false, replicate, quiet: true }),
		{ payload, replicate }
	);

/** a page on another build (helpers.setupPage always opens APP_URL): the same first-visit flags, then its hooks
 * @param {any} browser @param {string} url */
async function stockPage(browser, url) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
	await ctx.addInitScript(() => {
		localStorage.setItem('debugStores', 'true');
		localStorage.setItem('hasSeenDisclaimer', 'true');
		localStorage.setItem('hasSeenWelcome', 'true');
	});
	const page = await ctx.newPage();
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
	await page.waitForFunction(() => !!window.__tp?.test?.v1?.sessions, null, { timeout: 90000 });
	return { page };
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	await h.answerRestore(A);

	// ---- 0. a fresh box, "Add material slot", nothing assigned (the state the scout found) ----------------------
	await A.page.evaluate(async (name) => {
		const w = window.__tp.test.v1;
		w.commandsHandler.sceneCommand('/create Box 1 1 1');
		for (let i = 0; i < 50; i++) {
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const box = g.children.find((/** @type {any} */ c) => c.isMesh && !c.name);
			if (box) {
				box.name = name;
				box.position.set(0, 0.5, 0);
				w.materialsHandler.addMaterialSlot(box.uuid);
				return;
			}
			await new Promise((r) => setTimeout(r, 200));
		}
	}, NAME);
	const live = await state(A, NAME);
	h.check(good(live), '0 a box with an added slot draws all 12 triangles on slot 0: ' + JSON.stringify(live));
	const frame0 = await frameOf(A);
	const sameFrame = async (/** @type {any} */ peer, /** @type {string} */ label, /** @type {any} */ base = frame0) => {
		const d = await h.frameDelta(peer.page, base, await frameOf(peer), 24);
		h.check(!d.error && d.fraction < 0.02, label + ' (pixels: ' + (d.error ?? (d.fraction * 100).toFixed(2) + '% changed') + ')');
	};

	// ---- 1. scene save -> reopen (buildSessionPayload: the Explorer save, cloud save and dirty check) -------------
	const saved = await A.page.evaluate(() => JSON.parse(JSON.stringify(window.__tp.test.v1.sessions.buildSessionPayload('slot-save', { thumbnail: false }))));
	await load(A, saved);
	await h.eventually(() => state(A, NAME), good, '1 scene save -> reopen: every face draws on slot 0', 20000);
	await sameFrame(A, '1 pixels: the reopened box looks like the box before the save');

	// ---- 2. .tpscene export -> import (the zip writer + shared-geometry pass) -------------------------------------
	await A.page.evaluate(async () => {
		const S = window.__tp.test.v1;
		const payload = S.sessions.buildSessionPayload('slot-save-zip', { thumbnail: false });
		const bytes = await S.sessions.exportSessionZip(payload, { assets: false, packs: false, flow: true });
		const back = await S.sessions.readSessionZip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
		await S.sessions.applySession(back, { backup: false, replicate: false, quiet: true });
	});
	await h.eventually(() => state(A, NAME), good, '2 .tpscene export -> import: every face draws', 20000);

	// ---- 3. Save as .tpscene of a selection (buildSelectionPayload) -----------------------------------------------
	await A.page.evaluate(async (uuid) => {
		const S = window.__tp.test.v1;
		const payload = JSON.parse(JSON.stringify(S.sessions.buildSelectionPayload('slot-sel', [uuid])));
		await S.sessions.applySession(payload, { backup: false, replicate: false, quiet: true });
	}, (await state(A, NAME)).uuid);
	await h.eventually(() => state(A, NAME), good, '3 selection .tpscene -> open: every face draws', 20000);

	// ---- 4. delete -> undo (the history snapshot) ---------------------------------------------------------------
	await A.page.evaluate(async (uuid) => {
		const S = window.__tp.test.v1;
		S.objectActions.deleteObjectsByUuid([uuid]);
		await new Promise((r) => setTimeout(r, 300));
		S.history.undo();
	}, (await state(A, NAME)).uuid);
	await h.eventually(() => state(A, NAME), good, '4 delete -> undo: every face draws', 15000);

	// ---- 5. a scene SAVED BROKEN by 1.74.0 (plain toJSON of the parametric box) loads with its faces back -------
	const broken = await A.page.evaluate(async (name) => {
		const S = window.__tp.test.v1;
		const T = S.THREE;
		const payload = S.sessions.buildSessionPayload('slot-broken', { thumbnail: false });
		const geometry = new T.BoxGeometry(1, 1, 1);
		geometry.clearGroups();
		geometry.addGroup(0, 36, 0);
		const mesh = new T.Mesh(geometry, [new T.MeshStandardMaterial(), new T.MeshStandardMaterial()]);
		mesh.name = name;
		mesh.position.set(0, 0.5, 0);
		payload.objects = [mesh.toJSON()]; // what every build up to 1.74.0 wrote: parameters only, no groups
		return JSON.parse(JSON.stringify(payload));
	}, NAME);
	await load(A, broken);
	await h.eventually(() => state(A, NAME), good, '5 a scene saved broken before the fix opens with every face (healed on load)', 20000);

	// ---- 6. an old scene that was FINE loads unchanged (single-material box, 6-slot box, edited 2-slot mesh) -------
	const unchanged = await A.page.evaluate(async () => {
		const S = window.__tp.test.v1;
		const T = S.THREE;
		const payload = S.sessions.buildSessionPayload('slot-old', { thumbnail: false });
		const one = new T.Mesh(new T.BoxGeometry(1, 1, 1), new T.MeshStandardMaterial());
		one.name = 'Old1';
		const six = new T.Mesh(new T.BoxGeometry(1, 1, 1), Array.from({ length: 6 }, () => new T.MeshStandardMaterial()));
		six.name = 'Old6';
		six.position.x = 2;
		const flat = new T.BufferGeometry().copy(new T.BoxGeometry(1, 1, 1));
		flat.clearGroups();
		flat.addGroup(0, 6, 1);
		flat.addGroup(6, 30, 0);
		const edited = new T.Mesh(flat, [new T.MeshStandardMaterial(), new T.MeshStandardMaterial()]);
		edited.name = 'OldEdited';
		edited.position.x = -2;
		payload.objects = [one.toJSON(), six.toJSON(), edited.toJSON()];
		const input = JSON.parse(JSON.stringify(payload));
		await S.sessions.applySession(JSON.parse(JSON.stringify(input)), { backup: false, replicate: false, quiet: true });
		await new Promise((r) => setTimeout(r, 800));
		const g = await new Promise((r) => S.objectsGroup.subscribe(r)());
		/** @type {string[]} */
		const diffs = [];
		for (const element of input.objects) {
			const o = g.children.find((/** @type {any} */ c) => c.uuid === element.object.uuid);
			if (!o) {
				diffs.push(element.object.uuid + ' missing');
				continue;
			}
			const now = o.toJSON();
			if (JSON.stringify(now.geometries) !== JSON.stringify(element.geometries)) diffs.push(o.name + ' geometry');
			if (now.materials.length !== element.materials.length) diffs.push(o.name + ' materials');
		}
		return diffs;
	});
	h.check(unchanged.length === 0, '6 an old scene that drew every face loads unchanged (geometry JSON identical): ' + JSON.stringify(unchanged));

	// back to the crate for the two-peer half, saved with THIS build (the file the newest release must open)
	await load(A, saved);
	await h.eventually(() => state(A, NAME), good, '7 setup: the crate is back', 20000);
	const fixedFile = await A.page.evaluate(() => JSON.parse(JSON.stringify(window.__tp.test.v1.sessions.buildSessionPayload('slot-fixed', { thumbnail: false }))));
	const fixedZip = await A.page.evaluate(async () => {
		const S = window.__tp.test.v1;
		const bytes = await S.sessions.exportSessionZip(S.sessions.buildSessionPayload('slot-fixed-zip', { thumbnail: false }), { assets: false, packs: false, flow: true });
		return Array.from(bytes);
	});

	// ---- 7. two peers: the joiner sees every face; the joiner reloads (auto-rejoin); the host reloads (autosave) ----
	const B = await h.setupPageQuiet(browser, 'B', [A], { context: { viewport: { width: 1280, height: 800 } } });
	await h.answerRestore(B);
	await h.connect(B, A);
	await h.eventually(() => state(B, NAME), good, '7a the joiner receives the crate with every face', 30000);
	await sameFrame(B, '7a pixels: the joiner draws the crate the host draws');

	await h.freshReload(B);
	await h.eventually(() => state(B, NAME), good, '7b the joiner reloads, rejoins and still sees every face', 60000);

	await A.page.evaluate(() => window.__tp.test.v1.autosave.saveNow());
	await h.freshReload(A);
	await h.answerRestore(A, 'restore', 20000);
	await h.eventually(() => state(A, NAME), good, '7c the host reloads, restores the autosave: every face', 30000);

	await load(A, fixedFile, true);
	await h.eventually(() => state(A, NAME), good, '7d the host opens the saved scene: every face', 20000);
	await h.eventually(() => state(B, NAME), good, '7d the joiner receives the opened scene: every face', 30000);
	await sameFrame(B, '7d pixels: the joiner still draws the whole crate');

	// ---- 8. a file saved by this build opens in the newest release (stock page, own context, no peers) -----------
	const stock = process.env.STOCK_URL;
	if (!stock) console.log('SKIP 8 STOCK_URL not set (a file saved by this build opened in the newest release)');
	else {
		const C = await stockPage(browser, stock);
		const version = await C.page.evaluate(() => window.__tp.test.v1.version?.APP_VERSION ?? '?');
		console.log('stock page version: ' + version);
		await load(C, fixedFile);
		await h.eventually(() => state(C, NAME), good, '8a the newest release opens a scene saved by this build with every face', 30000);
		await C.page.evaluate(async (bytes) => {
			const S = window.__tp.test.v1;
			const u8 = new Uint8Array(bytes);
			const back = await S.sessions.readSessionZip(u8.buffer);
			await S.sessions.applySession(back, { backup: false, replicate: false, quiet: true });
		}, fixedZip);
		await h.eventually(() => state(C, NAME), good, '8b the newest release opens a .tpscene exported by this build with every face', 30000);
	}

	await h.finish(browser);
});

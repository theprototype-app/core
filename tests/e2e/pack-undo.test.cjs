// 30b integrate — placing kit pieces is UNDOABLE, by reference.
//
// A piece placed from a pack was recorded in history as its full toJSON — a 0.8 MB
// architecture-kit wall is ~7.9 MB that way (its JPEGs come back as PNG data URLs), past
// history's 5 MB snapshot limit, so every placement toasted "Object is too large for undo
// history" and a level built from the kits had no undo at all. history now asks a
// registered provider first (packRefs: a PRISTINE piece -> its stub) and keeps THAT; undo
// removes the piece, redo adds the stub back and the scene's stub scan refills it from the
// pack, with the recorded child uuids.
//
// Fixture: the bundled Duck (always served, addressed by an absolute url — the pack-refs
// suite's fixture), placed TEN times through the real drop path. A last section places a
// real architecture-kit wall when KIT_URL names one (e.g. a jsDelivr url of the packs repo)
// and SKIPS without it.
//
//   APP_URL=https://theprototype.app:5239/ [KIT_URL=https://…/WallStone.glb] node tests/e2e/pack-undo.test.cjs
const h = require('./helpers.cjs');

const DUCK = 'library/default/Duck/glTF-Binary/Duck.glb';

async function place(peer, url, name) {
	return peer.page.evaluate(
		async ({ url, name }) => {
			const s = window.__stores;
			/** @type {any} */ let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const before = new Set(g.children.map((c) => c.uuid));
			/** @type {any} */ let renderer;
			s.globalRenderer.subscribe((v) => (renderer = v))();
			const r = renderer.domElement.getBoundingClientRect();
			await s.explorerDrop.dropExplorerItem({ kind: 'object', name, url }, r.left + r.width / 2, r.top + r.height / 2);
			for (let i = 0; i < 200; i++) {
				const fresh = g.children.find((c) => !before.has(c.uuid));
				if (fresh) return fresh.uuid;
				await new Promise((res) => setTimeout(res, 100));
			}
			return null;
		},
		{ url, name }
	);
}

/** the scene's roots that carry a pack reference, with their refill state */
const pieces = (peer) =>
	peer.page.evaluate(() => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		return g.children
			.filter((o) => o.userData.packRef)
			.map((o) => {
				let tris = 0;
				o.traverse((n) => {
					if (n.isMesh) tris += (n.geometry.index ? n.geometry.index.count : n.geometry.attributes.position.count) / 3;
				});
				return { uuid: o.uuid, stub: !!o.userData.packStub, tris, kids: o.children.length };
			});
	});

/** the create entries on the undo stack, with the size of what each one keeps */
const createEntries = (peer) =>
	peer.page.evaluate(() => {
		const s = window.__stores;
		/** @type {any[]} */ let stack = [];
		s.history.undoStack.subscribe((v) => (stack = v))();
		return stack
			.filter((e) => e.kind === 'create')
			.map((e) => ({ uuid: e.uuid, bytes: JSON.stringify(e.snapshot.element).length, stub: !!e.snapshot.element?.object?.userData?.packStub }));
	});

const toasts = (peer) =>
	peer.page.evaluate(() => {
		const s = window.__stores;
		/** @type {any[]} */ let list = [];
		(s.notifications ?? s.toastStore).subscribe((v) => (list = v))();
		return (list || []).map((t) => String(t.message ?? t.text ?? t)).filter((m) => /too large for undo/i.test(m)).length;
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const url = await A.page.evaluate((p) => location.origin + '/' + p, DUCK);

	// 1. TEN placements, each a create entry that keeps the STUB -------------------------
	const placed = [];
	for (let i = 0; i < 10; i++) placed.push(await place(A, url, 'Duck'));
	h.check(placed.every(Boolean) && new Set(placed).size === 10, `premise: ten kit pieces placed through the real drop path (${placed.filter(Boolean).length})`);
	const filled = await pieces(A);
	const tris0 = filled[0]?.tris ?? 0;
	h.check(filled.length === 10 && filled.every((p) => !p.stub && p.tris > 0), `premise: all ten are filled pieces (${filled.map((p) => p.tris).join(',')} tris)`);
	const entries = await createEntries(A);
	const mine = entries.filter((e) => placed.includes(e.uuid));
	h.check(mine.length === 10, `each placement recorded ONE create entry (${mine.length})`);
	h.check(
		mine.every((e) => e.stub && e.bytes < 4000),
		`THE FIX: each entry keeps the piece as its STUB, not its bytes (${mine.map((e) => e.bytes).join(',')} B)`
	);

	// 2. undo all ten -------------------------------------------------------------------
	for (let i = 0; i < 10; i++) await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => pieces(A), (p) => p.length === 0, 'undo x10 removes every piece', 8000);

	// 3. redo all ten: back as stubs, refilled from the pack under the SAME uuids ---------
	for (let i = 0; i < 10; i++) await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(
		() => pieces(A),
		(p) => p.length === 10 && p.every((x) => !x.stub && x.tris === tris0),
		'redo x10 restores every piece, refilled from the pack (same triangle count)',
		20000
	);
	const back = await pieces(A);
	h.check(placed.every((u) => back.some((p) => p.uuid === u)), 'the restored pieces keep their uuids');

	// 4. and once more round the loop (redo recaptured each snapshot on its way out) -------
	for (let i = 0; i < 10; i++) await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => pieces(A), (p) => p.length === 0, 'a second undo x10 still removes them all', 8000);
	for (let i = 0; i < 10; i++) await A.page.evaluate(() => window.__stores.history.redo());
	await h.eventually(() => pieces(A), (p) => p.length === 10 && p.every((x) => !x.stub), 'a second redo x10 still restores them all', 20000);

	// 5. a REAL kit wall (7.9 MB as toJSON): no "too large" toast, and it undoes ----------
	const kit = process.env.KIT_URL;
	if (!kit) {
		console.log('SKIP a real kit wall (set KIT_URL to an architecture-kit GLB)');
	} else {
		const t0 = await toasts(A);
		const wall = await place(A, kit, 'WallStone');
		h.check(!!wall, 'premise: a real architecture-kit wall placed');
		const e = (await createEntries(A)).find((x) => x.uuid === wall);
		h.check(!!e && e.stub && e.bytes < 4000, `the wall's undo entry is its stub (${e && e.bytes} B)`);
		h.check((await toasts(A)) === t0, 'no "too large for undo history" toast for the wall');
		await A.page.evaluate(() => window.__stores.history.undo());
		await h.eventually(() => pieces(A), (p) => !p.some((x) => x.uuid === wall), 'undo removes the wall', 8000);
		await A.page.evaluate(() => window.__stores.history.redo());
		await h.eventually(() => pieces(A), (p) => p.some((x) => x.uuid === wall && !x.stub && x.tris > 500), 'redo brings the wall back, refilled', 30000);
	}

	await h.finish(browser);
});

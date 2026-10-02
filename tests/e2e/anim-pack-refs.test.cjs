// 33-scenes — ANIMATED PACK REFERENCES (animatedImports `animRef`): a door from the
// interactive kit is an animated import, and a save used to carry its whole GLB as base64.
// Its bytes ARE the pack's file, so a save names the file and a restore fetches it.
//   1. a DoorWood placed through the Explorer's own drop saves as an `animRef` entry with
//      NO bytes, a fraction of the size the bytes were;
//   2. restoring that payload brings the door back from the pack: the behavior registers,
//      the LOD group rides along, the root keeps its reference (a re-save stays small);
//   3. two copies fetch the file ONCE;
//   4. an entry WITH bytes (an ordinary animated import, an older save) restores as before.
// Needs the interactive kit served by the build (VITE_PACKS_BASE); SKIPS otherwise.
//
//   APP_URL=https://theprototype.app:5282/ node tests/e2e/anim-pack-refs.test.cjs
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'anim-pack-refs');
	const page = peer.page;

	const row = await page.evaluate(async () => {
		const base = String(window.__stores.packs.PACKS_BASE).replace(/\/+$/, '');
		const res = await fetch(base + '/interactive-kit/default.json').catch(() => null);
		if (!res?.ok) return null;
		const r = (await res.json()).find((x) => x.name === 'DoorWood');
		return r ? { url: base + '/interactive-kit/DoorWood/glTF-Binary/' + r.variants['glTF-Binary'], behavior: r.behavior, lods: r.lods } : null;
	});
	if (!row) {
		console.log('SKIP the interactive kit is not served by this build (set VITE_PACKS_BASE)');
		await h.finish(browser);
		return;
	}

	/** place a DoorWood through the Explorer drop (the user's own path) at x */
	const place = (x) =>
		page.evaluate(
			async ({ row, x }) => {
				const s = window.__stores;
				let g;
				s.objectsGroup.subscribe((v) => (g = v))();
				const before = new Set(g.children.map((c) => c.uuid));
				await s.explorerDrop.dropExplorerItem({ kind: 'object', name: 'DoorWood', url: row.url, behavior: row.behavior, lods: row.lods }, innerWidth / 2, innerHeight / 2);
				let o = null;
				for (let i = 0; i < 100 && !o; i++) {
					o = g.children.find((c) => !before.has(c.uuid)) ?? null;
					if (!o) await new Promise((r) => setTimeout(r, 100));
				}
				if (o) o.position.set(x, 0, -3);
				return o?.uuid ?? null;
			},
			{ row, x }
		);

	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await page.waitForTimeout(500);
	const a = await place(-1);
	const b = await place(1.5);
	h.check(!!a && !!b, 'premise: two doors placed through the Explorer drop');
	await page.waitForTimeout(800);

	// ---- 1. the save names the file ------------------------------------------------------
	const saved = await page.evaluate(() => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('doors');
		const entries = payload.animated ?? [];
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const bytes = s.animatedImports.animatedImportPayload?.(g.children[0].uuid);
		return {
			payload,
			n: entries.length,
			refs: entries.filter((e) => e.animRef?.path && !e.bytes).length,
			path: entries[0]?.animRef?.path,
			size: JSON.stringify(entries).length,
			fileSize: bytes?.buffer?.byteLength ?? bytes?.byteLength ?? null,
			behavior: entries[0]?.behavior?.type,
			lod: !!entries[0]?.lod
		};
	});
	h.check(saved.n === 2 && saved.refs === 2, `both doors save as an animRef with no bytes (${saved.refs} of ${saved.n})`);
	h.check(saved.path === 'interactive-kit/DoorWood/glTF-Binary/door-wood.glb', `the reference is PACKS_BASE-relative (${saved.path})`);
	h.check(saved.size < 4000, `the two entries weigh ${saved.size} B (the file alone is ${saved.fileSize} B, ~1.33x that as base64)`);
	h.check(saved.behavior === 'door' && saved.lod, `the entry keeps the behavior (${saved.behavior}) and the LOD group (${saved.lod})`);

	// ---- 2/3. the restore fetches the pack file, once -------------------------------------
	const restored = await page.evaluate(async (payload) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/clear all');
		await new Promise((r) => setTimeout(r, 300));
		const urls = [];
		const inner = window.fetch;
		window.fetch = function (input, ...rest) {
			urls.push(String(input?.url ?? input));
			return inner.call(this, input, ...rest);
		};
		try {
			await s.animatedImports.animatedImportsRestore(payload.animated, false);
		} finally {
			window.fetch = inner;
		}
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const roots = g.children.filter((c) => c.userData?.animRef);
		const again = s.sessions.buildSessionPayload('doors-again').animated ?? [];
		return {
			roots: roots.length,
			behaviors: s.animatedImports.behaviorUuids().length,
			lods: roots.filter((r) => r.userData.lod).length,
			fetches: urls.filter((u) => u.endsWith('door-wood.glb')).length,
			meshes: roots[0] ? (() => { let n = 0; roots[0].traverse((o) => o.isMesh && n++); return n; })() : 0,
			reRefs: again.filter((e) => e.animRef && !e.bytes).length
		};
	}, saved.payload);
	h.check(restored.roots === 2 && restored.meshes >= 2, `both doors come back from the pack (${restored.roots} roots, ${restored.meshes} meshes each)`);
	h.check(restored.behaviors === 2, `their behaviors register (${restored.behaviors})`);
	h.check(restored.lods === 2, `their LOD groups ride along (${restored.lods})`);
	h.check(restored.fetches <= 1, `the file is fetched ONCE for two copies (${restored.fetches} fetches)`);
	h.check(restored.reRefs === 2, `a re-save of the restored doors is still references (${restored.reRefs})`);

	// ---- 4. an entry with bytes restores as before ----------------------------------------
	const legacy = await page.evaluate(async (url) => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/clear all');
		await new Promise((r) => setTimeout(r, 300));
		const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
		let bin = '';
		for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		const n = await s.animatedImports.animatedImportsRestore([{ uuid: s.THREE.MathUtils.generateUUID(), name: 'Old door', kind: 'gltf', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], anim: null, bytes: btoa(bin) }], false);
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const again = s.sessions.buildSessionPayload('old').animated ?? [];
		return { n, bytes: again.filter((e) => e.bytes && !e.animRef).length, name: g.children[0]?.name };
	}, row.url);
	h.check(legacy.n === 1 && legacy.bytes === 1, `an entry with bytes restores and re-saves with its bytes (${legacy.n}, ${legacy.bytes})`);

	await h.finish(browser);
});

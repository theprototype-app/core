// fix-agenttest item 3 — REPEATED ACTIONS GIVE THEIR TEXTURES BACK.
// The agent test watched renderer.info.memory.textures climb over a session. A probe that wrapped
// gl.createTexture/deleteTexture and repeated common actions six times found two sources:
//  · a shadow-casting light that is deleted (or swept by /clear all) kept its SHADOW MAP render
//    target (colour + depth texture) — `disposeTree` freed geometry/material/maps and skipped the
//    light's own LightShadow, so every spot/point/directional light ever deleted stayed on the GPU;
//  · a peer's PHOTO avatar card (AvatarRig) loaded a new THREE.Texture on every roster update (a name
//    change, any userdata message) and never disposed the last one.
// Counterfactual on v1.47.0: 1.x (textures grow by 2 per deleted light) and 2.1/2.2 are red.
const h = require('./helpers.cjs');

const texCount = (p) =>
	p.page.evaluate(() => {
		let r;
		window.__stores.globalRenderer?.subscribe?.((v) => (r = v))();
		return r?.info?.memory?.textures ?? null;
	});

const frames = (p, n) => p.page.evaluate(async (k) => { for (let i = 0; i < k; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	h.check((await texCount(A)) !== null, 'premise: renderer.info is readable');

	// ---- 1. lights: create, draw a few frames (so the shadow map exists), delete --------------------
	for (const [label, remove] of [
		['/clear all', (uuid) => page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'))],
		['delete', (uuid) => page.evaluate((u) => window.__stores.commandsHandler.sceneCommand('/clear ' + u), uuid)]
	]) {
		for (const kind of ['spot', 'point', 'directional']) {
			const cycle = async () => {
				const uuid = await page.evaluate((k) => {
					const S = window.__stores;
					S.commandsHandler.sceneCommand('/light ' + k);
					let g;
					S.objectsGroup.subscribe((v) => (g = v))();
					const l = g.children[g.children.length - 1];
					l.castShadow = true;
					return l.uuid;
				}, kind);
				await frames(A, 6);
				await remove(uuid);
				await frames(A, 6);
			};
			await cycle(); // warm: anything created once (programs' samplers, caches) is not a leak
			const before = await texCount(A);
			for (let i = 0; i < 5; i++) await cycle();
			const after = await texCount(A);
			h.check(after <= before, `1 ${label} ${kind}: five shadow-casting lights created and removed leave no textures (${before} -> ${after})`);
		}
	}

	// ---- 2. a peer's photo avatar: roster updates reuse the card's texture; a new photo frees the old --
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const photo = (p, color) =>
		p.page.evaluate((c) => {
			const cv = document.createElement('canvas');
			cv.width = cv.height = 8;
			const x = cv.getContext('2d');
			x.fillStyle = c;
			x.fillRect(0, 0, 8, 8);
			return cv.toDataURL('image/png');
		}, color);
	const publish = (p, patch) =>
		p.page.evaluate((patch) => {
			const S = window.__stores;
			let peer;
			S.peers.subscribe((v) => (peer = v))();
			const id = peer.peer.id;
			let rows;
			S.userdata.subscribe((v) => (rows = v))();
			rows = rows.map((r) => {
				if (r[0] !== id) return r;
				const n = r.slice();
				if (patch.name != null) n[1] = patch.name;
				if (patch.photo != null) n[2] = patch.photo;
				if (patch.avatar) n[5] = { ...(n[5] ?? {}), ...patch.avatar };
				return n;
			});
			S.userdata.set(rows);
			peer.send({ type: 'userdata', userdata: rows });
		}, patch);
	// the card A draws for B, and every texture it has ever carried (with whether it was disposed)
	await page.evaluate(() => (window.__cardMaps = []));
	const cardMap = (bid) =>
		page.evaluate((id) => {
			let scene;
			window.__stores.globalScene.subscribe((v) => (scene = v))();
			const card = scene?.getObjectByName(id + '-face-card');
			const map = card?.material?.map ?? null;
			if (map && !window.__cardMaps.some((e) => e.map === map)) {
				const entry = { map, disposed: false };
				map.addEventListener('dispose', () => (entry.disposed = true));
				window.__cardMaps.push(entry);
			}
			return { has: !!map, index: map ? window.__cardMaps.findIndex((e) => e.map === map) : -1, seen: window.__cardMaps.length, disposed: window.__cardMaps.map((e) => e.disposed) };
		}, bid);

	await publish(B, { photo: await photo(B, '#e04040'), avatar: { character: 'classic', face: 'image' } });
	await h.eventually(() => cardMap(B.id), (v) => v.has, '2.0 premise: A draws B as a photo card', 20000);
	for (let i = 0; i < 5; i++) {
		await publish(B, { name: 'Bee ' + i });
		await A.page.waitForTimeout(500);
		await cardMap(B.id);
	}
	await A.page.waitForTimeout(800);
	const afterNames = await cardMap(B.id);
	h.check(afterNames.seen === 1, `2.1 five roster updates (name changes) keep ONE card texture (${afterNames.seen} seen)`);
	for (const c of ['#40e040', '#4040e0']) {
		await publish(B, { photo: await photo(B, c) });
		await h.eventually(() => cardMap(B.id), (v) => v.index === v.seen - 1 && v.seen >= 2, '2.x premise: the new photo reached the card', 20000);
	}
	const end = await cardMap(B.id);
	const stale = end.disposed.slice(0, -1);
	h.check(stale.length >= 1 && stale.every(Boolean) && !end.disposed[end.disposed.length - 1], `2.2 a new photo disposes the card's previous texture (${JSON.stringify(end.disposed)})`);

	for (const p of [A, B]) {
		const errs = h.pageErrors(p);
		h.check(errs.length === 0, `no page errors on ${p.id}: ` + JSON.stringify(errs.slice(0, 3)));
	}
	await h.finish(browser);
});

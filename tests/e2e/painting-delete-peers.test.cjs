// 54i row o — A DELETED PAINTING IS GONE FOR EVERYBODY.
// Owner's take (1.51, ad video): a painting (a plane textured with a library image) still showed after it was deleted,
// on VR and PC; cause not verified. Two peers; a painting is made the agent's way (create_objects Plane + update_objects
// map = a library image hash) and deleted every way a session can: the person's Delete, the AI tools' delete_objects
// from either peer, and at agent speed (made, textured and deleted in one go). After each, on BOTH peers: no object
// with that uuid anywhere in the scene, no mesh in the scene still drawing that texture, and on the peer that RECEIVED
// the delete its texture was disposed.
const h = require('./helpers.cjs');

/** a 128 px picture into this page's library; its hash @param {any} page @param {number} hue */
const addPicture = (page, hue) =>
	page.evaluate(async (hu) => {
		const c = document.createElement('canvas');
		c.width = c.height = 128;
		const g = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
		g.fillStyle = `hsl(${hu},70%,50%)`;
		g.fillRect(0, 0, 128, 128);
		g.fillStyle = '#fff';
		g.fillRect(20, 20, 40 + (hu % 50), 60);
		const png = await new Promise((r) => c.toBlob(r, 'image/png'));
		const item = await window.__stores.explorer.addItemFromBytes(await /** @type {Blob} */ (png).arrayBuffer(), 'painting-' + hu + '.png', null);
		return item?.hash ?? null;
	}, hue);

/** make a painting the agent's way; its uuid @param {any} page @param {string} name @param {string} hash @param {boolean} [thenDelete] */
const paint = (page, name, hash, thenDelete = false) =>
	page.evaluate(
		async ({ nm, hs, del }) => {
			const t = window.__stores.aiTools;
			const made = await t.executeAiTool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Plane', name: nm, position: [Math.random() * 4 - 2, 1.5, -2] }] });
			const uuid = made?.created?.[0]?.uuid ?? null;
			const up = await t.executeAiTool('update_objects', { updates: [{ uuid, materialParams: { map: hs } }] });
			const del2 = del ? await t.executeAiTool('delete_objects', { uuids: [uuid] }) : null;
			return { uuid, up: JSON.stringify(up).slice(0, 200), del: del2 };
		},
		{ nm: name, hs: hash, del: thenDelete }
	);

/** what one page holds of a painting: in objectsGroup, anywhere in the scene, its texture still drawn @param {any} page @param {string} uuid */
const holds = (page, uuid) =>
	page.evaluate((u) => {
		const S = window.__stores;
		let group, scene;
		S.objectsGroup.subscribe((x) => (group = x))();
		S.globalScene.subscribe((x) => (scene = x))();
		const inGroup = !!group?.getObjectByProperty('uuid', u);
		let inScene = false;
		let drawn = 0;
		const tex = window.__paintTex?.[u] ?? null;
		scene?.traverse((o) => {
			if (o.uuid === u) inScene = true;
			const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
			if (tex && o.visible && mats.some((m) => m?.map?.uuid === tex.uuid)) drawn++;
		});
		const mesh = group?.getObjectByProperty('uuid', u);
		return { inGroup, inScene, drawn, mapped: !!mesh?.material?.map, disposed: !!window.__paintDisposed?.[u] };
	}, uuid);

/** remember a painting's texture on this page and listen for its dispose @param {any} page @param {string} uuid */
const watchTexture = (page, uuid) =>
	page.evaluate((u) => {
		let group;
		window.__stores.objectsGroup.subscribe((x) => (group = x))();
		const map = group?.getObjectByProperty('uuid', u)?.material?.map;
		if (!map) return false;
		window.__paintTex = { ...(window.__paintTex || {}), [u]: map };
		window.__paintDisposed = window.__paintDisposed || {};
		map.addEventListener('dispose', () => (window.__paintDisposed[u] = true));
		return true;
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A, 8000);
	const hashA = await addPicture(A.page, 20);
	const hashB = await addPicture(B.page, 200);
	h.check(!!hashA && !!hashB, 'premise: a picture in each library');

	/** a painting by `maker`, seen textured on both, deleted by `del` @param {string} label */
	const round = async (label, maker, hash, del) => {
		const p = await paint(maker.page, 'Painting ' + label, hash);
		h.check(!!p.uuid, `${label}: premise: the painting was made (${p.up})`);
		for (const P of [A, B]) await h.eventually(() => holds(P.page, p.uuid), (s) => s.inGroup && s.mapped, `${label}: premise: ${P.id} shows it textured`, 30000);
		for (const P of [A, B]) h.check(await watchTexture(P.page, p.uuid), `${label}: premise: ${P.id} holds its texture`);
		await del(p.uuid);
		for (const P of [A, B]) {
			await h.eventually(() => holds(P.page, p.uuid), (s) => !s.inScene && s.drawn === 0, `${label}: ${P.id} no longer has it anywhere in the scene`, 15000).catch(() => {});
			await P.page.waitForTimeout(1500); // a late re-add would land within this
			const s = await holds(P.page, p.uuid);
			console.log(`  ${label} on ${P.id}: ${JSON.stringify(s)}`);
			h.check(!s.inScene && !s.inGroup, `${label}: ${P.id}: the painting is out of the scene graph`);
			h.check(s.drawn === 0, `${label}: ${P.id}: no mesh still draws its picture (${s.drawn})`);
		}
		return p.uuid;
	};

	const handDelete = (P) => (u) => P.page.evaluate((uu) => {
		window.__stores.objectActions.applySelectionSet([uu]);
		window.__stores.objectActions.deleteSelection();
	}, u);
	const agentDelete = (P) => async (u) => {
		const r = await P.page.evaluate((uu) => window.__stores.aiTools.executeAiTool('delete_objects', { uuids: [uu] }), u);
		h.check(r?.deleted === 1, `delete_objects on ${P.id} deleted it: ${JSON.stringify(r)}`);
	};

	const received = [];
	received.push([B, await round('1 hand delete on the maker', A, hashA, handDelete(A))]);
	received.push([A, await round('2 hand delete on the other peer', A, hashA, handDelete(B))]);
	received.push([B, await round('3 agent delete on the maker', A, hashA, agentDelete(A))]);
	received.push([A, await round('4 agent delete on the other peer', A, hashA, agentDelete(B))]);
	received.push([A, await round('5 guest paints, its own agent deletes', B, hashB, agentDelete(B))]);
	received.push([B, await round('5b guest paints, the host deletes by hand', B, hashB, handDelete(A))]);

	// the peer that RECEIVED a delete frees what the painting drew with (the deleting peer keeps it for Undo)
	for (const [P, u] of received) {
		const s = await holds(P.page, u);
		h.check(s.disposed, `${P.id} disposed the texture of a painting deleted elsewhere (${u.slice(0, 8)})`);
	}

	// at agent speed: made, textured and deleted in one go, then the receiver must not end up with it
	for (const [label, maker, hash] of [['6 agent speed on A', A, hashA], ['7 agent speed on B', B, hashB]]) {
		const p = await paint(maker.page, 'Painting ' + label, hash, true);
		h.check(p.del?.deleted === 1, `${label}: deleted at once (${JSON.stringify(p.del)})`);
		await A.page.waitForTimeout(5000);
		for (const P of [A, B]) {
			const s = await holds(P.page, p.uuid);
			console.log(`  ${label} on ${P.id}: ${JSON.stringify(s)}`);
			h.check(!s.inScene, `${label}: ${P.id}: nothing of it is in the scene`);
		}
	}

	for (const P of [A, B]) {
		const errs = h.pageErrors(P);
		h.check(errs.length === 0, `no page errors on ${P.id}: ` + JSON.stringify(errs.slice(0, 3)));
	}
	await h.finish(browser);
});

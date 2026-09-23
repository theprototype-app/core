// 30c — KIT REFERENCES (src/lib/packRefs.js): a piece placed from a pack carries where it
// came from, and a save / the wire write a PRISTINE one as a small stub that the loader and
// every peer refill from the pack URL.
//
// The fixture is the bundled Duck (static/library/default/Duck — always served by the dev
// server, nested nodes + a texture) addressed by an ABSOLUTE url, so the suite needs no pack
// server; when the dev server's PACKS_BASE serves the architecture kit (VITE_PACKS_BASE), a
// last section measures a real kit wall too, and SKIPS (never fails) without it.
//
//   APP_URL=https://theprototype.app:5255/ node tests/e2e/pack-refs.test.cjs
const h = require('./helpers.cjs');

const DUCK = 'library/default/Duck/glTF-Binary/Duck.glb';

/** Poll until `predicate` holds and RETURN the last value (h.eventually returns nothing). */
async function until(fn, predicate, label, timeout = 10000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	console.log('  last: ' + JSON.stringify(last)?.slice(0, 600));
	h.check(false, label);
	return last;
}

/** Place the fixture through the REAL drop path (explorerDrop.dropExplorerItem with a pack
 * payload), at the canvas centre. Resolves the placed root's uuid. */
async function place(peer, name = 'Duck') {
	return peer.page.evaluate(
		async ({ path, name }) => {
			const s = window.__stores;
			/** @type {any} */ let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const before = new Set(g.children.map((/** @type {any} */ c) => c.uuid));
			/** @type {any} */ let renderer;
			s.globalRenderer.subscribe((v) => (renderer = v))();
			const r = renderer.domElement.getBoundingClientRect();
			await s.explorerDrop.dropExplorerItem({ kind: 'object', name, url: location.origin + '/' + path }, r.left + r.width / 2, r.top + r.height / 2);
			for (let i = 0; i < 100; i++) {
				const fresh = g.children.find((/** @type {any} */ c) => !before.has(c.uuid));
				if (fresh) return fresh.uuid;
				await new Promise((res) => setTimeout(res, 100));
			}
			return null;
		},
		{ path: DUCK, name }
	);
}

/** Facts about one root in a page. */
function facts(peer, uuid) {
	return peer.page.evaluate((uuid) => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		if (!o) return null;
		let tris = 0;
		const kids = [];
		o.traverse((/** @type {any} */ n) => {
			if (n !== o) kids.push(n.uuid);
			if (n.isMesh) tris += (n.geometry.index ? n.geometry.index.count : n.geometry.attributes.position.count) / 3;
		});
		return {
			ref: o.userData.packRef ?? null,
			stub: !!o.userData.packStub,
			children: o.children.length,
			kids,
			tris,
			pos: o.position.toArray().map((v) => Math.round(v * 1000) / 1000),
			pristine: s.packRefs.isPristinePackRef(o)
		};
	}, uuid);
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- 1. a placement carries its reference ------------------------------------
	const duck = await place(A);
	h.check(!!duck, 'the pack payload placed an object through the real drop path');
	const f1 = await facts(A, duck);
	h.check(f1?.ref?.path?.endsWith(DUCK) && /^[0-9a-f]{64}$/.test(f1?.ref?.hash ?? ''), `the root carries packRef {path, hash} (${f1?.ref?.path} ${f1?.ref?.hash?.slice(0, 8)})`);
	h.check(Array.isArray(f1?.ref?.kids) && f1.ref.kids.join() === f1.kids.join() && f1.kids.length > 0, `packRef.kids records the descendants in traverse order (${f1?.kids?.length})`);
	h.check(f1?.pristine === true, 'a fresh placement is pristine');

	// ---- 2. the save writes a stub, a fraction of the full element ----------------
	const saved = await A.page.evaluate((uuid) => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('refs');
		const el = payload.objects.find((/** @type {any} */ e) => e.object?.uuid === uuid);
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const full = JSON.stringify(g.getObjectByProperty('uuid', uuid).toJSON()).length;
		return { stub: !!el?.object?.userData?.packStub, kids: el?.object?.children?.length ?? 0, bytes: JSON.stringify(el).length, full };
	}, duck);
	h.check(saved.stub && saved.kids === 0, 'buildSessionPayload writes the pristine piece as a hollow stub');
	h.check(saved.bytes < 4000 && saved.full > saved.bytes * 20, `the stub is ${saved.bytes} B against a ${saved.full} B full element`);

	// ---- 3. an EDITED piece is written in full ------------------------------------
	const edited = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		let mesh = null;
		o.traverse((/** @type {any} */ n) => {
			if (n.isMesh && !mesh) mesh = n;
		});
		const out = {};
		// a colour change
		const was = mesh.material.color.getHex();
		mesh.material.color.setHex(0x00ff00);
		out.color = s.packRefs.isPristinePackRef(o);
		mesh.material.color.setHex(was);
		out.colorBack = s.packRefs.isPristinePackRef(o);
		// a vertex moved in place (the vertex-drag / sculpt path)
		const pa = mesh.geometry.attributes.position;
		const y = pa.getY(0);
		pa.setY(0, y + 0.25);
		out.vertex = s.packRefs.isPristinePackRef(o);
		const payload = s.sessions.buildSessionPayload('edited');
		const el = payload.objects.find((/** @type {any} */ e) => e.object?.uuid === uuid);
		out.savedFull = !el.object.userData?.packStub && (el.object.children?.length ?? 0) > 0;
		pa.setY(0, y);
		out.vertexBack = s.packRefs.isPristinePackRef(o);
		// a child moved inside the piece
		mesh.position.x += 0.5;
		mesh.updateMatrix();
		out.child = s.packRefs.isPristinePackRef(o);
		mesh.position.x -= 0.5;
		mesh.updateMatrix();
		// the ROOT moved — that is the placement, and rides the stub
		o.position.x += 3;
		o.updateMatrix();
		out.root = s.packRefs.isPristinePackRef(o);
		return out;
	}, duck);
	h.check(edited.color === false && edited.colorBack === true, `a colour change makes it NOT pristine, and undoing it restores it (${edited.color}/${edited.colorBack})`);
	h.check(edited.vertex === false && edited.savedFull === true && edited.vertexBack === true, `an in-place vertex edit is NOT pristine and saves IN FULL (${edited.vertex}/${edited.savedFull}/${edited.vertexBack})`);
	h.check(edited.child === false, 'a moved child inside the piece is NOT pristine');
	h.check(edited.root === true, 'moving the root is the placement: still pristine');

	// ---- 4. a load refills stubs; copies share their textures ---------------------
	const second = await place(A, 'Duck 2');
	const loaded = await A.page.evaluate(async () => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('two');
		const stubs = payload.objects.filter((/** @type {any} */ e) => e.object?.userData?.packStub).length;
		await s.sessions.applySession(payload, { backup: false });
		await new Promise((r) => setTimeout(r, 200));
		await s.packRefs.packRefsSettled();
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const maps = new Set();
		const geos = new Set();
		const mats = new Set();
		let filled = 0;
		for (const c of g.children) {
			if (!c.userData.packRef) continue;
			if (!c.userData.packStub && c.children.length) filled++;
			c.traverse((/** @type {any} */ n) => {
				if (!n.isMesh) return;
				geos.add(n.geometry);
				mats.add(n.material);
				if (n.material.map) maps.add(n.material.map);
			});
		}
		return { stubs, filled, maps: maps.size, geos: geos.size, mats: mats.size, names: payload.objects.map((/** @type {any} */ e) => e.object.name) };
	});
	h.check(loaded.stubs === 2, `both copies saved as stubs (${loaded.stubs})`);
	h.check(loaded.filled === 2, `applySession refilled both (${loaded.filled})`);
	h.check(loaded.maps === 1, `the two copies SHARE one texture (${loaded.maps} distinct maps)`);
	h.check(loaded.geos === 2 && loaded.mats === 2, `...but each owns its geometry and material, so an edit to one cannot move the other (${loaded.geos}/${loaded.mats})`);
	const f4 = await facts(A, duck);
	h.check(f4 && f4.kids.join() === f1.kids.join(), 'the refilled piece takes the RECORDED child uuids');
	h.check(f4 && Math.abs(f4.pos[0] - (f1.pos[0] + 3)) < 1e-3, `the stub kept the root's placement (x ${f4?.pos?.[0]})`);
	h.check(f4 && f4.tris === f1.tris && f4.pristine === true, `the refill is the file again: ${f4?.tris} tris, pristine ${f4?.pristine}`);

	// ---- 5. an autosave-style GLTF round trip re-learns pristine ------------------
	const round = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		const Exporter = s.GLTFExporterModule.GLTFExporter;
		const glb = await new Promise((res, rej) => new Exporter().parse(o, res, rej, { binary: true, onlyVisible: false }));
		const gltf = await new Promise((res, rej) => s.animatedImports.createGltfLoader().parse(glb, '', res, rej));
		const back = gltf.scene.children[0];
		const la = s.packRefs.fingerprintOf(o).key.split('\n');
		const lb = s.packRefs.fingerprintOf(back).key.split('\n');
		const diff = la.map((line, i) => (line === lb[i] ? null : [line.slice(0, 300), (lb[i] ?? '').slice(0, 300)])).filter(Boolean);
		return { hasRef: !!back.userData?.packRef, pristine: s.packRefs.isPristinePackRef(back), diff: diff.slice(0, 2), n: [la.length, lb.length] };
	}, duck);
	h.check(round.hasRef, 'packRef rides GLTF extras (the autosave path)');
	h.check(round.pristine === true, `after a GLTF round trip (re-encoded textures) the piece still reads pristine (${round.pristine})`);
	if (!round.pristine) console.log('  diff ' + JSON.stringify(round.diff) + ' lines ' + round.n);

	// ---- 6. an unreachable pack keeps the reference -------------------------------
	const lost = await A.page.evaluate(async () => {
		const s = window.__stores;
		const T = s.THREE;
		const hollow = new T.Group();
		hollow.name = 'Lost piece';
		hollow.userData = { packRef: { pack: 'nowhere', item: 'Ghost', path: location.origin + '/no/such/piece.glb', hash: 'x', kids: [] }, packStub: true };
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		g.add(hollow);
		s.pokeScene();
		await new Promise((r) => setTimeout(r, 300));
		await s.packRefs.packRefsSettled();
		const payload = s.sessions.buildSessionPayload('lost');
		const el = payload.objects.find((/** @type {any} */ e) => e.object?.uuid === hollow.uuid);
		return { children: hollow.children.length, stillStub: !!hollow.userData.packStub, savedStub: !!el?.object?.userData?.packStub, path: el?.object?.userData?.packRef?.path, uuid: hollow.uuid };
	});
	h.check(lost.children === 0 && lost.stillStub, 'an unreachable piece stays a hollow stub');
	h.check(lost.savedStub && /no\/such\/piece\.glb$/.test(lost.path ?? ''), 'and SAVES back as the same reference — never silently dropped');
	await A.page.evaluate((uuid) => {
		const s = window.__stores;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', uuid);
		o?.parent?.remove(o);
		s.pokeScene();
	}, lost.uuid);

	// ---- 7. two peers: a late joiner and a live placement -------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const joined = await until(
		() => Promise.all([facts(B, duck), facts(B, second)]),
		(r) => r.every((f) => f && !f.stub && f.children > 0),
		'the late joiner refilled both pieces from their pack',
		20000
	);
	h.check(joined[0]?.kids.join() === f1.kids.join(), 'the joiner has the same child uuids');
	h.check(joined[0]?.tris === f1.tris, `the joiner has the same geometry (${joined[0]?.tris} tris)`);
	const wire = await A.page.evaluate(() => {
		const s = window.__stores;
		/** @type {any} */ const p = (() => { let v; s.peers.subscribe((x) => (v = x))(); return v; })();
		/** @type {any[]} */ const sent = [];
		const orig = p.send.bind(p);
		p.send = (msg) => {
			sent.push({ type: msg.type, bytes: JSON.stringify(msg).length, stub: !!msg.element?.object?.userData?.packStub });
			return orig(msg);
		};
		window.__refSent = sent;
		return true;
	});
	h.check(wire, 'a wire spy wraps A.peers.send');
	const third = await place(A, 'Duck 3');
	const live = await until(() => facts(B, third), (f) => f && !f.stub && f.children > 0, 'peer B refilled a LIVE placement', 20000);
	h.check(live?.ref?.hash === f1.ref.hash, 'B built it from the same bytes (hash)');
	const spied = await A.page.evaluate(() => window.__refSent.filter((m) => m.type === 'object'));
	h.check(spied.length === 1 && spied[0].stub && spied[0].bytes < 4000, `the placement crossed the wire as ONE stub message (${JSON.stringify(spied)})`);

	// ---- 8. a real kit wall, when this server's PACKS_BASE serves the architecture kit
	const kit = await A.page.evaluate(async () => {
		const s = window.__stores;
		const url = String(s.packs.PACKS_BASE).replace(/\/+$/, '') + '/architecture-kit/WallStone/glTF-Binary/wall-stone.glb';
		const res = await fetch(url).catch(() => null);
		if (!res?.ok) return null;
		/** @type {any} */ let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const before = new Set(g.children.map((/** @type {any} */ c) => c.uuid));
		await s.explorerDrop.dropExplorerItem({ kind: 'object', name: 'WallStone', url }, innerWidth / 2, innerHeight / 2);
		let o = null;
		for (let i = 0; i < 100 && !o; i++) {
			o = g.children.find((/** @type {any} */ c) => !before.has(c.uuid)) ?? null;
			if (!o) await new Promise((r) => setTimeout(r, 100));
		}
		if (!o) return { placed: false };
		const payload = s.sessions.buildSessionPayload('kit');
		const el = payload.objects.find((/** @type {any} */ e) => e.object?.uuid === o.uuid);
		return { placed: true, path: o.userData.packRef?.path, stub: JSON.stringify(el).length, full: JSON.stringify(o.toJSON()).length };
	});
	if (!kit) console.log('SKIP the architecture kit is not served by this build (set VITE_PACKS_BASE)');
	else {
		h.check(kit.placed && kit.path === 'architecture-kit/WallStone/glTF-Binary/wall-stone.glb', `a kit wall carries a PACKS_BASE-relative path (${kit.path})`);
		h.check(kit.stub < 4000 && kit.full > 1_000_000, `a kit wall saves as ${kit.stub} B instead of ${kit.full} B`);
	}

	await h.finish(browser);
});

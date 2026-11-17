// 101-schema step 1 — CAPTURE WHAT THIS BUILD SENDS AND SAVES, AS FIXTURES.
//
// The scenes repo and the templates cover the content people published; they do not cover every
// object kind the Add menu makes, every material type the Inspector switches to, a textured or a
// multi-slot material, or the shape each of those takes on the WIRE. This suite builds all of them
// in one page and writes three files the schema's "0 drops on real content" proof runs over:
//
//   <out>/capture.tpscene   — the scene saved exactly as the user's Save writes it
//   <out>/wire.json         — every `object` / `objectParameters` message the edits and a full
//                             handshake sync (sendObjects) put on the wire, in order
//   <out>/prefab.json       — a prefab element (the library snapshot shape)
//
// Run it on the BASE tag (v1.65.0) to make the fixtures; run it on the lane later to diff.
// It needs no second peer: the outgoing messages are captured at PeerConnection.broadcast.
//
// Run: APP_URL=https://theprototype.app:7022/ SCHEMA_CAPTURE_OUT=test-results/101-schema/capture node tests/e2e/schema-capture.test.cjs
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const OUT = path.resolve(process.env.SCHEMA_CAPTURE_OUT || path.join(__dirname, '../../test-results/101-schema/capture'));

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'capture');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.commandsHandler && !!window.__stores?.sessions && !!window.__stores?.objectsGroup, null, {
		timeout: 60000
	});

	// ---- the wire tap: every outgoing message, JSON-cloned at the moment it is sent ----------------
	await page.evaluate(() => {
		const s = window.__stores;
		let pc = null;
		s.peers.subscribe((v) => (pc = v))();
		window.__capture = [];
		const orig = pc.broadcast.bind(pc);
		window.__captureOne = (payload) => {
			try {
				const t = payload?.type;
				if (t === 'object' || t === 'objectParameters' || t === 'group' || t === 'duplicate' || t === 'batch' || t === 'objectfile') {
					const el = payload.element;
					// a GLTF binary element is bytes: keep its size, not the bytes
					const clone =
						el instanceof ArrayBuffer || ArrayBuffer.isView(el)
							? { ...payload, element: { __bytes: el.byteLength } }
							: JSON.parse(JSON.stringify(payload, (k, v) => (v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? { __bytes: v.byteLength } : v)));
					window.__capture.push(clone);
				}
			} catch (e) {
				window.__capture.push({ __error: String(e) });
			}
		};
		pc.broadcast = (payload, opts) => {
			window.__captureOne(payload);
			return orig(payload, opts);
		};
	});

	// ---- every Add-menu item -------------------------------------------------------------------------
	const created = await page.evaluate(async () => {
		const s = window.__stores;
		const { primitivesCatalog } = await import('/src/lib/primitivesCatalog.js').catch(() => ({ primitivesCatalog: null }));
		const catalog = primitivesCatalog ?? s.primitivesCatalog?.primitivesCatalog;
		const cmds = catalog ? catalog.flatMap((g) => g.items.map((i) => i.command)) : [];
		let i = 0;
		for (const c of cmds) {
			s.commandsHandler.sceneCommand(c);
			i++;
			await new Promise((r) => setTimeout(r, 60));
		}
		return { count: i, cmds };
	});
	h.check(created.count >= 40, `premise: the Add catalog was walked (${created.count} commands)`);
	await page.waitForTimeout(2500);

	// ---- materials: every switchable type, a textured map, a map slot, a tiling, params, slots ----
	const matInfo = await page.evaluate(async () => {
		const s = window.__stores;
		let group = null;
		s.objectsGroup.subscribe((g) => (group = g))();
		const meshes = group.children.filter((o) => o.isMesh && !Array.isArray(o.material));
		const types = ['MeshBasicMaterial', 'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshPhongMaterial', 'MeshLambertMaterial', 'MeshToonMaterial', 'MeshMatcapMaterial', 'MeshNormalMaterial', 'MeshDepthMaterial', 'ShadowMaterial'];
		const M = s.materialsHandler;
		const done = [];
		types.forEach((t, k) => {
			const m = meshes[k];
			if (!m) return;
			M.switchMaterialType(m.uuid, t, true);
			done.push([m.name, t]);
		});
		// a small PNG as a data URL and as a File
		const cv = document.createElement('canvas');
		cv.width = cv.height = 16;
		const g2 = cv.getContext('2d');
		g2.fillStyle = '#c84';
		g2.fillRect(0, 0, 16, 16);
		g2.fillStyle = '#48c';
		g2.fillRect(0, 0, 8, 8);
		const url = cv.toDataURL('image/png');
		const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
		const file = new File([blob], 'checker_normal.png', { type: 'image/png' });
		const textured = meshes[10] ?? meshes[0];
		M.applyMap(textured, url, 0, null);
		// the replicated map write (what the Inspector does)
		if (s.peers) {
			let pc = null;
			s.peers.subscribe((v) => (pc = v))();
			pc.send({ type: 'objectParameters', parameter: 'map', uuid: textured.uuid, map: url });
		}
		const slotted = meshes[11] ?? meshes[1];
		try {
			await s.materialMaps.setObjectsMapSlot([slotted.uuid], 'normalMap', file, 0);
			s.materialMaps.setTexTransform(slotted.uuid, { repeat: [2, 3], offset: [0.1, 0.2], rotation: 0.3 }, 0);
			s.materialMaps.setNormalStrength(slotted.uuid, 1.5, 0);
		} catch (e) {
			done.push(['mapSlot error', String(e)]);
		}
		const tuned = meshes[12] ?? meshes[2];
		for (const [k, v] of [['roughness', 0.3], ['metalness', 0.7], ['opacity', 0.6], ['transparent', true], ['emissive', '#223344'], ['side', 'double'], ['wireframe', false]])
			M.setMaterialParam(tuned.uuid, k, v, true);
		const multi = meshes.find((o) => o.geometry?.type === 'BoxGeometry') ?? meshes[3];
		M.addMaterialSlot(multi.uuid);
		return { done, textured: textured.name, slotted: slotted.name, multi: multi.name };
	});
	h.check(matInfo.done.length >= 10, `premise: material types switched (${matInfo.done.length})`);
	await page.waitForTimeout(1500);

	// ---- a group, a prefab of it, and the full handshake sync ---------------------------------------
	const syncInfo = await page.evaluate(async () => {
		const s = window.__stores;
		let group = null;
		s.objectsGroup.subscribe((g) => (group = g))();
		const two = group.children.filter((o) => o.isMesh && o.geometry?.type === 'SphereGeometry').concat(group.children.filter((o) => o.isMesh && o.geometry?.type === 'ConeGeometry')).slice(0, 2);
		let groupedName = null;
		try {
			s.selectedObjects.set(two);
			s.objectActions.groupSelection();
			await new Promise((r) => setTimeout(r, 300));
			groupedName = group.children.find((o) => o.type === 'Group')?.name ?? null;
		} catch {
			/* grouping is a nice-to-have here */
		}
		// prefab snapshot shape: what the library stores is `toJSON()` of the object
		const first = group.children.find((o) => o.type === 'Group') ?? group.children.find((o) => o.isMesh);
		const prefab = first.toJSON();
		const before = window.__capture.length;
		// the handshake reply goes to ONE conn (sendObjects resolves `connections[peerId]` after 500 ms), not
		// through broadcast: a fake open conn records it, installed only for this send
		let pc = null;
		s.peers.subscribe((v) => (pc = v))();
		const fake = { open: true, peer: 'capture-peer', send: (m) => window.__captureOne(m) };
		pc.connections['capture-peer'] = fake;
		s.commandsHandler.sendObjects('capture-peer');
		await new Promise((r) => setTimeout(r, 8000));
		delete pc.connections['capture-peer'];
		return { groupedName, prefab, synced: window.__capture.length - before, objects: group.children.length };
	});
	h.check(syncInfo.synced > 0, `premise: the handshake sync emitted messages (${syncInfo.synced})`);
	fs.writeFileSync(path.join(OUT, 'prefab.json'), JSON.stringify(syncInfo.prefab));

	// ---- the save ------------------------------------------------------------------------------------
	const zipB64 = await page.evaluate(async () => {
		const s = window.__stores;
		const payload = await s.sessions.buildSessionPayload('schema-capture');
		const bytes = await s.sessions.exportSessionZip(payload, { assets: true, packs: false, flow: true });
		const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(await new Response(bytes).arrayBuffer());
		let bin = '';
		for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
		return btoa(bin);
	});
	fs.writeFileSync(path.join(OUT, 'capture.tpscene'), Buffer.from(zipB64, 'base64'));

	const wire = await page.evaluate(() => window.__capture);
	fs.writeFileSync(path.join(OUT, 'wire.json'), JSON.stringify(wire));
	const kinds = {};
	for (const m of wire) {
		const k = m.type + (m.parameter ? ':' + m.parameter : '');
		kinds[k] = (kinds[k] || 0) + 1;
	}
	console.log('captured: ' + JSON.stringify({ objects: syncInfo.objects, created: created.count, materials: matInfo, kinds }));
	h.check(wire.length > 0 && !wire.some((m) => m.__error), `captured ${wire.length} wire messages, none failed to clone`);
	await h.finish(browser);
});

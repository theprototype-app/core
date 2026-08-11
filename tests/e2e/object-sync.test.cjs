// The late-joiner OBJECT SYNC: does a peer that joins an existing scene reliably
// receive it? Nothing in the committed suite covered this path before, and it is the
// foundation everything about multi-material replication rests on.
//
// The send side had no protection at all: sendObjects/sendObject call conn.send with
// no `conn.open` guard and no try/catch (unlike peers.broadcast, which has both), and
// peerjs's send() on a non-open connection emits an error and RETURNS - it does not
// throw. A failed dataChannel.send goes further and CLOSES the connection, after
// which every later message is silently swallowed. The only thing standing between
// that and a lost scene was a 500ms setTimeout, and the GLTFExporter callbacks that
// actually emit the objects fire even later.
//
// Diagnostics are first-class here (an unhandledrejection listener, each connection's
// own error event, and a PASS-THROUGH wire spy) because the failure mode is silence:
// nothing throws, nothing logs, the scene is just empty.
const h = require('./helpers.cjs');

/** count + name the objects a page holds */
const sceneOf = (page) =>
	page.evaluate(async () => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		return { count: g.children.length, names: g.children.map((o) => o.name || o.type) };
	});

/** listen for everything that would otherwise be silent */
const instrument = (peer, label) => {
	peer.page.on('pageerror', (e) => console.log('  [' + label + ' pageerror] ' + e.message));
	return peer.page.evaluate(() => {
		const w = window;
		w.__diag = { rejections: [], connErrors: [], sent: [] };
		window.addEventListener('unhandledrejection', (e) =>
			w.__diag.rejections.push(String(e.reason && e.reason.message ? e.reason.message : e.reason))
		);
	});
};

/**
 * Wrap every connection's send so we see what LEAVES, WITHOUT suppressing it. Every
 * existing spy in the suite replaces send() and never calls through, which makes a
 * delivered message and a dropped one look identical.
 */
const spyConns = (peer) =>
	peer.page.evaluate(async () => {
		const w = window;
		const p = await new Promise((r) => w.__stores.peers.subscribe(r)());
		const wrap = () => {
			for (const [, c] of Object.entries(p.connections || {})) {
				const list = Array.isArray(c) ? c : [c];
				list.forEach((conn) => {
					if (!conn || conn.__spied) return;
					conn.__spied = true;
					if (conn.on) conn.on('error', (err) => w.__diag.connErrors.push(String(err && err.message ? err.message : err)));
					const orig = conn.send ? conn.send.bind(conn) : null;
					conn.send = (data) => {
						w.__diag.sent.push({ type: data && data.type, open: !!conn.open });
						return orig ? orig(data) : undefined; // PASS THROUGH
					};
				});
			}
		};
		wrap();
		setInterval(wrap, 40);
	});

const diag = (peer) => peer.page.evaluate(() => window.__diag || null);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await instrument(A, 'A');

	// A builds a scene BEFORE anyone joins - several plain meshes, so a partial
	// delivery shows up as a count rather than all-or-nothing
	const built = await A.page.evaluate(async () => {
		const w = window.__stores;
		for (let i = 0; i < 4; i++) w.commandsHandler.sceneCommand('/create Box 1 1 1');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		g.children.forEach((o, i) => (o.name = 'box' + i));
		w.objectsGroup.update((v) => v);
		return g.children.length;
	});
	h.check(built === 4, 'premise: A has a scene before the join (' + built + ' objects)');
	await spyConns(A);

	// B joins - the joiner dials, the host approves (helpers.connect(from, to))
	const B = await h.setupPage(browser, 'B');
	await instrument(B, 'B');
	await h.connect(B, A);

	await h.eventually(
		() => sceneOf(B.page),
		(s) => s.count === 4,
		'THE BUG: a late joiner receives EVERY object in the scene',
		30000
	);

	const got = await sceneOf(B.page);
	const aDiag = await diag(A);
	const bDiag = await diag(B);
	console.log('  A sent: ' + JSON.stringify(aDiag.sent.map((m) => m.type + (m.open ? '' : '!CLOSED'))));
	if (aDiag.connErrors.length) console.log('  A conn errors: ' + JSON.stringify(aDiag.connErrors));
	if (aDiag.rejections.length) console.log('  A rejections: ' + JSON.stringify(aDiag.rejections));
	if (bDiag.rejections.length) console.log('  B rejections: ' + JSON.stringify(bDiag.rejections));

	h.check(got.count === 4, 'B holds all four objects (' + got.count + ': ' + got.names.join(',') + ')');
	h.check(
		aDiag.sent.every((m) => m.open),
		'every message left over an OPEN connection (' + aDiag.sent.filter((m) => !m.open).length + ' on a closed one)'
	);
	h.check(aDiag.connErrors.length === 0, 'no connection errors while sending (' + aDiag.connErrors.join('|') + ')');
	h.check(
		bDiag.rejections.length === 0,
		'the receiver applied them without a rejection (' + bDiag.rejections.join('|') + ')'
	);

	// ---------- a MULTI-MATERIAL mesh must not take the scene down with it ----------
	// Previously: with one multi-material mesh present, a late joiner got NOTHING -
	// not even the single-material meshes sent in the same batch.
	await A.page.evaluate(async () => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const tex = (hex) => {
			const c = document.createElement('canvas');
			c.width = c.height = 8;
			const ctx = c.getContext('2d');
			ctx.fillStyle = hex;
			ctx.fillRect(0, 0, 8, 8);
			const t = new w.THREE.CanvasTexture(c);
			t.colorSpace = w.THREE.SRGBColorSpace;
			return t;
		};
		const mesh = new w.THREE.Mesh(new w.THREE.BoxGeometry(1, 1, 1), [
			new w.THREE.MeshStandardMaterial({ name: 'front', map: tex('#ff0000') }),
			new w.THREE.MeshStandardMaterial({ name: 'back', map: tex('#00ff00') })
		]);
		mesh.name = 'twoSlot';
		const geo = mesh.geometry;
		geo.clearGroups();
		const total = geo.index ? geo.index.count : geo.attributes.position.count;
		geo.addGroup(0, total / 2, 0);
		geo.addGroup(total / 2, total / 2, 1);
		g.add(mesh);
		w.objectsGroup.update((v) => v);
	});

	const C = await h.setupPage(browser, 'C');
	await instrument(C, 'C');
	await h.connect(C, A);

	await h.eventually(
		() => sceneOf(C.page),
		(s) => s.count === 5,
		'THE BUG: a multi-material mesh in the scene does not empty a late joiner',
		30000
	);
	const cGot = await sceneOf(C.page);
	h.check(
		cGot.count === 5,
		'C receives all five objects incl. the multi-material one (' + cGot.count + ': ' + cGot.names.join(',') + ')'
	);

	// and the material ARRAY itself must survive the trip
	const cShape = await C.page.evaluate(async () => {
		const w = window.__stores;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const found = g.children.find((o) => o.name === 'twoSlot');
		if (!found) return { found: false };
		const mats = Array.isArray(found.material) ? found.material : found.material ? [found.material] : [];
		return {
			found: true,
			type: found.type,
			isMesh: !!found.isMesh,
			slots: mats.length,
			maps: mats.map((m) => !!(m && m.map)),
			groups: (found.geometry && found.geometry.groups && found.geometry.groups.length) || 0,
			childMeshes: found.children.filter((c) => c.isMesh).length
		};
	});
	console.log('  C twoSlot: ' + JSON.stringify(cShape));
	h.check(cShape.found, 'C has the multi-material object by name');
	h.check(
		cShape.isMesh && cShape.childMeshes === 0,
		'...as ONE mesh, not a Group of per-material children (' + cShape.type + ', ' + cShape.childMeshes + ' child meshes)'
	);
	h.check(
		cShape.slots === 2 && cShape.groups === 2,
		'THE BUG: the material ARRAY and its geometry groups survive (' + cShape.slots + ' slots, ' + cShape.groups + ' groups)'
	);
	h.check(
		cShape.maps && cShape.maps.every(Boolean),
		'...and both slots keep their texture (' + JSON.stringify(cShape.maps) + ')'
	);

	await h.finish(browser);
});

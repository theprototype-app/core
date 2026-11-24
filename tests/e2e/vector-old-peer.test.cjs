// 64-vector row 3 (old peers) + the save / sync rule, across TWO TREES: one peer runs the newest release
// (OLD_APP_URL, a v1.78.0 tree), the other this branch (APP_URL). The release has no vector code at all, so
// what it gets is the additive record riding the ordinary messages — it must see a plain flat mesh (or
// nothing), and never an error:
//   1. the branch places a rectangle and a rounded star (light: the whole mesh), a pen path and a radial
//      ellipse (heavy: the record without triangles; vectorGate WIRE_ARRAY_CAP decides) -> the release holds the light ones as meshes with the
//      branch's vertex count, and (64-extrude) the heavy one too: the release has no `vs` cap, so the mesh follows as a
//      binary `meshgeo` marked vectorFallback; no page error
//   3b. (64-extrude row 6) the branch EXTRUDES the rect with a bevel -> the release gets the solid as a plain mesh (the
//      branch's vertices, the depth's z extent), the branch's own copy is still its record
//   2. the branch edits the rectangle's corner radius (a `geometry` message of an unknown gtype) and unions
//      the star into it (geometry + move + delete) -> the release keeps going: the star is gone, no error
//   3. the release selects the shape (Inspector over an unknown gtype): no error
//   4. two peers + reload: the release reloads and rejoins -> the light shapes come back with their vertices
//   5. a file saved by the branch (buildSessionPayload) opens in the release: light shapes draw, no error
//   6. an old scene (saved by the release: a box, a sphere) loads in the branch unchanged (same objects,
//      same vertex counts)
// Run: OLD_APP_URL=https://theprototype.app:<old port>/ APP_URL=https://theprototype.app:<branch port>/ node tests/e2e/vector-old-peer.test.cjs
// Without OLD_APP_URL it prints a SKIP line (the int battery runs it with the release tree, see the PR).
const h = require('./helpers.cjs');

const OLD_URL = process.env.OLD_APP_URL;

/** a second copy of the helpers whose URL is the old tree's (helpers.cjs reads APP_URL at load) */
function helpersFor(url) {
	const file = require.resolve('./helpers.cjs');
	const keep = process.env.APP_URL;
	const cached = require.cache[file];
	delete require.cache[file];
	process.env.APP_URL = url;
	const copy = require(file);
	process.env.APP_URL = keep;
	require.cache[file] = cached;
	return copy;
}

/** every mesh by uuid: {name, verts, gtype} (any build: no vector code needed) */
const meshes = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		/** @type {Record<string, any>} */
		const out = {};
		g?.traverse((o) => {
			if (!o.isMesh || o === g) return;
			o.geometry?.computeBoundingBox?.();
			const b = o.geometry?.boundingBox;
			out[o.uuid] = { name: o.name, verts: o.geometry?.attributes?.position?.count ?? 0, gtype: o.userData?.geometryParams?.gtype ?? null, zext: b && Number.isFinite(b.max.z) ? b.max.z - b.min.z : 0 };
		});
		return out;
	});
const errorsOf = (peer) => [...(peer.page.__errors ?? [])];

h.run(async () => {
	if (!OLD_URL) {
		console.log('SKIP: OLD_APP_URL not set (a v1.78.0 tree; see the 64-vector PR)');
		return;
	}
	const hOld = helpersFor(OLD_URL);
	const browser = await h.launch();
	const L = await h.setupPage(browser, 'L'); // this branch
	const O = await hOld.setupPage(browser, 'O'); // the newest release
	h.check(
		await O.page.evaluate(() => !window.__tp.test.v1.geometryParams?.GEOMETRY_PARAMS?.Vector),
		'premise: the old peer has no Vector geometry type'
	);
	await h.connect(O, L);

	// ---- 1. four shapes, light and heavy -----------------------------------------------------------
	const made = await L.page.evaluate(async () => {
		const v = window.__tp.test.v1.vectorActions;
		const rect = v.placeVectorShape('rect', [-2, 0, 0]);
		// the star overlaps the rect IN ITS PLANE (same turn, 0.4 m along its +X), or a union refuses it
		const at = rect.position.clone().add(new rect.position.constructor(0.4, 0.1, 0).applyQuaternion(rect.quaternion));
		const star = v.addVectorShape({ ...window.__tp.test.v1.vectorRecord.vectorDefaults('star'), corner: 0.05 }, { position: at, quaternion: rect.quaternion });
		const pen = v.addVectorShape(
			{ kind: 'path', paths: [{ closed: false, nodes: [{ x: 0, y: 0, ix: 0, iy: 0, ox: 0.3, oy: 0.4 }, { x: 1, y: 0, ix: -0.3, iy: 0.4, ox: 0, oy: 0 }] }], strokeWidth: 0.04, fillType: 'none' },
			{ position: [1, 0.5, 0], name: 'Pen line' }
		);
		const heavy = v.placeVectorShape('ellipse', [2.5, 0, 0], { width: 1.4, height: 0.7, fillType: 'radial', fill: '#ffffff', fill2: '#0044ff' });
		return { rect: rect.uuid, star: star.uuid, pen: pen.uuid, heavy: heavy.uuid };
	});
	const mine = await meshes(L);
	// light = every attribute array within vectorGate's WIRE_ARRAY_CAP (the whole mesh rides); heavy = the record only
	const cap = await L.page.evaluate(() => window.__tp.test.v1.vectorGate.WIRE_ARRAY_CAP);
	const light = (k) => mine[made[k]].verts * 3 <= cap;
	h.check(light('rect') && light('star') && !light('heavy'), `1. premise: rect and star are light, the ellipse heavy (cap ${cap} numbers per array)`);
	for (const k of ['rect', 'star', 'pen', 'heavy'])
		await h.eventually(
			() => meshes(O),
			(m) => !!m[made[k]] && m[made[k]].verts === mine[made[k]].verts && m[made[k]].verts > 0,
			`1. the release holds the ${k} as a plain mesh with the branch's ${mine[made[k]].verts} vertices (${light(k) ? 'light: the whole mesh' : 'heavy: the vectorFallback meshgeo'})`,
			20000
		);
	h.check(errorsOf(O).length === 0, `1. no page error on the release (${errorsOf(O).join(' | ') || 'none'})`);

	// ---- 2. a geometry edit of an unknown gtype, then a boolean --------------------------------------
	await L.page.evaluate((uuid) => window.__tp.test.v1.vectorActions.setVectorParams(uuid, { corner: 0.2 }), made.rect);
	await O.page.waitForTimeout(1500);
	const unioned = await L.page.evaluate(async ({ rect, star }) => window.__tp.test.v1.vectorOps.combineShapes('union', [rect, star]), made);
	h.check(unioned === made.rect, '2. premise: the branch unions the star into the rect');
	await h.eventually(() => meshes(O), (m) => !m[made.star] && !!m[made.rect], '2. after the union the release dropped the star and kept the subject', 20000);
	h.check(errorsOf(O).length === 0, `2. no page error on the release after a Vector geometry edit + union (${errorsOf(O).join(' | ') || 'none'})`);

	// ---- 3. the release selects the shape: the Inspector over an unknown gtype ------------------------
	await O.page.evaluate((uuid) => window.__tp.test.v1.objectActions.selectObject(uuid, true), made.rect);
	await O.page.waitForTimeout(1500);
	h.check(errorsOf(O).length === 0, `3. the release selects and inspects the shape with no error (${errorsOf(O).join(' | ') || 'none'})`);
	await O.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject?.());

	// ---- 3b. 64-extrude: the branch extrudes the rect -> the release gets the solid as a plain mesh ---
	await L.page.evaluate((uuid) => window.__tp.test.v1.vectorActions.setVectorParams(uuid, { depth: 0.3, bevel: 0.03 }), made.rect);
	const solid = (await meshes(L))[made.rect];
	h.check(solid.gtype === 'Vector' && Math.abs(solid.zext - 0.3) < 1e-3, `3b. premise: the branch's rect is a 30 cm solid, still its record (z ${solid.zext.toFixed(3)})`);
	await h.eventually(
		() => meshes(O),
		(m) => !!m[made.rect] && m[made.rect].verts === solid.verts && Math.abs(m[made.rect].zext - 0.3) < 1e-3,
		`3b. the release gets the solid as a plain mesh (the branch's ${solid.verts} vertices, 30 cm deep)`,
		20000
	);
	const fallback = await L.page.evaluate(() => window.__tp.test.v1.vectorOldPeers.oldPeerDebug());
	h.check(fallback.sent >= 1 && fallback.oldPeers.length === 1, `3b. the mesh went to the one peer without the vs cap (${JSON.stringify(fallback)})`);
	h.check(errorsOf(O).length === 0, `3b. no page error on the release (${errorsOf(O).join(' | ') || 'none'})`);

	// ---- 4. two peers + reload: the release reloads and rejoins --------------------------------------
	const branchNow = await meshes(L);
	await O.page.reload({ waitUntil: 'domcontentloaded' });
	await O.page.waitForFunction(() => !!window.__tp?.test?.v1?.peers, null, { timeout: 150000 });
	await h.eventually(
		() =>
			O.page.evaluate(() => {
				let p;
				window.__tp.test.v1.peers.subscribe((v) => (p = v))();
				return Object.values(p?.connections ?? {}).some((c) => c?.open);
			}),
		(v) => v === true,
		'4. the release rejoined after its reload (premise)',
		90000
	);
	for (const k of ['rect', 'pen', 'heavy']) {
		const want = branchNow[made[k]].verts;
		await h.eventually(
			() => meshes(O),
			(m) => !!m[made[k]] && m[made[k]].verts === want,
			`4. ...and holds the ${k} again with the branch's ${want} vertices (${want * 3 <= cap ? 'light' : 'heavy: the vectorFallback at join'})`,
			60000
		);
	}
	h.check(errorsOf(O).length === 0, `4. no page error on the release after the rejoin (${errorsOf(O).join(' | ') || 'none'})`);

	// ---- 5. a file saved by the branch opens in the release ------------------------------------------
	// at most three pages at once from here: a fourth boot on a loaded box passed setupPage's 90 s (day1c)
	await O.page.context().close();
	const saved = await L.page.evaluate(() => JSON.parse(JSON.stringify(window.__tp.test.v1.sessions.buildSessionPayload('vector-old-peer', { thumbnail: false }))));
	const P = await hOld.setupPage(browser, 'P'); // a release page on its own (no session)
	await P.page.evaluate(async (payload) => window.__tp.test.v1.sessions.applySession(payload, { backup: false, replicate: false, quiet: true }), saved);
	await h.eventually(
		() => meshes(P),
		(m) => ['rect', 'pen', 'heavy'].every((k) => !!m[made[k]] && m[made[k]].verts === branchNow[made[k]].verts && m[made[k]].verts > 0),
		'5. the branch-saved scene opens in the release: every shape draws as a plain mesh with the branch\'s vertices (a file carries the triangles)',
		30000
	);
	h.check(errorsOf(P).length === 0, `5. no page error opening the branch file in the release (${errorsOf(P).join(' | ') || 'none'})`);
	await P.page.context().close();

	// ---- 6. an old scene loads in the branch unchanged ------------------------------------------------
	const Q = await hOld.setupPage(browser, 'Q'); // a release page on its own: a box and a sphere, saved there
	await Q.page.evaluate(() => {
		const c = window.__tp.test.v1.commandsHandler;
		c.sceneCommand('/create Box 1 1 1');
		c.sceneCommand('/create Sphere');
	});
	await h.eventually(() => meshes(Q), (m) => Object.keys(m).length >= 2, '6. premise: the release made an old scene (a box and a sphere)', 20000);
	const oldMeshes = await meshes(Q);
	const oldFile = await Q.page.evaluate(() => JSON.parse(JSON.stringify(window.__tp.test.v1.sessions.buildSessionPayload('old-scene', { thumbnail: false }))));
	await Q.page.context().close();
	const R = await h.setupPage(browser, 'R'); // a branch page on its own
	await R.page.evaluate(async (payload) => window.__tp.test.v1.sessions.applySession(payload, { backup: false, replicate: false, quiet: true }), oldFile);
	await h.eventually(
		() => meshes(R),
		(m) => Object.keys(oldMeshes).every((u) => m[u] && m[u].verts === oldMeshes[u].verts),
		`6. the old scene loads in the branch unchanged (${Object.keys(oldMeshes).length} objects, same vertex counts)`,
		30000
	);
	const loaded = await meshes(R);
	h.check(
		Object.keys(oldMeshes).every((u) => loaded[u]?.gtype === oldMeshes[u].gtype && loaded[u]?.name === oldMeshes[u].name),
		'6. ...same names and geometry types'
	);
	h.check(errorsOf(R).length === 0 && errorsOf(L).length === 0, `6. no page error on the branch (${[...errorsOf(R), ...errorsOf(L)].join(' | ') || 'none'})`);

	await browser.close();
});

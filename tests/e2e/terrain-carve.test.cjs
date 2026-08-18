// 21-C3 — CONFORM A TERRAIN TO A SPLINE (the carve).
//
// `carveAlongSpline` is PURE and the CALLER commits (the uvUnwrap backend shape),
// so the first half runs with NO browser at all: build a terrain grid and a spline
// record by hand, call the function, and assert the geometry. Every interesting
// claim about a carve is geometric — "inside the width lands on the curve", "beyond
// the shoulder is unchanged BIT FOR BIT", "the vertex order cannot matter" — and
// none of it needs a GL context.
//
// The second half is the app: both entry points, the single meshgeo commit, one undo,
// a peer rebuilding the same bed, and the triangle-sanity checks that the first
// version of this suite went without (see the commit that added them).
//
// The lap/checkpoint coverage that used to live here went with roadGates.js to the
// race module: checkpoints and a quadrant anti-cheat are racing rules, not core.
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const libPath = (name) => path.join(__dirname, '..', '..', 'src', 'lib', name);

h.run(async () => {
	// ============================================ 1. the pure carve (no browser)
	const THREE = await import('three');
	const carve = await import(pathToFileURL(libPath('terrainCarve.js')).href);

	/** a flat terrain grid, exactly as terrainGeometry builds one */
	const makeTerrain = (size, segments, height = 0) => {
		const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
		geometry.rotateX(-Math.PI / 2);
		if (height) {
			const p = geometry.attributes.position;
			// a deterministic slope, so "unchanged" means something
			for (let i = 0; i < p.count; i++) p.setY(i, height * (p.getX(i) / size + p.getZ(i) / size));
		}
		const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
		mesh.userData.terrain = true;
		mesh.userData.geometryParams = { gtype: 'Terrain', params: { size, segments } };
		return mesh;
	};

	// a straight road down the middle at y = 2, so every claim has an exact answer
	const straight = {
		points: [
			{ pos: [-10, 2, 0], radius: 3 },
			{ pos: [0, 2, 0], radius: 3 },
			{ pos: [10, 2, 0], radius: 3 }
		],
		closed: false
	};

	const terrain = makeTerrain(24, 24, 4);
	const baseline = Array.from(terrain.geometry.attributes.position.array);
	const carved = carve.carveAlongSpline(terrain, straight, {
		width: 6,
		shoulder: 3,
		mode: 'flatten',
		clearance: 0
	});
	h.check(!!carved && carved.length === baseline.length, 'carveAlongSpline returns a full position array');
	h.check(
		Array.from(terrain.geometry.attributes.position.array).every((v, i) => v === baseline[i]),
		'it is PURE — the terrain it was handed is untouched, so the caller decides what to commit'
	);

	// inside width/2 of the centre line, every vertex must sit ON the road height
	let insideWorst = 0;
	let insideCount = 0;
	let outsideChanged = 0;
	let outsideCount = 0;
	let bandCount = 0;
	for (let i = 0; i < baseline.length; i += 3) {
		const x = carved[i];
		const z = carved[i + 2];
		const y = carved[i + 1];
		if (Math.abs(x) > 9) continue; // clear of the road's open ends
		const d = Math.abs(z);
		if (d <= 3 - 1e-6) {
			insideCount++;
			insideWorst = Math.max(insideWorst, Math.abs(y - 2));
		} else if (d >= 6 + 1e-6) {
			outsideCount++;
			if (y !== baseline[i + 1]) outsideChanged++;
		} else bandCount++;
	}
	h.check(insideCount > 20 && outsideCount > 100 && bandCount > 10, `PREMISE: the grid has vertices in all three zones (${insideCount} road, ${bandCount} shoulder, ${outsideCount} outside)`);
	h.check(
		insideWorst < 1e-5,
		`every vertex inside width/2 lands on the curve height (worst error ${insideWorst.toExponential(1)}m)`
	);
	h.check(
		outsideChanged === 0,
		`every vertex beyond width/2 + shoulder is unchanged BIT FOR BIT (${outsideChanged} of ${outsideCount} moved)`
	);

	// the shoulder is a BLEND, not a cliff: the band must hold intermediate values
	let partial = 0;
	for (let i = 0; i < baseline.length; i += 3) {
		const d = Math.abs(carved[i + 2]);
		if (Math.abs(carved[i]) > 9 || d <= 3 || d >= 6) continue;
		const moved = Math.abs(carved[i + 1] - baseline[i + 1]);
		const full = Math.abs(2 - baseline[i + 1]);
		if (moved > 1e-6 && moved < full - 1e-6) partial++;
	}
	h.check(partial > 5, `the shoulder blends rather than steps (${partial} partially-moved vertices)`);

	// ORDER INDEPENDENCE: the hash grid must not make the result depend on the
	// order vertices happen to be visited in, or two peers carving the same road
	// could differ. Feed a terrain whose vertices are shuffled and compare the
	// (x, z) -> y field.
	const shuffled = makeTerrain(24, 24, 4);
	const sp = shuffled.geometry.attributes.position;
	const triples = [];
	for (let i = 0; i < sp.count; i++) triples.push([sp.getX(i), sp.getY(i), sp.getZ(i)]);
	// a deterministic reversal is enough: it is a DIFFERENT visit order
	triples.reverse();
	triples.forEach((t, i) => sp.setXYZ(i, t[0], t[1], t[2]));
	const carvedShuffled = carve.carveAlongSpline(shuffled, straight, { width: 6, shoulder: 3 });
	const fieldOf = (arr) => {
		const map = new Map();
		for (let i = 0; i < arr.length; i += 3) map.set(arr[i] + ',' + arr[i + 2], arr[i + 1]);
		return map;
	};
	const a = fieldOf(carved);
	const b = fieldOf(carvedShuffled);
	let mismatched = 0;
	for (const [key, y] of a) if (b.get(key) !== y) mismatched++;
	h.check(
		a.size === b.size && mismatched === 0,
		`two vertex ITERATION ORDERS give the identical height field (${a.size} columns, ${mismatched} mismatched)`
	);

	// modes: 'lower' only cuts, 'raise' only fills. On a terrain that is BELOW the
	// road on one side and above it on the other, that is a real distinction.
	const lowered = carve.carveAlongSpline(terrain, straight, { width: 6, shoulder: 3, mode: 'lower' });
	const raised = carve.carveAlongSpline(terrain, straight, { width: 6, shoulder: 3, mode: 'raise' });
	let loweredRose = 0;
	let raisedFell = 0;
	let loweredCut = 0;
	let raisedFilled = 0;
	for (let i = 1; i < baseline.length; i += 3) {
		if (lowered[i] > baseline[i] + 1e-6) loweredRose++;
		if (lowered[i] < baseline[i] - 1e-6) loweredCut++;
		if (raised[i] < baseline[i] - 1e-6) raisedFell++;
		if (raised[i] > baseline[i] + 1e-6) raisedFilled++;
	}
	h.check(loweredRose === 0 && loweredCut > 0, `'lower' only ever cuts (${loweredCut} cut, ${loweredRose} raised)`);
	h.check(raisedFell === 0 && raisedFilled > 0, `'raise' only ever fills (${raisedFilled} filled, ${raisedFell} cut)`);

	// clearance sinks the bed below the road surface by exactly that much
	const sunk = carve.carveAlongSpline(terrain, straight, { width: 6, shoulder: 3, clearance: 0.5 });
	let clearanceWorst = 0;
	for (let i = 0; i < baseline.length; i += 3)
		if (Math.abs(sunk[i]) <= 9 && Math.abs(sunk[i + 2]) <= 3 - 1e-6)
			clearanceWorst = Math.max(clearanceWorst, Math.abs(sunk[i + 1] - 1.5));
	h.check(clearanceWorst < 1e-5, `clearance sinks the bed by exactly that much (worst ${clearanceWorst.toExponential(1)}m)`);

	// the frame conversion: a road parked away from the origin carves where it IS.
	// Without splineInFrameOf the record's own coordinates would be used verbatim
	// and the carve would land at the origin — a plausible-looking road in the
	// wrong place, which is the failure this guards.
	const offRoad = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
	offRoad.userData.spline = straight;
	offRoad.position.set(0, 0, 8);
	const flat = makeTerrain(24, 24, 0);
	const inFrame = carve.splineInFrameOf(offRoad, flat);
	h.check(
		!!inFrame && Math.abs(inFrame.points[1].pos[2] - 8) < 1e-6,
		`splineInFrameOf carries the road's transform into the terrain's frame (z ${inFrame?.points?.[1]?.pos?.[2]})`
	);
	const shifted = carve.carveAlongSpline(flat, inFrame, { width: 6, shoulder: 3 });
	const rawFrame = carve.carveAlongSpline(flat, straight, { width: 6, shoulder: 3 });
	const meanZOfMoved = (arr) => {
		let sum = 0;
		let n = 0;
		for (let i = 0; i < arr.length; i += 3)
			if (Math.abs(arr[i + 1]) > 1e-6) {
				sum += arr[i + 2];
				n++;
			}
		return n ? sum / n : NaN;
	};
	// (the mean sits a little short of 8 rather than on it, because the tile ends at
	// z = 12 and clips the far shoulder — so the claim is WHICH BAND moved, not its
	// exact centroid)
	h.check(
		meanZOfMoved(shifted) > 5 && Math.abs(meanZOfMoved(rawFrame)) < 1,
		`COUNTERFACTUAL: the converted record carves the band at z=8 (mean ${meanZOfMoved(shifted).toFixed(2)}) where the raw one carves at the origin (mean ${meanZOfMoved(rawFrame).toFixed(2)})`
	);

	// ==================================================== 2. the app: commit + peers
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const built = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create Terrain 24 24');
		await new Promise((r) => setTimeout(r, 700));
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const terrain = group.children.find((c) => c.userData?.terrain);
		// give it hills, so a flattened bed is a visible change
		w.geometryEdit.applyGeometry(terrain.uuid, { amplitude: 5, seed: 9, frequency: 0.07 });
		await new Promise((r) => setTimeout(r, 400));
		// a road across it, built through the real spline path
		const road = w.splineTool.createSplineMesh({
			points: [
				{ pos: [-11, 3, 0], radius: 2 },
				{ pos: [0, 3, 2], radius: 2 },
				{ pos: [11, 3, 0], radius: 2 }
			],
			closed: false,
			color: '#333333'
		});
		group.add(road);
		w.objectsGroup.update((v) => v);
		const peer = await new Promise((r) => w.peers.subscribe(r)());
		peer?.send({ type: 'object', element: road.toJSON() });
		return { terrain: terrain.uuid, road: road.uuid };
	});
	await A.page.waitForTimeout(1200);
	h.check(!!built.terrain && !!built.road, 'PREMISE: a hilly terrain and a road across it');

	const surfaceOf = (page, uuid) =>
		page.evaluate(
			(id) =>
				new Promise((r) =>
					window.__stores.objectsGroup.subscribe((g) => {
						const mesh = g.getObjectByProperty('uuid', id);
						if (!mesh) return r(null);
						const p = mesh.geometry.attributes.position;
						let hash = 2166136261;
						for (let i = 0; i < p.count; i++)
							for (const v of [p.getX(i), p.getY(i), p.getZ(i)]) {
								const bits = new Uint32Array(new Float32Array([v]).buffer)[0];
								hash = Math.imul(hash ^ (bits & 0xffff), 16777619);
								hash = Math.imul(hash ^ (bits >>> 16), 16777619);
							}
						const idx = mesh.geometry.index;
						const tris = Math.floor((idx ? idx.count : p.count) / 3);
						let worstEdge = 0;
						for (let t = 0; t < tris; t++) {
							const c = [0, 1, 2].map((k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k));
							for (const [i, j] of [[c[0], c[1]], [c[1], c[2]], [c[2], c[0]]])
								worstEdge = Math.max(
									worstEdge,
									Math.hypot(p.getX(i) - p.getX(j), p.getY(i) - p.getY(j), p.getZ(i) - p.getZ(j))
								);
						}
						r({ hash: hash >>> 0, verts: p.count, indexed: !!idx, worstEdge });
					})()
				),
			uuid
		);

	// the objectMenu offers the carve on a spline, in TERRAIN vocabulary
	const menu = await A.page.evaluate((uuid) => {
		// (uuid FIRST, opts second — passing one object silently builds a menu for
		// "no object", which has no carve entry and would read as a green check)
		const items = window.__stores.objectMenu.buildObjectMenuItems(uuid, { selection: [uuid] });
		const labels = items.map((i) => i.label ?? '');
		const carve = items.find((i) => /Flatten terrain/i.test(i.label ?? ''));
		return {
			hasCarve: !!carve,
			flat: !!carve && !carve.children,
			// the SCOPE decision, asserted rather than trusted: a spline in a scene with
			// no racing game must not sprout racing vocabulary. Core owns the terrain
			// operation; laps and checkpoints belong to the race module.
			gameWords: labels.filter((l) => /road|lap|checkpoint|gate/i.test(l))
		};
	}, built.road);
	h.check(menu.hasCarve, 'the shared object menu offers the carve on a spline');
	h.check(menu.flat, 'one terrain in the scene means ONE flat entry, not a submenu to open');
	h.check(
		menu.gameWords.length === 0,
		`and no game vocabulary rides along in core (${menu.gameWords.join(', ') || 'none'})`
	);

	const commit = await A.page.evaluate(
		async ([roadUuid, terrainUuid]) => {
			const w = window.__stores;
			const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const terrain = group.getObjectByProperty('uuid', terrainUuid);
			const before = Array.from(terrain.geometry.attributes.position.array);
			const depth = await new Promise((r) => w.history.undoStack.subscribe((s) => r(s.length))());
			const peer = await new Promise((r) => w.peers.subscribe(r)());
			/** @type {any[]} */
			const seen = [];
			const send = peer.send.bind(peer); // PASS-THROUGH spy
			peer.send = (m) => {
				seen.push(typeof m === 'string' ? 'command' : m?.type);
				return send(m);
			};
			const ok = w.carveActions.carveTerrainAlong(roadUuid, terrainUuid);
			peer.send = send;
			await new Promise((r) => setTimeout(r, 300));
			const after = Array.from(terrain.geometry.attributes.position.array);
			// count by COLUMN, not by buffer index: the commit changes the terrain from
			// an indexed grid to a triangle soup, so comparing arrays position-by-position
			// compares different vertices (and reads past the end of the shorter one).
			const columns = (arr) => {
				const map = new Map();
				for (let i = 0; i < arr.length; i += 3) map.set(arr[i] + ',' + arr[i + 2], arr[i + 1]);
				return map;
			};
			const wasCol = columns(before);
			const isCol = columns(after);
			let moved = 0;
			for (const [key, y] of isCol) if (Math.abs((wasCol.get(key) ?? y) - y) > 1e-6) moved++;
			// TRIANGLE SANITY, which is the check this suite shipped without and paid
			// for: the meshgeo channel carries a triangle SOUP, so a carve that hands
			// applyMeshGeo an INDEXED terrain's positions leaves a non-indexed mesh
			// with the indexed count — 625 vertices, not even divisible by 3 — and
			// three draws 208 arbitrary triangles plus a fragment. The mesh shatters
			// on screen while every buffer-level metric (count unchanged, both peers
			// agreeing, one message, one undo entry) stays perfectly green.
			// On a 24-segment 24m tile the lattice pitch is 1m, so no triangle edge
			// may exceed the diagonal by much; a shattered soup joins vertices metres
			// apart. (The e2e skill says it plainly: watertightness/edge sanity is the
			// best check for any op that rebuilds geometry.)
			const worstEdge = (geo) => {
				const p = geo.attributes.position;
				const idx = geo.index;
				const tris = Math.floor((idx ? idx.count : p.count) / 3);
				let worst = 0;
				for (let t = 0; t < tris; t++) {
					const corners = [0, 1, 2].map((k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k));
					for (const [i, j] of [
						[corners[0], corners[1]],
						[corners[1], corners[2]],
						[corners[2], corners[0]]
					])
						worst = Math.max(
							worst,
							Math.hypot(p.getX(i) - p.getX(j), p.getY(i) - p.getY(j), p.getZ(i) - p.getZ(j))
						);
				}
				return worst;
			};
			return {
				ok,
				moved,
				verts: terrain.geometry.attributes.position.count,
				beforeVerts: before.length / 3,
				indexed: !!terrain.geometry.index,
				worstEdge: worstEdge(terrain.geometry),
				meshgeo: seen.filter((t) => t === 'meshgeo').length,
				entries: (await new Promise((r) => w.history.undoStack.subscribe((s) => r(s.length))())) - depth,
				kind: await new Promise((r) => w.history.undoStack.subscribe((s) => r(s[s.length - 1]?.kind))())
			};
		},
		[built.road, built.terrain]
	);
	h.check(commit.ok && commit.moved > 20, `the carve commits and moves the bed (${commit.moved} vertices)`);
	h.check(
		commit.verts % 3 === 0 && commit.verts === 24 * 24 * 2 * 3,
		`the terrain comes out as a proper triangle SOUP — 2 tris per cell, 3 vertices each (${commit.verts} vertices, divisible by 3: ${commit.verts % 3 === 0})`
	);
	h.check(
		Number.isFinite(commit.worstEdge) && commit.worstEdge < 3,
		`and it is still a SURFACE: no triangle edge exceeds the 1m lattice by much (worst ${commit.worstEdge?.toFixed?.(2) ?? commit.worstEdge}m — a shattered soup reads tens of metres, or NaN on the trailing fragment)`
	);
	h.check(commit.meshgeo === 1, `ONE meshgeo message (${commit.meshgeo})`);
	h.check(
		commit.entries === 1 && commit.kind === 'meshgeo',
		`and ONE undo entry, of the existing meshgeo kind (${commit.entries} x ${commit.kind})`
	);

	// THE ENTRY POINT the user actually reached for (reported): a road's Properties.
	// The context menu is not the only place someone looks for "what can this road
	// do", so the Spline section carries the same carve — driven here through the
	// real button, not the store behind it.
	await A.page.evaluate((uuid) => {
		localStorage.setItem('inspector:sec:Spline', 'open');
		window.__stores.objectActions.selectObject(uuid, true);
	}, built.road);
	await h.eventually(
		() =>
			A.page.evaluate(() => ({
				button: !!document.querySelector('#spline-carve-0'),
				label: document.querySelector('#spline-carve-0')?.textContent?.trim() ?? '',
				none: !!document.querySelector('#spline-carve-none')
			})),
		(d) => d.button && !d.none,
		'the spline Properties offer the same carve, naming the terrain',
		20000
	);
	const beforeProps = await surfaceOf(A.page, built.terrain);
	const depthBefore = await A.page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	);
	// the toast text, which is the only thing that distinguishes "this click did
	// nothing yet" from "this click found the bed already flat" — without it the
	// idempotence check below passes VACUOUSLY, which is exactly what it did while
	// racing a ~1.2s cold dynamic import of carveActions
	// scan the WHOLE stack, never just the last entry: this box emits peer-server
	// toasts ("Lost connection… reconnecting") throughout a run, so the newest toast
	// is regularly not the one the click produced
	const carveToast = () =>
		A.page.evaluate(
			() =>
				new Promise((r) =>
					window.__stores.toastStore.subscribe((t) => {
						const texts = t.map((entry) => (typeof entry === 'string' ? entry : (entry?.text ?? '')));
						r(texts.filter((text) => /Carved \d+ vertices|already carved|not under this road/i.test(text)).pop() ?? '');
					})()
				)
		);
	// clear the stack first: the earlier carve left its own "Carved N vertices" toast,
	// which would satisfy the wait below without the button ever running
	await A.page.evaluate(() => window.__stores.toastStore.set([]));
	// stash the height FIELD too, because the second pass has to be measured the same
	// way the first was: the toast counts VERTICES, and the first commit turned 625
	// indexed vertices into a 3456 soup, so comparing its 876 against the first pass's
	// 251 COLUMNS compares two units and reads as divergence when nothing diverged.
	const columnDiff = (page, uuid, stash) =>
		page.evaluate(
			([id, store]) =>
				new Promise((r) =>
					window.__stores.objectsGroup.subscribe((g) => {
						const p = g.getObjectByProperty('uuid', id).geometry.attributes.position;
						const field = new Map();
						for (let i = 0; i < p.count; i++) field.set(p.getX(i) + ',' + p.getZ(i), p.getY(i));
						const previous = window[store];
						window[store] = field;
						if (!previous) return r({ columns: field.size, changed: null });
						let changed = 0;
						for (const [key, y] of field) if (Math.abs((previous.get(key) ?? y) - y) > 1e-6) changed++;
						r({ columns: field.size, changed });
					})()
				),
			[uuid, stash]
		);
	await columnDiff(A.page, built.terrain, '__carveField'); // seeds the stash
	await A.page.evaluate(() => document.querySelector('#spline-carve-0').click());
	// wait on the OUTCOME, not a clock: the first click through either entry point
	// pays a cold dynamic import of carveActions (~1.2s in dev), and a fixed sleep here
	// let this whole section pass while nothing had run yet
	await h.eventually(
		carveToast,
		(text) => /Carved \d+ vertices|already carved/i.test(text),
		'the Properties button really carves (its own toast reports the commit)',
		25000
	);
	const secondToast = await carveToast();
	const afterProps = await surfaceOf(A.page, built.terrain);
	const depthAfter = await A.page.evaluate(
		() => new Promise((r) => window.__stores.history.undoStack.subscribe((s) => r(s.length))())
	);
	h.check(
		afterProps.verts % 3 === 0 && afterProps.worstEdge < 3,
		`and leaves the surface intact (${afterProps.verts} vertices, worst edge ${afterProps.worstEdge.toFixed(2)}m)`
	);
	// A REPEAT CARVE IS NOT A NO-OP, and it should not claim to be: the road bed is
	// already at the curve, but the shoulder is a partial blend, so carving again
	// pulls it FURTHER toward the bed. What must hold is CONVERGENCE — each pass moves
	// strictly fewer columns than the last, by a smaller amount — and that the pass is
	// honestly recorded as its own edit rather than a silent no-op entry.
	const secondPass = await columnDiff(A.page, built.terrain, '__carveField');
	h.check(
		!!secondToast,
		`the carve reported itself to the user ("${secondToast.slice(0, 48)}")`
	);
	h.check(
		secondPass.changed > 0 && secondPass.changed < commit.moved,
		`a repeat carve CONVERGES rather than diverging — measured in the same unit both times (${commit.moved} columns first, ${secondPass.changed} the second time)`
	);
	h.check(
		depthAfter === depthBefore + 1 && beforeProps.hash !== afterProps.hash,
		`and it is recorded as one real edit, not a phantom no-op (${depthAfter - depthBefore} entry)`
	);

	const carvedA = await surfaceOf(A.page, built.terrain);
	await h.eventually(
		() => surfaceOf(B.page, built.terrain),
		(t) => t?.hash === carvedA.hash,
		'B has the identical carved terrain (the meshgeo channel, nothing new)'
	);

	await A.page.keyboard.press('Control+z');
	await A.page.waitForTimeout(900);
	const undone = await surfaceOf(A.page, built.terrain);
	h.check(undone.hash !== carvedA.hash, 'ONE undo puts the hills back');
	await h.eventually(
		() => surfaceOf(B.page, built.terrain),
		(t) => t?.hash === undone.hash,
		'and the undo reaches B as well'
	);
	await A.page.keyboard.press('Control+y');
	await A.page.waitForTimeout(900);

	await h.finish(browser);
});

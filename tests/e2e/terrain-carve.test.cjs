// 21-C3/C4 — CARVE A ROAD BED, and the gates derived from the same spline.
//
// `carveAlongSpline` is PURE and the CALLER commits (the uvUnwrap backend shape),
// so the first half runs with NO browser at all: build a terrain grid and a spline
// record by hand, call the function, and assert the geometry. Every interesting
// claim about a carve is geometric — "inside the road lands on the curve", "beyond
// the shoulder is unchanged BIT FOR BIT", "the vertex order cannot matter" — and
// none of it needs a GL context.
//
// The second half is the app: the objectMenu entry, the single meshgeo commit, one
// undo, and a peer rebuilding the same bed. Plus C4's gates, whose whole point is
// that they are DERIVED — so the check that matters is that every peer computes
// the same list from the replicated record with nothing sent.
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const libPath = (name) => path.join(__dirname, '..', '..', 'src', 'lib', name);

h.run(async () => {
	// ============================================ 1. the pure carve (no browser)
	const THREE = await import('three');
	const carve = await import(pathToFileURL(libPath('terrainCarve.js')).href);
	const gates = await import(pathToFileURL(libPath('roadGates.js')).href);

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

	// ------------------------------------------------ C4, still without a browser
	const loop = {
		points: [
			{ pos: [10, 1, 0], radius: 2 },
			{ pos: [0, 1, 10], radius: 2 },
			{ pos: [-10, 1, 0], radius: 2 },
			{ pos: [0, 1, -10], radius: 2 }
		],
		closed: true
	};
	const road = { userData: { spline: loop } };
	const six = gates.checkpointsFor(road, 6);
	h.check(six.length === 6, `checkpointsFor returns the count asked for (${six.length})`);
	h.check(
		six.every((g) => g.width === 4),
		'each gate spans the road (the tube diameter at that point)'
	);
	// ARC LENGTH is the claim, and it needs the counterfactual to mean anything: on
	// a spline with UNEVEN spans, `getPointAt` spaces gates evenly along the tarmac
	// while `getPoint` (parameter-spaced, which is what a naive implementation
	// reaches for) crowds them into the short spans. Two short spans and one long
	// one is the adversarial input; on the smooth loop above BOTH would look fine.
	const splineTube = await import(pathToFileURL(libPath('splineTube.js')).href);
	const uneven = {
		points: [
			{ pos: [0, 1, 0], radius: 2 },
			{ pos: [2, 1, 0], radius: 2 },
			{ pos: [20, 1, 0], radius: 2 },
			{ pos: [22, 1, 0], radius: 2 }
		],
		closed: false
	};
	const unevenCurve = splineTube.splineCurve(uneven);
	const N = 8;
	const chordsOf = (/** @type {number[][]} */ pts) =>
		pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[2] - pts[i][2]));
	const arcChords = chordsOf(gates.checkpointsFor({ userData: { spline: uneven } }, N).map((g) => g.position));
	const paramChords = chordsOf(
		Array.from({ length: N }, (_, i) => unevenCurve.getPoint(i / (N - 1))).map((p) => [p.x, p.y, p.z])
	);
	const ratio = (/** @type {number[]} */ c) => Math.max(...c) / Math.max(Math.min(...c), 1e-9);
	h.check(
		ratio(arcChords) < 1.3,
		`gates are evenly spaced ALONG THE TARMAC on an uneven spline (longest/shortest gap ${ratio(arcChords).toFixed(2)})`
	);
	h.check(
		ratio(paramChords) > 3,
		`COUNTERFACTUAL: parameter spacing on the same spline is ${ratio(paramChords).toFixed(1)}x uneven — which is the bug getPointAt avoids`
	);
	h.check(
		gates.checkpointsFor(road, 6).every((g, i) => g.u === six[i].u),
		'the list is DERIVED: the same record gives the same gates every time (no messages needed)'
	);

	// lap counting: progress plus quadrant flags, never gate order
	const lap = gates.newLapState();
	let lapped = 0;
	for (let step = 0; step <= 40; step++) {
		const u = (step % 40) / 40;
		const point = { u, quadrant: Math.min(Math.floor(u * 4), 3) };
		if (gates.trackLap(lap, point).lapped) lapped++;
	}
	h.check(lapped === 1 && lap.laps === 1, `one full circuit counts one lap (${lap.laps})`);

	// the anti-cheat: nudging back and forth over the line must never count
	const cheat = gates.newLapState();
	let cheated = 0;
	for (let i = 0; i < 30; i++) {
		const u = i % 2 ? 0.99 : 0.01;
		if (gates.trackLap(cheat, { u, quadrant: u > 0.5 ? 3 : 0 }).lapped) cheated++;
	}
	h.check(
		cheated === 0 && cheat.laps === 0,
		`reversing over the finish line farms nothing (${cheat.laps} laps from 30 crossings)`
	);
	// and the honest half: a real lap after the cheating still counts
	const after = gates.newLapState();
	for (let step = 0; step <= 40; step++) {
		const u = (step % 40) / 40;
		gates.trackLap(after, { u, quadrant: Math.min(Math.floor(u * 4), 3) });
	}
	h.check(after.laps === 1, 'PREMISE: the tracker does count a legitimate lap, so the check above is not vacuous');

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

	// the objectMenu offers the carve on a spline, naming the terrain
	const menu = await A.page.evaluate((uuid) => {
		// (uuid FIRST, opts second — passing one object silently builds a menu for
		// "no object", which is a menu with no Road entry and a green-looking check)
		const items = window.__stores.objectMenu.buildObjectMenuItems(uuid, { selection: [uuid] });
		const road = items.find((i) => i.label === 'Road');
		return {
			hasRoad: !!road,
			children: (road?.children ?? []).map((c) => c.label ?? '(' + (c.section ?? '?') + ')')
		};
	}, built.road);
	h.check(menu.hasRoad, 'the shared object menu grows a Road submenu on a spline');
	h.check(
		menu.children.some((l) => /^Carve into/.test(l)) && menu.children.some((l) => /checkpoint gates$/.test(l)),
		`with the carve and the gate counts in it (${menu.children.join(', ')})`
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
			const ok = w.roadActions.carveRoadInto(roadUuid, terrainUuid);
			peer.send = send;
			await new Promise((r) => setTimeout(r, 300));
			const after = Array.from(terrain.geometry.attributes.position.array);
			let moved = 0;
			for (let i = 1; i < after.length; i += 3) if (Math.abs(after[i] - before[i]) > 1e-6) moved++;
			return {
				ok,
				moved,
				verts: terrain.geometry.attributes.position.count,
				beforeVerts: before.length / 3,
				meshgeo: seen.filter((t) => t === 'meshgeo').length,
				entries: (await new Promise((r) => w.history.undoStack.subscribe((s) => r(s.length))())) - depth,
				kind: await new Promise((r) => w.history.undoStack.subscribe((s) => r(s[s.length - 1]?.kind))())
			};
		},
		[built.road, built.terrain]
	);
	h.check(commit.ok && commit.moved > 20, `the carve commits and moves the bed (${commit.moved} vertices)`);
	h.check(
		commit.verts === commit.beforeVerts,
		`the vertex COUNT is unchanged (${commit.verts}) — which is why positions-only is the right commit`
	);
	h.check(commit.meshgeo === 1, `ONE meshgeo message (${commit.meshgeo})`);
	h.check(
		commit.entries === 1 && commit.kind === 'meshgeo',
		`and ONE undo entry, of the existing meshgeo kind (${commit.entries} x ${commit.kind})`
	);

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
						r({ hash: hash >>> 0, verts: p.count });
					})()
				),
			uuid
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

	// ---- C4 in the app: real sensor gates, and both peers derive the same list
	const made = await A.page.evaluate(async (roadUuid) => {
		const uuids = await window.__stores.roadActions.createLapGates(roadUuid, 4);
		await new Promise((r) => setTimeout(r, 600));
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		return uuids.map((uuid) => {
			const gate = group.getObjectByProperty('uuid', uuid);
			return {
				uuid,
				name: gate?.name,
				sensor: !!gate?.userData?.physics?.sensor,
				collider: gate?.userData?.physics?.collider,
				pos: gate ? [gate.position.x, gate.position.y, gate.position.z] : null
			};
		});
	}, built.road);
	h.check(made.length === 4, `four gates created (${made.length})`);
	h.check(
		made.every((g) => g.sensor && g.collider === 'box'),
		'each is a SENSOR box — so the existing onenter node fires on it, with no new node type'
	);
	h.check(
		made.every((g, i) => g.name === `Gate ${i + 1}`),
		`and they are named in road order (${made.map((g) => g.name).join(', ')})`
	);
	const spacingApp = made
		.map((g, i) => {
			const next = made[(i + 1) % made.length];
			return Math.hypot(next.pos[0] - g.pos[0], next.pos[2] - g.pos[2]);
		})
		.slice(0, 3);
	h.check(
		Math.max(...spacingApp) - Math.min(...spacingApp) < 2,
		`spaced along the road (${spacingApp.map((v) => v.toFixed(1)).join(', ')}m apart)`
	);

	// THE POINT of emitting real objects instead of keeping the gates as module
	// data: the EXISTING nodes already work on them. An On Enter node pointed at a
	// gate plus a Counter IS a lap counter, with no new node type — so drive that
	// seam directly (fireObjectEnter is what the physics sensor pass calls) rather
	// than waiting on a car to drive through, which is a different feature's test.
	const wired = await A.page.evaluate(async (gateUuid) => {
		const s = window.__stores;
		s.flowNodes.set([
			{ id: 'oe-gate', type: 'onenter', position: { x: 0, y: 0 }, data: { label: 'On Enter', pulse: 0.3 } },
			{
				id: 'sel-gate',
				type: 'objectselector',
				position: { x: 220, y: 0 },
				data: { label: 'Object', selected: gateUuid }
			},
			{ id: 'lap-count', type: 'counter', position: { x: 0, y: 140 }, data: { label: 'Counter', step: 1, value: 0 } }
		]);
		s.flowEdges.set([
			{ id: 'w1', source: 'oe-gate', target: 'sel-gate' },
			{ id: 'w2', source: 'oe-gate', target: 'lap-count' }
		]);
		await new Promise((r) => setTimeout(r, 400));
		const before = await new Promise((r) => s.flowTriggers.subscribe(r)());
		s.flowRuntime.fireObjectEnter(gateUuid, 'some-car');
		await new Promise((r) => setTimeout(r, 400));
		const after = await new Promise((r) => s.flowTriggers.subscribe(r)());
		return { before: before?.['oe-gate']?.lastT ?? null, after: after?.['oe-gate']?.lastT ?? null };
	}, made[0].uuid);
	h.check(!wired.before, 'PREMISE: the On Enter node has not pulsed before the gate reports anything');
	h.check(
		!!wired.after,
		'a gate crossing pulses the EXISTING On Enter node — a wireable lap counter with zero new node types'
	);

	// the derivation is the sync: B computes the same gate list from the replicated
	// record without any gate-specific message
	const derivedB = await B.page.evaluate(async (roadUuid) => {
		const gatesLib = window.__stores.roadGates;
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const road = group.getObjectByProperty('uuid', roadUuid);
		return road ? gatesLib.checkpointsFor(road, 4).map((g) => g.position) : null;
	}, built.road);
	const derivedA = await A.page.evaluate(async (roadUuid) => {
		const gatesLib = window.__stores.roadGates;
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const road = group.getObjectByProperty('uuid', roadUuid);
		return road ? gatesLib.checkpointsFor(road, 4).map((g) => g.position) : null;
	}, built.road);
	h.check(
		!!derivedB && JSON.stringify(derivedA) === JSON.stringify(derivedB),
		'B derives the identical checkpoint list from the replicated record — zero messages, determinism is the netcode'
	);

	await h.finish(browser);
});

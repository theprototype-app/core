// 21-C1 — PROCEDURAL TERRAIN. Two halves, because two different things are true:
//
//  1. noise.js is a PURE leaf, so it is imported directly in node (no browser).
//     Determinism, range and lattice continuity live there.
//  2. the terrain is a REPLICATED parametric primitive, so the rest runs two
//     peers plus a late joiner: identical geometry from identical params with NO
//     geometry on the wire, amplitude 0 byte-identical to the flat plane this
//     used to be, the tiling seam, and the sculpt one-way door.
//
// COUNTERFACTUALS are computed in-test (the topo-channel discipline): a guard for
// "the build hook is what makes a custom geometry parametric" has to show what
// happens WITHOUT the hook, or it passes for the wrong reason.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const libPath = (name) => path.join(__dirname, '..', '..', 'src', 'lib', name);

/** hash the exact float BITS of a position attribute, in the page — two peers
 * agreeing on this means BIT equality, and only the number crosses the bridge */
const HASH_FN = `(position) => {
	let hash = 2166136261;
	for (let i = 0; i < position.count; i++)
		for (const v of [position.getX(i), position.getY(i), position.getZ(i)]) {
			const bits = new Uint32Array(new Float32Array([v]).buffer)[0];
			hash = Math.imul(hash ^ (bits & 0xffff), 16777619);
			hash = Math.imul(hash ^ (bits >>> 16), 16777619);
		}
	return hash >>> 0;
}`;

/** ...and a REPRESENTATION-INDEPENDENT hash of the same surface: the height FIELD
 * as (x, z) -> y over the distinct columns, exact bits, in sorted order. It exists
 * because the two comparisons in this suite are not the same question. Two PEERS
 * hold the same layout, so bit equality of the buffer is the right test there. But
 * a sculpt session index-EXPANDS the mesh (2401 indexed vertices become a 13824
 * soup), so comparing a post-undo mesh against the parametric one by buffer hash
 * compares two encodings of one surface and always reads as a difference. */
const FIELD_FN = `(position) => {
	const bitsOf = (v) => new Uint32Array(new Float32Array([v]).buffer)[0];
	const column = new Map();
	for (let i = 0; i < position.count; i++)
		column.set(bitsOf(position.getX(i)) + ',' + bitsOf(position.getZ(i)), bitsOf(position.getY(i)));
	let field = 2166136261;
	for (const key of [...column.keys()].sort())
		for (const ch of key + ':' + column.get(key)) field = Math.imul(field ^ ch.charCodeAt(0), 16777619);
	return { field: field >>> 0, columns: column.size };
}`;

/** the terrain object's shape on a page */
const terrainInfo = (page) =>
	page.evaluate(
		([hashSrc, fieldSrc]) =>
			new Promise((resolve) => {
				window.__stores.objectsGroup.subscribe((g) => {
					const mesh = g?.children.find((c) => c.userData?.terrain);
					if (!mesh) return resolve(null);
					const hashOf = eval(hashSrc);
					const fieldOf = eval(fieldSrc);
					const position = mesh.geometry.attributes.position;
					let minY = Infinity;
					let maxY = -Infinity;
					for (let i = 0; i < position.count; i++) {
						minY = Math.min(minY, position.getY(i));
						maxY = Math.max(maxY, position.getY(i));
					}
					const surface = fieldOf(position);
					resolve({
						uuid: mesh.uuid,
						hash: hashOf(position),
						field: surface.field,
						columns: surface.columns,
						verts: position.count,
						indexed: !!mesh.geometry.index,
						params: mesh.userData.geometryParams?.params ?? null,
						gtype: mesh.userData.geometryParams?.gtype ?? null,
						spread: maxY - minY,
						faceEdited: !!mesh.userData.faceEdited
					});
				})();
			}),
		[HASH_FN, FIELD_FN]
	);

h.run(async () => {
	// ==================================================== 1. noise.js (no browser)
	const noise = await import(pathToFileURL(libPath('noise.js')).href);

	h.check(
		noise.hash2i(3, 7, 1) === noise.hash2i(3, 7, 1) && noise.hash2i(3, 7, 1) !== noise.hash2i(3, 7, 2),
		'hash2i is a pure function of (x, y, seed)'
	);

	// negative lattice coordinates are the trap: the mixer leaves a SIGNED 32-bit
	// int, and without the >>> 0 the field silently mirrors about the origin
	let hashOk = true;
	for (let x = -40; x <= 40; x += 7)
		for (let y = -40; y <= 40; y += 7) {
			const v = noise.hash2i(x, y, 5);
			if (!(v >= 0 && v < 1)) hashOk = false;
		}
	h.check(hashOk, 'hash2i stays in [0,1) for negative lattice coordinates too');

	let noiseOk = true;
	let noiseMin = Infinity;
	let noiseMax = -Infinity;
	for (let i = 0; i < 400; i++) {
		const v = noise.valueNoise2(i * 0.37 - 70, i * -0.19 + 12, 3);
		if (!(v >= 0 && v <= 1)) noiseOk = false;
		noiseMin = Math.min(noiseMin, v);
		noiseMax = Math.max(noiseMax, v);
	}
	h.check(
		noiseOk && noiseMax - noiseMin > 0.3,
		`valueNoise2 is in [0,1] and actually varies (${noiseMin.toFixed(3)}..${noiseMax.toFixed(3)})`
	);

	// continuity across a cell boundary: without the smoothstep both sides still
	// meet, so this is the weaker half; the DERIVATIVE is what smoothstep buys and
	// what stops a visible crease along every integer coordinate
	const gap = Math.abs(noise.valueNoise2(4 - 1e-7, 2.5, 9) - noise.valueNoise2(4 + 1e-7, 2.5, 9));
	const slopeInside = Math.abs(noise.valueNoise2(3.9, 2.5, 9) - noise.valueNoise2(3.8, 2.5, 9));
	const slopeAtEdge = Math.abs(noise.valueNoise2(4.0, 2.5, 9) - noise.valueNoise2(3.99, 2.5, 9));
	h.check(gap < 1e-6, `valueNoise2 is continuous across a lattice line (${gap.toExponential(1)})`);
	h.check(
		slopeAtEdge * 10 < slopeInside + 1e-9,
		`its slope flattens INTO the lattice line (smoothstep, not linear): ${slopeAtEdge.toExponential(1)} per 0.01 vs ${slopeInside.toExponential(1)} per 0.1`
	);

	// the transcendental rule — this is the whole reason the noise is value noise
	const noiseSrc = fs.readFileSync(libPath('noise.js'), 'utf8');
	const code = noiseSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
	const banned = ['Math.sin', 'Math.cos', 'Math.tan', 'Math.exp', 'Math.pow', 'Math.log', '**'].filter(
		(b) => code.includes(b)
	);
	h.check(
		banned.length === 0,
		'noise.js reaches for no transcendental — that is what makes it bit-exact per engine' +
			(banned.length ? ` — found ${banned.join(', ')}` : '')
	);

	// octaves must buy DETAIL, not height (fbm normalises by the amplitude sum),
	// or changing octaves alone would resize the mountains
	let oneMax = -Infinity;
	let sixMax = -Infinity;
	let differs = false;
	for (let i = 0; i < 300; i++) {
		const x = i * 0.11;
		const a = noise.fbm2(x, x * 0.7, { seed: 4, octaves: 1 });
		const b = noise.fbm2(x, x * 0.7, { seed: 4, octaves: 6 });
		oneMax = Math.max(oneMax, a);
		sixMax = Math.max(sixMax, b);
		if (Math.abs(a - b) > 0.02) differs = true;
	}
	h.check(
		oneMax <= 1 && sixMax <= 1 && differs,
		`fbm2 normalises by amplitude: 6 octaves add detail, not height (max ${oneMax.toFixed(3)} vs ${sixMax.toFixed(3)})`
	);
	h.check(
		noise.fbm2(1.5, -2.5, { seed: 8, octaves: 4, ridged: true }) !==
			noise.fbm2(1.5, -2.5, { seed: 8, octaves: 4 }),
		'the ridged fold changes the field'
	);

	// ==================================================== 2. the terrain, replicated
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- the latent bugs, measured -----------------------------------------
	// The plan expected a Terrain to resolve as a PLANE (a rotated PlaneGeometry
	// keeps .parameters). It does not, and the reason matters: createGeometry
	// bakes every custom builder into a plain BufferGeometry so toJSON carries
	// real vertices, so before this phase a Terrain resolved to NOTHING and had
	// no Geometry section at all.
	const resolution = await A.page.evaluate(() => {
		const ge = window.__stores.geometryEdit;
		const THREE = window.__stores.THREE;
		const old = new THREE.PlaneGeometry(24, 24, 48, 48);
		old.rotateX(-Math.PI / 2);
		const baked = new THREE.BufferGeometry().copy(old);
		const fake = new THREE.Mesh(baked, new THREE.MeshStandardMaterial());
		fake.userData.terrain = true;
		const withMarker = ge.geometryParamsOf(fake);
		delete fake.userData.terrain;
		const withoutMarker = ge.geometryParamsOf(fake);
		return {
			bakedType: baked.type,
			bakedHasParameters: !!baked.parameters,
			withMarker: withMarker?.gtype ?? null,
			size: withMarker?.params?.size ?? null,
			segments: withMarker?.params?.segments ?? null,
			withoutMarker: withoutMarker?.gtype ?? null
		};
	});
	h.check(
		resolution.bakedType === 'BufferGeometry' &&
			!resolution.bakedHasParameters &&
			resolution.withoutMarker === null,
		`PREMISE: a baked terrain geometry is a BufferGeometry with no .parameters, so the type fallback resolves NOTHING (${resolution.bakedType})`
	);
	h.check(
		resolution.withMarker === 'Terrain',
		'userData.terrain resolves to the Terrain spec BEFORE the geometry.type fallback'
	);
	h.check(
		resolution.size === 24 && resolution.segments === 48,
		`an UNSTAMPED terrain derives size + segments from the mesh, never from the defaults (${resolution.size}/${resolution.segments})`
	);

	// ---- amplitude 0 is byte-identical to the flat plane -------------------
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create Terrain 24 48'));
	await A.page.waitForTimeout(900);
	const flat = await terrainInfo(A.page);
	h.check(!!flat && flat.gtype === 'Terrain', 'a fresh /create Terrain is STAMPED with Terrain params');
	h.check(flat.params?.amplitude === 0, 'it starts FLAT (amplitude 0) — nothing about the old behaviour changed');
	const flatRef = await A.page.evaluate(
		([hashSrc]) => {
			const THREE = window.__stores.THREE;
			const old = new THREE.PlaneGeometry(24, 24, 48, 48);
			old.rotateX(-Math.PI / 2);
			return { hash: eval(hashSrc)(old.attributes.position), verts: old.attributes.position.count };
		},
		[HASH_FN]
	);
	h.check(
		flat.hash === flatRef.hash && flat.verts === flatRef.verts,
		`amplitude 0 is BYTE-IDENTICAL to the old PlaneGeometry + rotateX, epsilons included (${flat.hash} vs ${flatRef.hash})`
	);

	// ---- a noise edit: params on the wire, geometry rebuilt per peer -------
	const wire = await A.page.evaluate(
		async ([uuid]) => {
			const peer = await new Promise((r) => window.__stores.peers.subscribe((p) => r(p))());
			/** @type {any[]} */
			const seen = [];
			const send = peer.send.bind(peer); // PASS THROUGH: a dropping spy makes
			peer.send = (m) => {                // delivery and loss indistinguishable
				seen.push(
					typeof m === 'string'
						? { type: 'command', bytes: m.length }
						: { type: m?.type, bytes: JSON.stringify(m ?? {}).length }
				);
				return send(m);
			};
			const ok = window.__stores.geometryEdit.applyGeometry(uuid, {
				amplitude: 6,
				seed: 42,
				frequency: 0.08,
				octaves: 4,
				falloff: 'island'
			});
			peer.send = send;
			return { ok, seen };
		},
		[flat.uuid]
	);
	const geoMsgs = wire.seen.filter((m) => m.type === 'geometry');
	h.check(wire.ok && geoMsgs.length === 1, `the edit sends exactly ONE geometry message (${geoMsgs.length})`);
	h.check(
		!wire.seen.some((m) => m.type === 'meshgeo' || m.type === 'verts'),
		`and NO geometry travels — no meshgeo, no verts (${wire.seen.map((m) => m.type).join(', ') || 'nothing else'})`
	);
	h.check(
		geoMsgs[0].bytes < 400,
		`that message is a handful of numbers, not a mesh (${geoMsgs[0].bytes} bytes of JSON)`
	);

	const hilly = await terrainInfo(A.page);
	h.check(hilly.spread > 1, `the terrain is displaced now (Y spread ${hilly.spread.toFixed(2)}m)`);
	h.check(
		hilly.verts === flat.verts && hilly.indexed,
		'the vertex COUNT and the index are unchanged — noise only moves Y'
	);
	await h.eventually(
		() => terrainInfo(B.page),
		(t) => t?.hash === hilly.hash,
		'B rebuilds a BIT-IDENTICAL terrain from those params (determinism IS the netcode)'
	);

	// a different seed is a different world, and both peers still agree
	await A.page.evaluate((uuid) => window.__stores.geometryEdit.applyGeometry(uuid, { seed: 1234 }), flat.uuid);
	await A.page.waitForTimeout(500);
	const reseeded = await terrainInfo(A.page);
	h.check(reseeded.hash !== hilly.hash, 'changing the seed changes the terrain');
	await h.eventually(
		() => terrainInfo(B.page),
		(t) => t?.hash === reseeded.hash,
		'B follows the seed change, still bit-identical'
	);

	// ---- the counterfactual: the build hook IS the fix ---------------------
	// Without it, buildGeometry can only make what three has a constructor for,
	// so a Terrain has params that cannot rebuild anything — and the old
	// type-fallback path would have produced a VERTICAL plane, which is what the
	// second half of this measures rather than asserts from memory.
	const counter = await A.page.evaluate(
		([uuid, hashSrc]) => {
			const ge = window.__stores.geometryEdit;
			const hashOf = eval(hashSrc);
			const spec = ge.GEOMETRY_PARAMS.Terrain;
			const params = { ...spec.params.reduce((a, p) => ({ ...a, [p.key]: p.def }), {}), amplitude: 6, seed: 42 };
			const withHook = ge.buildGeometry('Terrain', params);
			const build = spec.build;
			spec.build = null; // rip the hook out
			const withoutHook = ge.buildGeometry('Terrain', params);
			const editRefused = ge.applyGeometry(uuid, { amplitude: 9 }, { replicate: false, record: false });
			spec.build = build; // and put it back
			const restored = ge.buildGeometry('Terrain', params);
			// what the geometry.type fallback WOULD have built for a terrain
			const asPlane = ge.buildGeometry('Plane', { width: 24, height: 24, widthSegments: 48, heightSegments: 48 });
			const spanOf = (geo, axis) => {
				const p = geo.attributes.position;
				let lo = Infinity;
				let hi = -Infinity;
				for (let i = 0; i < p.count; i++) {
					const v = axis === 'y' ? p.getY(i) : p.getZ(i);
					lo = Math.min(lo, v);
					hi = Math.max(hi, v);
				}
				return hi - lo;
			};
			return {
				withHook: !!withHook,
				withoutHook: withoutHook === null,
				editRefused: editRefused === false,
				restoredHash: restored ? hashOf(restored.attributes.position) : 0,
				withHookHash: withHook ? hashOf(withHook.attributes.position) : -1,
				planeYSpan: spanOf(asPlane, 'y'),
				planeZSpan: spanOf(asPlane, 'z'),
				terrainZSpan: spanOf(withHook, 'z')
			};
		},
		[flat.uuid, HASH_FN]
	);
	h.check(counter.withHook, 'PREMISE: with the build hook, buildGeometry makes a Terrain');
	h.check(
		counter.withoutHook && counter.editRefused,
		'COUNTERFACTUAL: with spec.build cleared, buildGeometry returns null and the param edit is refused — the hook is what makes a CUSTOM geometry parametric at all'
	);
	h.check(
		counter.restoredHash === counter.withHookHash,
		'putting the hook back rebuilds the same geometry (the counterfactual left nothing behind)'
	);
	// and the other half of the latent bug: the fallback's Plane is VERTICAL
	h.check(
		counter.planeZSpan === 0 && counter.planeYSpan > 20 && counter.terrainZSpan > 20,
		`COUNTERFACTUAL: the geometry.type fallback builds a Plane standing UP (z span ${counter.planeZSpan}, y span ${counter.planeYSpan.toFixed(0)}) where the terrain lies FLAT (z span ${counter.terrainZSpan.toFixed(0)})`
	);

	// ---- tiling: one field, offsets as PARAMS, so the seam matches ---------
	const tiling = await A.page.evaluate(() => {
		const ge = window.__stores.geometryEdit;
		const base = { size: 24, segments: 24, seed: 77, amplitude: 8, frequency: 0.05, octaves: 4, warp: 0, falloff: 'flat', offsetX: 0, offsetZ: 0, ridged: false };
		const left = ge.buildGeometry('Terrain', base);
		const right = ge.buildGeometry('Terrain', { ...base, offsetX: 24 });
		const moved = ge.buildGeometry('Terrain', base); // same tile, TRANSFORMED instead
		// left tile's +x edge vs right tile's -x edge, matched by z
		const edge = (geo, wantX) => {
			const p = geo.attributes.position;
			/** @type {{z: number, y: number}[]} */
			const out = [];
			for (let i = 0; i < p.count; i++)
				if (Math.abs(p.getX(i) - wantX) < 1e-4) out.push({ z: p.getZ(i), y: p.getY(i) });
			return out.sort((a, b) => a.z - b.z);
		};
		const a = edge(left, 12);
		const b = edge(right, -12);
		let worst = 0;
		for (let i = 0; i < Math.min(a.length, b.length); i++) worst = Math.max(worst, Math.abs(a[i].y - b[i].y));
		// the transformed alternative: shifting the SAME tile in X leaves its own
		// edge unchanged, so it cannot line up with its neighbour
		const c = edge(moved, -12);
		let movedWorst = 0;
		for (let i = 0; i < Math.min(a.length, c.length); i++) movedWorst = Math.max(movedWorst, Math.abs(a[i].y - c[i].y));
		return { samples: a.length, worst, movedWorst };
	});
	h.check(tiling.samples === 25, `PREMISE: the shared edge has one sample per segment row (${tiling.samples})`);
	h.check(
		tiling.worst < 1e-5,
		`two tiles with the same seed and offsetX one size apart SEAM exactly (worst mismatch ${tiling.worst.toExponential(1)}m)`
	);
	h.check(
		tiling.movedWorst > 0.1,
		`COUNTERFACTUAL: a TRANSFORMED copy of the same tile does not (${tiling.movedWorst.toFixed(2)}m step at the join) — which is why the offsets are params`
	);

	// the segments cap is load-bearing (the 45k live-preview budget), not cosmetic
	const capped = await A.page.evaluate(() => {
		const geo = window.__stores.geometryEdit.buildGeometry('Terrain', { size: 24, segments: 400, amplitude: 3 });
		return { verts: geo.attributes.position.count, floats: geo.attributes.position.count * 3 };
	});
	h.check(capped.verts === 49 * 49, `segments clamp at 48 whatever is asked for (${capped.verts} vertices)`);

	// ---- the sculpt handoff: a one-way door WITH a handle -------------------
	// the Geometry section is collapsed by default and a collapsed Section renders
	// NO children, so the flag has to be set before the panel first mounts it
	await A.page.evaluate((uuid) => {
		localStorage.setItem('inspector:sec:Geometry', 'open');
		window.__stores.objectActions.selectObject(uuid, true);
	}, flat.uuid);
	// WAIT ON THE PANEL, never on a clock: a fixed sleep here asserts the scheduler,
	// and on a loaded box (this suite after another) the section legitimately takes
	// longer than a second to mount — measured, exactly these two checks went red in
	// a battery and green alone.
	const inspectorDom = () =>
		A.page.evaluate(() => ({
			rows: !!document.querySelector('#inspector-geometry'),
			locked: !!document.querySelector('#geometry-locked'),
			regen: !!document.querySelector('#terrain-regenerate'),
			choice: !!document.querySelector('#geo-choice-falloff-island')
		}));
	await h.eventually(
		inspectorDom,
		(d) => d.rows && !d.locked,
		'the Inspector shows the parametric Terrain rows',
		20000
	);
	const beforeSculpt = await inspectorDom();
	h.check(beforeSculpt.choice, 'the falloff param renders as named CHOICE chips (a new spec kind)');

	// PIN the panel first: the point of the check below is that the lock appears
	// while the panel is OPEN, with no reselect. (exitSculpt() deselects, which
	// closes an unpinned panel — so an unpinned flow could never show this.)
	await A.page.evaluate(() => window.__stores.inspectorPinned?.set?.(true));
	const stroke = await A.page.evaluate((uuid) => {
		const ts = window.__stores.terrainSculpt;
		const ok = ts.enterSculpt(uuid);
		ts.beginStroke(uuid);
		for (let i = 0; i < 10; i++) ts.applyBrushAt(uuid, 0, 0, 'raise', 4, 1, 0.05);
		ts.endStroke();
		return ok;
	}, flat.uuid);
	await A.page.waitForTimeout(700);
	const sculpted = await terrainInfo(A.page);
	h.check(
		stroke && sculpted.field !== reseeded.field,
		'PREMISE: a brush stroke really changed the surface'
	);
	h.check(
		!sculpted.indexed && sculpted.verts > reseeded.verts && sculpted.columns === reseeded.columns,
		`PREMISE: a sculpt session index-EXPANDS the mesh (${reseeded.verts} indexed -> ${sculpted.verts} soup) over the same ${sculpted.columns} columns, which is why the checks below compare the height FIELD and not the buffer`
	);
	h.check(sculpted.faceEdited, 'the stroke stamps faceEdited (the meshgeo commit does it) — the parametric rows LOCK');
	await h.eventually(
		inspectorDom,
		(d) => d.locked && !d.rows,
		'the open Inspector says so and hides the rows, with no reselect',
		15000
	);
	const liveLock = await inspectorDom();
	h.check(liveLock.regen, 'and offers an explicit way back: Regenerate (discards the sculpt)');

	// and the same after the natural flow — leave sculpt (which deselects) and
	// click the terrain again
	await A.page.evaluate((uuid) => {
		window.__stores.terrainSculpt.exitSculpt();
		window.__stores.objectActions.selectObject(uuid, true);
	}, flat.uuid);
	await h.eventually(
		inspectorDom,
		(d) => d.locked && !d.rows && d.regen,
		'leaving sculpt and reselecting shows the same locked state',
		15000
	);

	// the way back is CONFIRMED, then one geometry rebuild
	await A.page.locator('#terrain-regenerate').click();
	await A.page.waitForTimeout(400);
	await A.page.getByRole('button', { name: 'Rebuild' }).click();
	await A.page.waitForTimeout(900);
	const regenerated = await terrainInfo(A.page);
	h.check(
		regenerated.hash === reseeded.hash && regenerated.indexed && !regenerated.faceEdited,
		'Regenerate rebuilds the parametric terrain exactly — indexed grid back, lock cleared'
	);
	// THIS is the check the reactivity fix earns, and the A/B says so: with the
	// template reading userData straight off $selectedObject, the lock APPEARS fine
	// (a sculpt commit re-renders the section anyway) but never goes AWAY — the
	// rebuild clears faceEdited on the object and a THREE tree is not reactive, so
	// the panel kept showing "Mesh edited" over a freshly parametric terrain, with
	// no rows and no way back except reselecting. Verified by putting the old
	// condition back: exactly this check goes red.
	await h.eventually(
		inspectorDom,
		(d) => d.rows && !d.locked,
		'the parametric rows come BACK — the panel notices the lock being cleared, not just set',
		15000
	);

	// What the history really does here, stated rather than glossed, because it is a
	// genuine limitation of the machinery and not what "undoable" would suggest: the
	// rebuild records a 'geometry' entry, and that kind carries PARAMS, not a mesh.
	// So walking BACK goes rebuild -> pre-sculpt (the sculpt's own meshgeo entry
	// undoes to what came before IT), and the sculpt is reached by walking FORWARD
	// again. Exactly how changing a param on any vertex-edited primitive already
	// behaves — and why the confirm text promises no one-key rescue.
	await A.page.keyboard.press('Control+z');
	await A.page.waitForTimeout(800);
	const undoneOnce = await terrainInfo(A.page);
	h.check(
		undoneOnce.hash === regenerated.hash,
		'the first undo pops the rebuild entry (same params in and out, so the shape does not move)'
	);
	await A.page.keyboard.press('Control+z');
	await A.page.waitForTimeout(800);
	const undoneTwice = await terrainInfo(A.page);
	h.check(
		undoneTwice.field === reseeded.field,
		'the second undo pops the SCULPT, landing on the parametric surface that preceded it'
	);
	await A.page.keyboard.press('Control+y');
	await A.page.waitForTimeout(800);
	const redone = await terrainInfo(A.page);
	h.check(
		redone.field === sculpted.field,
		'and the sculpt is still in the history — redo brings it back, so Regenerate loses nothing permanently'
	);
	await A.page.keyboard.press('Control+y');
	await A.page.waitForTimeout(800);
	const redoneTwice = await terrainInfo(A.page);
	h.check(redoneTwice.field === regenerated.field, 'redo again returns to the regenerated terrain');

	// ---- a late joiner: the params ride the object, nothing extra is sent ---
	const late = await terrainInfo(A.page);
	// B has done its job (bit-parity in both directions) and a third browser context
	// is the practical ceiling on a loaded box — free it before opening C.
	await B.ctx.close();
	await A.page.waitForTimeout(1200);
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	await h.eventually(
		() => terrainInfo(C.page),
		(t) => !!t?.params && t.gtype === 'Terrain',
		'a late joiner receives the terrain WITH its params on board (GLTF extras, no extra message)'
	);
	const arrived = await terrainInfo(C.page);
	h.check(
		JSON.stringify(arrived?.params ?? {}) === JSON.stringify(late.params ?? null),
		"the params that arrived are A's params, not defaults"
	);
	const rebuilt = await C.page.evaluate(
		([params, hashSrc]) => {
			const geo = window.__stores.geometryEdit.buildGeometry('Terrain', params);
			return geo ? eval(hashSrc)(geo.attributes.position) : 0;
		},
		[arrived?.params ?? late.params, HASH_FN]
	);
	h.check(
		rebuilt === late.hash,
		`and rebuilding from those params on C reproduces A's terrain bit for bit (${rebuilt} vs ${late.hash})`
	);
	const cEdit = await C.page.evaluate(
		(uuid) => window.__stores.geometryEdit.applyGeometry(uuid, { amplitude: 12 }),
		late.uuid
	);
	h.check(cEdit, 'the late joiner can edit it too (the params are not a one-way stamp)');
	await h.eventually(
		() => terrainInfo(A.page),
		(t) => t?.params?.amplitude === 12,
		"and A follows the joiner's edit"
	);

	await h.finish(browser);
});
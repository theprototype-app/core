// 64-extrude (D7) — ONE DRAG turns a shape or a text into a solid, on the mesh kernel.
//
//   §1 a star: select it, the extrude arrow stands on its front corner; a REAL mouse drag on the
//      arrow extrudes it live (B watches the depth grow before the release), ONE undo entry on
//      release, undo brings it back flat on both peers, redo extrudes it again
//   §2 the word "HELLO": a block text, the same arrow, the same drag -> Solid on A and B, one undo
//   §3 the solid is a clean kernel mesh: n-gon caps + quad walls stored as the face partition,
//      closed and manifold; Edit mode opens it and an EDGE BEVEL on one of its edges applies
//      (watertight after), the Geometry rows lock, the arrow goes away
//   §4 the Inspector's Extrude row: a scrub is ONE undo step (the geometry merge)
//   §5 bevel + steps: inward, the solid stays inside z 0..depth; bevelSegments reaches B
//   §6 budget: a 64-point star drags at frame rate (no frame over 50 ms on the PC); a 2 000-point
//      path builds under 300 ms, and a depth drag on it blocks no frame over 100 ms
//   §7 Escape mid-drag leaves the depth where it was and no undo step
//   §8 Bake: the shape becomes a plain mesh on A and B (no record), one undo brings the record back
//
// Run: e2e-slot --dev <lane> 7227 -- env APP_URL=https://theprototype.app:7227/ node tests/e2e/vector-extrude.test.cjs
const h = require('./helpers.cjs');

const v1 = 'window.__tp.test.v1';

/** facts of one object on a page @param {any} page @param {string} uuid */
const facts = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return null;
		const geo = o.geometry;
		geo?.computeBoundingBox?.();
		const topo = geo?.userData?.__topo;
		return {
			verts: geo?.attributes?.position?.count ?? 0,
			gtype: o.userData?.geometryParams?.gtype ?? null,
			params: o.userData?.geometryParams?.params ?? null,
			text: o.userData?.textPath
				? {
						mode: o.userData.textPath.mode,
						depth: o.userData.textPath.depth,
						text: o.userData.textPath.text
					}
				: null,
			faceEdited: !!o.userData?.faceEdited,
			zmin: geo?.boundingBox?.min.z ?? null,
			zmax: geo?.boundingBox?.max.z ?? null,
			topoFaces: topo?.counts?.length ?? 0,
			topoMax: topo?.counts?.length ? Math.max(...topo.counts) : 0
		};
	}, uuid);
const undoDepth = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__tp.test.v1.history.undoStack.subscribe((s) => r(s.length))())
	);
const undo = (page) => page.evaluate(() => window.__tp.test.v1.history.undo());
const redo = (page) => page.evaluate(() => window.__tp.test.v1.history.redo());
const select = (page, uuid) =>
	page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u), uuid);
const arrow = (page) => page.evaluate(() => window.__tp.test.v1.vectorExtrude.extrudeDebug());
const depthOf = (f) =>
	f?.params ? f.params.depth : f?.text?.mode === 'extruded' ? f.text.depth : 0;

/** wait for the arrow on `uuid` and return its screen segment */
async function arrowOn(page, uuid, label) {
	let a = null;
	await h.eventually(
		async () => (a = await arrow(page)),
		(d) => d && d.target === uuid && d.helper && !!d.foot && !!d.tip && !!d.pull,
		label,
		20000
	);
	return a;
}

/** a real press on the arrow's middle, a drag of `px` along it, a release; samples B mid-drag */
async function dragArrow(page, a, px, opts = {}) {
	const mx = (a.foot[0] + a.tip[0]) / 2;
	const my = (a.foot[1] + a.tip[1]) / 2;
	// the screen direction the arrow reads as deeper (along the arrow, or up the screen when it faces you)
	const [dx, dy] = a.pull;
	const l = Math.hypot(dx, dy) || 1;
	const steps = opts.steps ?? 12;
	await page.mouse.move(mx, my);
	await page.mouse.down();
	for (let i = 1; i <= steps; i++) {
		await page.mouse.move(mx + (dx / l) * px * (i / steps), my + (dy / l) * px * (i / steps));
		await page.waitForTimeout(opts.pause ?? 30);
		if (opts.mid && i === Math.ceil(steps / 2)) await opts.mid();
	}
	if (opts.beforeUp) await opts.beforeUp();
	await page.mouse.up();
	await page.waitForTimeout(250);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- §1 the star ----------------------------------------------------------------------
	const star = await A.page.evaluate(
		() =>
			window.__tp.test.v1.vectorActions.placeVectorShape('star', [0, 0, 0], { radius: 0.8 })?.uuid
	);
	h.check(!!star, '§1 premise: a star is placed');
	await h.eventually(
		() => facts(B.page, star),
		(f) => !!f && f.gtype === 'Vector',
		'§1 B has the star'
	);
	await select(A.page, star);
	const a1 = await arrowOn(A.page, star, '§1 the extrude arrow stands on the selected star');
	// a star placed facing the camera points its arrow (nearly) AT you: the drag then reads screen-up
	const len1 = Math.hypot(a1.tip[0] - a1.foot[0], a1.tip[1] - a1.foot[1]);
	h.check(
		len1 >= 14
			? Math.abs(Math.hypot(...a1.pull) - 1) < 1e-6
			: a1.pull[0] === 0 && a1.pull[1] === -1,
		`§1 the drag direction is the arrow on screen, or up when it faces you (${Math.round(len1)} px, pull ${a1.pull.map((v) => v.toFixed(2))})`
	);
	const u0 = await undoDepth(A.page);
	let midB = 0;
	await dragArrow(A.page, a1, 140, {
		mid: async () => {
			// live: B sees a depth before the release
			// (eventually returns the check, not the value: keep the last value it saw)
			await h.eventually(
				async () => {
					const f = await facts(B.page, star);
					midB = depthOf(f) ?? 0;
					return f;
				},
				(f) => depthOf(f) > 0,
				'§1 B watches the star grow DURING the drag',
				8000
			);
		}
	});
	const s1 = await facts(A.page, star);
	h.check(depthOf(s1) > 0.05, `§1 the drag extruded the star (depth ${depthOf(s1)?.toFixed(3)})`);
	h.check(
		midB > 0 && midB <= depthOf(s1) + 1e-9,
		`§1 B saw it mid-drag (${midB?.toFixed(3)} on the way to ${depthOf(s1)?.toFixed(3)})`
	);
	h.check(
		(await undoDepth(A.page)) === u0 + 1,
		`§1 the whole drag is ONE undo entry (${(await undoDepth(A.page)) - u0})`
	);
	h.check(
		Math.abs(s1.zmin) < 1e-4 && Math.abs(s1.zmax - depthOf(s1)) < 1e-3,
		`§1 the solid spans z 0..depth (${s1.zmin?.toFixed(4)}..${s1.zmax?.toFixed(4)})`
	);
	await h.eventually(
		() => facts(B.page, star),
		(f) => !!f && Math.abs(depthOf(f) - depthOf(s1)) < 1e-9 && f.verts === s1.verts,
		'§1 B ends on the same depth and the same mesh'
	);
	await undo(A.page);
	await h.eventually(
		() => facts(A.page, star),
		(f) => depthOf(f) === 0,
		'§1 ONE undo makes the star flat again on A'
	);
	await h.eventually(
		() => facts(B.page, star),
		(f) => depthOf(f) === 0,
		'§1 ...and on B'
	);
	await redo(A.page);
	await h.eventually(
		() => facts(B.page, star),
		(f) => Math.abs(depthOf(f) - depthOf(s1)) < 1e-9,
		'§1 redo extrudes it again on both'
	);

	// ---- §2 HELLO -------------------------------------------------------------------------
	const word = await A.page.evaluate(
		() => window.__tp.test.v1.addObjects.spawnAtPoint('/create Text', [2.2, 1, 0]).uuid
	);
	await A.page.evaluate(
		(u) => window.__tp.test.v1.textPathEdit.setTextPathFor(u, { text: 'HELLO', mode: 'flat' }),
		word
	);
	await h.eventually(
		() => facts(B.page, word),
		(f) => f?.text?.text === 'HELLO',
		'§2 B has the flat word HELLO'
	);
	await select(A.page, word);
	const a2 = await arrowOn(A.page, word, '§2 the arrow stands on the selected text');
	const u2 = await undoDepth(A.page);
	await dragArrow(A.page, a2, 90);
	const w2 = await facts(A.page, word);
	h.check(
		w2?.text?.mode === 'extruded' && w2.text.depth > 0.01,
		`§2 the drag made HELLO solid (depth ${w2?.text?.depth?.toFixed(3)})`
	);
	h.check(
		(await undoDepth(A.page)) === u2 + 1,
		`§2 ONE undo entry for the drag (${(await undoDepth(A.page)) - u2})`
	);
	await h.eventually(
		() => facts(B.page, word),
		(f) => f?.text?.mode === 'extruded' && Math.abs(f.text.depth - w2.text.depth) < 1e-9,
		'§2 B sees HELLO solid at the same depth'
	);
	await undo(A.page);
	await h.eventually(
		() => facts(B.page, word),
		(f) => f?.text?.mode === 'flat',
		'§2 ONE undo: HELLO flat again on B'
	);
	await redo(A.page);

	// ---- §3 the kernel mesh + Edit mode -------------------------------------------------
	const s3 = await facts(A.page, star);
	h.check(
		s3.topoFaces > 0 && s3.topoMax >= 8,
		`§3 the solid keeps its kernel faces (${s3.topoFaces} faces, the largest ${s3.topoMax} triangles: an n-gon cap)`
	);
	const kernel = await A.page.evaluate(async (u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		const { fromBufferGeometry } = await import('/src/lib/meshKernel/geometry.js');
		const { mesh, report } = fromBufferGeometry(o.geometry, { weld: 1e-4 });
		const rep = mesh.topologyReport();
		const sizes = mesh.faceIds().map((f) => mesh.faceSize(f));
		return {
			partition: report.partition,
			fallback: report.fallbackFaces,
			closed: rep.closed,
			manifold: rep.manifold,
			quads: sizes.filter((n) => n === 4).length,
			big: Math.max(...sizes)
		};
	}, star);
	h.check(
		kernel.partition === 'used' && kernel.fallback === 0,
		`§3 the editor reads the stored faces as they are (${kernel.partition}, ${kernel.fallback} fallback)`
	);
	h.check(kernel.closed && kernel.manifold, '§3 closed and manifold');
	h.check(
		kernel.big >= 10 && kernel.quads >= 10,
		`§3 n-gon caps (${kernel.big} corners) and quad walls (${kernel.quads})`
	);
	const bevel = await A.page.evaluate((u) => {
		const fe = window.__tp.test.v1.faceEdit;
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', u);
		fe.exitFaceEdit?.();
		fe.enterFaceEdit(u);
		fe.setFaceSubmode('edges');
		const tris = fe.readTriangles(o.geometry);
		// a vertical wall edge: its ends each carry a cap and two walls (the corner an edge bevel cuts)
		let picked = null;
		for (let ti = 0; ti < tris.length && !picked; ti++) {
			const t = tris[ti];
			for (let e = 0; e < 3 && !picked; e++) {
				const p = t[e];
				const q = t[(e + 1) % 3];
				if (Math.abs(p.x - q.x) > 1e-5 || Math.abs(p.y - q.y) > 1e-5 || Math.abs(p.z - q.z) < 0.01)
					continue;
				const c = t[0]
					.clone()
					.add(t[1])
					.add(t[2])
					.multiplyScalar(1 / 3);
				const key = fe.pickEdgeAt(ti, c.clone().lerp(p.clone().add(q).multiplyScalar(0.5), 0.95));
				if (!key) continue;
				fe.pickEdge(key, false);
				if (fe.edgeSelectionSize() === 1) picked = key;
			}
		}
		const before = tris.length;
		const ok = picked ? fe.bevelEdges(0.04, 2, 0.5) : false;
		const after = fe.readTriangles(o.geometry);
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const counts = new Map();
		for (const t of after) {
			const ks = t.map(keyOf);
			for (let e = 0; e < 3; e++) {
				const k = [ks[e], ks[(e + 1) % 3]].sort().join('|');
				counts.set(k, (counts.get(k) ?? 0) + 1);
			}
		}
		const odd = [...counts.values()].filter((n) => n !== 2).length;
		return {
			picked: !!picked,
			ok,
			before,
			after: after.length,
			odd,
			faceEdited: !!o.userData.faceEdited
		};
	}, star);
	h.check(bevel.picked, '§3 premise: one vertical wall edge of the star is picked in Edit mode');
	h.check(
		bevel.ok && bevel.after > bevel.before,
		`§3 the EDGE BEVEL applies to the extruded star (${bevel.before} -> ${bevel.after} triangles)`
	);
	h.check(bevel.odd === 0, `§3 watertight after the bevel (${bevel.odd} odd edges)`);
	h.check(bevel.faceEdited, '§3 the shape is marked mesh-edited (its Geometry rows lock)');
	await A.page.evaluate(() => window.__tp.test.v1.faceEdit.exitFaceEdit());
	await select(A.page, star);
	await A.page.waitForTimeout(300);
	const a3 = await arrow(A.page);
	h.check(
		a3.target !== star,
		'§3 a mesh-edited shape has no extrude arrow (its record no longer is its mesh)'
	);
	// undo takes the bevel back off (the Edit session may have left a selection step on top of it).
	// The shape stays marked mesh-edited — faceEdit stamps that on every swap, undo too (base) — and
	// §4's setDepth rebuilds it from its record, which clears the mark.
	let f3 = null;
	for (let i = 0; i < 4; i++) {
		await undo(A.page);
		await A.page.waitForTimeout(200);
		f3 = await facts(A.page, star);
		if (f3?.verts === bevel.before * 3) break;
	}
	h.check(
		f3?.verts === bevel.before * 3,
		`§3 undo takes the bevel back off (${f3?.verts / 3} triangles, ${bevel.before} before it)`
	);

	// ---- §4 the Inspector row: one scrub, one step ---------------------------------------
	const u4 = await undoDepth(A.page);
	await A.page.evaluate((u) => {
		const token = {};
		const s = window.__tp.test.v1;
		for (const d of [0.2, 0.25, 0.3, 0.35]) s.vectorExtrude.setDepth(u, 'vector', d, token);
	}, star);
	h.check(
		(await undoDepth(A.page)) === u4 + 1,
		`§4 four steps in one gesture fold into ONE geometry entry (${(await undoDepth(A.page)) - u4})`
	);
	await undo(A.page);
	h.check(
		Math.abs(depthOf(await facts(A.page, star)) - depthOf(s1)) < 1e-9,
		'§4 its undo goes straight back to the depth before the scrub'
	);

	// ---- §5 bevel + steps -------------------------------------------------------------------
	await A.page.evaluate(
		(u) =>
			window.__tp.test.v1.vectorActions.setVectorParams(u, {
				depth: 0.3,
				bevel: 0.04,
				bevelSegments: 3
			}),
		star
	);
	const s5 = await facts(A.page, star);
	h.check(
		Math.abs(s5.zmin) < 1e-4 && Math.abs(s5.zmax - 0.3) < 1e-3,
		`§5 a bevelled solid stays inside z 0..depth (${s5.zmin?.toFixed(4)}..${s5.zmax?.toFixed(4)})`
	);
	await h.eventually(
		() => facts(B.page, star),
		(f) => f?.params?.bevelSegments === 3 && f.verts === s5.verts,
		'§5 B builds the same bevelled solid (bevelSegments rides the record)'
	);

	// ---- §6 budget -----------------------------------------------------------------------
	const star64 = await A.page.evaluate(
		() =>
			window.__tp.test.v1.vectorActions.placeVectorShape('star', [-2.2, 0, 0], {
				points: 32,
				radius: 0.8
			})?.uuid
	);
	await select(A.page, star64);
	const a6 = await arrowOn(A.page, star64, '§6 premise: the arrow on a 64-point star');
	const watch = () =>
		A.page.evaluate(() => {
			window.__frames = [];
			let last = performance.now();
			const loop = (t) => {
				window.__frames.push(t - last);
				last = t;
				if (window.__frames.length < 100000) window.__frameRaf = requestAnimationFrame(loop);
			};
			window.__frameRaf = requestAnimationFrame(loop);
			window.__long = [];
			window.__t0 = performance.now();
			try {
				window.__lto = new PerformanceObserver((l) =>
					l.getEntries().forEach((e) => window.__long.push([e.startTime - window.__t0, e.duration]))
				);
				window.__lto.observe({ entryTypes: ['longtask'] });
			} catch {}
		});
	const read = () =>
		A.page.evaluate(() => {
			cancelAnimationFrame(window.__frameRaf);
			window.__lto?.disconnect();
			const f = window.__frames.slice(2);
			// the longest task and when it began (ms after the watch started; the press follows at once)
			const top = window.__long.reduce((m, e) => (e[1] > m[1] ? e : m), [0, 0]);
			return {
				frames: f.length,
				worst: Math.max(...f),
				long: top[1],
				at: Math.round(top[0]),
				n: window.__long.length
			};
		});
	const builds = () => A.page.evaluate(() => window.__tp.test.v1.vectorMesh.vectorMeshDebug());
	const posOf = (u) =>
		A.page.evaluate((id) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			return g.getObjectByProperty('uuid', id)?.position.toArray();
		}, u);
	const p6 = await posOf(star64);
	const b6 = await builds();
	await watch();
	await dragArrow(A.page, a6, 160, { steps: 30, pause: 16 });
	const f6 = await read();
	const b6e = await builds();
	h.check(depthOf(await facts(A.page, star64)) > 0.05, '§6 the 64-point star extruded');
	h.check(
		JSON.stringify(await posOf(star64)) === JSON.stringify(p6),
		'§6 the drag never moves the star (the gizmo under the arrow stands down)'
	);
	h.check(
		f6.long < 50,
		`§6 the 64-point star drag blocks no frame for 50 ms or more (longest task ${f6.long.toFixed(0)} ms at +${f6.at} ms of ${f6.n} long, worst frame ${f6.worst.toFixed(0)} ms over ${f6.frames}; ${b6e.fullBuilds - b6.fullBuilds} full + ${b6e.fastBuilds - b6.fastBuilds} depth-only builds)`
	);
	const path = await A.page.evaluate(() => {
		const nodes = Array.from({ length: 2000 }, (_, i) => {
			const a = (i / 2000) * 2 * Math.PI;
			const r = 0.9 + 0.08 * Math.sin(a * 37);
			return { x: r * Math.cos(a), y: r * Math.sin(a) };
		});
		const s = window.__tp.test.v1;
		const m = s.vectorActions.placeVectorShape('path', [2.2, 0, -2.5], {
			paths: [{ closed: true, nodes }],
			fillType: 'solid',
			strokeWidth: 0
		});
		const t = performance.now();
		s.vectorActions.setVectorParams(m.uuid, { depth: 0.2, bevel: 0.02 });
		return {
			uuid: m.uuid,
			ms: performance.now() - t,
			solid: s.vectorMesh.vectorMeshDebug().lastSolid
		};
	});
	h.check(
		path.ms < 300,
		`§6 a 2 000-point path extrudes (full build, bevelled) in under 300 ms (${path.ms.toFixed(0)} ms; kernel ${path.solid?.ms?.toFixed(0)} ms)`
	);
	await select(A.page, path.uuid);
	const a6b = await arrowOn(A.page, path.uuid, '§6 premise: the arrow on the 2 000-point path');
	await watch();
	await dragArrow(A.page, a6b, 120, { steps: 24, pause: 16 });
	const f6b = await read();
	h.check(
		f6b.long < 100,
		`§6 a depth drag on the 2 000-point path blocks no frame for 100 ms or more (longest task ${f6b.long.toFixed(0)} ms at +${f6b.at} ms of ${f6b.n} long, worst frame ${f6b.worst.toFixed(0)} ms)`
	);
	// a heavy record's drag goes on the wire every ~120 ms and once on release: B ends on the same depth
	const dA = depthOf(await facts(A.page, path.uuid));
	await h.eventually(
		() => facts(B.page, path.uuid),
		(f) => f && Math.abs(depthOf(f) - dA) < 1e-9 && dA > 0.2,
		`§6 B ends on the 2 000-point path's dragged depth (${dA?.toFixed(3)}; throttled sends + the release)`
	);

	// ---- §7 Escape ---------------------------------------------------------------------
	await select(A.page, star64);
	const a7 = await arrowOn(A.page, star64, '§7 premise: the arrow again');
	const d7 = depthOf(await facts(A.page, star64));
	const u7 = await undoDepth(A.page);
	await dragArrow(A.page, a7, 80, { beforeUp: () => A.page.keyboard.press('Escape') });
	h.check(
		Math.abs(depthOf(await facts(A.page, star64)) - d7) < 1e-9,
		'§7 Escape mid-drag puts the depth back'
	);
	h.check(
		(await undoDepth(A.page)) === u7,
		`§7 ...and leaves no undo step (${(await undoDepth(A.page)) - u7})`
	);

	// ---- §8 Bake ------------------------------------------------------------------------
	const u8 = await undoDepth(A.page);
	const before8 = await facts(A.page, star);
	const baked = await A.page.evaluate(
		(u) => window.__tp.test.v1.vectorActions.bakeVectorToMesh(u),
		star
	);
	h.check(baked?.ok, `§8 Bake to mesh runs on the extruded star (${JSON.stringify(baked)})`);
	const after8 = await facts(A.page, star);
	h.check(
		after8.gtype === null &&
			after8.verts === before8.verts &&
			after8.topoFaces === before8.topoFaces,
		`§8 A: a plain mesh, same triangles, the kernel faces kept (${after8.verts} verts, ${after8.topoFaces} faces)`
	);
	await h.eventually(
		() => facts(B.page, star),
		(f) => !!f && f.gtype === null && f.verts === before8.verts,
		'§8 B: the record is gone, the same mesh stays'
	);
	h.check((await undoDepth(A.page)) === u8 + 1, '§8 Bake is ONE undo entry');
	await select(A.page, star);
	await A.page.waitForTimeout(300);
	h.check((await arrow(A.page)).target !== star, '§8 a baked shape has no extrude arrow');
	await undo(A.page);
	await h.eventually(
		() => facts(B.page, star),
		(f) => f?.gtype === 'Vector' && Math.abs(depthOf(f) - depthOf(before8)) < 1e-9,
		'§8 ONE undo brings the shape (its record) back on A and B'
	);

	h.check(
		(A.page.__errors ?? []).length === 0 && (B.page.__errors ?? []).length === 0,
		`no page errors (${[...(A.page.__errors ?? []), ...(B.page.__errors ?? [])].join(' | ') || 'none'})`
	);
	await h.finish(browser);
});

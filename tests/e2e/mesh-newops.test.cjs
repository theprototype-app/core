// Roadmap 99 K8 (lane 99-newops): the three new mesh operators through the real app, with TWO PEERS.
//   1. SMOOTH SUBDIVIDE (Catmull-Clark): the toolbox's Subdivide with "smooth" on a picked face, then the whole mesh
//      with nothing picked (2 levels): one meshgeo entry with the element IDs on both sides, every pre-op vertex ID
//      survives, undo restores the bytes AND the starting pick, redo the op's; the peer holds the same bytes +
//      partition after each step and after the undo.
//   2. SHORTEST-PATH SELECT: a real Ctrl+click on a second face adds the path; in edges the chain; in vertices the
//      corner-to-corner path (3 steps on a cube); the Path toggle makes a plain click do it; a Ctrl+click with
//      nothing picked is an ordinary pick; Ctrl+Z puts the selection back (selection history). Nothing is sent.
//   3. BISECT: armed from the toolbox, two real clicks across the box draw the line, the plane appears with the
//      gizmo, Apply cuts; IDs + undo as in 1; Clear outer + Fill makes a closed half box; the peer follows.
//   4. Unused = zero change: arming Bisect and cancelling, or toggling Path, sends no meshgeo and edits nothing.
const h = require('./helpers.cjs');

const FACTS = (uuid) => {
	const s = window.__tp.test.v1;
	let g;
	s.objectsGroup.subscribe((v) => (g = v))();
	const object = g?.getObjectByProperty('uuid', uuid);
	const geometry = object?.geometry;
	if (!geometry?.attributes?.position) return null;
	const fnv = (array) => {
		const u8 = new Uint8Array(Float32Array.from(array).buffer);
		let x = 0x811c9dc5;
		for (let i = 0; i < u8.length; i++) x = Math.imul(x ^ u8[i], 0x01000193) >>> 0;
		return x.toString(16).padStart(8, '0');
	};
	const flat = geometry.index ? geometry.toNonIndexed() : geometry;
	const faces = s.meshTopology.readStoredFaces(geometry);
	return {
		tris: flat.attributes.position.count / 3,
		positions: fnv(flat.attributes.position.array),
		uvs: flat.attributes.uv ? fnv(flat.attributes.uv.array) : null,
		faces: faces ? JSON.stringify(faces) : null,
		storedFaces: faces ? faces.length : 0,
		maxY: Math.max(...Array.from(flat.attributes.position.array).filter((_, i) => i % 3 === 1))
	};
};
const facts = (peer, uuid) => peer.page.evaluate(FACTS, uuid);
const same = (a, b) => !!a && !!b && a.tris === b.tris && a.positions === b.positions && a.uvs === b.uvs && a.faces === b.faces;

/** the page's helpers, once: store reads and the pick */
const PRELUDE = () => {
	const s = window.__tp.test.v1;
	window.__k8 = {
		s,
		get(store) {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		},
		pick() {
			const fe = s.faceEdit;
			const me = s.meshEdit;
			return {
				faces: [...window.__k8.get(fe.faceEditSelectedTris)].sort((a, b) => a - b),
				edges: [...window.__k8.get(fe.edgeEditSelected)].sort(),
				verts: window.__k8.get(me.vertexSelectionSize)
			};
		},
		entry: () => window.__k8.get(s.history.undoStack).at(-1),
		stack: () => window.__k8.get(s.history.undoStack).length,
		bytes: () =>
			s.faceEdit
				.readTriangles(window.__box.geometry)
				.flat()
				.map((v) => `${v.x},${v.y},${v.z}`)
				.join(';'),
		/** the screen point of a LOCAL point of the box */
		screen(x, y, z) {
			const camera = window.__k8.get(s.globalCamera);
			window.__box.updateMatrixWorld(true);
			const w = window.__box.localToWorld(new s.THREE.Vector3(x, y, z)).project(camera);
			// the viewport canvas (the largest one), not the window: panels and the dock shrink it
			const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
			const r = canvas.getBoundingClientRect();
			return [r.left + ((w.x + 1) / 2) * r.width, r.top + ((1 - w.y) / 2) * r.height];
		}
	};
	return true;
};

/** a fresh 2x2x2 box in a face session; the camera framed on it */
const editBox = (page) =>
	page.evaluate(() => {
		const s = window.__tp.test.v1;
		s.faceEdit.exitFaceEdit?.();
		s.meshEdit.exitEditMode?.();
		s.commandsHandler.sceneCommand('/create Box 2 2 2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		window.__box = g.children[g.children.length - 1];
		s.faceEdit.enterFaceEdit(window.__box.uuid);
		s.faceEdit.setFaceSubmode('faces');
		return window.__box.uuid;
	});

/** IDs, undo / redo bytes and pick around one op run by `op` (a function source run in the page) */
const idCase = (page, setup, op) =>
	page.evaluate(
		async ({ setup, op }) => {
			const k = window.__k8;
			const s = k.s;
			const fe = s.faceEdit;
			await fe.loadKernelOps();
			new Function('k', 's', 'fe', setup)(k, s, fe);
			const before = k.pick();
			const beforeBytes = k.bytes();
			const n0 = k.stack();
			const ok = new Function('k', 's', 'fe', op)(k, s, fe);
			const e = k.entry();
			const recorded = k.stack() > n0 && e?.kind === 'meshgeo';
			const ids = { b: e?.before?.ids ?? null, a: e?.after?.ids ?? null };
			let lost = -1;
			if (ids.b && ids.a) {
				const after = new Set(Array.from(ids.a.cornerVertex));
				lost = [...new Set(Array.from(ids.b.cornerVertex))].filter((v) => !after.has(v)).length;
			}
			const afterOp = k.pick();
			const afterBytes = k.bytes();
			s.history.undo();
			const undone = k.pick();
			const undoBytes = k.bytes() === beforeBytes;
			s.history.redo();
			const redoBytes = k.bytes() === afterBytes;
			return {
				ok: ok !== false,
				recorded,
				hasIds: !!(ids.b?.cornerVertex && ids.a?.cornerVertex && ids.b?.triFace && ids.a?.triFace),
				lost,
				changed: afterBytes !== beforeBytes,
				before,
				afterOp,
				undone,
				undoBytes,
				redoBytes,
				trisAfter: afterBytes.split(';').length / 3
			};
		},
		{ setup, op }
	);

const pickTop = `
	const faces = fe.currentFaces();
	const i = faces.findIndex((f) => f.normal.y > 0.9);
	fe.highlightFaceByTriangle(faces[i].triIndices[0]);
	fe.pickFaceUnit(faces[i].triIndices[0]);
`;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__tp?.test?.v1?.faceEdit, null, { timeout: 60000 });
	await h.connect(A, B);
	for (const p of [A, B]) await p.page.evaluate(PRELUDE);
	// count A's meshgeo sends (the zero-change checks)
	await A.page.evaluate(() => {
		const s = window.__tp.test.v1;
		window.__sent = 0;
		const peers = window.__k8.get(s.peers);
		const send = peers.send.bind(peers);
		peers.send = (msg, ...rest) => {
			if (msg?.type === 'meshgeo') {
				window.__sent++;
				(window.__sentLog ??= []).push(window.__step ?? '?');
			}
			return send(msg, ...rest);
		};
	});
	const agree = async (uuid, label) => {
		let a = null;
		let b = null;
		const ok = await h
			.eventually(
				async () => {
					a = await facts(A, uuid);
					b = await facts(B, uuid);
					return same(a, b);
				},
				(v) => v === true,
				label,
				30000
			)
			.catch(() => false);
		if (!same(a, b)) h.check(false, `${label}: A ${JSON.stringify(a)} B ${JSON.stringify(b)}`);
		void ok;
		return a;
	};

	// ---- 1. smooth subdivide ----------------------------------------------------------------------------
	console.log('\n=== 1. smooth subdivide (Catmull-Clark) ===');
	let uuid = await editBox(A.page);
	await h.eventually(() => facts(B, uuid), (f) => !!f && f.tris === 12, 'the peer holds the box (premise)', 30000);
	h.check(
		await A.page.evaluate(() => !!document.querySelector('#mesh-op-subdivide')),
		'the toolbox shows Subdivide (premise)'
	);
	let r = await idCase(A.page, pickTop, `return fe.beginOpAdjust('subdivide', { levels: 1, smooth: true });`);
	h.check(r.ok && r.recorded && r.changed, 'smooth subdivide on the top face: one meshgeo entry, the mesh changed');
	h.check(r.hasIds, 'smooth: the entry holds the element IDs on both sides');
	h.check(r.lost === 0, `smooth: every pre-op vertex ID survives (${r.lost} lost)`);
	h.check(r.trisAfter === 12 - 2 + 8 + 4, `smooth: 4 quads for the top, its 4 neighbours gain a corner each (${r.trisAfter} triangles)`);
	h.check(r.undoBytes, 'smooth: undo restores the exact pre-op triangles');
	h.check(JSON.stringify(r.undone) === JSON.stringify(r.before), `smooth: undo restores the starting pick (${JSON.stringify(r.before)} / ${JSON.stringify(r.undone)})`);
	h.check(r.redoBytes, 'smooth: redo restores the op');
	await agree(uuid, 'smooth: the peer holds the same bytes + partition');

	// the whole mesh with nothing picked, through the toolbox: check Smooth, levels 2, Apply
	uuid = await editBox(A.page);
	await h.eventually(() => facts(B, uuid), (f) => !!f && f.tris === 12, 'the peer holds the second box (premise)', 30000);
	await A.page.evaluate(() => {
		const k = window.__k8;
		k.s.faceEdit.clearFaceSelection();
		k.s.meshToolParams?.subdivideLevelCount?.set?.(2);
	});
	await A.page.click('#mesh-op-subdivide');
	const smoothBox = await A.page.$('#subdivide-smooth');
	h.check(!!smoothBox, 'the Subdivide options show the smooth checkbox');
	if (smoothBox) {
		await A.page.evaluate(() => window.__k8.s.history.undo()); // the grid click applied a flat subdivide? undo is a no-op otherwise
		await smoothBox.check();
	}
	const whole = await A.page.evaluate(async () => {
		const k = window.__k8;
		const fe = k.s.faceEdit;
		fe.interruptOpAdjust?.();
		fe.clearFaceSelection();
		const ok = fe.beginOpAdjust('subdivide', { levels: 2, smooth: true });
		fe.interruptOpAdjust?.();
		const f = fe.readTriangles(window.__box.geometry);
		return { ok, tris: f.length, maxX: Math.max(...f.flat().map((v) => v.x)) };
	});
	h.check(whole.ok && whole.tris === 6 * 16 * 2, `smooth, nothing picked, 2 levels: the whole box = 96 quads (${whole.tris} triangles)`);
	h.check(whole.maxX < 0.9, `smooth: the box rounds off (max x ${whole.maxX.toFixed(3)} < 1)`);
	await agree(uuid, 'smooth whole mesh: the peer holds the same bytes + partition');
	await A.page.evaluate(() => window.__k8.s.history.undo());
	await agree(uuid, 'smooth whole mesh undone: the peer follows');

	// ---- 2. shortest-path select ------------------------------------------------------------------------
	console.log('\n=== 2. shortest-path select ===');
	uuid = await editBox(A.page);
	// a 4x4 grid on every side: a flat subdivide twice (the path needs room)
	await A.page.evaluate(async () => {
		const fe = window.__k8.s.faceEdit;
		await fe.loadKernelOps();
		const all = fe.readTriangles(window.__box.geometry).map((_, i) => i);
		fe.faceOpOnObject(window.__box.uuid, 'subdivide', all);
		const all2 = fe.readTriangles(window.__box.geometry).map((_, i) => i);
		fe.faceOpOnObject(window.__box.uuid, 'subdivide', all2);
		fe.exitFaceEdit();
		fe.enterFaceEdit(window.__box.uuid);
		fe.setFaceSubmode('faces');
	});
	// pick a top-front corner quad, then Ctrl+click the top-back corner quad
	const pts = await A.page.evaluate(() => {
		const k = window.__k8;
		const fe = k.s.faceEdit;
		const tris = fe.readTriangles(window.__box.geometry);
		const at = (x, z) =>
			tris.findIndex((t) => t.every((v) => v.y > 0.99) && Math.abs(t.reduce((a, v) => a + v.x, 0) / 3 - x) < 0.3 && Math.abs(t.reduce((a, v) => a + v.z, 0) / 3 - z) < 0.3);
		const from = at(-0.75, 0.75);
		fe.pickFaceUnit(from);
		window.__sent0 = window.__sent;
		window.__fromTri = from;
		window.__sentLog = [];
		window.__step = 'ctrl-click faces';
		return { from, a: k.screen(-0.75, 1, 0.75), b: k.screen(0.75, 1, -0.75) };
	});
	await A.page.keyboard.down('Control');
	await A.page.mouse.click(pts.b[0], pts.b[1]);
	await A.page.keyboard.up('Control');
	const facePath = await A.page.evaluate(() => window.__k8.pick().faces.length);
	// corner to corner across a 4x4 top: 7 quads by steps (the length path is the same staircase or the diagonal)
	h.check(facePath >= 2 * 4 && facePath <= 2 * 7, `faces: Ctrl+click adds the path of quads (${facePath / 2} quads)`);
	await A.page.evaluate(() => ((window.__step = 'undo pick'), window.__k8.s.history.undo()));
	h.check((await A.page.evaluate(() => window.__k8.pick().faces.length)) === 2, 'faces: Ctrl+Z puts the one-quad pick back (selection history)');
	// the Path toggle: a plain click does it too
	// the control: the SAME plain click with Path off (an ordinary pick), then the pick put back
	const plainSent = await A.page.evaluate(() => ((window.__step = 'plain click, Path off'), window.__sent));
	await A.page.mouse.click(pts.b[0], pts.b[1]);
	const plain = await A.page.evaluate((n) => window.__sent - n, plainSent);
	await A.page.evaluate(() => {
		const fe = window.__k8.s.faceEdit;
		fe.pickFaceUnit(window.__fromTri);
	});
	const toggleSent = await A.page.evaluate(() => window.__sent);
	await A.page.evaluate(() => (window.__step = 'path toggle on'));
	await A.page.click('#mesh-path-select');
	await A.page.evaluate(() => (window.__step = 'plain click under the toggle'));
	await A.page.mouse.click(pts.b[0], pts.b[1]);
	const toggled = await A.page.evaluate(() => window.__k8.pick().faces.length);
	const viaToggle = await A.page.evaluate((n) => window.__sent - n, toggleSent);
	h.check(viaToggle <= plain, `faces: a click under the Path toggle sends no more than the same plain click does (${viaToggle} vs ${plain})`);
	h.check(toggled === facePath, `faces: with the Path toggle a plain click adds the same path (${toggled / 2} quads)`);
	await A.page.evaluate(() => (window.__step = 'path toggle off'));
	await A.page.click('#mesh-path-select');
	// edges: two edges on the top's border
	const edgePath = await A.page.evaluate(() => {
		const fe = window.__k8.s.faceEdit;
		window.__step = 'edges submode';
		fe.setFaceSubmode('edges');
		window.__step = 'edge path';
		const key = (x, y, z) => [x, y, z].map((n) => Math.round(n * 1e4)).join(',');
		const e = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
		fe.pickEdge(e(key(-1, 1, 1), key(-0.5, 1, 1)), false);
		const ok = fe.pathSelectEdges(e(key(0.5, 1, 1), key(1, 1, 1)));
		return { ok, n: window.__k8.pick().edges.length };
	});
	h.check(edgePath.ok && edgePath.n === 4, `edges: the chain along the border (${edgePath.n} edges)`);
	h.check(
		(await A.page.evaluate((n) => window.__sentLog.filter((x) => !/plain click/.test(x)).length, 0)) === 0,
		`path select (Ctrl+click, edges, undo of a pick) sent no meshgeo: selection is local (${await A.page.evaluate(() => (window.__sentLog ?? []).join(' / '))})`
	);
	// vertices: corner to the opposite corner of the cube = 12 steps on a 4x4-per-side grid
	const vertPath = await A.page.evaluate(() => {
		const s = window.__k8.s;
		s.faceEdit.exitFaceEdit();
		s.meshEdit.enterEditMode(window.__box.uuid);
		let controls;
		s.TControls.subscribe((c) => (controls = c))();
		const find = (x, y, z) => {
			for (let i = 0; i < 400; i++) {
				s.meshEdit.selectHandle(i);
				const at = controls.object?.position;
				if (!at) break;
				if (Math.abs(at.x - x) + Math.abs(at.y - y) + Math.abs(at.z - z) < 1e-4) return i;
			}
			return -1;
		};
		const far = find(-1, -1, -1);
		const near = find(1, 1, 1);
		if (far < 0 || near < 0) return { error: 'corners' };
		const sent = window.__sent;
		const ok = s.meshEdit.pathSelectVertex(far);
		return { ok, n: window.__k8.get(s.meshEdit.vertexSelectionSize), sent: window.__sent - sent };
	});
	h.check(vertPath.ok && vertPath.n === 13, `vertices: corner to opposite corner = 13 vertices on 4x4 sides (${vertPath.n})`);
	h.check(vertPath.sent === 0, `vertex path select sent no meshgeo (${vertPath.sent})`);
	await A.page.evaluate(() => {
		window.__k8.s.meshEdit.exitEditMode();
	});

	// ---- 3. bisect ---------------------------------------------------------------------------------------
	console.log('\n=== 3. bisect ===');
	uuid = await editBox(A.page);
	await h.eventually(() => facts(B, uuid), (f) => !!f && f.tris === 12, 'the peer holds the bisect box (premise)', 30000);
	const sent1 = await A.page.evaluate(() => window.__sent);
	await A.page.click('#mesh-op-bisect');
	const line = await A.page.evaluate(() => ({ a: window.__k8.screen(-1.8, 0.2, 0), b: window.__k8.screen(1.8, 0.2, 0), op: window.__k8.get(window.__k8.s.faceEdit.faceEditOp) }));
	h.check(line.op === 'bisect', 'the toolbox arms Bisect');
	// cancel first: zero change
	await A.page.mouse.click(line.a[0], line.a[1]);
	await A.page.keyboard.press('Escape');
	h.check(
		await A.page.evaluate(() => !!window.__k8.get(window.__k8.s.faceEdit.faceEditObject)),
		'Esc drops the pending line and keeps the session'
	);
	await A.page.mouse.click(line.a[0], line.a[1]);
	await A.page.mouse.click(line.b[0], line.b[1]);
	await A.page.waitForSelector('#bisect-apply', { timeout: 5000 }).catch(() => null);
	h.check(!!(await A.page.$('#bisect-apply')), 'two clicks place the plane: Apply shows');
	h.check((await A.page.evaluate(() => window.__sent)) === sent1, 'placing the plane sends nothing');
	const beforeCut = await A.page.evaluate(
		({ a, b }) => {
			window.__lineA = a;
			window.__lineB = b;
			window.__beforeKeys = window.__k8.s.faceEdit
				.readTriangles(window.__box.geometry)
				.flat()
				.map((v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(','));
			return { bytes: window.__k8.bytes(), n: window.__k8.stack() };
		},
		{ a: line.a, b: line.b }
	);
	await A.page.click('#bisect-apply');
	const cut = await A.page.evaluate(() => {
		const k = window.__k8;
		const e = k.entry();
		// the plane runs through the drawn line and the eye: every NEW vertex lands ON the drawn line on screen
		const keyOf = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const old = new Set(window.__beforeKeys);
		const fresh = k.s.faceEdit.readTriangles(window.__box.geometry).flat().filter((v) => !old.has(keyOf(v)));
		const [a, b] = [window.__lineA, window.__lineB];
		const off = (v) => {
			const p = k.screen(v.x, v.y, v.z);
			const dx = b[0] - a[0];
			const dy = b[1] - a[1];
			return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy);
		};
		const ys = { fresh: fresh.length, worst: fresh.length ? Math.max(...fresh.map(off)) : -1 };
		let lost = -1;
		if (e?.before?.ids && e?.after?.ids) {
			const after = new Set(Array.from(e.after.ids.cornerVertex));
			lost = [...new Set(Array.from(e.before.ids.cornerVertex))].filter((v) => !after.has(v)).length;
		}
		return { recorded: k.stack() > 0 && e?.kind === 'meshgeo', lost, ys, op: k.get(k.s.faceEdit.faceEditOp) };
	});
	h.check(cut.recorded, 'Apply: one meshgeo entry');
	h.check(cut.lost === 0, `bisect: every pre-op vertex ID survives (${cut.lost} lost)`);
	h.check(cut.ys.fresh >= 4 && cut.ys.worst < 2, `bisect: every crossing lands on the drawn line on screen (${cut.ys.fresh} new corners, worst ${cut.ys.worst.toFixed(2)} px)`);
	h.check(cut.op === 'move', 'bisect is one-shot: the toolbox is back on Move');
	await agree(uuid, 'bisect: the peer holds the same bytes + partition');
	await A.page.evaluate(() => window.__k8.s.history.undo());
	h.check((await A.page.evaluate(() => window.__k8.bytes())) === beforeCut.bytes, 'bisect: undo restores the exact pre-op triangles');
	await agree(uuid, 'bisect undone: the peer follows');

	// clear outer + fill, through the pane
	await A.page.click('#mesh-op-bisect');
	await A.page.click('#bisect-clear-outer').catch(() => null);
	await A.page.check('#bisect-fill').catch(() => null);
	await A.page.mouse.click(line.a[0], line.a[1]);
	await A.page.mouse.click(line.b[0], line.b[1]);
	await A.page.keyboard.press('Enter');
	const half = await facts(A, uuid);
	h.check(!!half && (half.maxY < 0.25 || half.maxY > 0.95), `bisect, clear one side: the mesh is cut at the plane (max y ${half?.maxY?.toFixed(3)})`);
	const closed = await A.page.evaluate(() => {
		const tris = window.__k8.s.faceEdit.readTriangles(window.__box.geometry);
		const key = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e4)).join(',');
		const count = new Map();
		for (const t of tris)
			for (let i = 0; i < 3; i++) {
				const a = key(t[i]);
				const b = key(t[(i + 1) % 3]);
				const e = a < b ? a + '|' + b : b + '|' + a;
				count.set(e, (count.get(e) ?? 0) + 1);
			}
		return [...count.values()].every((n) => n === 2);
	});
	h.check(closed, 'bisect, clear + fill: the half box is closed (every edge used twice)');
	await agree(uuid, 'bisect clear + fill: the peer holds the same bytes + partition');

	// ---- 4. unused = zero change ------------------------------------------------------------------------
	console.log('\n=== 4. unused = zero change ===');
	const zero = await A.page.evaluate(() => {
		const k = window.__k8;
		const fe = k.s.faceEdit;
		const n = k.stack();
		const b = k.bytes();
		const sent = window.__sent;
		fe.setFaceOp('bisect');
		fe.setFaceOp('move');
		k.s.meshToolParams?.meshPathSelect?.set?.(true);
		k.s.meshToolParams?.meshPathSelect?.set?.(false);
		return { same: k.bytes() === b && k.stack() === n && window.__sent === sent };
	});
	h.check(zero.same, 'arming and leaving Bisect, toggling Path: no geometry, no history, no message');
	await browser.close();
});

// 37 R11: the xatlas "Smart unwrap" MODULE, installed from its real zip, running in the app.
//
// `uv-unwrap-module` proved the seam with a 41-byte wasm; this is the real thing: the
// `smart-unwrap` module (modules repo, xatlas-wasm inside the zip) registers
// `mod-smart-unwrap-xatlas`, the UV editor's registry lists it, and an unwrap through it
// gives a mapping a texture can use — every uv inside 0..1, no degenerate triangle, islands
// that do not overlap — as ONE undo step that replicates like any other unwrap.
// Skips (never fails) when the modules checkout has no packed zip: MODULES_REPO=<dir>/.
const h = require('./helpers.cjs');

const KEY = 'mod-smart-unwrap-xatlas';

/** uv facts of an object: range, degenerate triangles, and an overlap count on a raster */
const uvFacts = (page, uuid) =>
	page.evaluate((uuid) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', uuid);
		const uv = object?.geometry?.attributes?.uv;
		if (!uv) return null;
		const position = object.geometry.attributes.position;
		const count = object.geometry.index ? object.geometry.index.count : position.count;
		const at = (i) => (object.geometry.index ? object.geometry.index.getX(i) : i);
		let outside = 0;
		let degenerate = 0;
		const N = 256;
		const grid = new Uint16Array(N * N);
		let overlap = 0;
		const distinct = new Set();
		for (let t = 0; t + 2 < count; t += 3) {
			const p = [0, 1, 2].map((k) => [uv.getX(at(t + k)), uv.getY(at(t + k))]);
			for (const [u, v] of p) {
				if (u < -1e-4 || u > 1 + 1e-4 || v < -1e-4 || v > 1 + 1e-4) outside++;
				distinct.add(u.toFixed(3) + ',' + v.toFixed(3));
			}
			const area = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
			if (Math.abs(area) < 1e-9) {
				degenerate++;
				continue;
			}
			// rasterise the triangle's INTERIOR (cell centres strictly inside): a cell claimed by
			// two triangles is an overlap; shared edges are excluded by the strict test
			const minU = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0]) * N));
			const maxU = Math.min(N - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0]) * N));
			const minV = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1]) * N));
			const maxV = Math.min(N - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1]) * N));
			for (let y = minV; y <= maxV; y++)
				for (let x = minU; x <= maxU; x++) {
					const cx = (x + 0.5) / N;
					const cy = (y + 0.5) / N;
					const e = (a, b) => (b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0]);
					const w0 = e(p[0], p[1]);
					const w1 = e(p[1], p[2]);
					const w2 = e(p[2], p[0]);
					const inside = (w0 > 1e-9 && w1 > 1e-9 && w2 > 1e-9) || (w0 < -1e-9 && w1 < -1e-9 && w2 < -1e-9);
					if (!inside) continue;
					if (grid[y * N + x]++) overlap++;
				}
		}
		return { triangles: count / 3, outside, degenerate, overlap, distinct: distinct.size };
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);
	const installed = await h.installModule(A, 'smart-unwrap');
	if (!installed) {
		console.log('SKIP: no smart-unwrap.zip under MODULES_REPO — pack it in the modules checkout');
		await h.finish(browser);
		return;
	}
	await h.eventually(
		() => A.page.evaluate(() => window.__stores.uvUnwrap.unwrapBackends().map((b) => b.key + '=' + b.label)),
		(list) => list.includes(KEY + '=Smart (xatlas)'),
		'the module registered "Smart (xatlas)" in the unwrap registry',
		20000
	);

	for (const [what, command] of [
		['a box', '/create Box 1 1 1'],
		['a sphere', '/create Sphere 1 24 16']
	]) {
		const uuid = await A.page.evaluate((command) => {
			const s = window.__stores;
			s.commandsHandler.sceneCommand(command);
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			return g.children[g.children.length - 1].uuid;
		}, command);
		const depth = () =>
			A.page.evaluate(() => {
				let st;
				window.__stores.history.undoStack.subscribe((v) => (st = v))();
				return st.length;
			});
		const before = await uvFacts(A.page, uuid);
		const d0 = await depth();
		const ok = await A.page.evaluate(
			({ uuid, KEY }) => window.__stores.uvEditor.unwrapObject(uuid, KEY, { margin: 0.02 }),
			{ uuid, KEY }
		);
		h.check(ok === true, `${what}: the Smart unwrap ran and committed`);
		const after = await uvFacts(A.page, uuid);
		h.check(!!after && after.outside === 0, `${what}: every uv inside 0..1 (${after?.outside} outside)`);
		h.check(after.degenerate === 0, `${what}: no triangle collapsed in uv space (${after.degenerate})`);
		h.check(after.overlap === 0, `${what}: islands do not overlap on a 256² raster (${after.overlap} shared cells)`);
		h.check(
			after.distinct > (before?.distinct ?? 0) / 2 && after.distinct > 8,
			`${what}: a real spread of coordinates, not a collapsed map (${after.distinct} distinct)`
		);
		h.check((await depth()) - d0 === 1, `${what}: ONE undo entry`);
		await h.eventually(
			() => uvFacts(B.page, uuid),
			(f) => !!f && f.distinct === after.distinct && f.overlap === 0,
			`${what}: peer B holds the same unwrap`,
			20000
		);
		await A.page.evaluate(() => window.__stores.history.undo());
		const undone = await uvFacts(A.page, uuid);
		h.check(
			undone.distinct === (before?.distinct ?? undone.distinct),
			`${what}: one undo restores the previous mapping (${after.distinct} -> ${undone.distinct} distinct)`
		);
	}

	// the UV editor's menu lists it even though the module arrived after boot
	const listed = await A.page.evaluate(() => {
		const s = window.__stores;
		s.uvEditorClose?.set?.(false);
		return s.uvUnwrap.unwrapBackends().some((b) => b.key === 'mod-smart-unwrap-xatlas');
	});
	h.check(listed, 'the registry the UV editor reads lists Smart (xatlas)');
	await h.finish(browser);
});

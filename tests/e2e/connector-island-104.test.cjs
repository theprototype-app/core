// Roadmap 104 A1-A5 (lane 104-bugs) — the owner's island, replayed through a real connector tab against the fake relay
// (the connector-fixes pattern; the scout's repro, ~/.code/lanes-30/104-mcp-scout/repro/repro.cjs, made a suite):
// terrain {size 24, height 2.5, edges island} + water {kind ocean, 80 × 2 × 80, top at 0.4}.
//   1. A2 the island's rim sinks to -2 m on a new island; water answers surface + waves {height} and the band warning
//   2. A1 "on the ground": a box made at y 0 and a Campfire group stand on the ISLAND (they stood on the sea at 0.4 m);
//      out at sea a box passes through the water
//   3. A3 flatten through the assistant: pad {y, radius}; the host's terrain keeps 4,608 upward triangles (base: 800
//      junk ones, no index) and still fills a top-view picture; undo_last brings back a whole island
//   4. A4 the default iso shot frames the content (the ocean is left out and named); subject "scene" frames it all
//   5. A5 the Ocean row is water {preset, colours, level, surface, waves}, not its box colour; a screenshot answers
//      frame: the picture in words
// Run: e2e-slot --dev <tree> 7172 -- node tests/e2e/connector-island-104.test.cjs
const h = require('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = require('./connectorFake.cjs');

/** the base64 picture inside a screenshot answer @param {any} r */
const imageOf = (r) => {
	let img = null;
	const walk = (/** @type {any} */ o) => {
		if (img || !o) return;
		if (typeof o === 'object' && typeof o.data === 'string' && /^image\//.test(o.mimeType ?? '')) img = { data: o.data, mimeType: o.mimeType };
		else if (typeof o === 'object') for (const v of Object.values(o)) walk(v);
	};
	walk(r);
	return img;
};

/** the share of a picture that is not the background (the corner pixels' colour), decoded in the page */
const coverOf = (page, img) =>
	page.evaluate(async ({ data, mimeType }) => {
		const el = new Image();
		await new Promise((res, rej) => {
			el.onload = res;
			el.onerror = rej;
			el.src = 'data:' + mimeType + ';base64,' + data;
		});
		const c = document.createElement('canvas');
		c.width = el.naturalWidth;
		c.height = el.naturalHeight;
		const ctx = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
		ctx.drawImage(el, 0, 0);
		const px = ctx.getImageData(0, 0, c.width, c.height).data;
		const at = (/** @type {number} */ x, /** @type {number} */ y) => (y * c.width + x) * 4;
		const bg = [at(1, 1), at(c.width - 2, 1)].map((i) => [px[i], px[i + 1], px[i + 2]]);
		let off = 0;
		for (let i = 0; i < px.length; i += 4) if (bg.every((b) => Math.abs(px[i] - b[0]) + Math.abs(px[i + 1] - b[1]) + Math.abs(px[i + 2] - b[2]) > 40)) off++;
		return off / (px.length / 4);
	}, img);

/** what the host holds for a terrain: triangles, index, upward triangles, lowest point */
const terrainOf = (page, uuid) =>
	page.evaluate((u) => {
		/** @type {any} */ let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o?.geometry?.attributes?.position) return null;
		const p = o.geometry.attributes.position;
		const idx = o.geometry.index;
		const n = idx ? idx.count : p.count;
		const k = (/** @type {number} */ i) => (idx ? idx.getX(i) : i);
		let up = 0;
		let minY = Infinity;
		for (let i = 0; i < p.count; i++) minY = Math.min(minY, p.getY(i));
		for (let t = 0; t + 2 < n; t += 3) {
			const a = k(t), b = k(t + 1), c = k(t + 2);
			const ux = p.getX(b) - p.getX(a), uz = p.getZ(b) - p.getZ(a), vx = p.getX(c) - p.getX(a), vz = p.getZ(c) - p.getZ(a);
			// the normal's y of (b - a) × (c - a): positive = facing up
			if (uz * vx - ux * vz > 1e-9) up++;
		}
		return { tris: n / 3, indexed: !!idx, up, minY: Math.round(minY * 1000) / 1000 };
	}, uuid);

/** the world y of an object's lowest point */
const baseOf = (page, uuid) =>
	page.evaluate((u) => {
		/** @type {any} */ let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return null;
		let min = Infinity;
		o.updateWorldMatrix(true, true);
		o.traverse((/** @type {any} */ c) => {
			const p = c.geometry?.attributes?.position;
			if (!p) return;
			const m = c.matrixWorld.elements;
			for (let i = 0; i < p.count; i++) min = Math.min(min, m[1] * p.getX(i) + m[5] * p.getY(i) + m[9] * p.getZ(i) + m[13]);
		});
		return Math.round(min * 1000) / 1000;
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	await A.page.evaluate(() => window.__tp.test.v1.aiAssistantHidden.set(''));
	const relay = await fakeRelay(A.page);
	await installProvider(A.page);
	await A.page.locator('#connect-claude-button').click();
	await h.eventually(() => connectorPhase(A), (p) => p === 'connected', 'connected', 30000);
	let seq = 0;
	/** @returns {Promise<any>} the result, or {error} */
	const call = async (tool, args = {}, scope = 'edit', timeout = 120000) => {
		const id = 'c' + ++seq;
		relay.call(id, tool, args, scope);
		const a = await relay.answer(id, timeout);
		return a ? (a.type === 'result' ? a.result : { error: a.error }) : { error: 'no answer' };
	};
	const short = (/** @type {any} */ v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 300 ? '<' + x.length + ' chars>' : x)).slice(0, 700);

	// ---- 1. A2: the island and the sea --------------------------------------------------------------------------
	const terr = await call('terrain', { size: 24, height: 2.5, edges: 'island', name: 'Island' });
	const T = terr?.created?.[0]?.uuid;
	h.check(!!T && terr.created[0].peak > 2.3, '1. the island is made, peak ' + terr?.created?.[0]?.peak);
	await h.eventually(() => terrainOf(A.page, T), (t) => !!t && t.minY < -1.9, '1. A2 its rim sits 2 m under 0 (it was a flat skirt at exactly 0)', 20000);
	const water = await call('water', { kind: 'ocean', size: [80, 2, 80], position: [0, -1.6, 0], name: 'Ocean' });
	const W = water?.created?.[0]?.uuid;
	const wrow = water?.created?.[0] ?? {};
	h.check(!!W && Math.abs(wrow.surface - 0.4) < 0.01, '1. the ocean answers its surface at 0.4 m: ' + short(wrow));
	h.check(Math.abs((wrow.waves?.height ?? 0) - 1.208) < 0.02, '1. A2 and how high its waves run (1.2 m): ' + short(wrow.waves));
	h.check(/waves rise and fall .* Island .*lies inside that band/.test(wrow.warnings?.[0] ?? '') && wrow.waves?.groundInBand > 16, '1. A2 a warning names the island in the wave band: ' + (wrow.warnings?.[0] ?? 'none').slice(0, 200));

	// ---- 2. A1: on the ground -----------------------------------------------------------------------------------
	const mk = async (name, at, extra = {}) => {
		const r = await call('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name, position: at, scale: [0.4, 0.4, 0.4], ...extra }] });
		return { r, uuid: r?.created?.[0]?.uuid };
	};
	const a = await mk('crate', [0.37, 0, 0.41], { snap: 'floor' });
	const placed = a.r?.created?.[0]?.placed ?? {};
	h.check(placed.on === 'Island' && placed.surface === 'terrain' && placed.uuid === T, '2. A1 a box made at y 0 stands on the Island, not the Ocean: ' + short(placed));
	const crateBase = a.uuid ? await baseOf(A.page, a.uuid) : null;
	h.check(crateBase !== null && crateBase > 1 && Math.abs(crateBase - placed.y) < 0.02, '2. A1 its base is at the island height the answer says (' + crateBase + ' vs ' + placed.y + '; the sea is at 0.4)');
	const logs = await call('create_objects', {
		objects: [
			{ kind: 'primitive', primitive: 'Cylinder', name: 'log1', position: [0.2, 0.1, 0.41], scale: [0.2, 0.6, 0.2], rotation: [0, 0, 90] },
			{ kind: 'primitive', primitive: 'Cone', name: 'flame', position: [0.37, 0.4, 0.41], scale: [0.3, 0.5, 0.3] }
		]
	});
	const grp = await call('group_objects', { name: 'Campfire', memberUuids: (logs?.created ?? []).map((c) => c.uuid) });
	const G = grp?.uuid ?? grp?.group?.uuid ?? grp?.created?.[0]?.uuid;
	const gs = await call('update_objects', { updates: [{ uuid: G, snap: 'floor' }] });
	const gPlaced = gs?.updated?.[0]?.placed ?? gs?.placed ?? {};
	h.check(gPlaced.on === 'Island' && gPlaced.surface === 'terrain', '2. A1 the Campfire group stands on the Island: ' + short(gs));
	const sea = await mk('buoy', [30, 1, 30], { snap: 'floor' });
	h.check(sea.r?.created?.[0]?.placed?.surface === 'ground', '2. A1 out at sea it passes through the water to the ground: ' + short(sea.r?.created?.[0]?.placed));

	// ---- 3. A3: flatten -----------------------------------------------------------------------------------------
	const before = await terrainOf(A.page, T);
	h.check(before?.tris === 4608, '3. premise: the island has 4,608 triangles: ' + short(before));
	const flat = await call('terrain', { uuid: T, ops: [{ op: 'flatten', at: [0, 0], radius: 1.5 }] });
	const frow = flat?.updated?.[0] ?? {};
	h.check(frow.ok === true && frow.pad?.radius === 1.5 && frow.pad.y > 0.5, '3. A3 flatten answers the pad it made: ' + short(frow.pad));
	await A.page.waitForTimeout(800);
	const after = await terrainOf(A.page, T);
	h.check(after?.tris === 4608 && after.up === 4608 && after.indexed === false, '3. A3 the host keeps 4,608 upward triangles (base: 800 junk, no index): ' + short(after));
	const top = await call('screenshot', { view: 'top', uuid: T, size: 512 });
	const topImg = imageOf(top);
	const cover = topImg ? await coverOf(A.page, topImg) : 0;
	h.check(cover > 0.5, '3. A3 pixels: the island still fills a top-view picture framed on it (' + Math.round(cover * 100) + ' % of it is not sky)');
	const back = await call('undo_last', {});
	const undone = await terrainOf(A.page, T);
	h.check(!back?.error && undone?.tris === 4608 && undone.up === 4608, '3. A3 undo_last brings back a whole island: ' + short(undone));

	// ---- 4. A4: the content, not the ocean -----------------------------------------------------------------------
	const iso = await call('screenshot', { view: 'iso', size: 512 });
	const cam = iso?.camera ?? {};
	const dist = (c) => (c.position && c.target ? Math.hypot(c.position[0] - c.target[0], c.position[1] - c.target[1], c.position[2] - c.target[2]) : Infinity);
	h.check(cam.subject?.kind === 'content' && (cam.subject.leftOut ?? []).some((l) => l.name === 'Ocean' && l.kind === 'water'), '4. A4 the default iso shot frames the content and names the Ocean it left out: ' + short(cam.subject));
	const whole = await call('screenshot', { view: 'iso', subject: 'scene', size: 512 });
	h.check(whole?.camera?.subject?.kind === 'scene' && dist(whole.camera) > 3 * dist(cam), '4. A4 subject "scene" frames everything, from much further (' + Math.round(dist(whole.camera ?? {})) + ' m vs ' + Math.round(dist(cam)) + ' m)');
	const isoImg = imageOf(iso);
	const isoCover = isoImg ? await coverOf(A.page, isoImg) : 0;
	const wholeImg = imageOf(whole);
	const wholeCover = wholeImg ? await coverOf(A.page, wholeImg) : 0;
	h.check(isoCover > 0.2, '4. A4 pixels: the content shot is mostly scene, not sky (' + Math.round(isoCover * 100) + ' %; the whole-scene shot ' + Math.round(wholeCover * 100) + ' %)');
	const bad = await call('screenshot', { subject: 'sea' });
	h.check(!!bad?.error && /subject/.test(JSON.stringify(bad.error)), '4. A4 a wrong subject is refused with the choices: ' + short(bad.error));

	// ---- 5. A5: the water row, the frame text --------------------------------------------------------------------
	const ls = await call('list_scene', {}, 'read');
	const rows = ls?.objects ?? [];
	const orow = rows.find((r) => r.uuid === W);
	h.check(orow?.water?.preset === 'ocean' && orow.water.shallowColor === '#3fb6c8' && orow.water.deepColor === '#06304a' && orow.color === undefined, '5. A5 the Ocean row is water {preset, colours}, not its box colour: ' + short(orow?.water ?? orow));
	h.check(orow?.water?.level === 1 && Math.abs(orow.water.surface - 0.4) < 0.01 && orow.water.waves?.height > 1.2, '5. A5 and how full it is, its surface, its waves: ' + short(orow?.water));
	const trow = rows.find((r) => r.uuid === T);
	h.check(!!trow && trow.water === undefined && typeof trow.color === 'string', '5. the Island row keeps its colour and has no water: ' + short({ color: trow?.color, water: trow?.water }));
	h.check(typeof iso?.frame === 'string' && /Island/.test(iso.frame) && /Left out of the framing: Ocean \(water\)/.test(iso.frame), '5. A5 a screenshot answers frame, the picture in words: ' + (iso?.frame ?? 'none'));
	h.check(/Under the camera: /.test(whole?.frame ?? '') && /Ocean/.test(whole?.frame ?? ''), '5. A5 the whole-scene frame names the Ocean: ' + (whole?.frame ?? 'none'));

	await browser.close();
});

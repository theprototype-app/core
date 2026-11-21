// 102 M6 — PAINT ON MESHES: roughness / metalness / emission channels, the new brush kinds, model strokes, the
// vertex-colour fallback, the live wire to a second peer, undo, reload and GLB export, and the memory gate.
//
// What is asserted is PIXELS, by hash (meshPaint.mapHash: the bytes a channel READS — green for roughness, blue for
// metalness — in one row order), so "the peer sees the same thing" cannot pass on "it has a texture".
const h = require('./helpers.cjs');

/** create a mesh by command, name it, select it, UV editor open on Paint @returns {Promise<string>} its uuid */
const make = (page, cmd, name) =>
	page.evaluate(
		async ({ cmd, name }) => {
			const w = window.__tp.test.v1;
			w.commandsHandler.sceneCommand(cmd);
			const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const o = g.children[g.children.length - 1];
			o.name = name;
			w.objectActions.selectObject(o.uuid);
			w.uvEditorClose.set(false);
			w.bottomDock.activateDock('uv');
			w.uvEditor.uvTool.set('paint');
			return o.uuid;
		},
		{ cmd, name }
	);

/** set the brush through the panel's own stores */
const brush = (page, b) =>
	page.evaluate(async (b) => {
		const w = window.__tp.test.v1;
		const p = w.meshPaintPrefs;
		p.paintChannel.set(b.ch ?? 'color');
		p.paintValue.set(b.value ?? 0.5);
		p.paintHardness.set(b.hardness ?? 1);
		p.paintOpacity.set(b.opacity ?? 1);
		p.paintFlow.set(b.flow ?? 1);
		p.paintErase.set(!!b.erase);
		p.paintMirror.set(!!b.mirror);
		p.paintStamp.set('');
		p.paintMapSize.set(b.mapSize ?? 1024);
		w.uvEditor.uvBrushSize.set(b.size ?? 64);
		if (b.color) w.uvEditor.uvBrushColor.set(b.color);
	}, b);

/** a model stroke along the equator of a 0.5 sphere (or across a box face), through the painter's own API.
 * `hold` leaves it OPEN (for the live-wire check). */
const stroke = (page, uuid, { from = -0.4, to = 0.4, n = 12, y = 0, box = false, hold = false } = {}) =>
	page.evaluate(
		async ({ uuid, from, to, n, y, box, hold }) => {
			const w = window.__tp.test.v1;
			const at = (/** @type {number} */ i) => {
				const a = from + ((to - from) * i) / (n - 1);
				return box ? [a * 0.9, y, 0.5] : [0.5 * Math.sin(a) * Math.cos(y), 0.5 * Math.sin(y), 0.5 * Math.cos(a) * Math.cos(y)];
			};
			const ok = await w.meshPaint.beginStroke({ uuid, sp: 'obj', at: at(0), normal: [0, 0, 1] });
			if (!ok) return { ok };
			for (let i = 1; i < n; i++) {
				w.meshPaint.strokeTo(at(i));
				await new Promise((r) => setTimeout(r, 25));
			}
			if (hold) return { ok, open: w.meshPaint.stroking() };
			return { ok, committed: w.meshPaint.endStroke(), last: w.meshPaint.meshPaintDebug().last };
		},
		{ uuid, from, to, n, y, box, hold }
	);

const hashOf = (page, uuid, ch, slot = 0) =>
	page.evaluate(({ uuid, ch, slot }) => window.__tp.test.v1.meshPaint.mapHash(uuid, slot, ch), { uuid, ch, slot });

/** the material facts a channel touches */
const mat = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const w = window.__tp.test.v1;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', uuid);
		const m = Array.isArray(o?.material) ? o.material[0] : o?.material;
		const c = o?.geometry?.attributes?.color;
		let off = 0;
		if (c) for (let i = 0; i < c.count; i++) if (c.getX(i) < 0.98 || c.getY(i) < 0.98 || c.getZ(i) < 0.98) off++;
		return {
			found: !!o,
			roughness: m?.roughness,
			metalness: m?.metalness,
			emissive: m?.emissive?.getHexString?.(),
			roughnessMap: !!m?.roughnessMap,
			emissiveMap: !!m?.emissiveMap,
			map: !!m?.map,
			vertexColors: !!m?.vertexColors,
			colorAttr: !!c,
			paintedVerts: off
		};
	}, uuid);

const undoDepth = (page) =>
	page.evaluate(() => new Promise((r) => window.__tp.test.v1.history.undoStack.subscribe((v) => r(v.length))()));
const undo = (page) => page.evaluate(() => window.__tp.test.v1.history.undo());
const redo = (page) => page.evaluate(() => window.__tp.test.v1.history.redo());

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- 1. the panel: every new control is there, with a tooltip --------------------------------------------------
	const ball = await make(A.page, '/create Sphere 0.5', 'paint-ball');
	await A.page.waitForTimeout(800);
	const panel = await A.page.evaluate(() => {
		const ids = ['paint-channel', 'paint-hardness', 'paint-opacity', 'paint-flow', 'paint-erase', 'paint-mirror', 'paint-stamp', 'paint-map-size', 'paint-show-channel'];
		const missing = ids.filter((id) => !document.getElementById(id));
		const untitled = [...document.querySelectorAll('#paint-channel button, #paint-erase, #paint-mirror, #paint-map-size button')].filter((b) => !b.getAttribute('title')).length;
		return { missing, untitled };
	});
	h.check(panel.missing.length === 0, `arming Paint shows the new brush controls (missing: ${panel.missing.join(',') || 'none'})`);
	h.check(panel.untitled === 0, 'every new brush button has a tooltip');

	// ---- 2. a roughness stroke on the model: a NEW map, one undo step, the slider lifted in the same step ----------
	await brush(A.page, { ch: 'roughness', value: 0.1, hardness: 0.6, size: 64 });
	const before = await mat(A.page, ball);
	h.check(before.found && !before.roughnessMap, 'premise: the sphere has no roughness map');
	const d0 = await undoDepth(A.page);
	const live = await stroke(A.page, ball, { hold: true });
	h.check(live.ok && live.open, 'a model stroke opens on a mesh with clean UVs');
	await h.eventually(
		() => B.page.evaluate(() => window.__tp.test.v1.meshPaint?.remoteStrokeCount?.() ?? 0),
		(n) => n > 0,
		'THE WIRE: B is replaying A’s stroke live, before any commit',
		15000
	);
	const ended = await A.page.evaluate(() => window.__tp.test.v1.meshPaint.endStroke());
	h.check(ended, 'the stroke commits');
	const after = await mat(A.page, ball);
	h.check(after.roughnessMap, 'the first stroke made a roughness map');
	h.check(after.roughness === 1, `the slider is lifted to 1 so the map reads true (${before.roughness} -> ${after.roughness})`);
	const d1 = await undoDepth(A.page);
	h.check(d1 === d0 + 1, `one stroke (map + lift) is ONE undo step (${d0} -> ${d1})`);
	const hA = await hashOf(A.page, ball, 'roughness');
	h.check(!!hA, `A's roughness map is readable (${hA?.w}x${hA?.h} ${hA?.hash})`);
	h.check(hA?.w === 1024, 'a new map is made at the chosen size (1k)');
	await h.eventually(
		() => hashOf(B.page, ball, 'roughness'),
		(x) => !!x && x.hash === hA.hash,
		'B shows the SAME roughness pixels (hash)',
		25000
	);
	await h.eventually(
		() => mat(B.page, ball),
		(m) => m.roughness === 1,
		'B gets the lifted slider too',
		15000
	);

	// ---- 3. undo / redo, on both peers ------------------------------------------------------------------------------
	await undo(A.page);
	const undone = await mat(A.page, ball);
	h.check(!undone.roughnessMap && undone.roughness === before.roughness, `undo takes the map AND the lift back (${undone.roughness})`);
	await h.eventually(() => mat(B.page, ball), (m) => !m.roughnessMap, 'B loses the map on undo', 15000);
	await redo(A.page);
	await h.eventually(() => hashOf(A.page, ball, 'roughness'), (x) => !!x && x.hash === hA.hash, 'redo puts the same pixels back', 15000);
	await h.eventually(() => hashOf(B.page, ball, 'roughness'), (x) => !!x && x.hash === hA.hash, 'B follows the redo', 25000);

	// ---- 4. the brush is deterministic: replaying the stroke as a peer would draws the same pixels -----------------
	await brush(A.page, { ch: 'color', color: '#2255ff', hardness: 0.3, flow: 0.5, opacity: 0.8, mirror: true, size: 48 });
	const twin = await make(A.page, '/create Sphere 0.5', 'paint-twin');
	const soft = await make(A.page, '/create Sphere 0.5', 'paint-soft');
	await A.page.waitForTimeout(600);
	// held open first: the commit is a webp (lossy), so the bytes a replay must match are the LIVE canvas the sender
	// painted, which is what a peer's replay shows until that commit lands
	const held = await stroke(A.page, soft, { from: 0.1, to: 0.9, n: 16, y: 0.2, hold: true });
	const hSoft = await hashOf(A.page, soft, 'color');
	const s2 = held.ok
		? await A.page.evaluate(() => {
				const m = window.__tp.test.v1.meshPaint;
				return { ok: true, committed: m.endStroke(), last: m.meshPaintDebug().last };
			})
		: held;
	h.check(s2.ok && s2.committed, 'a soft, low-flow, mirrored colour stroke commits');
	h.check((s2.last?.points?.length ?? 0) > 1 && s2.last?.b?.m === 1, 'the stroke carries its brush (mirror) and rounded points');
	const replay = await A.page.evaluate(
		async ({ twin, last }) => {
			const m = window.__tp.test.v1.meshPaint;
			await m.applyMeshPaint({ type: 'meshpaint', id: 'replay-1', uuid: twin, sp: last.sp, c: last.c, r: last.r, ...(last.b && Object.keys(last.b).length ? { b: last.b } : {}), ...(last.n ? { n: last.n } : {}), seg: last.points });
			await m.applyMeshPaintEnd({ id: 'replay-1' });
			return true;
		},
		{ twin, last: s2.last }
	);
	h.check(replay, 'premise: the replay ran');
	const hTwin = await hashOf(A.page, twin, 'color');
	h.check(!!hSoft && !!hTwin && hSoft.hash === hTwin.hash, `a replayed stroke draws byte-identical pixels (${hSoft?.hash} vs ${hTwin?.hash})`);
	const mirrored = await A.page.evaluate(async (uuid) => {
		// the mirror half: on a three sphere the front (+z) is u = 0.25 and x -> -x maps u -> 0.5 - u, so the stroke
		// (a = 0.1..0.9 rad toward +x) lands right of u = 0.25 and its mirror left of it
		const w = window.__tp.test.v1;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByProperty('uuid', uuid);
		const img = o.material.map.image;
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		const ctx = c.getContext('2d');
		ctx.drawImage(img, 0, 0);
		const px = ctx.getImageData(0, 0, c.width, c.height).data;
		let left = 0;
		let right = 0;
		for (let y = 0; y < c.height; y++)
			for (let x = 0; x < c.width; x++) {
				const i = (y * c.width + x) * 4;
				if (px[i + 2] - px[i] > 40 && x < c.width / 2) (x < c.width / 4 ? left++ : right++);
			}
		return { left, right };
	}, soft);
	h.check(mirrored.left > 50 && mirrored.right > 50, `Mirror X paints both halves (${mirrored.left} / ${mirrored.right} px)`);

	// ---- 5. the eraser goes back to the material's own value ----------------------------------------------------------
	await brush(A.page, { ch: 'roughness', erase: true, size: 128 });
	const er = await stroke(A.page, ball, { n: 14 });
	h.check(er.ok && er.committed, 'an eraser stroke commits');
	h.check(er.last?.c === '#ffffff', `the roughness eraser paints white (the slider shows through) (${er.last?.c})`);
	const hErased = await hashOf(A.page, ball, 'roughness');
	h.check(hErased && hErased.hash !== hA.hash, 'the eraser changed the map');

	// ---- 6. vertex-colour fallback: a box's six faces share one UV square ---------------------------------------------
	await brush(A.page, { ch: 'color', color: '#ff2200', size: 96 });
	const box = await make(A.page, '/create Box 1 1 1', 'paint-box');
	await A.page.waitForTimeout(600);
	const target = await A.page.evaluate(async (uuid) => {
		const w = window.__tp.test.v1;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		return w.meshPaint.targetFor(g.getObjectByProperty('uuid', uuid), 0);
	}, box);
	h.check(target?.mode === 'vertex', `overlapping UVs paint vertex colours (${target?.mode}: ${target?.reason})`);
	await A.page.waitForTimeout(300);
	const note = await A.page.evaluate(() => document.getElementById('paint-target-info')?.textContent?.trim() ?? '');
	h.check(note.length > 10, `the panel says why (${note.slice(0, 60)})`);
	const vd0 = await undoDepth(A.page);
	const vs = await stroke(A.page, box, { box: true, n: 10 });
	h.check(vs.ok && vs.committed && vs.last?.sp === 'vtx', 'the box stroke paints vertex colours');
	const vm = await mat(A.page, box);
	h.check(vm.colorAttr && vm.vertexColors && vm.paintedVerts > 0, `vertex colours are on and painted (${vm.paintedVerts} verts)`);
	h.check((await undoDepth(A.page)) === vd0 + 1, 'a vertex stroke is one undo step');
	await h.eventually(() => mat(B.page, box), (m) => m.vertexColors && m.paintedVerts === vm.paintedVerts, 'B gets the same painted vertices', 25000);
	await undo(A.page);
	const vu = await mat(A.page, box);
	h.check(!vu.vertexColors && vu.paintedVerts === 0, 'undo takes the colours and the switch back');
	const refused = await A.page.evaluate(async (uuid) => {
		const w = window.__tp.test.v1;
		w.meshPaintPrefs.paintChannel.set('metalness');
		return w.meshPaint.beginStroke({ uuid, sp: 'obj', at: [0, 0, 0.5] });
	}, box);
	h.check(refused === false, 'a map channel on a mesh without clean UVs is refused (with a toast), not painted wrong');
	await redo(A.page);

	// ---- 7. reload: the painted map survives ----------------------------------------------------------------------
	const keep = await hashOf(A.page, ball, 'roughness');
	await A.page.evaluate(() => window.__tp.test.v1.autosave.saveNow());
	await h.freshReload(A);
	// the restore by hand (not h.answerRestore): its click waits only 10 s for the page, and a restore that decodes
	// several painted maps is measured here instead of timing out
	const offered = await A.page
		.waitForFunction(
			() => {
				const m = window.__tp?.test.v1?.autosave;
				if (!m?.restoreAvailable) return false;
				let v;
				m.restoreAvailable.subscribe((x) => (v = x))();
				return !!v;
			},
			null,
			{ timeout: 30000, polling: 200 }
		)
		.then(() => true)
		.catch(() => false);
	h.check(offered, 'after a reload the painted session is offered back');
	const t0 = Date.now();
	await A.page.locator('#restore-session-restore').click({ timeout: 10000, noWaitAfter: true });
	await A.page.waitForFunction(
		() => {
			let v;
			window.__tp.test.v1.autosave.restoreAvailable.subscribe((x) => (v = x))();
			return !v && !document.querySelector('#restore-session-modal[open]');
		},
		null,
		{ timeout: 60000, polling: 100 }
	);
	const restoreMs = Date.now() - t0;
	h.check(restoreMs < 20000, `the restore finishes (${restoreMs} ms)`);
	const reloaded = await h.eventually(
		() =>
			A.page.evaluate(async () => {
				const w = window.__tp.test.v1;
				const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
				const o = g.getObjectByName('paint-ball');
				if (!o) return null;
				return w.meshPaint.mapHash(o.uuid, 0, 'roughness');
			}),
		(x) => !!x && x.hash === keep.hash,
		`after a reload the roughness pixels are the same (${keep?.hash})`,
		40000
	);
	void reloaded;

	// ---- 8. GLB export carries the new maps -------------------------------------------------------------------------
	const gltf = await A.page.evaluate(async () => {
		const w = window.__tp.test.v1;
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.getObjectByName('paint-ball');
		const soft = g.getObjectByName('paint-soft');
		const out = await w.fileHandler.gltfBytesFor([o, soft], { binary: false });
		const text = typeof out === 'string' ? out : new TextDecoder().decode(out);
		const json = JSON.parse(text);
		const mats = json.materials ?? [];
		return {
			metalRough: mats.filter((m) => m.pbrMetallicRoughness?.metallicRoughnessTexture).length,
			baseColor: mats.filter((m) => m.pbrMetallicRoughness?.baseColorTexture).length,
			images: (json.images ?? []).length
		};
	});
	h.check(gltf.metalRough >= 1, `the glTF export carries the painted roughness map (${gltf.metalRough} metallicRoughnessTexture)`);
	h.check(gltf.baseColor >= 1, `and the painted colour map (${gltf.baseColor} baseColorTexture, ${gltf.images} images)`);

	// ---- 9. memory gate: ten 2k strokes grow the heap by no more than one map ---------------------------------------
	await brush(A.page, { ch: 'metalness', value: 0.9, size: 64, mapSize: 2048 });
	const mem = await A.page.evaluate(async () => {
		const w = window.__tp.test.v1;
		const heap = async () => {
			for (let i = 0; i < 3; i++) {
				/** @type {any} */ (window).gc?.();
				await new Promise((r) => setTimeout(r, 120));
			}
			return /** @type {any} */ (performance).memory?.usedJSHeapSize ?? null;
		};
		w.commandsHandler.sceneCommand('/create Sphere 0.5');
		const g = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const o = g.children[g.children.length - 1];
		o.name = 'paint-mem';
		// the first stroke makes the map (that map is the one map the gate allows); measure from after it
		const one = async (k) => {
			const a0 = -0.6 + k * 0.05;
			await w.meshPaint.beginStroke({ uuid: o.uuid, sp: 'obj', at: [0.5 * Math.sin(a0), 0, 0.5 * Math.cos(a0)] });
			for (let i = 1; i < 12; i++) {
				const a = a0 + i * 0.06;
				w.meshPaint.strokeTo([0.5 * Math.sin(a), 0.1 * Math.sin(k + i), 0.5 * Math.cos(a)]);
			}
			return w.meshPaint.endStroke();
		};
		const h0 = await heap();
		let ok = 0;
		for (let k = 0; k < 10; k++) if (await one(k)) ok++;
		await new Promise((r) => setTimeout(r, 1500)); // the committed images decode
		const h1 = await heap();
		return { ok, h0, h1, gc: typeof (/** @type {any} */ (window).gc) === 'function', size: o.material.metalnessMap?.image?.width ?? 0 };
	});
	h.check(mem.ok === 10, `ten 2k strokes commit (${mem.ok})`);
	h.check(mem.size === 2048, `the new map is 2k (${mem.size})`);
	const ONE_MAP = 2048 * 2048 * 4;
	if (mem.h0 == null) h.check(true, 'memory gate: SKIP (no performance.memory in this browser)');
	else {
		const grew = mem.h1 - mem.h0;
		h.check(grew <= ONE_MAP, `memory gate: the JS heap grew ${(grew / 1048576).toFixed(1)} MB over ten 2k strokes, at most one map (${(ONE_MAP / 1048576).toFixed(0)} MB)${mem.gc ? '' : ' (no forced GC)'}`);
	}

	await h.finish(browser);
});

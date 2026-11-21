// Roadmap 102b — the paper cuts, end to end on two real peers (A hosts, B joins):
//   1  a Box gets a corner radius (agent set_geometry): B rebuilds the same rounded mesh; the Inspector
//      shows Corner radius / Corner segs with their tooltips and hides the square segment rows
//   2  a BAKED rounded box is OFFERED a Convert (never automatic): the button by keyboard, B follows, one
//      undo puts the baked mesh back on both
//   3  the file: a rounded box saves as a Box with two numbers; two equal baked meshes are written once
//      (sharedGeometries); the file reads back to the same vertices; B reloads and rejoins with the
//      rounded box intact (two-peer + reload)
//   4  an OLD scene (an official .tpscene, OLD_SCENE=<path>) loads with the same objects and vertices
//   5  Set Shader Uniform drives a COLOUR and a VECTOR uniform (sRGB -> linear, like an authored colour)
//   6  a Script node's event output fires once per rising edge, and a Counter counts it on BOTH peers
//   7  an effect that reaches no object says "acts on nothing" on its card and in validate_scene; wired, the
//      line goes
//   8  fog kinds: set_sky {kind: 'height'} reaches B as FogExp2 + the height layer; the Inspector's Kind
//      row switches it back to Linear by keyboard
//   9  a cube-map cross (PNG) uploaded through Upload HDRI… becomes an equirectangular .hdr library item
//  10  feature unused = zero change: a plain box saves exactly the params it did, a scene with no repeats
//      writes no sharedGeometries, a linear fog adds no keys
// OLD_URL=<the newest release> adds 3b: the file this build wrote opens there (objects + rounded box size).
// Run: e2e-slot --dev <tree> 7106 -- node tests/e2e/papercuts-102b.test.cjs
const fs = require('fs');
const zlib = require('zlib');
const h = require('./helpers.cjs');

const exec = (peer, tool, args) => peer.page.evaluate(([x, a]) => window.__tp.test.v1.aiTools.executeAiTool(x, a), [tool, args]);
const short = (v) => JSON.stringify(v ?? null).slice(0, 220);

/** one object's geometry facts on a page */
const geoOf = (page, uuid) =>
	page.evaluate((u) => {
		/** @type {any} */ let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o?.geometry) return null;
		o.geometry.computeBoundingBox();
		const b = o.geometry.boundingBox;
		return {
			type: o.geometry.type,
			verts: o.geometry.attributes.position.count,
			typed: !!o.geometry.parameters,
			radius: o.geometry.parameters?.radius ?? null,
			gp: JSON.parse(JSON.stringify(o.userData.geometryParams ?? null)),
			size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => Math.round(v * 1000) / 1000)
		};
	}, uuid);

/** a tiny RGB PNG from a pixel function (node zlib; no image library) */
function png(w, h, px) {
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3);
	}
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** the scene as a .tpscene (the real writer), base64 */
const saveFile = (page) =>
	page.evaluate(async () => {
		const s = window.__tp.test.v1.sessions;
		const bytes = await s.exportSessionZip(s.buildSessionPayload('102b'), { assets: false, packs: false });
		let bin = '';
		for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return btoa(bin);
	});
/** session.json inside a base64 .tpscene, as the file holds it (no inflate) */
async function sessionJsonOf(b64) {
	const { unzipSync, strFromU8 } = await import('fflate');
	return JSON.parse(strFromU8(unzipSync(new Uint8Array(Buffer.from(b64, 'base64')))['session.json']));
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const make = async (name, position, params = [1, 1, 1]) => {
		const r = await exec(A, 'create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', params, name, position }] });
		const id = r?.created?.[0]?.uuid;
		if (!id) throw new Error('create_objects: ' + short(r));
		await h.eventually(() => geoOf(B.page, id), (o) => !!o, 'premise: B has ' + name, 20000);
		return id;
	};

	// ---- 10a (first, on a clean scene): a plain box keeps exactly its six params
	const plain = await make('Plain', [-6, 0.5, 0]);
	const plainGeo = await geoOf(A.page, plain);
	h.check(
		JSON.stringify(Object.keys(plainGeo.gp?.params ?? {})) === JSON.stringify(['width', 'height', 'depth', 'widthSegments', 'heightSegments', 'depthSegments']) && plainGeo.verts === 24,
		'10. a box that never uses a radius stores the six params it always did: ' + short(plainGeo.gp)
	);
	const plainFile = await sessionJsonOf(await saveFile(A.page));
	h.check(!('sharedGeometries' in plainFile), '10. a scene with no repeated mesh writes no sharedGeometries');
	const plainBoxJson = plainFile.objects.flatMap((e) => e.geometries ?? []).find((g) => g.type === 'BoxGeometry');
	h.check(plainBoxJson && !('radius' in plainBoxJson) && !('radiusSegments' in plainBoxJson), '10. ...and its Box JSON has no radius keys: ' + short(plainBoxJson));

	// ---- 1. corner radius
	console.log('\n=== 1. rounded box ===');
	const crate = await make('Crate', [0, 0.5, 0], [2, 1, 1]);
	const set = await exec(A, 'set_geometry', { objects: [crate], params: { radius: 0.2, radiusSegments: 3 } });
	h.check(!set?.error, '1. set_geometry takes {radius, radiusSegments}: ' + short(set));
	await h.eventually(() => geoOf(B.page, crate), (o) => o?.verts === 1764 && o.gp?.params?.radius === 0.2, '1. B rebuilds the same rounded box (1764 vertices, radius 0.2)', 20000);
	const a1 = await geoOf(A.page, crate);
	h.check(a1.verts === 1764 && a1.type === 'BoxGeometry' && a1.radius === 0.2 && a1.size.join() === '2,1,1', '1. A: a Box with radius 0.2, size 2 x 1 x 1: ' + short(a1));
	const listed = await exec(A, 'list_scene', {});
	h.check(JSON.stringify(listed).includes('"radius":0.2'), '1. list_scene reports the radius under geometry');
	await A.page.evaluate((u) => {
		const s = window.__tp.test.v1;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.selectedObject.set(g.getObjectByProperty('uuid', u));
		s.showSidebar('properties');
	}, crate);
	await A.page.waitForSelector('#inspector-geometry', { timeout: 15000 }).catch(() => {});
	const rows = await A.page.evaluate(() => {
		const box = document.getElementById('inspector-geometry');
		const txt = box?.textContent ?? '';
		return {
			radius: !!document.getElementById('geo-radius'),
			segs: !!document.getElementById('geo-radiusSegments'),
			tip: document.getElementById('geo-radius')?.closest('[title]')?.getAttribute('title') ?? '',
			squareSegs: /Width segs/.test(txt)
		};
	});
	h.check(rows.radius && rows.segs && /Rounds every edge/.test(rows.tip), '1. the Inspector shows Corner radius + Corner segs with a tooltip: ' + short(rows));
	h.check(!rows.squareSegs, '1. ...and hides the square box segment rows while it is rounded');

	// ---- 2. Convert a baked one
	console.log('\n=== 2. Convert ===');
	const baked = await make('Baked', [3, 0.5, 0], [1.2, 0.8, 0.6]);
	await exec(A, 'set_geometry', { objects: [baked], params: { radius: 0.08, radiusSegments: 2 } });
	await h.eventually(() => geoOf(B.page, baked), (o) => o?.verts === 900, 'premise: B has the rounded box', 20000);
	// bake it on both pages, as the template generator did (a plain mesh of vertices, no params)
	for (const P of [A, B])
		await P.page.evaluate((u) => {
			const s = window.__tp.test.v1;
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const o = g.getObjectByProperty('uuid', u);
			const out = new s.THREE.BufferGeometry();
			for (const n of ['position', 'normal', 'uv']) out.setAttribute(n, o.geometry.attributes[n].clone());
			o.geometry.dispose();
			o.geometry = out;
			delete o.userData.geometryParams;
			s.pokeScene?.();
		}, baked);
	const bakedA = await geoOf(A.page, baked);
	h.check(!bakedA.typed && !bakedA.gp && bakedA.verts === 900, 'premise: the box is baked (a plain mesh, no params): ' + short(bakedA));
	await A.page.evaluate((u) => {
		const s = window.__tp.test.v1;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		s.selectedObject.set(g.getObjectByProperty('uuid', u));
	}, baked);
	await A.page.waitForSelector('#geometry-convert-rounded', { timeout: 15000 }).catch(() => {});
	const offer = await A.page.evaluate(() => ({
		text: document.getElementById('geometry-rounded-offer')?.textContent?.trim() ?? '',
		tip: document.getElementById('geometry-convert-rounded')?.getAttribute('title') ?? ''
	}));
	h.check(/rounded box \(1\.2 x 0\.8 x 0\.6 m, corner 0\.08 m\)/.test(offer.text) && /looks the same/.test(offer.tip), '2. the Inspector OFFERS a Convert, with the box it found and a tooltip: ' + short(offer));
	await new Promise((r) => setTimeout(r, 1200));
	h.check((await geoOf(A.page, baked)).gp === null, '2. ...and converts nothing by itself');
	await A.page.focus('#geometry-convert-rounded');
	await A.page.keyboard.press('Enter');
	await h.eventually(() => geoOf(A.page, baked), (o) => o?.typed && o.gp?.params?.radius === 0.08, '2. Enter on the button converts it (a Box with radius 0.08)', 10000);
	await h.eventually(() => geoOf(B.page, baked), (o) => o?.typed && o.gp?.params?.radius === 0.08 && o.verts === 900, '2. B follows (the same 900 vertices, now a Box)', 20000);
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(() => geoOf(A.page, baked), (o) => o && !o.typed && !o.gp && o.verts === 900, '2. one undo puts the baked mesh back on A', 10000);
	await h.eventually(() => geoOf(B.page, baked), (o) => o && !o.typed && !o.gp && o.verts === 900, '2. ...and on B', 20000);

	// ---- 3. the file
	console.log('\n=== 3. the file ===');
	// a second baked copy of the same mesh: two equal shapes
	const twin = await A.page.evaluate((u) => {
		const s = window.__tp.test.v1;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', u);
		const copy = new s.THREE.Mesh(o.geometry.clone(), o.material);
		copy.name = 'Baked twin';
		copy.position.set(5, 0.5, 0);
		g.add(copy);
		return copy.uuid;
	}, baked);
	const b64 = await saveFile(A.page);
	const file = await sessionJsonOf(b64);
	const crateJson = file.objects.find((e) => e.object?.uuid === crate)?.geometries?.[0];
	h.check(crateJson?.type === 'BoxGeometry' && crateJson.radius === 0.2 && crateJson.radiusSegments === 3 && !crateJson.data, '3. the rounded box is a Box with two numbers in the file: ' + short(crateJson));
	h.check(JSON.stringify(crateJson).length < 400, '3. ...a few hundred bytes, not ' + 1764 * 8 * 4 + '+ of vertices (' + JSON.stringify(crateJson).length + ' bytes)');
	const stubs = file.objects.filter((e) => [baked, twin].includes(e.object?.uuid)).map((e) => e.geometries?.[0]);
	h.check(Array.isArray(file.sharedGeometries) && file.sharedGeometries.length === 1, '3. two equal baked meshes are written once (sharedGeometries: ' + (file.sharedGeometries?.length ?? 0) + ')');
	h.check(stubs.length === 2 && stubs.every((g) => g.type === 'BoxGeometry' && g.sharedGeometry === 0 && g.width === 1.2), '3. ...each use is a plain-box stand-in an older build can draw: ' + short(stubs[0]));
	h.check(file.formatMinor === 4 && file.format === 1, '3. format 1, minor 4 (additive: an older build loads it): ' + file.format + '.' + file.formatMinor);
	const back = await A.page.evaluate(async (b) => {
		const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
		const payload = await window.__tp.test.v1.sessions.readSessionZip(bytes.buffer);
		const out = {};
		for (const e of payload.objects) {
			const o = new (window.__tp.test.v1.THREE.ObjectLoader)().parse(e);
			out[o.name] = { type: o.geometry?.type, verts: o.geometry?.attributes?.position?.count, radius: o.geometry?.parameters?.radius ?? null };
		}
		return { out, shared: 'sharedGeometries' in payload };
	}, b64);
	h.check(!back.shared && back.out.Crate?.verts === 1764 && back.out.Crate.radius === 0.2 && back.out.Baked?.verts === 900 && back.out['Baked twin']?.verts === 900, '3. the file reads back to the same meshes: ' + short(back.out));
	if (process.env.OUT) fs.writeFileSync(process.env.OUT + '/102b-saved.tpscene', Buffer.from(b64, 'base64'));

	// two-peer + reload: B reloads, rejoins, and has the rounded box (GLTF sync carries vertices + params)
	await h.freshReload(B);
	await h.answerRestore(B).catch(() => false);
	await h.eventually(() => B.page.evaluate(() => window.__tp.test.v1.peers && (() => { let p; window.__tp.test.v1.peers.subscribe((x) => (p = x))(); return p?.openedPeers?.length ?? 0; })()), (n) => n >= 1, '3. B is back in the session after its reload', 60000);
	await h.eventually(() => geoOf(B.page, crate), (o) => o?.verts === 1764 && o.gp?.params?.radius === 0.2, '3. after the reload B has the rounded box with its radius (rows editable)', 60000);
	await exec(A, 'set_geometry', { objects: [crate], params: { radius: 0.4 } });
	await h.eventually(() => geoOf(B.page, crate), (o) => o?.gp?.params?.radius === 0.4, '3. ...and a later radius edit still reaches it', 20000);

	// ---- 3b. the newest release opens this file
	if (process.env.OLD_URL) {
		console.log('\n=== 3b. the newest release ===');
		const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
		await ctx.addInitScript(() => {
			localStorage.setItem('debugStores', 'true');
			localStorage.setItem('errorReports:send', 'false');
			localStorage.setItem('perfReports:offered', 'no');
		});
		const old = await ctx.newPage();
		await old.goto(process.env.OLD_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
		await old.waitForFunction(() => !!window.__tp?.test?.v1?.sessions, null, { timeout: 120000 });
		const there = await old.evaluate(async (b) => {
			const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
			const s = window.__tp.test.v1.sessions;
			const payload = await s.readSessionZip(bytes.buffer);
			if (!payload) return { refused: true };
			const out = {};
			for (const e of payload.objects) {
				const o = new (window.__tp.test.v1.THREE.ObjectLoader)().parse(e);
				o.geometry?.computeBoundingBox?.();
				const bb = o.geometry?.boundingBox;
				out[o.name] = bb ? [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].map((v) => Math.round(v * 100) / 100).join('x') : null;
			}
			return { out };
		}, b64);
		h.check(!there.refused && there.out?.Crate === '2x1x1' && there.out?.Baked === '1.2x0.8x0.6' && there.out?.['Baked twin'] === '1.2x0.8x0.6' && there.out?.Plain === '1x1x1',
			'3b. the newest release opens the file: every object, each the right size (rounded box and repeats as plain boxes): ' + short(there));
		await ctx.close();
	} else console.log('   (3b skipped: set OLD_URL to the newest release)');

	// remove the local-only twin (B never had it)
	await A.page.evaluate((u) => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((x) => (g = x))();
		const o = g.getObjectByProperty('uuid', u);
		o?.parent?.remove(o);
	}, twin);

	// ---- 4. an old scene loads unchanged
	if (process.env.OLD_SCENE && fs.existsSync(process.env.OLD_SCENE)) {
		console.log('\n=== 4. an old scene ===');
		const { unzipSync, strFromU8 } = await import('fflate');
		const raw = fs.readFileSync(process.env.OLD_SCENE);
		const orig = JSON.parse(strFromU8(unzipSync(new Uint8Array(raw))['session.json']));
		const want = { objects: orig.objects.length, floats: orig.objects.flatMap((e) => e.geometries ?? []).reduce((n, g) => n + (g.data?.attributes?.position?.array?.length ?? 0), 0) };
		const got = await A.page.evaluate(async (b) => {
			const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
			const payload = await window.__tp.test.v1.sessions.readSessionZip(bytes.buffer);
			return {
				objects: payload.objects.length,
				floats: payload.objects.flatMap((e) => e.geometries ?? []).reduce((n, g) => n + (g.data?.attributes?.position?.array?.length ?? 0), 0),
				shared: 'sharedGeometries' in payload,
				minor: payload.formatMinor ?? 0
			};
		}, raw.toString('base64'));
		h.check(got.objects === want.objects && got.floats === want.floats && !got.shared, '4. an old scene (' + process.env.OLD_SCENE.split('/').slice(-2).join('/') + ', minor ' + got.minor + ') reads back unchanged: ' + short(got) + ' vs ' + short(want));
	} else console.log('   (4 skipped: set OLD_SCENE to an official .tpscene)');

	// ---- 5. Set Shader Uniform: colour + vector
	console.log('\n=== 5. Set Shader Uniform ===');
	const sign = await make('Sign', [8, 0.5, 0]);
	const shader = await exec(A, 'create_shader', { objects: [sign], text: 'c = color {value: "#000000"}\nv = vector3 {value: [0, 0, 0]}\nout = surface\nc -> out.emissive\nv -> out.position' });
	console.log('   create_shader: ' + short(shader?.created?.[0]?.uniforms ?? shader));
	const uniforms = (shader?.created?.[0]?.uniforms ?? []).map((u) => u.uniform);
	const cu = uniforms.find((u) => /^u_c_/.test(u));
	const vu = uniforms.find((u) => /^u_v_/.test(u));
	const uni = (page, name) => page.evaluate(([u, n]) => { const v = window.__tp.test.v1.shaderGraph.shaderUniform(u, n)?.value; return v == null ? null : Array.from(v); }, [sign, name]);
	await h.eventually(() => uni(A.page, cu), (v) => Array.isArray(v) && v.length === 3, 'premise: the colour uniform compiled on A (' + cu + ')', 30000);
	const flow = await exec(A, 'create_flow_nodes', {
		graph: sign,
		text: 'pick = colorpicker {color: "#ff8000"}\nset = setuniform {uniform: "' + cu + '"}\npick -> set.color\nvec = vector3 {x: 0, y: 0.25, z: 0}\nsetv = setuniform {uniform: "' + vu + '"}\nvec -> setv.vector'
	});
	h.check(!flow?.error && !flow?.partial, '5. colour and vector wires into Set Shader Uniform are accepted: ' + short(flow?.errors ?? flow?.error ?? 'ok'));
	const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
	const want5 = [1, lin(128 / 255), 0];
	for (const P of [A, B]) {
		await h.eventually(() => uni(P.page, cu), (v) => Array.isArray(v) && v.every((x, i) => Math.abs(x - want5[i]) < 1e-3), '5. ' + P.name + ': the colour drives the uniform, sRGB -> linear (' + want5.map((x) => x.toFixed(3)) + ')', 30000);
		await h.eventually(() => uni(P.page, vu), (v) => Array.isArray(v) && Math.abs(v[1] - 0.25) < 1e-6 && v[0] === 0, '5. ' + P.name + ': the vector drives the vec3 uniform (0, 0.25, 0)', 30000);
	}

	// ---- 6. Script event output
	console.log('\n=== 6. Script event ===');
	const scr = await exec(A, 'create_flow_nodes', {
		graph: 'scene',
		nodes: [
			{ ref: 'tick', type: 'script', data: { code: 'return { hit: Math.floor(time * 2) % 2 === 0 };', outputs: [{ name: 'hit', type: 'event' }] } },
			{ ref: 'count', type: 'counter' }
		],
		edges: [{ from: 'tick', fromHandle: 'hit', to: 'count', toHandle: 'trigger' }]
	});
	console.log('   create_flow_nodes: ' + short(scr));
	const countId = scr?.created?.find?.((c) => c.ref === 'count')?.id ?? scr?.created?.[1]?.id;
	const counterOf = (page) => page.evaluate((id) => { let t; window.__tp.test.v1.flowTriggers.subscribe((x) => (t = x))(); return t?.[id]?.count ?? 0; }, countId);
	const c0 = await counterOf(A.page);
	await new Promise((r) => setTimeout(r, 4200));
	const c1 = await counterOf(A.page);
	h.check(c1 - c0 >= 3 && c1 - c0 <= 5, '6. the Script event fires once per rising edge (a 1 Hz square wave over 4.2 s: +' + (c1 - c0) + ', 3..5)');
	const cb = await counterOf(B.page);
	h.check(Math.abs(cb - c1) <= 1, '6. B counts it too (its own run of the same code: A ' + c1 + ', B ' + cb + ')');

	// ---- 7. an effect that acts on nothing
	console.log('\n=== 7. acts on nothing ===');
	const spin = await exec(A, 'create_flow_nodes', { graph: 'scene', nodes: [{ ref: 's', type: 'spin' }] });
	const spinId = spin?.created?.[0]?.id;
	await A.page.evaluate(() => window.__tp.test.v1.nodeLiveState.liveStateGraph.set('scene'));
	const lineOf = () => A.page.evaluate((id) => { let m; window.__tp.test.v1.nodeLiveState.nodeLiveStates.subscribe((x) => (m = x))(); return m?.[id] ?? null; }, spinId);
	await h.eventually(lineOf, (t) => t === 'acts on nothing: add an Object Selector', '7. an unwired Spin in the scene graph says "acts on nothing" on its card', 10000);
	const lint = await exec(A, 'validate_scene', {});
	h.check(JSON.stringify(lint).includes('effect-no-object'), '7. validate_scene lists it (effect-no-object)');
	const wire = await exec(A, 'create_flow_nodes', { graph: 'scene', nodes: [{ ref: 'sel', type: 'objectselector', data: { object: plain } }], edges: [{ from: spinId, to: 'sel' }] });
	h.check(!wire?.error, '7. wiring it to an Object Selector: ' + short(wire?.error ?? 'ok'));
	await h.eventually(lineOf, (t) => t !== 'acts on nothing: add an Object Selector', '7. ...and the line goes', 10000);
	await A.page.evaluate(() => window.__tp.test.v1.nodeLiveState.liveStateGraph.set(null));

	// ---- 8. fog kinds
	console.log('\n=== 8. fog ===');
	const fogSet = await exec(A, 'set_sky', { fog: { color: '#a0b0c0', kind: 'height', density: 0.05, base: 0, thickness: 4 } });
	h.check(!fogSet?.error, '8. set_sky takes a height fog: ' + short(fogSet?.error ?? 'ok'));
	const fogOn = (page) => page.evaluate(() => {
		let sc;
		window.__tp.test.v1.globalScene.subscribe((v) => (sc = v))();
		const f = sc?.fog ?? null;
		return { exp2: !!f?.isFogExp2, linear: !!f?.isFog, density: f?.density ?? null };
	});
	const envOf = (P) => exec(P, 'get_environment', {});
	await h.eventually(() => envOf(B), (e) => JSON.stringify(e).includes('"kind":"height"'), '8. B reads a height fog back (get_environment)', 20000);
	const fb = await fogOn(B.page);
	h.check(fb.exp2 && Math.abs(fb.density - 0.05) < 1e-6, '8. B draws it as a distance-integrated fog (FogExp2, density 0.05): ' + short(fb));
	await A.page.evaluate(() => window.__tp.test.v1.openSceneSection('Fog'));
	await A.page.waitForSelector('#fog-kind', { timeout: 15000 }).catch(() => {});
	const kindRow = await A.page.evaluate(() => ({ there: !!document.getElementById('fog-kind'), tip: document.getElementById('fog-kind')?.getAttribute('title') ?? document.getElementById('fog-kind')?.closest('[title]')?.getAttribute('title') ?? '', base: !!document.getElementById('fog-base'), near: !!document.getElementById('fog-near') }));
	h.check(kindRow.there && kindRow.base && !kindRow.near, '8. the Fog rows show Kind + Ground height, and hide Near/Far for a height fog: ' + short(kindRow));
	const picked = await exec(A, 'set_sky', { fog: { kind: 'linear', near: 5, far: 60 } });
	h.check(!picked?.error, '8. back to a linear fog');
	await h.eventually(() => envOf(B), (e) => !JSON.stringify(e).includes('"kind":"height"'), '8. B follows back to linear', 20000);
	const fl = await fogOn(B.page);
	h.check(fl.linear && !fl.exp2, '8. ...as THREE.Fog again (the fog every older build draws): ' + short(fl));

	// ---- 9. a cube-map cross
	console.log('\n=== 9. cube-map sky ===');
	const face = [[220, 60, 60], [60, 220, 60], [60, 60, 220], [220, 220, 60], [60, 220, 220], [220, 60, 220]];
	// a 4:3 horizontal cross, 16 px faces: row 1 = -X +Z +X -Z, +Y above +Z, -Y below
	const cell = (x, y) => {
		const cx = Math.floor(x / 16), cy = Math.floor(y / 16);
		if (cy === 0 && cx === 1) return face[2];
		if (cy === 2 && cx === 1) return face[3];
		if (cy === 1) return face[[1, 4, 0, 5][cx]];
		return [0, 0, 0];
	};
	const cross = png(64, 48, cell);
	await A.page.evaluate(() => window.__tp.test.v1.openSceneSection('Environment'));
	await A.page.waitForSelector('#hdri-upload-file', { state: 'attached', timeout: 15000 });
	await A.page.setInputFiles('#hdri-upload-file', { name: 'test-sky-cross.png', mimeType: 'image/png', buffer: cross });
	const items = () => A.page.evaluate(() => { let x; window.__tp.test.v1.explorer.explorerItems.subscribe((v) => (x = v))(); return (x ?? []).filter((i) => /test-sky-cross/.test(i.name)).map((i) => ({ name: i.name, kind: i.kind })); });
	await h.eventually(items, (l) => l.some((i) => i.name === 'test-sky-cross-equirect.hdr' && i.kind === 'hdri'), '9. the cross becomes test-sky-cross-equirect.hdr in the library (kind hdri)', 30000);
	const toast = await A.page.evaluate(() => [...document.querySelectorAll('.tp-toast')].map((t) => t.textContent).join(' | '));
	h.check(/Cube map converted to a sky image/.test(toast), '9. a toast names the conversion: ' + toast.slice(0, 120));

	await h.finish(browser);
});

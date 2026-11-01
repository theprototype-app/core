// 72 LK4: look animation leaves the app in a GLB as KHR_animation_pointer: material, visibility, light, camera
// field of view. The file is read back with no help from the exporter: the pointers must resolve to properties
// the document really holds, the sampled numbers must match what the app plays, and an ordinary loader must
// still open it. The Field of view channel is new here, so it is also proven in the app, on two peers.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const OUT = process.env.EVIDENCE_DIR || path.join('test-results', '72-materials');

/** export roots to a GLB in the page; returns the JSON chunk, the bytes as base64, and the accessors decoded */
const exportGlb = (page, uuids, opts = {}) =>
	page.evaluate(
		async ({ uuids, opts }) => {
			const s = window.__stores;
			let group = null;
			s.objectsGroup.subscribe((g) => (group = g))();
			const roots = uuids.map((id) => group.getObjectByProperty('uuid', id));
			const bytes = await s.fileHandler.gltfBytesFor(roots, { binary: true, ...opts });
			const view = new DataView(bytes);
			const jsonLength = view.getUint32(12, true);
			const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
			const binStart = 20 + jsonLength + 8;
			const read = (index) => {
				const accessor = json.accessors[index];
				const bv = json.bufferViews[accessor.bufferView];
				const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type];
				const start = binStart + (bv.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
				const Type = accessor.componentType === 5126 ? Float32Array : Uint8Array;
				return { size, componentType: accessor.componentType, min: accessor.min, max: accessor.max, values: [...new Type(bytes.slice(start, start + accessor.count * size * Type.BYTES_PER_ELEMENT))] };
			};
			const channels = (json.animations ?? []).flatMap((animation) =>
				animation.channels.map((channel) => {
					const sampler = animation.samplers[channel.sampler];
					return {
						animation: animation.name,
						pointer: channel.target.extensions?.KHR_animation_pointer?.pointer ?? null,
						node: channel.target.node,
						path: channel.target.path,
						interpolation: sampler.interpolation,
						input: read(sampler.input),
						output: read(sampler.output)
					};
				})
			);
			let binary = '';
			const raw = new Uint8Array(bytes);
			for (let i = 0; i < raw.length; i += 32768) binary += String.fromCharCode(...raw.subarray(i, i + 32768));
			return { json, channels, base64: btoa(binary) };
		},
		{ uuids, opts }
	);

/** does this JSON pointer resolve inside the document? (a target that is not there is an invalid file) */
const resolves = (json, pointer) => {
	let at = json;
	for (const part of pointer.split('/').slice(1)) {
		if (at === undefined || at === null) return false;
		at = at[part];
	}
	return at !== undefined;
};

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

const createObject = (page, command) =>
	page.evaluate(async (cmd) => {
		const group = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const before = new Set();
		group.traverse((n) => before.add(n.uuid));
		window.__stores.commandsHandler.sceneCommand(cmd);
		for (let i = 0; i < 40; i++) {
			await new Promise((r) => setTimeout(r, 100));
			const made = group.children.find((c) => !before.has(c.uuid));
			if (made) return made.uuid;
		}
		return '';
	}, command);

/** author a clip of these channels with the app's own editor calls */
const addClip = (page, uuid, tracks, duration = 2) =>
	page.evaluate(
		({ uuid, tracks, duration }) => {
			const ap = window.__stores.animationPreview;
			let group = null;
			window.__stores.objectsGroup.subscribe((g) => (group = g))();
			const object = group.getObjectByProperty('uuid', uuid);
			for (const [channel, keys] of Object.entries(tracks)) {
				ap.addTrack(uuid, channel, object);
				ap.updateAnim(uuid, { duration });
				const track = ap.getAnim(uuid).tracks.find((t) => t.channel === channel);
				const count = track.keys.length;
				keys.forEach((key, i) => (i < count ? ap.updateKey(uuid, track.id, i, key) : ap.addKey(uuid, track.id, key.t, key.v)));
			}
			return ap.getAnim(uuid).tracks.map((t) => [t.channel, t.keys.map((k) => [k.t, k.v])]);
		},
		{ uuid, tracks, duration }
	);

h.run(async () => {
	fs.mkdirSync(OUT, { recursive: true });
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	const page = A.page;
	await h.connect(B, A);

	console.log('\n=== 1. the Field of view channel, in the app ===');
	const camera = await createObject(page, '/create camera');
	h.check(!!camera, '1.0 premise: a camera marker exists');
	const channelInfo = await page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const object = group.getObjectByProperty('uuid', id);
		let box = null;
		group.traverse((n) => { if (n.isMesh && !n.userData.camera && !box) box = n; });
		return {
			listed: ap.CHANNELS.includes('camera.fov'),
			applies: ap.channelApplies(object, 'camera.fov'),
			notOnBox: box ? ap.channelApplies(box, 'camera.fov') : false,
			label: ap.channelLabel('camera.fov'),
			value: ap.channelValue(object, 'camera.fov')
		};
	}, camera);
	h.check(channelInfo.listed && channelInfo.applies, '1.1 a perspective camera offers the channel');
	h.check(!channelInfo.notOnBox, '1.2 ...nothing else does');
	h.check(channelInfo.label === 'Field of view', '1.3 it has a name: ' + channelInfo.label);
	h.check(channelInfo.value === 50, '1.4 it reads the lens: ' + channelInfo.value);
	const camTracks = await addClip(page, camera, { 'camera.fov': [{ t: 0, v: 60 }, { t: 2, v: 20 }] });
	h.check(camTracks.some(([c, keys]) => c === 'camera.fov' && keys[0][1] === 60 && keys[1][1] === 20), '1.5 keyed 60 to 20: ' + JSON.stringify(camTracks));
	const played = await page.evaluate(async (id) => {
		const ap = window.__stores.animationPreview;
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const object = group.getObjectByProperty('uuid', id);
		const clip = ap.getAnim(id);
		const mid = ap.evaluateClip(clip, 1)['camera.fov'];
		const base = object.userData.camera.fov;
		return { mid, base };
	}, camera);
	h.check(played.mid > 20 && played.mid < 60, '1.6 the clip evaluates between the keys: ' + played.mid);
	await h.eventually(
		() => B.page.evaluate((id) => window.__stores.animationPreview.getAnim(id)?.tracks?.some((t) => t.channel === 'camera.fov') ?? false, camera),
		(v) => v === true,
		'1.7 the track reached B',
		20000
	);

	console.log('\n=== 2. a material clip ===');
	const box = await createObject(page, '/create box');
	await page.evaluate((id) => {
		const M = window.__stores.materialsHandler;
		M.setObjectColor(id, '#336699');
		M.setMaterialParam(id, 'roughness', 0.7);
	}, box);
	await addClip(page, box, {
		opacity: [{ t: 0, v: 1 }, { t: 2, v: 0.25 }],
		'color.r': [{ t: 0, v: 0 }, { t: 2, v: 1 }],
		metalness: [{ t: 0, v: 0 }, { t: 2, v: 1 }],
		roughness: [{ t: 0, v: 1 }, { t: 2, v: 0 }],
		emissive: [{ t: 0, v: 0 }, { t: 2, v: 4 }],
		visible: [{ t: 0, v: 1 }, { t: 1, v: 0 }, { t: 2, v: 1 }],
		'pos.y': [{ t: 0, v: 0 }, { t: 2, v: 3 }]
	});

	console.log('\n=== 3. a light clip ===');
	const light = await createObject(page, '/light point');
	h.check(!!light, '3.0 premise: a point light exists');
	await addClip(page, light, { 'light.intensity': [{ t: 0, v: 2 }, { t: 2, v: 8 }] });

	console.log('\n=== 4. the file ===');
	const file = await exportGlb(page, [box, light, camera]);
	fs.writeFileSync(path.join(OUT, 'look-animation.glb'), Buffer.from(file.base64, 'base64'));
	const { json, channels } = file;
	const pointers = channels.filter((c) => c.pointer);
	h.check(json.extensionsUsed.includes('KHR_animation_pointer'), '4.1 the file declares KHR_animation_pointer');
	h.check(!(json.extensionsRequired ?? []).includes('KHR_animation_pointer'), '4.2 ...as used, not required: other viewers still open it');
	for (const c of pointers) {
		h.check(resolves(json, c.pointer), '4.3 the pointer resolves in the document: ' + c.pointer);
		h.check(c.path === 'pointer' && c.node === undefined, '4.4 ...the channel has path "pointer" and no node');
		h.check(c.input.min && c.input.max, '4.5 ...its time accessor has min and max');
		const monotonic = c.input.values.every((t, i, list) => i === 0 || t > list[i - 1]);
		h.check(monotonic, '4.6 ...and times only go up');
	}
	const at = (needle) => pointers.find((c) => c.pointer.endsWith(needle));
	const material = json.materials.find((m) => m.pbrMetallicRoughness && at('baseColorFactor')?.pointer.includes('/materials/' + json.materials.indexOf(m) + '/'));

	const baseColor = at('/baseColorFactor');
	h.check(!!baseColor && baseColor.output.size === 4, '4.7 colour + opacity = one VEC4 track');
	const lastColor = baseColor.output.values.slice(-4);
	const firstColor = baseColor.output.values.slice(0, 4);
	h.check(near(firstColor[0], 0) && near(lastColor[0], 1), '4.8 red runs 0 to 1: ' + firstColor[0] + ' .. ' + lastColor[0]);
	h.check(near(firstColor[3], 1) && near(lastColor[3], 0.25), '4.9 alpha runs 1 to 0.25: ' + firstColor[3] + ' .. ' + lastColor[3]);
	// green and blue are unkeyed: they hold the base colour, in the linear space glTF stores
	const base = await page.evaluate((id) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		const c = group.getObjectByProperty('uuid', id).material.color;
		return [c.r, c.g, c.b];
	}, box);
	h.check(near(firstColor[1], base[1]) && near(lastColor[2], base[2]), '4.10 unkeyed green and blue hold the base colour');
	h.check(material?.alphaMode === 'BLEND', '4.11 a fade below 1 turns on BLEND, or the alpha would not draw');

	const metal = at('/metallicFactor');
	const rough = at('/roughnessFactor');
	h.check(near(metal.output.values[0], 0) && near(metal.output.values.at(-1), 1), '4.12 metalness 0 to 1');
	h.check(near(rough.output.values[0], 1) && near(rough.output.values.at(-1), 0), '4.13 roughness 1 to 0');
	// a value the app plays is the value in the file, mid-clip too
	const midApp = await page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		return ap.evaluateClip(ap.getAnim(id), 1);
	}, box);
	const sampleAt = (c, t) => {
		const i = c.input.values.findIndex((v) => v >= t - 1e-4);
		return c.output.values[i * c.output.size];
	};
	h.check(near(sampleAt(metal, 1), midApp.metalness, 0.02), '4.14 mid-clip the file matches the app: ' + sampleAt(metal, 1) + ' vs ' + midApp.metalness);

	const emissive = at('/emissiveStrength');
	h.check(near(emissive.output.values.at(-1), 4), '4.15 emission strength reaches 4 (above 1, why the extension is needed)');
	h.check(json.extensionsUsed.includes('KHR_materials_emissive_strength'), '4.16 ...and the extension is declared');
	h.check(material?.emissiveFactor?.some((n) => n > 0), '4.17 ...on a colour that is not black: ' + JSON.stringify(material?.emissiveFactor));

	const visible = at('/visible');
	h.check(visible.interpolation === 'STEP' && visible.output.componentType === 5121, '4.18 visibility is a held byte');
	h.check(visible.output.values.includes(0) && visible.output.values.includes(255), '4.19 ...that turns off and on: ' + visible.output.values.join(','));
	h.check(json.extensionsUsed.includes('KHR_node_visibility'), '4.20 KHR_node_visibility is declared');

	const lightTrack = at('/intensity');
	h.check(near(lightTrack.output.values[0], 2) && near(lightTrack.output.values.at(-1), 8), '4.21 light intensity 2 to 8');

	const fov = at('/yfov');
	h.check(near(fov.output.values[0], (60 * Math.PI) / 180) && near(fov.output.values.at(-1), (20 * Math.PI) / 180), '4.22 field of view in radians');
	h.check(json.cameras?.[0]?.type === 'perspective' && json.cameras[0].perspective.znear > 0, '4.23 the marker is a real glTF camera: ' + JSON.stringify(json.cameras?.[0]));
	const cameraNode = json.nodes.find((n) => n.camera !== undefined);
	h.check(!!cameraNode, '4.24 ...on a node');

	const moved = channels.find((c) => c.path === 'translation');
	h.check(!!moved, '4.25 the movement still exports as an ordinary channel');
	const boxAnimation = json.animations.find((a) => a.channels.some((c) => c.target.path === 'translation'));
	h.check(boxAnimation.channels.some((c) => c.target.path === 'pointer'), '4.26 ...in the SAME animation as its look, so they play as one');
	h.check(json.animations.every((a) => a.channels.length > 0 && a.samplers.length > 0), '4.27 no empty animation (the schema refuses them)');

	console.log('\n=== 5. an ordinary loader still reads it ===');
	const loaded = await page.evaluate(async (base64) => {
		const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js').catch(() => ({}));
		if (!GLTFLoader) return { skipped: true };
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
		return new Promise((resolve) => {
			new GLTFLoader().parse(
				bytes.buffer,
				'',
				(gltf) => resolve({ clips: gltf.animations.map((a) => [a.name, a.tracks.length]), cameras: gltf.cameras.length }),
				(error) => resolve({ error: String(error) })
			);
		});
	}, file.base64);
	if (loaded.skipped) console.log('SKIP 5: no direct module import on this build');
	else {
		h.check(!loaded.error, '5.1 GLTFLoader opens the file: ' + JSON.stringify(loaded));
		h.check(loaded.clips?.some(([, tracks]) => tracks > 0), '5.2 ...and keeps the movement');
		h.check(loaded.cameras === 1, '5.3 ...and finds the camera');
	}

	console.log('\n=== 6. only exports carry it ===');
	const plain = await exportGlb(page, [box], { lookAnimation: false });
	h.check(!plain.channels.some((c) => c.pointer) && !plain.json.extensionsUsed?.includes('KHR_animation_pointer'), '6.1 the Quest path asks for no pointers and gets none');
	const scene = await page.evaluate(() => JSON.stringify(window.__stores.sessions.buildSessionPayload('look')).includes('KHR_animation_pointer'));
	h.check(!scene, '6.2 a saved scene stays free of it: the clip itself is what a scene saves');
	const fovAfter = await page.evaluate((id) => {
		let group = null;
		window.__stores.objectsGroup.subscribe((g) => (group = g))();
		return group.getObjectByProperty('uuid', id).userData.camera.fov;
	}, camera);
	h.check(fovAfter === 50, '6.3 exporting leaves the live lens at its base: ' + fovAfter);

	console.log('\n=== 7. an origin baked on a clone keeps its pointers ===');
	const door = await createObject(page, '/create box');
	await page.evaluate((id) => window.__stores.objectOrigin.setOriginFor(id, [0.5, 0, 0]), door);
	await addClip(page, door, { metalness: [{ t: 0, v: 0 }, { t: 1, v: 1 }], 'rot.y': [{ t: 0, v: 0 }, { t: 1, v: 1 }] }, 1);
	const doorFile = await exportGlb(page, [door]);
	h.check(doorFile.channels.some((c) => c.pointer?.endsWith('/metallicFactor')), '7.1 the pointer survives the clone path');

	h.check(h.pageErrors(A).length === 0, '8.1 no page errors on A (' + JSON.stringify(h.pageErrors(A)) + ')');
	h.check(h.pageErrors(B).length === 0, '8.2 no page errors on B (' + JSON.stringify(h.pageErrors(B)) + ')');
	await h.finish(browser);
});

// OBJECTS AND MATERIALS FROM OTHER PEOPLE AND FROM FILES ARE CHECKED BEFORE THEY LOAD
// (loadGuardCore.js / loadGuard.js). One page, the REAL dispatcher through a stubbed conn (the
// wire-hardening seam) and the real file path (fileHandler.load).
//
// What it holds the app to:
//   · a material that is not one of the standard types arrives as a standard material (object
//     message, materials message, scene file), and no foreign program is compiled;
//   · nothing the app receives or opens makes it request an outside address (an image in an
//     object, a glTF image or buffer, a .glb, a scene file);
//   · the ordinary forms still arrive whole: a textured mesh with a material array, a glTF the
//     exporter wrote, a material set with an embedded image.
//
// Run: APP_URL=https://theprototype.app:5175/ npm run e2e -- load-check
const h = require('./helpers.cjs');

const MARK = 'load-check.invalid';
const PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

h.run(async () => {
	const browser = await h.launch();
	const peer = await h.setupPage(browser, 'loadcheck');
	const page = peer.page;
	/** @type {string[]} */
	const requested = [];
	page.on('request', (r) => {
		if (r.url().includes(MARK)) requested.push(r.url());
	});
	await page.waitForFunction(() => !!window.__stores?.loadGuard && !!window.__stores?.THREE && !!window.__stores?.peers, null, {
		timeout: 60000
	});

	await page.evaluate(
		async ({ png }) => {
			const s = window.__stores;
			const T = s.THREE.default ?? s.THREE;
			const { GLTFExporter } = s.GLTFExporterModule;
			s.loadGuard.resetLoadGuard();
			let pc = null;
			s.peers.subscribe((v) => (pc = v))();
			const handlers = {};
			const conn = { peer: 'loadchk1', open: true, on: (ev, fn) => (handlers[ev] = fn), send() {} };
			pc.wireData(conn);
			const program = (tag) =>
				new T.ShaderMaterial({
					vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
					fragmentShader: 'void main(){ gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); } // ' + tag
				});
			const texture = () =>
				new Promise((resolve) => {
					const image = new Image();
					image.onload = () => {
						const t = new T.Texture(image);
						t.needsUpdate = true;
						resolve(t);
					};
					image.src = png;
				});
			const group = () => {
				let g = null;
				s.objectsGroup.subscribe((v) => (g = v))();
				return g;
			};
			const renderer = () => {
				let r = null;
				s.globalRenderer.subscribe((v) => (r = v))();
				return r;
			};
			window.__lc = {
				deliver: (m) => handlers.data(m),
				T,
				program,
				texture,
				group,
				exportGltf: (object) => new Promise((resolve, reject) => new GLTFExporter().parse(object, resolve, reject, { onlyVisible: false })),
				probe: (name) => {
					const o = group().getObjectByName(name);
					if (!o) return { found: false };
					const types = [];
					let compiledProgram = false;
					let maps = 0;
					o.traverse((x) => {
						for (const m of [].concat(x.material ?? [])) {
							types.push(m.type);
							if (m.map) maps++;
							const prog = renderer()?.properties?.get(m)?.currentProgram;
							if (prog && m.isShaderMaterial) compiledProgram = true;
						}
					});
					return { found: true, types, maps, compiledProgram };
				}
			};
		},
		{ png: PNG }
	);
	const settle = (ms = 1500) => page.waitForTimeout(ms);

	// ---- 1. a program material in an object message ---------------------------------------
	await page.evaluate((mark) => {
		const { T, program, deliver } = window.__lc;
		const mesh = new T.Mesh(new T.BoxGeometry(), program('one'));
		mesh.name = 'lc-program';
		const json = mesh.toJSON();
		json.images = [{ uuid: 'lc-img', url: 'https://' + mark + '/object.png' }];
		json.textures = [{ uuid: 'lc-tex', image: 'lc-img' }];
		deliver({ type: 'object', element: json });
	}, MARK);
	await settle();
	const one = await page.evaluate(() => window.__lc.probe('lc-program'));
	h.check(one.found, `the object still arrives (${JSON.stringify(one)})`);
	h.check(one.types?.length === 1 && one.types[0] === 'MeshStandardMaterial', `…wearing a standard material (${one.types})`);
	h.check(!one.compiledProgram, 'no foreign program was compiled');

	// ---- 2. a program material in a materials message --------------------------------------
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await settle(800);
	const two = await page.evaluate(() => {
		const { T, program, deliver, group } = window.__lc;
		const g = group();
		const box = g.children[g.children.length - 1];
		box.name = 'lc-materials';
		const json = new T.Mesh(new T.BoxGeometry(), program('two')).toJSON();
		deliver({ type: 'objectParameters', parameter: 'materials', uuid: box.uuid, payload: { materials: json.materials, textures: [], images: [] } });
		return box.uuid;
	});
	await settle();
	const twoProbe = await page.evaluate(() => window.__lc.probe('lc-materials'));
	h.check(!!two && twoProbe.types?.[0] === 'MeshStandardMaterial' && !twoProbe.compiledProgram, `a materials message cannot install a program (${JSON.stringify(twoProbe)})`);

	// ---- 3. glTF forms of the object message: image uri, buffer uri, .glb ----------------------
	await page.evaluate(({ mark, png }) => {
		const { T, deliver } = window.__lc;
		const floats = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		const b64 = btoa(String.fromCharCode(...new Uint8Array(floats.buffer)));
		const doc = (name, imageUri, bufferUri) => ({
			asset: { version: '2.0' },
			scene: 0,
			scenes: [{ nodes: [0] }],
			nodes: [{ mesh: 0, name }],
			meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
			materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
			textures: [{ source: 0 }],
			images: [{ uri: imageUri }],
			accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', max: [1, 1, 0], min: [0, 0, 0] }],
			bufferViews: [{ buffer: 0, byteLength: 36 }],
			buffers: [{ byteLength: 36, uri: bufferUri ?? 'data:application/octet-stream;base64,' + b64 }]
		});
		const id = () => T.MathUtils.generateUUID();
		deliver({ type: 'object', uuids: [id()], element: doc('lc-gltf-image', 'https://' + mark + '/gltf.png') });
		deliver({ type: 'object', uuids: [id()], element: doc('lc-gltf-buffer', png, 'https://' + mark + '/gltf.bin') });
		const json = doc('lc-glb', 'https://' + mark + '/glb.png');
		delete json.buffers[0].uri;
		let text = JSON.stringify(json);
		while (text.length % 4) text += ' ';
		const jb = new TextEncoder().encode(text);
		const total = 20 + jb.length + 8 + 36;
		const glb = new ArrayBuffer(total);
		const v = new DataView(glb);
		v.setUint32(0, 0x46546c67, true);
		v.setUint32(4, 2, true);
		v.setUint32(8, total, true);
		v.setUint32(12, jb.length, true);
		v.setUint32(16, 0x4e4f534a, true);
		new Uint8Array(glb, 20, jb.length).set(jb);
		v.setUint32(20 + jb.length, 36, true);
		v.setUint32(24 + jb.length, 0x004e4942, true);
		new Uint8Array(glb, 28 + jb.length, 36).set(new Uint8Array(floats.buffer));
		deliver({ type: 'object', uuids: [id()], element: glb });
	}, { mark: MARK, png: PNG });
	await settle(3000);

	// ---- 4. a scene file -------------------------------------------------------------------
	await page.evaluate(async (mark) => {
		const s = window.__stores;
		const { T, program } = window.__lc;
		const mesh = new T.Mesh(new T.BoxGeometry(), program('file'));
		mesh.name = 'lc-file';
		const json = mesh.toJSON();
		json.images = [{ uuid: 'lc-fimg', url: 'https://' + mark + '/file.png' }];
		json.textures = [{ uuid: 'lc-ftex', image: 'lc-fimg' }];
		const payload = s.sessions.buildSessionPayload('load-check');
		payload.objects = [json];
		const zip = await s.sessions.exportSessionZip(payload, { assets: false, packs: false, flow: true });
		await s.fileHandler.load(new File([zip], 'load-check.tpscene'));
	}, MARK);
	await settle(4000);
	const four = await page.evaluate(() => window.__lc.probe('lc-file'));
	h.check(four.found && four.types?.[0] === 'MeshStandardMaterial' && !four.compiledProgram, `a scene file cannot install a program (${JSON.stringify(four)})`);

	h.check(requested.length === 0, `nothing requested an outside address (${JSON.stringify(requested)})`);
	const totals = await page.evaluate(() => window.__stores.loadGuard.loadGuardTotals());
	h.check(totals.materials >= 3 && totals.refused >= 3, `the checks counted what they changed (${JSON.stringify(totals)})`);
	const counted = await page.evaluate(() => window.__stores.wireErrors.wireErrors().filter((e) => e.type.startsWith('checked:')).map((e) => e.peerId + ' ' + e.type));
	h.check(counted.some((c) => c.startsWith('loadchk1 checked:object')), `…per sender, in the wire counters (${counted})`);

	// ---- 5. the ordinary forms still arrive whole -------------------------------------------
	await page.evaluate(async () => {
		const { T, texture, deliver, exportGltf } = window.__lc;
		// a material ARRAY with groups and a textured slot, through the toJSON path
		const geometry = new T.BufferGeometry().copy(new T.BoxGeometry());
		geometry.clearGroups();
		geometry.addGroup(0, 18, 0);
		geometry.addGroup(18, 18, 1);
		const multi = new T.Mesh(geometry, [new T.MeshStandardMaterial({ map: await texture() }), new T.MeshPhysicalMaterial({ color: 0x2288ff })]);
		multi.name = 'lc-multi';
		deliver({ type: 'object', element: multi.toJSON() });
		// what the exporter writes for an ordinary textured mesh
		const box = new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial({ map: await texture() }));
		box.name = 'lc-gltf-ok';
		const holder = new T.Group();
		holder.add(box);
		const gltf = await exportGltf(holder);
		deliver({ type: 'object', uuids: [T.MathUtils.generateUUID()], element: gltf });
	});
	await settle(3000);
	const multi = await page.evaluate(() => window.__lc.probe('lc-multi'));
	h.check(
		multi.found && multi.types?.join(',') === 'MeshStandardMaterial,MeshPhysicalMaterial' && multi.maps === 1,
		`a textured material array arrives as sent (${JSON.stringify(multi)})`
	);
	const ok = await page.evaluate(() => window.__lc.probe('lc-gltf-ok'));
	h.check(ok.found && ok.maps === 1, `an exported glTF arrives with its texture (${JSON.stringify(ok)})`);
	// its own box: section 3 opened a scene file, which replaced everything made before it
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await settle(800);
	const embedded = await page.evaluate(
		async ({ png }) => {
			const { T, deliver, probe, group } = window.__lc;
			const g = group();
			const target = g.children[g.children.length - 1];
			target.name = 'lc-embedded';
			const json = new T.Mesh(new T.BoxGeometry(), new T.MeshStandardMaterial({ color: 0x00ff00 })).toJSON();
			json.materials[0].map = 'lc-etex';
			deliver({
				type: 'objectParameters',
				parameter: 'materials',
				uuid: target.uuid,
				payload: { materials: json.materials, textures: [{ uuid: 'lc-etex', image: 'lc-eimg' }], images: [{ uuid: 'lc-eimg', url: png }] }
			});
			await new Promise((r) => setTimeout(r, 500));
			return probe('lc-embedded');
		},
		{ png: PNG }
	);
	h.check(embedded.maps === 1 && embedded.types?.[0] === 'MeshStandardMaterial', `a material set with an embedded image keeps it (${JSON.stringify(embedded)})`);
	h.check(requested.length === 0, `still nothing requested outside (${requested.length})`);

	await h.finish(browser);
});

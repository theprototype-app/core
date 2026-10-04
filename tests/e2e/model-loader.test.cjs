// 34 R7 (E1) — api.loadModel (src/lib/modelLoader.js + gltfLoader.js + sdk/models.js; the
// rules are modelLoaderCore.js, unit-tested in tests/unit/modelLoaderCore.test.js). A test
// module gets PACKAGED files (registerModuleAssets, exactly what a zip install does) made
// in-page with the app's own GLTFExporter, plus one real compressed file:
//   fixtures/meshopt-ktx2.glb = the Waves crystal (CC0, made with Meshy.ai) through
//   `gltfpack -si 0.1 -tl 32 -tc -cc` — EXT_meshopt_compression + KHR_texture_basisu REQUIRED.
//   1 one THREE: the handle's scene is the scene's THREE; info; the default LOD
//   2 one parse per URL: a second load is a cache hit; geometry shared; ownMaterials
//   3 automatic LOD on module content outside objectsGroup: far draws fewer triangles
//   4 lod:false opts out
//   5 contract P1: level FILES beside a packaged model become a LOD group (outside objectsGroup)
//   6 skinned: every instance has its own bones
//   7 castShadow / collider
//   8 Meshopt + KTX2 decode; the transcoder is fetched only for the file that needs it
//   9 errors reject with a reason
//  11 a copy the module drops WITHOUT release() (a wrapper removed — Waves' enemies) is parked:
//     its LOD dropped, held weakly, collected; brought back, it is picked up again
//  10 T2: unloading the module disposes everything it loaded (objectsGroup copies stay);
//     a load still in flight when the module unloads is refused, not leaked
// Run: APP_URL=https://theprototype.app:5297/ npm run e2e -- model-loader
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

h.run(async () => {
	// --expose-gc: section 11 proves a dropped copy is COLLECTED, not just forgotten
	const browser = await h.launch({ args: [...h.GPU_ARGS, '--js-flags=--expose-gc'] });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	/** every request for the Basis transcoder, in order */
	const basisHits = [];
	page.on('request', (r) => {
		if (/\/basis\/basis_transcoder\.(js|wasm)/.test(r.url())) basisHits.push(r.url());
	});
	const tinyB64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'meshopt-ktx2.glb')).toString('base64');

	const fixture = await page.evaluate(async (tinyB64) => {
		const s = window.__stores;
		const THREE = s.THREE;
		const { GLTFExporter } = s.GLTFExporterModule;
		const toBlobUrl = (buf) => URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
		const ball = async (w, hgt) => {
			const scene = new THREE.Scene();
			const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, w, hgt), new THREE.MeshStandardMaterial({ color: 0x8899aa, name: 'BallMat' }));
			mesh.name = 'Body';
			scene.add(mesh);
			return { url: toBlobUrl(await new GLTFExporter().parseAsync(scene, { binary: true })), tris: mesh.geometry.index.count / 3 };
		};
		const rig = async () => {
			const scene = new THREE.Scene();
			const geo = new THREE.CylinderGeometry(0.2, 0.2, 2, 8, 4);
			const pos = geo.attributes.position;
			const idx = [];
			const wts = [];
			for (let i = 0; i < pos.count; i++) {
				const up = pos.getY(i) > 0 ? 1 : 0;
				idx.push(up, 0, 0, 0);
				wts.push(1, 0, 0, 0);
			}
			geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
			geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
			const b0 = new THREE.Bone();
			b0.name = 'Hip';
			const b1 = new THREE.Bone();
			b1.name = 'Knee';
			b1.position.y = 1;
			b0.add(b1);
			const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ name: 'RigMat' }));
			mesh.name = 'Leg';
			mesh.add(b0);
			mesh.bind(new THREE.Skeleton([b0, b1]));
			const root = new THREE.Group();
			root.name = 'Rig';
			root.add(mesh);
			scene.add(root);
			return toBlobUrl(await new GLTFExporter().parseAsync(scene, { binary: true }));
		};
		const lod0 = await ball(96, 48);
		const lod1 = await ball(32, 16);
		const lod2 = await ball(10, 5);
		const bin = atob(tinyB64);
		const tiny = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) tiny[i] = bin.charCodeAt(i);
		const assets = {
			'assets/ball.glb': lod0.url,
			'assets/ball.lod1.glb': lod1.url,
			'assets/ball.lod2.glb': lod2.url,
			'assets/rig.glb': await rig(),
			'assets/tiny.glb': toBlobUrl(tiny.buffer)
		};
		s.moduleSDK.registerModuleAssets('mltest', assets);
		await s.moduleSDK.initModules([{ id: 'mltest', name: 'Model loader test', version: '1.0.0', description: 'api.loadModel', register: (api) => (window.__mlapi = api) }]);
		const read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
		// a group at the scene root, far from the editor's own content
		const holder = new THREE.Group();
		holder.name = 'mltest-holder';
		holder.position.set(60, 1, -60);
		read(s.globalScene).add(holder);
		window.__ml = {
			read,
			holder,
			/** triangles `object` adds to ONE render from `dist` metres in front of it */
			drawn(object, dist) {
				const r = read(s.globalRenderer);
				const scene = read(s.globalScene);
				const target = new THREE.Vector3();
				object.getWorldPosition(target);
				const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
				cam.position.set(target.x, target.y, target.z + dist);
				cam.lookAt(target);
				cam.updateMatrixWorld(true);
				const auto = r.info.autoReset;
				r.info.autoReset = true;
				const was = object.visible;
				object.visible = true;
				r.render(scene, cam);
				const on = r.info.render.triangles;
				object.visible = false;
				r.render(scene, cam);
				const off = r.info.render.triangles;
				object.visible = was;
				r.info.autoReset = auto;
				return on - off;
			}
		};
		return { lod0: lod0.tris, lod1: lod1.tris, lod2: lod2.tris, hasApi: typeof window.__mlapi?.loadModel === 'function' };
	}, tinyB64);
	h.check(fixture.hasApi, '0.1 the api carries loadModel');
	h.check(fixture.lod0 > 8000 && fixture.lod2 < 150, '0.2 (premise) the fixture: ball ' + fixture.lod0 + ' tris, lod1 ' + fixture.lod1 + ', lod2 ' + fixture.lod2);

	// ---- 1 one THREE ------------------------------------------------------------------------------
	const one = await page.evaluate(async () => {
		const s = window.__stores;
		const hd = await window.__mlapi.loadModel('assets/ball.glb');
		window.__h1 = hd;
		let mesh = null;
		hd.scene.traverse((o) => (o.isMesh ? (mesh = o) : null));
		return {
			sameThree: hd.scene instanceof s.THREE.Object3D && mesh instanceof s.THREE.Mesh && mesh.material instanceof s.THREE.MeshStandardMaterial,
			info: hd.info,
			animations: Array.isArray(hd.animations),
			stats: s.modelLoader.modelStats()
		};
	});
	h.check(one.sameThree, '1.1 the loaded scene is built from the SCENE\'s THREE (instanceof Object3D / Mesh / MeshStandardMaterial — no second three)');
	h.check(one.info.meshes === 1 && one.info.triangles === fixture.lod0 && one.info.skinned === false && one.animations, '1.2 info: ' + JSON.stringify(one.info));
	h.check(one.stats.loads === 1 && one.stats.templates.length === 1 && one.stats.templates[0].refs === 1, '1.3 one parse, one template, one ref: ' + JSON.stringify(one.stats.templates));
	h.check(JSON.stringify(one.stats.owners) === JSON.stringify({ mltest: [{ url: one.stats.templates[0].url, instances: 1, parked: 0 }] }), '1.4 the handle is filed under its module: ' + JSON.stringify(one.stats.owners));

	// ---- 2 one parse per URL ---------------------------------------------------------------------
	const two = await page.evaluate(async () => {
		const s = window.__stores;
		const before = s.modelLoader.modelStats();
		const h2 = await window.__mlapi.loadModel('assets/ball.glb', { lod: false });
		window.__h2 = h2;
		const meshOf = (root) => {
			let m = null;
			root.traverse((o) => (o.isMesh ? (m = o) : null));
			return m;
		};
		const a = meshOf(window.__h1.scene);
		const b = meshOf(h2.scene);
		const c = window.__h1.instance();
		const d = window.__h1.instance({ ownMaterials: true });
		const after = s.modelLoader.modelStats();
		return {
			loads: [before.loads, after.loads],
			hits: after.cacheHits - before.cacheHits,
			refs: after.templates[0].refs,
			sharedGeo: a.geometry === b.geometry && meshOf(c).geometry === a.geometry && meshOf(d).geometry === a.geometry,
			sharedMat: meshOf(c).material === a.material,
			ownMat: meshOf(d).material !== a.material && meshOf(d).material.name === 'BallMat',
			ownScene: window.__h1.scene !== h2.scene,
			count: window.__h1.instances
		};
	});
	h.check(two.loads[0] === 1 && two.loads[1] === 1 && two.hits === 1 && two.refs === 2, '2.1 a second module handle on the same URL is a CACHE HIT (loads ' + two.loads + ', hits ' + two.hits + ', refs ' + two.refs + ')');
	h.check(two.sharedGeo && two.ownScene, '2.2 every handle and instance shares the ONE geometry, each handle has its own scene');
	h.check(two.sharedMat && two.ownMat, '2.3 materials are shared by default; instance({ownMaterials: true}) gets its own copy');
	h.check(two.count === 3, '2.4 the handle counts its live instances (scene + 2): ' + two.count);

	// ---- 3 automatic LOD on module content outside objectsGroup ----------------------------------
	await page.evaluate(() => {
		window.__ml.holder.add(window.__h1.scene);
		window.__h1.scene.position.set(0, 0, 0);
	});
	await h.eventually(
		() => page.evaluate(() => window.__stores.lod.lodStats().meshes.filter((m) => m.explicit && m.name === 'Body' && Array.isArray(m.levels) && m.levels.length >= 2).length),
		(n) => n >= 1,
		'3.1 the instance\'s mesh is registered EXPLICITLY (scene root, not objectsGroup) and its levels were built',
		20000
	);
	const lod3 = await page.evaluate(() => ({ near: window.__ml.drawn(window.__h1.scene, 3), far: window.__ml.drawn(window.__h1.scene, 80) }));
	h.check(lod3.near === fixture.lod0 && lod3.far < fixture.lod0 * 0.6, '3.2 up close it draws all ' + lod3.near + ' triangles, from 80 m a level (' + lod3.far + ')');

	// ---- 4 lod:false -----------------------------------------------------------------------------
	const off4 = await page.evaluate(() => {
		let flag = null;
		window.__h2.scene.traverse((o) => (o.isMesh ? (flag = o.userData.lod) : null));
		window.__ml.holder.add(window.__h2.scene);
		window.__h2.scene.position.set(4, 0, 0);
		return { flag, far: window.__ml.drawn(window.__h2.scene, 80), explicit: window.__stores.lod.lodStats().meshes.filter((m) => m.explicit && m.name === 'Body').length };
	});
	h.check(off4.flag === false && off4.far === fixture.lod0, '4.1 lod:false marks every mesh out of auto LOD and it draws whole from 80 m (' + off4.far + ')');

	// ---- 5 contract P1: level files beside a packaged model ---------------------------------------
	const p1 = await page.evaluate(async () => {
		const s = window.__stores;
		const hd = await window.__mlapi.loadModel('assets/ball.glb', { lod: [{ file: 'ball.lod2.glb', ratio: 0.03 }, { file: 'ball.lod1.glb', ratio: 0.12 }] });
		window.__h5 = hd;
		window.__ml.holder.add(hd.scene);
		hd.scene.position.set(-4, 0, 0);
		s.lodGroup.scanLodGroups();
		const block = JSON.parse(JSON.stringify(hd.scene.userData.lod));
		return { block, entry: s.lodGroup.lodGroupForTest.entries().has(hd.scene), explicit: s.lod.lodStats().meshes.filter((m) => m.explicit && m.name === 'Body').length };
	});
	h.check(
		!!p1.block && p1.block.levels.length === 3 && p1.block.levels[0].source === 'self' && p1.block.levels.slice(1).every((l) => l.source === 'pack' && /^blob:/.test(l.ref)),
		'5.1 the level files became a LOD GROUP, finest first, refs = the module\'s own packaged blobs: ' + JSON.stringify(p1.block?.levels?.map((l) => [l.source, l.ratio]))
	);
	h.check(p1.entry, '5.2 lodGroup draws it although it lives OUTSIDE objectsGroup (an extra root)');
	// the first far render ASKS for the level; it lands a moment later
	await page.evaluate(() => window.__ml.drawn(window.__h5.scene, 120));
	await h.eventually(() => page.evaluate(() => window.__ml.drawn(window.__h5.scene, 120)), (t) => t > 0 && t <= fixture.lod1, '5.3 from 120 m the group draws a level FILE (<= LOD1\'s ' + fixture.lod1 + ' triangles)', 15000);
	const p1near = await page.evaluate(() => window.__ml.drawn(window.__h5.scene, 2));
	h.check(p1near === fixture.lod0, '5.4 up close it draws LOD0 again (' + p1near + ')');

	// ---- 6 skinned ---------------------------------------------------------------------------------
	const sk = await page.evaluate(async () => {
		const hd = await window.__mlapi.loadModel('assets/rig.glb');
		const a = hd.scene;
		const b = hd.instance();
		const skinOf = (root) => {
			let m = null;
			root.traverse((o) => (o.isSkinnedMesh ? (m = o) : null));
			return m;
		};
		const sa = skinOf(a);
		const sb = skinOf(b);
		let inB = true;
		for (const bone of sb.skeleton.bones) {
			let found = false;
			b.traverse((o) => (o === bone ? (found = true) : null));
			inB &&= found;
		}
		window.__h6 = hd;
		return { skinned: hd.info.skinned, ownBones: sa.skeleton.bones[0] !== sb.skeleton.bones[0], inB, sharedGeo: sa.geometry === sb.geometry, bones: sb.skeleton.bones.map((x) => x.name) };
	});
	h.check(sk.skinned && sk.ownBones && sk.inB, '6.1 a skinned model\'s instance has its OWN bones, inside its own tree (' + JSON.stringify(sk.bones) + ')');
	h.check(sk.sharedGeo, '6.2 ... while the geometry is still shared');

	// ---- 7 castShadow / collider -------------------------------------------------------------------
	const opt = await page.evaluate(async () => {
		const hd = await window.__mlapi.loadModel('assets/ball.glb', { castShadow: true, receiveShadow: true, collider: 'hull', lod: false });
		window.__h7 = hd;
		const meshes = [];
		hd.scene.traverse((o) => (o.isMesh ? meshes.push([o.castShadow, o.receiveShadow]) : null));
		const inst = hd.instance();
		return { meshes, hint: hd.scene.userData.colliderHint, instHint: inst.userData.colliderHint };
	});
	h.check(opt.meshes.length === 1 && opt.meshes.every(([c, r]) => c && r), '7.1 castShadow/receiveShadow reach every mesh');
	h.check(opt.hint === 'hull' && opt.instHint === 'hull', '7.2 collider stamps userData.colliderHint on the copy and its instances');

	// ---- 8 Meshopt + KTX2 ----------------------------------------------------------------------------
	h.check(basisHits.length === 0, '8.0 (premise) six plain GLBs loaded and the Basis transcoder was never fetched (' + basisHits.length + ')');
	const kt = await page.evaluate(async () => {
		const s = window.__stores;
		try {
			const hd = await window.__mlapi.loadModel('assets/tiny.glb', { lod: false });
			window.__h8 = hd;
			const tex = [];
			let quantized = false;
			hd.scene.traverse((o) => {
				if (!o.isMesh) return;
				quantized ||= o.geometry.attributes.position.array.constructor.name !== 'Float32Array';
				for (const k of Object.keys(o.material)) if (o.material[k]?.isTexture) tex.push({ k, compressed: !!o.material[k].isCompressedTexture, w: o.material[k].image?.width ?? null });
			});
			return { ok: true, info: hd.info, tex, quantized, loader: s.modelLoader.modelStats().loader };
		} catch (e) {
			return { ok: false, error: String(e?.message ?? e) };
		}
	});
	h.check(kt.ok && kt.info.triangles > 0, '8.1 a REQUIRED EXT_meshopt_compression + KHR_texture_basisu file parses: ' + JSON.stringify(kt.ok ? kt.info : kt.error));
	h.check(kt.ok && kt.tex.length >= 1 && kt.tex.every((t) => t.compressed), '8.2 its textures arrive TRANSCODED (CompressedTexture): ' + JSON.stringify(kt.tex));
	h.check(basisHits.some((u) => /basis_transcoder\.wasm/.test(u)) && kt.loader?.ktx2Files === 1, '8.3 the transcoder was fetched for that file and only that one (' + basisHits.length + ' requests, ktx2Files ' + kt.loader?.ktx2Files + ')');

	// ---- 9 errors ----------------------------------------------------------------------------------
	const err = await page.evaluate(async () => {
		const out = {};
		for (const [k, url] of [['missing', 'assets/missing.glb'], ['http', '/no-such-model.glb']]) {
			try {
				await window.__mlapi.loadModel(url);
				out[k] = 'resolved';
			} catch (e) {
				out[k] = String(e?.message ?? e);
			}
		}
		out.templates = window.__stores.modelLoader.modelStats().templates.map((t) => t.url);
		return out;
	});
	h.check(/not a file this module packaged/.test(err.missing), '9.1 a packaged path the module does not have rejects with the reason: ' + err.missing);
	h.check(err.http !== 'resolved' && !err.templates.some((u) => /no-such-model/.test(u)), '9.2 a URL that is not a model rejects and leaves no template behind: ' + err.http);

	// ---- 11 a copy dropped without release() --------------------------------------------------------
	const park = await page.evaluate(async () => {
		const s = window.__stores;
		const ml = s.modelLoader;
		const hd = window.__h1;
		const meshOf = (root) => {
			let m = null;
			root.traverse((o) => (o.isMesh ? (m = o) : null));
			return m;
		};
		const wrapper = new s.THREE.Group();
		window.__ml.holder.add(wrapper);
		const copy = hd.instance();
		wrapper.add(copy);
		const uuid = meshOf(copy).uuid;
		const registered = () => s.lod.lodStats().meshes.some((m) => m.explicit && m.uuid === uuid);
		ml.sweepModels(); // the fresh copy's grace
		ml.sweepModels();
		const inScene = { registered: registered(), live: hd.instances, parked: hd.parked };
		window.__ml.holder.remove(wrapper); // dropped the way Waves drops an enemy: its wrapper goes
		ml.sweepModels();
		const dropped = { registered: registered(), parked: hd.parked };
		window.__ml.holder.add(wrapper);
		ml.sweepModels();
		const back = { registered: registered(), parked: hd.parked };
		window.__ml.holder.remove(wrapper);
		ml.sweepModels();
		// fifty more copies made, shown and dropped with no release() and no reference kept
		(() => {
			const w = new s.THREE.Group();
			window.__ml.holder.add(w);
			for (let i = 0; i < 50; i++) w.add(hd.instance());
			ml.sweepModels();
			ml.sweepModels();
			window.__ml.holder.remove(w);
		})();
		ml.sweepModels();
		const before = hd.parked;
		for (let i = 0; i < 6 && hd.parked > 1; i++) {
			await new Promise((r) => setTimeout(r, 200));
			window.gc?.();
			await new Promise((r) => setTimeout(r, 200));
			ml.sweepModels();
		}
		return { inScene, dropped, back, before, after: hd.parked, gc: typeof window.gc };
	});
	h.check(park.inScene.registered, '11.1 a copy in the scene has its LOD registered: ' + JSON.stringify(park.inScene));
	h.check(!park.dropped.registered && park.dropped.parked >= 1, '11.2 its wrapper removed (no release()), the next sweep PARKS it and drops its LOD entry: ' + JSON.stringify(park.dropped));
	h.check(park.back.registered, '11.3 put back, the next sweep picks it up again (LOD registered): ' + JSON.stringify(park.back));
	h.check(park.gc === 'function' && park.before >= 50 && park.after <= 1, '11.4 fifty copies dropped without release() are COLLECTED, not kept by the loader (' + park.before + ' parked -> ' + park.after + ' after GC)');

	// ---- 10 T2: the module's teardown disposes everything it loaded ---------------------------------
	const t2 = await page.evaluate(async () => {
		const s = window.__stores;
		const og = window.__ml.read(s.objectsGroup);
		const kept = window.__h1.instance();
		kept.name = 'mltest-kept';
		og.add(kept);
		const roots = [window.__h1.scene, window.__h2.scene, window.__h5.scene];
		const before = { templates: s.modelLoader.modelStats().templates.length, explicit: s.lod.lodStats().meshes.filter((m) => m.explicit && m.name === 'Body').length };
		s.moduleSDK.deactivateModule('mltest');
		let keptMesh = null;
		kept.traverse((o) => (o.isMesh ? (keptMesh = o) : null));
		const after = {
			parents: roots.map((r) => (r.parent ? r.parent.name : null)),
			kept: kept.parent === og && !!keptMesh?.geometry?.attributes?.position,
			explicit: s.lod.lodStats().meshes.filter((m) => m.explicit && m.name === 'Body').length,
			group: s.lodGroup.lodGroupForTest.entries().has(window.__h5.scene),
			templates: s.modelLoader.modelStats().templates.length,
			owners: s.modelLoader.modelStats().owners,
			instanceAfter: (() => {
				try {
					window.__h1.instance();
					return 'made';
				} catch (e) {
					return String(e?.message ?? e);
				}
			})()
		};
		kept.removeFromParent();
		return { before, after };
	});
	h.check(t2.before.templates >= 3 && t2.before.explicit >= 1, '10.0 (premise) before the unload: ' + JSON.stringify(t2.before));
	h.check(t2.after.parents.every((p) => p === null), '10.1 unloading the module took every copy it loaded out of the scene: ' + JSON.stringify(t2.after.parents));
	h.check(t2.after.explicit === 0 && t2.after.group === false, '10.2 ... and dropped their LOD registrations (auto levels ' + t2.after.explicit + ', group ' + t2.after.group + ')');
	h.check(t2.after.templates === 0 && JSON.stringify(t2.after.owners) === '{}', '10.3 ... and released every template (left ' + t2.after.templates + ', owners ' + JSON.stringify(t2.after.owners) + ')');
	h.check(t2.after.kept, '10.4 a copy the module put in objectsGroup STAYS (scene content) with its geometry');
	h.check(/after dispose/.test(t2.after.instanceAfter), '10.5 a disposed handle refuses instance(): ' + t2.after.instanceAfter);

	const inflight = await page.evaluate(async (b64) => {
		const s = window.__stores;
		const bin = atob(b64);
		const u8 = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
		s.moduleSDK.registerModuleAssets('mltest2', { 'assets/tiny.glb': URL.createObjectURL(new Blob([u8])) });
		await s.moduleSDK.initModules([{ id: 'mltest2', name: 'In flight', version: '1.0.0', description: '', register: (api) => (window.__mlapi2 = api) }]);
		const p = window.__mlapi2.loadModel('assets/tiny.glb').then(
			() => 'resolved',
			(e) => String(e?.message ?? e)
		);
		s.moduleSDK.deactivateModule('mltest2');
		const result = await p;
		return { result, stats: s.modelLoader.modelStats() };
	}, tinyB64);
	h.check(/unloaded while/.test(inflight.result), '10.6 a load still in flight when its module unloads is REFUSED: ' + inflight.result);
	h.check(inflight.stats.templates.length === 0 && JSON.stringify(inflight.stats.owners) === '{}', '10.7 ... and leaves nothing behind (' + JSON.stringify(inflight.stats.templates) + ', owners ' + JSON.stringify(inflight.stats.owners) + ')');
	// the same, with the unload landing while the file is really being fetched/parsed
	const midway = await page.evaluate(async (b64) => {
		const s = window.__stores;
		const bin = atob(b64);
		const u8 = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
		s.moduleSDK.registerModuleAssets('mltest3', { 'assets/tiny.glb': URL.createObjectURL(new Blob([u8])) });
		await s.moduleSDK.initModules([{ id: 'mltest3', name: 'Midway', version: '1.0.0', description: '', register: (api) => (window.__mlapi3 = api) }]);
		const p = window.__mlapi3.loadModel('assets/tiny.glb').then(
			() => 'resolved',
			(e) => String(e?.message ?? e)
		);
		let sawTemplate = false;
		for (let i = 0; i < 200 && !sawTemplate; i++) {
			await new Promise((r) => setTimeout(r, 0));
			sawTemplate = s.modelLoader.modelStats().templates.some((t) => !t.ready);
		}
		s.moduleSDK.deactivateModule('mltest3');
		const result = await p;
		return { sawTemplate, result, stats: s.modelLoader.modelStats() };
	}, tinyB64);
	h.check(midway.sawTemplate && /unloaded while/.test(midway.result), '10.8 an unload while the file is being fetched/parsed refuses the load too (template seen: ' + midway.sawTemplate + '): ' + midway.result);
	h.check(midway.stats.templates.length === 0 && JSON.stringify(midway.stats.owners) === '{}', '10.9 ... and nothing is left (' + JSON.stringify(midway.stats.templates) + ', owners ' + JSON.stringify(midway.stats.owners) + ')');

	await page.evaluate(() => window.__ml.holder.removeFromParent());
	h.check(h.pageErrors(A).length === 0, 'no page errors (' + JSON.stringify(h.pageErrors(A)) + ')');
	await h.finish(browser);
});

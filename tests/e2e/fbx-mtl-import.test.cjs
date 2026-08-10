// Roadmap #17 batch D2 — import gaps:
//  * FBX animations were parsed and then DROPPED (`result.animations` was never
//    read), so an animated FBX landed as a static mesh. Animated FBX now takes
//    the same raw-bytes `objectfile` route as animated GLB, and the message
//    carries a `kind` so the receiver picks the right parser. An ABSENT kind
//    still means gltf — that is what every older peer sends.
//  * OBJ imported without materials: nothing ever loaded the .mtl. Picking the
//    .obj together with its .mtl (and the textures the .mtl names) now applies
//    them, with the textures turned into data URLs so they replicate.
//
// No FBX exporter exists in three, so an animated-FBX FIXTURE cannot be authored
// in-test. Instead the FBX side is proven where it can fail: the wire `kind` is
// what selects the parser (a GLB fed in as kind:'fbx' must be REJECTED), and the
// send path stamps the kind an FBX import registered.
const h = require('./helpers.cjs');

const TINY_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const OBJ_WITH_MTL = 'mtllib tiny.mtl\nusemtl red\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const MTL = 'newmtl red\nKd 1 0 0\nmap_Kd tiny.png\n';

const objectCount = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g?.children.length ?? 0))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- an animated GLB still declares kind 'gltf' on the wire ----------
	const glb = await A.page.evaluate(
		() =>
			new Promise((resolve) => {
				const THREE = window.__stores.THREE;
				const { GLTFExporter } = window.__stores.GLTFExporterModule;
				const root = new THREE.Group();
				const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
				mesh.name = 'mover';
				root.add(mesh);
				const track = new THREE.VectorKeyframeTrack('mover.position', [0, 1, 2], [0, 0, 0, 2, 0, 0, 0, 0, 0]);
				const clip = new THREE.AnimationClip('slide', 2, [track]);
				new GLTFExporter().parse(
					root,
					(buffer) => resolve(Array.from(new Uint8Array(buffer))),
					() => resolve(null),
					{ binary: true, animations: [clip] }
				);
			})
	);
	h.check(Array.isArray(glb) && glb.length > 500, `built an animated glb (${glb?.length} bytes)`);

	// capture what the import broadcasts instead of standing up a second peer
	await A.page.evaluate(async () => {
		const peer = await new Promise((r) => window.__stores.peers.subscribe(r)());
		window.__files = [];
		const orig = peer.send.bind(peer);
		peer.send = (m) => {
			if (m && m.type === 'objectfile') window.__files.push({ uuid: m.uuid, kind: m.kind, bytes: m.buffer?.byteLength });
			return orig(m);
		};
	});
	await A.page.evaluate((bytes) => {
		const file = new File([new Uint8Array(bytes)], 'anim.glb');
		window.__stores.fileHandler.importFile(file, 'GlbAnim');
	}, glb);
	await A.page.waitForTimeout(1200);
	const sent = await A.page.evaluate(() => window.__files.slice());
	h.check(sent.length === 1, `the animated glb replicated as one objectfile (${sent.length})`);
	h.check(sent[0]?.kind === 'gltf', `it declares kind 'gltf' (${sent[0]?.kind})`);

	// ---------- the wire `kind` is what selects the parser ----------
	// same GLB bytes announced as FBX must FAIL: if kind were ignored (the pre-D2
	// behaviour, GLTFLoader always) this would succeed and the check goes red.
	const before = await objectCount(A.page);
	const asFbx = await A.page.evaluate(async (bytes) => {
		await window.__stores.animatedImports.applyObjectFile({
			uuid: 'kind-probe-fbx',
			name: 'WrongParser',
			kind: 'fbx',
			buffer: new Uint8Array(bytes).buffer
		});
		return new Promise((r) =>
			window.__stores.objectsGroup.subscribe((g) => r(!!g?.getObjectByProperty('uuid', 'kind-probe-fbx')))()
		);
	}, glb);
	h.check(asFbx === false, 'glb bytes announced as kind:fbx are rejected — the kind picks the parser');
	h.check((await objectCount(A.page)) === before, 'the rejected file added nothing to the scene');

	// ---------- an ABSENT kind still means gltf (older peers) ----------
	const noKind = await A.page.evaluate(async (bytes) => {
		await window.__stores.animatedImports.applyObjectFile({
			uuid: 'kind-probe-legacy',
			name: 'LegacyPeer',
			buffer: new Uint8Array(bytes).buffer
		});
		return new Promise((r) =>
			window.__stores.objectsGroup.subscribe((g) => r(!!g?.getObjectByProperty('uuid', 'kind-probe-legacy')))()
		);
	}, glb);
	h.check(noKind === true, 'a message with no kind still parses as gltf (back-compat)');

	// ---------- an FBX-registered import sends kind 'fbx' ----------
	const fbxSend = await A.page.evaluate(async () => {
		const w = window.__stores;
		const THREE = w.THREE;
		const root = new THREE.Group();
		root.name = 'FbxRig';
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		group.add(root);
		// the exact call the FBX import path makes
		w.animatedImports.registerAnimatedImport(root, [], new Uint8Array([1, 2, 3, 4]).buffer, 'fbx');
		const captured = [];
		w.animatedImports.sendAnimatedImport({ send: (m) => captured.push(m) }, root);
		return {
			kind: w.animatedImports.animatedImportKind(root.uuid),
			sentKind: captured[0]?.kind,
			bytes: captured[0]?.buffer?.byteLength
		};
	});
	h.check(fbxSend.kind === 'fbx', `an FBX import is remembered as fbx (${fbxSend.kind})`);
	h.check(fbxSend.sentKind === 'fbx', `and broadcasts kind 'fbx' with its bytes (${fbxSend.sentKind}, ${fbxSend.bytes}B)`);

	// ---------- OBJ + MTL: materials and textures actually arrive ----------
	const withMtl = await A.page.evaluate(
		async ([objText, mtlText, png]) => {
			const w = window.__stores;
			const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
			const files = [
				new File([objText], 'tiny.obj', { type: 'text/plain' }),
				new File([mtlText], 'tiny.mtl', { type: 'text/plain' }),
				new File([bytes], 'tiny.png', { type: 'image/png' })
			];
			w.fileHandler.importModelFiles(files);
			await new Promise((r) => setTimeout(r, 1800));
			const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const root = group.children.find((c) => c.name === 'tiny');
			let material = null;
			root?.traverse((o) => {
				if (o.material && !material) material = o.material;
			});
			return {
				imported: !!root,
				colour: material?.color?.getHexString() ?? null,
				mapSrc: material?.map?.image?.src?.slice(0, 11) ?? null,
				stamped: (material?.userData?.mapDataUrl ?? '').slice(0, 11) || null
			};
		},
		[OBJ_WITH_MTL, MTL, TINY_PNG]
	);
	h.check(withMtl.imported, 'the .obj imported when picked together with its .mtl');
	h.check(withMtl.colour === 'ff0000', `the .mtl diffuse colour was applied (${withMtl.colour})`);
	h.check(withMtl.mapSrc === 'data:image/', `the .mtl texture resolved to a data URL (${withMtl.mapSrc})`);
	h.check(
		withMtl.stamped === 'data:image/',
		`the map is stamped where the Inspector + peers read it (${withMtl.stamped})`
	);

	// ---------- the same .obj ALONE still imports, with a hint ----------
	const alone = await A.page.evaluate(async ([objText]) => {
		const w = window.__stores;
		w.fileHandler.importModelFiles([new File([objText], 'lonely.obj', { type: 'text/plain' })]);
		await new Promise((r) => setTimeout(r, 1200));
		const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
		const root = group.children.find((c) => c.name === 'lonely');
		let material = null;
		root?.traverse((o) => {
			if (o.material && !material) material = o.material;
		});
		const toasts = await new Promise((r) =>
			w.toastStore.subscribe((list) => r(list.map((t) => t.text ?? t.msg ?? String(t))))()
		);
		return { imported: !!root, hasMap: !!material?.map, toasts };
	}, [OBJ_WITH_MTL]);
	h.check(alone.imported, 'an .obj on its own still imports (unchanged behaviour)');
	h.check(!alone.hasMap, 'without the .mtl it gets no texture');
	h.check(
		alone.toasts.some((t) => /\.mtl/i.test(t)),
		`and the user is told why (${alone.toasts.filter((t) => /mtl/i.test(t)).join(' | ') || 'no hint'})`
	);

	// ---------- a .mtl naming a texture the user did NOT supply ----------
	// the unresolved map must be DROPPED, not left broken: a broken image makes
	// GLTFExporter abort ("No valid image data found"), which silently kills the
	// object's replication to peers
	const missing = await A.page.evaluate(
		async ([objText, mtlText]) => {
			const w = window.__stores;
			const errors = [];
			const origError = console.log;
			console.log = (...args) => {
				const line = args.map(String).join(' ');
				if (/GLTFExporter|No valid image data/i.test(line)) errors.push(line.slice(0, 120));
				return origError(...args);
			};
			w.fileHandler.importModelFiles([
				new File([objText.replace('tiny.obj', 'nomap.obj')], 'nomap.obj', { type: 'text/plain' }),
				new File([mtlText], 'nomap.mtl', { type: 'text/plain' }) // names tiny.png, never supplied
			]);
			await new Promise((r) => setTimeout(r, 1500));
			console.log = origError;
			const group = await new Promise((r) => w.objectsGroup.subscribe(r)());
			const root = group.children.find((c) => c.name === 'nomap');
			let material = null;
			root?.traverse((o) => {
				if (o.material && !material) material = o.material;
			});
			return {
				imported: !!root,
				colour: material?.color?.getHexString() ?? null,
				hasMap: !!material?.map,
				exportErrors: errors
			};
		},
		[OBJ_WITH_MTL, MTL]
	);
	h.check(missing.imported, 'an .obj whose .mtl names a missing texture still imports');
	h.check(missing.colour === 'ff0000', `it keeps the .mtl colour (${missing.colour})`);
	// these two only mean anything if the mesh actually arrived (a missing root
	// would make both trivially true)
	h.check(missing.imported && !missing.hasMap, 'the unresolved map is dropped rather than left broken');
	h.check(
		missing.imported && missing.exportErrors.length === 0,
		`so the GLTF sync of that object does not abort (${missing.exportErrors.length} export errors)`
	);

	await h.finish(browser);
});

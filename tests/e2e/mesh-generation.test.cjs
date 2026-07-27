// Mesh generation (roadmap #11, G7). Drives generateMesh against a MOCKED ComfyUI
// (page.route serves canned /prompt + /history + a real GLB from /view) and a mocked
// Meshy, asserting the generated mesh is parsed, placed in the scene, and stamped
// with AI provenance. The GLB fixture is exported in-page from a box so it is a valid
// binary glTF the real import path can parse.
const h = require('./helpers.cjs');

const COMFY = 'https://theprototype.app:5173/mock-comfy';
const MESHY = 'https://theprototype.app:5173/mock-meshy';
// a trivial API-format workflow — the mock ignores the graph, we only need valid
// JSON containing the {{PROMPT}} placeholder so meshGenReady() passes + substitution runs
const WORKFLOW = '{"3":{"inputs":{"text":"{{PROMPT}}","seed":"{{SEED}}"},"class_type":"Stub"}}';

const objCount = (peer) =>
	peer.page.evaluate(
		() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g ? g.children.length : 0))())
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// Seed both providers + enable (persisted to localStorage), then reload so the
	// meshJobs module and the __stores hook share ONE module instance (helpers.freshReload).
	await A.page.evaluate(
		({ comfy, meshy, workflow }) => {
			const mp = window.__stores.meshProviders;
			mp.addMeshProvider({ kind: 'comfyui', label: 'MockComfy', baseUrl: comfy, workflowJson: workflow });
			mp.addMeshProvider({ kind: 'meshy', label: 'MockMeshy', baseUrl: meshy, apiKey: 'k', mode: 'preview' });
			mp.setMeshGenEnabled(true);
		},
		{ comfy: COMFY, meshy: MESHY, workflow: WORKFLOW }
	);
	await h.freshReload(A);
	h.check(await A.page.evaluate(() => window.__stores.meshProviders.meshGenReady()), 'mesh provider ready after reload');

	// Export a valid GLB from a box, in-page, and hand the bytes to Node for the mocks.
	const glbArray = await A.page.evaluate(async () => {
		const THREE = window.__stores.THREE;
		const { GLTFExporter } = window.__stores.GLTFExporterModule;
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3388ff }));
		const glb = await new Promise((res, rej) => new GLTFExporter().parse(mesh, res, rej, { binary: true }));
		return Array.from(new Uint8Array(glb));
	});
	const glbBuf = Buffer.from(glbArray);
	h.check(glbBuf.length > 0 && glbBuf.slice(0, 4).toString() === 'glTF', 'exported a valid GLB fixture');

	// --- mock ComfyUI ---
	await A.page.route('**/mock-comfy/prompt', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prompt_id: 'p1', node_errors: {} }) })
	);
	await A.page.route('**/mock-comfy/history/**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				p1: { status: { status_str: 'success', completed: true }, outputs: { '9': { gltf: [{ filename: 'out.glb', subfolder: '', type: 'output' }] } } }
			})
		})
	);
	await A.page.route('**/mock-comfy/view**', (route) =>
		route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glbBuf })
	);

	// --- mock Meshy (preview -> succeeded -> model_urls.glb) ---
	let meshyPolls = 0;
	let meshyGlbUrl = MESHY + '/download.glb'; // switched to the blocked url later
	await A.page.route('**/mock-meshy/openapi/v2/text-to-3d', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: 'task-1' }) })
	);
	await A.page.route('**/mock-meshy/openapi/v2/text-to-3d/**', (route) => {
		meshyPolls++;
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ status: 'SUCCEEDED', progress: 100, model_urls: { glb: meshyGlbUrl } })
		});
	});
	await A.page.route('**/mock-meshy/download.glb', (route) =>
		route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glbBuf })
	);
	// CORS-blocked CDN + asset proxy (assets.meshy.ai sends no ACAO — the adapter must
	// fall back to `<assetProxy>?url=<encoded>`; see meshy.js fetchResult)
	let proxied = 0;
	await A.page.route('**/mock-meshy/blocked.glb', (route) => route.abort('failed'));
	await A.page.route('**/mock-proxy**', (route) => {
		const q = new URL(route.request().url()).searchParams.get('url') || '';
		proxied++;
		if (!q.includes('blocked.glb')) return route.fulfill({ status: 400, body: 'wrong url param' });
		route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glbBuf });
	});

	const base = await objCount(A);

	// ComfyUI generation -> import -> provenance
	await A.page.evaluate(() => {
		const list = window.__stores.meshProviders;
		let providers;
		list.meshProviders.subscribe((v) => (providers = v))();
		const comfy = providers.find((p) => p.kind === 'comfyui');
		list.setMeshActiveProvider(comfy.id);
		return window.__stores.meshJobs.generateMesh({ prompt: 'a wooden crate' });
	});

	await h.eventually(() => objCount(A), (n) => n === base + 1, 'ComfyUI mesh imported into the scene', 20000);

	const prov = await A.page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.objectsGroup.subscribe((g) => {
					const child = g.children[g.children.length - 1];
					r(child && child.userData && child.userData.aiGen ? child.userData.aiGen : null);
				})()
			)
	);
	h.check(!!prov && prov.prompt === 'a wooden crate' && prov.provider === 'comfyui', 'imported mesh carries aiGen provenance');

	// Meshy generation (switch active provider) -> import
	await A.page.evaluate(() => {
		const list = window.__stores.meshProviders;
		let providers;
		list.meshProviders.subscribe((v) => (providers = v))();
		const meshy = providers.find((p) => p.kind === 'meshy');
		list.setMeshActiveProvider(meshy.id);
		return window.__stores.meshJobs.generateMesh({ prompt: 'a clay pot' });
	});
	await h.eventually(() => objCount(A), (n) => n === base + 2, 'Meshy mesh imported into the scene', 20000);
	h.check(meshyPolls > 0, 'Meshy task was polled');

	// Meshy with a CORS-blocked CDN url -> the adapter retries through the asset proxy
	meshyGlbUrl = MESHY + '/blocked.glb';
	await A.page.evaluate(() => {
		const list = window.__stores.meshProviders;
		let providers;
		list.meshProviders.subscribe((v) => (providers = v))();
		const meshy = providers.find((p) => p.kind === 'meshy');
		list.updateMeshProvider(meshy.id, { assetProxy: 'https://theprototype.app:5173/mock-proxy' });
		return window.__stores.meshJobs.generateMesh({ prompt: 'a stone well' });
	});
	await h.eventually(() => objCount(A), (n) => n === base + 3, 'CORS-blocked GLB imported via the asset proxy', 20000);
	h.check(proxied > 0, 'download went through the proxy (' + proxied + ' request(s))');

	// EMPTY assetProxy field (the Settings form saves '' — the user-hit bug: '' must
	// fall through to the built-in default, `||` not `??`). The default resolves to
	// VITE_ASSET_PROXY or https://<VITE_PEER_HOST>/proxy — intercept both.
	let defaultProxied = 0;
	const serveDefault = (route) => {
		const q = new URL(route.request().url()).searchParams.get('url') || '';
		if (!q.includes('blocked.glb')) return route.fulfill({ status: 400, body: 'wrong url param' });
		defaultProxied++;
		route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glbBuf });
	};
	await A.page.route('**/peerjs.theprototype.app/proxy**', serveDefault);
	await A.page.evaluate(() => {
		const list = window.__stores.meshProviders;
		let providers;
		list.meshProviders.subscribe((v) => (providers = v))();
		const meshy = providers.find((p) => p.kind === 'meshy');
		list.updateMeshProvider(meshy.id, { assetProxy: '' });
		return window.__stores.meshJobs.generateMesh({ prompt: 'a rope bridge' });
	});
	await h.eventually(() => objCount(A), (n) => n === base + 4, 'empty provider field falls back to the default proxy', 20000);
	h.check(defaultProxied > 0, 'default proxy served the download (' + defaultProxied + ' request(s))');

	// undo removes the last generated mesh (standard history)
	await A.page.evaluate(() => window.__stores.history.undo());
	await h.eventually(() => objCount(A), (n) => n === base + 3, 'undo removed the last generated mesh', 8000);

	await h.finish(browser);
});

// Roadmap 73 AI1 — Image → 3D, through the real dialog, against a mocked Meshy and ComfyUI:
//   1. a GPS-tagged phone photo goes in through the dialog's file input; what reaches Meshy is a data URI
//      with NO metadata (counterfactual: the input carried GPS), ≤ 2048 px
//   2. the job takes the text path's import: placed, on BOTH peers, provenance `source: image`, and the
//      photo's file name appears nowhere in the object or its provenance
//   3. the other two sources: the viewport and an Explorer image (its menu entry + the dialog's picker)
//   4. ComfyUI: no {{IMAGE}} = no picture row; with it the bytes are uploaded and the name is in the graph
//   5. counterfactual: text only still goes to text-to-3d
//   6. the dialog on the N6, folded and unfolded: on screen, no sideways overflow, Camera offered
//   73-int (AI7): a picture for Meshy asks first — cost, the third-party line, the privacy link; Cancel sends
//      nothing and leaves no job row (counterfactual: Send sends). AI8: the limits are stated before a pick;
//      AI6: the first-use tip, retired by the first pick. AI4: no provider -> says so + opens Tools &
//      connections; Meshy 402 / 401 -> the message names Meshy and what to try.
// Run: APP_URL=https://localhost:5621/ npm run e2e -- image-to-3d
const path = require('node:path');
const h = require('./helpers.cjs');

const PHOTO = path.join(__dirname, '..', 'fixtures', 'exif', 'gps-photo-large.jpg');
process.env.E2E_SHOTS ||= 'test-results';
const MESHY = '/mock-meshy';
const COMFY = '/mock-comfy';
const OPEN = () => window.__stores.meshGenModalOpen.set({ position: [1, 0, 1] });

const objects = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.map((c) => ({ uuid: c.uuid, name: c.name, aiGen: c.userData?.aiGen ?? null }));
	});

async function waitCount(peer, n, label) {
	await h.eventually(async () => (await objects(peer)).length, (c) => c === n, label, 30000);
}

async function setProvider(page, kind) {
	await page.evaluate((k) => {
		const mp = window.__stores.meshProviders;
		let list;
		mp.meshProviders.subscribe((v) => (list = v))();
		mp.setMeshActiveProvider(list.find((p) => p.kind === k).id);
	}, kind);
}

/** the chosen picture's thumbnail; a fresh render + encode takes ~6 s on a loaded remote slot */
async function waitPicture(page) {
	try {
		await page.waitForSelector('#mesh-gen-image', { timeout: 60000 });
	} catch (e) {
		const state = await page.evaluate(() => ({
			modal: !!document.querySelector('#mesh-gen-window'),
			row: document.querySelector('#mesh-gen-picture')?.innerText,
			preparing: !!document.querySelector('#mesh-gen-preparing'),
			toasts: [...document.querySelectorAll('.tp-toast')].map((t) => t.innerText.slice(0, 160))
		}));
		console.log('no picture:', JSON.stringify(state));
		throw e;
	}
}

/** @param {any} page @param {boolean} [consent] a picture for Meshy: answer AI7's question with Send */
async function generate(page, consent = false) {
	// uir-timeline: the Generate window stays open after a submit (the job shows under the form)
	await page.click('#mesh-gen-submit');
	if (consent) {
		await page.waitForSelector('#confirm-mesh-picture-consent', { timeout: 8000 });
		await page.click('#confirm-dialog-send');
	}
}

const jobCount = (page) =>
	page.evaluate(() => {
		let v = [];
		window.__stores.meshJobs.meshJobs.subscribe((x) => (v = x))();
		return v.length;
	});

h.run(async () => {
	const { metadataOf, fromBase64 } = await import('../../src/lib/chat/attachCore.js');
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.evaluate((cfg) => {
		const mp = window.__stores.meshProviders;
		mp.addMeshProvider({ kind: 'meshy', label: 'MockMeshy', baseUrl: location.origin + cfg.MESHY, apiKey: 'k', mode: 'preview', assetProxy: '' });
		mp.setMeshGenEnabled(true);
	}, { MESHY });
	await h.freshReload(A);
	await h.answerRestore(A).catch(() => {});

	const glb = Buffer.from(
		await page.evaluate(async () => {
			const THREE = window.__stores.THREE;
			const { GLTFExporter } = window.__stores.GLTFExporterModule;
			const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3388ff }));
			const out = await new Promise((res, rej) => new GLTFExporter().parse(mesh, res, rej, { binary: true }));
			return Array.from(new Uint8Array(out));
		})
	);

	/** @type {any[]} */
	const imageTasks = [];
	/** @type {any[]} */
	const textTasks = [];
	const task = (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'SUCCEEDED', progress: 100, model_urls: { glb: new URL(route.request().url()).origin + MESHY + '/out.glb' } }) });
	await page.route('**/mock-meshy/openapi/v1/image-to-3d', (route) => {
		imageTasks.push(route.request().postDataJSON());
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: 'img-' + imageTasks.length }) });
	});
	await page.route('**/mock-meshy/openapi/v1/image-to-3d/**', task);
	await page.route('**/mock-meshy/openapi/v2/text-to-3d', (route) => {
		textTasks.push(route.request().postDataJSON());
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: 'txt-1' }) });
	});
	await page.route('**/mock-meshy/openapi/v2/text-to-3d/**', task);
	await page.route('**/mock-meshy/out.glb', (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glb }));

	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);
	const base = (await objects(A)).length;

	// ---- 1. the photo: the GPS never reaches the provider ------------------------------------------------
	await page.evaluate(() => window.__stores.tips?.resetTips?.());
	await page.evaluate(OPEN);
	await page.waitForSelector('#mesh-gen-picture');
	h.check(/2048 px/.test((await page.locator('#mesh-gen-limits').innerText().catch(() => '')) ?? ''), 'AI8: the picture limits are stated before a pick');
	h.check((await page.locator('#mesh-gen-tip').count()) === 1, 'AI6: the first-use tip shows on the picture row');
	h.check(await page.locator('#mesh-gen-submit').isDisabled(), 'no words and no picture: Generate is off');
	await page.setInputFiles('#mesh-gen-file-input', PHOTO);
	await waitPicture(page);
	h.check(!(await page.locator('#mesh-gen-submit').isDisabled()), 'a picture alone is enough to generate');
	const prep = await page.evaluate(() => {
		let v;
		window.__stores.chatAttach.lastPrepare.subscribe((x) => (v = x))();
		return v;
	});
	h.check(prep.inMeta.gps === true, 'counterfactual: the input photo carried GPS');
	h.check(prep.outMeta.gps === false && prep.outMeta.exif === false, 'the prepared picture has no EXIF or GPS');
	h.check(Math.max(prep.w, prep.h) <= 2048 && prep.outBytes <= 4 * 1024 * 1024, `the picture is ≤ 2048 px and ≤ 4 MB (${prep.w}×${prep.h}, ${prep.outBytes} B)`);
	h.check(!(await page.locator('#mesh-gen-tip').count()), 'AI6: the first-use tip retired with the first picture');

	// ---- 73 AI7: the question before anything leaves -----------------------------------------------------
	const jobsBefore = await jobCount(page);
	await generate(page);
	await page.waitForSelector('#confirm-mesh-picture-consent', { timeout: 8000 });
	const ask = await page.evaluate(() => ({
		text: document.querySelector('#confirm-mesh-picture-consent')?.closest('[role="dialog"]')?.textContent ?? document.querySelector('#confirm-mesh-picture-consent')?.textContent ?? '',
		href: document.querySelector('#confirm-dialog-link')?.getAttribute('href'),
		target: document.querySelector('#confirm-dialog-link')?.getAttribute('target'),
		send: document.querySelector('#confirm-dialog-send')?.textContent?.trim()
	}));
	h.check(/about 20 credits/.test(ask.text), 'AI7: the cost is stated (about 20 credits, Preview)');
	h.check(/third-party/.test(ask.text) && /Meshy/.test(ask.text), 'AI7: it says the picture goes to Meshy, a third party');
	h.check(ask.href === 'https://www.meshy.ai/privacy-policy' && ask.target === '_blank', "AI7: Meshy's privacy policy is linked");
	h.check(ask.send === 'Send to Meshy', 'AI7: the answer says what it does');
	await page.click('#confirm-dialog-cancel');
	await page.waitForTimeout(1500);
	h.check(imageTasks.length === 0 && textTasks.length === 0, 'AI7: Cancel sent nothing');
	h.check((await jobCount(page)) === jobsBefore, 'AI7: Cancel left no job row');
	await page.evaluate(OPEN);
	await page.waitForSelector('#mesh-gen-file-input', { state: 'attached' });
	await page.setInputFiles('#mesh-gen-file-input', PHOTO);
	await waitPicture(page);
	await generate(page, true);
	await h.eventually(() => imageTasks.length, (n) => n === 1, 'the photo went to image-to-3d', 8000);
	const sent = imageTasks[0];
	const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(sent.image_url);
	h.check(!!m, 'image_url is a base64 data URI');
	const meta = metadataOf(fromBase64(m[2]));
	h.check(!meta.gps && !meta.exif && !meta.xmp && !meta.text, 'the bytes Meshy receives carry no metadata');
	h.check(sent.should_texture === false && sent.should_remesh === true, 'Preview mode: untextured, remeshed');
	h.check(textTasks.length === 0, 'nothing went to text-to-3d');

	// ---- 2. the same import as text-to-3D, on both peers ------------------------------------------------
	await waitCount(A, base + 1, 'the model is placed on A');
	await waitCount(B, base + 1, 'the model reached peer B');
	const placed = (await objects(A)).at(-1);
	h.check(placed.aiGen?.source === 'image' && placed.aiGen?.provider === 'meshy', 'provenance says it came from a picture');
	h.check(placed.name === 'Model from a picture', `a generic name (${placed.name})`);
	h.check(!JSON.stringify(placed).includes('gps-photo'), 'the file name is in neither the object nor its provenance');

	// ---- 3. the viewport, and an Explorer image ----------------------------------------------------------
	await page.evaluate(OPEN);
	await page.waitForSelector('#mesh-gen-viewport');
	await page.click('#mesh-gen-viewport');
	await waitPicture(page);
	await page.fill('#mesh-gen-name', 'Viewport copy');
	await generate(page, true);
	await waitCount(A, base + 2, 'the viewport model is placed');
	h.check(imageTasks.length === 2 && /^data:image\//.test(imageTasks[1].image_url), 'the viewport went to image-to-3d');
	h.check((await objects(A)).at(-1).name === 'Viewport copy', 'the name field names the object');

	const itemId = await page.evaluate(async () => {
		const c = document.createElement('canvas');
		c.width = c.height = 64;
		c.getContext('2d').fillRect(0, 0, 32, 32);
		const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
		const explorer = window.__stores.explorer;
		const items = await explorer.importFiles([new File([blob], 'ref-73.png', { type: 'image/png' })], null);
		return (items?.[0] ?? null)?.id ?? null;
	});
	h.check(!!itemId, 'an Explorer image exists');
	await page.evaluate((id) => window.__stores.meshGenModalOpen.set({ imageItemId: id }), itemId);
	await waitPicture(page);
	h.check((await page.locator('#mesh-gen-picture').innerText()).includes('ref-73'), "the Explorer's entry opens with that picture chosen");
	await page.click('#mesh-gen-image-clear');
	await page.selectOption('#mesh-gen-explorer', itemId);
	await waitPicture(page);
	await generate(page, true);
	await waitCount(A, base + 3, 'the Explorer model is placed');
	h.check(imageTasks.length === 3, "the dialog's picker went to image-to-3d");

	// ---- 5. counterfactual: words alone ------------------------------------------------------------------
	await page.evaluate(OPEN);
	await page.fill('#mesh-gen-prompt', 'a clay pot');
	await generate(page);
	await waitCount(A, base + 4, 'the text model is placed');
	h.check(textTasks.length === 1 && imageTasks.length === 3, 'words alone stay on text-to-3d');
	h.check(!(await objects(A)).at(-1).aiGen?.source, 'and carry no picture provenance');

	// ---- 4. ComfyUI -------------------------------------------------------------------------------------
	let uploads = 0;
	/** @type {any} */
	let graph = null;
	await page.route('**/mock-comfy/upload/image', (route) => {
		uploads++;
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'uploaded-73.webp', subfolder: '' }) });
	});
	await page.route('**/mock-comfy/prompt', (route) => {
		graph = route.request().postDataJSON().prompt;
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prompt_id: 'p1', node_errors: {} }) });
	});
	await page.route('**/mock-comfy/history/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ p1: { status: { status_str: 'success', completed: true }, outputs: { 9: { gltf: [{ filename: 'o.glb', subfolder: '', type: 'output' }] } } } }) })
	);
	await page.route('**/mock-comfy/view**', (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glb }));
	await page.evaluate((cfg) => {
		window.__stores.meshProviders.addMeshProvider({ kind: 'comfyui', label: 'TextComfy', baseUrl: location.origin + cfg.COMFY, workflowJson: '{"1":{"inputs":{"text":"{{PROMPT}}"}}}' });
	}, { COMFY });
	await setProvider(page, 'comfyui');
	await page.evaluate(OPEN);
	await page.waitForSelector('#mesh-gen-window');
	h.check((await page.locator('#mesh-gen-picture').count()) === 0, 'a workflow without {{IMAGE}} offers no picture');
	await page.evaluate(() => window.__stores.meshGenModalOpen.set(null));
	await page.evaluate((cfg) => {
		const mp = window.__stores.meshProviders;
		let list;
		mp.meshProviders.subscribe((v) => (list = v))();
		mp.updateMeshProvider(list.find((p) => p.kind === 'comfyui').id, { workflowJson: '{"1":{"inputs":{"image":"{{IMAGE}}","text":"{{PROMPT}}"}}}' });
	}, { COMFY });
	await page.evaluate(OPEN);
	await page.waitForSelector('#mesh-gen-file-input', { state: 'attached' });
	await page.setInputFiles('#mesh-gen-file-input', PHOTO);
	await waitPicture(page);
	// the mock lives on the app's own origin: on a dev server that is this computer (no question), on a deployed
	// preview it is another host, which AI7 must ask about before the picture goes (generate() then answers Send)
	const comfyRemote = await page.evaluate(() => !/^(localhost|127\.|\[::1\]$)/.test(location.hostname));
	await generate(page, comfyRemote);
	await waitCount(A, base + 5, 'the ComfyUI model is placed');
	h.check(uploads === 1 && graph?.['1']?.inputs?.image === 'uploaded-73.webp', 'ComfyUI: uploaded, and the returned name is in the graph');
	if (comfyRemote) h.check(true, 'AI7: a ComfyUI on another host was asked about first, and Send went on (deployed origin)');
	else h.check(!(await page.locator('#confirm-mesh-picture-consent').count()), "AI7: ComfyUI (the person's own server) is not asked about");

	// ---- 73 AI4: errors that name the provider and what to try -----------------------------------------
	await setProvider(page, 'meshy');
	for (const [status, want] of [[402, /Meshy: out of credits — add credits/], [401, /Meshy rejected the API key — check it in Settings/]]) {
		await page.unroute('**/mock-meshy/openapi/v1/image-to-3d');
		await page.route('**/mock-meshy/openapi/v1/image-to-3d', (route) => route.fulfill({ status, contentType: 'application/json', body: '{"message":"no"}' }));
		await page.evaluate(OPEN);
		await page.waitForSelector('#mesh-gen-viewport');
		await page.click('#mesh-gen-viewport');
		await waitPicture(page);
		await generate(page, true);
		await h.eventually(
			() => page.evaluate(() => [...document.querySelectorAll('.tp-toast')].map((t) => t.textContent ?? '').join(' | ')),
			(t) => want.test(t),
			`AI4: a ${status} names Meshy and what to try`,
			15000
		);
	}
	// no provider at all: the dialog says so and opens Tools & connections
	await page.evaluate(() => {
		const mp = window.__stores.meshProviders;
		let list;
		mp.meshProviders.subscribe((v) => (list = v))();
		for (const p of list) mp.removeMeshProvider(p.id);
	});
	await page.evaluate(OPEN);
	await page.waitForSelector('#mesh-gen-no-provider');
	await page.click('#mesh-gen-setup');
	await h.eventually(() => page.evaluate(() => !!document.querySelector('#settings-sections')), (v) => v === true, 'AI4: Set one up opens Settings', 8000);
	h.check(!(await page.locator('#mesh-gen-window').count()), 'AI4: and the dialog made way');
	await B.page.close();
	await page.close();

	// ---- 6. the dialog on the N6 -------------------------------------------------------------------------
	const P = await h.setupPage(browser, 'n6', { context: { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true } });
	await h.answerRestore(P).catch(() => {});
	await P.page.evaluate(() => {
		const mp = window.__stores.meshProviders;
		mp.addMeshProvider({ kind: 'meshy', label: 'M', baseUrl: 'https://m.invalid', apiKey: 'k' });
		mp.setMeshGenEnabled(true);
		window.__stores.meshGenModalOpen.set({});
	});
	await P.page.waitForSelector('#mesh-gen-picture');
	for (const [label, viewport] of [['folded', { width: 390, height: 896 }], ['unfolded', { width: 1080, height: 1200 }], ['folded landscape', { width: 896, height: 390 }]]) {
		await P.page.setViewportSize(viewport);
		await P.page.waitForTimeout(400);
		const r = await P.page.evaluate(() => {
			const b = document.querySelector('#mesh-gen-window').getBoundingClientRect();
			return { l: b.left, t: b.top, r: b.right, b: b.bottom, docW: document.documentElement.scrollWidth, vw: innerWidth, vh: innerHeight, cam: !!document.querySelector('#mesh-gen-camera') };
		});
		h.check(r.l >= 0 && r.t >= 0 && r.r <= r.vw && r.b <= r.vh && r.docW <= r.vw, `N6 ${label}: the dialog fits (${JSON.stringify(r)})`);
		h.check(r.cam, `N6 ${label}: Camera is offered`);
		await P.page.screenshot({ path: path.join(process.env.E2E_SHOTS, `image-to-3d-${label.replace(' ', '-')}.png`) });
	}
	await h.finish(browser);
});

// Roadmap 73 AI2 — pictures in the built-in provider chat, against a mocked OpenAI-compatible endpoint:
//   1. a GPS-tagged photo in the composer reaches the provider as an image_url part: JPEG, no metadata
//      (counterfactual: the input carried GPS), no bookkeeping keys; the bubble shows it, the tray empties
//   2. a text-only message after it stays multimodal only for the last two picture turns: the third-oldest
//      turn is sent as text saying a picture was there
//   3. a picture with no words still sends
//   4. a text-only model's refusal says so plainly, and the NEXT prompt goes without pictures (a poisoned
//      transcript would refuse every later prompt)
//   5. counterfactual: a chat that never had a picture sends plain string content
//   6. generate_mesh from_picture: the attached picture reaches Meshy's image-to-3d; the model lands on both peers
//   7. the provider chat stays local: peer B has no bubble, and a viewer has no + button
//   8. N6 folded: the bubble's picture stays inside the window
// Run: APP_URL=https://localhost:5621/ npm run e2e -- ai-vision
const path = require('node:path');
const h = require('./helpers.cjs');

const PHOTO = path.join(__dirname, '..', 'fixtures', 'exif', 'gps-photo-large.jpg');
const ev = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const SAY = (text) => ev({ choices: [{ delta: { content: text } }] }) + ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
const CALL = (name, args) =>
	ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) +
	ev({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) +
	'data: [DONE]\n\n';

const messages = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.aiAssistant.aiMessages.subscribe((x) => (v = x))();
		return v;
	});
const objectCount = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.objectsGroup.subscribe((v) => (g = v))();
		return g.children.length;
	});

/** the newest user turn of a captured request */
const lastUser = (body) => body.messages.filter((m) => m.role === 'user').at(-1);
const parts = (m, type) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === type) : []);

h.run(async () => {
	const { metadataOf, fromBase64, sniffType } = await import('../../src/lib/chat/attachCore.js');
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.evaluate(() => {
		const p = window.__stores.aiProviders;
		const id = p.addAiProvider({ preset: 'custom', label: 'MockVision', baseUrl: location.origin + '/mock-ai/v1', model: 'vision-1', apiKey: 'k' });
		p.setAiActiveProvider(id);
		p.setAiEnabled(true);
		const mp = window.__stores.meshProviders;
		mp.addMeshProvider({ kind: 'meshy', label: 'MockMeshy', baseUrl: location.origin + '/mock-meshy', apiKey: 'k', mode: 'preview' });
		mp.setMeshGenEnabled(true);
	});
	await h.freshReload(A);
	await h.answerRestore(A).catch(() => {});

	/** @type {any[]} */
	const requests = [];
	/** what the endpoint does next: a function of the parsed body @type {(body: any) => {status?: number, sse?: string, json?: any}} */
	let answer = () => ({ sse: SAY('Seen.') });
	await page.route('**/mock-ai/v1/chat/completions', (route) => {
		const body = route.request().postDataJSON();
		requests.push(body);
		const a = answer(body);
		if (a.status) return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.json ?? {}) });
		route.fulfill({ status: 200, contentType: 'text/event-stream', body: a.sse });
	});

	await page.evaluate(() => window.__stores.aiAssistantHidden.set(''));
	await page.waitForSelector('#ai-send');
	const send = async (text, label) => {
		const before = requests.length;
		await page.fill('#ai-assistant-window input[type="text"]', text);
		await page.click('#ai-send');
		await h.eventually(() => requests.length, (n) => n > before, label, 15000);
		await h.eventually(() => page.evaluate(() => {
			let v;
			window.__stores.aiAssistant.aiBusy.subscribe((x) => (v = x))();
			return v;
		}), (busy) => busy === false, label + ': the run ended', 15000);
		return requests.at(-1);
	};
	const attach = async () => {
		await page.setInputFiles('#chat-attach-file', PHOTO);
		await page.waitForFunction(() => {
			let v;
			window.__stores.chatAttach.composerPending.subscribe((x) => (v = x))();
			return v.length > 0;
		}, null, { timeout: 30000 });
	};

	// ---- 5. counterfactual first: no picture, no parts --------------------------------------------------
	const plain = await send('hello', 'a plain prompt went out');
	h.check(typeof lastUser(plain).content === 'string', 'no picture: content stays a plain string');

	// ---- 1. the photo reaches the provider clean ---------------------------------------------------------
	await attach();
	const withPic = await send('what is this', 'the picture prompt went out');
	const user = lastUser(withPic);
	const [img] = parts(user, 'image_url');
	h.check(parts(user, 'text')[0]?.text.includes('Request: what is this'), 'the words travel as the text part');
	const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(img?.image_url?.url ?? '');
	h.check(m?.[1] === 'image/jpeg', `the part is a JPEG data URI (${m?.[1]})`);
	const bytes = fromBase64(m[2]);
	h.check(sniffType(bytes) === 'image/jpeg', 'the bytes really are JPEG');
	const meta = metadataOf(bytes);
	h.check(!meta.gps && !meta.exif && !meta.xmp && !meta.text, 'the bytes carry no metadata');
	const prep = await page.evaluate(() => {
		let v;
		window.__stores.chatAttach.lastPrepare.subscribe((x) => (v = x))();
		return v;
	});
	h.check(Math.max(prep.w, prep.h) <= 1568 && prep.outBytes <= 1024 * 1024, `chat size: ≤ 1568 px, ≤ 1 MB (${prep.w}×${prep.h}, ${prep.outBytes} B)`);
	h.check(!JSON.stringify(img).includes('tpName') && !JSON.stringify(withPic).includes('gps-photo'), 'our bookkeeping and the file name stay home');
	const shown = await page.evaluate(() => document.querySelectorAll('#ai-assistant-window .ai-pic').length);
	h.check(shown === 1, 'the bubble shows the picture');
	h.check(await page.evaluate(() => {
		let v;
		window.__stores.chatAttach.composerPending.subscribe((x) => (v = x))();
		return v.length === 0;
	}), 'the tray emptied on send');

	// ---- 2. the picture window ---------------------------------------------------------------------------
	const next = await send('and now?', 'a follow-up went out');
	h.check(next.messages.filter((x) => Array.isArray(x.content)).length === 1, 'a follow-up still carries the picture turn');
	await attach();
	await send('second', 'the second picture went out');
	await attach();
	const third = await send('third', 'the third picture went out');
	const users = third.messages.filter((x) => x.role === 'user');
	h.check(users.filter((x) => Array.isArray(x.content)).length === 2, 'only the newest two picture turns keep their pictures');
	const aged = users.find((x) => typeof x.content === 'string' && x.content.includes('Request: what is this'));
	h.check(!!aged && /no longer shown/.test(aged.content), 'the oldest says a picture was there');

	// ---- 3. a picture with no words ----------------------------------------------------------------------
	await attach();
	await page.click('#ai-send');
	await h.eventually(() => requests.length, (n) => n > 0 && parts(lastUser(requests.at(-1)), 'image_url').length === 1 && parts(lastUser(requests.at(-1)), 'text')[0].text.includes('See the attached picture'), 'a picture alone sends', 15000);

	// ---- 4. a text-only model ----------------------------------------------------------------------------
	await page.waitForTimeout(500);
	answer = () => ({ status: 400, json: { error: { message: 'This model does not support images' } } });
	await attach();
	await send('look', 'the refused prompt went out');
	await h.eventually(async () => (await messages(A)).at(-1)?.content ?? '', (t) => /can’t read pictures/.test(t), 'the refusal says what is wrong', 8000);
	answer = () => ({ sse: SAY('Fine.') });
	const after = await send('continue without', 'the next prompt went out');
	h.check(!after.messages.some((x) => Array.isArray(x.content)), 'the next prompt carries no pictures');
	h.check(!JSON.stringify(after).includes('image_url'), 'no image part anywhere in the transcript');

	// ---- 6. from_picture ---------------------------------------------------------------------------------
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
	const tasks = [];
	await page.route('**/mock-meshy/openapi/v1/image-to-3d', (route) => {
		tasks.push(route.request().postDataJSON());
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: 'i1' }) });
	});
	await page.route('**/mock-meshy/openapi/v1/image-to-3d/**', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'SUCCEEDED', progress: 100, model_urls: { glb: new URL(route.request().url()).origin + '/mock-meshy/out.glb' } }) })
	);
	await page.route('**/mock-meshy/out.glb', (route) => route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: glb }));
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);
	const base = await objectCount(A);
	answer = (body) => (body.messages.at(-1).role === 'tool' ? { sse: SAY('Building it.') } : { sse: CALL('generate_mesh', { prompt: 'a chair', from_picture: 1 }) });
	await attach();
	const toolTurn = await send('make this a 3D model', 'the tool prompt went out');
	h.check(toolTurn.tools.find((t) => t.function.name === 'generate_mesh')?.function.parameters.properties.from_picture, 'generate_mesh offers from_picture');
	await h.eventually(() => tasks.length, (n) => n === 1, 'the attached picture reached image-to-3d', 15000);
	h.check(tasks[0].image_url.startsWith('data:image/jpeg;base64,'), 'as the same clean JPEG');
	await h.eventually(() => objectCount(A), (n) => n === base + 1, 'the model is placed on A', 30000);
	await h.eventually(() => objectCount(B), (n) => n === base + 1, 'the model reached peer B', 30000);

	answer = (body) => (body.messages.at(-1).role === 'tool' ? { sse: SAY('No picture.') } : { sse: CALL('generate_mesh', { prompt: 'x', from_picture: 1 }) });
	await send('make that again', 'a call with no picture went out');
	await h.eventually(async () => (await messages(A)).some((x) => x.role === 'error' && /no such picture/.test(x.content)), (v) => v === true, 'from_picture with nothing attached is refused', 8000);
	h.check(tasks.length === 1, 'and nothing more went to Meshy');

	// ---- 7. local, and viewers ---------------------------------------------------------------------------
	h.check((await messages(B)).length === 0, 'the provider chat is not replicated');
	await B.page.evaluate(() => {
		window.__stores.cloudHooks.rolesInfo.set({ myId: 'b', myRole: 'viewer', amAdmin: false, order: [], roleOf: () => 'viewer', setRole() {} });
		window.__stores.aiAssistantHidden.set('');
	});
	await B.page.waitForSelector('#ai-assistant-window');
	h.check((await B.page.locator('#chat-attach').count()) === 0, 'a viewer has no + button');
	await B.page.close();
	await page.close();

	// ---- 8. N6 folded ------------------------------------------------------------------------------------
	const P = await h.setupPage(browser, 'n6', { context: { viewport: { width: 390, height: 896 }, deviceScaleFactor: 2.9, hasTouch: true, isMobile: true } });
	await h.answerRestore(P).catch(() => {});
	await P.page.evaluate(() => {
		window.__stores.aiAssistantHidden.set('');
		const c = document.createElement('canvas');
		c.width = 800;
		c.height = 300;
		window.__stores.aiAssistant.aiMessages.set([{ role: 'user', content: 'wide', images: [{ url: c.toDataURL(), name: 'wide' }] }]);
	});
	await P.page.waitForSelector('#ai-assistant-window .ai-pic');
	const fit = await P.page.evaluate(() => {
		const pic = document.querySelector('#ai-assistant-window .ai-pic').getBoundingClientRect();
		const win = document.querySelector('#ai-assistant-window').getBoundingClientRect();
		return { inside: pic.left >= win.left && pic.right <= win.right, docW: document.documentElement.scrollWidth, vw: innerWidth };
	});
	h.check(fit.inside && fit.docW <= fit.vw, `N6 folded: the picture stays inside the window (${JSON.stringify(fit)})`);
	await P.page.close();

	await h.finish(browser);
});

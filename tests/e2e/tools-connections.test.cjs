// 59 T4/T5 — SETTINGS ▸ TOOLS & CONNECTIONS, end to end on one page (mock servers by page.route):
//   1. MIGRATION: providers saved by the old Settings ▸ AI page (seeded into localStorage BEFORE boot,
//      under their old keys) show as rows here with their state; nothing was rewritten
//   2. the page: sections in order (Chat providers, Mesh providers, Desktop tools), each row with a
//      status dot, Test, Enable / Disable and the features it turns on
//   3. Test buttons: chat (GET /models ✓, a 401 ✗), mesh (Meshy task list ✓, ComfyUI without a workflow
//      ✗), voice typing (✓), desktop (✓) — a failed Test on a ready row turns its dot red
//   4. Enable / Disable act on the same switches (aiEnabled), and the feature status follows
//   5. T5: with no Mesh provider ready, the viewport Add menu still lists "Generate 3D model… (set up)";
//      pressing it says what is missing and opens Settings at the Mesh providers section; with the
//      assistant disabled the AI button does the same for the Chat provider row
//   6. the assistant's system prompt lists what is not set up (the same status)
//   7. axe: no serious / critical violation on the page (53 A4's gate, scoped to Settings)
// Run: APP_URL=https://theprototype.app:5442/ npm run e2e -- tools-connections
const h = require('./helpers.cjs');
const { AxeBuilder } = require('@axe-core/playwright');

const GET = `(s) => { let v; s.subscribe((x) => (v = x))(); return v; }`;

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', {
		context: { viewport: { width: 1280, height: 860 } }
	});
	const page = A.page;
	const origin = new URL(h.URL).origin;

	// ---- mock servers -----------------------------------------------------------------------
	await page.route('**/mock-ai/v1/models', (r) =>
		r.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ data: [{ id: 'mock' }] })
		})
	);
	await page.route('**/mock-bad/v1/models', (r) =>
		r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"bad key"}' })
	);
	await page.route('**/mock-bad/v1/chat/completions', (r) =>
		r.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"bad key"}' })
	);
	/** @type {string[]} */
	const meshAuth = [];
	await page.route('**/mock-meshy/openapi/v2/text-to-3d**', (r) => {
		meshAuth.push(r.request().headers()['authorization'] ?? '');
		return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
	});
	await page.route('**/mock-comfy/system_stats', (r) =>
		r.fulfill({ status: 200, contentType: 'application/json', body: '{"system":{}}' })
	);
	await page.route('**/mock-stt/v1/audio/transcriptions', (r) =>
		r.fulfill({ status: 200, contentType: 'application/json', body: '{"text":""}' })
	);

	// ---- 1. migration: the old keys, seeded before boot -----------------------------------------
	await page.evaluate((o) => {
		localStorage.setItem(
			'aiProviders',
			JSON.stringify([
				{
					id: 'p-good',
					preset: 'custom',
					label: 'Mock good',
					baseUrl: o + '/mock-ai/v1',
					apiKey: 'k',
					model: 'mock'
				}
			])
		);
		localStorage.setItem('aiActiveProvider', 'p-good');
		localStorage.setItem('aiEnabled', 'true');
		localStorage.setItem(
			'meshProviders',
			JSON.stringify([
				{
					id: 'm-meshy',
					kind: 'meshy',
					label: 'Meshy mock',
					baseUrl: o + '/mock-meshy',
					apiKey: 'mk'
				}
			])
		);
		localStorage.setItem('meshActiveProvider', 'm-meshy');
		localStorage.setItem('meshGenEnabled', 'false');
		localStorage.setItem(
			'aiStt',
			JSON.stringify({
				preset: 'custom',
				baseUrl: o + '/mock-stt/v1',
				apiKey: '',
				model: 'whisper-1'
			})
		);
	}, origin);
	await h.freshReload(A);
	await h.answerRestore(A);
	const before = await page.evaluate(() => localStorage.getItem('aiProviders'));

	await page.evaluate(() => {
		window.__stores.settingsSection.set('tools');
		window.__stores.settingsOpen.set(true);
	});
	await page.waitForSelector('#settings-main [data-tool-section="chat"]', {
		state: 'visible',
		timeout: 15000
	});
	const title = await page.evaluate(() =>
		[...document.querySelectorAll('#settings-sections .ss-page')]
			.filter((p) => /** @type {HTMLElement} */ (p).offsetParent !== null)
			.map((p) => (p.querySelector('.ss-title')?.textContent || '').replace(/›\s*$/, '').trim())
			.join('|')
	);
	h.check(
		/Tools & connections/.test(title),
		`the deep link opens Settings ▸ Tools & connections (${title})`
	);
	const rows = await page.evaluate(() =>
		[...document.querySelectorAll('#settings-main [data-tool-row]')].map((r) => ({
			id: r.getAttribute('data-tool-row'),
			state: r.getAttribute('data-tool-state'),
			text: r.textContent?.replace(/\s+/g, ' ').trim()
		}))
	);
	const row = (/** @type {string} */ id) => rows.find((r) => r.id === id);
	h.check(
		row('chat:p-good')?.state === 'ready' && /Mock good/.test(row('chat:p-good')?.text ?? ''),
		`the saved chat provider is a ready row (${JSON.stringify(row('chat:p-good'))})`
	);
	h.check(
		row('mesh:m-meshy')?.state === 'off',
		`the saved Meshy provider is a row, off (mesh generation was off) (${row('mesh:m-meshy')?.state})`
	);
	h.check(
		row('chat:voice')?.state === 'ready',
		`voice typing reads ready (${row('chat:voice')?.state})`
	);
	h.check(
		row('desktop:blender')?.state === 'ready',
		`Desktop tools ▸ Blender reads ready (${row('desktop:blender')?.state})`
	);
	h.check(
		(await page.evaluate(() => localStorage.getItem('aiProviders'))) === before,
		'the stored providers were not rewritten by the move'
	);

	// ---- 2. the page --------------------------------------------------------------------------
	// SHOTS=<dir>: evidence screenshots of the page (the default theme here, dark at the end)
	const shot = async (/** @type {string} */ name) => {
		if (!process.env.SHOTS) return;
		require('node:fs').mkdirSync(process.env.SHOTS, { recursive: true });
		await page
			.locator('dialog.settings-dialog')
			.screenshot({ path: require('node:path').join(process.env.SHOTS, name + '.png') })
			.catch(() => {});
	};
	await shot('tools-connections-default');
	const sections = await page.evaluate(() =>
		[...document.querySelectorAll('#settings-main [data-tool-section]')].map((e) =>
			e.getAttribute('data-tool-section')
		)
	);
	h.check(sections.join(',') === 'chat,mesh,desktop', `sections in order: ${sections.join(', ')}`);
	const anatomy = await page.evaluate(() => {
		const r = document.querySelector('#settings-main [data-tool-row="chat:p-good"]');
		return {
			dot: !!r?.querySelector('[data-tool-status] .badge-dot'),
			test: !!r?.querySelector('#tool-chat-p-good-test'),
			toggle: r?.querySelector('#tool-chat-p-good-enable')?.getAttribute('aria-pressed'),
			features: r?.querySelector('.tools-features')?.textContent?.trim()
		};
	});
	h.check(
		anatomy.dot &&
			anatomy.test &&
			anatomy.toggle === 'true' &&
			/AI assistant/.test(anatomy.features ?? ''),
		`a row has a status dot, Test, Enable / Disable and its features (${JSON.stringify(anatomy)})`
	);

	// ---- 3. Test buttons ------------------------------------------------------------------------
	/** @param {string} dom @returns {Promise<string>} */
	const runTest = async (dom) => {
		await page.click(`#tool-${dom}-test`);
		await page.waitForSelector(`#tool-${dom}-result`, { timeout: 15000 });
		return (await page.locator(`#tool-${dom}-result`).textContent())?.trim() ?? '';
	};
	let t = await runTest('chat-p-good');
	h.check(t.startsWith('✓') && /Connected/.test(t), `chat Test reaches /models (${t})`);
	t = await runTest('mesh-m-meshy');
	h.check(
		t.startsWith('✓') && meshAuth[0] === 'Bearer mk',
		`mesh Test lists Meshy tasks with the key, no generation (${t}; ${meshAuth[0]})`
	);
	t = await runTest('chat-voice');
	h.check(t.startsWith('✓'), `voice typing Test (${t})`);
	t = await runTest('desktop-blender');
	h.check(t.startsWith('✓') && /Ready/.test(t), `desktop tools Test (${t})`);
	// a broken key on the ACTIVE provider: ✗ and the dot turns red; a ComfyUI with no workflow: ✗
	await page.evaluate((o) => {
		const st = window.__stores;
		st.aiProviders.updateAiProvider('p-good', { baseUrl: o + '/mock-bad/v1' });
		st.meshProviders.addMeshProvider({
			kind: 'comfyui',
			label: 'Comfy mock',
			baseUrl: o + '/mock-comfy'
		});
	}, origin);
	await page.waitForTimeout(200);
	t = await runTest('chat-p-good');
	const red = await page.locator('[data-tool-row="chat:p-good"]').getAttribute('data-tool-state');
	h.check(
		t.startsWith('✗') && red === 'error',
		`a refused key: ✗ and the dot turns red (${t}; ${red})`
	);
	const comfyDom = await page.evaluate(() => {
		const r = [...document.querySelectorAll('[data-tool-row^="mesh:"]')].find((e) =>
			/Comfy mock/.test(e.textContent ?? '')
		);
		return r?.id?.replace(/^tool-/, '') ?? '';
	});
	t = await runTest(comfyDom);
	h.check(t.startsWith('✗') && /workflow/.test(t), `ComfyUI without a workflow: ✗ says so (${t})`);
	await page.evaluate(
		(o) => window.__stores.aiProviders.updateAiProvider('p-good', { baseUrl: o + '/mock-ai/v1' }),
		origin
	);

	// ---- 4. Enable / Disable --------------------------------------------------------------------
	await page.click('#tool-chat-p-good-enable');
	await page.waitForTimeout(150);
	let st = await page.evaluate(
		`(() => ({ on: (${GET})(window.__stores.aiProviders.aiEnabled), ready: window.__stores.toolStatus.featureStatus('assistant').ready, row: document.querySelector('[data-tool-row="chat:p-good"]')?.getAttribute('data-tool-state') }))()`
	);
	h.check(
		st.on === false && st.ready === false && st.row === 'off',
		`Disable switches the assistant off (${JSON.stringify(st)})`
	);

	// ---- 5. T5: a missing tool explains itself and opens its row --------------------------------
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(300);
	await page.evaluate(() =>
		window.__stores.viewportMenu.set({ x: 260, y: 160, point: [0, 0, 0], only: 'add' })
	);
	const gen = page
		.locator('[role="menu"] [role="menuitem"]', { hasText: 'Generate 3D model' })
		.first();
	await gen.waitFor({ state: 'visible', timeout: 8000 });
	h.check(
		/set up/.test((await gen.textContent()) ?? ''),
		`Generate 3D model stays in the Add menu and says it needs setting up (${(await gen.textContent())?.trim()})`
	);
	await gen.click();
	await page.waitForSelector('#settings-main [data-tool-section="mesh"]', {
		state: 'visible',
		timeout: 10000
	});
	const toast1 = await page.evaluate(() =>
		[...document.querySelectorAll('.tp-toast, [role="status"]')]
			.map((e) => e.textContent ?? '')
			.join(' | ')
	);
	h.check(
		/Generate 3D model needs a Mesh provider/.test(toast1),
		`…pressing it says what is missing (${toast1.slice(0, 160)})`
	);
	const meshInView = await page.evaluate(() => {
		const el = document.querySelector('#settings-main [data-tool-row="mesh:m-meshy"]');
		const main = document.querySelector('#settings-main');
		if (!el || !main) return false;
		const a = el.getBoundingClientRect();
		const b = main.getBoundingClientRect();
		return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
	});
	h.check(meshInView, '…and opens Tools & connections at the Mesh provider row');
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(300);
	await page.locator('#ai-hud-button').first().click();
	await page.waitForSelector('#settings-main [data-tool-section="chat"]', {
		state: 'visible',
		timeout: 10000
	});
	const toast2 = await page.evaluate(() =>
		[...document.querySelectorAll('.tp-toast, [role="status"]')]
			.map((e) => e.textContent ?? '')
			.join(' | ')
	);
	h.check(
		/The AI assistant needs a Chat provider/.test(toast2),
		`the AI button with the assistant off explains and opens the Chat row (${toast2.slice(0, 160)})`
	);

	// ---- 6. the assistant reads the same status -------------------------------------------------
	const prompt = await page.evaluate(() => window.__stores.aiTools.buildSystemPrompt());
	h.check(
		/Not set up on this device: [^\n]*Generate 3D model \(needs a Mesh provider\)/.test(prompt),
		'the system prompt lists Generate 3D model as not set up'
	);
	await page.evaluate(() => {
		window.__stores.meshProviders.setMeshActiveProvider('m-meshy');
		window.__stores.meshProviders.setMeshGenEnabled(true);
	});
	const prompt2 = await page.evaluate(() => window.__stores.aiTools.buildSystemPrompt());
	h.check(
		!/Generate 3D model \(needs/.test(prompt2) && /generate_mesh/.test(prompt2),
		'with Meshy enabled the line is gone and generate_mesh is offered'
	);

	// ---- 7. axe: serious / critical only ---------------------------------------------------------
	await page.evaluate(() => window.__stores.settingsSection.set('tools'));
	await page.waitForTimeout(400);
	const res = await new AxeBuilder({ page })
		.include('dialog.settings-dialog')
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
		.analyze();
	const gated = res.violations.filter(
		(/** @type {any} */ v) => v.impact === 'serious' || v.impact === 'critical'
	);
	for (const v of res.violations)
		console.log(
			`  [axe] ${v.impact} ${v.id} (${v.nodes.length}) — ${v.help}${
				gated.includes(v)
					? ' :: ' +
						v.nodes
							.slice(0, 4)
							.map((/** @type {any} */ n) => n.target.join(' '))
							.join(', ')
					: ''
			}`
		);
	h.check(
		gated.length === 0,
		`axe: no serious/critical violation on Tools & connections (${gated.map((/** @type {any} */ v) => v.id).join(', ') || 'none'})`
	);
	await page.evaluate(() => {
		document.documentElement.dataset.theme = 'dark';
		document.documentElement.classList.add('dark');
	});
	await page.waitForTimeout(200);
	await shot('tools-connections-dark');
	h.check(
		h.pageErrors(A).length === 0,
		`no page errors (${h.pageErrors(A).join(' | ').slice(0, 200)})`
	);
	await h.finish(browser);
});

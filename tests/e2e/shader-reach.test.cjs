// 73-int — WHERE YOUR OWN GLSL RUNS (AI9), the code view's accessibility (AI10) and its inline errors (AI4):
//   1. AI4: a broken pair shows its error by the text, with the stage and the line; pressing it shows that stage
//   2. AI9: someone else's GLSL that this device cannot test (the worker is unavailable) stays OFF with a notice
//      and "Run it anyway"; counterfactual: the same verdict on YOUR code runs (first-frame box); someone
//      else's code with a PASSED test runs; Run it anyway runs it
//   3. AI10: the </> view at desktop and the N6 folded: axe (serious/critical) clean on all three tabs, named
//      editors, and keyboard-only: tab buttons and Apply answer Enter, Tab reaches the editor
//   4. AI9 Quest (IWER Quest 3 + the Quest browser's user agent): custom GLSL is OFF by default, not even
//      the worker test runs, the pane offers "Turn on custom shaders", Settings ▸ VR has the switch, and it
//      stays off inside the XR session; turning it on runs it (counterfactual)
// Run: APP_URL=https://localhost:5620/ npm run e2e -- shader-reach
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const { AxeBuilder } = require('@axe-core/playwright');

const QUEST_UA = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/38.0 Chrome/130.0.0.0 VR Safari/537.36';
const VERT = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const FRAG = (r) => `varying vec2 vUv;
void main() { gl_FragColor = vec4(${r}, vUv.x, 0.0, 1.0); }
`;
const code = (r, extra = {}) => ({ use: true, vertex: VERT, fragment: FRAG(r), uniforms: {}, ...extra });

const firstMesh = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => {
		let m = null;
		g.traverse((n) => { if (n.isMesh && !m) m = n; });
		r(m?.uuid ?? null);
	})()));
const wornHash = (page, uuid) =>
	page.evaluate((u) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => r(g.getObjectByProperty('uuid', u)?.material?.userData?.shaderCodeHash ?? null))()), uuid);
const setCode = (page, key, c) => page.evaluate(([k, v]) => window.__stores.shaderGraph.setShaderGraphFor(k, { nodes: [], edges: [], code: v }), [key, c]);
const errorsOf = (page, key) => page.evaluate((k) => new Promise((r) => window.__stores.shaderGraph.shaderErrors.subscribe((all) => r(all[k] ?? []))()), key);
const statusOf = (page) => page.evaluate(() => document.querySelector('#shader-own-status')?.getAttribute('data-state') ?? null);

/** poll until truthy */
async function until(page, fn, what, ms = 25000) {
	const at = Date.now();
	let last;
	while (Date.now() - at < ms) {
		last = await fn();
		if (last) break;
		await page.waitForTimeout(250);
	}
	h.check(!!last, what);
	return last;
}

/** the probe worker as the browser without WebGL2-in-workers sees it */
const workerUnavailable = (page) =>
	page.evaluate(() => window.__stores.shaderCodeGuard.shaderCodeGuardForTest.setMakeProbeWorker(() => {
		throw new Error('no worker here');
	}));
const workerReal = (page) => page.evaluate(() => {
	const g = window.__stores.shaderCodeGuard.shaderCodeGuardForTest;
	g.resetMakeProbeWorker();
	g.forgetVerdicts();
});

async function openOwnPane(page, uuid) {
	await page.evaluate((k) => {
		window.__stores.shaderEditorClose.set(false);
		window.__stores.objectActions.selectObject(k, true);
	}, uuid);
	await page.evaluate(() => window.__stores.shaderGraph.openShaderEditor());
	await page.waitForSelector('#shader-code-btn', { timeout: 15000 });
	await page.evaluate(() => {
		const b = document.getElementById('shader-code-btn');
		if (b.getAttribute('aria-pressed') !== 'true') b.click();
	});
	await page.waitForSelector('#shader-code-pane', { timeout: 10000 });
	await page.click('#shader-code-tab-own');
	await page.waitForSelector('#shader-own-editor .cm-content', { timeout: 10000 });
}

async function axeClean(page, label) {
	const res = await new AxeBuilder({ page }).include('#shader-code-pane').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
	const gated = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
	for (const v of res.violations) console.log(`  [axe ${label}] ${v.impact} ${v.id} (${v.nodes.length}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
	h.check(gated.length === 0, `AI10 ${label}: no serious/critical axe violations (${gated.map((v) => v.id).join(', ') || 'none'})`);
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 800 } } });
	const page = A.page;
	await page.evaluate(() => window.__stores.shaderCodeReach.shaderCodeReachForTest.forgetMine());
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	const uuid = await until(page, () => firstMesh(page), 'premise — a cube');

	// ---- 1. AI4: the error by the text ----------------------------------------------------------------
	await setCode(page, uuid, code('1.0'));
	await until(page, () => wornHash(page, uuid), 'premise — a good pair from someone else runs after a PASSED worker test (AI9 counterfactual)');
	await openOwnPane(page, uuid);
	await page.click('#shader-own-vertex');
	await setCode(page, uuid, code('1.0', { fragment: 'void main() {\n  gl_FragColor = nope;\n}\n' }));
	const line = await until(page, async () => (await page.locator('#shader-own-errors').innerText().catch(() => '')) || null, 'AI4: the compile error shows in Your GLSL');
	h.check(/Fragment line 2/.test(line), 'AI4: with its stage and line: ' + line);
	h.check((await page.locator('#shader-own-errors').getAttribute('role')) === 'alert', 'AI4: announced (role=alert)');
	await page.locator('#shader-own-errors button').first().click();
	h.check((await page.locator('#shader-own-editor').getAttribute('data-stage')) === 'fragment', 'AI4: pressing it shows the fragment stage');

	// ---- 2. AI9: someone else's code, untestable here -------------------------------------------------
	await workerUnavailable(page);
	const foreign = code('0.3');
	await setCode(page, uuid, foreign);
	await until(page, async () => (await statusOf(page)) === 'held-foreign', 'AI9: someone else’s untested GLSL is held off');
	h.check((await wornHash(page, uuid)) === null, 'AI9: and the object wears its own material');
	h.check(/came from someone else/.test(await page.locator('#shader-own-status').innerText()), 'AI9: the notice says why');
	h.check((await page.locator('#shader-own-run-anyway').count()) === 1, 'AI9: with Run it anyway');
	await page.click('#shader-own-run-anyway');
	await until(page, () => wornHash(page, uuid), 'AI9: Run it anyway runs it (the first-frame box still holds)');
	const ranHash = await wornHash(page, uuid);
	h.check(await page.evaluate((hh) => (JSON.parse(localStorage.getItem('shaderCodeMine') ?? '[]')).includes(hh), ranHash), 'AI9: the choice is remembered on this device');
	// counterfactual: YOUR code (applied in the pane) with the same untestable verdict runs
	await page.click('#shader-own-editor .cm-content');
	await page.keyboard.press('Control+A');
	await page.keyboard.insertText('varying vec2 vUv;\nvoid main() { gl_FragColor = vec4(0.1, vUv.y, 0.4, 1.0); }\n');
	await page.click('#shader-own-apply');
	await until(page, async () => (await statusOf(page)) === 'running', 'AI9 counterfactual: your own pair runs on an untestable verdict');
	await workerReal(page);

	// ---- 3. AI10: axe, names, keyboard, at desktop and the N6 folded ---------------------------------------
	for (const [label, size] of [['desktop', { width: 1280, height: 800 }], ['N6 folded', { width: 412, height: 900 }]]) {
		await page.setViewportSize(size);
		await page.waitForTimeout(600);
		await openOwnPane(page, uuid);
		for (const tab of ['glsl', 'json', 'own']) {
			await page.focus('#shader-code-tab-' + tab);
			await page.keyboard.press('Enter');
			await until(page, async () => (await page.locator('#shader-code-tab-' + tab).getAttribute('aria-pressed')) === 'true', `AI10 ${label}: the ${tab} tab answers Enter`);
			await page.waitForTimeout(300);
			await axeClean(page, `${label} ${tab}`);
		}
		const names = await page.evaluate(() => [...document.querySelectorAll('#shader-code-pane .cm-content')].map((e) => e.getAttribute('aria-label')));
		h.check(names.length > 0 && names.every((n) => n && n !== 'Code editor'), `AI10 ${label}: the editor is named (${names.join(', ')})`);
		await page.focus('#shader-own-fragment');
		await page.keyboard.press('Enter');
		await page.keyboard.press('Tab');
		const inEditor = await page.evaluate(() => !!document.activeElement?.closest('#shader-own-editor'));
		h.check(inEditor, `AI10 ${label}: Tab moves from the stage switch into the editor`);
		await page.focus('#shader-own-apply');
		await page.keyboard.press('Enter');
		await until(page, async () => (await statusOf(page)) === 'running', `AI10 ${label}: Apply answers Enter`);
		await page.screenshot({ path: (process.env.E2E_EVID || 'test-results') + '/shader-reach-' + label.replace(' ', '-') + '.png' }).catch(() => {});
	}
	await page.close();

	// ---- 4. AI9 on Quest: off by default, with the switch ---------------------------------------------
	const Q = await h.setupPage(browser, 'quest', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 }, userAgent: QUEST_UA } });
	const q = Q.page;
	h.check(await q.evaluate(() => /OculusBrowser/.test(navigator.userAgent)), 'premise — the Quest browser user agent');
	await q.evaluate(() => window.__stores.shaderCodeReach.setCustomShadersOnQuest(false));
	const probes = () => q.evaluate(() => window.__stores.shaderCodeGuard.shaderCodeGuardForTest.probeRuns());
	const probesBefore = await probes();
	await q.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	const qu = await until(q, () => firstMesh(q), 'premise — a cube on the Quest page');
	await setCode(q, qu, code('0.8'));
	await until(q, async () => /off on Quest/.test((await errorsOf(q, qu)).join()), 'AI9 Quest: custom GLSL is off by default');
	h.check((await wornHash(q, qu)) === null, 'AI9 Quest: the object wears its own material');
	h.check((await probes()) === probesBefore, 'AI9 Quest: not even the worker test ran');
	await openOwnPane(q, qu);
	h.check((await statusOf(q)) === 'held-quest' && (await q.locator('#shader-own-quest-on').count()) === 1, 'AI9 Quest: the pane offers Turn on custom shaders');
	await q.evaluate(() => {
		const s = window.__stores;
		s.settingsOpen.set(false);
		s.settingsSection.set('vr');
		s.settingsOpen.set(true);
	});
	await until(q, () => q.evaluate(() => !!document.querySelector('#row-vr-customShaders') || [...document.querySelectorAll('#settings-sections *')].some((e) => e.textContent?.trim() === 'Turn on custom shaders')), 'AI9 Quest: Settings ▸ VR has the switch', 10000);
	await q.evaluate(() => window.__stores.settingsOpen.set(false));
	await iwer.enter(q);
	await iwer.frames(q, 4);
	h.check((await wornHash(q, qu)) === null, 'AI9 Quest: still off inside the XR session');
	await iwer.exit(q);
	await q.click('#shader-own-quest-on');
	await until(q, () => wornHash(q, qu), 'AI9 Quest counterfactual: turned on, it runs');
	h.check((await probes()) > probesBefore, 'AI9 Quest: and the worker test ran first');
	h.check(await q.evaluate(() => localStorage.getItem('customShadersQuest') === '1'), 'AI9 Quest: the switch is remembered');

	await h.finish(browser);
});

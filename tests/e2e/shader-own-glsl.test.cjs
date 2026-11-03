// 73 AI3 — the shader code view and your own GLSL, with the GPU-hang guard around it.
// Two real peers (the document replicates, the verdict never does) + the panel at desktop and
// the N6's folded width. A real context loss through WEBGL_lose_context; a stuck fence and a
// silent worker through the guard's test seams, because a GPU cannot be hung on demand here.
const h = require('./helpers.cjs');

const VERT = `varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const FRAG = (r) => `uniform vec3 tint;
uniform float gain;
varying vec2 vUv;
void main() { gl_FragColor = vec4(tint * gain * ${r}, 1.0); }
`;
const code = (r, extra = {}) => ({ use: true, vertex: VERT, fragment: FRAG(r), uniforms: { tint: [1, 0, 0], gain: 1 }, ...extra });

const firstMesh = (page) =>
	page.evaluate(() => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => {
		let m = null;
		g.traverse((n) => { if (n.isMesh && !m) m = n; });
		r(m?.uuid ?? null);
	})()));

/** what the object is actually wearing */
const worn = (page, uuid) =>
	page.evaluate((u) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => {
		const m = g.getObjectByProperty('uuid', u)?.material;
		r({
			hash: m?.userData?.shaderCodeHash ?? null,
			isShader: !!m?.isShaderMaterial,
			gain: m?.userData?.shaderUniforms?.gain?.value ?? null,
			tint: m?.userData?.shaderUniforms?.tint?.value ?? null,
			firstFrameMs: m?.userData?.shaderCodeFirstFrameMs ?? null,
			id: m?.uuid ?? null
		});
	})()), uuid);

const errorsOf = (page, key) =>
	page.evaluate((k) => new Promise((r) => window.__stores.shaderGraph.shaderErrors.subscribe((all) => r(all[k] ?? []))()), key);

const setCode = (page, key, c) =>
	page.evaluate(([k, value]) => {
		const sg = window.__stores.shaderGraph;
		sg.setShaderGraphFor(k, { nodes: [], edges: [], code: value });
	}, [key, c]);

/** fire and let the app settle a little; poll with `until` rather than sleeping */
async function until(page, fn, what, ms = 25000) {
	const at = Date.now();
	let last;
	while (Date.now() - at < ms) {
		last = await fn();
		if (last) break;
		await page.waitForTimeout(250);
	}
	h.check(!!last, what);
	if (!last) console.log('DIAG', what, await page.evaluate(() => new Promise((r) => {
		const s = window.__stores;
		let errs, blocked, sus, lost;
		s.shaderGraph.shaderErrors.subscribe((v) => (errs = v))();
		s.shaderCodeGuard.shaderCodeBlocked.subscribe((v) => (blocked = v))();
		s.shaderCodeGuard.shaderCodeSuspended.subscribe((v) => (sus = v))();
		s.contextLost?.subscribe((v) => (lost = v))();
		r(JSON.stringify({ errs, blocked, sus, lost, active: s.shaderCodeGuard.shaderCodeGuardForTest.activeHashes() }));
	})));
	return last;
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await until(A.page, () => firstMesh(A.page), 'premise — A has a cube');
	const uuid = await firstMesh(A.page);

	// ---- 1. the pair runs, through the worker, on the real renderer ------------------
	await setCode(A.page, uuid, code('1.0'));
	const on = await until(A.page, async () => { const w = await worn(A.page, uuid); return w.hash && w; }, 'your GLSL is installed');
	h.check(on.isShader, 'a real ShaderMaterial: ' + JSON.stringify(on));
	await until(A.page, async () => (await worn(A.page, uuid)).firstFrameMs !== null, 'the first frame reported finished inside its box');
	h.check((await errorsOf(A.page, uuid)).length === 0, 'no errors for a good pair');
	const journal = await A.page.evaluate(() => localStorage.getItem('shaderCodeJournal'));
	h.check(!journal || journal === '[]', 'the journal is struck off once the frame finished: ' + journal);

	// ---- 2. a field write is a value write, not a new program ------------------------
	const before = await worn(A.page, uuid);
	await A.page.evaluate((k) => {
		const sg = window.__stores.shaderGraph;
		const doc = sg.shaderGraphOf(k);
		sg.setShaderGraphFor(k, { code: { ...doc.code, uniforms: { ...doc.code.uniforms, gain: 0.25 } } });
	}, uuid);
	await until(A.page, async () => (await worn(A.page, uuid)).gain === 0.25, 'the field reached the live uniform');
	h.check((await worn(A.page, uuid)).id === before.id, 'the same material: no recompile for a value');

	// ---- 3. the static gate: nothing reaches a GPU, and the last good stays -------------
	await setCode(A.page, uuid, code('1.0', { fragment: 'void main() { while (true) {} }' }));
	const refused = await until(A.page, async () => { const e = await errorsOf(A.page, uuid); return e.length && e; }, 'while(true) is refused');
	h.check(/`while`/.test(refused[0]), 'and it says why: ' + refused[0]);
	h.check((await worn(A.page, uuid)).hash === before.hash, 'the last good material stays while you type');

	// ---- 4. a compile error comes back from the worker on the author's line -------------
	await setCode(A.page, uuid, code('1.0', { fragment: 'void main() {\n  gl_FragColor = nope;\n}\n' }));
	const broken = await until(A.page, async () => { const e = await errorsOf(A.page, uuid); return e.length && /nope/.test(e.join()) && e; }, 'the driver log reaches the editor');
	h.check(/Fragment line 2/.test(broken[0]), 'on the author\'s own line: ' + broken[0]);
	h.check((await worn(A.page, uuid)).hash === before.hash, 'the broken text never replaced the last good');

	// ---- 5. a hostile GLSL expression node cannot break out of its statement ------------
	await A.page.evaluate((k) => window.__stores.shaderGraph.setShaderGraphFor(k, {
		code: { ...window.__stores.shaderGraph.shaderGraphOf(k).code, use: false },
		nodes: [
			{ id: 's', type: 'surface', data: {} },
			{ id: 'g', type: 'glsl', data: { expression: '0.0); while (true) {} float x = (1.0', type: 'float' } }
		],
		edges: [{ id: 'e', source: 'g', sourceHandle: 'out', target: 's', targetHandle: 'roughness' }]
	}), uuid);
	await until(A.page, async () => /cannot contain/.test((await errorsOf(A.page, uuid)).join()), 'the expression node refuses a statement');

	// ---- 6. the worker never answers: time-boxed, off on this device, document kept -----
	await A.page.evaluate(() => {
		const g = window.__stores.shaderCodeGuard.shaderCodeGuardForTest;
		// past the boot, then silence: a worker that holds the text and never answers
		g.setMakeProbeWorker(() => {
			const fake = { terminate() {}, onmessage: null, onerror: null, postMessage(m) { setTimeout(() => fake.onmessage?.({ data: { id: m.id, phase: 'compile' } }), 0); } };
			return fake;
		});
	});
	await setCode(A.page, uuid, code('0.5'));
	await until(A.page, async () => /did not finish its test draw/.test((await errorsOf(A.page, uuid)).join()), 'a silent probe times out');
	h.check((await worn(A.page, uuid)).hash === null, 'and the object is back on its own material');
	h.check(await A.page.evaluate((k) => window.__stores.shaderGraph.shaderGraphOf(k).code.use === true, uuid), 'the document is untouched: a verdict is this device\'s');
	await A.page.evaluate(() => {
		const g = window.__stores.shaderCodeGuard.shaderCodeGuardForTest;
		g.resetMakeProbeWorker();
	});

	// ---- 7. Try again re-runs the verdict -------------------------------------------------
	await A.page.evaluate((k) => window.__stores.shaderGraph.retryShaderCodeFor(k), uuid);
	await until(A.page, async () => (await worn(A.page, uuid)).hash, 'Try again runs it through the real worker');

	// ---- 8. the first frame never finishes: taken off, blocked, persisted -----------------
	await A.page.evaluate(() => {
		const g = window.__stores.shaderCodeGuard.shaderCodeGuardForTest;
		g.setFenceStuck(true);
		g.setFirstFrameMs(300);
	});
	await setCode(A.page, uuid, code('0.75'));
	await until(A.page, async () => /first frame/.test((await errorsOf(A.page, uuid)).join()), 'a stuck first frame is caught');
	h.check((await worn(A.page, uuid)).hash === null, 'and the object is back on its own material');
	const blocked = await A.page.evaluate(() => localStorage.getItem('shaderCodeBlocked'));
	h.check(/first frame/.test(blocked ?? ''), 'the block is on this device\'s disk: ' + blocked);
	await A.page.evaluate(() => {
		const g = window.__stores.shaderCodeGuard.shaderCodeGuardForTest;
		g.setFenceStuck(false);
		g.setFirstFrameMs(6000);
	});
	await A.page.evaluate((k) => window.__stores.shaderGraph.retryShaderCodeFor(k), uuid);
	await until(A.page, async () => (await worn(A.page, uuid)).hash, 'Try again lifts the block');

	// ---- 9. a REAL context loss takes custom GLSL off, and it stays off -------------------
	const lost = await A.page.evaluate(() => new Promise((r) => {
		window.__stores.globalRenderer.subscribe((renderer) => {
			const ext = renderer.getContext().getExtension('WEBGL_lose_context');
			window.__loseExt = ext;
			if (ext) ext.loseContext();
			r(!!ext);
		})();
	}));
	h.check(lost, 'premise — WEBGL_lose_context exists');
	await until(A.page, async () => /context was lost/.test((await errorsOf(A.page, uuid)).join()), 'context loss turns custom GLSL off');
	h.check((await worn(A.page, uuid)).hash === null, 'the object is back on its own material');
	await A.page.evaluate(() => window.__loseExt.restoreContext());
	await A.page.waitForTimeout(1500);
	h.check((await worn(A.page, uuid)).hash === null, 'still off after the context came back');
	await A.page.evaluate((k) => window.__stores.shaderGraph.retryShaderCodeFor(k), uuid);
	await until(A.page, async () => (await worn(A.page, uuid)).hash, 'Try again turns it back on');

	// ---- 10. THE PANEL: code view + apply, real clicks --------------------------------------
	await A.page.evaluate((k) => {
		window.__stores.shaderGraph.setShaderGraphFor(k, null);
		window.__stores.shaderEditorClose.set(false);
		window.__stores.objectActions.selectObject(k, true);
	}, uuid);
	await A.page.evaluate(() => window.__stores.shaderGraph.openShaderEditor());
	await A.page.waitForSelector('#shader-code-btn', { timeout: 15000 });
	await A.page.evaluate(() => {
		if (document.getElementById('shader-code-btn').getAttribute('aria-pressed') !== 'true') document.getElementById('shader-code-btn').click();
	});
	await A.page.waitForSelector('#shader-code-pane', { timeout: 10000 });
	h.check(await A.page.locator('#shader-code-side').isVisible(), 'desktop: a split beside the graph');

	await A.page.click('#shader-create-btn');
	await until(A.page, () => A.page.evaluate((k) => !!window.__stores.shaderGraph.shaderGraphOf(k), uuid), 'a graph to look at');
	await A.page.click('#shader-code-tab-glsl');
	await until(A.page, async () => /Generated from the graph/.test(await A.page.locator('#shader-code-glsl').innerText()), 'the GLSL tab shows what the graph compiles to');
	const glslText = await A.page.locator('#shader-code-glsl').innerText();
	h.check(/albedo =/.test(glslText), 'with the taps in it');

	// Graph JSON: a broken Apply says so, a good one writes the graph
	await A.page.click('#shader-code-tab-json');
	await A.page.waitForSelector('#shader-code-json .cm-content', { timeout: 10000 });
	await A.page.click('#shader-code-json .cm-content');
	await A.page.keyboard.press('Control+A');
	await A.page.keyboard.insertText('{ nope');
	await A.page.click('#shader-json-apply');
	await until(A.page, async () => /Invalid JSON/.test(await A.page.locator('#shader-json-error').innerText().catch(() => '')), 'bad JSON is refused out loud');
	await A.page.click('#shader-code-json .cm-content');
	await A.page.keyboard.press('Control+A');
	const good = JSON.stringify({
		nodes: [{ id: 'surface', type: 'surface', position: { x: 300, y: 100 }, data: {} }, { id: 'c2', type: 'color', position: { x: 50, y: 100 }, data: { value: '#00ff00' } }],
		edges: [{ id: 'e2', source: 'c2', sourceHandle: 'out', target: 'surface', targetHandle: 'albedo' }]
	});
	await A.page.keyboard.insertText(good);
	await A.page.click('#shader-json-apply');
	await until(A.page, () => A.page.evaluate((k) => window.__stores.shaderGraph.shaderGraphOf(k)?.nodes?.some((n) => n.id === 'c2'), uuid), 'Apply writes the graph');

	// Your GLSL: the starter applies, the banner says who is driving, Use the graph goes back
	await A.page.click('#shader-code-tab-own');
	await A.page.waitForSelector('#shader-own-editor .cm-content', { timeout: 10000 });
	await A.page.click('#shader-own-apply');
	await until(A.page, async () => (await worn(A.page, uuid)).hash, 'Apply runs the starter pair');
	await A.page.waitForSelector('#shader-code-banner', { timeout: 10000 });
	await until(A.page, async () => (await A.page.locator('#shader-own-status').getAttribute('data-state')) === 'running', 'the status says it runs here');
	await A.page.waitForSelector('#shader-own-fields [data-uniform="tint"]', { timeout: 10000 });
	h.check(!(await A.page.locator('#shader-own-fields [data-uniform="uShaderTime"]').count()), 'the shared clock gets no field');
	await until(A.page, async () => {
		const w = await worn(A.page, uuid);
		return w.hash && (await A.page.evaluate((u) => new Promise((r) => window.__stores.objectsGroup.subscribe((g) => {
			r(g.getObjectByProperty('uuid', u)?.material?.userData?.shaderUniforms?.uShaderTime?.value > 0);
		})()), uuid));
	}, 'the shared clock ticks it');
	await A.page.click('#shader-own-off');
	await until(A.page, async () => (await worn(A.page, uuid)).hash === null, 'Use the graph goes back to the graph');
	h.check(await A.page.evaluate((k) => window.__stores.shaderGraph.shaderGraphOf(k).code.fragment.length > 0, uuid), 'and the text is kept');
	const undone = await A.page.evaluate(async (k) => {
		window.__stores.history.undo();
		await new Promise((r) => setTimeout(r, 400));
		return window.__stores.shaderGraph.shaderGraphOf(k).code.use;
	}, uuid);
	h.check(undone === true, 'undo brings your GLSL back');
	await until(A.page, async () => (await worn(A.page, uuid)).hash, 'and it runs again');

	// ---- 11. save + reload: the document persists, and a crashed start is blocked ------------
	const snapshot = await A.page.evaluate(() => window.__stores.shaderGraph.shaderGraphsSnapshot());
	h.check(JSON.stringify(snapshot).includes('uShaderTime'), 'the snapshot carries the code');
	const hash = (await worn(A.page, uuid)).hash;
	await A.page.evaluate((hh) => {
		localStorage.setItem('shaderCodeJournal', JSON.stringify([hh]));
		localStorage.removeItem('shaderCodeBlocked');
	}, hash);
	await h.freshReload(A);
	await h.answerRestore(A);
	const afterCrash = await A.page.evaluate(() => JSON.parse(localStorage.getItem('shaderCodeBlocked') ?? '{}'));
	h.check(/last session ended/.test(afterCrash[hash] ?? ''), 'a journal left by a crash blocks that shader at the next boot: ' + JSON.stringify(afterCrash));
	await A.page.evaluate((hh) => {
		const all = JSON.parse(localStorage.getItem('shaderCodeBlocked') ?? '{}');
		delete all[hh];
		localStorage.setItem('shaderCodeBlocked', JSON.stringify(all));
		window.__stores.shaderCodeGuard.retryShaderCode(hh);
	}, hash);

	// ---- 12. THE PHONE: the N6 folded and unfolded. The pane is a sheet, at each width -----------
	for (const [label, size] of [['folded', { width: 412, height: 900 }], ['unfolded', { width: 620, height: 690 }]]) {
		await A.page.setViewportSize(size);
		await A.page.waitForTimeout(800);
		await A.page.evaluate(() => window.__stores.shaderGraph.openShaderEditor());
		await A.page.waitForSelector('#shader-code-btn', { timeout: 15000 });
		const state = await A.page.evaluate(() => {
			const btn = document.getElementById('shader-code-btn');
			if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
			return btn.getAttribute('aria-pressed');
		});
		h.check(state !== null, label + ': the </> button exists');
		await A.page.waitForSelector('#shader-code-pane', { timeout: 10000 });
		const box = await A.page.locator('#shader-code-pane').boundingBox();
		h.check(box && box.x >= 0 && box.x + box.width <= size.width + 1, label + ': the pane fits the screen: ' + JSON.stringify(box));
		h.check(!(await A.page.locator('#shader-code-side').count()), label + ': a sheet, not a split');
		h.check(box && box.height > 200, label + ': with room for code: ' + (box && box.height));
		// the phone bar sits over the bottom of the screen: the pane has to end above it
		const clear = await A.page.evaluate(() => {
			const r = document.getElementById('shader-code-pane').getBoundingClientRect();
			const probe = document.elementFromPoint(r.left + r.width / 2, r.bottom - 8);
			return { bottom: Math.round(r.bottom), inside: !!probe?.closest('#shader-code-pane') };
		});
		h.check(clear.bottom <= size.height && clear.inside, label + ': its last line is on screen and not covered: ' + JSON.stringify(clear));
		await A.page.screenshot({ path: (process.env.E2E_EVID || 'test-results') + '/own-glsl-' + label + '.png' }).catch(() => {});
		await A.page.evaluate(() => document.getElementById('shader-code-btn')?.click());
		await A.page.keyboard.press('Escape');
	}

	await h.finish(browser);
});

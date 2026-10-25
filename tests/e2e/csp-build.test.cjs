// 69 T3: a BUILD ships a Content-Security-Policy (csp.config.js → each page's <meta>, frame-ancestors
// in build/_headers). The claim is two-sided, so is the suite: the app's own engines still run under it
// (the QuickJS script sandbox and rapier are both wasm, which needs 'wasm-unsafe-eval' and nothing
// more), and the policy is really enforced (an injected inline <script> and eval are refused).
// Runs against a built app (scripts/serve-build.cjs); a dev server ships no policy, so it SKIPs.
const h = require('./helpers.cjs');
h.run(async () => {
	const browser = await h.launch();
	const collect = () => {
		window.__csp = [];
		document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
	};
	const A = await h.setupPage(browser, 'A', { init: collect });
	const page = A.page;
	const meta = await page.evaluate(() => document.querySelector('meta[http-equiv="content-security-policy"]')?.getAttribute('content') ?? '');
	if (!meta) {
		console.log('SKIP: no policy on this page (a dev server — run against scripts/serve-build.cjs)');
		await browser.close();
		return;
	}
	h.check(/script-src 'self' 'wasm-unsafe-eval' blob:/.test(meta) && !/unsafe-eval'/.test(meta.replace("'wasm-unsafe-eval'", '')), 'the build carries the policy, no unsafe-eval (' + meta.slice(0, 80) + '…)');

	// a script node runs (the QuickJS engine is wasm)
	const uuid = await page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) => window.__stores.objectsGroup.subscribe((g) => resolve(g.children[g.children.length - 1].uuid))());
	});
	await page.evaluate((uuid) => {
		window.__stores.flowNodes.set([
			{ id: 'sc1', type: 'script', position: { x: 0, y: 0 }, data: { type: 'script', code: 'object.position.x = base.pos[0] + Math.sin(time * 3);' } },
			{ id: 'sel1', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: uuid } }
		]);
		window.__stores.flowEdges.set([{ id: 'e1', source: 'sc1', target: 'sel1' }]);
	}, uuid);
	const xOf = () => page.evaluate((uuid) => { let g; window.__stores.objectsGroup.subscribe((v) => (g = v))(); return g.getObjectByProperty('uuid', uuid)?.position.x; }, uuid);
	let moved = false;
	for (let i = 0; i < 60 && !moved; i++) {
		const a = await xOf();
		await page.waitForTimeout(250);
		moved = (await xOf()) !== a;
	}
	h.check(moved, 'a script node animates under the policy (QuickJS wasm loads)');

	// physics (rapier wasm)
	await page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
	await page.evaluate(() => window.__stores.physics.toggleSimulation());
	await page.waitForTimeout(1500);
	const bodies = await page.evaluate(() => window.__stores.physics.physicsDebug().length);
	h.check(bodies > 0, 'the physics engine starts under the policy (' + bodies + ' bodies)');
	await page.evaluate(() => window.__stores.physics.toggleSimulation());

	const before = await page.evaluate(() => window.__csp.slice());
	h.check(before.length === 0, 'no policy violations while the app ran (' + JSON.stringify(before) + ')');

	// negative controls: the policy is enforced
	const inline = await page.evaluate(async () => {
		const s = document.createElement('script');
		s.textContent = 'window.__inlineRan = 1';
		document.head.appendChild(s);
		await new Promise((r) => setTimeout(r, 200));
		let evalBlocked = false;
		try {
			(0, eval)('1 + 1');
		} catch {
			evalBlocked = true;
		}
		return { ran: window.__inlineRan === 1, evalBlocked, violations: window.__csp.slice() };
	});
	h.check(!inline.ran, 'an injected inline <script> does not run');
	h.check(inline.evalBlocked, 'eval is refused');
	h.check(inline.violations.some((v) => /script-src/.test(v)), 'and both show up as script-src violations (' + JSON.stringify(inline.violations) + ')');
	await h.finish(browser);
});

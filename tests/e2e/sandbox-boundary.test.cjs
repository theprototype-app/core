// 69 T1 — what code carried in a scene can reach, asked from INSIDE it. Script nodes and custom HUD
// elements run in the sandbox engine (src/lib/sandbox): no page globals, no storage, no network, no
// DOM. The suite does not try to do anything with those — it asks whether they EXIST from each code
// path, checks that hostile HUD markup comes out sanitised, and counts requests to a host nothing
// legitimate uses. Positive controls: the page itself has every one of those globals, and the same
// code paths still do their real jobs (move an object, draw text).
const h = require('./helpers.cjs');

// what an escape would need; none of it may be visible from scene code
const GLOBALS = ['window', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'navigator', 'location', 'parent', 'top', 'opener', 'importScripts', 'postMessage', 'setTimeout'];
const probe = (/** @type {string} */ extra) => `${JSON.stringify(GLOBALS)}
	.filter((k) => typeof globalThis[k] !== 'undefined')
	.concat((function () {}).constructor('return typeof window')() !== 'undefined' ? ['Function->window'] : [])
	.concat(${extra})
	.join(',') || 'none'`;
// a script has no document at all
const PROBE = probe("typeof document !== 'undefined' ? ['document'] : []");
// a custom HUD element draws through the guest's own small document — which must lead nowhere
const HUD_PROBE = probe("['cookie', 'defaultView', 'location', 'domain', 'body', 'head'].filter((k) => typeof document[k] !== 'undefined').map((k) => 'document.' + k)");
const UNUSED_HOST = 'unused-host.invalid';

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	const outbound = [];
	page.on('request', (req) => {
		if (req.url().includes(UNUSED_HOST)) outbound.push(req.url());
	});

	const pageHas = await page.evaluate(() => ['localStorage', 'fetch', 'WebSocket', 'RTCPeerConnection', 'document'].every((k) => typeof globalThis[k] !== 'undefined'));
	h.check(pageHas, 'premise: the page itself has storage, network and the DOM');

	// ---- 1. a Script node ----------------------------------------------------------------
	const uuid = await page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) => window.__stores.objectsGroup.subscribe((g) => resolve(g.children[g.children.length - 1].uuid))());
	});
	await page.evaluate(
		({ uuid, probe }) => {
			window.__stores.flowNodes.set([
				{
					id: 'probe',
					type: 'script',
					position: { x: 0, y: 0 },
					data: { type: 'script', code: `object.userData.seen = ${probe}; object.userData.hasParent = typeof object.parent; object.position.y = 2;` }
				},
				{ id: 'sel', type: 'objectselector', position: { x: 300, y: 0 }, data: { type: 'objectselector', selected: uuid } }
			]);
			window.__stores.flowEdges.set([{ id: 'e1', source: 'probe', target: 'sel' }]);
		},
		{ uuid, probe: PROBE }
	);
	const readObject = () =>
		page.evaluate((uuid) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', uuid);
			return { seen: o?.userData?.seen ?? null, hasParent: o?.userData?.hasParent ?? null, y: o?.position.y };
		}, uuid);
	await h.eventually(readObject, (r) => r.seen !== null, 'the script ran (the sandbox engine loaded)', 30000);
	const fromScript = await readObject();
	h.check(fromScript.y === 2, `positive control: the script still moves its object (y=${fromScript.y})`);
	h.check(fromScript.seen === 'none', `a script sees no page globals, storage, network or timers (${fromScript.seen})`);
	h.check(fromScript.hasParent === 'undefined', `and its object is a view with no way up the scene graph (parent: ${fromScript.hasParent})`);

	// ---- 2. a custom HUD element ---------------------------------------------------------
	await page.evaluate(
		({ hudProbe, host }) => {
			window.__stores.hudDocs.setHudDocFor('scene', {
				screens: [
					{
						id: 'probe',
						name: 'Probe',
						elements: [
							{ id: 'seen', kind: 'custom', anchor: 'top-left', x: 20, y: 20, w: 400, h: 40, code: `container.textContent = ${hudProbe};` },
							{
								id: 'markup',
								kind: 'custom',
								anchor: 'top-left',
								x: 20,
								y: 80,
								w: 400,
								h: 80,
								code: `container.innerHTML = '<b class="kept">kept</b><img src="https://${host}/p.png"><a href="javascript:void 0">a</a><span onclick="void 0">s</span><div style="background:url(https://${host}/bg.png)">d</div><script>void 0<\\/script>';`
							}
						]
					}
				],
				active: 'probe'
			});
		},
		{ hudProbe: HUD_PROBE, host: UNUSED_HOST }
	);
	const readHud = () =>
		page.evaluate((host) => {
			const seen = document.querySelector('[data-hud-id="seen"] .hud-custom-slot')?.textContent?.trim() ?? null;
			const slot = document.querySelector('[data-hud-id="markup"] .hud-custom-slot');
			if (!slot) return { seen, markup: null };
			const all = [...slot.querySelectorAll('*')];
			return {
				seen,
				markup: {
					kept: !!slot.querySelector('b.kept'),
					remote: slot.innerHTML.includes(host),
					handlers: all.filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
					jsLinks: all.filter((el) => /^\s*javascript:/i.test(el.getAttribute('href') || '')).length,
					scripts: slot.querySelectorAll('script').length
				}
			};
		}, UNUSED_HOST);
	await h.eventually(readHud, (r) => r.seen !== null && r.markup !== null, 'the custom elements rendered', 20000);
	const hud = await readHud();
	h.check(hud.seen === 'none', `a custom HUD element sees no page globals either (${hud.seen})`);
	h.check(hud.markup.kept, 'positive control: allowed markup is drawn');
	h.check(!hud.markup.remote, 'no remote URL survives the sanitiser (img src, CSS url())');
	h.check(hud.markup.handlers === 0 && hud.markup.jsLinks === 0 && hud.markup.scripts === 0, `no event handlers, javascript: links or scripts (${JSON.stringify(hud.markup)})`);

	await page.waitForTimeout(1500);
	h.check(outbound.length === 0, `nothing in the scene made a request to an outside host (${outbound.length})`);
	await h.finish(browser);
});

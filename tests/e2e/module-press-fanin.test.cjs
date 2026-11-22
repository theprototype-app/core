// 48 D2 — EVENT-AS-PULSE into a MODULE node's input (DEVX #22), the half that was still missing.
//
// Since 1.23 a HUD Button wired straight into a module input reads the onclick pulse window, so
// the Delay "bridge" Football and Dungeon Realms put between the two has not been needed. What
// still did not work is TWO event wires into ONE input: resolveInputs let the last edge win even
// while it read 0, so a press on the first button never arrived — and both games carried a
// duplicate Match / Menu Button node per HUD button instead. This suite pins both halves on an
// inline module whose effect counts rising edges on its `press` input.
//
//   1  one HUD Button straight into `press` (no Delay): a press arrives (green since 1.23)
//   2  two HUD Buttons into one `press`: the FIRST one's press arrives (red on v1.38.0)
//   3  ...and the second one's
//   4  a Delay bridge still works exactly as before (saved scenes keep it)
//
// Run: APP_URL='https://localhost:5481/' npm run e2e -- module-press-fanin
const h = require('./helpers.cjs');

const presses = (page, id) => page.evaluate((nid) => window.__press?.[nid] ?? 0, id);
const fire = (page, id) => page.evaluate((nid) => window.__tp.test.v1.flowRuntime.applyNodeTrigger(nid, (Date.now() % 86400000) / 1000, false), id);

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const p = A.page;
	await p.waitForFunction(() => !!window.__tp?.test.v1?.moduleSDK && !!window.__tp?.test.v1?.flowRuntime, null, { timeout: 30000 });

	await p.evaluate(async () => {
		window.__press = {};
		window.__was = {};
		await window.__tp.test.v1.moduleSDK.initModules([
			{
				id: 'testpress',
				name: 'Test press',
				version: '1.0.0',
				description: 'counts rising edges on a press input',
				register(api) {
					api.registerEffect(
						'testpress',
						(object, base, data, time, ctx) => {
							const high = Number(data.press) > 0.5;
							if (high && !window.__was[ctx.id]) window.__press[ctx.id] = (window.__press[ctx.id] ?? 0) + 1;
							window.__was[ctx.id] = high;
						},
						{ inputs: { press: 'number' } }
					);
					api.registerNodeGroup({ group: 'Test press', items: [{ type: 'testpress', label: 'Test Press', defaults: {} }] });
				}
			}
		]);
	});
	const box = await p.evaluate(async () => {
		const s = window.__tp?.test.v1;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1200));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		s.objectActions.deselectObject();
		return group.children[group.children.length - 1].uuid;
	});
	const N = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, ...data } });
	const E = (source, target, targetHandle) => ({ id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : ''), source, target, ...(targetHandle ? { targetHandle } : {}) });
	await p.evaluate(
		([nodes, edges]) => {
			const s = window.__tp?.test.v1;
			s.flowGraphs.update((g) => ({ ...g, scene: { nodes, edges } }));
			s.flowNodes.set(nodes);
			s.flowEdges.set(edges);
		},
		[
			[
				N('one-btn', 'hudbutton', { element: 'one', perPlayer: true }),
				N('one-press', 'testpress'),
				N('one-sel', 'objectselector', { selected: box }),
				N('two-a', 'hudbutton', { element: 'a', perPlayer: true }),
				N('two-b', 'hudbutton', { element: 'b', perPlayer: true }),
				N('two-press', 'testpress'),
				N('two-sel', 'objectselector', { selected: box }),
				N('br-btn', 'hudbutton', { element: 'br', perPlayer: true }),
				N('br-delay', 'delay', { seconds: 0.05, pulse: 0.3 }),
				N('br-press', 'testpress'),
				N('br-sel', 'objectselector', { selected: box })
			],
			[
				E('one-btn', 'one-press', 'press'),
				E('one-press', 'one-sel'),
				// the FIRST edge is `a`: with last-edge-wins its press is overwritten by b's 0
				E('two-a', 'two-press', 'press'),
				E('two-b', 'two-press', 'press'),
				E('two-press', 'two-sel'),
				E('br-btn', 'br-delay', 'trigger'),
				E('br-delay', 'br-press', 'press'),
				E('br-press', 'br-sel')
			]
		]
	);
	await p.waitForTimeout(1500); // the stale-stamp cutoffs take their first-seen on a tick

	await fire(p, 'one-btn');
	await h.eventually(() => presses(p, 'one-press'), (n) => n === 1, '1 a HUD Button wired straight into a module input arrives (no Delay bridge)');

	await fire(p, 'two-a');
	await h.eventually(() => presses(p, 'two-press'), (n) => n === 1, '2 the FIRST of two HUD Buttons into one input arrives (they OR)');
	await p.waitForTimeout(700); // past the 0.3 s pulse, so the next press is a new rising edge
	await fire(p, 'two-b');
	await h.eventually(() => presses(p, 'two-press'), (n) => n === 2, '3 ...and the second one does too');

	await fire(p, 'br-btn');
	await h.eventually(() => presses(p, 'br-press'), (n) => n === 1, '4 a Delay bridge still delivers its press (saved scenes keep working)');
	await p.waitForTimeout(800);
	h.check((await presses(p, 'one-press')) === 1 && (await presses(p, 'br-press')) === 1, 'no press is counted twice');

	await h.finish(browser);
});

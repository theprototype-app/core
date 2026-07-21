// Roadmap #13 H2 + H3.
//   H2  api.registerNodeDefs: the hello module seeds a code-editable custom node
//       (mod-hello-bobble) that drives objects like any custom node; reseeding
//       never clobbers a user-edited def.
//   H3  Key Press node: a real keydown pulses the node (replicated trigger) and
//       its pulse drives a wired consumer; holding keeps the output high.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- H2: module def seeded -------------------------------------------------
	const def = await A.page.evaluate(
		() => new Promise((r) => window.__stores.customNodeDefs.subscribe((d) => r(d.find((x) => x.id === 'mod-hello-bobble') ?? null))())
	);
	h.check(!!def && /position\.y/.test(def.code), 'H2: hello module seeded the editable Bobble node def');

	// the def is editable like any custom node (applyNodeDef updates in place;
	// the registerNodeDefs absent-only guard means reseeds never clobber this)
	await A.page.evaluate(() => {
		let defs; window.__stores.customNodeDefs.subscribe((d) => (defs = d))();
		const mine = { ...defs.find((x) => x.id === 'mod-hello-bobble'), code: '// user edited\nobject.position.y = base.pos[1] + Math.sin(time * (data.speed ?? 3)) * (data.height ?? 0.5);\n' };
		window.__stores.customNodes.applyNodeDef(mine);
	});
	const after = await A.page.evaluate(
		() => new Promise((r) => window.__stores.customNodeDefs.subscribe((d) => r(d.find((x) => x.id === 'mod-hello-bobble').code))())
	);
	h.check(after.includes('user edited'), 'H2: the module def is user-editable in place');

	// the def drives an object end-to-end (customnode instance in an OBJECT graph,
	// implicit owner — composes H1+H2)
	const uuid = await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		window.__stores.flowGraphsCtl.createObjectGraph(box.uuid);
		window.__stores.nodesHandler.createFlowNode(
			{ id: 'bob-1', type: 'customnode', position: { x: 0, y: 0 }, data: { type: 'customnode', defId: 'mod-hello-bobble', height: 1, speed: 3 } },
			box.uuid
		);
		return box.uuid;
	});
	await h.eventually(
		() => A.page.evaluate((id) => window.__stores.flowRuntime.isAnimatedTarget(id), uuid),
		(v) => v === true,
		'H2+H1: the module def animates its graph owner implicitly'
	);

	// --- H3: Key Press node -----------------------------------------------------
	await A.page.evaluate(() => {
		const nh = window.__stores.nodesHandler;
		nh.createFlowNode({ id: 'key-r', type: 'keypress', position: { x: 0, y: 0 }, data: { type: 'keypress', code: 'KeyR', pulse: 0.4 } }, 'scene');
	});
	await A.page.waitForTimeout(300);
	// focus the canvas area (not a text field) and press R
	await A.page.mouse.click(400, 400);
	await A.page.keyboard.down('r');
	await h.eventually(
		() =>
			A.page.evaluate(
				() => new Promise((r) => window.__stores.flowValues.subscribe((v) => r(v['key-r']))())
			),
		(v) => v === 1,
		'H3: pressing R pulses the Key Press node (output 1)'
	);
	// held: stays 1 well past a single pulse window
	await A.page.waitForTimeout(900);
	const stillHeld = await A.page.evaluate(
		() => new Promise((r) => window.__stores.flowValues.subscribe((v) => r(v['key-r']))())
	);
	h.check(stillHeld === 1, 'H3: holding the key keeps the output high (re-pulse)');
	await A.page.keyboard.up('r');
	await h.eventually(
		() =>
			A.page.evaluate(
				() => new Promise((r) => window.__stores.flowValues.subscribe((v) => r(v['key-r']))())
			),
		(v) => v === 0,
		'H3: releasing the key drops the output after the pulse expires'
	);

	// --- Flow Input: changing the type resets the fallback to a typed default --
	await A.page.evaluate(async () => {
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		window.__stores.nodesHandler.createFlowNode(
			{ id: 'fi-typed', type: 'flowinput', position: { x: 300, y: 200 }, data: { type: 'flowinput', label: 'Flow Input', name: 'val', vtype: 'number', fallback: 7 } },
			box.uuid
		);
		window.__stores.flowGraphClose.set(false);
		window.__stores.objectActions.selectObject(box.uuid);
	});
	await A.page.waitForTimeout(600);
	await A.page.locator('[data-id="fi-typed"] select').selectOption('color');
	await A.page.waitForTimeout(300);
	const typed = await A.page.evaluate(
		() => new Promise((r) =>
			window.__stores.flowGraphs.subscribe((g) => {
				for (const graph of Object.values(g)) {
					const n = graph.nodes.find((x) => x.id === 'fi-typed');
					if (n) return r({ vtype: n.data.vtype, fallback: n.data.fallback });
				}
				r(null);
			})()
		)
	);
	h.check(typed?.vtype === 'color' && typed?.fallback === '#ffffff', 'Flow Input type change resets the fallback to a typed default');

	await h.finish(browser);
});

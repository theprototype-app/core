// #20 P7 — the Graphs tree in the node and shader editors.
//
// It is a NAVIGATOR, not a second object list, and that is the claim worth testing: it
// must list `Scene` plus exactly the objects that own a document of its own kind, and no
// others. An object with no flow graph has nothing to navigate to, so a tree that showed
// every object would be a worse object list.
//
// Clicking a row selects the object, which is how the scope changes — both editors derive
// scope from the SELECTION rather than from a scope control, so the tree deliberately has
// no scope state of its own to get out of step.
const h = require('./helpers.cjs');

/** Row labels + which one is active, from the rendered tree. */
const READ_TREE = (kind) => {
	const root = document.querySelector('#graph-tree-' + kind);
	if (!root) return { present: false };
	const rows = [...root.querySelectorAll('.gt-row')].map((el) => ({
		// the whole row's text, whitespace and all: the Scene row leads with an ICON span,
		// so reading the first <span> gives "" — and the count rides at the end, which is
		// why every check below is a startsWith/includes rather than an equality
		text: el.textContent.trim(),
		active: el.classList.contains('gt-active'),
		disabled: !!el.disabled
	}));
	return { present: true, rows, labels: rows.map((r) => r.text) };
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// a wide pane with the palette shown, so the tree is actually rendered
	await A.page.evaluate(() => {
		localStorage.setItem('flowPaletteOpen', 'true');
		localStorage.setItem('flowDockHeight', '460');
		localStorage.setItem('graphTree:flow', 'true');
		localStorage.setItem('graphTree:shader', 'true');
	});
	await h.freshReload(A);

	// three boxes: one gets a flow graph, one gets a shader graph, one gets neither
	const setup = await A.page.evaluate(async () => {
		const w = window.__stores;
		for (let i = 0; i < 3; i++) {
			w.commandsHandler.sceneCommand('/create box 1 1 1');
			await new Promise((r) => setTimeout(r, 500));
		}
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const kids = g.children.slice(-3);
		kids[0].name = 'HasFlow';
		kids[1].name = 'HasShader';
		kids[2].name = 'HasNeither';
		w.objectsGroup.update((v) => v);

		w.flowGraphsCtl.createObjectGraph(kids[0].uuid);
		w.nodesHandler.createFlowNode(
			{ id: crypto.randomUUID(), type: 'time', position: { x: 20, y: 20 }, data: {} },
			kids[0].uuid
		);
		w.shaderGraph.setShaderGraphFor(kids[1].uuid, {
			nodes: [
				{ id: 'surface', type: 'surface', position: { x: 300, y: 100 }, data: {} },
				{ id: 'colour', type: 'color', position: { x: 60, y: 100 }, data: { value: '#883322' } }
			],
			edges: [{ id: 'e-c', source: 'colour', sourceHandle: 'out', target: 'surface', targetHandle: 'albedo' }]
		});
		await new Promise((r) => setTimeout(r, 500));
		w.objectActions.deselectObject();
		await new Promise((r) => setTimeout(r, 300));
		return { flow: kids[0].uuid, shader: kids[1].uuid, neither: kids[2].uuid };
	});
	h.check(!!setup.flow && !!setup.shader, 'three boxes, one with a flow, one with a shader (premise)');

	// ---- 1. the FLOW tree lists only flow owners -------------------------------
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(1400);
	const flowTree = await A.page.evaluate(READ_TREE, 'flow');
	h.check(flowTree.present, 'the node editor renders a Flows tree');
	h.check(
		flowTree.labels.some((l) => l.startsWith('Scene')),
		`Scene is always the root (${JSON.stringify(flowTree.labels)})`
	);
	h.check(
		flowTree.labels.some((l) => l.includes('HasFlow')),
		`the object owning a flow is listed (${JSON.stringify(flowTree.labels)})`
	);
	h.check(
		!flowTree.labels.some((l) => l.includes('HasNeither')) &&
			!flowTree.labels.some((l) => l.includes('HasShader')),
		`objects with no FLOW are not listed — it is a navigator, not an object list (${JSON.stringify(flowTree.labels)})`
	);

	// ---- 2. Scene is active while nothing is selected --------------------------
	const sceneActive = flowTree.rows.find((r) => r.text.startsWith('Scene'))?.active;
	h.check(sceneActive === true, `with nothing selected, Scene is the active row (${sceneActive})`);

	// ---- 3. clicking a row selects the object and moves the highlight ----------
	await A.page.evaluate(() => {
		const rows = [...document.querySelectorAll('#graph-tree-flow .gt-row')];
		rows.find((r) => r.textContent.includes('HasFlow'))?.click();
	});
	await A.page.waitForTimeout(600);
	const afterClick = await A.page.evaluate((uuid) => {
		let set;
		window.__stores.selectedObjects.subscribe((v) => (set = v))();
		const root = document.querySelector('#graph-tree-flow');
		const rows = [...root.querySelectorAll('.gt-row')];
		return {
			selection: set.slice(),
			hit: set.length === 1 && set[0] === uuid,
			activeText: rows.find((r) => r.classList.contains('gt-active'))?.textContent?.trim() ?? null
		};
	}, setup.flow);
	h.check(afterClick.hit, `clicking the row selected that object (${JSON.stringify(afterClick.selection)})`);
	h.check(
		(afterClick.activeText ?? '').includes('HasFlow'),
		`and the highlight followed the selection (${afterClick.activeText})`
	);

	// ---- 4. clicking Scene deselects, which is how you get back ----------------
	await A.page.evaluate(() => document.querySelector('#graph-tree-flow-scene')?.click());
	await A.page.waitForTimeout(500);
	const backToScene = await A.page.evaluate(() => {
		let set;
		window.__stores.selectedObjects.subscribe((v) => (set = v))();
		return set.length;
	});
	h.check(backToScene === 0, `the Scene row deselects everything (${backToScene} still selected)`);

	// ---- 5. a graph whose OBJECT is gone shows as an orphan, not a dead link ----
	// The document outlives the object until the next save prunes it, so the tree must
	// say so rather than offering a row that selects nothing.
	const orphan = await A.page.evaluate(async (uuid) => {
		window.__stores.objectActions.deleteObjectsByUuid([uuid]);
		await new Promise((r) => setTimeout(r, 800));
		const rows = [...document.querySelectorAll('#graph-tree-flow .gt-row')];
		const row = rows.find((r) => r.classList.contains('gt-missing'));
		return { count: rows.length, hasOrphan: !!row, disabled: !!row?.disabled };
	}, setup.flow);
	h.check(orphan.hasOrphan, `the flow of a deleted object is shown as an orphan (${orphan.count} rows)`);
	h.check(orphan.disabled, 'and its row is not clickable');

	// ---- 6. the SHADER tree is the same component with its own documents -------
	const shaderTree = await A.page.evaluate(async () => {
		await window.__stores.shaderGraph.openShaderEditor();
		await new Promise((r) => setTimeout(r, 1400));
		const root = document.querySelector('#graph-tree-shader');
		if (!root) return { present: false };
		return {
			present: true,
			labels: [...root.querySelectorAll('.gt-row')].map((el) => el.textContent.trim())
		};
	});
	h.check(shaderTree.present, 'the shader editor renders a Shaders tree');
	h.check(
		shaderTree.labels.some((l) => l.includes('HasShader')),
		`listing the shader owner (${JSON.stringify(shaderTree.labels)})`
	);
	h.check(
		!shaderTree.labels.some((l) => l.includes('HasNeither')),
		`and not the object with no shader (${JSON.stringify(shaderTree.labels)})`
	);

	// ---- 7. collapsing persists -------------------------------------------------
	const collapsed = await A.page.evaluate(async () => {
		document.querySelector('#graph-tree-shader .gt-head')?.click();
		await new Promise((r) => setTimeout(r, 300));
		return {
			bodyGone: !document.querySelector('#graph-tree-shader .gt-body'),
			stored: localStorage.getItem('graphTree:shader')
		};
	});
	h.check(collapsed.bodyGone, 'collapsing the section removes its rows from the DOM');
	h.check(collapsed.stored === 'false', `and the state persists (${collapsed.stored})`);

	// ---- 8. the resize grip, the animation clip list's shape -------------------
	// Its ceiling is derived from the MEASURED column, not a constant: the clip list's cap
	// used to be a flat 360px with no relation to its pane, so on a short dock the grip was
	// pushed off the bottom of the window with no way back.
	// NOT the nav button: it TOGGLES, so clicking it again here closed the node editor
	// that section 1 opened and the grip was legitimately absent. Drive the stores.
	await A.page.evaluate(async () => {
		const w = window.__stores;
		w.flowGraphClose.set(false);
		w.bottomDock.activateDock('flow');
		await new Promise((r) => setTimeout(r, 900));
		// and make sure the flow tree itself is expanded
		if (!document.querySelector('#graph-tree-flow .gt-body'))
			document.querySelector('#graph-tree-flow .gt-head')?.click();
		await new Promise((r) => setTimeout(r, 400));
	});
	const grip = await A.page.evaluate(() => {
		const el = document.querySelector('#graph-tree-flow-resize');
		const body = document.querySelector('#graph-tree-flow .gt-body');
		if (!el || !body) return { present: false };
		const r = el.getBoundingClientRect();
		const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
		return {
			present: true,
			onTop: at === el,
			x: r.x + r.width / 2,
			y: r.y + r.height / 2,
			height: body.getBoundingClientRect().height,
			maxHeight: body.style.maxHeight
		};
	});
	h.check(grip.present, 'the tree has a resize grip');
	h.check(grip.onTop, 'and it is the top element at its own centre (premise)');
	h.check(
		/^\d+px$/.test(grip.maxHeight ?? ''),
		`the body is bounded by an explicit height, not a percentage (${grip.maxHeight})`
	);

	// drag it DOWN: the list gets taller
	await A.page.mouse.move(grip.x, grip.y);
	await A.page.mouse.down();
	for (let dy = 8; dy <= 64; dy += 8) await A.page.mouse.move(grip.x, grip.y + dy, { steps: 2 });
	await A.page.mouse.up();
	await A.page.waitForTimeout(400);
	const grown = await A.page.evaluate(() => ({
		maxHeight: parseInt(document.querySelector('#graph-tree-flow .gt-body').style.maxHeight),
		stored: parseInt(localStorage.getItem('graphTree:h:flow') ?? '0')
	}));
	const before = parseInt(grip.maxHeight);
	h.check(grown.maxHeight > before, `dragging down grew the list (${before} -> ${grown.maxHeight})`);
	h.check(
		grown.stored === grown.maxHeight,
		`and the height persisted on release (stored ${grown.stored})`
	);

	// the CEILING follows the pane: a stored height taller than a short pane must be
	// clamped, or the grip ends up unreachable
	const clamped = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.bottomDock.dockHeight.set(200);
		await new Promise((r) => setTimeout(r, 600));
		const body = document.querySelector('#graph-tree-flow .gt-body');
		const col = document.querySelector('#graph-tree-flow')?.parentElement;
		return {
			bodyH: parseInt(body?.style.maxHeight ?? '0'),
			colH: col ? Math.round(col.getBoundingClientRect().height) : 0
		};
	});
	h.check(
		clamped.bodyH < clamped.colH,
		`shrinking the dock re-clamps the list inside its column (${clamped.bodyH} within ${clamped.colH})`
	);
	// and the grip is still reachable, which is the thing that actually went wrong before
	const reachable = await A.page.evaluate(() => {
		const el = document.querySelector('#graph-tree-flow-resize');
		const r = el.getBoundingClientRect();
		return r.bottom <= window.innerHeight && r.top >= 0;
	});
	h.check(reachable, 'and its grip is still on screen');

	const errs = h.pageErrors(A);
	h.check(errs.length === 0, `no page errors (${JSON.stringify(errs.slice(0, 2))})`);

	await h.finish(browser);
});

// 21-D7 — ACTIONS: the closed loop.
//
// 21-A made a button emit an event, but wiring it meant leaving the HUD editor, adding a
// `hudbutton` node by hand and TYPING the element id into it. Nothing told you whether an
// element was wired, or to what. The loop existed and was undiscoverable.
//
// The model: actions ARE flow nodes — no second behaviour system — and the HUD editor
// CREATES AND WIRES them and LISTS what is bound. So the checks that matter are that the
// list is a genuine VIEW on the graph (edit the nodes and the list follows), that an add is
// ONE undo entry and ONE replicated batch, and that both DIRECTIONS work: a button's
// outgoing action, and a readout's incoming source.
//
// Run: $env:APP_URL='https://localhost:5201/'; PEER_CONFIG=...; npm run e2e -- hud-actions
const h = require('./helpers.cjs');

const sceneNodes = (peer) =>
	peer.page.evaluate(() => {
		let g;
		window.__stores.flowGraphs.subscribe((v) => (g = v))();
		const doc = g.scene ?? { nodes: [], edges: [] };
		return { nodes: doc.nodes.map((n) => n.type), edges: doc.edges.length, ids: doc.nodes.map((n) => n.id) };
	});

// 21-E8: a clean slate has to be cleaned on EVERY peer. `flowNodes.set([])` does not
// broadcast, and nodesync's periodic hash compare then has the emptier peer PULL from the
// fuller one - so a local wipe comes BACK a few seconds later. That is exactly what the
// earlier sections got away with by being quick, and what section 12 did not.
const wipeGraphs = async (peers, settle = 900) => {
	for (const peer of peers) await peer.page.evaluate(() => window.__stores.clearGraphs());
	await peers[0].page.waitForTimeout(settle);
};

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__stores?.hudActions, { timeout: 30000 });
	await h.connect(A, B);
	const page = A.page;

	// a menu with a Start button and a score readout
	await page.evaluate(() => {
		const s = window.__stores;
		s.gameState.clearGameState();
		s.flowNodes.set([]);
		s.flowEdges.set([]);
		s.hudDocs.clearHudDocs();
		s.hudDocs.setHudDocFor('scene', {
			screens: [
				{
					id: 'menu',
					name: 'Menu',
					elements: [
						{ id: 'start', kind: 'button', label: 'Start', anchor: 'center', w: 160, h: 36 },
						{ id: 'score', kind: 'text', label: 'Gems: 0', anchor: 'top-right', x: 20, y: 20 }
					]
				}
			],
			active: 'menu'
		});
	});
	await page.waitForTimeout(900);

	// ---- 1. the catalog is kind-aware ---------------------------------------
	const catalog = await page.evaluate(() => {
		const HA = window.__stores.hudActions;
		return {
			button: HA.actionsForKind('button').map((a) => a.key),
			text: HA.actionsForKind('text').map((a) => a.key),
			// a panel is neither interactive nor a display node, so it has nothing to offer —
			// and the UI must EXPLAIN that rather than show a dead button
			panel: HA.actionsForKind('panel').map((a) => a.key),
			buttonGroups: HA.actionGroupsForKind('button').map((g) => g.group)
		};
	});
	h.check(
		catalog.button.includes('start') && catalog.button.includes('camera'),
		`a BUTTON is offered press actions (${catalog.button.join(', ')})`
	);
	h.check(
		catalog.text.includes('showvar') && !catalog.text.includes('start'),
		`a TEXT readout is offered SOURCES instead, not press actions (${catalog.text.join(', ')})`
	);
	h.check(catalog.panel.length === 0, 'a panel has neither, so the pane explains rather than offering a dead control');
	h.check(catalog.buttonGroups.length >= 3, `grouped for the picker (${catalog.buttonGroups.join(' · ')})`);

	// ---- 2. nothing is bound yet -------------------------------------------
	const empty = await page.evaluate(() => ({
		start: window.__stores.hudActions.bindingsFor('start').length,
		wired: [...window.__stores.hudActions.wiredElementIds()]
	}));
	h.check(empty.start === 0 && empty.wired.length === 0, 'premise: nothing is wired to begin with');

	// ---- 3. ADD an action: nodes + edge, ONE undo entry, replicated ---------
	const added = await page.evaluate(async () => {
		const s = window.__stores;
		const depthBefore = s.history.undoDepth ? s.history.undoDepth() : null;
		const result = s.hudActions.addBinding('start', 'start');
		await new Promise((r) => setTimeout(r, 700));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const doc = g.scene;
		return {
			ok: result.ok,
			created: result.nodes.map((n) => n.type),
			types: doc.nodes.map((n) => n.type),
			edges: doc.edges.length,
			bindings: s.hudActions.bindingsFor('start'),
			depthBefore
		};
	});
	h.check(added.ok, 'addBinding reports success');
	h.check(
		added.types.includes('hudbutton') && added.types.includes('setgamestate'),
		`it created BOTH the press node and the action node (${added.types.join(', ')})`
	);
	h.check(added.edges === 1, `and wired them (${added.edges} edge)`);
	h.check(
		added.bindings.length === 1 && added.bindings[0].role === 'press',
		`the list shows one press binding (${JSON.stringify(added.bindings.map((b) => b.label))})`
	);
	h.check(
		/playing/.test(added.bindings[0].label),
		`described in words, not node types (${added.bindings[0].label})`
	);

	// it REPLICATED — the peer holds the same graph
	await page.waitForTimeout(1400);
	const onPeer = await sceneNodes(B);
	h.check(
		onPeer.nodes.includes('hudbutton') && onPeer.nodes.includes('setgamestate') && onPeer.edges === 1,
		`the peer received the nodes AND the edge (${onPeer.nodes.join(', ')}, ${onPeer.edges} edge)`
	);

	// ONE undo entry for the whole add
	const undone = await page.evaluate(async () => {
		const s = window.__stores;
		s.history.undo();
		await new Promise((r) => setTimeout(r, 700));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		return { nodes: g.scene.nodes.length, edges: g.scene.edges.length, bindings: s.hudActions.bindingsFor('start').length };
	});
	h.check(
		undone.nodes === 0 && undone.edges === 0,
		`ONE undo removes the WHOLE action — both nodes and the edge (${undone.nodes} nodes, ${undone.edges} edges)`
	);
	h.check(undone.bindings === 0, 'and the list empties with it');

	const redone = await page.evaluate(async () => {
		const s = window.__stores;
		s.history.redo();
		await new Promise((r) => setTimeout(r, 700));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		return { nodes: g.scene.nodes.length, edges: g.scene.edges.length, bindings: s.hudActions.bindingsFor('start').length };
	});
	h.check(
		redone.nodes === 2 && redone.edges === 1 && redone.bindings === 1,
		`and REDO puts it all back (${redone.nodes} nodes, ${redone.edges} edge)`
	);

	// ---- 4. a SECOND action reuses the press node ---------------------------
	// A second `hudbutton` on one element would fire every action twice.
	const second = await page.evaluate(async () => {
		const s = window.__stores;
		s.hudActions.addBinding('start', 'camera');
		await new Promise((r) => setTimeout(r, 700));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const presses = g.scene.nodes.filter((n) => n.type === 'hudbutton');
		return {
			presses: presses.length,
			types: g.scene.nodes.map((n) => n.type),
			bindings: s.hudActions.bindingsFor('start').map((b) => b.label)
		};
	});
	h.check(second.presses === 1, `a second action REUSES the one press node (${second.presses})`);
	h.check(second.types.filter((t) => t === 'setcamera').length === 1, 'and adds only the new action node');
	h.check(second.bindings.length === 2, `the list shows both (${JSON.stringify(second.bindings)})`);

	// ---- 5. the list is a VIEW on the graph, not a copy ---------------------
	// Editing the node by hand must show up here, or the panel is lying.
	const view = await page.evaluate(async () => {
		const s = window.__stores;
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const node = g.scene.nodes.find((n) => n.type === 'setgamestate');
		s.nodesHandler.setNodeData(node.id, { state: 'over', outcome: 'lost' });
		await new Promise((r) => setTimeout(r, 700));
		return s.hudActions.bindingsFor('start').map((b) => b.label);
	});
	h.check(
		view.some((l) => /over/.test(l)),
		`editing the node by hand changes what the list says (${JSON.stringify(view)})`
	);

	// ---- 6. the DRIVES direction: a readout gets a source -------------------
	const drives = await page.evaluate(async () => {
		const s = window.__stores;
		const result = s.hudActions.addBinding('score', 'showvar');
		await new Promise((r) => setTimeout(r, 700));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const bindings = s.hudActions.bindingsFor('score');
		return {
			ok: result.ok,
			types: g.scene.nodes.map((n) => n.type),
			role: bindings[0]?.role,
			source: bindings[0]?.source,
			// the hudtext node must name the ELEMENT, or nothing drives it
			element: g.scene.nodes.find((n) => n.type === 'hudtext')?.data?.element
		};
	});
	h.check(drives.ok, 'a readout can be given a source');
	h.check(
		drives.types.includes('hudtext') && drives.types.includes('getvariable'),
		`which creates the display node AND the value source (${drives.types.join(', ')})`
	);
	h.check(drives.element === 'score', `the display node is bound to the element (${drives.element})`);
	h.check(drives.role === 'drives', `and the list calls it a DRIVES binding (${drives.role})`);
	h.check(/score/.test(String(drives.source)), `naming its source (${drives.source})`);

	// and it really shows the value at runtime — the whole point
	const live = await page.evaluate(async () => {
		const s = window.__stores;
		s.gameState.setGameVar('score', 42);
		s.hudEditorClose.set(true);
		await new Promise((r) => setTimeout(r, 1400));
		return document.querySelector('#hud-layer [data-hud-id="score"] .hud-el')?.textContent?.trim();
	});
	h.check(live === '42', `and the HUD really shows the variable (${JSON.stringify(live)})`);

	// ---- 7. the artboard badge marks wired elements ------------------------
	const badge = await page.evaluate(async () => {
		const s = window.__stores;
		const wired = [...s.hudActions.wiredElementIds()];
		// add an UNWIRED element, so the badge has something to be absent from
		const sid = s.hudDocs.hudDocOf('scene').screens[0].id;
		const dead = s.hudDocs.addHudElement('scene', sid, { kind: 'button', label: 'Dead', anchor: 'bottom-left', x: 20, y: 20 });
		s.hudEditorClose.set(false);
		s.bottomDock.activateDock('hud');
		await new Promise((r) => setTimeout(r, 1600));
		return {
			wired,
			deadId: dead.id,
			badges: [...document.querySelectorAll('#hud-board [data-hud-item] .hud-wired')].length,
			deadHasBadge: !!document.querySelector(`#hud-board [data-hud-item="${dead.id}"] .hud-wired`),
			startHasBadge: !!document.querySelector('#hud-board [data-hud-item="start"] .hud-wired')
		};
	});
	h.check(
		badge.wired.includes('start') && badge.wired.includes('score'),
		`wiredElementIds names both wired elements (${JSON.stringify(badge.wired)})`
	);
	h.check(badge.startHasBadge, 'the artboard badges a wired element');
	h.check(!badge.deadHasBadge, 'and a dead button has NO badge, so it reads as dead at a glance');

	// ---- 8. the Actions section, in the real pane ---------------------------
	const pane = await page.evaluate(async () => {
		const item = document.querySelector('#hud-board [data-hud-item="start"]');
		item?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
		await new Promise((r) => setTimeout(r, 900));
		const dock = document.querySelector('#hud-dock');
		return {
			heads: [...(dock?.querySelectorAll('.hud-sec-head') ?? [])].map((s) => s.textContent?.trim()),
			rows: [...(dock?.querySelectorAll('.ha-row') ?? [])].map((r) => r.textContent?.replace(/\s+/g, ' ').trim()),
			hasAdd: !!dock?.querySelector('#hud-add-action')
		};
	});
	h.check(pane.heads.includes('Actions'), `the pane has an Actions section (${JSON.stringify(pane.heads)})`);
	h.check(pane.rows.length === 2, `listing both bindings (${pane.rows.length})`);
	h.check(
		pane.rows.every((r) => /On press/i.test(r)),
		`each labelled by its role (${JSON.stringify(pane.rows)})`
	);
	h.check(pane.hasAdd, 'with an Add action button');

	// the picker really opens and adds through the UI
	const throughUi = await page.evaluate(async () => {
		document.querySelector('#hud-add-action')?.click();
		await new Promise((r) => setTimeout(r, 700));
		const menuUp = !!document.querySelector('[role="menu"]');
		const rows = [...document.querySelectorAll('[role="menu"] *')]
			.filter((el) => el.children.length === 0)
			.map((el) => el.textContent?.trim());
		return { menuUp, hasGame: rows.some((r) => /Game/.test(String(r))) };
	});
	h.check(throughUi.menuUp, 'Add action opens the picker');
	h.check(throughUi.hasGame, 'grouped, with the Game actions in it');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);

	// ---- 9. UNBIND ---------------------------------------------------------
	const unbound = await page.evaluate(async () => {
		const s = window.__stores;
		const before = s.hudActions.bindingsFor('start');
		s.hudActions.removeBinding(before[0]);
		await new Promise((r) => setTimeout(r, 800));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		return {
			before: before.length,
			after: s.hudActions.bindingsFor('start').length,
			// the press node must SURVIVE, because the other action still needs it
			presses: g.scene.nodes.filter((n) => n.type === 'hudbutton').length
		};
	});
	h.check(unbound.after === unbound.before - 1, `unbind removes one binding (${unbound.before} -> ${unbound.after})`);
	h.check(unbound.presses === 1, 'and KEEPS the press node, because another action still uses it');

	// ---- 10. the deep link -------------------------------------------------
	const deepLink = await page.evaluate(async () => {
		const s = window.__stores;
		const binding = s.hudActions.bindingsFor('start')[0];
		// appStore is SPREAD onto the __stores root, so its exports are top-level
		await s.focusFlowNode(binding.actionNodeId);
		await new Promise((r) => setTimeout(r, 1200));
		let visible;
		s.bottomDock.visibleDockKey.subscribe((v) => (visible = v))();
		let pending;
		s.flowFocus.subscribe((v) => (pending = v))();
		return { visible, pending, flowOpen: !!document.querySelector('.svelte-flow') };
	});
	h.check(deepLink.visible === 'flow', `the deep link brings the node editor to the front (${deepLink.visible})`);
	h.check(deepLink.flowOpen, 'and the graph is on screen');
	h.check(
		deepLink.pending === null,
		`and the request was CLEARED after being acted on, so it cannot re-fire (${deepLink.pending})`
	);


	// ---- 11. a JUST-BUILT binding still fires (the 21-E6 stale-stamp guard) --
	// The game actions now refuse a trigger stamp OLDER than the node that would act on
	// it, because the trigger log is keyed by node id and outlives the node — wiring a
	// previously-pressed On Click into a fresh Set Game State used to start the game on
	// connect. addBinding is the one path that creates press node, action node and edge in
	// ONE entry, so it is exactly the case that guard must not break: the press comes
	// AFTER both nodes exist. Asserted here rather than reasoned about.
	const justBuilt = await page.evaluate(async () => {
		const s = window.__stores;
		// a clean slate: no graph, and a game parked at menu
		s.flowNodes.set([]);
		s.flowEdges.set([]);
		s.gameState.clearGameState();
		s.gameState.setGameState('menu');
		await new Promise((r) => setTimeout(r, 900));
		let before;
		s.gameState.gameState.subscribe((v) => (before = v))();
		// build the binding, then press the button the ordinary way
		const result = s.hudActions.addBinding('start', 'start');
		await new Promise((r) => setTimeout(r, 900));
		let mid;
		s.gameState.gameState.subscribe((v) => (mid = v))();
		const pressId = result.nodes.find((n) => n.type === 'hudbutton')?.id;
		s.flowRuntime.fireHudButton('start');
		await new Promise((r) => setTimeout(r, 1400));
		let after;
		s.gameState.gameState.subscribe((v) => (after = v))();
		return { ok: result.ok, before: before.state, mid: mid.state, after: after.state, pressId };
	});
	h.check(justBuilt.ok && !!justBuilt.pressId, 'premise: a fresh binding was built (press node + action node + edge)');
	h.check(justBuilt.before === 'menu', `premise: the game starts at menu (${justBuilt.before})`);
	h.check(
		justBuilt.mid === 'menu',
		`building the binding does NOT start the game by itself (${justBuilt.mid})`
	);
	h.check(
		justBuilt.after === 'playing',
		`and the FIRST press of a just-built button starts it — the guard refuses stale stamps, not new bindings (${justBuilt.after})`
	);

	// ---- 12. 21-E8: the GAME actions, and the CHAIN -------------------------
	// E4 shipped the logic and E6 the controller, so by now the pieces of "press this and
	// something happens in the scene" all exist - the catalog was the part that still sent
	// you to the node editor. Two things here are more than a longer list: a Counter reached
	// through `reset` is the OPPOSITE of one reached through `pulse` and the row has to say
	// so, and one verb (hide/show) is genuinely several nodes.
	const newKeys = await page.evaluate(() => {
		const HA = window.__stores.hudActions;
		return {
			button: HA.actionsForKind('button').map((a) => a.key),
			toggle: HA.actionsForKind('toggle').map((a) => a.key),
			// a display element must NOT be offered a press action (the PRESSABLE rule)
			text: HA.actionsForKind('text').map((a) => a.key),
			slider: HA.actionsForKind('slider').map((a) => a.key),
			groups: HA.actionGroupsForKind('button').map((g) => g.group)
		};
	});
	const WANT = ['playanim', 'sound', 'particles', 'impulse', 'resetcounter', 'togglevis'];
	h.check(
		WANT.every((k) => newKeys.button.includes(k)),
		`a button is offered every new action (missing: ${JSON.stringify(WANT.filter((k) => !newKeys.button.includes(k)))})`
	);
	h.check(
		WANT.every((k) => newKeys.toggle.includes(k)),
		"and so is a TOGGLE, which fires as well as holding a value"
	);
	h.check(
		!WANT.some((k) => newKeys.text.includes(k)) && !WANT.some((k) => newKeys.slider.includes(k)),
		`but NOT a readout or a slider - neither fires a press (${JSON.stringify(newKeys.text)} / ${JSON.stringify(newKeys.slider)})`
	);

	// three single-node actions on ONE button, and the handle each edge lands on
	await wipeGraphs([A, B]);
	const preWipe = await sceneNodes(A);
	h.check(preWipe.nodes.length === 0, `premise: a clean graph on both peers (${preWipe.nodes.length} nodes)`);
	const verbs = await page.evaluate(async () => {
		const s = window.__stores;
		const results = ['playanim', 'sound', 'resetcounter', 'count'].map((k) => ({ k, ok: s.hudActions.addBinding('start', k).ok }));
		await new Promise((r) => setTimeout(r, 900));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const byType = (t) => g.scene.nodes.filter((n) => n.type === t);
		const handleTo = (t) => {
			const ids = byType(t).map((n) => n.id);
			return g.scene.edges.filter((e) => ids.includes(e.target)).map((e) => e.targetHandle ?? null);
		};
		return {
			results,
			types: g.scene.nodes.map((n) => n.type),
			presses: byType('hudbutton').length,
			animHandles: handleTo('playanim'),
			soundHandles: handleTo('sound'),
			counterHandles: handleTo('counter').sort(),
			animAction: byType('playanim')[0]?.data?.action,
			labels: s.hudActions.bindingsFor('start').map((b) => b.label)
		};
	});
	h.check(verbs.results.every((r) => r.ok), `all four built (${JSON.stringify(verbs.results)})`);
	h.check(
		verbs.types.includes('playanim') && verbs.types.includes('sound'),
		`Play an animation and Play a sound created their nodes (${verbs.types.join(', ')})`
	);
	h.check(verbs.presses === 1, `all four SHARE one press node (${verbs.presses})`);
	h.check(
		JSON.stringify(verbs.animHandles) === '["trigger"]' && JSON.stringify(verbs.soundHandles) === '["trigger"]',
		`each wired to its own trigger handle (${JSON.stringify(verbs.animHandles)} / ${JSON.stringify(verbs.soundHandles)})`
	);
	h.check(verbs.animAction === 'toggle', `Play Animation defaults to toggle, which also CLOSES the door (${verbs.animAction})`);
	// the reason the handle is carried at all: two Counters on one button, one reset and
	// one counting, and the rows must not read the same
	h.check(
		verbs.counterHandles.length === 2 && verbs.counterHandles.includes('reset') && verbs.counterHandles.includes('pulse'),
		`Reset a counter lands on the RESET handle, Count the presses on pulse (${JSON.stringify(verbs.counterHandles)})`
	);
	h.check(
		verbs.labels.includes('Reset counter') && verbs.labels.includes('Count it'),
		`and the two rows say which is which (${JSON.stringify(verbs.labels)})`
	);

	// the CHAIN: three nodes and three wires from one menu entry, as ONE undo entry
	await wipeGraphs([A, B]);
	const chained = await page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1400));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const box = group.children[group.children.length - 1];
		// creating an object SELECTS it, which is exactly the state the chain reads
		s.objectActions.selectObject(box.uuid);
		// ...and it also points the editor scope at that object, so put it back on the scene
		// graph before writing to it (the char-controller scope-reset note)
		s.setActiveGraph(s.SCENE_GRAPH);
		await new Promise((r) => setTimeout(r, 500));
		const result = s.hudActions.addBinding('start', 'togglevis');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const node = (t) => g.scene.nodes.find((n) => n.type === t);
		const edgeInto = (t) => {
			const target = node(t);
			return g.scene.edges.find((e) => e.target === target?.id) ?? null;
		};
		return {
			ok: result.ok,
			uuid: box.uuid,
			types: g.scene.nodes.map((n) => n.type).sort(),
			nodes: g.scene.nodes.length,
			edges: g.scene.edges.length,
			latchHandle: edgeInto('latch')?.targetHandle ?? null,
			visHandle: edgeInto('visibility')?.targetHandle ?? null,
			selectorHandle: edgeInto('objectselector')?.targetHandle ?? null,
			selectorEdgeId: edgeInto('objectselector')?.id ?? '',
			latchEdgeId: edgeInto('latch')?.id ?? '',
			initial: node('latch')?.data?.initial,
			selected: node('objectselector')?.data?.selected,
			labels: s.hudActions.bindingsFor('start').map((b) => b.label)
		};
	});
	h.check(chained.ok, 'the chain action reports success');
	h.check(
		chained.nodes === 4 && chained.edges === 3,
		`one menu entry built FOUR nodes and THREE wires (${chained.nodes} / ${chained.edges})`
	);
	h.check(
		JSON.stringify(chained.types) === JSON.stringify(['hudbutton', 'latch', 'objectselector', 'visibility']),
		`press -> Latch -> Visibility -> Object Selector (${JSON.stringify(chained.types)})`
	);
	h.check(
		chained.latchHandle === 'toggle' && chained.visHandle === 'on' && chained.selectorHandle === null,
		`each hop on its own handle, and the selector on the UNNAMED one (${chained.latchHandle} / ${chained.visHandle} / ${chained.selectorHandle})`
	);
	// the edge-id format is what peer dedupe turns on, so a chain must not invent its own
	h.check(
		chained.latchEdgeId.endsWith('.toggle') && !chained.selectorEdgeId.includes('.'),
		`edge ids stay handle-qualified (${chained.latchEdgeId} / ${chained.selectorEdgeId})`
	);
	h.check(
		chained.initial === true,
		'the Latch starts ON, so ASSIGNING the action does not hide the object on the spot'
	);
	h.check(
		chained.selected === chained.uuid,
		`and the Object Selector names the CURRENT selection, not "-None-" (${chained.selected})`
	);
	h.check(
		chained.labels.some((l) => /Latch/.test(String(l))),
		`the pane describes it in words (${JSON.stringify(chained.labels)})`
	);

	// it replicated as ONE batch, and ONE undo takes the whole chain back
	await page.waitForTimeout(1600);
	const chainOnPeer = await sceneNodes(B);
	h.check(
		chainOnPeer.nodes.includes('latch') && chainOnPeer.nodes.includes('visibility') && chainOnPeer.edges === 3,
		`the peer received every node AND every wire (${chainOnPeer.nodes.join(', ')}, ${chainOnPeer.edges} edges)`
	);
	const chainUndo = await page.evaluate(async () => {
		const s = window.__stores;
		s.history.undo();
		await new Promise((r) => setTimeout(r, 900));
		let g;
		s.flowGraphs.subscribe((v) => (g = v))();
		const afterUndo = { nodes: g.scene.nodes.length, edges: g.scene.edges.length };
		s.history.redo();
		await new Promise((r) => setTimeout(r, 900));
		s.flowGraphs.subscribe((v) => (g = v))();
		return { afterUndo, redo: { nodes: g.scene.nodes.length, edges: g.scene.edges.length } };
	});
	h.check(
		chainUndo.afterUndo.nodes === 0 && chainUndo.afterUndo.edges === 0,
		`ONE undo removes the WHOLE chain (${chainUndo.afterUndo.nodes} nodes, ${chainUndo.afterUndo.edges} edges)`
	);
	h.check(
		chainUndo.redo.nodes === 4 && chainUndo.redo.edges === 3,
		`and redo puts all of it back (${chainUndo.redo.nodes} / ${chainUndo.redo.edges})`
	);

	h.check(h.pageErrors(A).length === 0, `no render crash on A (${JSON.stringify(h.pageErrors(A))})`);

	await h.finish(browser);
});

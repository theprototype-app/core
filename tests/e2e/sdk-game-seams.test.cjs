// R3a (roadmap 21-G round 3) — THE SDK GAME SEAMS: what the collectible MODULE stands on.
//
// Collectibles v3 is a module, so core's job shrank to seams: api.game (round reads +
// the shared variable pair), api.peerVars (owner-only rows), fireNodeTrigger's
// {replicate:false} (the per-player local pulse), api.playerPosition (the touch
// trigger's read), api.flow (graph reads, replicated node creation with ONE undo entry,
// the round-aware trigger-log read), the generalized `whilePlaying` dormancy for module
// effects, api.hud.registerDebugLine / registerAction, and selectObject/selectedUuids.
//
// Everything drives `moduleSDK.initModules` with an inline module — the REAL api path
// (makeApi runs, the teardown journal records), the module-node-io precedent.
//
// It also pins the MIGRATION: collectcount / the recipe / the dialog are GONE from core
// (they live in the collectible module now), and the debug element + action catalog
// read module registries instead.
//
// Run: $env:APP_URL='https://localhost:5183/'; PEER_CONFIG=...; npm run e2e -- sdk-game-seams
const h = require('./helpers.cjs');

const setPlay = (peer, state) => peer.page.evaluate((s) => window.__stores.isLocked.set(s), state);
const varOf = (peer, name) => peer.page.evaluate((n) => window.__stores.gameState.gameVar(n, 0), name);
const gstate = (peer, state) =>
	peer.page.evaluate((s) => window.__stores.gameState.setGameState(s), state);

const wipe = async (peers) => {
	for (const p of peers)
		await p.page.evaluate(() => {
			window.__stores.clearGraphs();
			window.__stores.gameState.clearGameState();
			window.__stores.peerVars.clearPeerVars(false);
			window.__stores.isLocked.set(null);
		});
	await peers[0].page.waitForTimeout(900);
};

const makeBox = (peer) =>
	peer.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 1100));
		let group;
		s.objectsGroup.subscribe((v) => (group = v))();
		const uuid = group.children[group.children.length - 1].uuid;
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		return uuid;
	});

/** The inline module: an event node (the collectible shape), an effect that HIDES its
 * target while its own trigger reads collected, a value node reading its ctx, plus the
 * debug line and the catalog action. */
const installSeamsModule = (peer) =>
	peer.page.evaluate(async () => {
		window.__seams = { effectCtx: null, valueCtx: null, apis: null };
		const s = window.__stores;
		await s.moduleSDK.initModules([
			{
				id: 'seams',
				name: 'Seams test',
				version: '1.0.0',
				description: 'proves the R3a seams',
				register(api) {
					window.__seams.api = api;
					// the collectible shape: an EFFECT node that hides its target while its
					// own trigger-log entry reads collected (ctx.trigger, round-aware)
					api.registerEffect(
						'seamcollect',
						(object, base, data, time, ctx) => {
							window.__seams.effectCtx = ctx ? { id: ctx.id, trigger: ctx.trigger } : null;
							if (data.hide !== false && ctx?.trigger) object.visible = false;
						},
						{}
					);
					// a VALUE node that reports its ctx — the module-collectcount read path
					api.registerValueNode('seamvalue', (data, time, ctx) => {
						window.__seams.valueCtx = { id: ctx?.id, trigger: ctx?.trigger ?? null };
						return ctx?.trigger ? 1 : 0;
					});
					api.registerNodeGroup({
						group: 'Seams',
						items: [
							{ type: 'seamcollect', label: 'Seam Collect', defaults: {} },
							{ type: 'seamvalue', label: 'Seam Value', defaults: {} }
						]
					});
					api.hud.registerDebugLine(() => 'seams: line-alive');
					api.hud.registerAction({
						key: 'showseam',
						label: 'Show the seam value',
						group: 'Data',
						role: 'drives',
						node: '',
						via: { node: 'seamvalue', data: {}, handle: 'value' },
						hint: 'module-supplied'
					});
				}
			}
		]);
		return true;
	});

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	for (const p of [A, B]) await p.page.waitForFunction(() => !!window.__stores?.moduleSDK, { timeout: 30000 });
	await h.connect(A, B);
	await wipe([A, B]);
	await installSeamsModule(A);
	await installSeamsModule(B);

	// =====================================================================
	// 0. THE MIGRATION IS REAL: the recipe, the dialog and collectcount are gone
	// =====================================================================
	const gone = await A.page.evaluate(() => {
		const s = window.__stores;
		let cat;
		const groups = s.nodeCatalog.nodeCatalog ?? [];
		cat = groups.some((g) => (g.items ?? []).some((i) => i.type === 'collectcount'));
		return {
			recipe: !!s.gameRecipes,
			dialog: !!s.recipeDialog,
			collectcountInCatalog: cat,
			collectcountSpec: !!s.nodeCatalog.findNodeSpec('collectcount'),
			countsFor: typeof s.flowRuntime.collectibleCountsFor === 'function',
			showleft: (s.hudActions.actionsForKind('text') ?? []).some((a) => a.key === 'showleft')
		};
	});
	h.check(!gone.recipe && !gone.dialog, 'gameRecipes + recipeDialog are gone from core');
	h.check(!gone.collectcountInCatalog && !gone.collectcountSpec, 'collectcount left the catalog');
	h.check(!gone.countsFor, 'collectibleCountsFor left flowRuntime');
	h.check(!gone.showleft, 'the showleft catalog entry left hudActions');

	// =====================================================================
	// 1. api.game — round reads + the shared variable pair (replicates)
	// =====================================================================
	const g0 = await A.page.evaluate(() => ({
		cutoff: window.__seams.api.game.roundCutoff(),
		underway: window.__seams.api.game.roundUnderway(),
		playActive: window.__seams.api.game.playActive()
	}));
	// shell unused: cutoff null, and roundUnderway TRUE by design — a scene that never
	// used the game shell must not have its round-scoped content gated (gameState's rule)
	h.check(g0.cutoff === null && g0.underway === true, `shell unused: cutoff null, underway defaults open (${JSON.stringify(g0)})`);
	await gstate(A, 'playing');
	await A.page.waitForTimeout(700);
	const g1 = await Promise.all(
		[A, B].map((p) =>
			p.page.evaluate(() => ({
				cutoff: window.__seams.api.game.roundCutoff(),
				underway: window.__seams.api.game.roundUnderway(),
				playActive: window.__seams.api.game.playActive()
			}))
		)
	);
	h.check(
		g1.every((g) => Number.isFinite(g.cutoff) && g.underway),
		`a running round reads finite + underway on BOTH peers (${JSON.stringify(g1)})`
	);
	h.check(!g1[0].playActive, 'playActive stays false in the editor even mid-round (the local half)');
	await setPlay(A, true);
	await A.page.waitForTimeout(300);
	h.check(
		await A.page.evaluate(() => window.__seams.api.game.playActive()),
		'playActive turns true once THIS peer plays inside the round'
	);
	await setPlay(A, null);
	await A.page.evaluate(() => window.__seams.api.game.setVar('score', 7));
	await A.page.waitForTimeout(700);
	h.check((await varOf(B, 'score')) === 7, `api.game.setVar replicates (B reads ${await varOf(B, 'score')})`);
	h.check(
		(await B.page.evaluate(() => window.__seams.api.game.getVar('score', 0))) === 7,
		'api.game.getVar reads the shared singleton'
	);
	await gstate(A, 'menu');
	await A.page.waitForTimeout(700);
	const g2 = await A.page.evaluate(() => ({
		cutoff: window.__seams.api.game.roundCutoff(),
		underway: window.__seams.api.game.roundUnderway()
	}));
	h.check(g2.cutoff === Infinity || g2.cutoff === null || g2.cutoff > 1e15 || g2.cutoff === Number.POSITIVE_INFINITY, `menu reads Infinity (${g2.cutoff})`);
	h.check(!g2.underway, 'and no round underway');

	// =====================================================================
	// 2. api.peerVars — one writer per row, converging rows, leaderboard shape
	// =====================================================================
	await A.page.evaluate(() => window.__seams.api.peerVars.setMine('laps', 3));
	await B.page.evaluate(() => window.__seams.api.peerVars.setMine('laps', 5));
	await A.page.waitForTimeout(900);
	const mineA = await A.page.evaluate(() => window.__seams.api.peerVars.mine('laps', 0));
	const mineB = await B.page.evaluate(() => window.__seams.api.peerVars.mine('laps', 0));
	h.check(mineA === 3 && mineB === 5, `each peer reads its OWN row (A=${mineA}, B=${mineB})`);
	const rows = await Promise.all(
		[A, B].map((p) => p.page.evaluate(() => window.__seams.api.peerVars.all('laps').map((r) => r.value)))
	);
	h.check(
		JSON.stringify(rows[0]) === JSON.stringify(rows[1]) && rows[0].length === 2,
		`all('laps') converges to the same two ordered rows on both screens (${JSON.stringify(rows)})`
	);
	h.check(
		rows[0][0] === 5 && rows[0][1] === 3,
		`desc by default, 5 before 3 (${JSON.stringify(rows[0])})`
	);

	// =====================================================================
	// 3. fireNodeTrigger {replicate:false} — the per-player local pulse
	// =====================================================================
	// one module event node in the scene graph, on both peers via replication
	const evIds = await A.page.evaluate(() =>
		window.__seams.api.flow.addNodes({ nodes: [{ type: 'seamvalue', x: 60, y: 60, data: {} }] })
	);
	await A.page.waitForTimeout(900);
	const evId = evIds[0];
	h.check(!!evId, 'premise: a module node created through api.flow.addNodes');
	const onB = await B.page.evaluate(
		(id) => window.__seams.api.flow.nodes('seamvalue').some((n) => n.id === id),
		evId
	);
	h.check(onB, 'and it replicated to the peer (nodecreate)');
	await A.page.evaluate(() => window.__seams.api.fireNodeTrigger('seamvalue', undefined, { replicate: false }));
	await A.page.waitForTimeout(800);
	const stampA = await A.page.evaluate((id) => window.__seams.api.flow.triggerStamp(id), evId);
	const stampB = await B.page.evaluate((id) => window.__seams.api.flow.triggerStamp(id), evId);
	h.check(!!stampA && typeof stampA.stamp === 'number' && typeof stampA.age === 'number', `the local pulse stamped MY log ({stamp, age} = ${JSON.stringify(stampA)})`);
	h.check(stampB === null, 'and never reached the peer — the per-player mechanism in one bit');
	await A.page.evaluate(() => window.__seams.api.fireNodeTrigger('seamvalue'));
	await A.page.waitForTimeout(800);
	const stampB2 = await B.page.evaluate((id) => window.__seams.api.flow.triggerStamp(id), evId);
	h.check(!!stampB2, 'a default fire still replicates, exactly as before');

	// the value node saw its round-aware trigger through ctx
	const vctx = await A.page.evaluate(() => window.__seams.valueCtx);
	h.check(vctx && vctx.id === evId && vctx.trigger && typeof vctx.trigger.stamp === 'number', `the value node's ctx carries its own {stamp, age} (${JSON.stringify(vctx)})`);

	// =====================================================================
	// 4. perRound retirement through the SAME read (the pull rule, F2's)
	// =====================================================================
	await A.page.evaluate((id) => window.__seams.api.flow.setNodeData(id, { perRound: true }), evId);
	await A.page.waitForTimeout(600);
	await gstate(A, 'menu'); // already menu — make sure, then check the read retires
	await A.page.waitForTimeout(600);
	const retired = await A.page.evaluate((id) => window.__seams.api.flow.triggerStamp(id), evId);
	h.check(retired === null, 'a perRound node in menu reads null — Infinity retires the read (the locked fork)');
	const dataOnB = await B.page.evaluate(
		(id) => window.__seams.api.flow.nodes('seamvalue').find((n) => n.id === id)?.data?.perRound,
		evId
	);
	h.check(dataOnB === true, 'setNodeData replicated the perRound patch (the nodedata path)');

	// =====================================================================
	// 5. api.flow.addNodes — one undo entry, canonical edge ids, spec defaults
	// =====================================================================
	const box = await makeBox(A);
	await A.page.waitForTimeout(600);
	const chain = await A.page.evaluate(
		(uuid) =>
			window.__seams.api.flow.addNodes({
				nodes: [
					{ type: 'seamcollect', x: 60, y: 400, data: { whilePlaying: true, perRound: true } },
					{ type: 'objectselector', x: 280, y: 400, data: { selected: uuid } }
				],
				edges: [{ from: 0, to: 1 }]
			}),
		box
	);
	await A.page.waitForTimeout(900);
	h.check(chain.length === 2, 'a two-node chain created in one call');
	const edgeShape = await A.page.evaluate(
		(ids) => window.__seams.api.flow.edges().find((e) => e.source === ids[0] && e.target === ids[1])?.id,
		chain
	);
	h.check(edgeShape === 'e-' + chain[0] + '-' + chain[1], `the edge id is the editor's canonical shape (${edgeShape})`);
	const selectorDefaultKept = await A.page.evaluate(
		(ids) => window.__seams.api.flow.nodes('objectselector').find((n) => n.id === ids[1])?.data?.label,
		chain
	);
	h.check(typeof selectorDefaultKept === 'string' && selectorDefaultKept.length > 0, `core spec label/defaults seeded the data (${selectorDefaultKept})`);
	// ONE undo entry: a single undo removes both nodes (assert the PROPERTY, not depth)
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(900);
	const afterUndo = await A.page.evaluate(
		(ids) => window.__seams.api.flow.nodes().filter((n) => ids.includes(n.id)).length,
		chain
	);
	h.check(afterUndo === 0, 'ONE undo removes the whole batch (one flownodes entry)');
	await A.page.evaluate(() => window.__stores.history.redo());
	await A.page.waitForTimeout(900);
	const afterRedo = await A.page.evaluate(
		(ids) => window.__seams.api.flow.nodes().filter((n) => ids.includes(n.id)).length,
		chain
	);
	h.check(afterRedo === 2, 'and one redo restores it');

	// =====================================================================
	// 6. the generalized whilePlaying dormancy — a MODULE effect stands down
	// =====================================================================
	// fire the module node so it reads collected, in play, inside a round
	await gstate(A, 'playing');
	await setPlay(A, true);
	await A.page.waitForTimeout(500);
	await A.page.evaluate(() => window.__seams.api.fireNodeTrigger('seamcollect'));
	await A.page.waitForTimeout(900);
	const hiddenInPlay = await A.page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return group?.getObjectByProperty('uuid', uuid)?.visible;
	}, box);
	h.check(hiddenInPlay === false, 'the module effect hides its target while playing in a round');
	const ectx = await A.page.evaluate(() => window.__seams.effectCtx);
	h.check(ectx && ectx.trigger && typeof ectx.trigger.age === 'number', `the effect ctx carried {stamp, age} (${JSON.stringify(ectx)})`);
	// Esc — the node is whilePlaying, so the restore loop hands the object back and FORGETS it
	await setPlay(A, false);
	await A.page.waitForTimeout(400);
	await setPlay(A, null);
	await A.page.waitForTimeout(1200);
	const back = await A.page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		const o = group?.getObjectByProperty('uuid', uuid);
		// manual hide must WIN now (the restore loop forgot the object)
		if (o) o.visible = false;
		return o?.visible;
	}, box);
	await A.page.waitForTimeout(900);
	const manualWins = await A.page.evaluate((uuid) => {
		let group;
		window.__stores.objectsGroup.subscribe((v) => (group = v))();
		return group?.getObjectByProperty('uuid', uuid)?.visible;
	}, box);
	h.check(back === false && manualWins === false, 'outside play the effect stands down and manual visibility wins (the F2 rule, module edition)');
	await gstate(A, 'menu');

	// =====================================================================
	// 7. api.playerPosition + selectObject/selectedUuids
	// =====================================================================
	const pos = await A.page.evaluate(() => window.__seams.api.playerPosition());
	h.check(
		Array.isArray(pos) && pos.length === 3 && pos.every((v) => Number.isFinite(v)),
		`playerPosition is a finite [x, y, z] (${JSON.stringify(pos)})`
	);
	await A.page.evaluate((uuid) => window.__seams.api.selectObject(uuid), box);
	await A.page.waitForTimeout(500);
	const sel = await A.page.evaluate(() => window.__seams.api.selectedUuids());
	h.check(sel.includes(box), `selectObject landed in the selection SET (${JSON.stringify(sel)})`);
	await A.page.evaluate(() => window.__stores.objectActions.deselectObject());
	await A.page.waitForTimeout(300);
	h.check(
		(await A.page.evaluate(() => window.__seams.api.selectedUuids())).length === 0,
		'selectedUuids reads the SET, so a deselect empties it (never the sticky primary)'
	);

	// =====================================================================
	// 8. the debug line + the action catalog seams, and their teardown
	// =====================================================================
	const hudSeams = await A.page.evaluate(() => {
		const s = window.__stores;
		return {
			lines: s.moduleHudKinds.moduleDebugLineTexts(),
			offered: s.hudActions.actionsForKind('text').map((a) => a.key)
		};
	});
	h.check(hudSeams.lines.includes('seams: line-alive'), `registerDebugLine feeds the debug pill (${JSON.stringify(hudSeams.lines)})`);
	h.check(hudSeams.offered.includes('mod-seams-showseam'), `registerAction lands in the catalog, namespaced (${JSON.stringify(hudSeams.offered.filter((k) => k.startsWith('mod-')))})`);
	// bind it for real — addBinding must resolve a module key and build the via node
	const bound = await A.page.evaluate(() => window.__stores.hudActions.addBinding('seam-el', 'mod-seams-showseam'));
	h.check(bound.ok && bound.nodes.some((n) => n.type === 'seamvalue'), `addBinding builds a module via-node (${JSON.stringify(bound.nodes.map((n) => n.type))})`);
	// teardown: deactivate removes BOTH registries through the journal
	await A.page.evaluate(() => window.__stores.moduleSDK.deactivateModule('seams'));
	await A.page.waitForTimeout(400);
	const afterOff = await A.page.evaluate(() => {
		const s = window.__stores;
		return {
			lines: s.moduleHudKinds.moduleDebugLineTexts(),
			offered: s.hudActions.actionsForKind('text').map((a) => a.key)
		};
	});
	h.check(!afterOff.lines.includes('seams: line-alive'), 'deactivate removes the debug line (journal)');
	h.check(!afterOff.offered.includes('mod-seams-showseam'), 'and the catalog entry');

	await h.finish(browser);
});

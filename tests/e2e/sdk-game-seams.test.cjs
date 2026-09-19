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
	// 4b. R29 S3: a module's setNodeData is ONE undo step, attributed to the module
	// =====================================================================
	const dataOf = (peer, id) =>
		peer.page.evaluate((i) => {
			const n = window.__seams.api.flow.nodes().find((x) => x.id === i);
			return n ? { perRound: n.data.perRound, tag: n.data.tag ?? null } : null;
		}, id);
	const depthOf = (peer) =>
		peer.page.evaluate(() => {
			let v;
			window.__stores.history.undoStack.subscribe((x) => (v = x))();
			return v.length;
		});
	const depth0 = await depthOf(A);
	await A.page.evaluate((id) => window.__seams.api.flow.setNodeData(id, { perRound: false, tag: 's3' }), evId);
	await A.page.waitForTimeout(600);
	const top = await A.page.evaluate(() => {
		let v;
		window.__stores.history.undoStack.subscribe((x) => (v = x))();
		const e = v[v.length - 1];
		return { depth: v.length, kind: e?.kind, op: e?.op, moduleId: e?.moduleId, items: e?.items?.length };
	});
	h.check(top.depth === depth0 + 1 && top.kind === 'flownodes' && top.op === 'data', `setNodeData records ONE flownodes data entry (${depth0} -> ${top.depth}, ${top.kind}/${top.op})`);
	h.check(top.moduleId === 'seams', `the entry is attributed to the module (${top.moduleId})`);
	const edited = [await dataOf(A, evId), await dataOf(B, evId)];
	h.check(edited.every((d) => d && d.perRound === false && d.tag === 's3'), `premise: the write landed on both peers (${JSON.stringify(edited)})`);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(800);
	const undone = [await dataOf(A, evId), await dataOf(B, evId)];
	h.check(undone.every((d) => d && d.perRound === true && !d.tag), `one undo restores the node's previous data, on BOTH peers (${JSON.stringify(undone)})`);
	await A.page.evaluate(() => window.__stores.history.redo());
	await A.page.waitForTimeout(800);
	const redone = [await dataOf(A, evId), await dataOf(B, evId)];
	h.check(redone.every((d) => d && d.perRound === false && d.tag === 's3'), `and one redo re-applies it everywhere (${JSON.stringify(redone)})`);
	await A.page.evaluate((id) => window.__seams.api.flow.setNodeData(id, { perRound: true }), evId);
	await A.page.waitForTimeout(400);
	const missing = await A.page.evaluate(() => window.__seams.api.flow.setNodeData('no-such-node', { x: 1 }));
	h.check(missing === false, 'an unknown id still returns false (and records nothing)');

	// =====================================================================
	// 4c. R29 S3: setNodesData — a group edit across graphs is ONE undo step
	// =====================================================================
	const obox = await makeBox(A);
	await A.page.waitForTimeout(600);
	const grpScene = await A.page.evaluate(() =>
		window.__seams.api.flow.addNodes({ nodes: Array.from({ length: 6 }, (_, i) => ({ type: 'seamvalue', x: 700 + i * 20, y: 700, data: {} })) })
	);
	const grpObj = await A.page.evaluate(
		(g) => window.__seams.api.flow.addNodes({ graphId: g, nodes: Array.from({ length: 6 }, (_, i) => ({ type: 'seamvalue', x: 60 + i * 20, y: 60, data: {} })) }),
		obox
	);
	await A.page.waitForTimeout(900);
	const grp = [...grpScene, ...grpObj];
	const tagsOf = (peer) =>
		peer.page.evaluate((ids) => {
			const nodes = window.__seams.api.flow.nodes();
			return ids.map((i) => nodes.find((n) => n.id === i)?.data?.tag ?? null);
		}, grp);
	const gDepth0 = await depthOf(A);
	const written = await A.page.evaluate(
		(ids) =>
			window.__seams.api.flow.setNodesData([
				...ids.map((id) => ({ id, patch: { tag: 'grp' } })),
				{ id: 'no-such-node', patch: { tag: 'x' } },
				null,
				// the SAME node twice in one batch: undo must still land on its original value
				{ id: ids[0], patch: { tag: 'twice' } }
			]),
		grp
	);
	await A.page.waitForTimeout(900);
	const gTop = await A.page.evaluate(() => {
		let v;
		window.__stores.history.undoStack.subscribe((x) => (v = x))();
		const e = v[v.length - 1];
		return { depth: v.length, items: e?.items?.length, graphs: [...new Set((e?.items ?? []).map((i) => i.graphId))].length, moduleId: e?.moduleId };
	});
	h.check(written === 13, `setNodesData writes every known node, skips the unknown and the null (${written})`);
	h.check(gTop.depth === gDepth0 + 1 && gTop.items === 13, `and records ONE entry for the whole batch (${gDepth0} -> ${gTop.depth}, ${gTop.items} items)`);
	h.check(gTop.graphs === 2 && gTop.moduleId === 'seams', `the one entry spans both graphs, attributed (${gTop.graphs} graphs, ${gTop.moduleId})`);
	const gAfter = [await tagsOf(A), await tagsOf(B)];
	const wantAfter = JSON.stringify(['twice', ...grp.slice(1).map(() => 'grp')]);
	h.check(gAfter.every((t) => JSON.stringify(t) === wantAfter), `the batch replicated over the ordinary nodedata path (${JSON.stringify(gAfter[1])})`);
	await A.page.evaluate(() => window.__stores.history.undo());
	await A.page.waitForTimeout(900);
	const gUndo = [await tagsOf(A), await tagsOf(B)];
	h.check(gUndo.every((t) => t.every((x) => x === null)), `ONE undo restores all twelve, on both peers, incl. the node written twice (${JSON.stringify(gUndo[1])})`);
	await A.page.evaluate(() => window.__stores.history.redo());
	await A.page.waitForTimeout(900);
	const gRedo = [await tagsOf(A), await tagsOf(B)];
	h.check(gRedo.every((t) => JSON.stringify(t) === wantAfter), `and one redo re-applies the batch in order (${JSON.stringify(gRedo[0])})`);
	const emptyWrite = await A.page.evaluate(() => window.__seams.api.flow.setNodesData([]));
	const gDepth2 = await depthOf(A);
	h.check(emptyWrite === 0 && gDepth2 === gTop.depth, `an empty batch writes nothing and records nothing (${emptyWrite}, depth ${gDepth2})`);

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
	// 7b. R29 S1 — node POSITIONS come back, and api.flow.freeRegion keeps two
	//     recipes in a row off each other and off the user's own nodes
	// =====================================================================
	await wipe([A, B]);
	const placed = await A.page.evaluate(() =>
		window.__seams.api.flow.addNodes({ nodes: [{ type: 'seamvalue', x: 123, y: 456, data: {} }] })
	);
	await A.page.waitForTimeout(700);
	const snap = await Promise.all(
		[A, B].map((p) => p.page.evaluate((id) => window.__seams.api.flow.nodes().find((n) => n.id === id), placed[0]))
	);
	h.check(
		snap.every((n) => n && n.x === 123 && n.y === 456),
		`api.flow.nodes() snapshots carry x/y, on both peers (${JSON.stringify(snap.map((n) => n && [n.x, n.y]))})`
	);
	// a "user" node dragged somewhere a fixed-row layout would collide with
	await A.page.evaluate(() =>
		window.__seams.api.flow.addNodes({ nodes: [{ type: 'seamvalue', x: 60, y: 700, data: {} }] })
	);
	/** run one two-node recipe at whatever freeRegion answers; return its ids */
	const recipe = (peer) =>
		peer.page.evaluate(() => {
			const api = window.__seams.api;
			const at = api.flow.freeRegion({ w: 370, h: 150 });
			return api.flow.addNodes({
				nodes: [
					{ type: 'seamvalue', x: at.x, y: at.y, data: {} },
					{ type: 'seamcollect', x: at.x + 220, y: at.y, data: {} }
				],
				edges: [{ from: 1, to: 0 }]
			});
		});
	const r1 = await recipe(A);
	const r2 = await recipe(A);
	await A.page.waitForTimeout(600);
	/** every pair of 150x150 cards that overlap, over the scene graph */
	const overlapsOf = (peer) =>
		peer.page.evaluate(() => {
			const ns = window.__seams.api.flow.nodes().filter((n) => n.graphId === 'scene');
			const hits = [];
			for (let i = 0; i < ns.length; i++)
				for (let j = i + 1; j < ns.length; j++) {
					const a = ns[i], b = ns[j];
					if (a.x < b.x + 150 && b.x < a.x + 150 && a.y < b.y + 150 && b.y < a.y + 150) hits.push([a.id, b.id]);
				}
			return { n: ns.length, hits };
		});
	const ov = await overlapsOf(A);
	h.check(r1.length === 2 && r2.length === 2 && ov.n === 6, `premise: two recipes built beside two nodes (${ov.n} nodes)`);
	h.check(ov.hits.length === 0, `two recipes in a row land on nothing — no overlapping cards (${JSON.stringify(ov.hits)})`);
	const ys = await A.page.evaluate(
		(ids) => ids.map((id) => window.__seams.api.flow.nodes().find((n) => n.id === id)?.y),
		[r1[0], r2[0]]
	);
	h.check(ys[0] > 700 && ys[1] > ys[0], `each block lands BELOW everything before it (${JSON.stringify(ys)})`);
	// the detector is live: a recipe at a CONSTANT point (what freeRegion used to be
	// hand-rolled as) is caught — proves the check above cannot pass vacuously
	await A.page.evaluate(() =>
		window.__seams.api.flow.addNodes({ nodes: [{ type: 'seamvalue', x: 60, y: 700, data: {} }] })
	);
	const ovBad = await overlapsOf(A);
	h.check(ovBad.hits.length > 0, `and a constant-placed block IS detected as an overlap (${ovBad.hits.length})`);
	const scoped = await A.page.evaluate(() => window.__seams.api.flow.freeRegion({ graphId: 'no-such-graph' }));
	h.check(scoped.x === 40 && scoped.y === 40, `an empty/unknown graph answers the margin (${JSON.stringify(scoped)})`);

	// =====================================================================
	// 7c. R29 S2 — onChange: fires on a node edit, a game-state change and a peer-var
	//     write; COALESCED (one call per burst, nothing while idle); torn down in §8
	// =====================================================================
	await wipe([A, B]);
	for (const p of [A, B])
		await p.page.evaluate(() => {
			const api = window.__seams.api;
			const c = (window.__seamCounts = { flow: 0, game: 0, peer: 0 });
			api.flow.onChange(() => c.flow++);
			api.game.onChange(() => c.game++);
			api.peerVars.onChange(() => c.peer++);
			// a toolbox-style subscriber that unmounts early: the returned off must stop it
			c.early = 0;
			const off = api.flow.onChange(() => c.early++);
			window.__seamEarlyOff = off;
		});
	const counts = (peer) => peer.page.evaluate(() => ({ ...window.__seamCounts }));
	const frames = (peer, n) =>
		peer.page.evaluate(
			(n) => new Promise((r) => {
				let i = 0;
				const step = () => (++i >= n ? r(i) : requestAnimationFrame(step));
				requestAnimationFrame(step);
			}),
			n
		);
	// idle: sixty frames with the flow runtime ticking, a clock running, nothing edited
	await A.page.evaluate(() => window.__seams.api.flow.addNodes({ nodes: [{ type: 'time', x: 60, y: 60, data: {} }] }));
	await A.page.waitForTimeout(800);
	const idle0 = await counts(A);
	await frames(A, 60);
	const idle1 = await counts(A);
	h.check(
		idle1.flow === idle0.flow && idle1.game === idle0.game && idle1.peer === idle0.peer,
		`NOT once per frame: 60 idle frames fire nothing (${JSON.stringify(idle0)} -> ${JSON.stringify(idle1)})`
	);
	// a node edit fires it, locally AND on the peer the edit arrives at
	const bumpIds = await A.page.evaluate(() =>
		window.__seams.api.flow.addNodes({
			nodes: Array.from({ length: 30 }, (_, i) => ({ type: 'seamvalue', x: 400 + i * 10, y: 60, data: {} }))
		})
	);
	await A.page.waitForTimeout(900);
	const e0 = [await counts(A), await counts(B)];
	// ONE burst: thirty node edits in one synchronous gesture (a toolbox bulk edit)
	const ticks = await A.page.evaluate((ids) => {
		const s = window.__stores;
		let n = 0;
		const off = s.flowGraphs.subscribe(() => n++);
		n = 0;
		for (const id of ids) window.__seams.api.flow.setNodeData(id, { tag: 'bulk' });
		off();
		return n;
	}, bumpIds);
	await A.page.waitForTimeout(900);
	const e1 = [await counts(A), await counts(B)];
	h.check(ticks >= 30, `premise: the bulk edit is ${ticks} store ticks`);
	h.check(e1[0].flow - e0[0].flow === 1, `a ${ticks}-tick bulk edit runs the flow handler ONCE (${e1[0].flow - e0[0].flow})`);
	h.check(e1[1].flow > e0[1].flow, `and the peer's handler fires as the edits ARRIVE (+${e1[1].flow - e0[1].flow})`);
	h.check(e1[0].early - e0[0].early === 1, `premise: the early subscriber saw the burst too (+${e1[0].early - e0[0].early})`);
	await A.page.evaluate(() => window.__seamEarlyOff());
	await A.page.evaluate((id) => window.__seams.api.flow.setNodeData(id, { tag: 'after-off' }), bumpIds[0]);
	await A.page.waitForTimeout(400);
	const e2 = await counts(A);
	h.check(e2.early === e1[0].early && e2.flow === e1[0].flow + 1, `the returned off() stops ONE subscriber and leaves the rest (${e2.early}, flow +${e2.flow - e1[0].flow})`);
	h.check(e1[1].flow - e0[1].flow < ticks, `arriving edits are coalesced too, not one per message (+${e1[1].flow - e0[1].flow} for ${ticks})`);
	// a node FIRING is a flow change too (the trigger log) — what a collected-state list needs
	const f0 = await counts(A);
	await A.page.evaluate(() => window.__seams.api.fireNodeTrigger('seamvalue', undefined, { replicate: false }));
	await A.page.waitForTimeout(400);
	const f1 = await counts(A);
	h.check(f1.flow - f0.flow === 1, `a node firing runs the flow handler once (+${f1.flow - f0.flow})`);
	// game state: a transition fires it on both peers; a variable burst is one call
	const g0c = await counts(A);
	await gstate(A, 'playing');
	await A.page.waitForTimeout(700);
	const g1c = [await counts(A), await counts(B)];
	h.check(g1c[0].game > g0c.game, `a game-state change fires api.game.onChange (+${g1c[0].game - g0c.game})`);
	h.check(g1c[1].game > 0, `and on the peer, from the replicated singleton (${g1c[1].game})`);
	await A.page.evaluate(() => {
		for (let i = 0; i < 20; i++) window.__seams.api.game.setVar('burst', i);
	});
	await A.page.waitForTimeout(400);
	const g2c = await counts(A);
	h.check(g2c.game - g1c[0].game === 1, `twenty setVar calls in one burst = ONE game handler call (${g2c.game - g1c[0].game})`);
	await gstate(A, 'menu');
	// peer vars: my write fires mine; the peer's write fires mine as it arrives
	const p0 = [await counts(A), await counts(B)];
	await A.page.evaluate(() => window.__seams.api.peerVars.setMine('laps', 9));
	await A.page.waitForTimeout(900);
	const p1 = [await counts(A), await counts(B)];
	h.check(p1[0].peer > p0[0].peer, `a peer-var write fires my handler (+${p1[0].peer - p0[0].peer})`);
	h.check(p1[1].peer > p0[1].peer, `and the OTHER peer's, as the row arrives (+${p1[1].peer - p0[1].peer})`);

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
	// R29 S2: the three onChange subscriptions went with the journal
	const off0 = await counts(A);
	await A.page.evaluate(() => {
		const s = window.__stores;
		s.gameState.setGameVar('after', 1);
		s.peerVars.setPeerVar('after', 1);
		s.flowGraphs.update((g) => ({ ...g }));
	});
	await A.page.waitForTimeout(400);
	const off1 = await counts(A);
	h.check(
		JSON.stringify(off0) === JSON.stringify(off1),
		`deactivate unsubscribes every onChange (${JSON.stringify(off0)} -> ${JSON.stringify(off1)})`
	);

	await h.finish(browser);
});

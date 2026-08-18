// #20 P1 — a duplicate carries what BELONGS to the object.
//
// Geometry, transform, children, material and userData already came along; the
// three things keyed by uuid in their OWN stores did not, so a clone simply had
// none of them: its animation clips, its object flow graph, and (found after the
// shader lane merged, which the plan predates) its shader graph.
//
// The shader case is the nastiest of the three because it does not LOOK broken:
// `detachMaterials` hands the clone a copy of the COMPILED ShaderMaterial, so the
// copy renders — frozen, with nothing ticking its uniforms and nothing for the
// Inspector to edit. Asserting the document is the only way to see it.
//
// Deliberately NOT asserted as "one more undo entry": the copies record no history
// of their own. The object's create entry owns the copy's lifecycle, and a second
// entry would make one Ctrl+Z strip the clips off an object that stayed. Section 4
// asserts that property directly.
const h = require('./helpers.cjs');

/** Seed one box with all three carriers. Returns its uuid. */
const SEED = async () => {
	const w = window.__stores;
	w.commandsHandler.sceneCommand('/create box 1 1 1');
	await new Promise((r) => setTimeout(r, 900));
	let g;
	w.objectsGroup.subscribe((v) => (g = v))();
	const object = g.children[g.children.length - 1];
	const uuid = object.uuid;

	// (a) an animation clip
	w.animationPreview.addTrack(uuid, 'pos.y', object);

	// (b) an object flow graph with two nodes and a wire between them
	w.flowGraphsCtl.createObjectGraph(uuid);
	const n1 = { id: crypto.randomUUID(), type: 'time', position: { x: 40, y: 40 }, data: {} };
	const n2 = { id: crypto.randomUUID(), type: 'number', position: { x: 240, y: 40 }, data: { value: 2 } };
	w.nodesHandler.createFlowNode(n1, uuid);
	w.nodesHandler.createFlowNode(n2, uuid);
	w.nodesHandler.createFlowEdge(
		{ id: 'e-' + n1.id + '.out-' + n2.id + '.a', source: n1.id, target: n2.id, sourceHandle: 'out', targetHandle: 'a' },
		uuid
	);

	// (c) a shader graph — the editor's own starter document
	w.shaderGraph.setShaderGraphFor(uuid, {
		nodes: [
			{ id: 'surface', type: 'surface', position: { x: 380, y: 120 }, data: {} },
			{ id: 'colour', type: 'color', position: { x: 90, y: 130 }, data: { value: '#cc3344' } }
		],
		edges: [
			{ id: 'e-colour', source: 'colour', sourceHandle: 'out', target: 'surface', targetHandle: 'albedo' }
		]
	});
	await new Promise((r) => setTimeout(r, 400));
	return uuid;
};

/** Read all three carriers for a uuid. */
const READ = (uuid) => {
	const w = window.__stores;
	let anims, graphs, shaders;
	w.animationPreview.animations.subscribe((v) => (anims = v))();
	w.flowGraphs.subscribe((v) => (graphs = v))();
	w.shaderGraph.shaderGraphs.subscribe((v) => (shaders = v))();
	const set = anims[uuid];
	const graph = graphs[uuid];
	const shader = shaders[uuid];
	return {
		clips: set ? Object.keys(set.clips).length : 0,
		tracks: set ? Object.keys(set.clips).map((id) => set.clips[id].tracks.length) : [],
		nodes: graph ? graph.nodes.length : 0,
		edges: graph ? graph.edges.length : 0,
		nodeIds: graph ? graph.nodes.map((n) => n.id).sort() : [],
		edgeIds: graph ? graph.edges.map((e) => e.id) : [],
		edgeEnds: graph ? graph.edges.map((e) => [e.source, e.target]) : [],
		shaderNodes: shader ? shader.nodes.length : 0,
		shaderColour: shader ? (shader.nodes.find((n) => n.type === 'color')?.data?.value ?? null) : null
	};
};

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---- 1. premise: a source object that owns all three -----------------------
	const src = await A.page.evaluate(SEED);
	const before = await A.page.evaluate(READ, src);
	h.check(before.clips === 1 && before.tracks[0] === 1, `source owns 1 clip with 1 track (premise: ${JSON.stringify(before.tracks)})`);
	h.check(before.nodes === 2 && before.edges === 1, `source owns a 2-node flow graph (premise: ${before.nodes}/${before.edges})`);
	h.check(before.shaderNodes === 2, `source owns a 2-node shader graph (premise: ${before.shaderNodes})`);

	// ---- 2. duplicate carries all three ---------------------------------------
	const dup = await A.page.evaluate(async (uuid) => {
		const clone = window.__stores.objectActions.duplicateObject(uuid);
		await new Promise((r) => setTimeout(r, 600));
		return clone?.uuid ?? null;
	}, src);
	h.check(!!dup && dup !== src, 'duplicate produced a clone with a fresh uuid');

	const copy = await A.page.evaluate(READ, dup);
	h.check(copy.clips === 1 && copy.tracks[0] === 1, `the copy has its OWN clip with the same 1 track (got ${copy.clips}/${JSON.stringify(copy.tracks)})`);
	h.check(copy.nodes === 2 && copy.edges === 1, `the copy has its OWN 2-node flow graph (got ${copy.nodes}/${copy.edges})`);
	h.check(copy.shaderNodes === 2, `the copy has its OWN 2-node shader graph (got ${copy.shaderNodes})`);
	h.check(
		copy.shaderColour === '#cc3344',
		`the copied shader graph kept its authored colour (got ${copy.shaderColour})`
	);

	// node ids must be REGENERATED — a node id is global to the app, and two graphs
	// sharing one would have the editor and every applier addressing the wrong node
	// each of these three demands a NON-EMPTY set as well: `every` over nothing is
	// true, so without the length guard they all passed while no graph was copied at
	// all (proven by deleting the carry — they stayed green while the three above went
	// red, which is exactly the vacuous-check trap)
	const shared = copy.nodeIds.filter((id) => before.nodeIds.includes(id));
	h.check(
		copy.nodeIds.length === 2 && shared.length === 0,
		`the copy's flow node ids are all fresh (${copy.nodeIds.length} ids, ${shared.length} shared with the source)`
	);
	// ...and the edge must have been REMAPPED onto them, not left pointing at the source's
	const remapped =
		copy.edgeEnds.length === 1 &&
		copy.edgeEnds.every(([s, t]) => copy.nodeIds.includes(s) && copy.nodeIds.includes(t));
	h.check(remapped, `the copied edge points at the copy's own nodes (${JSON.stringify(copy.edgeEnds)})`);
	h.check(
		copy.edgeIds.length === 1 &&
			copy.edgeIds.every((id) => id.startsWith('e-') && !before.edgeIds.includes(id)),
		`the copied edge id follows the editor's handle-qualified format and is fresh (${JSON.stringify(copy.edgeIds)})`
	);

	// ---- 3. the source is untouched --------------------------------------------
	const after = await A.page.evaluate(READ, src);
	h.check(
		after.clips === before.clips && after.nodes === before.nodes && after.shaderNodes === before.shaderNodes &&
			JSON.stringify(after.nodeIds) === JSON.stringify(before.nodeIds),
		'the source keeps its own clip, graph and node ids'
	);

	// ---- 4. one undo removes the whole duplicate ------------------------------
	// The carriers record NO history of their own, so the create entry is the only
	// step: one Ctrl+Z must take the object away, not strip its clips and leave it.
	const undone = await A.page.evaluate(async (ids) => {
		const w = window.__stores;
		w.history.undo();
		await new Promise((r) => setTimeout(r, 500));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const gone = !g.getObjectByProperty('uuid', ids.dup);
		const sourceStillThere = !!g.getObjectByProperty('uuid', ids.src);
		return { gone, sourceStillThere };
	}, { src, dup });
	h.check(undone.gone && undone.sourceStillThere, 'one undo removes the clone and leaves the source');

	const redone = await A.page.evaluate(async (ids) => {
		const w = window.__stores;
		w.history.redo();
		await new Promise((r) => setTimeout(r, 600));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		return !!g.getObjectByProperty('uuid', ids.dup);
	}, { src, dup });
	h.check(redone, 'redo brings the clone back');
	// the data survived the round trip precisely BECAUSE a deleted object keeps its
	// clips and graph (the serializer prunes at output) — the documented precedent
	const afterRedo = await A.page.evaluate(READ, dup);
	h.check(
		afterRedo.clips === 1 && afterRedo.nodes === 2 && afterRedo.shaderNodes === 2,
		`the clone's carriers survived undo+redo (${afterRedo.clips}/${afterRedo.nodes}/${afterRedo.shaderNodes})`
	);

	// ---- 5. each toggle suppresses exactly its own carrier ---------------------
	const gated = await A.page.evaluate(async (uuid) => {
		const w = window.__stores;
		w.duplicateCarriesAnimation.set(false);
		w.duplicateCarriesFlow.set(true);
		w.duplicateCarriesShader.set(false);
		const clone = w.objectActions.duplicateObject(uuid);
		await new Promise((r) => setTimeout(r, 500));
		w.duplicateCarriesAnimation.set(true);
		w.duplicateCarriesShader.set(true);
		return clone?.uuid ?? null;
	}, src);
	const gatedRead = await A.page.evaluate(READ, gated);
	h.check(gatedRead.clips === 0, `animation off: the copy has no clip (got ${gatedRead.clips})`);
	h.check(gatedRead.shaderNodes === 0, `shader off: the copy has no shader graph (got ${gatedRead.shaderNodes})`);
	h.check(gatedRead.nodes === 2, `flow on: the copy still has its graph (got ${gatedRead.nodes})`);

	// ---- 6. a bare object sends NO extra messages ------------------------------
	// The carriers must be silent when there is nothing to carry, or every duplicate
	// in a plain scene pays for a feature it is not using.
	const wire = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const bare = g.children[g.children.length - 1];

		let peer;
		w.peers.subscribe((v) => (peer = v))();
		const sent = [];
		const original = peer.send.bind(peer);
		// PASS THROUGH — a spy that swallows makes delivery and loss identical
		peer.send = (m) => { sent.push(m.type); return original(m); };
		try {
			w.objectActions.duplicateObject(bare.uuid);
			await new Promise((r) => setTimeout(r, 500));
		} finally {
			peer.send = original;
		}
		return sent;
	});
	h.check(
		wire.includes('duplicate'),
		`duplicating a bare object still sends its duplicate message (premise: ${JSON.stringify(wire)})`
	);
	h.check(
		!wire.includes('animdata') && !wire.includes('graphcreate') && !wire.includes('nodes'),
		`no carrier messages for an object that owns none (${JSON.stringify(wire)})`
	);

	// ---- 7. an object inheriting the SCENE shader default is not pinned --------
	// Copying an inherited graph would give the clone a private snapshot that stops
	// following the scene default — so only an OWN graph is copied.
	const inherited = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.shaderGraph.setShaderGraphFor('scene', {
			nodes: [
				{ id: 'surface', type: 'surface', position: { x: 380, y: 120 }, data: {} },
				{ id: 'colour', type: 'color', position: { x: 90, y: 130 }, data: { value: '#11ee22' } }
			],
			edges: [{ id: 'e-colour', source: 'colour', sourceHandle: 'out', target: 'surface', targetHandle: 'albedo' }]
		});
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 900));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const plain = g.children[g.children.length - 1];
		const clone = w.objectActions.duplicateObject(plain.uuid);
		await new Promise((r) => setTimeout(r, 500));
		let shaders;
		w.shaderGraph.shaderGraphs.subscribe((v) => (shaders = v))();
		return {
			sourceHasOwn: !!shaders[plain.uuid],
			cloneHasOwn: !!shaders[clone.uuid],
			// both still resolve to the scene graph, which is the point
			resolves: w.shaderGraph.graphKeyFor(clone.uuid)
		};
	});
	h.check(
		!inherited.sourceHasOwn && !inherited.cloneHasOwn,
		'an object inheriting the scene shader default gets no private copy'
	);
	h.check(
		inherited.resolves === 'scene',
		`the clone still resolves to the scene default (got ${inherited.resolves})`
	);

	// ---- 8. the carriers reach a PEER ------------------------------------------
	// Each rides an existing message (`animdata`, `graphcreate` + `nodes`,
	// `shadergraph`), so this is really asserting that the initiator sent them and
	// that no applier re-copies locally — a peer that copied too would double the
	// work and diverge the node ids.
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const remote = await A.page.evaluate(async (uuid) => {
		const clone = window.__stores.objectActions.duplicateObject(uuid);
		await new Promise((r) => setTimeout(r, 1200));
		return clone?.uuid ?? null;
	}, src);
	h.check(!!remote, 'A duplicated the source again while connected (premise)');

	// `eventually` returns the CHECK result, not the value it polled — read the state
	// back separately rather than binding its return (that mistake made four reads
	// below run against `undefined` while delivery had actually worked)
	await h.eventually(
		() => B.page.evaluate(READ, remote),
		(r) => r && r.clips === 1 && r.nodes === 2 && r.shaderNodes === 2,
		'B received the clone with all three carriers',
		20000
	);
	const seen = await B.page.evaluate(READ, remote);
	h.check(
		seen && seen.clips === 1,
		`B has the clone's clip (got ${seen ? seen.clips : 'nothing'})`
	);
	h.check(
		seen && seen.nodes === 2 && seen.edges === 1,
		`B has the clone's flow graph (got ${seen ? seen.nodes + '/' + seen.edges : 'nothing'})`
	);
	h.check(
		seen && seen.shaderNodes === 2 && seen.shaderColour === '#cc3344',
		`B has the clone's shader graph with its colour (got ${seen ? seen.shaderColour : 'nothing'})`
	);
	// the ids must MATCH A's — a peer that re-derived them locally would diverge
	const mine = await A.page.evaluate(READ, remote);
	h.check(
		seen && JSON.stringify(seen.nodeIds) === JSON.stringify(mine.nodeIds),
		'B has the SAME node ids as A (nobody copied locally as well)'
	);

	await h.finish(browser);
});

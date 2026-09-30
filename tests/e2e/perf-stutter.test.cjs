// 31-perf P1 — THE CORE STUTTER GUARDS. The seven-game probe (scripts/perf-games.cjs
// --profile) found where 1.17's frames went; each check below is a COUNTERFACTUAL that goes
// red with its fix reverted (the numbers in the messages are the reverted readings):
//   a) the object list's "Module content" rows never deep-read a module group — svelte's
//      deep_read of a $state proxy walked the whole scene graph through `parent` on every
//      refresh: 88% of Waves' CPU, the 1 Hz hitch in Dungeon Realms
//   b) the flow runtime resolves a node's inputs through an index, not a scan of every edge
//   c) the walker's dungeon lookup is cached, hit AND miss, instead of a per-frame traversal
//   d) easing a remote physics stream neither searches the tree nor pokes the whole UI every
//      frame (a watching peer ran both at the display rate)
//   e) the closed VR objects panel does not rebuild its rows on a scene poke
//
// Run: APP_URL=https://theprototype.app:5263/ npm run e2e -- perf-stutter
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	await page.evaluate(() => {
		window.read = (store) => {
			let v;
			store.subscribe((x) => (v = x))();
			return v;
		};
	});

	// ---- the guards ------------------------------------------------------------
	const deep = await page.evaluate(async () => {
		const s = window.__stores;
		window.__deepReads = 0;
		await s.moduleSDK.initModules([
			{
				id: 'deepprobe',
				name: 'Deep-read probe',
				version: '1.0.0',
				description: 'a module group carrying a getter-counting probe',
				register(api) {
					const THREE = api.THREE;
					class Probe {
						get touched() {
							window.__deepReads++;
							return 1;
						}
					}
					const group = new THREE.Group();
					group.name = 'deepprobe-group';
					const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
					child.name = 'deepprobe-child';
					child.userData.probe = new Probe();
					group.add(child);
					api.scene().add(group);
					api.registerInteractiveGroup('deepprobe-group');
				}
			}
		]);
		// the rows re-derive on every poke and once a second: give them several refreshes
		for (let i = 0; i < 6; i++) {
			s.pokeScene();
			await new Promise((r) => setTimeout(r, 350));
		}
		const listed = !!document.querySelector('.module-content-row[data-group="deepprobe-group"]');
		const reads = window.__deepReads;
		s.moduleSDK.deactivateModule('deepprobe');
		return { listed, reads };
	});
	h.check(deep.listed, '0 (premise) the probe group is listed in the object list\'s Module content');
	h.check(deep.reads === 0, '1 COUNTERFACTUAL GUARD: refreshing the Module content rows never deep-reads a module group (' + deep.reads + ' getter reads; a deep $state walks the scene graph)');

	const index = await page.evaluate(() => {
		const s = window.__stores;
		const nodes = [];
		const edges = [];
		for (let i = 0; i < 200; i++) nodes.push({ id: 'n' + i, type: 'number', data: { value: i } });
		for (let i = 0; i < 400; i++) edges.push({ id: 'e' + i, source: 'n' + (i % 200), target: 'n' + ((i * 7) % 200), targetHandle: 'value' });
		const consumer = { id: 'consumer', type: 'mathop', data: {} };
		nodes.push(consumer);
		edges.push({ id: 'ein', source: 'n3', target: 'consumer', targetHandle: 'a' });
		let reads = 0;
		const counted = new Proxy(edges, {
			get(target, key, recv) {
				if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
				return Reflect.get(target, key, recv);
			}
		});
		for (let i = 0; i < 50; i++) s.flowRuntime.resolveInputs(consumer, nodes, counted, 0, null);
		const data = s.flowRuntime.resolveInputs(consumer, nodes, counted, 0, null);
		return { reads, edges: edges.length, a: data.a };
	});
	h.check(index.a === 3, '2 (premise) the wired input still resolves through the index (a = ' + index.a + ')');
	h.check(index.reads <= index.edges + 10, '3 COUNTERFACTUAL GUARD: 51 resolutions read the edge list ONCE (' + index.reads + ' element reads for ' + index.edges + ' edges; a per-call scan reads ~' + index.edges * 51 + ')');

	const dungeon = await page.evaluate(() => {
		const s = window.__stores;
		const THREE = s.THREE;
		const scene = new THREE.Scene();
		let lookups = 0;
		const inner = scene.getObjectByName.bind(scene);
		scene.getObjectByName = (name) => (lookups++, inner(name));
		s.dungeonPlay.forgetDungeonData?.();
		for (let i = 0; i < 100; i++) s.dungeonPlay.dungeonData(scene);
		const missLookups = lookups;
		const g = new THREE.Group();
		g.name = 'dungeon-module';
		g.userData.play = { grid: [1], width: 1, height: 1, minX: 0, minY: 0, floorValue: 1 };
		scene.add(g);
		s.dungeonPlay.forgetDungeonData?.();
		lookups = 0;
		let found = 0;
		for (let i = 0; i < 100; i++) if (s.dungeonPlay.dungeonData(scene)) found++;
		const hitLookups = lookups;
		scene.remove(g);
		const gone = s.dungeonPlay.dungeonData(scene);
		s.dungeonPlay.forgetDungeonData?.();
		return { missLookups, hitLookups, found, gone };
	});
	h.check(dungeon.found === 100 && dungeon.gone === null, '4 (premise) the raster is found every call, and forgotten when its group leaves the scene');
	h.check(dungeon.hitLookups === 1 && dungeon.missLookups === 1, '5 COUNTERFACTUAL GUARD: 100 walker frames cost ONE scene traversal, hit or miss (' + dungeon.hitLookups + ' / ' + dungeon.missLookups + '; per-frame was 100 / 100)');

	const ease = await page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const group = read(s.objectsGroup);
		const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		box.name = 'ease-box';
		box.userData.physics = { mode: 'dynamic', mass: 1 };
		group.add(box);
		const ms = s.moveSmoothing;
		const move = (x) => {
			const before = { pos: box.position.clone(), quat: box.quaternion.clone() };
			box.position.set(x, 0, 0);
			return ms.noteRemoteMove(box.uuid, box, before);
		};
		move(0.1);
		const easing = move(0.2); // the second inside 400 ms is a STREAM
		let lookups = 0;
		const inner = group.getObjectByProperty.bind(group);
		group.getObjectByProperty = (...a) => (lookups++, inner(...a));
		let revisions = 0;
		const off = s.sceneRevision.subscribe(() => revisions++);
		revisions = 0;
		// 30 "frames" inside one poke window, each followed by a microtask turn so a poke
		// flushes as it would between real frames (pokeScene coalesces per microtask)
		for (let i = 0; i < 30; i++) {
			ms.tickMoveSmoothing();
			await Promise.resolve();
		}
		off();
		group.getObjectByProperty = inner;
		ms.clearMoveSmoothing?.();
		group.remove(box);
		return { easing, lookups, revisions };
	});
	h.check(ease.easing === true, '6 (premise) two moves inside 400 ms ease as a stream');
	// a subscriber reacting to the one allowed poke may search the tree itself: count at most one per poke
	h.check(ease.revisions <= 1 && ease.lookups <= ease.revisions, '7 COUNTERFACTUAL GUARD: 30 eased frames did ' + ease.lookups + ' tree searches and ' + ease.revisions + ' scene pokes (per frame was 30+ / 30)');


	const panel = await page.evaluate(async () => {
		const s = window.__stores;
		const THREE = s.THREE;
		const g = read(s.objectsGroup);
		// a top-level object whose `type` counts reads made from inside flattenPanelRows only
		// (every other list in the app reads `type` too)
		window.__flatReads = 0;
		const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		m.name = 'panel-probe';
		Object.defineProperty(m, 'type', {
			configurable: true,
			get() {
				if (/flattenPanelRows/.test(new Error().stack || '')) window.__flatReads++;
				return 'Mesh';
			}
		});
		g.add(m);
		for (let i = 0; i < 8; i++) {
			s.pokeScene();
			await new Promise((r) => setTimeout(r, 30));
		}
		const closedReads = window.__flatReads;
		s.vrObjectsPanelOpen.set(true);
		await new Promise((r) => setTimeout(r, 200));
		const openReads = window.__flatReads - closedReads;
		const openAction = read(s.vrControls.vrPanelCursorAction);
		s.vrObjectsPanelOpen.set(false);
		g.remove(m);
		s.pokeScene();
		return { closedReads, openReads, openAction };
	});
	h.check(panel.openReads > 0 && typeof panel.openAction === 'string', '(premise) opened, the VR objects panel lists the scene at once (' + panel.openReads + ' reads, ' + panel.openAction + ')');
	h.check(panel.closedReads === 0, 'COUNTERFACTUAL GUARD: 8 scene pokes rebuilt the CLOSED VR objects panel ' + panel.closedReads + ' times (was once per poke)');

	h.check(h.pageErrors(A).length === 0, 'no page errors (' + JSON.stringify(h.pageErrors(A)) + ')');
	await h.finish(browser);
});

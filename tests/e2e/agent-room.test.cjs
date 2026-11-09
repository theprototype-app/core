// 85-nodes — THE FURNISHED ROOM FROM THE VOICE SESSION, REBUILT BY A SCRIPTED AGENT. A real MCP stdio client
// spawns `tools/agent/src/cli.js mcp <link>`, the host approves, and the agent builds the room the voice agent
// could not: a door that swings, a lamp you switch, a doorbell that presses, a sofa cushion to sit on, a cat
// that wanders, a plant and a flag in the wind, a pond that flows, a mug you can carry — using the everyday
// words a person says (door, lamp, button, seat, cat, flag, river) as node types. Every result is read back on
// the HOST page:
//   1  describe_node_types knows every 85-nodes type, with its doc and sockets
//   2  create_objects + one create_flow_nodes per piece, in the object's own graph (aliases resolve)
//   3  the host runs them: a click opens the door on its hinge and switches the lamp off, the button goes in,
//      the cat walks, the plant and the pond carry their shader effects, the mug and the cushion are a
//      Grabbable and a Sit Spot
//   4  one undo_last takes the last call back on the host
// Run: e2e-slot --dev <tree> 5878 -- node tests/e2e/agent-room.test.cjs
const path = require('path');
const { pathToFileURL } = require('url');
const h = require('./helpers.cjs');

const root = path.resolve(__dirname, '../..');
const agentDir = path.join(root, 'tools/agent');
const sdk = (f) => import(pathToFileURL(path.join(agentDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm', f)).href);
const BASE = h.URL.replace(/\/+$/, '');
const TYPES_85 = ['oscillate', 'moveto', 'rotateto', 'scaleto', 'lightswitch', 'lightintensity', 'lightcycle', 'windsway', 'waterflow', 'ambientanimal', 'grabbable', 'highlight', 'pressbutton', 'sitspot'];

async function startBridge(args, onChanged) {
	const { Client } = await sdk('client/index.js');
	const { StdioClientTransport } = await sdk('client/stdio.js');
	const { ToolListChangedNotificationSchema } = await sdk('types.js');
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(agentDir, 'src/cli.js'), 'mcp', ...args, '--verbose'],
		env: { ...process.env },
		stderr: 'pipe'
	});
	const client = new Client({ name: 'claude-code', version: 'e2e' });
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => onChanged && onChanged());
	await client.connect(transport);
	return { client, transport };
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
const json = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
const short = (v) => JSON.stringify(v ?? null).slice(0, 240);

const CAP_MS = 12 * 60 * 1000;
setTimeout(() => {
	console.error('SCRIPT FAILED: agent-room passed its ' + CAP_MS / 60000 + ' min cap');
	process.exit(2);
}, CAP_MS).unref();

/** the host's view of one object */
const onHost = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.objectsGroup.subscribe((x) => (g = x))();
		const o = g?.getObjectByProperty('uuid', u);
		if (!o) return null;
		let intensity = null;
		o.traverse((c) => {
			if (c.isLight && intensity === null) intensity = c.intensity;
		});
		const m = Array.isArray(o.material) ? o.material[0] : o.material;
		return { pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], intensity, key: m?.customProgramCacheKey?.() ?? '' };
	}, uuid);
/** the host's nodes in an object's own graph */
const graphTypes = (page, uuid) =>
	page.evaluate((u) => {
		let g;
		window.__stores.flowGraphs?.subscribe?.((v) => (g = v))();
		return (g?.[u]?.nodes ?? []).map((n) => n.type);
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'host');
	let changed = 0;
	const B = await startBridge([BASE + '/#' + A.id], () => changed++);
	try {
		await h.approveButton(A.page).click({ timeout: 120000 });
		await h.eventually(async () => changed, (n) => n > 0, 'the host tools arrived (tools/list_changed)', 60000);
		let st = null;
		for (let i = 0; i < 90 && !(st?.joined && !st.loading); i++) {
			st = json(await call(B.client, 'status'));
			if (!(st.joined && !st.loading)) await new Promise((r) => setTimeout(r, 1000));
		}
		h.check(st?.joined === true, 'premise: the agent joined');
		if (st?.joined !== true) throw new Error('the agent never joined: ' + short(st));

		console.log('\n=== 1. describe_node_types ===');
		const cards = [
			...json(await call(B.client, 'describe_node_types', { types: TYPES_85.slice(0, 12) })).types,
			...json(await call(B.client, 'describe_node_types', { types: TYPES_85.slice(12) })).types
		];
		for (const t of TYPES_85) {
			const c = cards.find((x) => x.type === t);
			h.check(!!c && typeof c.doc === 'string' && c.doc.length > 20, `1. ${t}: described with a doc (${short(c?.doc).slice(0, 70)})`);
		}
		const door = cards.find((x) => x.type === 'rotateto');
		h.check(['trigger', 'back', 'toggle', 'open'].every((n) => door?.inputs?.some((i) => i.name === n)), '1. rotateto lists its trigger / back / toggle / open sockets');

		console.log('\n=== 2. the agent builds the room ===');
		const made = json(
			await call(B.client, 'create_objects', {
				objects: [
					{ kind: 'primitive', primitive: 'Box', params: [1, 2, 0.1], name: 'Door', position: [0, 1, -3] },
					{ kind: 'light', light: 'point', name: 'Lamp', position: [2, 2, -2] },
					{ kind: 'primitive', primitive: 'Box', params: [0.3, 0.3, 0.1], name: 'Doorbell', position: [1, 1.4, -2.9] },
					{ kind: 'primitive', primitive: 'Box', params: [0.8, 0.4, 0.8], name: 'Cushion', position: [-2, 0.2, 0] },
					{ kind: 'primitive', primitive: 'Box', params: [0.5, 0.4, 0.8], name: 'Cat', position: [3, 0.2, 2] },
					{ kind: 'primitive', primitive: 'Box', params: [0.2, 1.4, 0.2], name: 'Plant', position: [-3, 0.7, -2] },
					{ kind: 'primitive', primitive: 'Box', params: [1.5, 1, 0.05], name: 'Flag', position: [5, 3, -3] },
					{ kind: 'primitive', primitive: 'Box', params: [3, 0.1, 3], name: 'Pond', position: [0, 0.05, 4] },
					{ kind: 'primitive', primitive: 'Box', params: [0.15, 0.2, 0.15], name: 'Mug', position: [-1, 0.9, 1] }
				]
			})
		);
		const id = Object.fromEntries((made.created ?? []).map((c) => [c.name, c.uuid]));
		console.log('  created: ' + short(id));
		h.check(Object.keys(id).length === 9, '2. create_objects made the nine pieces: ' + Object.keys(id).join(', '));
		await h.eventually(() => Promise.all(Object.values(id).map((u) => onHost(A.page, u))), (all) => all.every(Boolean), 'premise: the host has every piece', 30000);

		/** one create_flow_nodes in the object's own graph, with everyday words as node types */
		const flow = async (name, args) => {
			const r = json(await call(B.client, 'create_flow_nodes', { graph: id[name], ...args }));
			h.check(!r.error && !(r.errors ?? []).length && (r.created ?? []).length === (args.nodes ?? []).length, `2. ${name}: ${short(r.created?.map((c) => c.type))}${r.error || r.errors?.length ? ' ERR ' + short(r.error ?? r.errors) : ''}`);
			return r;
		};
		await flow('Door', { nodes: [{ ref: 'c', type: 'onclick' }, { ref: 'd', type: 'door', data: { angle: 90, axis: 'y', pivot: 'left', duration: 0.6 } }], edges: [{ from: 'c', to: 'd', toHandle: 'toggle' }] });
		await flow('Lamp', { nodes: [{ ref: 'c', type: 'onclick' }, { ref: 'l', type: 'lamp', data: { fade: 0.2 } }], edges: [{ from: 'c', to: 'l', toHandle: 'toggle' }] });
		await flow('Doorbell', {
			nodes: [{ ref: 'h', type: 'hover' }, { ref: 'c', type: 'onclick' }, { ref: 'p', type: 'button', data: { axis: '-z', depth: 0.05, hold: 0.5 } }],
			edges: [{ from: 'c', to: 'p', toHandle: 'trigger' }]
		});
		await flow('Cushion', { nodes: [{ type: 'seat', data: { facing: '+z' } }] });
		await flow('Cat', { nodes: [{ type: 'cat', data: { rx: 2, rz: 2, rest: 0.3, restTime: 1, speed: 0.8, clips: false } }] });
		await flow('Plant', { nodes: [{ type: 'wind', data: { mode: 'plant', anchor: 'bottom', strength: 0.2 } }] });
		await flow('Flag', { nodes: [{ type: 'wind', data: { mode: 'flag', anchor: 'left' } }] });
		await flow('Pond', { nodes: [{ type: 'river', data: { speed: 0.2 } }] });
		await flow('Mug', { nodes: [{ type: 'pickup', data: { release: 'return', returnAfter: 1 } }] });
		const want = { Door: 'rotateto', Lamp: 'lightswitch', Doorbell: 'pressbutton', Cushion: 'sitspot', Cat: 'ambientanimal', Plant: 'windsway', Flag: 'windsway', Pond: 'waterflow', Mug: 'grabbable' };
		await h.eventually(
			() => Promise.all(Object.keys(want).map((n) => graphTypes(A.page, id[n]))),
			(all) => all.every((types, i) => types.includes(Object.values(want)[i])),
			'2. the host holds every piece\'s own graph with the right node (aliases resolved)',
			20000
		);
		h.check((await graphTypes(A.page, id.Doorbell)).includes('highlight'), '2. the doorbell has its hover Highlight');

		console.log('\n=== 3. the host runs the room ===');
		// validate_scene is 85-runtime's (1.64); on an older base the tool is not there and that is not this suite's row
		let v = null;
		try {
			const r = await call(B.client, 'validate_scene', {});
			v = r.content?.[0]?.text ?? null;
		} catch (e) {
			v = String(e);
		}
		console.log('  validate_scene: ' + String(v).slice(0, 300));
		const door0 = await onHost(A.page, id.Door);
		const lamp0 = await onHost(A.page, id.Lamp);
		await A.page.evaluate((u) => window.__stores.flowRuntime.fireObjectClick(u), id.Door);
		await h.eventually(() => onHost(A.page, id.Door), (o) => Math.abs(o.rot[1] - Math.PI / 2) < 1e-3, '3. a click swings the door open 90 degrees', 15000);
		const door1 = await onHost(A.page, id.Door);
		h.check(Math.hypot(door1.pos[0] - door0.pos[0], door1.pos[2] - door0.pos[2]) > 0.3, `3. ...on its hinge edge, not its centre (moved ${door1.pos.map((x) => x.toFixed(2))})`);
		h.check(lamp0.intensity > 0, `premise: the lamp is on (${lamp0.intensity})`);
		await A.page.evaluate((u) => window.__stores.flowRuntime.fireObjectClick(u), id.Lamp);
		await h.eventually(() => onHost(A.page, id.Lamp), (o) => o.intensity === 0, '3. a click switches the lamp off', 15000);
		const bell0 = await onHost(A.page, id.Doorbell);
		await A.page.evaluate((u) => window.__stores.flowRuntime.fireObjectClick(u), id.Doorbell);
		// the press is held ~0.6 s, which a ~4 fps headless page can sample past: ask for the pose at the
		// click's own shared moment + 0.3 s instead (the IWER suite's check), then watch it come back
		const pressPose = () =>
			A.page.evaluate((u) => {
				let g;
				window.__stores.flowGraphs.subscribe((v) => (g = v))();
				const ns = g?.[u]?.nodes ?? [];
				const click = ns.find((n) => n.type === 'onclick');
				const btn = ns.find((n) => n.type === 'pressbutton');
				let t;
				window.__stores.flowTriggers.subscribe((v) => (t = v))();
				const at = click ? t?.[click.id]?.lastT : null;
				if (!btn || typeof at !== 'number') return null;
				return window.__stores.flowRuntime.effectPoseAt(btn.id, u, at + 0.3);
			}, id.Doorbell);
		await h.eventually(pressPose, (p) => !!p, 'premise: the doorbell click is stamped', 5000);
		const press = await pressPose(); // h.eventually returns nothing
		h.check(!!press && press.pos[2] < bell0.pos[2] - 0.03, `3. a click presses the doorbell in (z ${bell0.pos[2].toFixed(3)} -> ${press?.pos[2].toFixed(3)} at the click + 0.3 s)`);
		await h.eventually(() => onHost(A.page, id.Doorbell), (o) => Math.abs(o.pos[2] - bell0.pos[2]) < 1e-6, '3. ...and it springs back', 5000);
		const cat0 = await onHost(A.page, id.Cat);
		await A.page.waitForTimeout(2500);
		const cat1 = await onHost(A.page, id.Cat);
		h.check(Math.hypot(cat1.pos[0] - cat0.pos[0], cat1.pos[2] - cat0.pos[2]) > 0.01, '3. the cat wanders');
		h.check((await onHost(A.page, id.Plant)).key.includes('windsway') && (await onHost(A.page, id.Flag)).key.includes('windsway'), '3. the plant and the flag sway (shader deformer on)');
		h.check((await onHost(A.page, id.Pond)).key.includes('waterflow'), '3. the pond flows');
		const decl = await A.page.evaluate((ids) => ({ mug: window.__stores.flowRuntime.kinematicGrab(ids.Mug), seat: window.__stores.flowRuntime.sitSpotFor(ids.Cushion) }), id);
		h.check(decl.mug?.release === 'return' && decl.seat?.facing === '+z', '3. the mug is a Grabbable (return) and the cushion a Sit Spot: ' + short(decl));

		console.log('\n=== 4. undo_last ===');
		const undo = json(await call(B.client, 'undo_last', {}));
		console.log('  undo_last: ' + short(undo));
		await h.eventually(() => graphTypes(A.page, id.Mug), (t) => !t.includes('grabbable'), '4. undo_last takes the agent\'s last call (the mug\'s Grabbable) back on the host', 20000);

		const errs = h.pageErrors(A);
		h.check(errs.length === 0, 'no page errors on the host: ' + JSON.stringify(errs.slice(0, 3)));
	} finally {
		await B.client.close().catch(() => {});
	}
	await h.finish(browser);
});

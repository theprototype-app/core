// 17-E A5 — the Play Animation node: a viewport click opens a door.
//
// The whole point of authoring a movement is triggering it from the world. This
// wires the shipped recipe end to end: a door whose ORIGIN sits on its hinge edge,
// an authored clip that swings it 90 degrees, and an On Click -> Play Animation
// pair in the door's own object graph (no Object Selector: the implicit-owner rule
// makes the graph's owner the target). A real mouse click on the door in the
// viewport must open it, and clicking again must close it.
//
// It also pins the replication contract that is easy to get wrong: the node
// applies playback LOCALLY, because the `nodetrigger` stamp that woke it already
// replicated. Broadcasting from the node too would fire the transport twice.
const h = require('./helpers.cjs');

/** rot.y + the playing flag as one peer sees it */
const doorState = (page, uuid) =>
	page.evaluate((id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		let pb;
		s.animationPreview.playback.subscribe((v) => (pb = v))();
		return {
			deg: obj ? (obj.rotation.y * 180) / Math.PI : null,
			playing: !!pb[id]?.playing,
			pausedAt: pb[id]?.pausedAt ?? null
		};
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- build the door ----------
	const uuid = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box 1 2 0.1');
		await new Promise((r) => setTimeout(r, 400));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.children[g.children.length - 1];
		obj.name = 'Door';
		obj.position.set(0, 1, 0);
		obj.rotation.set(0, 0, 0);
		obj.updateMatrix();
		s.objectOrigin.setOriginFor(obj.uuid, [-0.5, 0, 0]); // hinge edge
		const ap = s.animationPreview;
		const track = ap.addTrack(obj.uuid, 'rot.y', obj);
		ap.updateKey(obj.uuid, track, 0, { t: 0, v: 0 });
		ap.updateKey(obj.uuid, track, 1, { t: 0.6, v: Math.PI / 2 });
		ap.updateAnim(obj.uuid, { duration: 0.6, loop: 'once' });

		// the door's OWN graph: On Click -> Play Animation, nothing else wired
		s.flowGraphsCtl.createObjectGraph(obj.uuid);
		const nh = s.nodesHandler;
		nh.createFlowNode(
			{ id: 'door-click', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 } },
			obj.uuid
		);
		nh.createFlowNode(
			{
				id: 'door-play',
				type: 'playanim',
				position: { x: 220, y: 0 },
				data: { type: 'playanim', clip: '', action: 'toggle', speed: 1 }
			},
			obj.uuid
		);
		nh.createFlowEdge(
			{ id: 'e-door', source: 'door-click', target: 'door-play', targetHandle: 'trigger' },
			obj.uuid
		);
		return obj.uuid;
	});
	await A.page.waitForTimeout(600);

	const closed = await doorState(A.page, uuid);
	h.check(Math.abs(closed.deg) < 0.01, `the door starts closed (${closed.deg?.toFixed(2)}deg)`);

	// ---------- a real viewport click opens it ----------
	// (fireObjectClick is what raycastSelect calls on a hit — the same entry point
	//  the desktop pointerup and the VR trigger both use)
	await A.page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), uuid);
	await A.page.waitForTimeout(300);
	const opening = await doorState(A.page, uuid);
	h.check(opening.playing, 'clicking the door starts its clip');
	await A.page.waitForTimeout(900); // a 0.6s once-clip finishes
	const open = await doorState(A.page, uuid);
	h.check(Math.abs(open.deg - 90) < 1, `and it swings to 90 degrees (${open.deg?.toFixed(2)})`);
	h.check(!open.playing, 'the once-clip ends by itself');

	// ---------- clicking again closes it: the clip plays BACKWARDS ----------
	await A.page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), uuid);
	await A.page.waitForTimeout(250);
	const closing = await doorState(A.page, uuid);
	h.check(
		closing.playing && closing.deg !== null && closing.deg < 89 && closing.deg > 1,
		`clicking again runs it backwards (mid-swing at ${closing.deg?.toFixed(1)}deg)`
	);
	await A.page.waitForTimeout(700);
	const shut = await doorState(A.page, uuid);
	h.check(Math.abs(shut.deg) < 0.5, `and it ends shut (${shut.deg?.toFixed(2)}deg)`);

	// Mid-swing, a click REVERSES from where the door stands instead of restarting.
	// The clip is stretched to 2s first: the On Click pulse is high for 0.3s and a
	// second click inside that window is CORRECTLY swallowed (the pulse debounces),
	// so the reversal has to be triggered after it expires but before the clip ends.
	await A.page.evaluate((id) => {
		window.__stores.animationPreview.updateAnim(id, { duration: 2 });
		window.__stores.flowRuntime.fireObjectClick(id);
	}, uuid);
	await A.page.waitForTimeout(800); // past the pulse, mid-swing
	// Read the angle AND the clip position in ONE evaluate: the door travels ~45
	// deg/s here, so two separate CDP calls sample two different moments and the
	// comparison becomes a race (this bit the phase check in animation-sync too).
	const snapshot = (page) =>
		page.evaluate((id) => {
			const s = window.__stores;
			let g;
			s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
			const obj = g.getObjectByProperty('uuid', id);
			const t = s.animationPreview.transportOf(id);
			return { deg: (obj.rotation.y * 180) / Math.PI, position: t.position, reverse: t.reverse, playing: t.playing };
		}, uuid);
	const half = await snapshot(A.page);
	await A.page.evaluate((id) => window.__stores.flowRuntime.fireObjectClick(id), uuid);
	// `position` is where the clip should be NOW while the pose was written by the
	// last tick, which lags by a frame (much more under a software renderer). Give
	// the reversal enough travel that the lag cannot invert the comparison.
	await A.page.waitForTimeout(900);
	const reversed = await snapshot(A.page);
	h.check(
		half.playing && !half.reverse && half.deg > 2 && half.deg < 88,
		`the door is genuinely mid-swing to reverse from (${half.deg.toFixed(1)}deg, position ${half.position.toFixed(2)}s)`
	);
	h.check(
		reversed.reverse && reversed.position < half.position,
		`a click mid-swing runs the clip backwards from there (${half.position.toFixed(2)} -> ${reversed.position.toFixed(2)}s)`
	);
	h.check(
		reversed.deg < half.deg - 10,
		`so the door closes rather than restarting (${half.deg.toFixed(1)} -> ${reversed.deg.toFixed(1)}deg)`
	);
	await A.page.evaluate((id) => {
		window.__stores.animationPreview.stop(id);
		window.__stores.animationPreview.updateAnim(id, { duration: 0.6 });
	}, uuid);
	await A.page.waitForTimeout(300);

	// One pulse must act ONCE, not on every frame it stays high. Count RISING
	// transitions of `playing`, not store emissions: subscribing reports the
	// current value immediately, which would score a pass or fail on state that
	// existed before the click.
	const repeats = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		ap.stop(id);
		await new Promise((r) => setTimeout(r, 200));
		let starts = 0;
		let last = false;
		const off = ap.playback.subscribe((/** @type {any} */ v) => {
			const now = !!v[id]?.playing;
			if (now && !last) starts++;
			last = now;
		});
		s.flowRuntime.fireObjectClick(id);
		await new Promise((r) => setTimeout(r, 500)); // longer than the 0.3s pulse
		off();
		return { starts };
	}, uuid);
	h.check(repeats.starts === 1, `a 0.3s pulse starts the clip exactly once (${repeats.starts})`);

	// ---------- the node does NOT broadcast: the trigger stamp already did ----------
	const sent = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const peer = await new Promise((r) => s.peers.subscribe(r)());
		const seen = [];
		const orig = peer.send.bind(peer);
		peer.send = (m) => {
			seen.push(m?.type);
			return orig(m);
		};
		await new Promise((r) => setTimeout(r, 1200)); // let the clip finish first
		seen.length = 0;
		s.flowRuntime.fireObjectClick(id);
		await new Promise((r) => setTimeout(r, 600));
		peer.send = orig;
		return seen;
	}, uuid);
	h.check(
		sent.includes('nodetrigger'),
		`the click replicates as a trigger stamp (${sent.join(',') || 'nothing'})`
	);
	h.check(
		!sent.includes('animplay'),
		'and the node does NOT also send the transport (that would fire it twice)'
	);

	// ---------- a named clip, and an unknown name is inert ----------
	const named = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		ap.stop(id);
		const shutId = ap.createClip(id, 'Slam');
		const track = ap.addTrack(id, 'rot.y', null, shutId);
		ap.updateKey(id, track, 0, { t: 0, v: 0 }, shutId);
		ap.updateKey(id, track, 1, { t: 0.4, v: -Math.PI / 2 }, shutId);
		ap.updateAnim(id, { duration: 0.4, loop: 'once' }, shutId);
		// name resolution is by clip NAME (flows and the SDK never see ids)
		const resolved = ap.clipIdByName(id, 'Slam');
		const missing = ap.clipIdByName(id, 'Nope');
		s.nodesHandler.setNodeData('door-play', { clip: 'Slam', action: 'restart' }, id);
		await new Promise((r) => setTimeout(r, 300));
		s.flowRuntime.fireObjectClick(id);
		await new Promise((r) => setTimeout(r, 700));
		let g;
		s.objectsGroup.subscribe((x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		return { resolved: resolved === shutId, missing, deg: (obj.rotation.y * 180) / Math.PI };
	}, uuid);
	h.check(named.resolved, 'a clip resolves by its name');
	h.check(named.missing === null, 'an unknown name resolves to null (the default clip is used)');
	h.check(
		Math.abs(named.deg + 90) < 1,
		`the node plays the clip it NAMES, not the default (${named.deg.toFixed(2)}deg)`
	);

	// ---------- the node is in the catalog and the editor can render it ----------
	const catalog = await A.page.evaluate(() => {
		const s = window.__stores;
		const groups = s.nodeCatalog?.nodeCatalog ?? [];
		const anim = groups.find((/** @type {any} */ g) => g.group === 'Animation');
		return {
			listed: !!anim?.items?.some((/** @type {any} */ i) => i.type === 'playanim'),
			// it must NOT be a per-frame effect type, or the runtime would try to
			// pose an object with it every tick
			inEffects: (s.nodeCatalog?.animationTypes ?? []).includes('playanim')
		};
	});
	h.check(catalog.listed, 'Play Animation is in the Animation group of the catalog');
	h.check(!catalog.inEffects, 'and it is not registered as a per-frame effect');

	await h.finish(browser);
});

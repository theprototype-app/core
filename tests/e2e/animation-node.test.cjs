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
	// WATCH the swing from inside the page instead of sampling it at a fixed 250ms.
	// The clip is 0.6s, so a first tick that arrives late under the software renderer
	// reads exactly 90.0 and the check fails on a pose it was too early to see —
	// while a CDP poll coarse enough to be safe can step straight over a 0.6s swing.
	// What is being asserted is that the door LEAVES 90 and travels down, which is a
	// condition somewhere in the window, not a value at one instant.
	const closing = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		s.flowRuntime.fireObjectClick(id);
		let sawMidSwing = false;
		let least = 90;
		for (let i = 0; i < 40; i++) {
			await new Promise((r) => setTimeout(r, 25));
			const deg = (obj.rotation.y * 180) / Math.PI;
			let pb;
			s.animationPreview.playback.subscribe((/** @type {any} */ v) => (pb = v))();
			if (pb[id]?.playing && deg > 1 && deg < 89) sawMidSwing = true;
			least = Math.min(least, deg);
		}
		return { sawMidSwing, least };
	}, uuid);
	h.check(
		closing.sawMidSwing,
		`clicking again runs it backwards (caught mid-swing; reached ${closing.least.toFixed(1)}deg)`
	);
	await A.page.waitForTimeout(700);
	const shut = await doorState(A.page, uuid);
	h.check(Math.abs(shut.deg) < 0.5, `and it ends shut (${shut.deg?.toFixed(2)}deg)`);

	// Mid-swing, a click REVERSES from where the door stands instead of restarting.
	// The clip is stretched to 2s first: the On Click pulse is high for 0.3s and a
	// second click inside that window is CORRECTLY swallowed (the pulse debounces),
	// so the reversal has to be triggered after it expires but before the clip ends.
	// RETIME (not the length field): stretching the movement itself is what gives
	// the swing room — a length change deliberately leaves key times alone now
	await A.page.evaluate((id) => {
		window.__stores.animationPreview.retimeClip(id, 2);
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
		window.__stores.animationPreview.resetPreview(id);
		window.__stores.animationPreview.retimeClip(id, 0.6);
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

	// ---------- Animation Finished: a clip hands off to the rest of the graph ------
	// This is what "hook clips into the logic" needs: the door that has just opened
	// starts the next thing. Fired LOCALLY when the once-clip ends, because every
	// peer's runtime reaches that same elapsed time on its own — no message needed.
	const handoff = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		const nh = s.nodesHandler;
		// Animation Finished on the door -> a Counter, so a pulse is observable
		nh.createFlowNode(
			{ id: 'door-done', type: 'animfinished', position: { x: 0, y: 200 }, data: { type: 'animfinished', pulse: 0.4 } },
			id
		);
		nh.createFlowNode(
			{ id: 'done-count', type: 'counter', position: { x: 220, y: 200 }, data: { type: 'counter', op: 'up', step: 1 } },
			id
		);
		nh.createFlowEdge(
			{ id: 'e-done', source: 'door-done', target: 'done-count', targetHandle: 'pulse' },
			id
		);
		await new Promise((r) => setTimeout(r, 400));
		const before = await new Promise((r) => s.flowValues.subscribe((/** @type {any} */ v) => r(v['done-count']))());
		// run the door: a 0.6s once-clip
		s.animationPreview.resetPreview(id);
		s.animationPreview.play(id, undefined, { from: 0, reverse: false });
		await new Promise((r) => setTimeout(r, 1400));
		const after = await new Promise((r) => s.flowValues.subscribe((/** @type {any} */ v) => r(v['done-count']))());
		const pulsed = await new Promise((r) => s.flowValues.subscribe((/** @type {any} */ v) => r(v['door-done']))());
		return { before: before ?? 0, after: after ?? 0, pulsed };
	}, uuid);
	h.check(
		handoff.after > handoff.before,
		`a finished clip pulses Animation Finished, and the Counter downstream sees it (${handoff.before} -> ${handoff.after})`
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

	// ---------- F3: Animation State, the readable half of animfinished ----------
	// A door that reports how far open it is. The transport replicates as a
	// synced-clock stamp, so every peer computes the same number from the same data
	// and this node broadcasts nothing.
	//
	// The clip is authored HERE with a length these checks name out loud: the
	// sections above leave a 0.4s named clip on the transport, and reading its
	// duration as "2" would have been a check about the wrong clip.
	const clipSeconds = await A.page.evaluate((id) => {
		const s = window.__stores;
		const ap = s.animationPreview;
		let g;
		s.objectsGroup.subscribe((/** @type {any} */ x) => (g = x))();
		const obj = g.getObjectByProperty('uuid', id);
		const clipId = ap.createClip(id, 'StateReadout');
		const track = ap.addTrack(id, 'rot.y', obj, clipId);
		ap.updateKey(id, track, 0, { t: 0, v: 0 }, clipId);
		ap.updateKey(id, track, 1, { t: 2, v: Math.PI / 2 }, clipId);
		ap.updateAnim(id, { duration: 2, loop: 'once' }, clipId);
		ap.setActiveClip(id, clipId);
		return ap.activeClip(id)?.duration ?? null;
	}, uuid);
	h.check(clipSeconds === 2, `a 2s clip is on the transport for the readouts (${clipSeconds})`);

	await A.page.evaluate((id) => {
		const nh = window.__stores.nodesHandler;
		// `label` is what the palette puts on a node it adds, and NodeWrapper falls
		// back to the raw type without it — so a card check would be reading a node
		// the editor never builds
		const mk = (/** @type {string} */ nid, /** @type {any} */ data, /** @type {number} */ y) =>
			nh.createFlowNode(
				{
					id: nid,
					type: 'animstate',
					position: { x: 440, y },
					data: { label: 'Animation State', type: 'animstate', clip: '', ...data },
					class: 'w-[150px]'
				},
				id
			);
		// one node per reading, all on the door's own graph with NOTHING wired: the
		// implicit-owner rule has to make the graph's owner the target
		['progress', 'playing', 'position', 'duration', 'remaining'].forEach((read, i) =>
			mk('st-' + read, { read }, i * 120)
		);
		// and one asking for a clip that is NOT the one on the transport
		mk('st-other', { clip: 'NoSuchClip', read: 'progress' }, 600);
	}, uuid);
	await A.page.waitForTimeout(400);

	const vals = () =>
		A.page.evaluate(() => {
			let v = {};
			window.__stores.flowValues.subscribe((/** @type {any} */ x) => (v = x))();
			return {
				progress: v['st-progress'],
				playing: v['st-playing'],
				position: v['st-position'],
				duration: v['st-duration'],
				remaining: v['st-remaining'],
				other: v['st-other']
			};
		});

	// parked at the start of the clip
	await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		ap.stop(id);
		ap.scrub(id, 0);
	}, uuid);
	await A.page.waitForTimeout(350);
	const parked = await vals();
	h.check(
		parked.playing === 0 && Math.abs(parked.progress) < 0.02,
		`parked at the start reads progress 0, playing 0 (${parked.progress}, ${parked.playing})`
	);
	h.check(
		Math.abs(parked.duration - 2) < 0.01,
		`duration is the clip length in seconds (${parked.duration})`
	);

	// scrubbed to the middle, still not playing: progress is where the PLAYHEAD is
	await A.page.evaluate((id) => window.__stores.animationPreview.scrub(id, 1), uuid);
	await A.page.waitForTimeout(350);
	const mid = await vals();
	h.check(
		Math.abs(mid.progress - 0.5) < 0.03 && mid.playing === 0,
		`a scrub to 1s of 2s reads progress 0.5 while stopped (${mid.progress?.toFixed(3)}, playing ${mid.playing})`
	);
	h.check(
		Math.abs(mid.position - 1) < 0.05 && Math.abs(mid.remaining - 1) < 0.05,
		`position and remaining agree with it (${mid.position?.toFixed(2)}s / ${mid.remaining?.toFixed(2)}s)`
	);
	h.check(mid.other === 0, `and a node naming a DIFFERENT clip reads 0 (${mid.other})`);

	// playing: progress climbs and playing is 1
	await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		ap.resetPreview(id);
		ap.play(id, undefined, { from: 0, reverse: false });
	}, uuid);
	await A.page.waitForTimeout(500);
	const early = await vals();
	await A.page.waitForTimeout(700);
	const later = await vals();
	h.check(early.playing === 1, `while playing, playing reads 1 (${early.playing})`);
	h.check(
		later.progress > early.progress + 0.15,
		`and progress climbs with the playhead (${early.progress?.toFixed(3)} -> ${later.progress?.toFixed(3)})`
	);
	h.check(
		early.progress > 0 && later.progress <= 1,
		`staying inside 0..1 (${early.progress?.toFixed(3)}, ${later.progress?.toFixed(3)})`
	);

	// progress is measured through the A/B WINDOW, not the whole clip — that window
	// is what the transport actually loops over. 1.5s of a 1-2s window is HALF way,
	// which is the reading that separates this from position/duration.
	await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		ap.stop(id);
		ap.setRange(id, 1, 2);
		ap.scrub(id, 1.5);
	}, uuid);
	await A.page.waitForTimeout(400);
	const ranged = await vals();
	h.check(
		Math.abs(ranged.progress - 0.5) < 0.06,
		`with an A/B window of 1-2s, 1.5s is HALF WAY (progress ${ranged.progress?.toFixed(3)}, not 0.75)`
	);
	await A.page.evaluate((id) => {
		const ap = window.__stores.animationPreview;
		ap.setRange(id, null, null);
		ap.stop(id);
	}, uuid);

	// catalog + socket contract
	const stateCatalog = await A.page.evaluate(() => {
		const s = window.__stores;
		const groups = s.nodeCatalog?.nodeCatalog ?? [];
		const anim = groups.find((/** @type {any} */ g) => g.group === 'Animation');
		const fs = s.flowSockets;
		return {
			listed: !!anim?.items?.some((/** @type {any} */ i) => i.type === 'animstate'),
			inEffects: (s.nodeCatalog?.animationTypes ?? []).includes('animstate'),
			isValue: (s.flowRuntime?.valueTypes ?? []).includes('animstate'),
			out: fs?.outputType?.('animstate'),
			targetIn: fs?.inputType?.('animstate', 'target'),
			// the recipe the node exists for: a number into a Map Range
			intoMapRange: fs?.canConnect?.(fs.outputType('animstate'), fs.inputType('maprange', 'a')),
			// and into a Gate, which is where `playing` belongs
			intoGate: fs?.canConnect?.(fs.outputType('animstate'), fs.inputType('gate', 'a'))
		};
	});
	h.check(stateCatalog.listed, 'Animation State is in the Animation group of the catalog');
	h.check(
		!stateCatalog.inEffects && stateCatalog.isValue,
		`and it is a VALUE node, not a per-frame effect (value ${stateCatalog.isValue}, effect ${stateCatalog.inEffects})`
	);
	h.check(stateCatalog.out === 'number', `its output socket is a number (${stateCatalog.out})`);
	h.check(
		stateCatalog.targetIn === 'object',
		`and its target input takes an object (${stateCatalog.targetIn})`
	);
	h.check(
		stateCatalog.intoMapRange && stateCatalog.intoGate,
		`it can drive a Map Range and a Gate (${stateCatalog.intoMapRange} / ${stateCatalog.intoGate})`
	);

	// it must RENDER: a mount crash is invisible to every store read above. The
	// nodes live on the DOOR's graph, so the editor has to be pointed at it — the
	// dock opens on the scene graph, where there is nothing of ours to find.
	const card = await A.page.evaluate(async (id) => {
		const s = window.__stores;
		s.flowGraphClose.set(false); // activateDock alone leaves it hidden
		s.bottomDock.activateDock('flow');
		s.setActiveGraph(id);
		await new Promise((r) => setTimeout(r, 1500));
		const nodes = [...document.querySelectorAll('.svelte-flow__node, [data-id]')].filter(
			(n) => n.className && String(n.className).includes('node')
		);
		const labels = nodes.map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? '');
		return {
			count: labels.length,
			state: labels.filter((t) => /Animation State/.test(t)),
			selects: nodes.reduce((n, el) => n + el.querySelectorAll('select').length, 0)
		};
	}, uuid);
	h.check(
		card.state.length >= 6,
		`the six Animation State cards render in the editor (${card.state.length} of ${card.count} nodes)`
	);
	h.check(
		/progress/.test(card.state.join(' ')),
		`with the read picker on them (${card.state[0]?.slice(0, 90) ?? 'nothing'})`
	);

	await h.finish(browser);
});

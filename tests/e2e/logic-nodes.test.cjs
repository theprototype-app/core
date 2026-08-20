// 21-E4 — the logic nodes a game LOOP is made of: latch / delay / sequence / once,
// plus counter's reset input, select grown N-way, gate's `not` and sound's trigger.
//
// THE CLAIM UNDER TEST is determinism with NOTHING new on the wire. Every value here
// is a function of (replicated trigger stamps, node params, the synced clock), so the
// two-peer section asserts that one stamp produces the same state on both peers — and
// where a node CANNOT converge for a late joiner (the counter precedent: a joiner's
// trigger log starts empty), the suite asserts the DOCUMENTED behaviour rather than
// pretending otherwise.
//
// Timing matters (Delay/Sequence are measured in real seconds), so this runs with
// h.AUDIO_ARGS — the GPU flags are part of it, and a SwiftShader page ticks too slowly
// for a sub-second window to mean anything.
//
// Run: $env:APP_URL='https://localhost:5200/'; PEER_CONFIG=...; npm run e2e -- logic-nodes
const h = require('./helpers.cjs');

// ---- reading the runtime ---------------------------------------------------
const values = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.flowValues.subscribe((x) => (v = x))();
		return v;
	});
const triggers = (peer) =>
	peer.page.evaluate(() => {
		let v;
		window.__stores.flowTriggers.subscribe((x) => (v = x))();
		return v;
	});
const valueOf = async (peer, id) => (await values(peer))[id];
const countOf = async (peer, id) => (await triggers(peer))[id]?.count ?? 0;

/** Fire an event node the way the app does — a shared synced stamp. */
const pulse = (peer, id, replicate = true) =>
	peer.page.evaluate(
		({ id, replicate }) =>
			window.__stores.flowRuntime.applyNodeTrigger(id, (Date.now() % 86400000) / 1000, replicate),
		{ id, replicate }
	);

/** Replace the whole active graph. Note flowNodes/flowEdges.set does NOT broadcast —
 * the two-peer sections push with sendNodes, as hud-nodes documents.
 *
 * THE SCOPE RESET IS LOAD-BEARING, and cost this suite a whole run: the editor's
 * scope FOLLOWS THE SELECTION, creating an object SELECTS it, and the store mirror
 * refuses to write the view into an object that has no flow document
 * (`if (id !== SCENE_GRAPH && !all[id]) return all`). So one `/create box` turns
 * every later flowNodes.set into a SILENT no-op — which reads as eight broken
 * features, not as a test-setup mistake. */
const setGraph = (peer, nodes, edges) =>
	peer.page.evaluate(
		({ nodes, edges }) => {
			window.__stores.setActiveGraph(window.__stores.SCENE_GRAPH);
			window.__stores.flowNodes.set(
				nodes.map((n) => ({
					id: n.id,
					type: n.type,
					position: n.position ?? { x: 0, y: 0 },
					data: { type: n.type, ...(n.data ?? {}) },
					class: 'w-[150px]'
				}))
			);
			window.__stores.flowEdges.set(edges);
		},
		{ nodes, edges }
	);

/** An edge id in the editor's format — handles included, which peer dedupe depends on. */
const wire = (source, target, targetHandle, sourceHandle) => ({
	id: 'e-' + source + '-' + target + (targetHandle ? '.' + targetHandle : '') + (sourceHandle ? '#' + sourceHandle : ''),
	source,
	target,
	...(sourceHandle ? { sourceHandle } : {}),
	...(targetHandle ? { targetHandle } : {})
});

const pushGraph = async (from, to, expectIds) => {
	await from.page.evaluate((peerId) => window.__stores.nodesHandler.sendNodes(peerId), to.id);
	for (let i = 0; i < 40; i++) {
		const have = await to.page.evaluate(() => {
			let nodes, edges;
			window.__stores.flowNodes.subscribe((v) => (nodes = v))();
			window.__stores.flowEdges.subscribe((v) => (edges = v))();
			return { ids: nodes.map((n) => n.id), edges: edges.length };
		});
		if (expectIds.every((id) => have.ids.includes(id))) return have;
		await to.page.waitForTimeout(250);
	}
	return null;
};

h.run(async () => {
	const browser = await h.launch({ args: h.AUDIO_ARGS });
	const A = await h.setupPage(browser, 'A');

	// ---- 1. premise: the catalog and the socket table agree ------------------
	const wiring = await A.page.evaluate(() => {
		const { nodeCatalog, flowSockets } = window.__stores;
		const spec = (t) => nodeCatalog.findNodeSpec(t);
		const groupOf = (t) => nodeCatalog.groupOf(t);
		return {
			specs: ['latch', 'delay', 'sequence', 'once'].map((t) => ({
				type: t,
				found: !!spec(t),
				group: groupOf(t),
				inputs: spec(t)?.inputs ?? null
			})),
			out: Object.fromEntries(
				['latch', 'delay', 'sequence', 'once'].map((t) => [t, flowSockets.outputType(t)])
			),
			inputs: {
				latchSet: flowSockets.inputType('latch', 'set'),
				latchToggle: flowSockets.inputType('latch', 'toggle'),
				delayCancel: flowSockets.inputType('delay', 'cancel'),
				delaySeconds: flowSockets.inputType('delay', 'seconds'),
				sequenceTrigger: flowSockets.inputType('sequence', 'trigger'),
				onceRearm: flowSockets.inputType('once', 'rearm'),
				counterReset: flowSockets.inputType('counter', 'reset'),
				soundTrigger: flowSockets.inputType('sound', 'trigger'),
				selectC: flowSockets.inputType('select', 'c'),
				selectD: flowSockets.inputType('select', 'd')
			},
			connects: {
				eventToEvent: flowSockets.canConnect('event', 'event'),
				eventToEffect: flowSockets.canConnect('event', 'effect'),
				boolToBool: flowSockets.canConnect('boolean', 'boolean'),
				boolToNumber: flowSockets.canConnect('boolean', 'number'),
				eventToNumber: flowSockets.canConnect('event', 'number')
			}
		};
	});
	h.check(
		wiring.specs.every((s) => s.found && s.group === 'Logic'),
		`all four new nodes are in the Logic palette group (${JSON.stringify(wiring.specs.map((s) => s.type + ':' + s.group))})`
	);
	h.check(
		wiring.out.latch === 'boolean' &&
			wiring.out.delay === 'event' &&
			wiring.out.sequence === 'event' &&
			wiring.out.once === 'event',
		`Latch outputs a boolean, the other three carry the event channel (${JSON.stringify(wiring.out)})`
	);
	h.check(
		Object.entries(wiring.inputs)
			.filter(([k]) => !k.startsWith('select') && k !== 'delaySeconds')
			.every(([, v]) => v === 'event'),
		`every new control socket is an EVENT (${JSON.stringify(wiring.inputs)})`
	);
	h.check(
		wiring.inputs.selectC === 'number' && wiring.inputs.selectD === 'number' && wiring.inputs.delaySeconds === 'number',
		`select c/d and delay.seconds take numbers (${wiring.inputs.selectC}/${wiring.inputs.selectD}/${wiring.inputs.delaySeconds})`
	);
	h.check(
		Object.values(wiring.connects).every(Boolean),
		`the wirings these nodes need are all legal — event->event, event->effect, boolean->boolean/number (${JSON.stringify(wiring.connects)})`
	);

	// the node editor can actually RENDER them (a type missing from CORE_NODE_TYPES
	// falls through to UnknownNode, which no store read would notice)
	await A.page.locator('p[title="Node editor (N)"]').click();
	await A.page.waitForTimeout(1200);
	const renderable = await A.page.evaluate(() => {
		const live = window.__flowNodeTypes?.live() ?? [];
		return ['latch', 'delay', 'sequence', 'once'].filter((t) => live.includes(t));
	});
	h.check(
		renderable.length === 4,
		`the mounted pane can render all four (${JSON.stringify(renderable)})`
	);

	// ---- 2. LATCH: a pulse becomes state that HOLDS --------------------------
	await setGraph(
		A,
		[
			{ id: 'setSrc', type: 'onclick', position: { x: 0, y: 0 } },
			{ id: 'resetSrc', type: 'onclick', position: { x: 0, y: 90 } },
			{ id: 'togSrc', type: 'onclick', position: { x: 0, y: 180 } },
			{ id: 'latch1', type: 'latch', position: { x: 240, y: 60 }, data: { initial: false } },
			{ id: 'latchInit', type: 'latch', position: { x: 240, y: 260 }, data: { initial: true } }
		],
		[
			wire('setSrc', 'latch1', 'set'),
			wire('resetSrc', 'latch1', 'reset'),
			wire('togSrc', 'latch1', 'toggle')
		]
	);
	await A.page.waitForTimeout(900);
	h.check((await valueOf(A, 'latch1')) === false, 'a fresh Latch reads its `initial` (false)');
	h.check(
		(await valueOf(A, 'latchInit')) === true,
		'and an unwired Latch with initial=true reads true — no pulse required'
	);

	await pulse(A, 'setSrc');
	await h.eventually(() => valueOf(A, 'latch1'), (v) => v === true, 'a `set` pulse turns the Latch on');
	// THE UNBLOCK: the pulse itself is only ~0.3s long. Every trigger in this app was
	// that pulse and nothing else, which is exactly what this node exists to fix.
	await A.page.waitForTimeout(1600);
	h.check(
		(await valueOf(A, 'latch1')) === true,
		'and it STAYS on long after the ~0.3s pulse expired — the state, not the pulse'
	);
	const srcPulse = await valueOf(A, 'setSrc');
	h.check(srcPulse === 0, `premise: the source pulse itself has ended (${srcPulse})`);

	await pulse(A, 'resetSrc');
	await h.eventually(() => valueOf(A, 'latch1'), (v) => v === false, 'a `reset` pulse turns it off');
	await A.page.waitForTimeout(1200);
	h.check((await valueOf(A, 'latch1')) === false, 'and off is just as persistent as on');

	await pulse(A, 'togSrc');
	await h.eventually(() => valueOf(A, 'latch1'), (v) => v === true, 'a `toggle` pulse flips it on');
	await A.page.waitForTimeout(700);
	await pulse(A, 'togSrc');
	await h.eventually(() => valueOf(A, 'latch1'), (v) => v === false, 'a second toggle flips it back off');

	// the two halves COMPOSE: a set/reset re-bases the toggle parity rather than
	// fighting it (an accumulated odd count would otherwise invert a fresh `set`)
	await pulse(A, 'togSrc'); // parity now odd
	await A.page.waitForTimeout(700);
	await pulse(A, 'setSrc');
	await h.eventually(
		() => valueOf(A, 'latch1'),
		(v) => v === true,
		'`set` wins over an odd toggle parity — the halves compose'
	);
	const parity = await countOf(A, 'latch1');
	h.check(parity === 0, `and clears it, so the next toggle flips from ON (parity ${parity})`);
	await pulse(A, 'togSrc');
	await h.eventually(() => valueOf(A, 'latch1'), (v) => v === false, 'so one toggle after a set turns it off');

	// ---- 3. the recipe the plan names: latch -> visibility = hide-on-collect --
	const hidden = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 900));
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const box = group.children[group.children.length - 1];
		// creating selected it, which moved the editor scope onto its (nonexistent)
		// object graph — see the note on setGraph
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		await new Promise((r) => setTimeout(r, 300));
		s.flowNodes.set([
			{ id: 'collect', type: 'onclick', position: { x: 0, y: 0 }, data: { type: 'onclick', pulse: 0.3 }, class: 'w-[150px]' },
			{ id: 'gone', type: 'latch', position: { x: 200, y: 0 }, data: { type: 'latch', initial: true }, class: 'w-[150px]' },
			{ id: 'vis', type: 'visibility', position: { x: 400, y: 0 }, data: { type: 'visibility', on: true }, class: 'w-[150px]' },
			{ id: 'selBox', type: 'objectselector', position: { x: 600, y: 0 }, data: { type: 'objectselector', selected: box.uuid }, class: 'w-[150px]' }
		]);
		s.flowEdges.set([
			{ id: 'e-collect-gone.reset', source: 'collect', target: 'gone', targetHandle: 'reset' },
			{ id: 'e-gone-vis.on', source: 'gone', target: 'vis', targetHandle: 'on' },
			{ id: 'e-vis-selBox', source: 'vis', target: 'selBox' }
		]);
		await new Promise((r) => setTimeout(r, 1200));
		const before = box.visible;
		s.flowRuntime.applyNodeTrigger('collect', (Date.now() % 86400000) / 1000, true);
		await new Promise((r) => setTimeout(r, 1800)); // well past the pulse
		return { before, after: box.visible };
	});
	h.check(
		hidden.before === true && hidden.after === false,
		`latch -> Visibility hides an object for good on ONE pulse — no new visibility node needed (${JSON.stringify(hidden)})`
	);

	// ---- 4. DELAY: fires late, and `cancel` stops it -------------------------
	await setGraph(
		A,
		[
			{ id: 'dTrig', type: 'onclick', position: { x: 0, y: 0 } },
			{ id: 'dCancel', type: 'onclick', position: { x: 0, y: 90 } },
			{ id: 'delay1', type: 'delay', position: { x: 240, y: 40 }, data: { seconds: 1.2, pulse: 0.5 } },
			{ id: 'dCount', type: 'counter', position: { x: 480, y: 40 }, data: { step: 1, op: 'up' } }
		],
		[
			wire('dTrig', 'delay1', 'trigger'),
			wire('dCancel', 'delay1', 'cancel'),
			wire('delay1', 'dCount', 'pulse')
		]
	);
	await A.page.waitForTimeout(1000);

	const measured = await A.page.evaluate(async () => {
		const s = window.__stores;
		const read = (id) => {
			let v;
			s.flowValues.subscribe((x) => (v = x))();
			return v[id];
		};
		const count = () => {
			let t;
			s.flowTriggers.subscribe((x) => (t = x))();
			return t.dCount?.count ?? 0;
		};
		const before = count();
		s.flowRuntime.applyNodeTrigger('dTrig', (Date.now() % 86400000) / 1000, true);
		const start = performance.now();
		let early = null;
		let firedAt = null;
		let countedAt = null;
		while (performance.now() - start < 4000) {
			await new Promise((r) => setTimeout(r, 40));
			const el = (performance.now() - start) / 1000;
			if (early === null && el >= 0.4) early = read('delay1') ?? 0;
			if (firedAt === null && read('delay1') === 1) firedAt = el;
			if (countedAt === null && count() > before) countedAt = el;
			if (firedAt !== null && countedAt !== null && el > firedAt + 1.4) break;
		}
		return { before, early, firedAt, countedAt, after: read('delay1') ?? 0, count: count() };
	});
	h.check(
		measured.early === 0,
		`a Delay is NOT high 0.4s into a 1.2s wait (${measured.early}) — the stamp is withheld until its moment passes`
	);
	h.check(
		measured.firedAt !== null && measured.firedAt > 1.0 && measured.firedAt < 2.4,
		`it fires about "seconds" after the stamp (${measured.firedAt}s of 1.2s)`
	);
	h.check(
		measured.after === 0,
		`and the pulse closes again afterwards (${measured.after})`
	);
	h.check(
		measured.count === measured.before + 1 && measured.countedAt !== null,
		`a Counter wired from it counts exactly once — the PUSH half of the event system is reached (${measured.before} -> ${measured.count})`
	);
	// THE GUARD, and the one worth having here: the value window is protected by its
	// own `dt >= 0`, so only the PUSH path can show that the derived stamp is WITHHELD
	// until its moment. Measured with `at <= syncedNow()` removed: this counted at
	// 0.04s, and every Sequence step fired at once.
	h.check(
		measured.countedAt !== null && measured.countedAt > 1.0,
		`and counts it LATE rather than on the trigger — the withheld stamp, measured downstream (${measured.countedAt}s)`
	);

	const cancelled = await A.page.evaluate(async () => {
		const s = window.__stores;
		const read = () => {
			let v;
			s.flowValues.subscribe((x) => (v = x))();
			return v.delay1;
		};
		const count = () => {
			let t;
			s.flowTriggers.subscribe((x) => (t = x))();
			return t.dCount?.count ?? 0;
		};
		const before = count();
		s.flowRuntime.applyNodeTrigger('dTrig', (Date.now() % 86400000) / 1000, true);
		await new Promise((r) => setTimeout(r, 350));
		s.flowRuntime.applyNodeTrigger('dCancel', (Date.now() % 86400000) / 1000, true);
		let everHigh = false;
		const start = performance.now();
		while (performance.now() - start < 3200) {
			await new Promise((r) => setTimeout(r, 40));
			if (read() === 1) everHigh = true;
		}
		return { before, everHigh, count: count() };
	});
	h.check(
		!cancelled.everHigh,
		`a "cancel" mid-wait drops the pending pulse entirely (everHigh=${cancelled.everHigh})`
	);
	h.check(
		cancelled.count === cancelled.before,
		`so nothing downstream counted either (${cancelled.before} -> ${cancelled.count})`
	);

	// a trigger AFTER a cancel still fires — the cancel is history, not a mode
	const reArmed = await A.page.evaluate(async () => {
		const s = window.__stores;
		const count = () => {
			let t;
			s.flowTriggers.subscribe((x) => (t = x))();
			return t.dCount?.count ?? 0;
		};
		const before = count();
		s.flowRuntime.applyNodeTrigger('dTrig', (Date.now() % 86400000) / 1000, true);
		await new Promise((r) => setTimeout(r, 3000));
		return { before, count: count() };
	});
	h.check(
		reArmed.count === reArmed.before + 1,
		`and a later trigger fires normally — a cancel is history, not a latch (${reArmed.before} -> ${reArmed.count})`
	);

	// ---- 5. SEQUENCE: four ordered steps off one pulse -----------------------
	await setGraph(
		A,
		[
			{ id: 'sTrig', type: 'onclick', position: { x: 0, y: 0 } },
			{
				id: 'seq1',
				type: 'sequence',
				position: { x: 220, y: 0 },
				data: { delay1: 0, delay2: 0.6, delay3: 0.6, delay4: 0.6, pulse: 0.4 }
			},
			{ id: 'sc1', type: 'counter', position: { x: 460, y: 0 }, data: { step: 1, op: 'up' } },
			{ id: 'sc2', type: 'counter', position: { x: 460, y: 90 }, data: { step: 1, op: 'up' } },
			{ id: 'sc3', type: 'counter', position: { x: 460, y: 180 }, data: { step: 1, op: 'up' } },
			{ id: 'sc4', type: 'counter', position: { x: 460, y: 270 }, data: { step: 1, op: 'up' } }
		],
		[
			wire('sTrig', 'seq1', 'trigger'),
			wire('seq1', 'sc1', 'pulse', 'step1'),
			wire('seq1', 'sc2', 'pulse', 'step2'),
			wire('seq1', 'sc3', 'pulse', 'step3'),
			wire('seq1', 'sc4', 'pulse', 'step4')
		]
	);
	await A.page.waitForTimeout(1000);
	const staged = await A.page.evaluate(async () => {
		const s = window.__stores;
		const counts = () => {
			let t;
			s.flowTriggers.subscribe((x) => (t = x))();
			return [1, 2, 3, 4].map((i) => t['sc' + i]?.count ?? 0);
		};
		const before = counts();
		s.flowRuntime.applyNodeTrigger('sTrig', (Date.now() % 86400000) / 1000, true);
		const start = performance.now();
		const at = [null, null, null, null];
		while (performance.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 40));
			const now = counts();
			const el = (performance.now() - start) / 1000;
			for (let i = 0; i < 4; i++) if (at[i] === null && now[i] > before[i]) at[i] = el;
			if (at.every((v) => v !== null)) break;
		}
		await new Promise((r) => setTimeout(r, 600));
		return { before, at, counts: counts() };
	});
	h.check(
		staged.at.every((v) => v !== null),
		`all four steps fire from ONE pulse (${JSON.stringify(staged.at.map((v) => (v === null ? null : +v.toFixed(2))))})`
	);
	h.check(
		staged.at[0] !== null && staged.at[0] < 0.6,
		`step1 fires immediately at delay1=0 (${staged.at[0]}s)`
	);
	h.check(
		staged.at.every((v, i) => i === 0 || (v !== null && staged.at[i - 1] !== null && v > staged.at[i - 1])),
		'and the rest fire in ORDER, each at its cumulative offset'
	);
	h.check(
		staged.at[3] !== null && staged.at[3] > 1.4 && staged.at[3] < 3.2,
		`step4 lands near the 1.8s total (${staged.at[3]}s)`
	);
	h.check(
		staged.counts.every((c, i) => c === staged.before[i] + 1),
		`each step counts EXACTLY once on its own counter — the per-handle push filter holds (${JSON.stringify(staged.counts)})`
	);

	// ---- 6. ONCE: the first stamp only, until rearmed ------------------------
	await setGraph(
		A,
		[
			{ id: 'oTrig', type: 'onclick', position: { x: 0, y: 0 } },
			{ id: 'oRearm', type: 'onclick', position: { x: 0, y: 90 } },
			{ id: 'once1', type: 'once', position: { x: 240, y: 40 }, data: { pulse: 0.3 } },
			{ id: 'oCount', type: 'counter', position: { x: 480, y: 40 }, data: { step: 1, op: 'up' } }
		],
		[wire('oTrig', 'once1', 'trigger'), wire('oRearm', 'once1', 'rearm'), wire('once1', 'oCount', 'pulse')]
	);
	await A.page.waitForTimeout(900);
	for (let i = 0; i < 3; i++) {
		await pulse(A, 'oTrig');
		await A.page.waitForTimeout(600);
	}
	const onceState = await triggers(A);
	h.check(
		(onceState.oCount?.count ?? 0) === 1,
		`three pulses through a Once count ONCE (${onceState.oCount?.count})`
	);
	const frozen = onceState.once1?.lastT ?? null;
	h.check(
		onceState.once1?.count === 1 && frozen !== null,
		`and its own entry is frozen at count 1 — what a stamp-edge consumer needs (${JSON.stringify(onceState.once1)})`
	);
	await pulse(A, 'oTrig');
	await A.page.waitForTimeout(700);
	const stillFrozen = (await triggers(A)).once1?.lastT ?? null;
	h.check(
		stillFrozen === frozen,
		`the frozen STAMP does not advance on a later pulse either (${frozen} / ${stillFrozen})`
	);

	await pulse(A, 'oRearm');
	await A.page.waitForTimeout(700);
	const rearmed = await triggers(A);
	h.check(
		rearmed.once1 === undefined,
		`\`rearm\` DELETES the entry rather than restamping it — a live stamp on a disarmed Once would read as a fresh pulse downstream (${JSON.stringify(rearmed.once1 ?? null)})`
	);
	await pulse(A, 'oTrig');
	await h.eventually(() => countOf(A, 'oCount'), (c) => c === 2, 'and after a rearm it fires again, exactly once more');

	// ---- 7. COUNTER gains a reset INPUT -------------------------------------
	await setGraph(
		A,
		[
			{ id: 'up', type: 'onclick', position: { x: 0, y: 0 } },
			{ id: 'rst', type: 'onclick', position: { x: 0, y: 90 } },
			{ id: 'score', type: 'counter', position: { x: 240, y: 40 }, data: { step: 1, op: 'up' } }
		],
		[wire('up', 'score', 'pulse'), wire('rst', 'score', 'reset')]
	);
	await A.page.waitForTimeout(900);
	for (let i = 0; i < 3; i++) {
		await pulse(A, 'up');
		await A.page.waitForTimeout(250);
	}
	h.check((await countOf(A, 'score')) === 3, 'a Counter still counts its pulse input');
	await pulse(A, 'rst');
	await h.eventually(() => countOf(A, 'score'), (c) => c === 0, 'a wired `reset` event zeroes it — the round-2 score');
	await pulse(A, 'up');
	await h.eventually(() => countOf(A, 'score'), (c) => c === 1, 'and it counts up again afterwards, `op` untouched');

	// ---- 8. SELECT grows N-way, and stays byte-compatible -------------------
	await setGraph(
		A,
		[
			{ id: 'idx', type: 'number', position: { x: 0, y: 0 }, data: { value: 0 } },
			{ id: 'n0', type: 'number', position: { x: 0, y: 60 }, data: { value: 10 } },
			{ id: 'n1', type: 'number', position: { x: 0, y: 120 }, data: { value: 20 } },
			{ id: 'n2', type: 'number', position: { x: 0, y: 180 }, data: { value: 30 } },
			{ id: 'n3', type: 'number', position: { x: 0, y: 240 }, data: { value: 40 } },
			{ id: 'pick', type: 'select', position: { x: 260, y: 120 }, data: { index: 0, a: 0, b: 0 } },
			// the SAME node as it was saved before this batch: only a/b, no c/d anywhere
			{ id: 'legacy', type: 'select', position: { x: 260, y: 320 }, data: { index: 5, a: 7, b: 9 } }
		],
		[
			wire('idx', 'pick', 'index'),
			wire('n0', 'pick', 'a'),
			wire('n1', 'pick', 'b'),
			wire('n2', 'pick', 'c'),
			wire('n3', 'pick', 'd')
		]
	);
	await A.page.waitForTimeout(1000);
	const picked = [];
	for (const i of [0, 1, 2, 3]) {
		await A.page.evaluate((v) => window.__stores.nodesHandler.setNodeData('idx', { value: v }), i);
		await A.page.waitForTimeout(500);
		picked.push(await valueOf(A, 'pick'));
	}
	h.check(
		JSON.stringify(picked) === JSON.stringify([10, 20, 30, 40]),
		`Select indexes four wired inputs (${JSON.stringify(picked)})`
	);
	h.check(
		(await valueOf(A, 'legacy')) === 9,
		`a saved 2-input Select handed an out-of-range index still lands on \`b\` — byte-compatible (${await valueOf(A, 'legacy')})`
	);

	// ---- 9. GATE `not` ------------------------------------------------------
	// AUDIT NOTE: the plan listed this as missing. It was already shipped (runtime
	// case + BinaryNode option), so this section is a REGRESSION guard, not new work.
	await setGraph(
		A,
		[
			{ id: 'flag', type: 'toggle', position: { x: 0, y: 0 }, data: { on: true } },
			{ id: 'inv', type: 'gate', position: { x: 240, y: 0 }, data: { op: 'not', a: false, b: false } }
		],
		[wire('flag', 'inv', 'a')]
	);
	await A.page.waitForTimeout(900);
	h.check((await valueOf(A, 'inv')) === false, 'Gate `not` inverts a wired true');
	await A.page.evaluate(() => window.__stores.nodesHandler.setNodeData('flag', { on: false }));
	await h.eventually(() => valueOf(A, 'inv'), (v) => v === true, 'and inverts a wired false — no compare trick needed');

	// ---- 10. SOUND gains a trigger -----------------------------------------
	// Audible output is the user's check; what is asserted here is the audio GRAPH:
	// soundEntries() exposes `fired`, the only way to see a fire-and-forget source.
	const hash = await A.page.evaluate(async () => {
		const rate = 8000;
		const n = rate / 4;
		const buf = new ArrayBuffer(44 + n * 2);
		const v = new DataView(buf);
		const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
		str(0, 'RIFF');
		v.setUint32(4, 36 + n * 2, true);
		str(8, 'WAVE');
		str(12, 'fmt ');
		v.setUint32(16, 16, true);
		v.setUint16(20, 1, true);
		v.setUint16(22, 1, true);
		v.setUint32(24, rate, true);
		v.setUint32(28, rate * 2, true);
		v.setUint16(32, 2, true);
		v.setUint16(34, 16, true);
		str(36, 'data');
		v.setUint32(40, n * 2, true);
		for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 10) * 12000, true);
		const created = await window.__stores.explorer.importFiles(
			[new File([buf], 'blip.wav', { type: 'audio/wav' })],
			null
		);
		return created[0].hash;
	});
	const box2 = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 900));
		let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const uuid = group.children[group.children.length - 1].uuid;
		s.objectActions.deselectObject();
		s.setActiveGraph(s.SCENE_GRAPH);
		return uuid;
	});
	await setGraph(
		A,
		[
			{ id: 'bang', type: 'onclick', position: { x: 0, y: 0 } },
			{
				id: 'snd',
				type: 'sound',
				position: { x: 220, y: 0 },
				data: { hash, file: 'blip.wav', volume: 0.8, radius: 5, rolloff: 1, loop: true, playing: false }
			},
			{ id: 'selSnd', type: 'objectselector', position: { x: 460, y: 0 }, data: { selected: box2 } }
		],
		[wire('bang', 'snd', 'trigger'), wire('snd', 'selSnd')]
	);
	const entries = () => A.page.evaluate(() => window.__stores.soundRuntime.soundEntries());
	await h.eventually(
		entries,
		(e) => e.length === 1 && e[0].buffered,
		'premise: the sound chain decodes and waits, not playing'
	);
	const idle = await entries();
	h.check(
		idle[0].fired === 0 && idle[0].playing === false,
		`premise: nothing has fired and the loop is stopped (${JSON.stringify({ fired: idle[0].fired, playing: idle[0].playing })})`
	);
	await pulse(A, 'bang');
	await h.eventually(entries, (e) => e[0]?.fired === 1, 'a trigger pulse plays the buffer ONCE');
	// the pulse stays high ~0.3s; at 60fps a per-frame read would be ~18 copies
	await A.page.waitForTimeout(900);
	const afterHigh = await entries();
	h.check(
		afterHigh[0].fired === 1,
		`and only once while that pulse is still high — stamp edge, not per frame (${afterHigh[0].fired})`
	);
	h.check(
		afterHigh[0].playing === false,
		`the \`playing\` loop is untouched by a one-shot (${afterHigh[0].playing})`
	);
	await pulse(A, 'bang');
	await h.eventually(entries, (e) => e[0]?.fired === 2, 'a second pulse fires a second shot');

	// ---- 11. TWO PEERS: one stamp, the same state ---------------------------
	const B = await h.setupPage(browser, 'B');
	await h.connect(A, B);
	await setGraph(
		A,
		[
			{ id: 'pSet', type: 'onclick', position: { x: 0, y: 0 } },
			{ id: 'pReset', type: 'onclick', position: { x: 0, y: 80 } },
			{ id: 'pTog', type: 'onclick', position: { x: 0, y: 160 } },
			{ id: 'pLatch', type: 'latch', position: { x: 240, y: 60 }, data: { initial: false } },
			{ id: 'pTrig', type: 'onclick', position: { x: 0, y: 260 } },
			{ id: 'pDelay', type: 'delay', position: { x: 240, y: 260 }, data: { seconds: 1, pulse: 0.5 } },
			{ id: 'pCount', type: 'counter', position: { x: 480, y: 260 }, data: { step: 1, op: 'up' } }
		],
		[
			wire('pSet', 'pLatch', 'set'),
			wire('pReset', 'pLatch', 'reset'),
			wire('pTog', 'pLatch', 'toggle'),
			wire('pTrig', 'pDelay', 'trigger'),
			wire('pDelay', 'pCount', 'pulse')
		]
	);
	await A.page.waitForTimeout(1000);
	const synced = await pushGraph(A, B, ['pLatch', 'pDelay', 'pCount']);
	h.check(!!synced, `premise: the peer holds the graph before anything is pulsed (${JSON.stringify(synced)})`);

	await pulse(A, 'pSet');
	await A.page.waitForTimeout(1500);
	const bothSet = [await valueOf(A, 'pLatch'), await valueOf(B, 'pLatch')];
	h.check(
		bothSet[0] === true && bothSet[1] === true,
		`one \`set\` stamp holds the Latch on for BOTH peers (${JSON.stringify(bothSet)})`
	);
	const stamps = await Promise.all([triggers(A), triggers(B)]);
	h.check(
		stamps[0].pSet?.lastT === stamps[1].pSet?.lastT,
		`from ONE shared stamp (${stamps[0].pSet?.lastT} / ${stamps[1].pSet?.lastT})`
	);
	await pulse(A, 'pReset');
	await A.page.waitForTimeout(1500);
	const bothReset = [await valueOf(A, 'pLatch'), await valueOf(B, 'pLatch')];
	h.check(
		bothReset[0] === false && bothReset[1] === false,
		`and a \`reset\` agrees just as exactly (${JSON.stringify(bothReset)})`
	);
	for (let i = 0; i < 3; i++) {
		await pulse(A, 'pTog');
		await A.page.waitForTimeout(500);
	}
	await A.page.waitForTimeout(800);
	const bothTog = [await valueOf(A, 'pLatch'), await valueOf(B, 'pLatch'), await countOf(A, 'pLatch'), await countOf(B, 'pLatch')];
	h.check(
		bothTog[0] === bothTog[1] && bothTog[2] === bothTog[3] && bothTog[2] === 3,
		`three toggles leave both peers on the same parity (${JSON.stringify(bothTog)})`
	);

	// the Delay: each peer derives its own moment from the one stamp, so the DERIVED
	// stamp itself must come out identical — that is the proof nothing was sent
	const beforeCounts = [await countOf(A, 'pCount'), await countOf(B, 'pCount')];
	await pulse(A, 'pTrig');
	await A.page.waitForTimeout(3200);
	const afterCounts = [await countOf(A, 'pCount'), await countOf(B, 'pCount')];
	h.check(
		afterCounts[0] === beforeCounts[0] + 1 && afterCounts[1] === beforeCounts[1] + 1,
		`a delayed pulse counts once on each peer (${JSON.stringify(beforeCounts)} -> ${JSON.stringify(afterCounts)})`
	);
	const derived = await Promise.all([triggers(A), triggers(B)]);
	h.check(
		derived[0].pDelay?.lastT !== undefined && derived[0].pDelay?.lastT === derived[1].pDelay?.lastT,
		`and both peers derived the SAME fire moment with no message of its own (${derived[0].pDelay?.lastT} / ${derived[1].pDelay?.lastT})`
	);

	// ---- 12. a LATE JOINER: what converges, and what is documented not to ---
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	const syncedC = await pushGraph(A, C, ['pLatch', 'pDelay', 'pCount']);
	h.check(!!syncedC, `premise: the late joiner holds the graph (${JSON.stringify(syncedC)})`);
	// its trigger log starts EMPTY (it is not part of the handshake), so it reads
	// `initial` while A/B hold the state the toggles left
	const joinRead = [await valueOf(A, 'pLatch'), await valueOf(C, 'pLatch')];
	h.check(
		joinRead[1] === false,
		`the joiner starts from \`initial\` — the trigger log is not handshaked (A=${joinRead[0]} C=${joinRead[1]})`
	);
	await pulse(A, 'pSet');
	await A.page.waitForTimeout(1800);
	const converged = [await valueOf(A, 'pLatch'), await valueOf(B, 'pLatch'), await valueOf(C, 'pLatch')];
	h.check(
		converged.every((v) => v === true),
		`and CONVERGES on the very next set/reset — set/reset being pure stamp comparison is what buys that (${JSON.stringify(converged)})`
	);
	// the documented cost: a toggle-only parity, and a spent Once, do NOT converge
	const parities = [await countOf(A, 'pLatch'), await countOf(C, 'pLatch')];
	h.check(
		parities[0] === 0 && parities[1] === 0,
		`a set/reset also re-bases the toggle parity on every peer, joiner included (${JSON.stringify(parities)})`
	);
	await pulse(A, 'pTog');
	await A.page.waitForTimeout(1500);
	const afterJoinTog = [await valueOf(A, 'pLatch'), await valueOf(B, 'pLatch'), await valueOf(C, 'pLatch')];
	h.check(
		afterJoinTog.every((v) => v === afterJoinTog[0]),
		`so toggles agree again from there on (${JSON.stringify(afterJoinTog)})`
	);
	const delayC = await A.page.evaluate(async () => {
		const s = window.__stores;
		s.flowRuntime.applyNodeTrigger('pTrig', (Date.now() % 86400000) / 1000, true);
		return true;
	});
	await A.page.waitForTimeout(3200);
	const delayStamps = await Promise.all([triggers(A), triggers(B), triggers(C)]);
	h.check(
		delayC &&
			delayStamps.every((t) => t.pDelay?.lastT === delayStamps[0].pDelay?.lastT) &&
			delayStamps[0].pDelay?.lastT !== undefined,
		`a Delay needs no catch-up at all — the joiner derives the same moment from the next stamp (${delayStamps.map((t) => t.pDelay?.lastT).join(' / ')})`
	);

	await h.finish(browser);
});

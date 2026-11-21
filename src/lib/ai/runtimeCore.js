// Roadmap 85 R1 / R4 / R8 (85b, lane 85-runtime) — SEE WHAT THE GAME DOES, the pure half (imports nothing;
// runtimeTools.js hands in a plain snapshot of the scene's graphs, trigger log and settings).
//
//   validateScene(world)  the playability lint: what will not work when somebody presses Play, in words
//   explainNode(world, n) "why didn't X fire": one node's last pulse and the first thing upstream that is missing
//   nodeRuntime(world, n) the fixed read projection inspect_runtime returns per node
//
// THE RULE EVERYTHING HERE RESTS ON (research round 1, 2026-10-28): an ACTION node runs only on the stamp edge
// of an upstream SOURCE (On Click, On Enter, a key, On Game State …). Firing an action node directly does
// nothing; a graph whose action has no source upstream is dead however right it looks. And an On Click
// reaches an object only DOWNSTREAM (On Click → … → Object Selector) or as the owner of its own object graph:
// the selector wired INTO the On Click is the wrong way round and never fires (R8).

/** a node's display name: its label, else its type @param {any} n */
export const nodeName = (n) => String(n?.data?.label && n.data.label !== n.type ? n.data.label : n?.type ?? 'node');

/** the trigger clock wraps at midnight (seconds of the day): age of a stamp at `now` @param {number} stamp @param {number} now */
export function stampAge(stamp, now) {
	let age = now - stamp;
	if (age < -43200) age += 86400;
	return age;
}

/** @param {number} n */
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * @typedef {{
 *   nodes: {id: string, type: string, data?: any, __graph?: string}[],
 *   edges: {id?: string, source: string, target: string, sourceHandle?: string | null, targetHandle?: string | null}[],
 *   triggers?: Record<string, {lastT: number, count?: number}>,
 *   now?: number,
 *   objects?: Record<string, {name: string, type?: string, light?: boolean, visible?: boolean, sensor?: boolean}>,
 *   hudElements?: string[],
 *   hudScreens?: string[],
 *   play?: {interaction?: string, grounded?: boolean, spawn?: any, simOnPlay?: boolean},
 *   dynamicBodies?: boolean,
 *   envLit?: boolean,
 *   behaviours?: {name: string, issues: {line?: number, message: string}[]}[],
 *   isSource: (type: string) => boolean,
 *   isAction: (type: string) => boolean,
 *   isObjectEffect?: (type: string) => boolean,
 *   inputsOf: (type: string) => {name: string, type: string}[],
 *   edgeTypeProblem?: (source: any, target: any, sourceHandle?: string, targetHandle?: string) => ({refuse?: string, warn?: string} | null),
 *   edgeHandleProblems?: (source: any, target: any, sourceHandle?: string, targetHandle?: string) => string[]
 * }} World
 */

/** the HUD node types and the field naming their element / screen */
const HUD_FIELDS = /** @type {Record<string, 'element' | 'screen'>} */ ({
	hudtext: 'element',
	hudbar: 'element',
	hudbutton: 'element',
	hudtimer: 'element',
	hudlist: 'element',
	hudrows: 'element',
	hudinput: 'element',
	hudset: 'element',
	leaderboard: 'element',
	hudscreen: 'screen'
});

/** sources that reach an object (by a selector downstream or the graph owner) — they need a target */
const OBJECT_SOURCES = new Set(['onclick', 'ongrab', 'onhit', 'onimpact', 'onrest']);

/** @param {World} w */
function index(w) {
	const byId = new Map(w.nodes.map((n) => [n.id, n]));
	/** @type {Map<string, any[]>} */
	const into = new Map();
	/** @type {Map<string, any[]>} */
	const out = new Map();
	for (const e of w.edges) {
		if (!into.has(e.target)) into.set(e.target, []);
		if (!out.has(e.source)) out.set(e.source, []);
		/** @type {any[]} */ (into.get(e.target)).push(e);
		/** @type {any[]} */ (out.get(e.source)).push(e);
	}
	return { byId, into: (/** @type {string} */ id) => into.get(id) ?? [], out: (/** @type {string} */ id) => out.get(id) ?? [] };
}

/**
 * Every SOURCE upstream of a node (walking wires backwards), nearest first; `cycle`-safe.
 * @param {World} w @param {ReturnType<typeof index>} ix @param {string} id @returns {any[]}
 */
function sourcesUpstream(w, ix, id) {
	const seen = new Set([id]);
	const queue = [id];
	const found = [];
	while (queue.length) {
		const cur = /** @type {string} */ (queue.shift());
		for (const e of ix.into(cur)) {
			if (seen.has(e.source)) continue;
			seen.add(e.source);
			const n = ix.byId.get(e.source);
			if (!n) continue;
			if (w.isSource(n.type)) found.push(n);
			queue.push(e.source);
		}
	}
	return found;
}

/** the object an On Click / On Grab … answers to: selectors downstream, else the owner of its object graph
 * @param {ReturnType<typeof index>} ix @param {any} n @returns {{targets: string[], owner: string | null}} */
function sourceTargets(ix, n) {
	const seen = new Set([n.id]);
	const stack = [n.id];
	/** @type {string[]} */
	const targets = [];
	while (stack.length) {
		const cur = /** @type {string} */ (stack.pop());
		for (const e of ix.out(cur)) {
			if (seen.has(e.target)) continue;
			const t = ix.byId.get(e.target);
			if (t?.type === 'objectselector') {
				if (t.data?.selected) targets.push(String(t.data.selected));
				continue;
			}
			seen.add(e.target);
			stack.push(e.target);
		}
	}
	const wiredToSelector = ix.out(n.id).some((/** @type {any} */ e) => ix.byId.get(e.target)?.type === 'objectselector');
	const owner = n.__graph && n.__graph !== 'scene' && !wiredToSelector ? String(n.__graph) : null;
	return { targets, owner };
}

/** @param {World} w @param {string} uuid */
const objName = (w, uuid) => w.objects?.[uuid]?.name || 'an object';

/**
 * R4 + R8 — the playability lint. Each issue: `{code, level: 'error'|'warning', message, node?, object?}`;
 * `message` is a sentence a voice client can say, `fix` what to do about it.
 * @param {World} w @returns {{ok: boolean, issues: any[], checked: {nodes: number, edges: number, behaviours: number}}}
 */
export function validateScene(w) {
	const ix = index(w);
	/** @type {any[]} */
	const issues = [];
	/** @param {any} issue */
	const add = (issue) => issues.length < 60 && issues.push(issue);
	const objects = w.objects ?? {};
	const elements = new Set(w.hudElements ?? []);
	const screens = new Set((w.hudScreens ?? []).map((s) => s.toLowerCase()));

	for (const n of w.nodes) {
		const name = nodeName(n);
		// R8: a selector wired INTO an event source (anything but a declared object input such as On Enter's filter)
		for (const e of ix.into(n.id)) {
			const from = ix.byId.get(e.source);
			if (from?.type !== 'objectselector' || !w.isSource(n.type)) continue;
			const declared = w.inputsOf(n.type).some((i) => i.name === e.targetHandle && i.type === 'object');
			if (declared) continue;
			add({
				code: 'reversed-selector',
				level: 'error',
				node: n.id,
				object: from.data?.selected || undefined,
				message: name + ' has an Object Selector wired INTO it, so it never fires: the wire goes the wrong way.',
				fix: 'Wire ' + name + ' → Object Selector (' + objName(w, from.data?.selected) + '), or put ' + name + ' in that object\'s own graph with no selector.'
			});
		}
		// a source that reaches no object (a scene-graph On Click with no selector downstream)
		if (OBJECT_SOURCES.has(n.type)) {
			const { targets, owner } = sourceTargets(ix, n);
			if (!owner && !targets.length)
				add({
					code: 'source-no-object',
					level: 'error',
					node: n.id,
					message: name + ' is in the scene graph and no Object Selector follows it, so no object can fire it.',
					fix: 'Wire it to an Object Selector naming the object, or move it into that object\'s own graph.'
				});
			for (const t of targets) if (!objects[t]) add({ code: 'missing-object', level: 'error', node: n.id, object: t, message: name + ' targets an object that is not in the scene.' });
			if (n.type === 'onclick' && w.play?.interaction === 'off')
				add({ code: 'clicks-off', level: 'warning', node: n.id, message: name + ': clicking is switched off in Play (scene physics ▸ play interaction "off"), so a player cannot click it.', fix: 'Set the play interaction to click or grab.' });
		}
		// 102b-papercuts (scout row 18): a per-frame EFFECT in the scene graph that reaches no object (no Object
		// Selector picking one, no target of its own) does nothing — the node editor card says so too
		if (
			w.isObjectEffect?.(n.type) &&
			!(n.type === 'script' && Array.isArray(n.data?.outputs) && n.data.outputs.length) &&
			(!n.__graph || n.__graph === 'scene') &&
			!(typeof n.data?.target === 'string' && n.data.target && n.data.target !== '-None-') &&
			!ix.out(n.id).some((/** @type {any} */ e) => {
				const t = ix.byId.get(e.target);
				return t?.type === 'objectselector' && t.data?.selected && t.data.selected !== '-None-';
			})
		)
			add({
				code: 'effect-no-object',
				level: 'warning',
				node: n.id,
				message: name + ' is in the scene graph and is not wired into an Object Selector that picks an object, so it acts on nothing.',
				fix: 'Wire it into an Object Selector naming the object, or move it into that object\'s own graph.'
			});
		// an ACTION with no source upstream never runs (kit actions, setgamestate, travel, spawn …)
		if (w.isAction(n.type) && !w.isSource(n.type)) {
			const triggerWired = ix.into(n.id).length > 0;
			if (!triggerWired || !sourcesUpstream(w, ix, n.id).length)
				add({
					code: 'action-no-source',
					level: triggerWired ? 'warning' : 'error',
					node: n.id,
					message: name + (triggerWired ? ' has wires in, but no event source (On Click, On Enter, a key, On Game State…) upstream,' : ' has nothing wired into it,') + ' so it never runs: action nodes run only when an upstream source fires.',
					fix: 'Wire a source into its trigger input (describe_node_types names the socket).'
				});
		}
		// 78 F13: Game Start is an action, not an event
		if (n.type === 'gamestart' && ix.out(n.id).length)
			add({
				code: 'gamestart-as-event',
				level: 'error',
				node: n.id,
				message: name + ' is wired as if it were an event, but Start camera (type gamestart, once called Game Start) never fires: it only switches to its camera when the game state becomes playing, so what hangs off it never runs.',
				fix: 'Use On Play start (fires once when Play begins) or On Game State (state: playing) as the event; start the round with Set Game State from a button or On Click.'
			});
		// HUD bindings to elements / screens that do not exist
		const field = HUD_FIELDS[n.type];
		if (field) {
			const ref = String(n.data?.[field] ?? '').trim();
			if (!ref)
				add({ code: 'hud-unbound', level: 'warning', node: n.id, message: name + ' names no HUD ' + field + ', so it shows nothing.', fix: 'Set its ' + field + ' to a HUD ' + field + ' id (hud list).' });
			else if (field === 'element' ? !elements.has(ref) : !screens.has(ref.toLowerCase()))
				add({ code: 'hud-missing', level: 'error', node: n.id, message: name + ' points at the HUD ' + field + ' "' + ref.slice(0, 40) + '", which does not exist.', fix: 'Pick a real ' + field + ' (hud list), or create it.' });
		}
		// a selector naming nothing / a missing object
		if (n.type === 'objectselector' && ix.into(n.id).length) {
			const sel = String(n.data?.selected ?? '');
			if (!sel) add({ code: 'selector-empty', level: 'warning', node: n.id, message: 'An Object Selector with wires in names no object, so what reaches it acts on nothing.' });
			else if (!objects[sel]) add({ code: 'missing-object', level: 'error', node: n.id, object: sel, message: 'An Object Selector names an object that is not in the scene.' });
		}
	}

	wiringIssues(w, ix, add);

	// walk mode with no way to stand anywhere (78 F11, H3)
	if (w.play?.grounded && !w.play?.spawn && !w.nodes.some((n) => n.type === 'charcontroller'))
		add({
			code: 'walk-no-spawn',
			level: 'warning',
			message: 'Play is set to walk, but there is no spawn point and no Character Controller node: players start wherever their camera happens to be.',
			fix: 'Set a spawn (game_setup spawn) or add a Character Controller node.'
		});
	// 78 F11: an all-static walk level starts its world on Play by itself; one with moving bodies
	// keeps the author's "run physics on Play" choice — and without it nothing stops a player
	const walks = !!w.play?.grounded || w.nodes.some((n) => n.type === 'charcontroller' && n.data?.mode === 'walk');
	if (walks && w.dynamicBodies === true && !w.play?.simOnPlay)
		add({
			code: 'walk-no-physics',
			level: 'warning',
			message: 'Play walks, but the scene has moving bodies and "run physics on Play" is off, so no physics world starts when someone presses Play: walls and floors will not stop players and sensors only feel the player.',
			fix: 'Start the simulation with control_simulation action start (it keeps running through Play), or ask the person to turn on "Start the simulation when play mode opens" in Scene, Physics.'
		});
	// unlit
	const lights = Object.values(objects).filter((o) => o.light).length;
	if (!lights && w.envLit === false)
		add({ code: 'unlit', level: 'warning', message: 'There is no light in the scene and the environment gives none, so everything renders dark.', fix: 'Add a light, or pick an environment preset.' });
	// behaviours (78 / 55: the analyzer's own words — a bare findAll, an unknown event …)
	for (const b of w.behaviours ?? [])
		for (const i of b.issues.slice(0, 5))
			add({ code: 'behaviour', level: 'warning', message: 'Behaviour "' + b.name + '"' + (i.line ? ' line ' + i.line : '') + ': ' + i.message, behaviour: b.name });

	return {
		ok: !issues.some((i) => i.level === 'error'),
		issues,
		checked: { nodes: w.nodes.length, edges: w.edges.length, behaviours: (w.behaviours ?? []).length }
	};
}

/** the stateful nodes whose `toggle` flips per press @type {Set<string>} */
const TOGGLES = new Set(['latch', 'moveto', 'rotateto', 'scaleto', 'lightswitch']);

/**
 * 2.0-n3b step 2: the WIRING mistakes the N3a agents made, each with the fix in one sentence — a value wired into an
 * event input, an edge into a handle that does not exist, an action used as an event, On Enter / On Exit listening
 * to something that is not a sensor, a pickup nothing hides, a toggle each person flips for themselves.
 * @param {World} w @param {ReturnType<typeof index>} ix @param {(issue: any) => void} add
 */
export function wiringIssues(w, ix, add) {
	const objects = w.objects ?? {};
	for (const e of w.edges) {
		const from = ix.byId.get(e.source);
		const to = ix.byId.get(e.target);
		if (!from || !to) continue;
		const sh = e.sourceHandle ?? undefined;
		const th = e.targetHandle ?? undefined;
		const bad = w.edgeHandleProblems?.(from, to, sh, th) ?? [];
		if (bad.length)
			add({ code: 'missing-handle', level: 'error', node: to.id, message: nodeName(from) + ' → ' + nodeName(to) + ': ' + bad[0] + '. The wire does nothing.', fix: 'Remove it and wire the named socket (describe_node_types lists them).' });
		const typed = w.edgeTypeProblem?.(from, to, sh, th);
		if (typed?.refuse)
			add({ code: 'value-into-event', level: 'error', node: to.id, message: typed.refuse.split(': ')[0] + ', so it never fires.', fix: typed.refuse.split(': ').slice(1).join(': ') });
		else if (typed?.warn)
			add({ code: 'fires-on-every-change', level: 'warning', node: to.id, message: typed.warn.split('. ')[0] + '.', fix: typed.warn.split('. ').slice(1).join('. ') });
		// an ACTION's output used as an event (gamestart has its own, older rule)
		if (from.type !== 'gamestart' && w.isAction(from.type) && !w.isSource(from.type) && to.type !== 'objectselector') {
			const input = w.inputsOf(to.type).find((i) => i.name === (th ?? 'trigger'));
			if (input?.type === 'event')
				add({
					code: 'action-as-event',
					level: 'error',
					node: from.id,
					message: nodeName(from) + ' is an action: nothing comes out of it, so ' + nodeName(to) + ' never fires.',
					fix: 'Wire the event that runs ' + nodeName(from) + ' (its On Click / On Enter / key) into ' + nodeName(to) + ' as well; a behaviour can this.emit() both.'
				});
		}
	}
	for (const n of w.nodes) {
		const name = nodeName(n);
		if (n.type === 'onenter' || n.type === 'onexit') {
			const { targets, owner } = sourceTargets(ix, n);
			const filtered = ix.into(n.id).some((e) => e.targetHandle === 'filter');
			const sensors = targets.filter((t) => objects[t]?.sensor);
			// physics reports a pair when ONE side is a sensor, but the player only ever as (sensor, 'player'):
			// a non-sensor never fires for the player, and fires for objects only when a sensor touches it
			const playerOnly = n.data?.who === 'player';
			const level = playerOnly ? 'error' : 'warning';
			const how = playerOnly ? 'so the player walking in never fires it' : 'so the player walking in never fires it (only a sensor touching it does)';
			if (owner && objects[owner] && !objects[owner].sensor && !targets.length)
				add({ code: 'not-a-sensor', level, node: n.id, object: owner, message: name + ' is in ' + objName(w, owner) + '\'s graph, but ' + objName(w, owner) + ' is not a sensor, ' + how + '.', fix: 'Make it a sensor: set_physics {uuid, sensor: true} (it stops blocking and starts reporting).' });
			else if (!owner && targets.length && !sensors.length)
				add({
					code: 'sensor-is-target',
					level,
					node: n.id,
					object: targets[0],
					message: 'In the scene graph, the object ' + name + ' reaches through an Object Selector is the sensor it listens to, and ' + objName(w, targets[0]) + ' is not a sensor, ' + how + '.',
					fix: 'Put ' + name + ' in the sensor\'s own graph (graph: the sensor uuid) and drive ' + objName(w, targets[0]) + ' by its target, or wire an Object Selector of the sensor into ' + name + '.filter.'
				});
			else if (!owner && !targets.length && !filtered)
				add({ code: 'sensor-any', level: 'warning', node: n.id, message: name + ' is in the scene graph with no sensor named, so it fires for EVERY sensor in the scene.', fix: 'Wire an Object Selector naming the sensor into its filter, or put it in the sensor\'s own graph.' });
		}
		// a Collect with nothing hiding the pickup (N3a pickup-own): the kit takes it, the object stays
		// (a Collect with "Hide when collected" — every one made since 2.0-n3b — hides it itself)
		if (n.type === 'kit-pickups-collect' && n.data?.hide !== true) {
			const graph = n.__graph ?? 'scene';
			const hidden = w.nodes.some((m) => m.type === 'kit-pickups-available' && (m.__graph ?? 'scene') === graph && ix.out(m.id).length);
			if (!hidden)
				add({
					code: 'pickup-stays',
					level: 'warning',
					node: n.id,
					message: name + ' takes the pickup, but nothing hides it, so it stays in view after it is taken.',
					fix: 'Turn on its "Hide when collected" (update_flow_nodes {hide: true}), or in the same graph: a = kit-pickups-available; v = visibility; a -> v.on.'
				});
		}
		// a toggle each person flips for themselves (a Per-player event: its pulse stays with the presser)
		for (const e of ix.into(n.id)) {
			if (e.targetHandle !== 'toggle' || !TOGGLES.has(n.type)) continue;
			const src = ix.byId.get(e.source);
			if (src?.data?.perPlayer)
				add({
					code: 'toggle-per-person',
					level: 'warning',
					node: n.id,
					message: name + '.toggle is fed by ' + nodeName(src) + ' that only fires for the person who pressed it, so each person flips their own copy and nobody else sees it.',
					fix: 'For something everyone shares, turn Per-player off on ' + nodeName(src) + ' (update_flow_nodes {perPlayer: false}); keep it only for something private.'
				});
		}
	}
}

/**
 * The fixed read projection of one node (inspect_runtime): what it is, where, its last pulse and count.
 * @param {World} w @param {any} n
 */
export function nodeRuntime(w, n) {
	const trig = w.triggers?.[n.id];
	/** @type {any} */
	const row = { id: n.id, type: n.type, name: nodeName(n), graph: n.__graph ?? 'scene' };
	if (row.graph !== 'scene') row.graphName = objName(w, row.graph);
	if (trig && Number.isFinite(trig.lastT)) {
		row.lastFired = { secondsAgo: r1(Math.max(0, stampAge(trig.lastT, w.now ?? trig.lastT))) };
		if (Number.isFinite(trig.count)) row.count = trig.count;
	} else if (w.isSource(n.type) || w.isAction(n.type)) row.lastFired = null;
	return row;
}

/**
 * "Why didn't X fire?" — for one node: when it last fired, and if it never did, the first missing link.
 * @param {World} w @param {string} id @returns {any}
 */
export function explainNode(w, id) {
	const ix = index(w);
	const n = ix.byId.get(id);
	if (!n) return { error: 'no flow node with id "' + String(id).slice(0, 64) + '"' };
	const name = nodeName(n);
	const rt = nodeRuntime(w, n);
	/** @type {string[]} */
	const why = [];
	const own = validateScene({ ...w, nodes: w.nodes, edges: w.edges }).issues.filter((i) => i.node === id);
	for (const i of own) why.push(i.message + (i.fix ? ' ' + i.fix : ''));
	if (w.isSource(n.type)) {
		if (OBJECT_SOURCES.has(n.type)) {
			const { targets, owner } = sourceTargets(ix, n);
			const on = owner ? [owner] : targets;
			if (on.length && !rt.lastFired) why.push(name + ' waits for ' + on.map((u) => objName(w, u)).join(', ') + ' to be ' + (n.type === 'onclick' ? 'clicked' : n.type === 'ongrab' ? 'grabbed' : 'hit') + ' in Play; nobody has yet.');
		} else if (!rt.lastFired) why.push(name + ' is a source: it fires when its event happens in Play (nothing has happened yet). playtest can make it happen.');
	} else {
		const sources = sourcesUpstream(w, ix, id);
		if (sources.length) {
			const fired = sources.map((s) => ({ s, t: w.triggers?.[s.id] })).filter((x) => x.t && Number.isFinite(x.t.lastT));
			if (!fired.length) why.push('Nothing upstream has fired yet: ' + sources.slice(0, 4).map(nodeName).join(', ') + (sources.length > 4 ? ' …' : '') + ' must fire first.');
			else {
				const last = fired.sort((a, b) => stampAge(/** @type {any} */ (a.t).lastT, w.now ?? 0) - stampAge(/** @type {any} */ (b.t).lastT, w.now ?? 0))[0];
				if (!rt.lastFired && w.isAction(n.type)) why.push(nodeName(last.s) + ' fired ' + r1(stampAge(/** @type {any} */ (last.t).lastT, w.now ?? 0)) + ' s ago but ' + name + ' did not run: check the nodes between them (a Latch that is set, a Once already spent, a Select on the other branch).');
			}
		} else if (!own.length && (w.isAction(n.type) || ix.into(n.id).length)) why.push('No event source upstream: ' + name + ' runs only when a source (On Click, On Enter, a key …) wired into it fires. Firing an action node directly does nothing.');
		else if (!own.length) why.push(name + ' is a value node: it is evaluated every frame, it does not fire.');
	}
	const upstream = ix.into(id).map((e) => ({ from: e.source, name: nodeName(ix.byId.get(e.source)), handle: e.targetHandle ?? undefined }));
	const downstream = ix.out(id).map((e) => ({ to: e.target, name: nodeName(ix.byId.get(e.target)), handle: e.targetHandle ?? undefined }));
	return { node: rt, why: why.length ? why : [rt.lastFired ? name + ' fired ' + rt.lastFired.secondsAgo + ' s ago.' : 'Nothing found in the wiring; it may simply not have been triggered yet.'], upstream, downstream };
}

// ---------------------------------------------------------------- playtest (R2)

/** most steps one playtest takes */
export const PLAYTEST_MAX_STEPS = 40;
/** longest playtest (seconds of simulated walking + waiting) */
export const PLAYTEST_MAX_SECONDS = 60;
/** walking speed (m/s) when the step does not say */
export const WALK_SPEED = 3;

/** @param {any} v @returns {number[] | null} */
const vec3 = (v) => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e5) ? v : null);

/**
 * The steps of a playtest, checked: `{walk: [[x,y,z],…], speed?}` · `{look: [x,y,z]}` · `{click: uuid}` ·
 * `{grab: uuid}` · `{key: 'KeyE', hold?: s}` · `{hud: elementId}` (press a HUD button) · `{wait: s}`.
 * @param {any} raw @returns {{steps: any[], seconds: number} | {error: string}}
 */
export function normalizePlaytest(raw) {
	if (!Array.isArray(raw) || !raw.length) return { error: 'steps: a list such as [{"walk": [[0,0,5]]}, {"click": "<uuid>"}, {"wait": 1}]' };
	if (raw.length > PLAYTEST_MAX_STEPS) return { error: 'at most ' + PLAYTEST_MAX_STEPS + ' steps per playtest' };
	/** @type {any[]} */
	const steps = [];
	let seconds = 0;
	for (let i = 0; i < raw.length; i++) {
		const s = raw[i] ?? {};
		const at = 'step ' + (i + 1) + ': ';
		const kinds = ['walk', 'look', 'click', 'grab', 'key', 'hud', 'wait'].filter((k) => s[k] !== undefined);
		if (kinds.length !== 1) return { error: at + 'give exactly one of walk, look, click, grab, key, hud, wait' };
		const kind = kinds[0];
		if (kind === 'walk') {
			const pts = /** @type {any[]} */ (Array.isArray(s.walk) && vec3(s.walk) ? [s.walk] : Array.isArray(s.walk) ? s.walk : []).map(vec3);
			if (!pts.length || pts.length > 50 || pts.some((p) => !p)) return { error: at + 'walk takes a point [x,y,z] or up to 50 points (metres)' };
			const speed = s.speed === undefined ? WALK_SPEED : Number(s.speed);
			if (!Number.isFinite(speed) || speed < 0.2 || speed > 20) return { error: at + 'speed: 0.2 to 20 m/s' };
			steps.push({ walk: pts, speed });
		} else if (kind === 'look') {
			if (!vec3(s.look)) return { error: at + 'look takes a point [x,y,z] to face' };
			steps.push({ look: s.look });
		} else if (kind === 'click' || kind === 'grab' || kind === 'hud') {
			if (typeof s[kind] !== 'string' || !s[kind] || s[kind].length > 64) return { error: at + kind + ' takes ' + (kind === 'hud' ? 'a HUD button element id' : 'an object uuid') };
			steps.push({ [kind]: s[kind] });
		} else if (kind === 'key') {
			if (typeof s.key !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(s.key)) return { error: at + 'key takes a key code such as "KeyE", "Space", "ArrowUp"' };
			const hold = s.hold === undefined ? 0.2 : Number(s.hold);
			if (!Number.isFinite(hold) || hold < 0 || hold > 10) return { error: at + 'hold: 0 to 10 seconds' };
			steps.push({ key: s.key, hold });
			seconds += hold;
		} else {
			const wait = Number(s.wait);
			if (!Number.isFinite(wait) || wait < 0 || wait > 30) return { error: at + 'wait: 0 to 30 seconds' };
			steps.push({ wait });
			seconds += wait;
		}
	}
	return { steps, seconds };
}

/** how long a walk takes (s) @param {number[]} from @param {number[][]} pts @param {number} speed */
export function walkSeconds(from, pts, speed) {
	let d = 0;
	let p = from;
	for (const q of pts) {
		d += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
		p = q;
	}
	return d / speed;
}

/**
 * What fired between two trigger snapshots: one row per node whose stamp moved, oldest first.
 * @param {Record<string, {lastT: number, count?: number}>} before @param {Record<string, {lastT: number, count?: number}>} after
 * @param {(id: string) => any} nodeOf @param {(uuid: string) => string} nameOf
 */
export function firedBetween(before, after, nodeOf, nameOf) {
	/** @type {any[]} */
	const rows = [];
	for (const [id, t] of Object.entries(after ?? {})) {
		const b = before?.[id];
		if (b && b.lastT === t.lastT && b.count === t.count) continue;
		const n = nodeOf(id);
		/** @type {any} */
		const row = { node: id, type: n?.type ?? 'node', name: n ? nodeName(n) : id, at: t.lastT };
		if (n?.__graph && n.__graph !== 'scene') row.on = nameOf(n.__graph) || n.__graph;
		const times = Number.isFinite(t.count) && Number.isFinite(b?.count) ? /** @type {number} */ (t.count) - /** @type {number} */ (b?.count) : null;
		if (times !== null && times > 1) row.times = times;
		rows.push(row);
	}
	return rows.sort((a, b) => a.at - b.at).map(({ at: _a, ...r }) => r);
}

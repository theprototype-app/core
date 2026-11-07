// Roadmap 85 R1-R4 + R8 (85b, lane 85-runtime) — SEE WHAT THE GAME DOES. The connector groups them as
// `run {inspect, validate, logs, playtest}`; local agents keep the fine names.
//
//   inspect_runtime  the sanctioned, read-only, agent-scoped version of the debugStores hook: FIXED read
//                    projections (the trigger log, the game shell, the kit's document + authority, behaviour
//                    and script errors, who simulates) and "why didn't X fire" for one node or object. No store
//                    handle leaves this file and nothing here writes.
//   validate_scene   the playability lint (runtimeCore.validateScene): what will not work when someone presses Play
//   logs             the page's diagnostics ring + toast history since a moment (status() carries the newest few)
//   playtest         a virtual player in the AGENT PAGE's own Play (B4b: never on a person's page): walk, look,
//                    click, grab, press a key or a HUD button, wait — then what fired, the HUD and the errors
//
// Schemas live in the registry getAiTools builds, so the in-app assistant, the agent page, the bridge and the
// connector catalog list one definition. Everything heavy loads on first use (flowRuntime, physics, the kit
// and playMode are history-family; this module sits in the assistant's static graph and the catalog's SSR load).
import { get } from 'svelte/store';
import { objectsGroup, isLocked, globalCamera } from '../../stores/sceneStore.js';
import { notifications } from '../../stores/appStore.js';
import { allNodes, allEdges, flowTriggers, scriptErrors } from '../../stores/flowStore.js';
import { hudDocs, hudRuntime } from '$lib/hudDocs.js';
import { gameState } from '$lib/gameState.js';
import { entries as diagnosticEntries, redactSecrets } from '$lib/diagnostics.js';
import { sessionNow } from '$lib/sessionClock.js';
import { behaviourHost } from './aiExtensions.js';
import {
	validateScene,
	explainNode,
	nodeRuntime,
	normalizePlaytest,
	walkSeconds,
	firedBetween,
	PLAYTEST_MAX_STEPS,
	PLAYTEST_MAX_SECONDS
} from './runtimeCore.js';

/** the tool names this module answers */
export const RUNTIME_TOOL_NAMES = ['inspect_runtime', 'validate_scene', 'logs', 'playtest', 'take_photo'];
/** the read-only ones (viewers may run them; the connector's read scope allows them) */
export const RUNTIME_READ_TOOLS = ['inspect_runtime', 'validate_scene', 'logs'];

/** most log lines one call returns */
const LOGS_MAX = 100;
/** the eye above the floor while walking (m) */
const EYE = 1.6;
/** node types an action runs from only when their trigger fires (the rest also run with nothing wired) */
const TRIGGERED_ACTIONS = new Set(['setgamestate', 'travel', 'spawn', 'impulse', 'setvelocity', 'hudscreen', 'hudset', 'setcamera', 'attachsocket', 'joint']);

/** the trigger clock: synced seconds of the day (flowRuntime's syncedNow) */
const triggerNow = () => (sessionNow() % 86400000) / 1000;

/** @param {string} uuid */
const objectOf = (uuid) => /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid);

/** the socket tables, loaded once (flowSockets is a leaf; the kit's action set needs the kit catalog) */
/** @type {Promise<{isSource: (t: string) => boolean, isAction: (t: string) => boolean, inputsOf: (t: string) => {name: string, type: string}[]}> | null} */
let typeInfoP = null;
function typeInfo() {
	typeInfoP ??= Promise.all([import('$lib/flowSockets'), import('$lib/kit/nodes.js').catch(() => null)]).then(([s, kit]) => {
		/** @param {string} t */
		const inputsOf = (t) => s.inputHandles(t).map((name) => ({ name, type: s.inputType(t, name) }));
		/** @param {string} t */
		const isSource = (t) => s.outputType(t) === 'event' && !inputsOf(t).some((i) => i.type === 'event');
		const kitActions = kit?.KIT_ACTION_TYPES ?? new Set();
		/** @param {string} t */
		const isAction = (t) => TRIGGERED_ACTIONS.has(t) || kitActions.has(t);
		return { isSource, isAction, inputsOf };
	});
	return typeInfoP;
}

/** every object of the scene, by uuid (names, lights) */
function sceneObjects() {
	/** @type {Record<string, {name: string, type: string, light?: boolean, visible?: boolean}>} */
	const out = {};
	const group = /** @type {any} */ (get(objectsGroup));
	group?.traverse?.((/** @type {any} */ o) => {
		if (o === group) return;
		out[o.uuid] = { name: String(o.name ?? ''), type: String(o.type ?? ''), ...(o.isLight ? { light: true } : {}), ...(o.visible === false ? { visible: false } : {}) };
	});
	return out;
}

/** does the environment rig (or an HDRI) light the scene? */
function environmentLights() {
	let root = /** @type {any} */ (get(objectsGroup));
	while (root?.parent) root = root.parent;
	if (!root) return true;
	if (root.environment) return true;
	let lit = false;
	root.traverse?.((/** @type {any} */ o) => {
		if (!lit && o.isLight && !(o.parent && o.parent === get(objectsGroup)) && Number(o.intensity) > 0.05) lit = true;
	});
	return lit;
}

/** the HUD's element ids and screen ids + names */
function hudIndex() {
	/** @type {string[]} */
	const elements = [];
	/** @type {string[]} */
	const screens = [];
	for (const doc of Object.values(/** @type {any} */ (get(hudDocs)) ?? {}))
		for (const s of doc?.screens ?? []) {
			screens.push(String(s.id), String(s.name ?? ''));
			for (const el of s.elements ?? []) elements.push(String(el.id));
		}
	return { elements, screens };
}

/** the World runtimeCore reads @returns {Promise<import('./runtimeCore.js').World>} */
async function world() {
	const info = await typeInfo();
	const [scenePhysics] = await Promise.all([import('$lib/scenePhysics').catch(() => null)]);
	const host = /** @type {any} */ (behaviourHost());
	/** @type {{name: string, issues: any[]}[]} */
	const behaviours = [];
	for (const n of allNodes()) {
		if (n.type !== 'behaviour' || typeof n.data?.code !== 'string') continue;
		let issues = [];
		try {
			issues = host?.lint ? host.lint(String(n.data.code)) : [];
		} catch {}
		behaviours.push({ name: String(n.data?.name ?? 'Behaviour'), issues });
	}
	const hud = hudIndex();
	return {
		nodes: allNodes(),
		edges: allEdges(),
		triggers: get(flowTriggers),
		now: triggerNow(),
		objects: sceneObjects(),
		hudElements: hud.elements,
		hudScreens: hud.screens,
		play: scenePhysics ? get(scenePhysics.scenePlay) : undefined,
		envLit: environmentLights(),
		behaviours,
		...info
	};
}

// ---------------------------------------------------------------- inspect_runtime (R1)

/** the shared game shell, as read-only numbers */
function gameView() {
	const g = /** @type {any} */ (get(gameState));
	const vars = Object.fromEntries(Object.entries(g.vars ?? {}).slice(0, 40));
	return { state: g.state, round: g.round, ...(g.outcome ? { outcome: g.outcome } : {}), vars };
}

/** who steps the physics, who decides the kit */
async function authorityView() {
	const [physics, kit] = await Promise.all([import('$lib/physics').catch(() => null), import('$lib/kit/runtime.js').catch(() => null)]);
	/** @type {any} */
	const out = {};
	if (physics) {
		const here = get(physics.simulating);
		const remote = get(physics.remoteSimulating);
		out.simulation = here ? { running: true, by: 'this page' } : remote ? { running: true, by: remote } : { running: false };
	}
	if (kit) {
		try {
			const d = kit.kitDebug();
			out.kit = { authority: d.authority ?? null, me: d.me ?? null, ...(d.stats ? { stats: d.stats } : {}), ...kitDocSummary(d.doc) };
		} catch {}
	}
	return out;
}

/** the kit document, trimmed to what an agent reads (scores, round, pickups taken) @param {any} doc */
function kitDocSummary(doc) {
	if (!doc || typeof doc !== 'object') return {};
	/** @type {any} */
	const out = {};
	for (const [piece, state] of Object.entries(doc)) {
		if (!state || typeof state !== 'object' || piece === 'by' || piece === 'at') continue;
		const s = /** @type {any} */ (state);
		if (piece === 'pickups') out.pickups = { taken: Object.keys(s.taken ?? {}).length };
		else if (piece === 'score') out.score = { total: s.total, players: s.players ?? s.rows };
		else if (piece === 'round') out.round = { state: s.state, number: s.round ?? s.number };
	}
	return Object.keys(out).length ? { doc: out } : {};
}

/** @param {any} args */
async function inspectRuntime(args) {
	const w = await world();
	const base = {
		playingHere: get(isLocked) === true,
		game: gameView(),
		...(await authorityView())
	};
	const host = /** @type {any} */ (behaviourHost());
	const behaviourErrs = (() => {
		try {
			return host?.errors?.() ?? [];
		} catch {
			return [];
		}
	})();
	const scriptErrs = Object.entries(/** @type {Record<string, string>} */ (get(scriptErrors))).slice(0, 10).map(([node, message]) => ({ node, message: String(message).slice(0, 200) }));
	const errors = [...behaviourErrs.slice(0, 10), ...scriptErrs];
	if (typeof args?.node === 'string' && args.node) return { ...base, ...explainNode(w, args.node), ...(errors.length ? { errors } : {}) };
	if (typeof args?.object === 'string' && args.object) {
		const o = objectOf(args.object);
		if (!o) return { error: 'no object with uuid "' + args.object.slice(0, 64) + '"' };
		// its own graph + every source in the scene that reaches it through a selector
		const mine = w.nodes.filter((n) => n.__graph === args.object);
		const viaSelector = w.nodes.filter(
			(n) => n.type === 'objectselector' && n.data?.selected === args.object
		);
		const feeding = new Set(w.edges.filter((e) => viaSelector.some((s) => s.id === e.target)).map((e) => e.source));
		const related = [...mine, ...w.nodes.filter((n) => feeding.has(n.id))];
		const explained = related
			.filter((n) => w.isSource(n.type) || w.isAction(n.type))
			.slice(0, 12)
			.map((n) => explainNode(w, n.id))
			.map((x) => ({ node: x.node, why: x.why }));
		return {
			...base,
			object: { uuid: o.uuid, name: o.name, visible: o.visible !== false, ...(o.userData?.physics?.mode ? { physics: o.userData.physics.mode } : {}) },
			nodes: related.slice(0, 40).map((n) => nodeRuntime(w, n)),
			explain: explained,
			...(errors.length ? { errors } : {})
		};
	}
	// the overview: every source and action, most recently fired first
	const rows = w.nodes.filter((n) => w.isSource(n.type) || w.isAction(n.type) || n.type === 'counter' || n.type === 'latch' || n.type === 'once').map((n) => nodeRuntime(w, n));
	rows.sort((a, b) => (a.lastFired?.secondsAgo ?? Infinity) - (b.lastFired?.secondsAgo ?? Infinity));
	const limit = Math.max(1, Math.min(80, Number(args?.limit) || 40));
	return {
		...base,
		nodes: rows.slice(0, limit),
		...(rows.length > limit ? { more: rows.length - limit } : {}),
		hud: hudValues(),
		...(errors.length ? { errors } : {}),
		note: 'Read-only. Pass node (an id) or object (a uuid) for "why didn\'t it fire". Sources fire in Play; playtest (agent page) can make them fire.'
	};
}

/** what the HUD shows right now (element id -> value), capped */
function hudValues() {
	return Object.fromEntries(Object.entries(/** @type {Record<string, any>} */ (get(hudRuntime)) ?? {}).slice(0, 40).map(([k, v]) => [k, typeof v === 'object' && v !== null ? (v.text ?? v.value ?? v) : v]));
}

// ---------------------------------------------------------------- logs (R3)

/**
 * The page's log since a moment: diagnostics lines (errors, warnings, the console) and the toasts people saw.
 * @param {{since?: number, level?: string, limit?: number}} [args]
 */
export function logsTool(args = {}) {
	const since = Number.isFinite(Number(args.since)) ? Number(args.since) : 0;
	const order = ['debug', 'info', 'warn', 'error'];
	const floor = Math.max(0, order.indexOf(String(args.level ?? 'info')));
	const limit = Math.max(1, Math.min(LOGS_MAX, Number(args.limit) || 40));
	const lines = diagnosticEntries()
		.filter((e) => (e.last ?? e.t) > since && order.indexOf(e.level) >= floor)
		.map((e) => ({ at: e.last ?? e.t, level: e.level, scope: e.scope, text: redactSecrets(e.message + (e.data ? ' ' + e.data : '')).slice(0, 300), ...(e.n && e.n > 1 ? { times: e.n } : {}) }));
	const toasts = (/** @type {any[]} */ (get(notifications)) ?? [])
		.filter((n) => Number(n?.ts) > since)
		.map((n) => ({ at: Number(n.ts), level: 'toast', text: redactSecrets(String(n.text ?? '')).slice(0, 300) }));
	const all = [...lines, ...toasts].sort((a, b) => a.at - b.at);
	return { now: Date.now(), lines: all.slice(-limit), ...(all.length > limit ? { more: all.length - limit } : {}), note: 'Pass since (the "now" of this answer) next time for only what is new.' };
}

/** R3: the newest few for status(): errors and warnings, then toasts @returns {{at: number, level: string, text: string}[]} */
export function recentLogs(count = 5) {
	try {
		const all = logsTool({ level: 'warn', limit: count }).lines;
		const toasts = logsTool({ limit: 50 }).lines.filter((l) => l.level === 'toast').slice(-count);
		return [...all, ...toasts].sort((a, b) => a.at - b.at).slice(-count);
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------- playtest (R2)

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {any} args */
async function playtest(args) {
	const { agentRequested } = await import('$lib/agent/agentMode.js');
	if (!agentRequested())
		return {
			error: 'playtest runs only on an agent page (the agent\'s own Play), never on a person\'s tab. Use validate_scene and inspect_runtime here, or ask the person to press Play.',
			refused: true
		};
	const plan = normalizePlaytest(args?.steps);
	if ('error' in plan) return { error: plan.error };
	const camera = /** @type {any} */ (get(globalCamera));
	if (!camera) return { error: 'The 3D view is not ready yet.' };
	const [flow, playMode, diag] = await Promise.all([import('$lib/flowRuntime'), import('$lib/playMode'), Promise.resolve(diagnosticEntries)]);
	// budget: the walks at their speeds plus the waits
	let from = camera.position.toArray();
	let seconds = plan.seconds;
	for (const s of plan.steps)
		if (s.walk) {
			seconds += walkSeconds([from[0], from[1] - EYE, from[2]], s.walk, s.speed);
			from = [...s.walk[s.walk.length - 1]];
			from[1] += EYE;
		}
	if (seconds > PLAYTEST_MAX_SECONDS) return { error: 'that playtest would take ' + Math.round(seconds) + ' s; at most ' + PLAYTEST_MAX_SECONDS + ' s (split it into several calls)' };

	const startedAt = Date.now();
	const before = structuredClone(get(flowTriggers));
	const gameBefore = gameView();
	const wasPlaying = get(isLocked) === true;
	if (!wasPlaying) {
		playMode.requestPlay({ flat: true });
		for (let i = 0; i < 20 && get(isLocked) !== true; i++) await sleep(50);
	}
	/** @type {any[]} */
	const log = [];
	try {
		for (const s of plan.steps) {
			if (s.walk) {
				for (const p of s.walk) {
					const to = [p[0], p[1] + EYE, p[2]];
					const start = camera.position.toArray();
					const dist = Math.hypot(to[0] - start[0], to[1] - start[1], to[2] - start[2]);
					const steps = Math.max(1, Math.ceil(dist / s.speed / 0.1));
					for (let i = 1; i <= steps; i++) {
						const t = i / steps;
						camera.position.set(start[0] + (to[0] - start[0]) * t, start[1] + (to[1] - start[1]) * t, start[2] + (to[2] - start[2]) * t);
						camera.updateMatrixWorld?.();
						await sleep(100);
					}
				}
				log.push({ did: 'walked to', at: s.walk[s.walk.length - 1] });
			} else if (s.look) {
				camera.lookAt(s.look[0], s.look[1], s.look[2]);
				camera.updateMatrixWorld?.();
				log.push({ did: 'looked at', at: s.look });
			} else if (s.click || s.grab) {
				const uuid = s.click ?? s.grab;
				const o = objectOf(uuid);
				if (!o) {
					log.push({ did: s.click ? 'click' : 'grab', error: 'no object with that uuid' });
					continue;
				}
				const reached = s.click ? flow.fireObjectClick(uuid) : flow.fireObjectGrab(uuid);
				log.push({ did: s.click ? 'clicked' : 'grabbed', object: o.name || uuid, reached, ...(reached ? {} : { note: 'nothing listens for a ' + (s.click ? 'click' : 'grab') + ' on it (no On ' + (s.click ? 'Click' : 'Grab') + ' reaches it)' }) });
				await sleep(150);
			} else if (s.hud) {
				flow.fireHudButton(s.hud);
				log.push({ did: 'pressed HUD button', element: s.hud });
				await sleep(150);
			} else if (s.key) {
				window.dispatchEvent(new KeyboardEvent('keydown', { code: s.key, key: s.key }));
				await sleep(s.hold * 1000);
				window.dispatchEvent(new KeyboardEvent('keyup', { code: s.key, key: s.key }));
				log.push({ did: 'pressed key', key: s.key });
			} else if (s.wait !== undefined) {
				await sleep(s.wait * 1000);
				log.push({ did: 'waited', seconds: s.wait });
			}
		}
		await sleep(300); // a pulse made by the last step reaches its consumers on the next ticks
	} finally {
		if (!wasPlaying && args?.stayInPlay !== true) playMode.exitPlay();
	}
	const nodesNow = allNodes();
	const byId = new Map(nodesNow.map((n) => [n.id, n]));
	const fired = firedBetween(before, get(flowTriggers), (id) => byId.get(id), (u) => String(objectOf(u)?.name ?? ''));
	const errors = diag()
		.filter((e) => (e.last ?? e.t) >= startedAt && (e.level === 'error' || e.level === 'warn'))
		.slice(-15)
		.map((e) => ({ level: e.level, text: redactSecrets(e.message).slice(0, 200) }));
	const host = /** @type {any} */ (behaviourHost());
	const behaviourErrs = (host?.errors?.() ?? []).filter((/** @type {any} */ e) => !Number.isFinite(e.at) || e.at >= startedAt).slice(0, 10);
	return {
		steps: log,
		fired: fired.slice(0, 60),
		...(fired.length > 60 ? { moreFired: fired.length - 60 } : {}),
		game: { before: gameBefore, after: gameView() },
		hud: hudValues(),
		...(errors.length || behaviourErrs.length ? { errors: [...errors, ...behaviourErrs] } : {}),
		seconds: Math.round((Date.now() - startedAt) / 100) / 10,
		note: fired.length ? undefined : 'Nothing fired. inspect_runtime {node} says why a node did not.'
	};
}

// ---------------------------------------------------------------- the dispatch

/** @param {string} name @param {any} args @returns {Promise<any>} */
export async function runtimeTool(name, args) {
	switch (name) {
		case 'inspect_runtime':
			return inspectRuntime(args ?? {});
		case 'validate_scene': {
			const r = validateScene(await world());
			return { ...r, say: r.issues.length ? r.issues.length + ' thing(s) to fix, ' + r.issues.filter((i) => i.level === 'error').length + ' that stop the game working.' : 'Nothing found that would stop the game working.' };
		}
		case 'logs':
			return logsTool(args ?? {});
		case 'playtest':
			return playtest(args ?? {});
		case 'take_photo':
			return takePhotoTool(args ?? {});
		default:
			return { error: 'unknown tool ' + name };
	}
}

/**
 * 98 P2 (98-photo): a path-traced still of the person's CURRENT view (connector `run {action: 'photo'}`).
 * Runs in this tab (or a PC peer's when this is a Quest / weak phone; else a plain raster still), never
 * moves anybody's view; `save` files the PNG in the Library under Scene shots/<scene>.
 * @param {any} args
 */
async function takePhotoTool(args) {
	const m = await import('$lib/photo/photoMode.js');
	const s = await m.startPhoto({ samples: args.samples, seconds: args.seconds, denoise: args.denoise });
	if (s.status !== 'done' || !s.blob) return { error: s.error || 'No photo was made.' };
	/** @type {any} */
	let saved = null;
	if (args.save === true) saved = await m.savePhotoToScene().catch((/** @type {any} */ e) => ({ error: String(e?.message ?? e) }));
	const image_url = await new Promise((res) => {
		const r = new FileReader();
		r.onload = () => res(String(r.result));
		r.onerror = () => res('');
		r.readAsDataURL(/** @type {Blob} */ (s.blob));
	});
	const where = s.place === 'peer' ? 'on a PC in the session' : s.place === 'raster' ? 'as a normal still (this device cannot path-trace)' : 'path-traced here';
	return {
		say: 'Took a photo of your view, ' + where + (s.samples ? ', ' + s.samples + ' samples' : '') + (saved && !saved.error ? ', saved to the Library.' : '.'),
		place: s.place,
		...(s.place !== 'here' && s.why ? { why: s.why } : {}),
		samples: s.samples,
		ms: s.ms,
		width: s.width,
		height: s.height,
		reason: s.reason,
		...(s.notes.length ? { notShown: s.notes.map((n) => n.note) } : {}),
		...(saved ? { saved } : {}),
		image_url
	};
}

/** the assistant's OpenAI-format schemas */
export const RUNTIME_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'inspect_runtime',
			description:
				'Read what the game is doing right now, without changing anything: when each event and action node last fired, the game state and variables, who runs the physics and the game rules, behaviour and script errors, and what the HUD shows. ' +
				'Pass node (a flow node id) or object (a uuid) to ask "why didn\'t it fire?": it names the missing link (no source upstream, a selector wired the wrong way, nothing clicked it yet). Action nodes run only when an upstream source fires; firing one directly does nothing.',
			parameters: {
				type: 'object',
				properties: {
					node: { type: 'string', description: 'a flow node id: explain this node' },
					object: { type: 'string', description: 'an object uuid: its nodes and why they did or did not fire' },
					limit: { type: 'integer', minimum: 1, maximum: 80, description: 'overview: how many nodes (default 40)' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'validate_scene',
			description:
				'Check the scene for what would not work when someone presses Play: actions nothing fires, an Object Selector wired the wrong way round, a scene-graph On Click that reaches no object, Game Start wired as an event, HUD nodes pointing at elements that do not exist, walk mode with no spawn, a scene with no light, behaviour code problems. Each issue says what to fix. Run it after building a game, then playtest.',
			parameters: { type: 'object', properties: {} }
		}
	},
	{
		type: 'function',
		function: {
			name: 'logs',
			description:
				'The page\'s recent log: errors, warnings, console lines and the toasts people saw, oldest first. Pass since (the "now" of the previous answer) for only what is new. status shows the newest few.',
			parameters: {
				type: 'object',
				properties: {
					since: { type: 'number', description: 'only lines after this time (ms since 1970, the "now" a previous logs answer gave)' },
					level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: 'the lowest level to include (default info)' },
					limit: { type: 'integer', minimum: 1, maximum: LOGS_MAX, description: 'most lines (default 40)' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'playtest',
			description:
				'Play the game as a virtual player in YOUR OWN Play (agent page only; it never moves a person): walk a path, look at a point, click or grab an object, press a key or a HUD button, wait. Then it reports which nodes fired, the game state before and after, what the HUD shows and any errors. ' +
				'It fires SOURCES the way a player does (a click reaches On Click nodes); a step on an action node does nothing. Walk points are on the floor; your eye is ' +
				EYE +
				' m above them. Clicks and pickups count for real in the shared game, like a person playing.',
			parameters: {
				type: 'object',
				properties: {
					steps: {
						type: 'array',
						maxItems: PLAYTEST_MAX_STEPS,
						description: 'in order, each ONE of: {walk: [[x,y,z], …], speed?} · {look: [x,y,z]} · {click: uuid} · {grab: uuid} · {key: "KeyE", hold?} · {hud: elementId} · {wait: seconds}',
						items: {
							type: 'object',
							properties: {
								walk: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'floor points to walk through' },
								speed: { type: 'number', description: 'walking speed m/s (default 3)' },
								look: { type: 'array', items: { type: 'number' }, description: '[x,y,z] to face' },
								click: { type: 'string', description: 'object uuid' },
								grab: { type: 'string', description: 'object uuid' },
								key: { type: 'string', description: 'a key code: KeyE, Space, ArrowUp …' },
								hold: { type: 'number', description: 'seconds to hold the key (default 0.2)' },
								hud: { type: 'string', description: 'a HUD button element id' },
								wait: { type: 'number', description: 'seconds' }
							}
						}
					},
					stayInPlay: { type: 'boolean', description: 'keep this page in Play afterwards (default: leave Play if the playtest entered it)' }
				},
				required: ['steps']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'take_photo',
			description:
				"A PHOTO of the person's current view: a path-traced still (soft shadows, real reflections and glass), rendered in their tab while they keep working; their view never moves. It takes seconds to a minute: samples (1-2048, default 256) or seconds (2-600, default 60), whichever comes first. " +
				'On a Quest or a weak phone a PC in the session renders it; with no PC it is a normal still and the answer says why. Post effects, flat text, particles and your own GLSL are not in a photo (notShown lists what was left out). save: true also files the PNG in the Library under Scene shots. Use it when the person asks for a photo, a render or a nice picture of the scene; for checking your work use screenshot.',
			parameters: {
				type: 'object',
				properties: {
					samples: { type: 'integer', minimum: 1, maximum: 2048, description: 'path-tracing samples (more = cleaner, slower; default 256)' },
					seconds: { type: 'number', minimum: 2, maximum: 600, description: 'time limit in seconds (default 60)' },
					denoise: { type: 'boolean', description: 'smooth the remaining noise (default true)' },
					save: { type: 'boolean', description: 'also save the PNG to the Library under Scene shots/<scene> (default false)' }
				}
			}
		}
	}
];

/** the system-prompt line */
export const RUNTIME_PROMPT =
	'\nAfter building a game, call validate_scene and fix what it reports; inspect_runtime {node} says why a node did not fire; playtest (agent page) plays it; logs shows errors. Never start the simulation yourself unless the person asks.';

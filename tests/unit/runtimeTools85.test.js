// 85b R1 / R2 / R4 / R8 — the pure half of inspect_runtime, validate_scene and playtest (runtimeCore.js).
import { describe, it, expect } from 'vitest';
import { validateScene, explainNode, nodeRuntime, normalizePlaytest, firedBetween, stampAge, walkSeconds, PLAYTEST_MAX_STEPS } from '../../src/lib/ai/runtimeCore.js';

const SOURCES = new Set(['onclick', 'ongrab', 'onenter', 'keypress', 'ongamestate', 'kit-pickups-collected']);
const ACTIONS = new Set(['kit-pickups-collect', 'setgamestate', 'travel', 'hudscreen']);
const INPUTS = /** @type {Record<string, {name: string, type: string}[]>} */ ({
	onenter: [{ name: 'filter', type: 'object' }],
	'kit-pickups-collect': [{ name: 'trigger', type: 'event' }, { name: 'pickup', type: 'object' }],
	setgamestate: [{ name: 'trigger', type: 'event' }]
});

/** @param {Partial<import('../../src/lib/ai/runtimeCore.js').World>} w */
const world = (w) => ({
	nodes: [],
	edges: [],
	triggers: {},
	now: 1000,
	objects: { gem: { name: 'Gem_1' }, lamp: { name: 'Lamp', light: true } },
	hudElements: ['score'],
	hudScreens: ['main', 'Main'],
	play: { interaction: 'grab', grounded: false },
	envLit: true,
	behaviours: [],
	isSource: (/** @type {string} */ t) => SOURCES.has(t),
	isAction: (/** @type {string} */ t) => ACTIONS.has(t),
	inputsOf: (/** @type {string} */ t) => INPUTS[t] ?? [],
	...w
});

const codes = (/** @type {any} */ r) => r.issues.map((/** @type {any} */ i) => i.code);

describe('85b validate_scene', () => {
	it('a clean collectible graph passes', () => {
		const r = validateScene(
			world({
				nodes: [
					{ id: 'c', type: 'onclick', __graph: 'gem' },
					{ id: 'k', type: 'kit-pickups-collect', __graph: 'gem' },
					{ id: 't', type: 'hudtext', data: { element: 'score' } }
				],
				edges: [{ source: 'c', target: 'k', targetHandle: 'trigger' }]
			})
		);
		expect(r.ok).toBe(true);
		expect(r.issues).toEqual([]);
	});

	it('R8: an Object Selector wired INTO an On Click is the wrong way round', () => {
		const r = validateScene(
			world({
				nodes: [
					{ id: 's', type: 'objectselector', data: { selected: 'gem' } },
					{ id: 'c', type: 'onclick' }
				],
				edges: [{ source: 's', target: 'c' }]
			})
		);
		expect(codes(r)).toContain('reversed-selector');
		expect(r.ok).toBe(false);
	});

	it('R8 leaves a declared object input alone (On Enter filter)', () => {
		const r = validateScene(
			world({
				nodes: [
					{ id: 's', type: 'objectselector', data: { selected: 'gem' } },
					{ id: 'e', type: 'onenter', __graph: 'gem' }
				],
				edges: [{ source: 's', target: 'e', targetHandle: 'filter' }]
			})
		);
		expect(codes(r)).not.toContain('reversed-selector');
	});

	it('a scene-graph On Click with no selector reaches no object', () => {
		expect(codes(validateScene(world({ nodes: [{ id: 'c', type: 'onclick' }] })))).toContain('source-no-object');
	});

	it('an action with nothing upstream never runs; one with only values upstream is a warning', () => {
		const r = validateScene(
			world({
				nodes: [
					{ id: 'a', type: 'setgamestate' },
					{ id: 'n', type: 'number' },
					{ id: 'b', type: 'travel' }
				],
				edges: [{ source: 'n', target: 'b' }]
			})
		);
		const rows = r.issues.filter((/** @type {any} */ i) => i.code === 'action-no-source');
		expect(rows.map((/** @type {any} */ i) => [i.node, i.level])).toEqual([
			['a', 'error'],
			['b', 'warning']
		]);
	});

	it('Game Start wired as an event, HUD bindings, walk without spawn, unlit, behaviour issues', () => {
		const r = validateScene(
			world({
				nodes: [
					{ id: 'g', type: 'gamestart' },
					{ id: 'x', type: 'counter' },
					{ id: 'h', type: 'hudtext', data: { element: 'nope' } },
					{ id: 'h2', type: 'hudbar', data: { element: '' } },
					{ id: 'sc', type: 'hudscreen', data: { screen: 'main' } }
				],
				edges: [{ source: 'g', target: 'x' }],
				objects: {},
				envLit: false,
				play: { grounded: true },
				behaviours: [{ name: 'Rules', issues: [{ line: 3, message: 'findAll needs this.' }] }]
			})
		);
		expect(codes(r)).toEqual(expect.arrayContaining(['gamestart-as-event', 'hud-missing', 'hud-unbound', 'walk-no-spawn', 'unlit', 'behaviour']));
		expect(codes(r)).not.toContain('hud-missing-screen');
		expect(r.issues.find((/** @type {any} */ i) => i.code === 'hud-missing').node).toBe('h');
		// every issue is a sentence
		for (const i of r.issues) expect(i.message).toMatch(/\.$|this\.$/);
	});

	it('clicks switched off in Play are reported', () => {
		const r = validateScene(world({ nodes: [{ id: 'c', type: 'onclick', __graph: 'gem' }], play: { interaction: 'off' } }));
		expect(codes(r)).toEqual(['clicks-off']);
	});
});

describe('85b inspect_runtime — why did it not fire', () => {
	const nodes = [
		{ id: 'c', type: 'onclick', __graph: 'gem', data: { label: 'Gem click' } },
		{ id: 'k', type: 'kit-pickups-collect', __graph: 'gem' }
	];
	const edges = [{ source: 'c', target: 'k', targetHandle: 'trigger' }];

	it('a source nobody triggered yet says what it waits for', () => {
		const x = explainNode(world({ nodes, edges }), 'c');
		expect(x.node.lastFired).toBeNull();
		expect(x.why.join(' ')).toMatch(/waits for Gem_1 to be clicked/);
		expect(x.downstream).toEqual([{ to: 'k', name: 'kit-pickups-collect', handle: 'trigger' }]);
	});

	it('an action whose source has not fired names the source', () => {
		expect(explainNode(world({ nodes, edges }), 'k').why.join(' ')).toMatch(/Nothing upstream has fired yet: Gem click/);
	});

	it('a fired node reports how long ago', () => {
		const x = explainNode(world({ nodes, edges, triggers: { c: { lastT: 990, count: 2 }, k: { lastT: 990.1, count: 1 } } }), 'k');
		expect(x.node.lastFired.secondsAgo).toBe(9.9);
		expect(x.why[0]).toMatch(/fired 9\.9 s ago/);
	});

	it('an unknown id is an error; the trigger clock wraps at midnight', () => {
		expect(explainNode(world({}), 'zz').error).toMatch(/no flow node/);
		expect(stampAge(86399, 1)).toBe(2);
		expect(nodeRuntime(world({ triggers: { c: { lastT: 86399, count: 1 } }, now: 1 }), nodes[0]).lastFired.secondsAgo).toBe(2);
	});
});

describe('85b playtest steps', () => {
	it('normalizes each kind and adds up the waits', () => {
		const r = /** @type {any} */ (normalizePlaytest([{ walk: [0, 0, 4] }, { look: [0, 1, 0] }, { click: 'gem' }, { key: 'KeyE', hold: 0.5 }, { hud: 'start' }, { wait: 2 }]));
		expect(r.steps[0]).toEqual({ walk: [[0, 0, 4]], speed: 3 });
		expect(r.seconds).toBe(2.5);
	});

	it('refuses what it cannot do', () => {
		expect(normalizePlaytest([])).toHaveProperty('error');
		expect(normalizePlaytest([{ walk: [[0, 0]] }])).toHaveProperty('error');
		expect(normalizePlaytest([{ click: 'a', wait: 1 }])).toHaveProperty('error');
		expect(normalizePlaytest([{ wait: 99 }])).toHaveProperty('error');
		expect(normalizePlaytest([{ key: 'Key E' }])).toHaveProperty('error');
		expect(normalizePlaytest(Array(PLAYTEST_MAX_STEPS + 1).fill({ wait: 0 }))).toHaveProperty('error');
	});

	it('walk time and what fired between two trigger logs', () => {
		expect(walkSeconds([0, 0, 0], [[3, 0, 4]], 5)).toBe(1);
		const nodes = new Map([
			['c', { id: 'c', type: 'onclick', __graph: 'gem', data: { label: 'Gem click' } }],
			['k', { id: 'k', type: 'counter' }]
		]);
		const rows = firedBetween({ k: { lastT: 5, count: 1 } }, { c: { lastT: 10, count: 1 }, k: { lastT: 11, count: 4 } }, (id) => nodes.get(id), () => 'Gem_1');
		expect(rows).toEqual([
			{ node: 'c', type: 'onclick', name: 'Gem click', on: 'Gem_1' },
			{ node: 'k', type: 'counter', name: 'counter', times: 3 }
		]);
	});
});

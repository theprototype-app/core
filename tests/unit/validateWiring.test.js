import { describe, it, expect } from 'vitest';
import { validateScene } from '../../src/lib/ai/runtimeCore.js';
import { edgeTypeProblem, edgeHandleProblems } from '../../src/lib/ai/edgeHandles.js';

// 2.0-n3b step 2: validate_scene names the WIRING mistakes the N3a baseline agents made, each with a one-line fix.
// Fixtures are the agents' own graphs (baseline-v1.68.0 calls logs). Counterfactual: on v1.68.0 every case below
// except reversed-selector came back with no issue at all.
const SOURCES = new Set(['onclick', 'onenter', 'onexit', 'keypress', 'kit-pickups-collected']);
const ACTIONS = new Set(['kit-pickups-collect', 'setgamestate', 'sound', 'gamestart']);
const INPUTS = /** @type {Record<string, {name: string, type: string}[]>} */ ({
	onenter: [{ name: 'filter', type: 'object' }],
	onexit: [{ name: 'filter', type: 'object' }],
	setgamestate: [{ name: 'trigger', type: 'event' }],
	sound: [{ name: 'trigger', type: 'event' }],
	latch: [{ name: 'set', type: 'event' }, { name: 'reset', type: 'event' }, { name: 'toggle', type: 'event' }],
	'kit-pickups-collect': [{ name: 'trigger', type: 'event' }, { name: 'pickup', type: 'object' }]
});
/** @param {any} w */
const world = (w) => ({
	nodes: [],
	edges: [],
	objects: { spikes: { name: 'Spikes', sensor: true }, door: { name: 'Door' }, zone: { name: 'Zone' }, coin: { name: 'Coin' }, lamp: { name: 'Lamp', light: true } },
	envLit: true,
	isSource: (/** @type {string} */ t) => SOURCES.has(t),
	isAction: (/** @type {string} */ t) => ACTIONS.has(t),
	inputsOf: (/** @type {string} */ t) => INPUTS[t] ?? [],
	edgeTypeProblem,
	edgeHandleProblems,
	...w
});
const n = (/** @type {string} */ id, /** @type {string} */ type, data = {}, graph = 'scene') => ({ id, type, data, __graph: graph });
const find = (/** @type {any} */ r, /** @type {string} */ code) => r.issues.find((/** @type {any} */ i) => i.code === code);

describe('2.0-n3b validate_scene names wiring mistakes', () => {
	it('pause-p r1: a Gate into Set Game State never fires; the Latch fires on every change', () => {
		const r = validateScene(world({
			nodes: [n('k', 'keypress', { code: 'KeyP' }), n('l', 'latch'), n('g', 'gate', { op: 'NOT' }), n('p', 'setgamestate', { state: 'paused' }), n('s', 'setgamestate', { state: 'playing' })],
			edges: [
				{ source: 'k', target: 'l', targetHandle: 'toggle' },
				{ source: 'l', target: 'p', targetHandle: 'trigger' },
				{ source: 'l', target: 'g', targetHandle: 'a' },
				{ source: 'g', target: 's', targetHandle: 'trigger' }
			]
		}));
		expect(r.ok).toBe(false);
		expect(find(r, 'value-into-event')).toMatchObject({ level: 'error', node: 's' });
		expect(find(r, 'value-into-event').fix).toMatch(/Wire an event/);
		expect(find(r, 'fires-on-every-change')).toMatchObject({ level: 'warning', node: 'p' });
	});

	it('an edge into a handle the node does not have', () => {
		const r = validateScene(world({ nodes: [n('c', 'onclick', {}, 'coin'), n('l', 'latch', {}, 'coin')], edges: [{ source: 'c', target: 'l', targetHandle: 'sett' }] }));
		expect(find(r, 'missing-handle')).toMatchObject({ level: 'error' });
		expect(find(r, 'missing-handle').message).toMatch(/set, /);
	});

	it('an action used as an event', () => {
		const r = validateScene(world({ nodes: [n('c', 'onclick', {}, 'coin'), n('p', 'setgamestate'), n('s', 'sound')], edges: [{ source: 'c', target: 'p', targetHandle: 'trigger' }, { source: 'p', target: 's', targetHandle: 'trigger' }] }));
		expect(find(r, 'action-as-event')).toMatchObject({ level: 'error', node: 'p' });
	});

	it('On Enter: the owner is not a sensor / a scene-graph one reaching a door / one with no sensor named', () => {
		expect(find(validateScene(world({ nodes: [n('e', 'onenter', { who: 'player' }, 'zone')] })), 'not-a-sensor')).toMatchObject({ object: 'zone', level: 'error' });
		expect(find(validateScene(world({ nodes: [n('e', 'onenter', {}, 'zone')] })), 'not-a-sensor')).toMatchObject({ level: 'warning' });
		const door = validateScene(world({ nodes: [n('e', 'onenter', { who: 'player' }), n('r', 'rotateto'), n('d', 'objectselector', { selected: 'door' })], edges: [{ source: 'e', target: 'r' }, { source: 'r', target: 'd' }] }));
		expect(find(door, 'sensor-is-target')).toMatchObject({ object: 'door' });
		expect(find(validateScene(world({ nodes: [n('e', 'onenter', { who: 'player' })] })), 'sensor-any')).toMatchObject({ level: 'warning' });
		// fine: in the sensor's own graph, and a scene-graph one with the sensor in its filter
		expect(validateScene(world({ nodes: [n('e', 'onenter', {}, 'spikes')] })).issues.map((/** @type {any} */ i) => i.code)).not.toContain('not-a-sensor');
		const filtered = validateScene(world({ nodes: [n('s', 'objectselector', { selected: 'spikes' }), n('e', 'onenter')], edges: [{ source: 's', target: 'e', targetHandle: 'filter' }] }));
		expect(filtered.issues.map((/** @type {any} */ i) => i.code)).toEqual([]);
	});

	it('pickup-own r1: a Collect nothing hides', () => {
		const r = validateScene(world({ nodes: [n('e', 'onenter', {}, 'spikes'), n('k', 'kit-pickups-collect', {}, 'spikes')], edges: [{ source: 'e', target: 'k', targetHandle: 'trigger' }] }));
		expect(find(r, 'pickup-stays').fix).toMatch(/Hide when collected/);
		// G27: a Collect with hide on hides itself
		const hides = validateScene(world({ nodes: [n('e', 'onenter', {}, 'spikes'), n('k', 'kit-pickups-collect', { hide: true }, 'spikes')], edges: [{ source: 'e', target: 'k', targetHandle: 'trigger' }] }));
		expect(find(hides, 'pickup-stays')).toBeUndefined();
	});

	it('a toggle fed by a per-person click', () => {
		const r = validateScene(world({ nodes: [n('c', 'onclick', { perPlayer: true }, 'lamp'), n('l', 'latch', {}, 'lamp')], edges: [{ source: 'c', target: 'l', targetHandle: 'toggle' }] }));
		expect(find(r, 'toggle-per-person')).toMatchObject({ level: 'warning', node: 'l' });
		const shared = validateScene(world({ nodes: [n('c', 'onclick', {}, 'lamp'), n('l', 'latch', {}, 'lamp')], edges: [{ source: 'c', target: 'l', targetHandle: 'toggle' }] }));
		expect(find(shared, 'toggle-per-person')).toBeUndefined();
	});
});

// 2.0 N1 — the core node families IN PALETTE ORDER, and the tables generated from them. Everything
// that used to list core node types by hand reads these: nodeCatalog (the palette groups),
// flowSockets (OUTPUT / INPUT / OUTPUT_HANDLES), Nodes.svelte (the card map) and flowRuntime
// (evalNodeBody dispatches `eval`). Adding a node = one entry in its family file; adding a GROUP =
// one file plus one line here. Kit nodes stay generated from the piece specs (kit/catalog.js), and
// module nodes keep registerNodeDefs / registerValueNode / registerEffect as adapters onto the same
// lookups (moduleSDK, moduleNodeIO).
import input from './families/input.js';
import scene from './families/scene.js';
import objectFlow from './families/objectFlow.js';
import game from './families/game.js';
import character from './families/character.js';
import hud from './families/hud.js';
import logic from './families/logic.js';
import triggers from './families/triggers.js';
import animation from './families/animation.js';
import physics from './families/physics.js';
import effects from './families/effects.js';
import music from './families/music.js';
import { buildRegistry, registryErrors } from './registry.js';

/** @type {import('./registry.js').NodeFamily[]} */
export const NODE_FAMILIES = [
	input,
	scene,
	objectFlow,
	game,
	character,
	hud,
	logic,
	triggers,
	animation,
	physics,
	effects,
	music
];

const registry = buildRegistry(NODE_FAMILIES);

/** the core palette groups, generated (nodeCatalog prepends nothing and appends the kit) */
export const coreCatalogGroups = registry.groups;

/** one core node type's definition, or undefined @param {string} type */
export function nodeDef(type) {
	return registry.defs.get(type);
}

/** every core node type, in palette order */
export function coreNodeTypes() {
	return [...registry.defs.keys()];
}

/** a core type's value function (evalNodeBody's dispatch); undefined = not a core value node @param {string} type */
export function nodeEvalOf(type) {
	return registry.defs.get(type)?.eval ?? undefined;
}

/** type -> card key, for Nodes.svelte's CORE_NODE_TYPES @returns {Record<string, string>} */
export function coreCardKeys() {
	return Object.fromEntries([...registry.defs].map(([type, def]) => [type, def.card]));
}

/**
 * flowSockets' three tables, generated. OUTPUT lists every core type (an `effect` output is now
 * said out loud instead of being the fallback — `outputType` answers the same either way).
 */
export function coreSocketTables() {
	/** @type {Record<string, string>} */ const OUTPUT = {};
	/** @type {Record<string, Record<string, string>>} */ const INPUT = {};
	/** @type {Record<string, Record<string, string>>} */ const OUTPUT_HANDLES = {};
	for (const [type, def] of registry.defs) {
		OUTPUT[type] = def.sockets.out;
		if (def.sockets.in) INPUT[type] = def.sockets.in;
		if (def.sockets.outHandles) OUTPUT_HANDLES[type] = def.sockets.outHandles;
	}
	return { OUTPUT, INPUT, OUTPUT_HANDLES };
}

/** what is wrong with the core families (empty = whole) — the build check and the unit test */
export function coreRegistryErrors() {
	return registryErrors(NODE_FAMILIES);
}

/**
 * 2.0-n3c (formatMinor 3): stamp each saved node that has no `v` yet with its definition's version, when
 * that is above 1 (absent = 1, so today every node saves unchanged). A node that already carries `v` keeps
 * it: it says what the node was MADE with. Mutates and returns the serialized copies.
 * @template {Record<string, {nodes?: any[]}>} G
 * @param {G} graphs @param {(type: string) => number} [versionOf]
 * @returns {G}
 */
export function stampNodeVersions(graphs, versionOf = (type) => /** @type {any} */ (nodeDef(type))?.v ?? 1) {
	for (const g of Object.values(graphs ?? {}))
		for (const n of g?.nodes ?? []) {
			if (!n || n.v !== undefined) continue;
			const v = versionOf(n.type);
			if (Number.isInteger(v) && v > 1) n.v = v;
		}
	return graphs;
}

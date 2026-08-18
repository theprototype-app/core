// A1 — the module node I/O registry (DEVX #9 + #12).
//
// Module nodes used to be effect SINKS only: flowRuntime called
// moduleEffects[type](object, base, data, time) and evalNode had no module hook, so
// a module node could not output a value, fire a trigger, or learn its own id. That
// made "module state -> core HUD" unauthorable, which is what every game needs.
//
// This module imports NOTHING, deliberately (the meshTopology pattern): flowSockets,
// flowRuntime AND moduleSDK all read it, and an edge from here to any of them would
// close a cycle — flowRuntime is reachable from history, so a static edge back into
// that family TDZ-crashes the vite-dev SSR eval.
//
// THE CONTRACT, and the one thing that can silently break a session: a module value
// node is a PURE FUNCTION of (data, time) — the script-node rule. Every peer
// evaluates it itself from the already-replicated node data and the shared clock, so
// a value that reads local state (a mouse position, an unreplicated Map, Math.random)
// diverges per peer with NO error anywhere. Values are never sent; only discrete
// events are, and those ride the existing replicated nodetrigger path.

/** node type -> the pure evaluator. @type {Record<string, (data: any, time: number, ctx: any) => any>} */
export const moduleValueNodes = {};
/** node type -> its OUTPUT socket type (flowSockets.outputType reads this).
 * @type {Record<string, string>} */
export const moduleValueTypes = {};
/** node type -> {handle: socketType} for its named INPUTS. Effect nodes may declare
 * these too — without them flowSockets.inputType answers 'number' for every handle,
 * which refuses an Object Selector (object -> number is not a coercion).
 * @type {Record<string, Record<string, string>>} */
export const moduleNodeInputs = {};

/**
 * Register a module node that OUTPUTS a value.
 * @param {string} type node type, as registered in the module's node group
 * @param {(data: any, time: number, ctx: any) => any} fn pure of (data, time)
 * @param {string} vtype output socket type ('number' | 'boolean' | 'vector3' | 'color' | 'object' | 'event')
 */
export function registerModuleValueNode(type, fn, vtype) {
	moduleValueNodes[type] = fn;
	moduleValueTypes[type] = vtype || 'number';
}

/** Drop a value node, but only if `fn` is still the registered one — a module
 * re-registering the same type (dev reload) must not have its NEW fn removed by the
 * OLD registration's teardown. @param {string} type @param {Function} fn */
export function unregisterModuleValueNode(type, fn) {
	if (moduleValueNodes[type] !== fn) return;
	delete moduleValueNodes[type];
	delete moduleValueTypes[type];
}

/** Declare a module node's typed named inputs. @param {string} type @param {Record<string,string>} inputs */
export function registerModuleNodeInputs(type, inputs) {
	if (!inputs) return;
	moduleNodeInputs[type] = { ...inputs };
}

/** @param {string} type @param {Record<string,string>} inputs */
export function unregisterModuleNodeInputs(type, inputs) {
	// same guard as above: only retract OUR declaration
	if (!inputs || !moduleNodeInputs[type]) return;
	if (JSON.stringify(moduleNodeInputs[type]) !== JSON.stringify({ ...inputs })) return;
	delete moduleNodeInputs[type];
}

/** Is this node type a registered module value node? @param {string} type */
export function isModuleValueNode(type) {
	return !!moduleValueNodes[type];
}

/** The declared input handles of a module node, in declaration order (the node card
 * renders one Socket per entry). @param {string} type @returns {string[]} */
export function moduleInputHandles(type) {
	return Object.keys(moduleNodeInputs[type] ?? {});
}

/**
 * Evaluate a module value node. Never throws into the tick: a module that throws
 * reads as `undefined`, which every consumer already treats as "fall back to the
 * node's own param" — the same containment registerEffect's call site has.
 * @param {string} type @param {any} data @param {number} time @param {any} ctx {id, graphId}
 */
export function evalModuleValueNode(type, data, time, ctx) {
	const fn = moduleValueNodes[type];
	if (!fn) return undefined;
	try {
		return fn(data, time, ctx);
	} catch (error) {
		console.log('module value node ' + type + ' failed', error);
		return undefined;
	}
}

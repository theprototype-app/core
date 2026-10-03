// 34 R2 (T3) — ONE SPEC PER KIT PIECE -> `api.kit.<piece>` AND a flow node group.
//
// A pure LEAF (imports nothing). Each piece ships `src/lib/kit/<piece>.spec.js`, plain data:
//
//   { piece: 'score', group: 'Kit: Score', calls: [
//       { name: 'add', kind: 'action', label: 'Add score', doc: '…',
//         args: [{ key: 'amount', type: 'number', default: 1, min: -100, max: 100, step: 1 }],
//         authority: true },
//       { name: 'total', kind: 'value', label: 'Score', vtype: 'number', args: [] },
//       { name: 'won', kind: 'event', label: 'On round won', args: [] } ] }
//
// and the two generators below turn that ONE description into both faces, so a graph author
// and a code author get the same behaviour and the same words (and 34-behaviours' derived
// view / 34-graph-ai's compact text show a kit call as exactly this node):
//
//   kitApi(spec, impl, ctx)  -> { add(amount), total(), onWon(fn) -> off }
//   kitNodeItems(spec)       -> nodeCatalog items, type `kit-<piece>-<name>`
//
// THE THREE KINDS. An `action` changes shared kit state: as a node it acts on its trigger's
// STAMP EDGE (the spawn/setgamestate shape — every peer sees the stamp, and the kit itself
// routes the change to the ONE authority peer, so N peers seeing one press change it once).
// A `value` is a pure read of replicated kit state (the module value-node rule). An `event`
// is a moment the authority witnessed; as a node it is a trigger SOURCE, pulsed once on the
// authority (replicated like every pulse), and in code it is `on<Name>(fn)`, heard on EVERY
// peer from the replicated kit message.

/** @typedef {'number'|'boolean'|'string'|'vector3'|'object'|'entity'|'color'} KitArgType */
/**
 * @typedef {{key: string, type: KitArgType, label?: string, default?: any, min?: number,
 *   max?: number, step?: number, options?: string[]}} KitArg
 * @typedef {{name: string, kind: 'action'|'value'|'event', label: string, doc?: string,
 *   args?: KitArg[], vtype?: string, authority?: boolean, node?: boolean, local?: boolean, owned?: boolean}} KitCall
 * `owned` (actions): the SDK face appends the calling module's id after the spec args and
 * journals ONE `impl.disown(moduleId)` per module per piece (the node path passes no owner).
 * `local` (events only): the event is witnessed on ONE peer and stays there — its listeners
 * and its node pulse (kept local, the perPlayer rule) — e.g. "your grab was refused".
 * @typedef {{piece: string, group: string, calls: KitCall[]}} KitSpec
 */

/** the flow node type of one call @param {string} piece @param {string} name */
export function kitNodeType(piece, name) {
	return 'kit-' + piece + '-' + name;
}

/** `won` -> `onWon` @param {string} name */
export function eventMethodName(name) {
	return 'on' + name.charAt(0).toUpperCase() + name.slice(1);
}

/** A spec's shape problems, as sentences (empty = fine). The kit's own table test runs this
 * over every piece, so a malformed row fails a unit test instead of a palette.
 * @param {any} spec @returns {string[]} */
export function specProblems(spec) {
	/** @type {string[]} */
	const out = [];
	if (!spec || typeof spec !== 'object') return ['spec is not an object'];
	if (!/^[a-z][a-z0-9]*$/.test(String(spec.piece ?? ''))) out.push('piece must be a lowercase identifier');
	if (typeof spec.group !== 'string' || !spec.group) out.push('group is missing');
	if (!Array.isArray(spec.calls) || !spec.calls.length) out.push('calls is empty');
	const seen = new Set();
	for (const call of spec.calls ?? []) {
		const where = spec.piece + '.' + call?.name;
		if (!/^[a-z][A-Za-z0-9]*$/.test(String(call?.name ?? ''))) out.push(where + ': name must be camelCase');
		if (seen.has(call?.name)) out.push(where + ': duplicate name');
		seen.add(call?.name);
		if (!['action', 'value', 'event'].includes(call?.kind)) out.push(where + ': kind must be action|value|event');
		if (typeof call?.label !== 'string' || !call.label) out.push(where + ': label is missing');
		const keys = new Set();
		for (const arg of call?.args ?? []) {
			if (!arg || typeof arg.key !== 'string' || !arg.key) out.push(where + ': an arg has no key');
			else if (keys.has(arg.key)) out.push(where + ': duplicate arg ' + arg.key);
			keys.add(arg?.key);
			if (arg?.key === 'trigger') out.push(where + ': "trigger" is reserved for the node input');
		}
		if (call?.kind === 'event' && seen.has(eventMethodName(call.name))) out.push(where + ': event method name collides');
	}
	return out;
}

/** The default of one arg (its type's zero when it names none). @param {KitArg} arg */
export function argDefault(arg) {
	if (arg.default !== undefined) return arg.default;
	switch (arg.type) {
		case 'number':
			return 0;
		case 'boolean':
			return false;
		case 'vector3':
			return [0, 0, 0];
		case 'string':
			return arg.options?.[0] ?? '';
		default:
			return null;
	}
}

/** Positional call args from a node's resolved data (wired value, else its param, else default).
 * @param {KitCall} call @param {Record<string, any>} data */
export function argsFromData(call, data) {
	return (call.args ?? []).map((arg) => {
		const v = data?.[arg.key];
		if (v === undefined || v === null || v === '') return argDefault(arg);
		if (arg.type === 'number') {
			const n = Number(v);
			return Number.isFinite(n) ? n : argDefault(arg);
		}
		if (arg.type === 'boolean') return v === true || v === 1 || v === 'true';
		return v;
	});
}

/**
 * The SDK face of one piece. `impl` holds the real functions (same names); an event call
 * becomes `on<Name>(fn) -> off`, recorded in the module's teardown journal through
 * `ctx.onDispose` (T2: the one line the lifecycle registry replaces), so an unloaded module
 * leaves no listener behind. Reads and actions pass straight through.
 * @param {KitSpec} spec @param {Record<string, any>} impl
 * @param {{onDispose?: (fn: () => void) => any, moduleId?: string}} [ctx]
 */
export function kitApi(spec, impl, ctx) {
	/** @type {Record<string, any>} */
	const api = {};
	/** has an owned call journaled this module's disown yet? */
	let owned = false;
	for (const call of spec.calls) {
		if (call.kind === 'event') {
			const method = eventMethodName(call.name);
			api[method] = (/** @type {(payload: any) => void} */ fn) => {
				const off = impl.on(call.name, fn);
				ctx?.onDispose?.(off);
				return off;
			};
			continue;
		}
		const fn = impl[call.name];
		if (typeof fn !== 'function') throw new Error('kit.' + spec.piece + '.' + call.name + ' has no implementation');
		if (!call.owned) {
			api[call.name] = (/** @type {any[]} */ ...args) => fn(...args);
			continue;
		}
		// an OWNED call (34-kit-entities' spawn): the calling module's id after the spec args, and
		// ONE teardown per module per piece — `impl.disown(moduleId)` drops what it owns (T2)
		api[call.name] = (/** @type {any[]} */ ...args) => {
			const padded = args.slice(0, call.args?.length ?? 0);
			while (padded.length < (call.args?.length ?? 0)) padded.push(undefined);
			const r = fn(...padded, ctx?.moduleId ?? '');
			if (!owned) {
				owned = true;
				ctx?.onDispose?.(() => impl.disown?.(ctx?.moduleId ?? ''));
			}
			return r;
		};
	}
	// the piece's code-only extras (a level table, a pickup registration…) ride along under
	// their own names; a spec row is what makes something ALSO a node. A TRACKED extra
	// (`impl.tracked = {name: argCount}`) is a registration: it gets the calling module's id after
	// its own args (its owner, for scoping) and the `off` it returns is journaled for teardown.
	for (const [name, fn] of Object.entries(impl.extra ?? {})) {
		if (name in api) continue;
		const argc = impl.tracked?.[name];
		if (argc === undefined) {
			api[name] = fn;
			continue;
		}
		api[name] = (/** @type {any[]} */ ...args) => {
			const padded = args.slice(0, argc);
			while (padded.length < argc) padded.push(undefined);
			const off = fn(...padded, ctx?.moduleId ?? '');
			if (typeof off === 'function') ctx?.onDispose?.(off);
			return off;
		};
	}
	return api;
}

/** a node param for one arg (null when the arg is wire-only: objects, entities, vectors)
 * @param {KitArg} arg */
function paramOf(arg) {
	const label = arg.label ? { label: arg.label } : {};
	if (arg.options?.length) return { key: arg.key, kind: 'select', options: [...arg.options], ...label };
	if (arg.type === 'number')
		return { key: arg.key, kind: 'range', min: arg.min ?? 0, max: arg.max ?? 100, step: arg.step ?? 1, ...label };
	if (arg.type === 'boolean') return { key: arg.key, kind: 'toggle', ...label };
	if (arg.type === 'string') return { key: arg.key, kind: 'text', ...label };
	return null;
}

/** the flow socket type of an arg @param {KitArg} arg */
export function socketTypeOf(arg) {
	if (arg.type === 'entity') return 'object';
	if (arg.type === 'string') return 'any';
	return arg.type;
}

/**
 * The node group of one piece: nodeCatalog items, plus what flowSockets needs to type them
 * (`io`: the output socket type and the named inputs). `node: false` on a call keeps it
 * code-only.
 * @param {KitSpec} spec
 * @returns {{type: string, label: string, defaults: Record<string, any>, params: any[],
 *   inputs?: string[], note?: string, kit: {piece: string, call: string, kind: string},
 *   io: {output: string, inputs: Record<string, string>}}[]}
 */
export function kitNodeItems(spec) {
	return spec.calls
		.filter((call) => call.node !== false)
		.map((call) => {
			/** @type {Record<string, any>} */
			const defaults = {};
			const params = [];
			/** @type {Record<string, string>} */
			const inputs = {};
			for (const arg of call.args ?? []) {
				const d = argDefault(arg);
				if (d !== null) defaults[arg.key] = Array.isArray(d) ? [...d] : d;
				const param = paramOf(arg);
				if (param) params.push(param);
				inputs[arg.key] = socketTypeOf(arg);
			}
			if (call.kind === 'action') inputs.trigger = 'event';
			const output = call.kind === 'value' ? call.vtype ?? 'number' : call.kind === 'event' ? 'event' : 'effect';
			const named = Object.keys(inputs);
			return {
				type: kitNodeType(spec.piece, call.name),
				label: call.label,
				defaults,
				params,
				...(named.length ? { inputs: call.kind === 'action' ? ['trigger', ...named.filter((k) => k !== 'trigger')] : named } : {}),
				...(call.doc ? { note: call.doc } : {}),
				kit: { piece: spec.piece, call: call.name, kind: call.kind },
				io: { output, inputs }
			};
		});
}

/** `kit-score-add` -> {piece: 'score', call: 'add'} (null for anything else) @param {string} type */
export function parseKitNodeType(type) {
	const m = /^kit-([a-z][a-z0-9]*)-([a-z][A-Za-z0-9]*)$/.exec(String(type ?? ''));
	return m ? { piece: m[1], call: m[2] } : null;
}

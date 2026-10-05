// 36 (U10, 36-games-graphs) — ENGINE PIECES: what a module lends a game's rules.
//
// A game's RULES live in a behaviour on its Main graph (readable, editable, replicated as the
// behaviour document); what the rules cannot be — a ball's physics body, the putting drag with its
// arrow, a VR club, a generated dungeon — stays in the module as ENGINE HELPERS. A module hands
// those to behaviours as a piece shaped exactly like a kit piece (kit/spec.js):
//
//   const golf = api.kit.provide({ piece: 'golf', group: 'Mini golf (engine)', calls: [
//       { name: 'hit', kind: 'action', label: 'Hit the ball', args: [{ key: 'velocity', type: 'vector3' }] },
//       { name: 'ballSpeed', kind: 'value', label: 'Ball speed', vtype: 'number' },
//       { name: 'stopped', kind: 'event', label: 'On ball stopped' } ] },
//     { hit(v) {…}, ballSpeed() {…} });
//   golf.emit('stopped', { pos });        // every behaviour's `on: {'golf.stopped'(e) {…}}` hears it
//
// so a behaviour calls `kit.golf.hit(v)`, handles `golf.stopped`, and the analyzer, the derived
// node view and the event resolver treat it like any kit call (they read pieces by SPEC). An
// engine event reaches handlers through the same `on<Event>(fn)` face a kit event has, and the
// behaviour runtime runs the handler on the authority only — so a module emits on EVERY peer that
// saw the moment (or on the one that did and forwards it), and the authority's handler acts once.
//
// A LEAF (kit/spec.js only). The SDK registers through `provideEngine` (lifecycle-tracked: an
// unloaded module's piece goes, and every behaviour using it reloads without it).

import { kitApi, specProblems } from '../kit/spec.js';

/** @typedef {{spec: any, impl: Record<string, any>, moduleId: string, listeners: Map<string, Set<(p: any) => void>>}} EnginePiece */

/** piece name -> the piece @type {Map<string, EnginePiece>} */
const pieces = new Map();
/** change listeners (behaviours/app.js reloads behaviours) @type {Set<() => void>} */
const changeListeners = new Set();
/** kit piece names an engine may not take (set by app.js from the kit's specs) @type {Set<string>} */
let reserved = new Set();

function changed() {
	for (const fn of [...changeListeners]) {
		try {
			fn();
		} catch (error) {
			console.warn('engines: change listener failed', error);
		}
	}
}

/** @param {Iterable<string>} names the kit's own piece names (an engine may not shadow one) */
export function reserveEngineNames(names) {
	reserved = new Set(names);
}

/**
 * Register an engine piece. Returns `{emit(event, payload), listening(event), dispose()}`; a second
 * provide of the same piece REPLACES the first (a module reload).
 * @param {any} spec kit-spec shaped `{piece, group, calls}` @param {Record<string, any>} impl
 * @param {string} [moduleId]
 */
export function provideEngine(spec, impl, moduleId = '') {
	const found = specProblems(spec);
	if (found.length) throw new Error('kit.provide: ' + found.join('; '));
	const name = String(spec.piece);
	if (reserved.has(name)) throw new Error('kit.provide: "' + name + '" is a kit piece');
	for (const call of spec.calls)
		if (call.kind !== 'event' && typeof impl?.[call.name] !== 'function') throw new Error('kit.provide: ' + name + '.' + call.name + ' has no function');
	/** @type {EnginePiece} */
	const piece = { spec, impl: impl ?? {}, moduleId, listeners: new Map() };
	pieces.set(name, piece);
	changed();
	let disposed = false;
	return {
		/** fire an engine event on THIS peer's listeners @param {string} event @param {any} [payload] */
		emit(event, payload) {
			if (disposed || pieces.get(name) !== piece) return 0;
			let n = 0;
			for (const fn of [...(piece.listeners.get(String(event)) ?? [])]) {
				n++;
				try {
					fn(payload ?? {});
				} catch (error) {
					console.warn('engines: ' + name + '.' + event + ' listener failed', error);
				}
			}
			return n;
		},
		/** how many listeners an event has right now (0 = no rules are listening: the engine's own
		 * built-in rule may decide) @param {string} event */
		listening(event) {
			return disposed || pieces.get(name) !== piece ? 0 : (piece.listeners.get(String(event))?.size ?? 0);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (pieces.get(name) === piece) {
				pieces.delete(name);
				changed();
			}
		}
	};
}

/** the specs of every engine piece (the analyzer / event resolver / derived view read these) */
export function engineSpecs() {
	return [...pieces.values()].map((p) => p.spec);
}

/** a version stamp of the registry: changes whenever a piece comes or goes */
export function enginesKey() {
	return [...pieces.entries()].map(([n, p]) => n + ':' + p.moduleId + ':' + p.spec.calls.length).join('|');
}

/**
 * The faces of every engine piece for ONE behaviour: `{golf: {hit, ballSpeed, onStopped(fn)}}`.
 * `ctx.onDispose(off)` journals each listener (the behaviour's T2 tracking).
 * @param {{onDispose?: (fn: () => void) => any, moduleId?: string}} [ctx]
 */
export function engineFaces(ctx) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const [name, piece] of pieces) {
		const impl = {
			...piece.impl,
			/** @param {string} event @param {(p: any) => void} fn */
			on(event, fn) {
				let set = piece.listeners.get(event);
				if (!set) piece.listeners.set(event, (set = new Set()));
				set.add(fn);
				return () => set?.delete(fn);
			}
		};
		out[name] = kitApi(piece.spec, impl, ctx);
	}
	return out;
}

/** @param {() => void} fn @returns {() => void} */
export function onEnginesChange(fn) {
	changeListeners.add(fn);
	return () => changeListeners.delete(fn);
}

/** debug / suites */
export function enginesDebug() {
	return [...pieces.entries()].map(([name, p]) => ({
		piece: name,
		moduleId: p.moduleId,
		calls: p.spec.calls.map((/** @type {any} */ c) => c.kind + ':' + c.name),
		listeners: Object.fromEntries([...p.listeners].map(([e, s]) => [e, s.size]))
	}));
}

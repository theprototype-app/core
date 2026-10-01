// 33 (L4) — WHICH MODULES BELONG TO THE SCENE ON SCREEN. A LEAF: svelte/store only, so
// gameShell, gameSettings, gameMusic, playSettings and moduleSDK can all read it without an
// edge into history (the TDZ-cycle family).
//
// The user: "when opened one game then another the new one stops working (opened waves
// game, then towers — music from waves stays and the gun, but only objects from towers
// load)". A game module is a SCENE SCRIPT: it came with a scene, and the scene going away
// is the end of its say in the world. Unloading it (the scene-switch ask, sceneSwitch.js)
// runs its teardown journal; but a module the person chose to KEEP is still loaded, and
// what it registered for its own game — a level list, How to play, settings rows, a
// Restart hook, a music track, a spawn — must not leak into the next game's menu or
// position the next game's player.
//
// So core tracks the modules the scene was USING when it went away and the next scene does
// not use: LEFT BEHIND. A registration whose owner is left behind is kept (coming back to
// that game brings it back with no re-registration — modules register once at boot) but
// does not COUNT: the shell hides it, the music it owns stops and further plays are
// refused, its spawn is ignored. Everything else (core, an anonymous registration, a flow
// node's row, a module the scene uses, a tool module no scene ever used) is in scope.
//
// Deliberately "left behind" rather than "in the scene": a freshly installed module is in
// scope until a scene switch leaves it behind, so a module tried out in a blank scene, and
// every suite that installs one and pokes it, behaves exactly as before this file existed.
//
// The derivation (what a scene uses = its declared `modules` ∪ what its nodes and devices
// derive, moduleRequirements) needs modules a leaf may not import, so sceneSwitch.js
// registers it here (`registerSceneUsage`) and drives the recompute.
import { writable, get } from 'svelte/store';

/** module ids left behind by the last scene switch (see the header)
 * @type {import('svelte/store').Writable<Set<string>>} */
export const leftBehindModules = writable(new Set());

/** what the scene USES right now, registered by sceneSwitch @type {() => string[]} */
let usageFn = () => [];
/** @param {() => string[]} fn */
export function registerSceneUsage(fn) {
	usageFn = typeof fn === 'function' ? fn : () => [];
}
/** @returns {string[]} the module ids the scene on screen uses */
export function sceneUsedModules() {
	try {
		return usageFn() ?? [];
	} catch {
		return [];
	}
}

/**
 * Is a registration's owner in scope? Owners are module ids; '' (core, anonymous) and the
 * flow runtime's `node:<id>` rows are always in scope.
 * @param {string | null | undefined} owner @returns {boolean}
 */
export function ownerInScope(owner) {
	if (!owner || String(owner).startsWith('node:')) return true;
	return !get(leftBehindModules).has(String(owner));
}

/** modules the scene used just before the most recent clear, still waiting to be judged
 * @type {Set<string>} */
let candidates = new Set();

/**
 * The clear path calls this BEFORE it wipes anything: whatever the scene uses now is what a
 * replacement may leave behind. An objects-only clear keeps the graphs, so the very next
 * recompute finds them still used and leaves nothing behind.
 */
export function noteSceneLeaving() {
	for (const id of sceneUsedModules()) candidates.add(id);
	recomputeScope();
}

/**
 * Judge the candidates against what the scene uses NOW: unused ones are left behind, used
 * ones (and any left-behind module the scene uses again) come back into scope.
 * @param {string[]} [extraUsed] ids a caller knows the incoming scene uses (its declared list)
 * @returns {Set<string>} the left-behind set after the recompute
 */
export function recomputeScope(extraUsed = []) {
	const used = new Set([...sceneUsedModules(), ...(extraUsed ?? [])]);
	const before = get(leftBehindModules);
	const next = new Set([...before].filter((id) => !used.has(id)));
	for (const id of candidates) if (!used.has(id)) next.add(id);
	// a candidate the scene still uses stays a candidate — the next recompute (the replacement
	// scene's graphs landing a beat later) may still find it unused
	if (!sameSet(next, before)) leftBehindModules.set(next);
	return next;
}

/**
 * A scene finished arriving (applySession's end): the judgement is final for this switch,
 * the candidates are spent. @param {string[]} [declared] the payload's own module list
 */
export function settleScope(declared = []) {
	const next = recomputeScope(declared);
	candidates = new Set();
	return next;
}

/** A module (re)activated or unloaded: it starts from scratch, in scope. @param {string} id */
export function forgetScopeOf(id) {
	candidates.delete(id);
	const before = get(leftBehindModules);
	if (!before.has(id)) return;
	const next = new Set(before);
	next.delete(id);
	leftBehindModules.set(next);
}

/** are there modules from a cleared scene still waiting to be judged? */
export function scopePending() {
	return candidates.size > 0;
}

/** @param {Set<string>} a @param {Set<string>} b */
function sameSet(a, b) {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}

/** the suites' view */
export function sceneScopeDebug() {
	return { leftBehind: [...get(leftBehindModules)], candidates: [...candidates], used: sceneUsedModules() };
}

/** test seam */
export function resetSceneScope() {
	candidates = new Set();
	leftBehindModules.set(new Set());
}

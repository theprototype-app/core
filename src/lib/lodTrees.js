// 40 F14 — WHICH SUBSTITUTE MODELS DRAW FOR AN OBJECT. A LEAF that imports nothing: lodGroup.js
// (which owns the scene-root substitute subtrees of TREE levels) writes it, and the readers that
// must reach those meshes without pulling the LOD runtime into their import graph read it — Body
// Wave bends a fish's real model, the look tier draws its film at this device's tier.

/** object root -> the tree-level subtrees built for it @type {WeakMap<any, Set<any>>} */
const trees = new WeakMap();
/** every live subtree (for a whole-scene pass) @type {Set<any>} */
const all = new Set();
/** @type {Set<() => void>} */
const listeners = new Set();

/** @param {any} root @param {any} tree */
export function addLodTree(root, tree) {
	let set = trees.get(root);
	if (!set) trees.set(root, (set = new Set()));
	set.add(tree);
	all.add(tree);
	for (const fn of listeners) fn();
}

/** @param {any} root @param {any} tree */
export function removeLodTree(root, tree) {
	trees.get(root)?.delete(tree);
	all.delete(tree);
	for (const fn of listeners) fn();
}

/** the subtrees built for an object (empty when none) @param {any} root @returns {any[]} */
export function lodTreesOf(root) {
	const set = trees.get(root);
	return set ? [...set] : [];
}

/** every live subtree @returns {any[]} */
export function allLodTrees() {
	return [...all];
}

/** called when a subtree is built or dropped @param {() => void} fn @returns {() => void} */
export function onLodTreesChanged(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

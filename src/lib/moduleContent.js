// 30 P3: MODULE CONTENT in the object list — a LEAF (THREE + svelte/store + sceneStore +
// helperLayer). moduleSDK writes the registry, the object list reads it, objectActions
// clears the selection; none of them may import each other through here, which is why
// it is its own file (moduleSDK primes objectActions DYNAMICALLY to dodge that cycle, and
// a registry living in either one would close it).
//
// THE FINDING (roadmap 30, "Selection and the object list", cause 3): scene-root module
// content — the dungeon, the untangle board, the piano, the sabers — lives outside
// `objectsGroup` by golden rule 5, so it was never picked and never LISTED. Only the
// advanced System filter polled `systemGroupNames`, and it named no module. Every module
// group is listed now, READ-ONLY: the module owns it and regenerates it from its own
// state, so a rename, a delete or a reparent here would be undone on the next rebuild
// (or, worse, not undone and never replicated).
//
// Selecting one selects a PROXY, never the group: a scene-root box on the helper layer
// sized to the group's bounds. It is not in objectsGroup, so it never replicates, never
// saves and never enters the selection SET (applySelectionSet filters uuids it cannot
// find there) — the selection outline, the gizmo and every "act on the selection"
// command stay exactly what they were.
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene } from '../stores/sceneStore';
import { markHelper } from './helperLayer';

/** named children listed per group, and how deep */
export const LIST_CAP = 200;
export const LIST_DEPTH = 2;

/**
 * @typedef {{ name: string, moduleId: string, moduleName: string, label: string,
 *   icon: string | null, kinds: Set<string> }} ModuleGroup
 */

/** @type {Map<string, ModuleGroup>} scene-root group name -> who registered it */
const groups = new Map();

/** bumps on every registry change so the list re-derives */
export const moduleGroupsRevision = writable(0);

/**
 * Record a module's scene-root group. `kind` is which register* call named it
 * ('interactive' | 'system' | 'listed'); the row lives while any kind still holds it.
 * @param {string} name @param {{id: string, name?: string}} owner @param {string} kind
 * @param {{label?: string, icon?: string}} [opts]
 */
export function noteModuleGroup(name, owner, kind, opts = {}) {
	if (!name || !owner?.id) return;
	const entry = groups.get(name) ?? {
		name,
		moduleId: owner.id,
		moduleName: owner.name || owner.id,
		label: '',
		icon: null,
		kinds: new Set()
	};
	entry.kinds.add(kind);
	if (opts.label) entry.label = String(opts.label).slice(0, 80);
	if (opts.icon) entry.icon = String(opts.icon);
	groups.set(name, entry);
	moduleGroupsRevision.update((n) => n + 1);
}

/** @param {string} name @param {string} kind */
export function forgetModuleGroup(name, kind) {
	const entry = groups.get(name);
	if (!entry) return;
	entry.kinds.delete(kind);
	if (kind === 'listed') {
		entry.label = '';
		entry.icon = null;
	}
	if (!entry.kinds.size) groups.delete(name);
	if (get(moduleSelection)?.name === name && !groups.has(name)) clearModuleSelection();
	moduleGroupsRevision.update((n) => n + 1);
}

/** every registered module group, in a stable order (module, then name) */
export function moduleGroupList() {
	return [...groups.values()].sort(
		(a, b) => a.moduleName.localeCompare(b.moduleName) || a.name.localeCompare(b.name)
	);
}

/** @param {string} name */
export function moduleGroupOf(name) {
	return groups.get(name) ?? null;
}

/** A group name is an id ('untangle-module'); until the module names it with
 * registerListedGroup, show it the way a person would write it ('Untangle module').
 * @param {string} name */
export function humanize(name) {
	const words = String(name).replace(/[-_]+/g, ' ').trim();
	return words ? words[0].toUpperCase() + words.slice(1) : String(name);
}

/**
 * The rows the list draws: one per registered group PRESENT in the scene, with its named
 * descendants down to LIST_DEPTH, capped at LIST_CAP (the rest counted, not dropped
 * silently). A group a module registered but has not built yet is not listed — there is
 * nothing to frame or select.
 * @param {any} scene
 */
export function moduleContentRows(scene) {
	if (!scene) return [];
	/** @type {any[]} */
	const rows = [];
	for (const entry of moduleGroupList()) {
		const root = scene.getObjectByName(entry.name);
		// 30b P5: a registered group is re-homed under the world rig's module root
		// (moduleWorld.js — named, not imported, because that leaf imports this one)
		if (!root || (root.parent !== scene && root.parent?.name !== 'module-world-root')) continue;
		/** @type {{name: string, depth: number, uuid: string}[]} */
		const children = [];
		let total = 0;
		/** @param {any} node @param {number} depth */
		const walk = (node, depth) => {
			for (const child of node.children ?? []) {
				if (child.userData?.isModuleProxy) continue;
				if (child.name) {
					total++;
					if (children.length < LIST_CAP) children.push({ name: child.name, depth, uuid: child.uuid });
				}
				if (depth < LIST_DEPTH) walk(child, depth + 1);
			}
		};
		walk(root, 1);
		rows.push({
			name: entry.name,
			label: entry.label || humanize(entry.name),
			moduleId: entry.moduleId,
			moduleName: entry.moduleName,
			icon: entry.icon,
			object: root,
			visible: root.visible !== false,
			children,
			more: Math.max(0, total - children.length)
		});
	}
	return rows;
}

// --- the selection: a proxy, never the group ----------------------------------------

/** @type {import('svelte/store').Writable<{name: string, moduleId: string, moduleName: string, label: string} | null>} */
export const moduleSelection = writable(null);

/** @type {any} */
let proxy = null;
const box = new THREE.Box3();
let lastFit = 0;

/** @param {any} root */
function fitProxy(root) {
	if (!proxy || !root) return false;
	box.makeEmpty();
	// bounds of the GROUP only — the proxy is a scene-root sibling, never inside it
	box.setFromObject(root);
	if (box.isEmpty()) {
		const at = root.getWorldPosition(new THREE.Vector3());
		box.setFromCenterAndSize(at, new THREE.Vector3(0.5, 0.5, 0.5));
	}
	proxy.box.copy(box);
	proxy.updateMatrixWorld(true);
	return true;
}

/**
 * Select a module group: park the proxy around it and publish the selection. Returns the
 * group's world bounds (the caller frames them), or null when the group is not in the scene.
 * @param {string} name
 */
export function selectModuleGroup(name) {
	const scene = /** @type {any} */ (get(globalScene));
	const root = scene?.getObjectByName(name);
	const entry = groups.get(name);
	if (!root || !entry) return null;
	if (!proxy) {
		proxy = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0xf59e0b));
		proxy.name = 'module-content-proxy';
		proxy.userData.isModuleProxy = true;
		proxy.material.depthTest = false;
		proxy.material.transparent = true;
		proxy.renderOrder = 999;
		markHelper(proxy);
	}
	if (proxy.parent !== scene) scene.add(proxy);
	fitProxy(root);
	moduleSelection.set({ name, moduleId: entry.moduleId, moduleName: entry.moduleName, label: entry.label || humanize(name) });
	return box.clone();
}

export function clearModuleSelection() {
	if (proxy?.parent) proxy.parent.remove(proxy);
	if (get(moduleSelection)) moduleSelection.set(null);
}

/** Per frame (Scene's task): module content moves on its own, so the box follows it —
 * at a few Hz, because setFromObject walks the whole group. */
export function tickModuleProxy() {
	const selection = get(moduleSelection);
	if (!selection || !proxy?.parent) return;
	const now = performance.now();
	if (now - lastFit < 250) return;
	lastFit = now;
	const root = proxy.parent.getObjectByName(selection.name);
	if (!root) {
		clearModuleSelection();
		return;
	}
	fitProxy(root);
}

/** test/debug view */
export function moduleContentDebug() {
	return {
		groups: moduleGroupList().map((g) => ({ name: g.name, moduleId: g.moduleId, label: g.label, kinds: [...g.kinds] })),
		selection: get(moduleSelection),
		proxyInScene: !!proxy?.parent,
		proxyBox: proxy?.parent ? { min: proxy.box.min.toArray(), max: proxy.box.max.toArray() } : null
	};
}

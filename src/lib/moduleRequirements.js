import { get, writable } from 'svelte/store';
import { allNodes } from '../stores/flowStore';
import { moduleNodeGroups, loadedModules, disabledModules } from './moduleSDK';

// A6.2: "which modules does this scene need?" — DERIVED from what the scene
// actually USES, never from what happens to be installed. Installing everything
// present would prompt a player for five modules to open a scene that needs one.
//
// The shape is `[{id, version}]`, IDENTICAL to the handshake's
// `{type:'modules', versions:[{id,version}]}`, so there is exactly one shape for
// "which modules" in the whole system.
//
// Two derivation signals, both riding data that already replicates and already
// saves:
//   1. a node TYPE registered by a module (moduleNodeGroups items carry moduleId)
//   2. a `customnode` whose def id is `mod-<moduleId>-<key>` — the H2
//      registerNodeDefs naming, which is how flow-toolkit-style modules ship
//      code-editable nodes
// Deliberately NOT a signal: scene-root viewport content. That lives at the scene
// root by golden rule 5, so it is never in the saved objects — a module that only
// draws is rebuilt from its own state, and a scene cannot observe it.
//
// A LEAF by construction (two stores + moduleSDK, nothing that reaches history),
// so sessions.js can import it without opening a cycle.

// `mod-<moduleId>-<key>` is the registerNodeDefs id format (H2/A1) — and it is
// AMBIGUOUS on its own, because module ids contain hyphens too ('flow-toolkit',
// 'dungeon-realms'): a regex split would read `mod-flow-toolkit-greet` as module
// "flow". It is resolved against the ids we actually know instead, longest first,
// and an unresolvable def contributes nothing rather than a wrong id.
const MODULE_DEF_PREFIX = 'mod-';

/** moduleId for a node type, or null when it is a core type. @param {string} type */
export function moduleOfNodeType(type) {
	if (!type) return null;
	for (const group of get(moduleNodeGroups)) {
		const item = (group.items ?? []).find((/** @type {any} */ i) => i.type === type);
		if (item) return item.moduleId ?? null;
	}
	return null;
}

/** Every module id this device knows about, longest first. */
function knownModuleIds() {
	const ids = new Set(loadedModules.map((m) => m.id));
	for (const group of get(moduleNodeGroups))
		for (const item of group.items ?? []) if (item.moduleId) ids.add(item.moduleId);
	return [...ids].sort((a, b) => b.length - a.length);
}

/** moduleId behind a customnode instance's def, or null. @param {any} node */
function moduleOfCustomNode(node) {
	if (node?.type !== 'customnode') return null;
	const defId = node.data?.defId;
	if (typeof defId !== 'string' || !defId.startsWith(MODULE_DEF_PREFIX)) return null;
	for (const id of knownModuleIds()) if (defId.startsWith(MODULE_DEF_PREFIX + id + '-')) return id;
	return null;
}

/**
 * The modules this scene's flow needs, newest-known version each.
 * @returns {{id: string, version: string}[]} `[]` when the scene needs none, so
 * buildSessionPayload can save NULL and a default scene stays byte-identical.
 */
export function moduleRequirements() {
	/** @type {Set<string>} */
	const ids = new Set();
	for (const node of allNodes()) {
		const owner = moduleOfNodeType(node.type) ?? moduleOfCustomNode(node);
		if (owner) ids.add(owner);
	}
	return [...ids].sort().map((id) => ({
		id,
		version: loadedModules.find((m) => m.id === id)?.version ?? ''
	}));
}

/**
 * Split a saved requirement list against this device: what is missing entirely,
 * what is installed but switched off, and what is ready.
 *
 * Advisory by design, and it must stay that way — `checkModuleVersions` is too.
 * Installing a module here installs it for THIS player only; every peer needs
 * their own copy, which is the one sentence the prompt has to say out loud.
 * @param {any} list a payload's `modules` field (absent/garbage = nothing needed)
 */
export function classifyRequirements(list) {
	/** @type {{id: string, version: string}[]} */
	const wanted = Array.isArray(list)
		? list
				.filter((entry) => entry && typeof entry.id === 'string' && entry.id)
				.map((entry) => ({ id: String(entry.id), version: String(entry.version ?? '') }))
		: [];
	const off = get(disabledModules);
	const missing = [];
	const disabled = [];
	const ready = [];
	for (const entry of wanted) {
		if (off.includes(entry.id)) disabled.push(entry);
		else if (loadedModules.some((m) => m.id === entry.id)) ready.push(entry);
		else missing.push(entry);
	}
	return { wanted, missing, disabled, ready, satisfied: !missing.length && !disabled.length };
}

/** test/debug view */
export function moduleRequirementsDebug() {
	return {
		required: moduleRequirements(),
		types: get(moduleNodeGroups).flatMap((g) =>
			(g.items ?? []).map((/** @type {any} */ i) => ({ type: i.type, moduleId: i.moduleId ?? null }))
		)
	};
}

/**
 * A6.4: what the LAST loaded scene said it needs — remembered so an unknown-node
 * card can name its provider. The node itself cannot: an uninstalled module's node
 * types are, by definition, unknown to us, so the only source is the file's own
 * `modules` field.
 * @type {import('svelte/store').Writable<{id: string, version: string}[]>}
 */
export const sceneModules = writable([]);

/** Remember a loaded payload's declared requirements. @param {any} list */
export function rememberSceneModules(list) {
	sceneModules.set(classifyRequirements(list).wanted);
}

/**
 * The module an unknown node type most likely came from, or null.
 *
 * Deliberately only answers when it is UNAMBIGUOUS — one missing module means every
 * unknown node came from it. With two missing modules there is no honest way to
 * attribute a type we have never seen, and a wrong name is worse than none.
 * @param {string} type @returns {string|null}
 */
export function requiredModuleFor(type) {
	if (moduleOfNodeType(type)) return null; // we know it: not unknown at all
	const missing = classifyRequirements(get(sceneModules)).missing;
	return missing.length === 1 ? missing[0].id : null;
}

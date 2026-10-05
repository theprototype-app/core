// 36 B7: the NODE MANAGER's state — node types switched off on this device. The
// disabledModules pattern (a persisted id list, LOCAL): a disabled type leaves the palette,
// the add menus and the node search, so a long catalog can be trimmed to what a person
// actually uses. Nodes of that type already in a graph keep working (a graph is shared,
// a preference is not), and a type can always be switched back on in Settings ▸ Node types.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

const KEY = 'disabledNodeTypes';

function read() {
	try {
		const list = JSON.parse(safeStorage.getItem(KEY) ?? '[]');
		return Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
	} catch {
		return [];
	}
}

/** @type {import('svelte/store').Writable<string[]>} */
export const disabledNodeTypes = writable(typeof localStorage === 'undefined' ? [] : read());
disabledNodeTypes.subscribe((list) => {
	if (typeof localStorage === 'undefined') return;
	if (list.length) safeStorage.setItem(KEY, JSON.stringify(list));
	else safeStorage.removeItem(KEY);
});

/** @param {string[]} types @param {boolean} enabled */
export function setNodeTypesEnabled(types, enabled) {
	disabledNodeTypes.update((list) => {
		const set = new Set(list);
		for (const t of types) enabled ? set.delete(t) : set.add(t);
		return [...set].sort();
	});
}

/** @param {string} type */
export function nodeTypeEnabled(type) {
	return !get(disabledNodeTypes).includes(type);
}

/**
 * A palette/menu catalog without the disabled types (empty groups dropped).
 * @template {{group: string, items: {type: string}[]}} G
 * @param {G[]} groups @param {string[]} disabled @returns {G[]}
 */
export function enabledCatalog(groups, disabled) {
	if (!disabled.length) return groups;
	const off = new Set(disabled);
	return groups
		.map((g) => ({ ...g, items: g.items.filter((i) => !off.has(i.type)) }))
		.filter((g) => g.items.length > 0);
}

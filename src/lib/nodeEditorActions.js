// 36 U11: the node editor's keyboard commands, reached by NAME. A zero-import leaf.
//
// The keymap registry (shortcuts.js) owns the BINDINGS — so they are listed, rebindable and
// drawn on the `?` sheet with everything else — while the ACTIONS need the mounted editor
// (its xyflow instance for framing, the pointer for "add at cursor", the visible graph).
// The mounted Nodes.svelte installs its handlers here and removes them on unmount; a row
// whose editor is not mounted declines the key (`hasNodeAction`), so the press is left
// untouched for anybody else.

/** @typedef {(arg?: any) => void} NodeAction */

/** @type {Record<string, NodeAction>} */
let handlers = {};
/** @type {(() => boolean) | null} */
let insideGroupProbe = null;

/**
 * Install the mounted editor's handlers. Returns the uninstall (only removes what this
 * call installed, so a remount racing an unmount cannot strip the new instance).
 * @param {Record<string, NodeAction>} map @param {{insideGroup?: () => boolean}} [opts]
 */
export function installNodeActions(map, opts = {}) {
	handlers = { ...map };
	insideGroupProbe = opts.insideGroup ?? null;
	const mine = handlers;
	return () => {
		if (handlers !== mine) return;
		handlers = {};
		insideGroupProbe = null;
	};
}

/** @param {string} name */
export function hasNodeAction(name) {
	return typeof handlers[name] === 'function';
}

/** @param {string} name @param {any} [arg] @returns {boolean} ran */
export function runNodeAction(name, arg) {
	const fn = handlers[name];
	if (typeof fn !== 'function') return false;
	fn(arg);
	return true;
}

/** Is the editor showing the inside of a group right now? (Esc / Tab leave it.) */
export function nodeEditorInsideGroup() {
	try {
		return !!insideGroupProbe?.();
	} catch {
		return false;
	}
}

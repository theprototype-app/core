// 36 U11: "Open code" for a node — the one place the node editor's context menu asks
// whether a node HAS code and opens it. Script nodes open the script panel, behaviour nodes
// their derived view, custom nodes the node designer. 36-dataflow / 36-code (G1: double-
// click opens a script node's source in the code workspace) register their own openers
// in front through `registerCodeOpener`, so this file never has to learn about them.
import { get } from 'svelte/store';
import { scriptEditorOpen, behaviourViewOpen, nodeDesignerOpen, customNodeDefs } from '../stores/flowStore';

/** @typedef {(node: any, graphId: string) => boolean} CodeOpener — true = handled */

/** @type {{has: (node: any) => boolean, open: CodeOpener}[]} */
const openers = [];

/** Put an opener IN FRONT of the built-ins. Returns the unregister.
 * @param {(node: any) => boolean} has @param {CodeOpener} open */
export function registerCodeOpener(has, open) {
	const entry = { has, open };
	openers.unshift(entry);
	return () => {
		const i = openers.indexOf(entry);
		if (i >= 0) openers.splice(i, 1);
	};
}

/** @param {any} node */
function builtinHas(node) {
	return node?.type === 'script' || node?.type === 'behaviour' || node?.type === 'customnode';
}

/** Does this node have code a user can open? @param {any} node */
export function nodeHasCode(node) {
	if (!node) return false;
	return openers.some((o) => safe(() => o.has(node))) || builtinHas(node);
}

/** Open it. @param {any} node @param {string} graphId @returns {boolean} */
export function openNodeCode(node, graphId) {
	for (const o of openers) if (safe(() => o.has(node)) && safe(() => o.open(node, graphId))) return true;
	if (node?.type === 'script') {
		scriptEditorOpen.set(node.id);
		return true;
	}
	if (node?.type === 'behaviour') {
		behaviourViewOpen.set({ id: node.id, graphId });
		return true;
	}
	if (node?.type === 'customnode') {
		const def = get(customNodeDefs).find((d) => d.id === node.data?.defId);
		if (def) {
			nodeDesignerOpen.set(def);
			return true;
		}
	}
	return false;
}

/** @param {() => any} fn */
function safe(fn) {
	try {
		return !!fn();
	} catch {
		return false;
	}
}

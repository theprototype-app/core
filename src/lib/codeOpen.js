// 36 (contract G1, phase 4): CODE <-> NODE. Every node that carries code answers double-click /
// "Open code" with its source, and a module-owned one can be forked into an editable copy.
//
// THE SEAM: 36-code (plan 75, the code workspace) registers `registerCodeOpener(fn)`; until it
// is merged — or when it declines a request (returns false) — the editor's existing surfaces
// open instead: the Script panel, the behaviour view, the Node Designer, and for a module's
// own files the read-only Module source window (ModuleSourceWindow.svelte, mounted in Flow).
// The request shape is graphContract's OpenCodeRequest (`openCodeRequestFor(node, graphId)`).
//
// MODULE SOURCE: a core module's files are its `src/modules/<id>/*.js`, read as raw text in a
// lazy chunk (import.meta.glob ?raw — nothing joins the boot bundle); an installed module's are
// the bytes its record already keeps (userModules `files`). Either is shown READ-ONLY: a repo
// file is not the user's to change, and editing it in place would change it for nobody else.
//
// THE FORK ("Make editable copy"): a node bound to a module file (`data.src.kind === 'module'`)
// keeps its running text in `data.code` (G1 rule 3), so the copy is (a) an Explorer script asset
// holding that text — the user's own file, hash-bound — and (b) `data.src` re-pointed at it.
// One setNodeData, so the fork replicates, undoes and hashes like any node edit, and every peer
// keeps running exactly the text it ran before the click.

import { get, writable } from 'svelte/store';
import { strFromU8 } from 'fflate';
import { scriptEditorOpen, behaviourViewOpen, nodeDesignerOpen, activeGraphId, setActiveGraph, graphOf } from '../stores/flowStore';
import { setNodeData } from './nodesHandler';
import { recordFlowNodesEntry } from './flowGraphs';

/** @typedef {import('./graphContract.js').OpenCodeRequest} OpenCodeRequest */

/** @type {((req: OpenCodeRequest) => boolean | Promise<boolean>) | null} */
let opener = null;

/**
 * 36-code's hook: take over "Open code". Return false from `fn` to decline one request (the
 * fallback then opens it). Returns the unregister function.
 * @param {(req: OpenCodeRequest) => boolean | Promise<boolean>} fn
 */
export function registerCodeOpener(fn) {
	opener = fn;
	return () => {
		if (opener === fn) opener = null;
	};
}

/** what the read-only Module source window shows @type {import('svelte/store').Writable<{module: string, file?: string, line?: number, nodeId?: string, graphId?: string} | null>} */
export const moduleSourceOpen = writable(null);

/** the last request routed — for the debug hook and the e2e @type {OpenCodeRequest | null} */
let lastRequest = null;
export const lastOpenCode = () => lastRequest;

/**
 * Open a node's code. True when something opened it.
 * @param {OpenCodeRequest | null} req
 */
export async function openCode(req) {
	if (!req) return false;
	lastRequest = req;
	if (opener) {
		try {
			if ((await opener(req)) !== false) return true;
		} catch (error) {
			console.log('code opener failed, using the built-in panel', error);
		}
	}
	return fallbackOpen(req);
}

/** @param {OpenCodeRequest} req */
function fallbackOpen(req) {
	if (req.graphId && req.graphId !== get(activeGraphId)) setActiveGraph(req.graphId);
	switch (req.source) {
		case 'script':
			scriptEditorOpen.set(req.ref);
			return true;
		case 'behaviour':
			// `code: true` — the view opens with its source panel shown (Open code means the code)
			behaviourViewOpen.set(/** @type {any} */ ({ id: req.ref, graphId: req.graphId ?? get(activeGraphId), code: true }));
			return true;
		case 'customnode':
			// the Designer opens on the def OBJECT (its own seeding rule)
			void import('./customNodes').then((m) => {
				const def = m.findNodeDef(req.ref);
				if (def) nodeDesignerOpen.set(def);
			});
			return true;
		case 'module': {
			const [module, ...rest] = String(req.ref).split('/');
			moduleSourceOpen.set({ module, file: rest.join('/') || undefined, line: req.line });
			return true;
		}
	}
	return false;
}

// core modules' source, as raw text, in a lazy chunk per file — and the kit's (a kit node's
// code is its piece's file: `kit/<piece>.js` beside `<piece>.spec.js`)
const CORE_SOURCES = import.meta.glob('../modules/*/*.js', { query: '?raw', import: 'default' });
const KIT_SOURCES = import.meta.glob('./kit/*.js', { query: '?raw', import: 'default' });

/**
 * A module's source files, entry first. Core modules from the repo (raw), installed ones from
 * their stored record. [] when the module is unknown here (not installed, not core).
 * @param {string} moduleId
 * @returns {Promise<{file: string, text: string}[]>}
 */
export async function moduleSourceFiles(moduleId) {
	const id = String(moduleId ?? '');
	if (id === 'kit')
		return Promise.all(
			Object.keys(KIT_SOURCES)
				.sort()
				.map(async (k) => ({ file: k.slice('./kit/'.length), text: String(await KIT_SOURCES[k]()) }))
		);
	const prefix = '../modules/' + id + '/';
	const core = Object.keys(CORE_SOURCES).filter((k) => k.startsWith(prefix));
	if (core.length) {
		core.sort((a, b) => (a.endsWith('/module.js') ? -1 : b.endsWith('/module.js') ? 1 : a.localeCompare(b)));
		return Promise.all(core.map(async (k) => ({ file: k.slice(prefix.length), text: String(await CORE_SOURCES[k]()) })));
	}
	const { userModules } = await import('./userModules');
	const record = /** @type {any[]} */ (get(userModules)).find((m) => m.id === id);
	if (!record?.files) return [];
	const names = Object.keys(record.files).filter((f) => /\.(m?js|json|md)$/.test(f));
	names.sort((a, b) => (a === record.entry ? -1 : b === record.entry ? 1 : a.localeCompare(b)));
	return names.map((file) => ({ file, text: strFromU8(record.files[file]) }));
}

/**
 * "Make editable copy": fork a module-bound node's source into an Explorer script asset and
 * re-point the node at it. Returns the new `data.src`, or null when there is nothing to fork.
 * @param {string} nodeId @param {string} [graphId]
 */
export async function forkNodeSource(nodeId, graphId) {
	const gid = graphId ?? get(activeGraphId);
	const node = graphOf(gid)?.nodes.find((/** @type {any} */ n) => n.id === nodeId);
	const src = node?.data?.src;
	if (!node || src?.kind !== 'module') return null;
	const text = String(node.data.code ?? '');
	const base = String(src.file ?? node.type + '.js').split('/').pop() || 'script.js';
	const name = base.replace(/\.m?js$/, '') + ' (copy).js';
	const { addItemFromBytes } = await import('./explorer');
	const item = await addItemFromBytes(new TextEncoder().encode(text).buffer, name, null, {});
	/** @type {import('./graphContract.js').CodeSrc} */
	const next = { kind: 'asset', hash: String(item?.hash ?? ''), name: item?.name ?? name };
	setNodeData(nodeId, { src: next }, gid);
	recordFlowNodesEntry({ op: 'data', graphId: gid, items: [{ id: nodeId, before: { src }, after: { src: next } }] });
	return next;
}

/** Is this node's code read-only here (bound to a module file, not yet forked)? @param {any} node */
export function codeIsReadOnly(node) {
	return node?.data?.src?.kind === 'module';
}

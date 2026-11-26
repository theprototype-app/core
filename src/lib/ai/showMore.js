// Roadmap 107 (connector round 3, owner report 27 Nov) — three more `show` actions, a lazy chunk showTool.js
// loads on their first call. They ride the PANEL kind's first-use answer (Always / This time / No): one
// question covers "your panels and what is selected in them", where three new kinds would be three more
// prompts (the same report asks for fewer). Every one leaves the person a line with Back and pushes its undo.
//
//   reveal  {path | id, state?: 'open'}  a Library file or folder in the Explorer: the tree expanded down to
//           it (explorer.expandExplorerTo), the folder that holds it on screen, its card selected and scrolled
//           to (explorer.revealItem, the Explorer's own Reveal; a folder id reveals the folder). state 'open'
//           walks INTO a folder instead (activeFolder). Only the Explorer's public seams, no component state.
//   select  {uuids, mode: set | add | remove | clear}  the person's selection, and NOTHING moves the camera
//           (show camera {select} is the one that flies). Clear lands the Inspector on the scene's settings and
//           the Flow editor on the scene flow (the Flow editor follows the selection by itself).
//   flow    {object | node, select?}  the Flow editor on the scene flow (nothing / "scene"), an object's flow
//           (object: uuid) or the flow holding a node, with that node selected and framed (node: id). The
//           Flow editor's scope FOLLOWS the selection (H1), so by default the owner is selected the way the
//           Code tab's "Bound nodes" does it (codeWorkspace.goToNode); select: false sets the scope alone,
//           which holds until the person's selection changes.

import { get } from 'svelte/store';
import { objectsGroup, selectedObjects, isLocked } from '../../stores/sceneStore';
import { inspectorClose, inspectorKind } from '../../stores/appStore';
import { resolveRef, pathOfFolder, pathOfItem } from './filesCore.js';

/**
 * @typedef {{by: string, fail: (msg: string, extra?: any) => any, line: (text: string) => void,
 *   push: (label: string, undo: () => Promise<string> | string) => void, openPanel: (id: string) => Promise<any>,
 *   isOpen: (id: string) => Promise<boolean>, inVR: () => boolean, nameOf: (uuid: string) => string}} ShowCtx
 */

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** open a panel the action needs, and the undo half that closes it again @param {string} id @param {ShowCtx} ctx */
async function ensurePanel(id, ctx) {
	const was = await ctx.isOpen(id);
	await ctx.openPanel(id); // opens it, or brings an open one forward (focusWindow): the person should SEE the answer
	return was;
}

// ---------------------------------------------------------------- reveal

/** @param {any} args @param {ShowCtx} ctx */
async function revealAction(args, ctx) {
	const ex = await import('../explorer');
	await ex.loadExplorer();
	const folders = /** @type {any[]} */ (get(ex.explorerFolders));
	const items = /** @type {any[]} */ (get(ex.explorerItems));
	if (!args.path && !args.id) return ctx.fail('reveal: path (a Library file "Sounds/boom.ogg" or folder "Sounds/") or id');
	const r = resolveRef({ path: args.path, id: args.id }, folders, items);
	if (r.type === 'none') return ctx.fail(r.missing?.length ? 'no folder "' + r.missing.join('/') + '" in the Library (files {action: "list"})' : 'no file or folder "' + (r.name ?? args.path ?? args.id) + '" in the Library (files {action: "list"} shows what is there)');
	const open = String(args.state ?? '') === 'open';
	const root = r.type === 'folder' && r.id === null;
	const folder = r.type === 'folder' && !root ? folders.find((f) => f.id === r.id) : null;
	const prevFolder = get(ex.activeFolder);
	const wasOpen = await ensurePanel('explorer', ctx);
	/** the folder the grid should land on, and the card to select there (null = none) */
	let lands = /** @type {string | null} */ (null);
	let card = /** @type {string | null} */ (null);
	if (root) ex.activeFolder.set(null);
	else if (r.type === 'file') {
		lands = r.item.folderId ?? null;
		card = r.item.id;
		ex.expandExplorerTo(lands);
		ex.revealItem(r.item.id);
	} else if (open) {
		lands = folder.id;
		ex.expandExplorerTo(folder.id);
		ex.activeFolder.set(folder.id);
	} else {
		lands = folder.parentId ?? null;
		card = folder.id;
		ex.expandExplorerTo(lands);
		ex.revealItem(folder.id);
	}
	// the Explorer acts on the next frames (and may be mounting): watch for the card, a few seconds at most
	/** @returns {{at: boolean, shown: boolean, selected: boolean}} */
	const look = () => {
		const el = card && typeof document !== 'undefined' ? document.querySelector('[data-card-id="' + card + '"]') : null;
		return { at: (get(ex.activeFolder) ?? null) === lands, shown: !!el, selected: !!el && /\bborder-accent\b/.test(String(el.className)) };
	};
	let seen = look();
	for (let i = 0; i < 40 && !(seen.at && (!card || seen.selected)); i++) {
		await sleep(75);
		seen = look();
	}
	const path = root ? '/' : r.type === 'file' ? pathOfItem(r.item, folders) : pathOfFolder(String(r.id), folders) + '/';
	ctx.push('showed ' + path + ' in the Explorer', async () => {
		ex.activeFolder.set(prevFolder ?? null);
		if (!wasOpen) {
			const { closeDockView } = await import('../dockMenu');
			closeDockView('explorer');
		}
		return 'put the Explorer back';
	});
	const what = root ? 'the Library' : '"' + (r.type === 'file' ? r.item.name : folder?.name) + '"';
	ctx.line(ctx.by + (open || root ? ' opened ' + what + ' in the Explorer' : ' showed you ' + what + ' in the Explorer'));
	return {
		revealed: r.type,
		path,
		...(open || root ? { opened: true } : { selected: seen.selected }),
		inFolder: lands ? pathOfFolder(lands, folders) + '/' : '/',
		...(!seen.at ? { note: 'The Explorer is still opening: it lands there as soon as it is up (screenshot to check).' } : {}),
		...(ctx.inVR() ? { note: 'The person is in a headset: they see it when they take it off.' } : {})
	};
}

// ---------------------------------------------------------------- select

const MODES = ['set', 'add', 'remove', 'clear'];

/** @param {any} args @param {ShowCtx} ctx */
async function selectAction(args, ctx) {
	if (get(isLocked) === true) return ctx.fail('the person is playing (Play mode): ask them to press Esc first', { refused: true });
	const mode = String(args.mode ?? (args.uuids === undefined && args.frame === undefined ? '' : 'set'));
	if (!MODES.includes(mode)) return ctx.fail('select: mode set | add | remove | clear (with uuids: the objects, list_scene gives them)');
	const raw = args.uuids ?? args.frame;
	const want = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).map(String).filter(Boolean);
	if (mode !== 'clear' && !want.length) return ctx.fail('select: uuids, the objects to ' + (mode === 'remove' ? 'take out of' : mode === 'add' ? 'add to' : 'select as') + ' the selection');
	/** @type {any} */
	const group = get(objectsGroup);
	const missing = want.filter((u) => !group?.getObjectByProperty('uuid', u));
	if (missing.length) return ctx.fail(missing.length + ' of those uuids are not in the scene (list_scene gives real ones)', { missing: missing.slice(0, 10) });
	const prev = /** @type {string[]} */ ([...(get(selectedObjects) ?? [])]);
	const prevKind = get(inspectorKind);
	const oa = await import('../objectActions');
	const { activeGraphId } = await import('../../stores/flowStore');
	const next = mode === 'set' ? want : mode === 'add' ? [...prev, ...want.filter((u) => !prev.includes(u))] : mode === 'remove' ? prev.filter((u) => !want.includes(u)) : [];
	if (next.length) oa.applySelectionSet(next, false);
	else {
		oa.deselectObject();
		// the owner's rule (107): a cleared selection shows the SCENE in an open Inspector, never the last object
		if (!get(inspectorClose) && get(inspectorKind) === 'selection') inspectorKind.set('scene');
	}
	const now = /** @type {string[]} */ ([...(get(selectedObjects) ?? [])]);
	const held = next.filter((u) => !now.includes(u));
	ctx.push(mode === 'clear' ? 'cleared the selection' : 'changed the selection', () => {
		if (prev.length) oa.applySelectionSet(prev, false);
		else oa.deselectObject();
		if (get(inspectorKind) !== prevKind && !get(inspectorClose)) inspectorKind.set(prevKind);
		return 'put the selection back';
	});
	const say = now.length === 1 ? ctx.nameOf(now[0]) : now.length + ' objects';
	ctx.line(ctx.by + (now.length ? ' selected ' + say : ' cleared your selection'));
	return {
		selected: now,
		count: now.length,
		...(held.length ? { notSelected: held, why: 'someone else holds ' + (held.length === 1 ? 'it' : 'them') + ' (a peer is editing)' } : {}),
		inspector: get(inspectorClose) ? 'closed' : get(inspectorKind),
		flow: get(activeGraphId),
		camera: 'unchanged'
	};
}

// ---------------------------------------------------------------- flow

/** @param {any} args @param {ShowCtx} ctx */
async function flowAction(args, ctx) {
	const fs = await import('../../stores/flowStore');
	const SCENE = fs.SCENE_GRAPH;
	/** @type {string} */
	let graph = SCENE;
	/** @type {string | null} */
	let node = null;
	if (args.node) {
		const hit = /** @type {any} */ (fs.findNodeAnyGraph((/** @type {any} */ n) => n.id === String(args.node)));
		if (!hit?.node) return ctx.fail('no flow node "' + String(args.node) + '" (list_scene {flow: uuid | "scene"} lists them)');
		graph = hit.graphId;
		node = hit.node.id;
		if (args.object && String(args.object) !== graph && !(String(args.object) === 'scene' && graph === SCENE)) return ctx.fail('node "' + node + '" is in ' + (graph === SCENE ? 'the scene flow' : 'the flow of ' + ctx.nameOf(graph)) + ', not that object\'s');
	} else if (args.object && String(args.object) !== 'scene') {
		graph = String(args.object);
		/** @type {any} */
		const group = get(objectsGroup);
		if (!group?.getObjectByProperty('uuid', graph)) return ctx.fail('"' + graph + '" is not an object in the scene (list_scene gives uuids; object: "scene" or nothing = the scene flow)');
	}
	const prevSel = /** @type {string[]} */ ([...(get(selectedObjects) ?? [])]);
	const prevGraph = get(fs.activeGraphId);
	const oa = await import('../objectActions');
	const select = args.select !== false;
	const wasOpen = await ensurePanel('flow', ctx);
	if (select) {
		// the Flow editor's scope follows the selection: select the owner (or nothing, for the scene flow) the way
		// the Code tab's Bound nodes does — a held object is VIEWED (its flow shows view-only)
		if (graph === SCENE) oa.deselectObject();
		else {
			const { heldByOther } = await import('../lockHeld');
			if (heldByOther(graph)) oa.selectObject(graph);
			else oa.applySelectionSet([graph], false);
		}
	}
	fs.setActiveGraph(graph);
	if (node) {
		const { flowFocus } = await import('../../stores/appStore');
		// the Flow editor consumes it (enters the node's group, selects and frames it); a closed editor on mount
		await sleep(30);
		flowFocus.set(node);
	}
	const graphDoc = /** @type {any} */ (get(fs.flowGraphs))[graph];
	ctx.push('showed a flow', async () => {
		if (select) {
			if (prevSel.length) oa.applySelectionSet(prevSel, false);
			else oa.deselectObject();
		}
		fs.setActiveGraph(prevGraph);
		if (!wasOpen) {
			const { closeDockView } = await import('../dockMenu');
			closeDockView('flow');
		}
		return 'put the Flow editor back';
	});
	const label = graph === SCENE ? 'the scene flow' : 'the flow of ' + ctx.nameOf(graph);
	ctx.line(ctx.by + ' showed you ' + (node ? 'a node in ' : '') + label);
	return {
		flow: graph === SCENE ? 'scene' : graph,
		name: graph === SCENE ? 'Scene' : ctx.nameOf(graph).replace(/"/g, ''),
		nodes: (graphDoc?.nodes ?? []).length,
		...(node ? { node, selectedNode: true } : {}),
		...(graph !== SCENE && !graphDoc ? { empty: true, note: 'That object has no flow yet: the person sees "Create flow" (create_flow_nodes adds one).' } : {}),
		selection: select ? (graph === SCENE ? 'cleared (the scene flow shows with nothing selected)' : 'the object') : 'unchanged: the flow shows until the person selects something else',
		panel: 'Flow editor'
	};
}

/**
 * @param {string} action @param {any} args @param {ShowCtx} ctx
 */
export async function showMore(action, args, ctx) {
	if (action === 'reveal') return revealAction(args, ctx);
	if (action === 'select') return selectAction(args, ctx);
	if (action === 'flow') return flowAction(args, ctx);
	return ctx.fail('action: reveal, select or flow');
}

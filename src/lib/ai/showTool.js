// Roadmap 104 C2 — `show`: the assistant drives the person's OWN interface, in their own tab. A lazy
// chunk (personTools.js loads it on the first call). The rules are listed in showCore.js.
//
//   panel   {name, state: open | close | focus}   the allow-list in showCore.SHOW_PANELS, through the app's
//           own toggles (panelToggles / dockHost / showSidebar / openChatTab), so a panel opens where
//           the person keeps it (dock, sidebar, floating)
//   camera  {frame: [uuids]} | {position, target} | {through: cameraUuid}, select: true selects what was
//           framed. objectActions.flyTo (0.6 s, an instant cut under reduced motion) / startCameraPreview
//   code    {path | id | node | object, line, to, select: {from, to}, find}: codeWorkspace.openCode, then
//           the editor's reveal seam selects (CodeEditor `reveal.select`). Never edits text.
//   back    undo what the newest `show` changed (a stack of 10)
//
// Each kind asks the person once (Always / This time / No): Always is stored on this device
// (safeStorage `show:allow:<kind>`, the switches in Settings ▸ Privacy), This time and No last
// until the page reloads, per app. An app the Worker cannot name ("an AI app") is never offered Always
// and never uses a stored one (104-int: 89's app names x 104's show).

import { get } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { showToastById, inspectorClose, inspectorKind, chatHidden, chatTab, showSidebar, closeSelectionInspector, specatorMode } from '../../stores/appStore';
import { globalCamera, orbitControls, globalRenderer, objectsGroup, TControls, isLocked, selectedObjects, marqueeRect, isVRMode } from '../../stores/sceneStore';
import { askPerson } from './personAsk.js';
import {
	SHOW_PANELS,
	SHOW_PER_MINUTE,
	CAMERA_GAP_MS,
	FLY_MS,
	KIND_WORDS,
	panelOf,
	deniedPanel,
	frameBox,
	isVec3,
	findRange
} from './showCore.js';
import { createRateLimit, resolveRef, isTextName, extOf } from './filesCore.js';
import { isDirty } from '../codeTabs';

/** this page's answers: 'session' (This time) | 'no' @type {Map<string, string>} */
const answers = new Map();
const calls = createRateLimit(SHOW_PER_MINUTE);
let lastCameraAt = 0;
/** what `back` undoes, newest last @type {{label: string, undo: () => Promise<string> | string}[]} */
let stack = [];
const STACK_MAX = 10;
const debug = { done: 0, back: 0, refused: 0, last: /** @type {any} */ (null) };

/** @param {string} msg @param {any} [extra] */
const fail = (msg, extra) => {
	debug.refused++;
	return { error: msg, ...(extra ?? {}) };
};

/** @param {string} kind */
export const allowKey = (kind) => 'show:allow:' + kind;

/** an app with a trusted name (Claude, ChatGPT, the in-app assistant), not one the Worker could not name @param {string} by */
const trustedApp = (by) => !/^(an )?ai app$/i.test(by.trim());
/** this page's answer for one kind, per app @param {string} kind @param {string} by */
const answerKey = (kind, by) => kind + '\n' + by;

/** is this kind allowed without asking @param {string} kind @param {string} by */
function allowed(kind, by) {
	if (answers.get(answerKey(kind, by)) === 'session') return true;
	if (!trustedApp(by)) return false;
	try {
		return safeStorage.getItem(allowKey(kind)) === 'always';
	} catch {
		return false;
	}
}

/** why the view is not free to move (a recording, Film on the phone, a sequence shot), or '' */
export async function busyCamera() {
	try {
		const { lookingThrough } = await import('../connector/throughCamera.js');
		const kind = lookingThrough()?.kind;
		if (kind === 'recording') return 'the person is recording a video: wait until the recording stops (where_are_users says when)';
		if (kind === 'phone') return 'the person is filming with their phone (Film): wait until they close Film';
		if (kind === 'sequence') return 'a sequence is playing its shots: wait until it ends';
	} catch {}
	return '';
}

/** the person is in a headset */
function inVR() {
	/** @type {any} */
	const r = get(globalRenderer);
	return !!r?.xr?.isPresenting || !!get(isVRMode);
}

/** a key pressed in a text field this recently is typing; focus alone is not (show code itself focuses the
 * editor it opens, and a person reading code has it focused too) */
const TYPING_QUIET_MS = 3000;
let lastKeyAt = -Infinity;
if (typeof window !== 'undefined') {
	window.addEventListener('keydown', () => (lastKeyAt = performance.now()), { capture: true, passive: true });
}

/** why the person's hands are busy, or null (rule 7) */
function busyReason() {
	/** @type {any} */
	const tc = get(TControls);
	if (tc?.dragging) return 'the person is dragging an object';
	if (get(marqueeRect)) return 'the person is selecting with a box';
	if (typeof document !== 'undefined') {
		const el = /** @type {any} */ (document.activeElement);
		// the person's own assistant chat is where they just typed to us: that is not "typing elsewhere"
		const inChat = !!el?.closest?.('#chat-window');
		const typing = !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|email|url|number|password|)$/i.test(el.type ?? '')));
		if (typing && !inChat && performance.now() - lastKeyAt < TYPING_QUIET_MS) return 'the person is typing';
	}
	return null;
}

/** the line the person sees, with Back @param {string} text */
function line(text) {
	showToastById('show-line', text + '.', [{ label: 'Back', action: () => void back() }]);
}

/** @param {string} label @param {() => Promise<string> | string} undo */
function push(label, undo) {
	stack = [...stack, { label, undo }].slice(-STACK_MAX);
}

async function back() {
	const top = stack.pop();
	if (!top) return null;
	debug.back++;
	const said = await top.undo();
	showToastById('show-line', 'Back: ' + (said || top.label) + '.', []);
	return said || top.label;
}

/** @param {number} frames */
const waitFrames = (frames) =>
	new Promise((resolve) => {
		let n = 0;
		const step = () => (++n >= frames || typeof requestAnimationFrame === 'undefined' ? resolve(undefined) : requestAnimationFrame(step));
		if (typeof requestAnimationFrame === 'undefined') setTimeout(resolve, frames * 16);
		else requestAnimationFrame(step);
	});

// ---------------------------------------------------------------- panel

/** @param {string} key */
async function panelOpenNow(key) {
	const { windowWhere } = await import('../dockMenu');
	return windowWhere(key) !== null;
}

/** @param {string} id the SHOW_PANELS id */
async function isOpen(id) {
	const p = SHOW_PANELS[id];
	if (p.via === 'inspector') return !get(inspectorClose) && get(inspectorKind) === 'selection';
	if (p.via === 'chat') return get(chatHidden) === '' && get(chatTab) === (id === 'assistant' ? 'assistant' : 'session');
	return panelOpenNow(p.key);
}

/** @param {string} id */
async function openPanel(id) {
	const p = SHOW_PANELS[id];
	if (p.via === 'inspector') return showSidebar('properties', { focus: true });
	if (p.via === 'chat') {
		const { openChatTab } = await import('../chat/chatWindow.js');
		return openChatTab(id === 'assistant' ? 'assistant' : 'session');
	}
	const { focusWindow } = await import('../dockMenu');
	if (focusWindow(p.key)) return;
	if (p.via === 'toggle') {
		const { togglePanel } = await import('../panelToggles');
		return togglePanel(p.key);
	}
	const { HOSTED } = await import('../dockHost');
	HOSTED[p.key]?.open();
}

/** @param {string} id */
async function closePanel(id) {
	const p = SHOW_PANELS[id];
	if (p.via === 'inspector') return closeSelectionInspector();
	if (p.via === 'chat') return chatHidden.set('hidden');
	if (p.via === 'hosted') {
		const { HOSTED } = await import('../dockHost');
		return HOSTED[p.key]?.close();
	}
	const { closeDockView } = await import('../dockMenu');
	closeDockView(p.key);
}

/** @param {any} args @param {string} by */
async function panelAction(args, by) {
	const asked = String(args.name ?? args.panel ?? '');
	if (!asked) return fail('name: the panel to show — ' + Object.values(SHOW_PANELS).map((p) => p.label).join(', '));
	if (deniedPanel(asked)) return fail('"' + asked + '" is not something show opens: sign-in, account, consent, publishing, connected apps, payment and settings stay the person\'s own to open', { refused: true });
	const id = panelOf(asked);
	if (!id) return fail('no panel "' + asked + '": show opens ' + Object.values(SHOW_PANELS).map((p) => p.label).join(', '));
	const state = String(args.state ?? 'open');
	if (!['open', 'close', 'focus'].includes(state)) return fail('state: open, close or focus');
	const label = SHOW_PANELS[id].label;
	const was = await isOpen(id);
	if (state === 'close') {
		if (!was) return { panel: label, state: 'closed', changed: false };
		await closePanel(id);
		push('closed ' + label, async () => {
			await openPanel(id);
			return 'reopened ' + label;
		});
		line(by + ' closed ' + label);
		return { panel: label, state: 'closed', changed: true };
	}
	await openPanel(id);
	if (!was)
		push('opened ' + label, async () => {
			await closePanel(id);
			return 'closed ' + label;
		});
	line(by + (was ? ' brought ' + label + ' forward' : ' opened ' + label));
	return { panel: label, state: 'open', changed: !was, ...(inVR() ? { note: 'The person is in a headset: panels show when they take it off.' } : {}) };
}

// ---------------------------------------------------------------- camera

/** the box around some objects, in world space @param {string[]} uuids */
async function boxOf(uuids) {
	const THREE = await import('three');
	/** @type {any} */
	const group = get(objectsGroup);
	const found = uuids.map((u) => group?.getObjectByProperty('uuid', u)).filter(Boolean);
	if (!found.length) return null;
	const box = new THREE.Box3();
	for (const o of found) box.expandByObject(o);
	if (box.isEmpty()) {
		for (const o of found) box.expandByPoint(o.getWorldPosition(new THREE.Vector3()));
	}
	const c = box.getCenter(new THREE.Vector3());
	return { center: [c.x, c.y, c.z], radius: Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5), found: found.length };
}

/** @returns {{position: number[], target: number[]} | null} */
function cameraPose() {
	/** @type {any} */
	const cam = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	if (!cam || !controls?.target) return null;
	return { position: cam.position.toArray(), target: controls.target.toArray() };
}

/** @param {any} args @param {string} by */
async function cameraAction(args, by) {
	if (inVR()) return fail('the person is in a VR headset: show does not move a headset\'s view in this release (it would be uncomfortable). Ask them where to look, or use where_are_users.', { refused: true, vr: true });
	if (get(isLocked) === true) return fail('the person is playing (Play mode): their camera belongs to the game. Ask them to press Esc first.', { refused: true });
	if (get(specatorMode)) return fail('the person is watching someone else\'s view: ask them to press Exit first.', { refused: true });
	// 104-int (104-world x 104-show): a recording, Film on the phone or a sequence shot owns the view; moving it would cut the take
	const wait = CAMERA_GAP_MS - (Date.now() - lastCameraAt);
	if (wait > 0) return fail('one camera move at a time: wait ' + Math.ceil(wait / 1000) + ' s', { retryAfter: Math.ceil(wait / 1000) });
	const through = await busyCamera();
	if (through) return fail(through, { refused: true, busy: true });
	const { cameraPreview, startCameraPreview, stopCameraPreview } = await import('../cameraPreview');
	/** @type {any} */
	const preview = get(cameraPreview);
	if (args.through !== undefined) {
		const uuid = String(args.through ?? '');
		if (!startCameraPreview(uuid)) return fail('"' + uuid + '" is not a camera in the scene (list_scene type "camera")');
		lastCameraAt = Date.now();
		push('looked through a camera', () => {
			stopCameraPreview();
			if (preview?.uuid) startCameraPreview(preview.uuid);
			return 'back to the view before';
		});
		line(by + ' showed you the view through ' + nameOf(uuid));
		return { through: uuid, name: nameOf(uuid), note: 'The person now looks through that camera (an "Exit" strip at the top takes them back); screenshot {view: "current"} sees what they see.' };
	}
	const uuids = (Array.isArray(args.frame) ? args.frame : typeof args.frame === 'string' ? [args.frame] : []).map(String).filter(Boolean);
	/** @type {{position: number[], target: number[]} | null} */
	let goal = null;
	/** @type {any} */
	let framed = null;
	if (uuids.length) {
		framed = await boxOf(uuids);
		if (!framed) return fail('frame: none of those uuids is in the scene (list_scene gives real ones)');
	} else if (isVec3(args.position) && isVec3(args.target)) goal = { position: args.position, target: args.target };
	else return fail('camera: frame: [uuids], or position + target ([x, y, z] each), or through: a camera uuid');
	// looking through a camera: step out first (the editor camera is the one that moves)
	if (preview) {
		stopCameraPreview();
		await waitFrames(30);
	}
	const before = cameraPose();
	/** @type {any} */
	const cam = get(globalCamera);
	if (!before || !cam) return fail('the 3D view is not ready yet: try again in a moment');
	if (framed) {
		const dir = [before.position[0] - before.target[0], before.position[1] - before.target[1], before.position[2] - before.target[2]];
		goal = frameBox(framed, cam.fov ?? 50, Math.hypot(dir[0], dir[1], dir[2]) > 1e-6 ? dir : [0, 0.5, 1]);
	}
	if (!goal) return fail('camera: nothing to look at');
	const { flyTo, applySelectionSet } = await import('../objectActions');
	flyTo(goal.position, goal.target, FLY_MS);
	lastCameraAt = Date.now();
	const prevSel = /** @type {string[]} */ ([...(get(selectedObjects) ?? [])]);
	const select = args.select === true && uuids.length;
	if (select) applySelectionSet(uuids, false);
	push('moved the view', async () => {
		if (select) applySelectionSet(prevSel, false);
		if (preview?.uuid) startCameraPreview(preview.uuid);
		else flyTo(before.position, before.target, FLY_MS);
		return 'moved the view back';
	});
	line(by + (uuids.length ? ' showed you ' + (uuids.length === 1 ? nameOf(uuids[0]) : uuids.length + ' objects') : ' moved your view') + (select ? ' and selected ' + (uuids.length === 1 ? 'it' : 'them') : ''));
	return {
		moved: true,
		position: goal.position.map((n) => +n.toFixed(2)),
		target: goal.target.map((n) => +n.toFixed(2)),
		...(framed ? { framed: framed.found } : {}),
		...(select ? { selected: uuids.length } : {}),
		...(preview ? { note: 'The person was looking through a camera; they are back in the editor view now (back returns them).' } : {})
	};
}

/** @param {string} uuid */
function nameOf(uuid) {
	/** @type {any} */
	const o = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid);
	return o?.name ? '"' + o.name + '"' : 'the object';
}

// ---------------------------------------------------------------- code

/** @param {any} args */
async function codeTarget(args) {
	if (args.node) {
		const { findNodeAnyGraph } = await import('../../stores/flowStore');
		const hit = /** @type {any} */ (findNodeAnyGraph((/** @type {any} */ n) => n.id === String(args.node)));
		if (!hit?.node) return { error: 'no flow node "' + String(args.node) + '"' };
		const type = hit.node.type;
		if (type !== 'script' && type !== 'behaviour') return { error: 'node "' + String(args.node) + '" is a ' + type + ' node: only Script and Behaviour nodes have code' };
		return { request: { source: type, ref: { nodeId: hit.node.id, graphId: hit.graphId } }, label: 'the ' + type + ' node' };
	}
	if (args.object) {
		const { flowGraphs } = await import('../../stores/flowStore');
		const g = /** @type {any} */ (get(flowGraphs))[String(args.object)];
		const node = (g?.nodes ?? []).find((/** @type {any} */ n) => n.type === 'behaviour' || n.type === 'script');
		if (!node) return { error: 'that object has no Script or Behaviour node (list_scene {flow: uuid} shows its graph)' };
		return { request: { source: node.type, ref: { nodeId: node.id, graphId: String(args.object) } }, label: 'the code on ' + nameOf(String(args.object)) };
	}
	const { explorerItems, explorerFolders, loadExplorer } = await import('../explorer');
	await loadExplorer();
	const r = resolveRef({ path: args.path, id: args.id }, /** @type {any[]} */ (get(explorerFolders)), /** @type {any[]} */ (get(explorerItems)));
	if (r.type !== 'file') return { error: 'code: path (an Explorer text file, "Scripts/door.js"), node (a Script / Behaviour node id) or object (its uuid)' };
	if (!isTextName(r.item.name)) return { error: '"' + r.item.name + '" is not a text file' };
	return { request: { source: extOf(r.item.name) === 'js' ? 'script' : 'text', ref: { itemId: r.item.id } }, label: '"' + r.item.name + '"' };
}

/** @param {any} args @param {string} by */
async function codeAction(args, by) {
	const target = await codeTarget(args);
	if ('error' in target) return fail(String(target.error));
	const ws = await import('../codeWorkspace');
	const { windowWhere, closeDockView } = await import('../dockMenu');
	const wasOpen = windowWhere('code') !== null;
	const prevTab = get(ws.activeCodeTab);
	const before = new Set(/** @type {any[]} */ (get(ws.codeTabs)).map((t) => t.id));
	const tabId = await ws.openCode(/** @type {any} */ (target.request));
	if (!tabId) return fail('that code could not be opened (it may be gone)');
	await waitFrames(3);
	const tab = /** @type {any} */ (ws.tabById(tabId));
	const text = String(tab?.code ?? tab?.saved ?? '');
	const total = text.split('\n').length;
	/** @type {{from: number[], to: number[]} | null} */
	let select = null;
	let at = Math.max(1, Math.floor(Number(args.line) || 0));
	if (typeof args.find === 'string' && args.find) {
		const hit = findRange(text, args.find, at || 1);
		if (!hit) return fail('"' + String(args.find).slice(0, 60) + '" is not in ' + target.label + ' (it is open now)', { opened: true, tabId });
		select = hit;
		at = hit.from[0];
	} else if (args.select && Array.isArray(args.select.from)) {
		select = { from: args.select.from, to: Array.isArray(args.select.to) ? args.select.to : args.select.from };
		at = Number(args.select.from[0]) || at || 1;
	} else if (at && Number(args.to) >= at) {
		const toLine = Math.min(total, Math.floor(Number(args.to)));
		select = { from: [at, 0], to: [toLine, (text.split('\n')[toLine - 1] ?? '').length] };
	}
	if (at || select) ws.revealInTab(tabId, at || 1, select ?? undefined);
	const fresh = !before.has(tabId);
	push('opened ' + target.label, () => {
		const t = /** @type {any} */ (ws.tabById(tabId));
		// a tab show opened goes again, unless the person typed in it since
		if (fresh && t && !isDirty(t)) ws.closeCodeTab(tabId, { keepOpen: wasOpen });
		else if (prevTab) ws.activeCodeTab.set(prevTab);
		if (!wasOpen) closeDockView('code');
		return 'closed ' + target.label;
	});
	line(by + ' opened ' + target.label + (at ? ' at line ' + at : ''));
	return {
		opened: target.label.replace(/"/g, ''),
		tabId,
		lines: total,
		...(at ? { line: at } : {}),
		...(select ? { selected: select } : {}),
		note: 'Only opened and selected: the person edits it, or change a file with files {action: "write"} (running code: edit_behaviour).'
	};
}

// ---------------------------------------------------------------- the tool

/**
 * @param {any} args @param {{by?: string}} [ctx]
 */
export async function showTool(args, ctx = {}) {
	const a = args && typeof args === 'object' ? args : {};
	const action = String(a.action ?? '');
	const by = String(ctx.by || 'The assistant');
	if (action === 'back') {
		if (!stack.length) return { back: false, note: 'nothing to put back: show has not changed anything yet (or it was all put back)' };
		const said = await back();
		return { back: true, did: said, left: stack.length };
	}
	if (!['panel', 'camera', 'code'].includes(action)) return fail('action: panel, camera, code or back');
	// rule 2 first: a denied or unknown panel is refused without asking and without spending the minute's calls
	if (action === 'panel') {
		const asked = String(a.name ?? a.panel ?? '');
		if (asked && deniedPanel(asked)) return panelAction(a, by);
		if (asked && !panelOf(asked)) return panelAction(a, by);
	}
	const busy = busyReason();
	if (busy) return fail(busy + ': show waits until they stop (try again in a moment)', { busy: true, retryAfter: 3 });
	// the camera's own pacing first (it is synchronous): the checks below await
	if (action === 'camera' && answers.get(answerKey(action, by)) !== 'no') {
		const gap = CAMERA_GAP_MS - (Date.now() - lastCameraAt);
		if (gap > 0 && lastCameraAt) return fail('one camera move at a time: wait ' + Math.ceil(gap / 1000) + ' s', { retryAfter: Math.ceil(gap / 1000) });
	}
	// 104-int: refused before the person is asked, so nobody says Always to a move that cannot happen now
	const filming = action === 'camera' ? await busyCamera() : '';
	if (filming) return fail(filming, { refused: true, busy: true });
	if (answers.get(answerKey(action, by)) === 'no') return fail('the person said no to letting you ' + KIND_WORDS[action] + ' in this session: describe where to look instead', { refused: true, denied: true });
	const wait = calls.check();
	if (wait) return fail('show is paced (6 a minute): wait ' + wait + ' s', { retryAfter: wait });
	const run = async () => {
		calls.note();
		debug.done++;
		debug.last = { action, at: Date.now() };
		if (action === 'panel') return panelAction(a, by);
		if (action === 'camera') return cameraAction(a, by);
		return codeAction(a, by);
	};
	if (allowed(action, by)) return run();
	// rule 3: the first time, the person says whether (Always / This time / No)
	return askPerson('show', a, {
		summary: KIND_WORDS[action],
		prompt: 'Let ' + by.replace(/^An /, 'an ') + ' ' + KIND_WORDS[action] + '?',
		choices: [
			...(trustedApp(by) ? [{ label: 'Always', value: 'always' }] : []),
			{ label: 'This time', value: 'session' },
			{ label: 'No', value: 'no', cancel: true }
		],
		apply: async (value) => {
			if (value === 'always') {
				try {
					safeStorage.setItem(allowKey(action), 'always');
				} catch {}
			} else answers.set(answerKey(action, by), 'session');
			return run();
		}
	}).then((r) => {
		if (r?.cancelled) answers.set(answerKey(action, by), 'no');
		return r;
	});
}

/** unit / e2e: forget this page's answers and pacing */
export function showToolResetForTest() {
	answers.clear();
	calls.reset();
	lastCameraAt = 0;
	stack = [];
}

/** the suites' view */
export function showToolDebug() {
	return { ...debug, stack: stack.map((s) => s.label), answers: Object.fromEntries(answers) };
}

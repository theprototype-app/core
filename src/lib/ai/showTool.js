// Roadmap 104 C2 — `show`: the assistant drives the person's OWN interface, in their own tab. A lazy
// chunk (personTools.js loads it on the first call). The rules are listed in showCore.js.
//
//   panel   {name, state: open | close | focus | toggle | move (to) | maximize | restore | collapse | expand (pane)}
//           107-panels: the registry in panelsCore.js (every real panel, the dock and the two sidebars as named
//           targets), through the app's own seams (panels.js), so a panel opens where the person keeps it. An
//           unknown name never substitutes: it errors with the valid names and the refused surfaces by reason.
//   panels  the whole registry with each panel's state (open / where / visible / front): reads, never asks
//   layout  {name, state: apply | save} the Windows ▸ Layouts named layouts
//   camera  {frame: [uuids]} | {position, target} | {through: cameraUuid}, select: true selects what was
//           framed. objectActions.flyTo (0.6 s, an instant cut under reduced motion) / startCameraPreview
//   code    {path | id | node | object, line, to, select: {from, to}, find}: codeWorkspace.openCode, then
//           the editor's reveal seam selects (CodeEditor `reveal.select`). Never edits text.
//   back    undo what the newest `show` changed (a stack of 10)
//   107 (showMore.js, lazy): reveal {path | id, state: 'open'} a file or folder in the Explorer · select {uuids,
//           mode} with no camera move · flow {object | node} the Flow editor on a flow / a node. All three ride the
//           PANEL kind's first-use answer (one question, not three more). code highlights without focus by default.
//
// Each kind asks the person once (Always / This time / No): Always is stored on this device
// (safeStorage `show:allow:<kind>`, the switches in Settings ▸ Privacy), This time and No last
// until the page reloads, per app. An app the Worker cannot name ("an AI app") is never offered Always
// and never uses a stored one (104-int: 89's app names x 104's show).

import { get } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { showToastById, specatorMode } from '../../stores/appStore';
import { globalCamera, orbitControls, globalRenderer, objectsGroup, TControls, isLocked, selectedObjects, marqueeRect, isVRMode } from '../../stores/sceneStore';
import { askPerson } from './personAsk.js';
import { SHOW_PANELS, SHOW_PER_MINUTE, CAMERA_GAP_MS, FLY_MS, KIND_WORDS, panelOf, deniedPanel, frameBox, isVec3, findRange, MORE_KIND } from './showCore.js';
import { targetOf } from './panelsCore.js';
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
// 107-panels: the registry (panelsCore.js) says WHICH panels exist and what each is called; panels.js says where
// each one is and works the app's own seams. This section is the show rules around them: an unknown name never
// substitutes, the answer reports visible + front truthfully, and every change has a Back.

/** the snapshot of what bringing something forward can change, so Back puts it back @returns {Promise<any>} */
async function chromeSnapshot() {
	const [b, sb, fm] = await Promise.all([import('../bottomDock'), import('../sidebars'), import('../focusMode')]);
	return { active: get(b.bottomDockActive), min: get(b.dockMinimized), vis: { ...get(sb.sidebarVisible) }, shown: { ...get(sb.sidebarShown) }, focus: get(fm.focusMode) };
}

/** @param {any} snap */
async function restoreChrome(snap) {
	const [b, sb, fm] = await Promise.all([import('../bottomDock'), import('../sidebars'), import('../focusMode')]);
	b.bottomDockActive.set(snap.active);
	b.dockMinimized.set(snap.min);
	for (const side of /** @type {const} */ (['left', 'right'])) {
		if (snap.shown[side] && get(sb.sidebarShown)[side] !== snap.shown[side]) sb.activateSidebarTab(snap.shown[side]);
		if (!snap.vis[side] && get(sb.sidebarVisible)[side]) sb.toggleSidebar(side, false);
	}
	if (snap.focus && !get(fm.focusMode)) fm.enterFocus(snap.focus);
}

/** the answer's state fields @param {string} id @returns {Promise<{where?: string | null, visible?: boolean, front?: boolean, panes?: any}>} */
async function panelState(id) {
	const P = await import('./panels.js');
	await P.waitFrames(2);
	const r = await P.readPanel(id);
	return r ? { where: r.where, visible: r.visible, front: r.front, ...(r.panes ? { panes: r.panes } : {}) } : {};
}

/** why a panel that is open is still not visible, for the note @param {any} st */
function hiddenWhy(st) {
	if (get(isLocked) === true) return 'The person is playing (Play mode hides the editor): it shows when they press Esc.';
	if (st.where && !st.visible) return 'It is open but not showing on this screen (a narrow screen or a phone can fold it away).';
	return '';
}

/** @param {string} id */
const readOnlyNote = (id) => (SHOW_PANELS[id]?.readOnly ? { readOnly: true, note: 'A read-only panel: it shows figures; it changes nothing in the scene.' } : {});

/** the dock / a sidebar as a target @param {'dock'|'left'|'right'} tid @param {string} state @param {string} by */
async function targetAction(tid, state, by) {
	const T = (await import('./panelsCore.js')).TARGETS[tid];
	const want = state === 'focus' ? 'open' : state;
	if (!['open', 'close', 'toggle'].includes(want)) return fail(T.title + ': state open, close or toggle');
	const P = await import('./panels.js');
	const r = await P.setTarget(tid, /** @type {any} */ (want));
	if ('error' in r) return fail(r.error);
	const all = await P.readPanels();
	const now = /** @type {any} */ (all)[tid];
	if (r.changed) {
		push((r.open ? 'opened ' : 'closed ') + T.title, () => {
			r.undo();
			return (r.open ? 'closed ' : 'reopened ') + T.title;
		});
		line(by + (r.open ? ' opened ' : ' closed ') + 'the ' + T.title.toLowerCase());
	}
	return { target: T.title, ...now, state: now.open ? 'open' : 'closed', changed: r.changed, ...(r.changed && !r.open ? { note: 'Hidden, not closed: every tab in it stays open.' } : {}) };
}

/**
 * 107-panels (ruling 2026-11-27): when no panel change can be true. Play mode hides the editor, so show never answers
 * success for a panel that is not there; an open dialog (Settings, Sessions, ...) puts the panels back as they were
 * when it closes, and watching someone else's view holds the same snapshot.
 * @returns {Promise<{error: string, extra: any} | null>}
 */
async function panelsNotNow() {
	if (get(isLocked) === true) return { error: 'the person is playing: panels belong to Edit, and Play hides them. Nothing was opened. Ask them to press Esc to go back to Edit, then call again', extra: { refused: true, playing: true } };
	const { anyModalOpen } = await import('../../stores/appStore');
	if (get(anyModalOpen)) return { error: 'a dialog is open on the person\'s screen (Settings, Sessions, Modules, ...): it puts the panels back as they were when it closes. Ask them to close it first', extra: { busy: true, retryAfter: 5 } };
	if (get(specatorMode)) return { error: 'the person is watching someone else\'s view: their panels come back when they press Exit', extra: { refused: true } };
	return null;
}

/** the person's Windows ▸ Lock layout: moves and layouts wait for them @returns {Promise<string>} */
async function layoutLockedWhy() {
	const { layoutLocked } = await import('../windowPrefs');
	return get(layoutLocked) ? 'the person locked the layout (Windows ▸ Lock layout): moving panels and applying a layout wait until they unlock it' : '';
}

/** @param {any} args @param {string} by */
async function panelAction(args, by) {
	const core = await import('./panelsCore.js');
	const asked = String(args.name ?? args.panel ?? '');
	if (!asked) return fail('name: the panel to show. ' + core.unknownPanelError('').error.replace(/^no panel "": nothing was opened\. /, ''), { valid: core.validNames(), blocked: core.blockedList() });
	const blocked = core.blockedError(asked);
	if (blocked) return fail(blocked.error, { refused: true, reason: blocked.reason, surface: blocked.surface, blocked: blocked.blocked });
	if (!core.panelOf(asked) && !core.targetOf(asked)) {
		const e = core.unknownPanelError(asked);
		return fail(e.error, { valid: e.valid, blocked: e.blocked });
	}
	const notNow = await panelsNotNow();
	if (notNow) return fail(notNow.error, notNow.extra);
	// a `to` without a state opens it (when closed) and puts it there: the open path below moves it too
	const state = String(args.state ?? 'open');
	const tid = core.targetOf(asked);
	if (tid) return targetAction(/** @type {any} */ (tid), state, by);
	const id = /** @type {string} */ (core.panelOf(asked));
	const p = core.PANEL_BY_ID[id];
	const label = p.title;
	const P = await import('./panels.js');
	const STATES = ['open', 'close', 'focus', 'toggle', 'move', 'maximize', 'restore', 'collapse', 'expand'];
	if (!STATES.includes(state)) return fail('state: ' + STATES.join(', '));
	const before = await P.readPanel(id);
	const was = !!before?.open;
	const sameAs = { id, ...(asked.trim().toLowerCase() !== label.toLowerCase() ? { asked } : {}) };

	if (state === 'toggle') return panelAction({ ...args, state: was && before?.front ? 'close' : 'open' }, by);

	if (state === 'close') {
		if (!was) return { panel: label, ...sameAs, state: 'closed', changed: false };
		const snap = await chromeSnapshot();
		await P.closePanel(p);
		push('closed ' + label, async () => {
			await P.openPanel(p);
			await restoreChrome(snap);
			return 'reopened ' + label;
		});
		line(by + ' closed ' + label);
		return { panel: label, ...sameAs, state: 'closed', changed: true };
	}

	if (state === 'collapse' || state === 'expand') {
		if (!args.pane) return fail('pane: which of ' + label + '\'s own sidebars — ' + (p.panes ? Object.keys(p.panes).join(', ') : 'it has none'));
		if (!was) return fail(label + ' is not open: open it first');
		const r = await P.setPane(p, String(args.pane), state === 'expand');
		if ('error' in r) return fail(r.error);
		const changed = r.was !== (state === 'expand');
		if (changed) {
			push((state === 'expand' ? 'opened ' : 'closed ') + label + '\'s ' + r.pane, async () => {
				await P.setPane(p, r.pane, r.was);
				return 'put ' + label + '\'s ' + r.pane + ' back';
			});
			line(by + (state === 'expand' ? ' opened ' : ' closed ') + label + '\'s ' + r.pane + ' sidebar');
		}
		return { panel: label, ...sameAs, pane: r.pane, paneState: state === 'expand' ? 'open' : 'closed', changed, ...(await panelState(id)) };
	}

	if (state === 'maximize' || state === 'restore') {
		const r = await P.maximizePanel(p, state === 'maximize');
		if ('error' in r) return fail(r.error);
		const fm = await import('../focusMode');
		const now = get(fm.focusMode);
		const changed = now !== r.was;
		if (changed) {
			push(state === 'maximize' ? 'maximized ' + label : 'restored the layout', async () => {
				if (r.was) fm.enterFocus(/** @type {any} */ (r.was));
				else fm.exitFocus();
				return state === 'maximize' ? 'restored the layout' : 'maximized it again';
			});
			line(by + (state === 'maximize' ? ' maximized ' + label + ' (Esc restores)' : ' restored your layout'));
		}
		return { panel: label, ...sameAs, maximized: now === 'dock', changed, ...(await panelState(id)) };
	}

	if (state === 'move' || (args.to && state === 'open')) {
		const locked = await layoutLockedWhy();
		if (locked) return fail(locked, { refused: true, locked: true });
	}
	if (state === 'move') {
		const to = String(args.to ?? '');
		if (!['dock', 'left', 'right', 'floating'].includes(to)) return fail('to: dock, left, right or floating');
		const r = await P.movePanel(p, /** @type {any} */ (to));
		if ('error' in r) return fail(r.error);
		const st = await panelState(id);
		const changed = r.from !== st.where;
		if (changed && r.from) {
			const from = r.from;
			push('moved ' + label, async () => {
				await P.movePanel(p, /** @type {any} */ (from));
				return 'moved ' + label + ' back';
			});
			line(by + ' moved ' + label + ' to the ' + (to === 'dock' ? 'dock' : to === 'floating' ? 'a floating window' : to + ' sidebar'));
		}
		return { panel: label, ...sameAs, state: 'open', changed, ...st };
	}

	// open / focus: open it where it lives, or bring it to the front where it is
	const snap = await chromeSnapshot();
	const { exitedFocus } = was ? await P.bringForward(p) : (await P.openPanel(p), { exitedFocus: null });
	let st = await panelState(id);
	// a move asked together with the open
	if (args.to && ['dock', 'left', 'right', 'floating'].includes(String(args.to)) && st.where !== args.to) {
		const r = await P.movePanel(p, /** @type {any} */ (String(args.to)));
		if ('error' in r) return fail(r.error, { opened: !was, panel: label });
		st = await panelState(id);
	}
	const changed = !was || !before?.front || before?.where !== st.where || !!exitedFocus;
	if (changed)
		push((was ? 'brought ' + label + ' forward' : 'opened ' + label), async () => {
			if (!was) await P.closePanel(p);
			await restoreChrome(snap);
			return was ? 'put the panels back as they were' : 'closed ' + label;
		});
	if (changed) line(by + (was ? ' brought ' + label + ' forward' : ' opened ' + label));
	const why = st.visible ? '' : hiddenWhy(st);
	const ro = readOnlyNote(id);
	const notes = [ro.note, why, exitedFocus ? 'Focus mode was hiding it: the person\'s layout is back (back re-enters focus mode).' : '', inVR() ? 'The person is in a headset: panels show when they take it off.' : ''].filter(Boolean);
	return {
		panel: label,
		...sameAs,
		state: 'open',
		changed,
		...st,
		...(ro.readOnly ? { readOnly: true } : {}),
		...(notes.length ? { note: notes.join(' ') } : {})
	};
}

// ---------------------------------------------------------------- layout (the Layouts menu's named layouts)

/** @param {any} args @param {string} by */
async function layoutAction(args, by) {
	const notNow = await panelsNotNow();
	if (notNow) return fail(notNow.error, notNow.extra);
	const L = await import('../uiLayouts');
	const list = /** @type {any[]} */ (get(L.uiLayouts));
	const state = String(args.state ?? 'apply');
	const name = String(args.name ?? '').trim();
	if (!name) return fail('name: the layout\'s name. Saved layouts: ' + (list.map((l) => l.name).join(', ') || 'none yet'), { layouts: list.map((l) => l.name) });
	const hit = list.find((l) => String(l.name).toLowerCase() === name.toLowerCase());
	if (state === 'save') {
		if (hit) return fail('a layout named "' + hit.name + '" exists: show never overwrites one (the person replaces it in Windows ▸ Layouts), pick a new name', { layouts: list.map((l) => l.name) });
		const r = L.saveLayout(name);
		if (!r.ok) return fail(r.reason);
		const id = r.layout.id;
		push('saved the layout "' + r.layout.name + '"', () => {
			L.deleteLayout(id);
			return 'removed the layout "' + r.layout.name + '"';
		});
		line(by + ' saved your layout as "' + r.layout.name + '"');
		return { layout: r.layout.name, saved: true, layouts: get(L.uiLayouts).map((/** @type {any} */ l) => l.name) };
	}
	if (state !== 'apply') return fail('layout state: apply (default) or save');
	const locked = await layoutLockedWhy();
	if (locked) return fail(locked, { refused: true, locked: true });
	if (!hit) return fail('no layout "' + name + '": nothing changed. Saved layouts: ' + (list.map((l) => l.name).join(', ') || 'none yet'), { layouts: list.map((l) => l.name) });
	const beforeRec = L.captureLayout('before');
	const beforeActive = get(L.activeLayoutId);
	const ok = await L.applyLayout(hit.id);
	if (!ok) return fail('the layout could not be applied right now (another one is applying): try again in a moment');
	push('applied the layout "' + hit.name + '"', async () => {
		await L.applyLayoutRecord(beforeRec);
		L.activeLayoutId.set(beforeActive);
		return 'put the layout from before back';
	});
	line(by + ' applied your layout "' + hit.name + '"');
	return { layout: hit.name, applied: true };
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
	// 107 (scout inv-B d): no line given = no line (it used to read as line 1, so a bare open moved the caret there)
	let at = Number(args.line) >= 1 ? Math.floor(Number(args.line)) : 0;
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
	// 107: by default the range is HIGHLIGHTED without focusing the editor (no caret, no on-screen keyboard on
	// a phone), and a bare line is highlighted whole; focus: true puts the caret there as before
	const focus = args.focus === true;
	if (!focus && at && !select && at <= total) select = { from: [at, 0], to: [at, (text.split('\n')[at - 1] ?? '').length] };
	if (at || select) ws.revealInTab(tabId, at || 1, select ?? undefined, { highlight: !focus });
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
		...(select ? { selected: select, ...(focus ? {} : { highlighted: true }) } : {}),
		focused: focus,
		note: (focus ? 'Opened with the caret there' : 'Highlighted, without focusing their editor (no caret, no keyboard)') + ': the person edits it, or change a file with files {action: "write"} (running code: edit_behaviour).'
	};
}

// ---------------------------------------------------------------- the tool

/**
 * @param {any} args @param {{by?: string}} [ctx]
 */
export async function showTool(args, ctx = {}) {
	const a = args && typeof args === 'object' ? args : {};
	const raw = String(a.action ?? '');
	const by = String(ctx.by || 'The assistant');
	if (raw === 'back') {
		if (!stack.length) return { back: false, note: 'nothing to put back: show has not changed anything yet (or it was all put back)' };
		const said = await back();
		return { back: true, did: said, left: stack.length };
	}
	// 107-panels: the panel list only reads — no question, no pacing
	if (raw === 'panels') {
		const { readPanels } = await import('./panels.js');
		return readPanels();
	}
	// 107-select-files: reveal (Explorer), select (no camera), flow (Flow editor) ride the panel kind's answer (MORE_KIND)
	if (!['panel', 'camera', 'code', 'layout', 'reveal', 'select', 'flow'].includes(raw)) return fail('action: panel, panels, layout, camera, code, reveal, select, flow or back');
	// rule 2 first: a denied or unknown panel is refused without asking and without spending the minute's calls
	if (raw === 'panel') {
		const asked = String(a.name ?? a.panel ?? '');
		if (!asked || deniedPanel(asked) || (!panelOf(asked) && !targetOf(asked))) return panelAction(a, by);
	}
	// 107-panels: nobody is asked about a panel change that cannot happen now (Play, a dialog, spectating)
	if (raw === 'panel' || raw === 'layout' || MORE_KIND[raw]) {
		const notNow = await panelsNotNow();
		if (notNow) return fail(notNow.error, notNow.extra);
	}
	// 107-panels: a layout asks as a panel change (the same first-use kind: "open and close your panels")
	const action = raw === 'layout' ? 'panel' : MORE_KIND[raw] ?? raw;
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
		debug.last = { action: raw, at: Date.now() };
		if (raw === 'layout') return layoutAction(a, by);
		if (raw === 'panel') return panelAction(a, by);
		if (raw === 'camera') return cameraAction(a, by);
		if (raw === 'code') return codeAction(a, by);
		// 107-select-files (lazy): the registry's own open / read (panels.js), by id
		const { PANEL_BY_ID } = await import('./panelsCore.js');
		const P = await import('./panels.js');
		const openPanelId = async (/** @type {string} */ id) => ((await P.readPanel(id))?.open ? P.bringForward(PANEL_BY_ID[id]) : P.openPanel(PANEL_BY_ID[id]));
		const isOpenId = async (/** @type {string} */ id) => !!(await P.readPanel(id))?.open;
		const more = await import('./showMore.js');
		return more.showMore(raw, a, { by, fail, line, push, openPanel: openPanelId, isOpen: isOpenId, inVR, nameOf });
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

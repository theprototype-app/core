// Roadmap 67 P1 — AGENT PANELS IN THE HEADSET (the "VR via panel provider" half of P1). DOM is
// invisible in VR, so the panel the desktop shows in a window is drawn onto a canvas-textured plane
// in front of the person (agentPanelVRDraw paints it), the tours/vrPanel shape one domain over: it
// follows the head LAZILY (vrGamePanel's followYaw; with reduced motion it jumps), it is an overlay
// panel (the laser ends on it), and a press is read on the TRIGGER EDGE in the frame hook while a
// trigger hook swallows that press so it never also selects what stands behind the board.
//
// A press does exactly what the window's control does — `changeControl` / `pressControl` /
// `closeAgentPanel` in agentPanels.js — so the headset and the desktop cannot disagree, and every
// effect is still the agent's own tool call. ONE board shows the focused panel; "Next" walks the
// rest. A text field / colour shows its value and is changed on the desktop.
//
// Lazy: AgentPanels.svelte imports this only while a headset session runs and a panel is up;
// everything registered is undone by the function `mountAgentPanelsVR` returns.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, globalRenderer, isVRMode } from '../stores/sceneStore';
import { agentPanels, focusedPanel, changeControl, pressControl, closeAgentPanel, canUse, panelByKey } from './agentPanels.js';
import { controlById } from './agentPanelCore.js';
import { drawAgentPanel, pressResult, hitAt, VR_PANEL_PX, VR_PANEL_M } from './agentPanelVRDraw.js';
import { registerVRFrameHook, registerVRTriggerHooks, registerOverlayPanel, controllerIndexFor, hapticPulse } from './vrControls';
import { followYaw } from './vrGamePanel';
import { actionPressed } from './vr/bindings.js';

const PANEL_DIST = 0.85;
const PANEL_DROP = 0.18;

/** @type {any} */ let mesh = null;
/** @type {HTMLCanvasElement | null} */ let canvas = null;
/** @type {any} */ let texture = null;
/** @type {import('./agentPanelVRDraw.js').VRHit[]} */ let hits = [];
/** per controller slot: the hit the laser is on @type {(string | null)[]} */
const hover = [null, null];
/** @type {Record<string, boolean>} */
const prevTrigger = { left: false, right: false };
let swallowSelect = false;
let drawnSig = '';
let yaw = NaN;
const follow = { following: false };
let lastT = 0;
/** per panel: the tab and page the board shows @type {Map<string, {tab: number, page: number}>} */
const view = new Map();
/** decoded images by panel key + control id @type {Map<string, {src: string, img: HTMLImageElement}>} */
const images = new Map();
/** suites (headless: no presenting camera) pin the head here @type {{position: any, quaternion: any} | null} */
let injectedHead = null;
const debug = { draws: 0, presses: 0, lastPress: /** @type {string | null} */ (null), shown: /** @type {string | null} */ (null) };

const reducedMotion = () => {
	try {
		return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
};

function ensureMesh() {
	if (mesh || typeof document === 'undefined') return mesh;
	canvas = document.createElement('canvas');
	canvas.width = VR_PANEL_PX.w;
	canvas.height = VR_PANEL_PX.h;
	texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(VR_PANEL_M.w, VR_PANEL_M.h),
		new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false })
	);
	mesh.name = 'vr-agent-panel';
	mesh.visible = false;
	return mesh;
}

/** the panel the board shows: the focused one, else the newest */
function shownPanel() {
	const list = get(agentPanels);
	const key = get(focusedPanel);
	return list.find((p) => p.key === key) ?? list.at(-1) ?? null;
}
/** @param {string} key */
const viewOf = (key) => {
	let v = view.get(key);
	if (!v) view.set(key, (v = { tab: 0, page: 0 }));
	return v;
};

/** the decoded images of a panel's image controls (each decodes once per src) @param {any} p */
function imagesOf(p) {
	/** @type {Record<string, HTMLImageElement | null>} */
	const out = {};
	for (const tab of p.spec?.tabs ?? [])
		for (const s of tab.sections)
			for (const c of s.controls) {
				if (c.type !== 'image' || !c.src) continue;
				const k = p.key + ':' + c.id;
				let rec = images.get(k);
				if (!rec || rec.src !== c.src) {
					const img = new Image();
					img.onload = () => (drawnSig = '');
					img.src = c.src;
					rec = { src: c.src, img };
					images.set(k, rec);
				}
				out[c.id] = rec.img.complete && rec.img.naturalWidth > 0 ? rec.img : null;
			}
	return out;
}

function liveHead() {
	const renderer = /** @type {any} */ (get(globalRenderer));
	if (!renderer?.xr?.isPresenting) return null;
	const cam = renderer.xr.getCamera();
	cam.updateMatrixWorld?.(true);
	return { position: cam.getWorldPosition(new THREE.Vector3()), quaternion: cam.getWorldQuaternion(new THREE.Quaternion()) };
}

const _e = new THREE.Euler();
/** @param {{position: any, quaternion: any}} head @param {number} dt */
function place(head, dt) {
	_e.setFromQuaternion(head.quaternion, 'YXZ');
	const headYaw = _e.y;
	if (reducedMotion()) {
		const d = Number.isFinite(yaw) ? Math.atan2(Math.sin(headYaw - yaw), Math.cos(headYaw - yaw)) : Infinity;
		if (Math.abs(d) > (35 * Math.PI) / 180) yaw = headYaw;
	} else yaw = followYaw(yaw, headYaw, dt, follow);
	// a little to the right of the gaze, so it does not sit on top of the tour / game board
	const side = 0.18;
	mesh.position.set(
		head.position.x - Math.sin(yaw) * PANEL_DIST + Math.cos(yaw) * side,
		head.position.y - PANEL_DROP,
		head.position.z - Math.cos(yaw) * PANEL_DIST - Math.sin(yaw) * side
	);
	mesh.rotation.set(0, yaw, 0);
	mesh.updateMatrixWorld(true);
}

/** @param {number} index */
function rayOf(index) {
	const renderer = /** @type {any} */ (get(globalRenderer));
	const controller = renderer?.xr?.getController(index);
	if (!controller) return null;
	const ray = new THREE.Raycaster();
	const m = new THREE.Matrix4().extractRotation(controller.matrixWorld);
	ray.ray.origin.setFromMatrixPosition(controller.matrixWorld);
	ray.ray.direction.set(0, 0, -1).applyMatrix4(m);
	return ray;
}
/** @param {number} index */
function pointAt(index) {
	if (!mesh?.visible || index < 0) return null;
	const hit = rayOf(index)?.intersectObject(mesh, false)[0];
	return hit ? { on: true, at: hit.uv ? hitAt(hits, hit.uv) : null } : null;
}

/**
 * Press a hit on the board (the laser's trigger edge, or a suite): the window's own actions.
 * @param {string} id a hit id (`c:<control>`, `c:<control>:<part>`, `tab:<n>`, `page:prev|next`, `next-panel`, `close`)
 * @param {number} [u] where along the hit (a slider's track)
 */
export function pressAgentPanelVR(id, u = 0.5) {
	const p = shownPanel();
	if (!p) return false;
	debug.presses++;
	debug.lastPress = id;
	drawnSig = '';
	const v = viewOf(p.key);
	if (id === 'close') return closeAgentPanel(p.key), true;
	if (id === 'next-panel') {
		const list = get(agentPanels);
		const i = list.findIndex((x) => x.key === p.key);
		focusedPanel.set(list[(i + 1) % list.length]?.key ?? null);
		return true;
	}
	if (id.startsWith('tab:')) return (v.tab = Number(id.slice(4)) || 0), (v.page = 0), true;
	if (id === 'page:prev') return (v.page = Math.max(0, v.page - 1)), true;
	if (id === 'page:next') return (v.page += 1), true;
	if (!id.startsWith('c:') || !canUse(p)) return false;
	const hit = hits.find((h) => h.id === id);
	const controlId = hit?.control ?? id.slice(2).split(':')[0];
	const c = controlById(p.spec, controlId);
	const r = pressResult(c, p.values?.[controlId] ?? c?.value, hit?.part ?? '', u);
	if (!r) return false;
	if (r.kind === 'press') return pressControl(p.key, controlId);
	return changeControl(p.key, controlId, r.value);
}

function redraw() {
	const p = shownPanel();
	if (!p || !canvas) return;
	const v = viewOf(p.key);
	const list = get(agentPanels);
	const imgs = imagesOf(p);
	const hovered = hover[0] ?? hover[1];
	const sig = [p.key, p.rev, p.live, p.waiting, JSON.stringify(p.values), v.tab, v.page, hovered, list.length, Object.values(imgs).filter(Boolean).length].join('|');
	if (sig === drawnSig) return;
	drawnSig = sig;
	const g = canvas.getContext('2d');
	if (!g) return;
	hits = drawAgentPanel(g, p, { tab: v.tab, page: v.page, hover: hovered, images: imgs, count: list.length, index: list.indexOf(p) });
	texture.needsUpdate = true;
	debug.draws++;
	debug.shown = p.key;
}

function frame() {
	if (!mesh) return;
	const renderer = /** @type {any} */ (get(globalRenderer));
	const session = renderer?.xr?.getSession?.();
	const p = shownPanel();
	const live = !!p && get(isVRMode) && (!!session || !!injectedHead);
	if (!live) {
		mesh.visible = false;
		yaw = NaN;
		return;
	}
	const scene = /** @type {any} */ (get(globalScene));
	if (scene && mesh.parent !== scene) scene.add(mesh);
	const now = performance.now();
	const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 72;
	lastT = now;
	const head = injectedHead ?? liveHead();
	if (head) place(head, dt);
	mesh.visible = !!head;
	redraw();
	for (const source of [...(session?.inputSources ?? [])]) {
		const hand = source?.handedness;
		if ((hand !== 'left' && hand !== 'right') || !source.gamepad) continue;
		const index = controllerIndexFor(hand);
		if (index < 0 || index > 1) continue;
		const at = pointAt(index);
		hover[index] = at?.at?.hit.id ?? null;
		const trigger = actionPressed('select', source);
		if (trigger && !prevTrigger[hand] && at?.at) {
			if (pressAgentPanelVR(at.at.hit.id, at.at.u)) hapticPulse(0.3, 30, hand, true);
		}
		prevTrigger[hand] = trigger;
	}
	redraw();
}

/** Mount the board and its hooks; returns the teardown. @returns {() => void} */
export function mountAgentPanelsVR() {
	const panel = ensureMesh();
	if (!panel) return () => {};
	const undo = [
		registerOverlayPanel(panel),
		registerVRFrameHook(frame),
		registerVRTriggerHooks({
			start: (/** @type {number} */ index) => {
				if (!pointAt(index)) return false;
				swallowSelect = true;
				return true;
			},
			swallow: () => {
				if (!swallowSelect) return false;
				swallowSelect = false;
				return true;
			}
		}),
		agentPanels.subscribe((list) => {
			drawnSig = '';
			for (const k of [...view.keys()]) if (!list.some((p) => p.key === k)) view.delete(k);
			for (const k of [...images.keys()]) if (!list.some((p) => k.startsWith(p.key + ':'))) images.delete(k);
		}),
		focusedPanel.subscribe(() => (drawnSig = ''))
	];
	return () => {
		for (const fn of undo) fn();
		panel.parent?.remove(panel);
		panel.visible = false;
		prevTrigger.left = prevTrigger.right = false;
	};
}

/** suites: pin the head pose (null = the live XR camera again) @param {{position: number[], yaw?: number} | null} pose */
export function setAgentPanelHead(pose) {
	injectedHead = pose
		? { position: new THREE.Vector3(...pose.position), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, pose.yaw ?? 0, 0, 'YXZ')) }
		: null;
	yaw = NaN;
}

/** suites: one frame without a headset session */
export const agentPanelVRFrame = () => frame();

/** the suites' view: what is shown, where, the hits and their world points */
export function agentPanelsVRDebug() {
	const point = (/** @type {string} */ id, u = 0.5) => {
		const r = hits.find((h) => h.id === id);
		if (!r || !mesh) return null;
		const x = (r.x + r.w * u) / VR_PANEL_PX.w;
		const y = (r.y + r.h / 2) / VR_PANEL_PX.h;
		return mesh.localToWorld(new THREE.Vector3((x - 0.5) * VR_PANEL_M.w, (0.5 - y) * VR_PANEL_M.h, 0)).toArray();
	};
	return {
		mounted: !!mesh?.parent,
		visible: !!mesh?.visible,
		position: mesh ? mesh.position.toArray() : null,
		hits: hits.map((h) => h.id),
		point,
		hover: hover.slice(),
		canvas,
		panel: panelByKey(debug.shown ?? '')?.key ?? null,
		...debug
	};
}

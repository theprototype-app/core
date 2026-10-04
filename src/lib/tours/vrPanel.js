// 36 U3b — THE VR WELCOME IN THE HEADSET: the tour engine's world-space surface, and the
// watcher that notices the user doing what a step asks.
//
// THE PANEL is a canvas-textured plane (vrPanelDraw paints it) held in front of the user at
// reading distance. It follows the head LAZILY (vrGamePanel's followYaw: a glance leaves it
// alone, a real turn brings it back in front) — with reduced motion on it jumps instead of
// gliding. It is an overlay panel (drawn over the scene, the laser ends on it). Its buttons
// press on the TRIGGER EDGE read in the frame hook — one path for a headset and for the suites'
// fake session — while a trigger hook swallows that press so it never also selects whatever
// stands behind the panel.
//
// THE WATCHER (same frame hook, only while a VR tour runs) turns raw input into the engine's
// signals: a thumbstick pushed past 0.6 → 'vr-move', a trigger pulled anywhere but on the
// panel → 'vr-trigger', a grip squeezed → 'vr-grip'. 'vr-menu', 'vr-interact' and 'vr-exit'
// come from stores (builtin.js). A step completed by doing it ticks the hand (haptics).
//
// Everything registered here is undone by the function `mountTourVRPanel` returns (the
// component's destroy), so a hot reload or an unmount leaves no hook behind.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, globalRenderer, isVRMode } from '../../stores/sceneStore';
import { activeTour, tours } from './index.js';
import { FAMILY_KEY, VR_TOUR } from './builtin.js';
import { controllerSvg, litFor, sessionFamily } from './controllerArt.js';
import { drawTourPanel, hitAtUv, PANEL_PX } from './vrPanelDraw.js';
import {
	registerVRFrameHook,
	registerVRTriggerHooks,
	registerOverlayPanel,
	controllerIndexFor,
	hapticPulse
} from '../vrControls';
import { followYaw } from '../vrGamePanel';
import { registerVRMenuEntry, unregisterVRMenuEntry } from '../vrRadialMenu';
import { safeStorage } from '../safeStorage';

/** the radial entry that replays the welcome: the System ring, before Exit VR (36-vr owns the
 * ring layout — if it moves settings into their own ring, this is the one line to change) */
export const RADIAL_ENTRY = { id: 'tour:vr', group: 'system', order: 6.5 };

/** panel size in metres, and where it sits relative to the head */
export const PANEL_M = { w: 0.6, h: 0.375 };
export const PANEL_DIST = 0.9;
export const PANEL_DROP = 0.12;
/** a thumbstick counts as pushed past this deflection */
export const STICK_PUSH = 0.6;

/** @type {any} */ let mesh = null;
/** @type {HTMLCanvasElement | null} */ let canvas = null;
/** @type {any} */ let texture = null;
/** @type {import('./vrPanelDraw.js').PanelHit[]} */ let hits = [];
/** per controller slot: the button the laser is on @type {(string | null)[]} */
const hover = [null, null];
/** per hand: last frame's buttons @type {Record<string, {trigger: boolean, grip: boolean, stick: boolean}>} */
const prev = {
	left: { trigger: false, grip: false, stick: false },
	right: { trigger: false, grip: false, stick: false }
};
/** a trigger press landed on the panel: swallow the scene's 'select' for it */
let swallowSelect = false;
let drawnSig = '';
let yaw = NaN;
const follow = { following: false };
let lastT = 0;
/** the suites' view */
const debug = { presses: 0, lastPress: /** @type {string | null} */ (null), draws: 0, signals: /** @type {string[]} */ ([]) };

/** rasterised diagrams by svg string (an <img> per distinct step drawing) @type {Map<string, HTMLImageElement>} */
const artCache = new Map();
/** @param {string} svg @returns {HTMLImageElement | null} the image once it has loaded */
function artImage(svg) {
	let img = artCache.get(svg);
	if (!img) {
		img = new Image();
		img.onload = () => {
			drawnSig = ''; // repaint with the diagram in
		};
		img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
		artCache.set(svg, img);
		if (artCache.size > 24) artCache.delete(/** @type {string} */ (artCache.keys().next().value));
	}
	return img.complete && img.naturalWidth > 0 ? img : null;
}

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
	canvas.width = PANEL_PX.w;
	canvas.height = PANEL_PX.h;
	texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(PANEL_M.w, PANEL_M.h),
		new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false })
	);
	mesh.name = 'vr-tour-panel';
	mesh.visible = false;
	return mesh;
}

/** the headset's pose, or null outside a real session @returns {{position: any, quaternion: any} | null} */
function liveHead() {
	const renderer = /** @type {any} */ (get(globalRenderer));
	if (!renderer?.xr?.isPresenting) return null;
	const cam = renderer.xr.getCamera();
	cam.updateMatrixWorld?.(true);
	return { position: cam.getWorldPosition(new THREE.Vector3()), quaternion: cam.getWorldQuaternion(new THREE.Quaternion()) };
}
/** suites (headless: no presenting camera) pin the head here @type {{position: any, quaternion: any} | null} */
let injectedHead = null;

const _e = new THREE.Euler();
/** place the panel in front of `head`, following its yaw lazily @param {{position: any, quaternion: any}} head @param {number} dt */
function place(head, dt) {
	_e.setFromQuaternion(head.quaternion, 'YXZ');
	const headYaw = _e.y;
	if (reducedMotion()) {
		// no glide: once the head has turned past the follow threshold the panel JUMPS back in front
		const d = Number.isFinite(yaw) ? Math.atan2(Math.sin(headYaw - yaw), Math.cos(headYaw - yaw)) : Infinity;
		if (Math.abs(d) > (35 * Math.PI) / 180) yaw = headYaw;
	} else yaw = followYaw(yaw, headYaw, dt, follow);
	mesh.position.set(
		head.position.x - Math.sin(yaw) * PANEL_DIST,
		head.position.y - PANEL_DROP,
		head.position.z - Math.cos(yaw) * PANEL_DIST
	);
	mesh.rotation.set(0, yaw, 0);
	mesh.updateMatrixWorld(true);
}

/** a ray from controller slot `index` @param {number} index */
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
/** the panel button controller slot `index` points at @param {number} index */
function buttonAt(index) {
	if (!mesh?.visible || index < 0) return null;
	const ray = rayOf(index);
	const hit = ray?.intersectObject(mesh, false)[0];
	return hit?.uv ? hitAtUv(hits, hit.uv) : null;
}
/** does controller slot `index` point at the panel at all? @param {number} index */
function onPanel(index) {
	if (!mesh?.visible || index < 0) return false;
	return !!rayOf(index)?.intersectObject(mesh, false).length;
}

/** @param {'skip' | 'never' | 'back' | 'next'} id */
export function pressTourButton(id) {
	debug.presses++;
	debug.lastPress = id;
	if (id === 'skip') tours.skip();
	else if (id === 'never') tours.dontShowAgain();
	else if (id === 'back') tours.back();
	else tours.next();
}

/** @param {string} name @param {'left' | 'right'} hand */
function act(name, hand) {
	debug.signals.push(name);
	if (tours.signal(name)) hapticPulse(0.4, 40, hand, true);
}

function redraw(/** @type {any} */ tour, /** @type {string} */ family) {
	const controls = tour.step.controls;
	const svg = controls ? controllerSvg({ family: /** @type {any} */ (family), lit: litFor(controls) }) : null;
	const art = svg ? artImage(svg) : null;
	const sig = [tour.id, tour.index, tour.total, tour.step.title, tour.step.body, family, hover[0], hover[1], !!art].join('|');
	if (sig === drawnSig) return;
	drawnSig = sig;
	const g = /** @type {CanvasRenderingContext2D} */ (canvas?.getContext('2d'));
	if (!g) return;
	const hovered = hover[0] ?? hover[1];
	hits = drawTourPanel(g, tour, { art, artW: 432, artH: 308, hover: hovered, family });
	texture.needsUpdate = true;
	debug.draws++;
}

/** One frame: show/hide, place, hover, presses, signals. */
function frame() {
	const tour = get(activeTour);
	const renderer = /** @type {any} */ (get(globalRenderer));
	const session = renderer?.xr?.getSession?.();
	const live = !!tour && tour.surface === 'vr' && !tour.preview && !!session && get(isVRMode);
	if (!mesh) return;
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

	const family = sessionFamily(session);
	if (family !== 'generic' && safeStorage.getItem(FAMILY_KEY) !== family) safeStorage.setItem(FAMILY_KEY, family);
	const drawFamily = family === 'generic' ? safeStorage.getItem(FAMILY_KEY) || 'quest3' : family;

	for (const source of [...(session.inputSources ?? [])]) {
		const hand = source?.handedness;
		if ((hand !== 'left' && hand !== 'right') || !source.gamepad) continue;
		const index = controllerIndexFor(hand);
		if (index < 0 || index > 1) continue;
		const button = buttonAt(index);
		hover[index] = button?.id ?? null;
		const pads = source.gamepad;
		const trigger = !!pads.buttons?.[0]?.pressed;
		const grip = !!pads.buttons?.[1]?.pressed;
		const stick = Math.hypot(pads.axes?.[2] ?? 0, pads.axes?.[3] ?? 0) > STICK_PUSH;
		const was = prev[hand];
		if (trigger && !was.trigger) {
			if (button) pressTourButton(button.id);
			else if (!onPanel(index)) act('vr-trigger', hand);
		}
		if (grip && !was.grip) act('vr-grip', hand);
		if (stick && !was.stick) act('vr-move', hand);
		was.trigger = trigger;
		was.grip = grip;
		was.stick = stick;
	}
	// the press above may have ended the tour
	const after = get(activeTour);
	if (after && after.surface === 'vr') redraw(after, drawFamily);
	else mesh.visible = false;
}

/**
 * Mount the panel and its hooks; returns the teardown. Called by TourVRPanel.svelte (Scene).
 * @returns {() => void}
 */
export function mountTourVRPanel() {
	const panel = ensureMesh();
	if (!panel) return () => {};
	const undo = [
		registerOverlayPanel(panel),
		registerVRFrameHook(frame),
		registerVRTriggerHooks({
			// a trigger that lands on the panel is the panel's: the scene must not select through it
			start: (/** @type {number} */ index) => {
				if (!onPanel(index)) return false;
				swallowSelect = true;
				return true;
			},
			swallow: () => {
				if (!swallowSelect) return false;
				swallowSelect = false;
				return true;
			}
		}),
		activeTour.subscribe(() => {
			drawnSig = '';
		})
	];
	registerVRMenuEntry({
		...RADIAL_ENTRY,
		label: 'Welcome tour',
		closes: true,
		action: () => tours.start(VR_TOUR, { from: 'start' })
	});
	undo.push(() => unregisterVRMenuEntry(RADIAL_ENTRY.id, RADIAL_ENTRY.group));
	return () => {
		for (const fn of undo) fn();
		panel.parent?.remove(panel);
		panel.visible = false;
		for (const hand of ['left', 'right']) prev[hand] = { trigger: false, grip: false, stick: false };
	};
}

/** suites: pin the head pose (null = the live XR camera again) @param {{position: number[], yaw?: number} | null} pose */
export function setTourHead(pose) {
	injectedHead = pose
		? {
				position: new THREE.Vector3(...pose.position),
				quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, pose.yaw ?? 0, 0, 'YXZ'))
			}
		: null;
	yaw = NaN;
}

/** the suites' view: what is shown, where, and the buttons' world points */
export function tourVRDebug() {
	const point = (/** @type {string} */ id) => {
		const r = hits.find((h) => h.id === id);
		if (!r || !mesh) return null;
		const u = (r.x + r.w / 2) / PANEL_PX.w;
		const v = (r.y + r.h / 2) / PANEL_PX.h;
		return mesh.localToWorld(new THREE.Vector3((u - 0.5) * PANEL_M.w, (0.5 - v) * PANEL_M.h, 0)).toArray();
	};
	return {
		visible: !!mesh?.visible,
		position: mesh ? mesh.position.toArray() : null,
		yaw,
		hover: hover.slice(),
		buttons: hits.map((h) => h.id),
		points: Object.fromEntries(['skip', 'never', 'back', 'next'].map((id) => [id, point(id)])),
		canvas,
		...debug,
		signals: debug.signals.slice()
	};
}

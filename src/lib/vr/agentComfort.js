// 85b S5 — AGENT EDITS, GENTLY, IN A HEADSET. Two local presentation rules for whoever is in VR (nothing is sent,
// saved or undone): an object an agent makes FADES IN instead of popping (`agentObjectArrived`, from the tools on
// a connector tab and from peerHandler for a create sent by an agent peer), and each agent line (the A8 log every
// peer already receives) shows as a small HEADSET TOAST under the view for a few seconds. The clear radius — the
// refusal half of S5 — is in ai/placement.js. While a fade runs, a park hook hands every serializer the real
// opacity, so a save mid-fade never keeps a half-transparent object.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalRenderer, globalScene, objectsGroup } from '../../stores/sceneStore.js';
import { agentLog } from '$lib/agentLog.js';
import { registerParkHook } from '$lib/parkHooks.js';
import { registerVRFrameHook } from './hooks.js';

export const FADE_MS = 450;
export const TOAST_MS = 3500;
/** an agent line older than this when it arrives is history (the handshake), not news */
const FRESH_MS = 10000;

const presenting = () => !!(/** @type {any} */ (get(globalRenderer))?.xr?.isPresenting);

/** @type {Map<any, {opacity: number, transparent: boolean, set: number}>} material → what it really is */
const fading = new Map();
/** @type {ReturnType<typeof setInterval> | 0} */
let fadeTimer = 0;

/** @param {any} object @returns {any[]} its own materials, once each */
function materialsOf(object) {
	const out = new Set();
	object.traverse((/** @type {any} */ o) => {
		if (!o.isMesh || !o.material) return;
		for (const m of Array.isArray(o.material) ? o.material : [o.material]) out.add(m);
	});
	return [...out];
}

/**
 * Fade one object in (VR only). Pure presentation: the material ends exactly as it was.
 * @param {any} object
 */
export function fadeIn(object) {
	const start = Date.now();
	const mats = materialsOf(object).filter((m) => !fading.has(m));
	if (!mats.length) return;
	for (const m of mats) {
		fading.set(m, { opacity: m.opacity, transparent: m.transparent, set: 0 });
		if (!m.transparent) m.needsUpdate = true;
		m.transparent = true;
		m.opacity = 0;
	}
	const ends = new Map(mats.map((m) => [m, start]));
	const step = () => {
		const now = Date.now();
		for (const [m, t0] of ends) {
			const real = fading.get(m);
			if (!real) {
				ends.delete(m);
				continue;
			}
			const k = Math.min(1, (now - t0) / FADE_MS);
			// somebody else changed the opacity meanwhile (an edit): theirs stands, the fade lets go
			if (real.set && Math.abs(m.opacity - real.set) > 1e-6) {
				fading.delete(m);
				ends.delete(m);
				continue;
			}
			if (k >= 1) {
				m.opacity = real.opacity;
				if (m.transparent !== real.transparent) m.needsUpdate = true;
				m.transparent = real.transparent;
				fading.delete(m);
				ends.delete(m);
			} else {
				m.opacity = real.opacity * k;
				real.set = m.opacity;
			}
		}
		if (!ends.size && !fading.size && fadeTimer) {
			clearInterval(fadeTimer);
			fadeTimer = 0;
		}
	};
	if (!fadeTimer) fadeTimer = setInterval(step, 30);
	else setTimeout(step, 30);
}

// a save, an autosave or a peer sync taken mid-fade sees the real material
registerParkHook(() => {
	if (!fading.size) return null;
	/** @type {[any, number, boolean][]} */
	const now = [];
	for (const [m, real] of fading) {
		now.push([m, m.opacity, m.transparent]);
		m.opacity = real.opacity;
		m.transparent = real.transparent;
	}
	return () => {
		for (const [m, o, t] of now) {
			m.opacity = o;
			m.transparent = t;
		}
	};
});

/**
 * An agent made this object (here, or a create from an agent peer): fade it in if we are in a headset.
 * @param {string} uuid
 */
export function agentObjectArrived(uuid) {
	if (!presenting()) return;
	const object = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid);
	if (object) fadeIn(object);
}

// ---------------------------------------------------------------- the headset toast

/** @type {{mesh: any, until: number} | null} */
let toast = null;

/** @param {string} text @returns {any} */
function toastMesh(text) {
	const canvas = document.createElement('canvas');
	canvas.width = 1024;
	canvas.height = 160;
	const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	g.fillStyle = 'rgba(20, 22, 28, 0.86)';
	g.beginPath();
	g.roundRect(4, 4, 1016, 152, 40);
	g.fill();
	g.fillStyle = '#f2f4f8';
	g.font = '500 44px system-ui, sans-serif';
	g.textBaseline = 'middle';
	const line = text.length > 60 ? text.slice(0, 59) + '…' : text;
	g.fillText(line, 48, 82, 928);
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.075), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
	mesh.renderOrder = 10000;
	mesh.name = 'agent-headset-toast';
	mesh.userData.helper = true;
	return mesh;
}

function dropToast() {
	if (!toast) return;
	toast.mesh.parent?.remove(toast.mesh);
	toast.mesh.geometry.dispose();
	toast.mesh.material.map?.dispose();
	toast.mesh.material.dispose();
	toast = null;
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
/** one frame: keep the toast under the view, gone when its time is up */
function placeToast() {
	if (!toast) return;
	if (Date.now() > toast.until || !presenting()) return dropToast();
	const cam = /** @type {any} */ (get(globalRenderer))?.xr?.getCamera?.();
	if (!cam) return;
	cam.updateMatrixWorld?.(true);
	cam.matrixWorld.decompose(_p, _q, new THREE.Vector3());
	toast.mesh.position.copy(_p).add(new THREE.Vector3(0, -0.22, -0.9).applyQuaternion(_q));
	toast.mesh.quaternion.copy(_q);
}

/** Show one line in the headset (replaces the one showing). @param {string} text */
export function showHeadsetToast(text) {
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene || !presenting() || typeof document === 'undefined') return;
	dropToast();
	toast = { mesh: toastMesh(text), until: Date.now() + TOAST_MS };
	scene.add(toast.mesh);
	placeToast();
}

/** @type {(() => void)[]} */
let stops = [];

/** Start for one XR session (Scene's sessionstart): agent lines become toasts. */
export function startAgentComfort() {
	stopAgentComfort();
	const seen = new Set((get(agentLog) ?? []).map((e) => e.id));
	stops.push(
		agentLog.subscribe((log) => {
			for (const e of log ?? []) {
				if (seen.has(e.id)) continue;
				seen.add(e.id);
				if (!e.text || e.undone || Date.now() - (e.at ?? 0) > FRESH_MS) continue;
				showHeadsetToast((e.name || 'Agent') + ': ' + e.text);
			}
		}),
		registerVRFrameHook(placeToast)
	);
}

/** Scene's sessionend */
export function stopAgentComfort() {
	for (const s of stops) s();
	stops = [];
	dropToast();
}

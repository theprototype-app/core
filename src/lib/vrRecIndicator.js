// 34 PF — THE RECORDING INDICATOR IN A HEADSET. A recording started from the VR menu (System ▸
// Profile ▸ Record) costs nothing visible, so without a mark the person in the headset forgets
// it is running — or never learns that a desktop peer is watching their frames live. A small
// head-locked pill, up and to the LEFT of the gaze line (the perf strip owns the middle):
//
//   ● REC 0:12            a light recording (red dot)
//   ● REC DETAILED 0:04   a detailed one (it costs frame time, so it says so)
//   ◉ LIVE 1              a desktop peer is watching the stream (perfLive.js), recording or not
//
// Shown ONLY while one of those is true, in every mode. It reads the recorder and the live
// source through the perfMarks LEAF (`recording`, `perfLive`), so the VR import family never
// imports the perf modules. Redrawn only when the text changes (once a second at most).
// Called once per XR frame from vrGameInput's frame hook; `hideVrRecIndicator` on session end.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, globalRenderer } from '../stores/sceneStore';
import { PANEL_ORDER } from './vrPanelOverlay';
import { perfContext } from './perf/perfMarks.js';

const PX_W = 384;
const PX_H = 64;
const WORLD_W = 0.2;
/** metres ahead of the eyes, up from the gaze line, and left of it */
const DIST = 1.2;
const UP = 0.5;
const LEFT = 0.3;

const RED = '#f87171';
const BLUE = '#60a5fa';

/** @type {{mesh: THREE.Mesh, g: CanvasRenderingContext2D, texture: THREE.CanvasTexture, sig: string} | null} */
let pill = null;
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _head = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
const debug = { draws: 0, segments: /** @type {{text: string, color: string}[]} */ ([]) };
const CHECK_MS = 250;
let lastCheck = -Infinity;
let lastHead = false;
/** @type {{text: string, color: string}[]} */
let shown = [];
let shownSig = '';

/** @param {number} ms */
function clock(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/**
 * What the pill says. Exported for the suite.
 * @param {{mode: string, startedAt: number} | null} rec the recorder's `recordingInfo()`
 * @param {{watchers: number} | null} live the live source's state
 * @param {number} [nowMs] epoch ms
 * @returns {{text: string, color: string}[]} empty = hide
 */
export function recSegments(rec, live, nowMs = Date.now()) {
	/** @type {{text: string, color: string}[]} */
	const out = [];
	if (rec) out.push({ text: '● REC ' + (rec.mode === 'detailed' ? 'DETAILED ' : '') + clock(nowMs - rec.startedAt), color: RED });
	if (live && live.watchers > 0) out.push({ text: '◉ LIVE ' + live.watchers, color: BLUE });
	return out;
}

function liveHead() {
	const renderer = /** @type {any} */ (get(globalRenderer));
	if (!renderer?.xr?.isPresenting) return null;
	const cam = renderer.xr.getCamera();
	cam.updateMatrixWorld?.(true);
	cam.getWorldPosition(_head.position);
	cam.getWorldQuaternion(_head.quaternion);
	return _head;
}

function ensure() {
	if (pill || typeof document === 'undefined') return pill;
	const canvas = document.createElement('canvas');
	canvas.width = PX_W;
	canvas.height = PX_H;
	const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(WORLD_W, (WORLD_W * PX_H) / PX_W),
		new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false })
	);
	mesh.name = 'vr-rec-indicator';
	mesh.renderOrder = PANEL_ORDER;
	mesh.frustumCulled = false;
	mesh.visible = false;
	mesh.userData.localOnly = true;
	pill = { mesh, g, texture, sig: '' };
	return pill;
}

/** @param {CanvasRenderingContext2D} g @param {{text: string, color: string}[]} segments */
function draw(g, segments) {
	const W = g.canvas.width;
	const H = g.canvas.height;
	g.clearRect(0, 0, W, H);
	g.beginPath();
	g.roundRect?.(0, 0, W, H, H / 2);
	g.fillStyle = 'rgba(0, 0, 0, 0.72)';
	g.fill();
	g.font = `700 ${Math.round(H * 0.42)}px ui-monospace, Menlo, monospace`;
	g.textBaseline = 'middle';
	g.textAlign = 'left';
	const gap = 18;
	const widths = segments.map((s) => g.measureText(s.text).width);
	const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, segments.length - 1);
	let x = Math.max(10, (W - total) / 2);
	segments.forEach((s, i) => {
		g.fillStyle = s.color;
		g.fillText(s.text, x, H / 2);
		x += widths[i] + gap;
	});
}

/**
 * One XR frame. `head` = the headset's world pose (default: the live XR camera; a suite passes
 * a synthetic one, null = not presenting).
 * @param {{position: THREE.Vector3, quaternion: THREE.Quaternion} | null} [head]
 * @param {number} [nowMs] perf clock (a suite passes its own to skip the throttle)
 */
export function vrRecIndicatorFrame(head = liveHead(), nowMs = performance.now()) {
	// the text changes once a second at most: read the leaf ~4x/s, not every frame (the Quest
	// budget's no-per-frame-allocation rule — recordingInfo() builds an object)
	if (nowMs - lastCheck >= CHECK_MS || !head !== !lastHead) {
		lastCheck = nowMs;
		lastHead = !!head;
		shown = head ? recSegments(perfContext('recording'), perfContext('perfLive')) : [];
		shownSig = shown.map((s) => s.text).join('|');
	}
	if (!shown.length || !head) {
		if (pill) pill.mesh.visible = false;
		return;
	}
	const p = ensure();
	if (!p) return;
	const scene = /** @type {any} */ (get(globalScene));
	if (scene && p.mesh.parent !== scene) scene.add(p.mesh);
	if (shownSig !== p.sig) {
		p.sig = shownSig;
		draw(p.g, shown);
		p.texture.needsUpdate = true;
		debug.draws++;
		debug.segments = shown;
	}
	_fwd.set(0, 0, -1).applyQuaternion(head.quaternion);
	_up.set(0, 1, 0).applyQuaternion(head.quaternion);
	_right.set(1, 0, 0).applyQuaternion(head.quaternion);
	p.mesh.position.copy(head.position).addScaledVector(_fwd, DIST).addScaledVector(_up, UP).addScaledVector(_right, -LEFT);
	p.mesh.quaternion.copy(head.quaternion);
	p.mesh.updateMatrixWorld(true);
	p.mesh.visible = true;
}

/** the session ended: take the pill down */
export function hideVrRecIndicator() {
	if (pill) pill.mesh.visible = false;
	lastCheck = -Infinity;
}

/** suites: what the pill shows right now */
export function vrRecIndicatorDebug() {
	return { visible: !!pill?.mesh.visible, parent: pill?.mesh.parent?.type ?? null, draws: debug.draws, segments: debug.segments };
}

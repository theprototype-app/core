// 33 Q1 — THE PERF STRIP IN A HEADSET. "Show amount of fps and draw calls within quest as an
// option in settings (150 is limit for quest)". The desktop half is FpsCounter.svelte; DOM is
// invisible in a headset, so this draws the SAME reading (fpsMeter's `fpsReading`) on a small
// head-locked canvas strip near the top of the view, in EVERY mode (Edit, Interact, Play) —
// a debugging lens, not a game feature, so it does not wait for a game to be running the way
// the game panel's own Show FPS line does.
//
// The draw calls are coloured against the Quest budget (fpsMeter's `callsTier`): amber past
// 120, red past 150. Redrawn only when the text changes (the reading republishes ~2x/s).
// Called once per XR frame from vrGameInput's frame hook; `hideVrPerfStrip` on session end.
// Scene-root, local, overlay order (vrPanelOverlay) so no wall can cover it.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, globalRenderer } from '../stores/sceneStore';
import { fpsReading, perfParts, perfStatsShown, TIER_COLORS } from './fpsMeter';
import { PANEL_ORDER } from './vrPanelOverlay';
import { perfContext } from './perf/perfMarks.js'; // 34 R1: the reporting dot (an import-free leaf)

const PX_W = 768;
const PX_H = 72;
const WORLD_W = 0.42;
/** metres ahead of the eyes, and up from the gaze line (above the game strip at 0.36/1.3) */
const DIST = 1.2;
const UP = 0.43;

/** @type {{mesh: THREE.Mesh, canvas: HTMLCanvasElement, g: CanvasRenderingContext2D, texture: THREE.CanvasTexture, sig: string} | null} */
let strip = null;
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _head = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

/** the headset's world pose, or null when nothing presents */
function liveHead() {
	const renderer = /** @type {any} */ (get(globalRenderer));
	if (!renderer?.xr?.isPresenting) return null;
	const cam = renderer.xr.getCamera();
	cam.updateMatrixWorld?.(true);
	cam.getWorldPosition(_head.position);
	cam.getWorldQuaternion(_head.quaternion);
	return _head;
}
/** the last text drawn, for the suites */
const debug = { draws: 0, segments: /** @type {{text: string, color: string}[]} */ ([]) };

function ensure() {
	if (strip || typeof document === 'undefined') return strip;
	const canvas = document.createElement('canvas');
	canvas.width = PX_W;
	canvas.height = PX_H;
	const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(WORLD_W, (WORLD_W * PX_H) / PX_W),
		new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false })
	);
	mesh.name = 'vr-perf-strip';
	mesh.renderOrder = PANEL_ORDER;
	mesh.frustumCulled = false;
	mesh.visible = false;
	mesh.userData.localOnly = true;
	strip = { mesh, canvas, g, texture, sig: '' };
	return strip;
}

/** The strip's segments for a reading: text + colour, in draw order. Exported for the suite.
 * @param {import('./fpsMeter').FpsReading} r */
export function perfSegments(r) {
	const p = perfParts(r);
	/** @type {{text: string, color: string}[]} */
	const out = [{ text: p.fps, color: '#a7f3d0' }];
	// 34 R1: performance reports are on — the same dot as the desktop counter (beacon.js
	// registers `reporting`: null when off, else 'idle' | 'sent' | 'failed')
	const reporting = perfContext('reporting');
	if (reporting) out.unshift({ text: '●', color: reporting === 'sent' ? '#34d399' : reporting === 'failed' ? '#fbbf24' : '#9ca3af' });
	if (p.ms) out.push({ text: p.ms, color: TIER_COLORS.ok });
	if (p.calls) out.push({ text: p.calls, color: TIER_COLORS[p.tier ?? 'ok'] });
	if (p.tris) out.push({ text: p.tris, color: TIER_COLORS.ok });
	return out;
}

/** @param {CanvasRenderingContext2D} g @param {{text: string, color: string}[]} segments */
function draw(g, segments) {
	const W = g.canvas.width;
	const H = g.canvas.height;
	g.clearRect(0, 0, W, H);
	g.beginPath();
	const r = H / 3;
	g.moveTo(r, 0);
	g.arcTo(W, 0, W, H, r);
	g.arcTo(W, H, 0, H, r);
	g.arcTo(0, H, 0, 0, r);
	g.arcTo(0, 0, W, 0, r);
	g.closePath();
	g.fillStyle = 'rgba(0, 0, 0, 0.72)';
	g.fill();
	g.font = `700 ${Math.round(H * 0.5)}px ui-monospace, Menlo, monospace`;
	g.textBaseline = 'middle';
	g.textAlign = 'left';
	const sep = '  ·  ';
	const widths = segments.map((s) => g.measureText(s.text).width);
	const sepW = g.measureText(sep).width;
	const total = widths.reduce((a, b) => a + b, 0) + sepW * Math.max(0, segments.length - 1);
	let x = Math.max(12, (W - total) / 2);
	segments.forEach((s, i) => {
		if (i) {
			g.fillStyle = '#6b7280';
			g.fillText(sep, x, H / 2);
			x += sepW;
		}
		g.fillStyle = s.color;
		g.fillText(s.text, x, H / 2);
		x += widths[i];
	});
}

/**
 * One XR frame. `head` = the headset's world pose (default: the live XR camera; a suite
 * passes a synthetic one, null = not presenting).
 * @param {{position: THREE.Vector3, quaternion: THREE.Quaternion} | null} [head]
 */
export function vrPerfStripFrame(head = liveHead()) {
	const on = !!head && get(perfStatsShown);
	if (!on) {
		if (strip) strip.mesh.visible = false;
		return;
	}
	const s = ensure();
	if (!s || !head) return;
	const scene = /** @type {any} */ (get(globalScene));
	if (scene && s.mesh.parent !== scene) scene.add(s.mesh);
	const segments = perfSegments(get(fpsReading));
	const sig = JSON.stringify(segments);
	if (sig !== s.sig) {
		s.sig = sig;
		draw(s.g, segments);
		s.texture.needsUpdate = true;
		debug.draws++;
		debug.segments = segments;
	}
	_fwd.set(0, 0, -1).applyQuaternion(head.quaternion);
	_up.set(0, 1, 0).applyQuaternion(head.quaternion);
	s.mesh.position.copy(head.position).addScaledVector(_fwd, DIST).addScaledVector(_up, UP);
	s.mesh.quaternion.copy(head.quaternion);
	s.mesh.updateMatrixWorld(true);
	s.mesh.visible = true;
}

/** the session ended: take the strip down */
export function hideVrPerfStrip() {
	if (strip) strip.mesh.visible = false;
}

/** suites: what the strip shows right now */
export function vrPerfStripDebug() {
	return { visible: !!strip?.mesh.visible, parent: strip?.mesh.parent?.type ?? null, draws: debug.draws, segments: debug.segments };
}

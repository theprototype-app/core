// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { clampNum, pressDepthAt, PRESS_AXES } from './tweenCore.js';
import { registerParkHook } from '../parkHooks.js';

// 85 I2 — the hover HIGHLIGHT and the PRESS BUTTON. The THREE half; a LEAF (three, the pure
// core, the import-free park registry).
//
// Highlight: the object's meshes glow a tint while `on` is true — wired, or (unwired) while this
// person points at it (hoverState: a VR laser or the play crosshair). LOCAL per peer and never
// sent: what you point at lights up for you. The authored emissive stays the authored emissive
// (the lightNodes rules: a record per material, an edit while driven is the new authored value,
// a serializer's park puts it back).
//
// Press Button: on each press (a replicated trigger stamp) the object goes in along an axis,
// holds and springs back — a pure function of the stamp and the shared clock (tweenCore), so
// every peer sees the same press.

/** @typedef {{color: number, intensity: number, written: number, writtenIntensity: number}} GlowRec */
/** material -> its authored emissive @type {WeakMap<any, GlowRec>} */
const recs = new WeakMap();
/** (node, object) -> {targets, level, t, seen} @type {Map<string, {targets: any[], level: number, t: number, seen: number}>} */
const live = new Map();
let frameNo = 0;
const tint = new THREE.Color();
const from = new THREE.Color();

/** the emissive materials of an object's meshes @param {any} object */
function glowTargets(object) {
	/** @type {any[]} */
	const out = [];
	object.traverse((/** @type {any} */ o) => {
		if (!o.isMesh || !o.material) return;
		for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m?.emissive && !out.includes(m)) out.push(m);
	});
	return out;
}

/** @param {any} m @returns {GlowRec} */
function recOf(m) {
	let r = recs.get(m);
	const hex = m.emissive.getHex();
	if (!r) {
		r = { color: hex, intensity: m.emissiveIntensity, written: hex, writtenIntensity: m.emissiveIntensity };
		recs.set(m, r);
		return r;
	}
	// an edit while driven (the Inspector, an undo) becomes the authored value
	if (hex !== r.written) r.color = hex;
	if (Math.abs(m.emissiveIntensity - r.writtenIntensity) > 1e-6) r.intensity = m.emissiveIntensity;
	return r;
}

/** @param {any} m */
function restore(m) {
	const r = recs.get(m);
	if (!r) return;
	m.emissive.setHex(r.color);
	m.emissiveIntensity = r.intensity;
	recs.delete(m);
}

/**
 * Highlight: glow `color` x `strength` while `on`, faded in / out over `fade` seconds (a per-peer
 * look; the level eases on this peer's clock).
 * @param {any} object @param {any} data @param {number} time @param {string} key @param {boolean} on
 * @returns {number} the level 0..1
 */
export function applyHighlight(object, data, time, key, on) {
	const targets = glowTargets(object);
	let s = live.get(key);
	if (!s) s = { targets, level: 0, t: time, seen: frameNo };
	for (const m of s.targets) if (!targets.includes(m)) restore(m);
	const fade = clampNum(data?.fade, 0.15, 0, 5);
	const dt = Math.max(0, Math.min(0.5, time - s.t));
	const want = on ? 1 : 0;
	const step = fade > 0 ? dt / fade : 1;
	s.level = want > s.level ? Math.min(want, s.level + step) : Math.max(want, s.level - step);
	s.t = time;
	s.seen = frameNo;
	s.targets = targets;
	live.set(key, s);
	tint.set(typeof data?.color === 'string' ? data.color : '#ffd54a');
	tint.multiplyScalar(clampNum(data?.strength, 0.6, 0, 5));
	for (const m of targets) {
		const r = recOf(m);
		if (s.level <= 0) {
			m.emissive.setHex(r.color);
			m.emissiveIntensity = r.intensity;
		} else {
			// from the authored glow (colour x intensity) to the tint, carried at intensity 1
			from.setHex(r.color).multiplyScalar(r.intensity);
			m.emissive.lerpColors(from, tint, s.level);
			m.emissiveIntensity = 1;
		}
		r.written = m.emissive.getHex();
		r.writtenIntensity = m.emissiveIntensity;
	}
	return s.level;
}

/** call once per tick with the (node, object) keys still driven @param {Set<string>} liveKeys */
export function prunePressNodes(liveKeys) {
	frameNo++;
	for (const [key, s] of live) {
		if (liveKeys.has(key)) continue;
		for (const m of s.targets) if (![...live].some(([k, o]) => k !== key && liveKeys.has(k) && o.targets.includes(m))) restore(m);
		live.delete(key);
	}
}

export function resetPressNodes() {
	for (const s of live.values()) for (const m of s.targets) restore(m);
	live.clear();
}

/** debug: the live highlights and their levels */
export function pressNodesDebug() {
	return Object.fromEntries([...live].map(([k, s]) => [k, { level: s.level, materials: s.targets.length }]));
}

const axisV = new THREE.Vector3();

/**
 * Press Button: offset the object along its own `axis` by depth x the press curve.
 * @param {any} object @param {any} data @param {number} time @param {number | null} stamp the press's trigger stamp
 * @returns {number} how far in (the curve, 0..1)
 */
export function applyPress(object, data, time, stamp) {
	const f = stamp === null || stamp === undefined ? 0 : pressDepthAt(time - stamp, data);
	if (f === 0) return 0;
	const a = PRESS_AXES[data?.axis] ?? PRESS_AXES['-y'];
	const depth = clampNum(data?.depth, 0.04, 0, 5);
	// the axis is the object's own (a button on a tilted panel goes in along the panel's normal)
	axisV.set(a[0], a[1], a[2]).applyQuaternion(object.quaternion).multiplyScalar(depth * f);
	object.position.add(axisV);
	return f;
}

// a serializer's park: the authored emissive in for the save, the glow back after
registerParkHook(() => {
	/** @type {[any, number, number][]} */
	const lifted = [];
	for (const s of live.values())
		for (const m of s.targets) {
			const r = recs.get(m);
			if (!r) continue;
			lifted.push([m, m.emissive.getHex(), m.emissiveIntensity]);
			m.emissive.setHex(r.color);
			m.emissiveIntensity = r.intensity;
		}
	if (!lifted.length) return null;
	return () => {
		for (const [m, c, i] of lifted) {
			m.emissive.setHex(c);
			m.emissiveIntensity = i;
		}
	};
});

// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { lightLevel, cycleColour, clampNum, tweenEvents } from './tweenCore.js';
import { registerParkHook } from '../parkHooks.js';

// 85 N4 — the light nodes: Light Switch (on / off with a fade), Light Intensity (fade to a
// level) and Light Colour Cycle. The THREE half; a LEAF (three, the pure core, the import-free
// park registry).
//
// A node drives every light in its object's subtree (a Point light object, or a lamp model with
// a light inside) and, with `glow` on, the EMISSIVE of its meshes too — a bulb that goes dark with
// its light. Values are LOCAL per peer and never sent: the switch events are replicated stamps,
// the cycle is the shared clock (the Set Color rule).
//
// THE AUTHORED VALUE STAYS THE AUTHORED VALUE:
//  - every light keeps a record of its authored intensity / colour; the node writes
//    authored x level, never compounds on what it wrote last frame;
//  - an Inspector edit while a node drives the light (the value is no longer what we wrote)
//    becomes the new authored value;
//  - a serializer's park (parkHooks) puts the authored values back for the save and re-applies
//    after, so a scene saved with the lamp switched off still has a lamp;
//  - a node that goes away (deleted, unwired) hands the authored values back.

/** @typedef {{intensity: number, color: number, written: number, writtenColor: number, emissive: boolean}} LightRec */
/** @type {WeakMap<any, LightRec>} light or emissive material -> its authored values */
const recs = new WeakMap();
/** every target touched, keyed by (node, object) @type {Map<string, {targets: any[], seen: number}>} */
const live = new Map();
/** per (node, object) Light Intensity fades: {from, to, t} @type {Map<string, {from: number, to: number, t: number}>} */
const fades = new Map();
/** debug reads @type {Map<string, any>} */
const reads = new Map();
let frameNo = 0;
const col = new THREE.Color();

/** the lights (and, with glow, the emissive materials) a node drives @param {any} object @param {boolean} glow */
export function lightTargets(object, glow) {
	/** @type {any[]} */
	const out = [];
	object.traverse((/** @type {any} */ o) => {
		if (o.isLight) out.push(o);
		else if (glow && o.isMesh && o.material && !Array.isArray(o.material) && o.material.emissive && (o.material.emissive.r || o.material.emissive.g || o.material.emissive.b))
			out.push(o.material);
	});
	return out;
}

/** @param {any} t a light or an emissive material @returns {LightRec} */
function recOf(t) {
	let r = recs.get(t);
	const isLight = !!t.isLight;
	const now = isLight ? t.intensity : t.emissiveIntensity;
	const nowColor = (isLight ? t.color : t.emissive).getHex();
	if (!r) {
		r = { intensity: now, color: nowColor, written: now, writtenColor: nowColor, emissive: !isLight };
		recs.set(t, r);
		return r;
	}
	// an edit made while we drive it (the Inspector, an undo) is the new authored value
	if (Math.abs(now - r.written) > 1e-6) r.intensity = now;
	if (nowColor !== r.writtenColor) r.color = nowColor;
	return r;
}

/** @param {any} t @param {number} intensity */
function writeIntensity(t, intensity) {
	const r = recOf(t);
	const v = r.intensity * intensity;
	if (t.isLight) t.intensity = v;
	else t.emissiveIntensity = v;
	r.written = t.isLight ? t.intensity : t.emissiveIntensity;
}

/** @param {any} t @param {[number, number, number]} rgb */
function writeColour(t, rgb) {
	const r = recOf(t);
	const c = t.isLight ? t.color : t.emissive;
	// the core's colours are sRGB (hex, hsl): say so, or three reads them as linear and they wash out
	c.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
	r.writtenColor = c.getHex();
}

/** @param {any} t */
function restore(t) {
	const r = recs.get(t);
	if (!r) return;
	if (t.isLight) {
		t.intensity = r.intensity;
		t.color.setHex(r.color);
	} else {
		t.emissiveIntensity = r.intensity;
		t.emissive.setHex(r.color);
	}
	recs.delete(t);
}

/** @param {string} key @param {any[]} targets */
function mark(key, targets) {
	const held = live.get(key);
	if (held) for (const t of held.targets) if (!targets.includes(t)) restore(t);
	live.set(key, { targets, seen: frameNo });
}

/**
 * Light Switch: the level from the switch's events (trigger = on, back = off, toggle, or an `on`
 * boolean), faded over `fade` seconds.
 * @param {any} object @param {any} data @param {number} time @param {string} key
 * @param {{trigger: number | null, back: number | null, toggle: number | null, toggleCount: number, open: any[], onWired: boolean}} s
 */
export function applyLightSwitch(object, data, time, key, s) {
	const targets = lightTargets(object, data?.glow !== false);
	mark(key, targets);
	const events = tweenEvents({ trigger: s.trigger, back: s.back, toggle: s.toggle, toggleCount: s.toggleCount, open: s.open });
	// the `on` checkbox is the state before any switch event; a WIRED `on` carries its own
	// events (open), first sight included
	const initial = s.onWired ? false : data?.on !== false;
	const level = lightLevel(events, time, clampNum(data?.fade, 0.3, 0, 30), initial);
	for (const t of targets) writeIntensity(t, level);
	reads.set(key, { level, seen: frameNo });
	return level;
}

/**
 * Light Intensity: fade to a level (x the authored intensity) over `fade` seconds whenever the
 * level changes. The change moment is the one THIS peer saw (a wired value is the replicated
 * graph's, so peers differ only by their latency mid-fade).
 * @param {any} object @param {any} data @param {number} time @param {string} key
 */
export function applyLightIntensity(object, data, time, key) {
	const targets = lightTargets(object, data?.glow !== false);
	mark(key, targets);
	const want = clampNum(data?.level, 1, 0, 100);
	const fade = clampNum(data?.fade, 0.5, 0, 30);
	let f = fades.get(key);
	if (!f) f = { from: want, to: want, t: time };
	else if (f.to !== want) {
		const u = fade > 0 ? Math.min(1, (time - f.t) / fade) : 1;
		f = { from: f.from + (f.to - f.from) * u, to: want, t: time };
	}
	fades.set(key, f);
	const u = fade > 0 ? Math.max(0, Math.min(1, (time - f.t) / fade)) : 1;
	const level = f.from + (f.to - f.from) * (u * u * (3 - 2 * u));
	for (const t of targets) writeIntensity(t, level);
	reads.set(key, { level, seen: frameNo });
	return level;
}

/**
 * Light Colour Cycle: the light's colour walks the hue wheel or a list of colours, from the
 * shared clock (every peer the same colour).
 * @param {any} object @param {any} data @param {number} time @param {string} key
 */
export function applyLightCycle(object, data, time, key) {
	const targets = lightTargets(object, data?.glow !== false);
	mark(key, targets);
	const rgb = cycleColour(data, time);
	for (const t of targets) writeColour(t, rgb);
	col.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
	reads.set(key, { color: '#' + col.getHexString(), seen: frameNo });
	return rgb;
}

/** call once per runtime tick with the (node, object) keys still driven: the rest hand back @param {Set<string>} liveKeys */
export function pruneLightNodes(liveKeys) {
	frameNo++;
	for (const [key, held] of live) {
		if (liveKeys.has(key)) continue;
		// a target another live key still drives is not restored
		for (const t of held.targets) if (![...live].some(([k, h]) => k !== key && liveKeys.has(k) && h.targets.includes(t))) restore(t);
		live.delete(key);
		fades.delete(key);
		reads.delete(key);
	}
}

/** put every authored value back (a scene clear) */
export function resetLightNodes() {
	for (const held of live.values()) for (const t of held.targets) restore(t);
	live.clear();
	fades.clear();
	reads.clear();
}

/** debug: what the light nodes hold */
export function lightNodesDebug() {
	return { live: live.size, reads: Object.fromEntries([...reads].map(([k, r]) => [k, { level: r.level, color: r.color }])) };
}

// a serializer's park: authored values in for the save, the driven ones back after
registerParkHook(() => {
	/** @type {[any, number, number][]} */
	const lifted = [];
	for (const held of live.values())
		for (const t of held.targets) {
			const r = recs.get(t);
			if (!r) continue;
			const isLight = !!t.isLight;
			lifted.push([t, isLight ? t.intensity : t.emissiveIntensity, (isLight ? t.color : t.emissive).getHex()]);
			if (isLight) {
				t.intensity = r.intensity;
				t.color.setHex(r.color);
			} else {
				t.emissiveIntensity = r.intensity;
				t.emissive.setHex(r.color);
			}
		}
	if (!lifted.length) return null;
	return () => {
		for (const [t, v, c] of lifted) {
			if (t.isLight) {
				t.intensity = v;
				t.color.setHex(c);
			} else {
				t.emissiveIntensity = v;
				t.emissive.setHex(c);
			}
		}
	};
});

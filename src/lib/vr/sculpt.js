// VR controls — TERRAIN SCULPT IN THE HEADSET (37 R9). The desktop brush (terrainSculpt.js: raise / lower / smooth /
// flatten over the meshgeo channel, one snapshot + one undo entry per stroke, selection = lock) driven by the
// controllers instead of the mouse:
//   - the POINTER hand aims: its ray puts the brush ring on the terrain; the trigger held = a stroke
//   - the pointer hand's STICK sizes the brush: left/right = size, up/down = strength (a little tick at every
//     half metre / tenth); that hand's move/turn/teleport stand down while you sculpt, the other stick still
//     moves you (hooks.registerStickOwner)
//   - a label on the pointer hand says the tool and both numbers
//   - the radial opens on the Sculpt ring while a session is up: Raise · Lower · Smooth · Flatten · Done
//     (Back reaches the usual menu); Add ▸ Terrain starts one on the new terrain, Selected ▸ Sculpt terrain on
//     an existing one
// The tool and the two numbers are the desktop toolbar's own stores, so a desktop peer-of-yourself and the
// headset agree. Edit only: switching to Interact or leaving the session ends the session.
//
// 52 (V3) — THE PAINT AND SCATTER BRUSHES ON THE CONTROLLER. The same session grows the desktop toolbar's two
// other brushes (47 T1/T2 + 51): Paint lays one of the terrain's FOUR layers, Scatter paints instances of a
// source and its 51 edit tools (Erase · Rotate · Scale · Relax) work on what is there. The Sculpt ring's
// Paint ▸ and Scatter ▸ are the WHEELS: Paint ▸ = the four layers, Scatter ▸ = the tools + Source ▸ (the
// sources this terrain already scatters, the one in use, then the primitives). Trigger strokes, the stick
// sizes (x) and sets the strength (y — the DENSITY while scatter-painting, the toolbar's own row), the ring
// on the surface follows the pointer, and a stroke starts with a tick in the hand. Everything goes through
// terrainSculpt's beginStroke/strokeMove/endStroke, so a stroke is the desktop's: one commit, one undo
// entry. It works in a miniature (52 V5): the hit is taken into the terrain's own frame and the ring is
// drawn at the terrain's world scale. With hand tracking the brushes ask for a controller (52 rules: precise
// tools are controller tools).
//
// Rides the K1 hook registries (trigger / frame / stick owner), registered on first use (the splineEdit pattern).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, editorMode, vrMenuHand, vrMenuOpen } from '../../stores/sceneStore';
import {
	sculptObject,
	sculptOp,
	sculptMode,
	sculptRadius,
	sculptStrength,
	enterSculpt,
	exitSculpt,
	beginStroke,
	strokeMove,
	endStroke,
	showCursorAt,
	hideCursor
} from '../terrainSculpt';
import { renderer } from './core.js';
import { hapticPulse } from './haptics.js';
import { controllerIndexFor, axesForSlot } from './input.js';
import { controllerRay } from './pointer.js';
import { vrHovered } from './panels.js';
import { registerVRFrameHook, registerVRTriggerHooks, registerStickOwner } from './hooks.js';
import { controllerRequired } from './handInput.js';
import { vrSculptActive } from './worldStores.js';
import { paintLayer, scatterSource, scatterDensity, scatterErase, scatterBlockNow } from '../terrainPaint';
import { scatterTool, setScatterTool } from '../scatterEdit';
import { sourceChoices, resolveSourceChoice, sourceLabel, packChoiceList } from '../scatterSources';
import { sourceKey, sourceOf } from '../terrainScatterCore';

export const SCULPT_OPS = /** @type {const} */ (['raise', 'lower', 'smooth', 'flatten']);
export const RADIUS_MIN = 0.25;
export const RADIUS_MAX = 20;
export const STRENGTH_MIN = 0.05;
export const STRENGTH_MAX = 1;
/** 52 (V3): the brushes beside the four sculpt ops (paint = terrain only, scatter = any sculpted host) */
export const BRUSH_OPS = /** @type {const} */ (['paint', 'scatter']);
/** 52 (V3): the scatter tools a controller drives (the toolbar's Select is a screen marquee — not in VR) */
export const SCATTER_TOOLS = /** @type {const} */ (['paint', 'erase', 'rotate', 'scale', 'relax']);
/** 52 (V3): the scatter density range (the toolbar's own slider) */
export const DENSITY_MIN = 0.05;
export const DENSITY_MAX = 2;
/** 52 (V3): at most this many sources on the Source ▸ wheel */
export const SOURCE_SLOTS = 7;
const DEAD = 0.25;

let hooked = false;
/** @type {{index: number, last: number} | null} the trigger stroke in flight */
let stroke = null;
let lastFrame = 0;
let swallowAt = 0;
/** the suites' view */
const stats = { strokes: 0, moves: 0, ticks: 0, strokeTicks: 0, handRefusals: 0 };

/** the pointer hand (the one that does not hold the menu) */
function pointerHand() {
	return get(vrMenuHand) === 'right' ? 'left' : 'right';
}
function pointerIndex() {
	return controllerIndexFor(pointerHand());
}
/** the sculpted object @returns {any} */
function target() {
	const uuid = get(sculptObject);
	return uuid ? get(objectsGroup)?.getObjectByProperty('uuid', uuid) : null;
}

function ensureHooks() {
	if (hooked) return;
	hooked = true;
	registerStickOwner(() => (get(vrSculptActive) && !get(vrMenuOpen) ? pointerHand() : null));
	registerVRTriggerHooks({
		start: (/** @type {number} */ i) => sculptTriggerStart(i),
		end: (/** @type {number} */ i) => sculptTriggerEnd(i),
		swallow: () => {
			const pending = swallowAt && Date.now() - swallowAt < 5000;
			swallowAt = 0;
			return !!pending;
		}
	});
	registerVRFrameHook(() => tickVRSculpt());
}

/** Start sculpting `uuid` in the headset (Add ▸ Terrain, Selected ▸ Sculpt terrain). @param {string} uuid */
export function startVRSculpt(uuid) {
	if (!uuid) return false;
	ensureHooks();
	if (get(sculptObject) !== uuid) {
		if (get(sculptObject)) exitSculpt();
		if (!enterSculpt(uuid)) return false;
	}
	vrSculptActive.set(true);
	vrMenuOpen.set(false);
	lastFrame = performance.now();
	return true;
}

/** Done: commit a stroke in flight and leave sculpt mode */
export function stopVRSculpt() {
	if (stroke) sculptTriggerEnd(stroke.index);
	stroke = null;
	if (get(sculptObject)) exitSculpt();
	vrSculptActive.set(false);
	hideLabel();
}

/** a sculpt-ring sector: pick the brush @param {string} op */
export function setVRSculptOp(op) {
	if (/** @type {readonly string[]} */ (SCULPT_OPS).includes(op)) sculptOp.set(/** @type {any} */ (op));
	// 52 (V3): Paint needs a splat map (a terrain); Scatter paints on any sculpted host (51-surface)
	else if (op === 'paint' && onTerrain()) sculptOp.set('paint');
	else if (op === 'scatter') sculptOp.set('scatter');
}

/** 52 (V3): is the session on a terrain (the paint layers and the edit tools need one)? */
export function onTerrain() {
	return get(sculptMode) === 'terrain';
}

/** 52 (V3): the Paint ▸ wheel — pick a layer (0..3) and arm Paint @param {number} i */
export function setVRPaintLayer(i) {
	if (!onTerrain() || !(i >= 0 && i <= 3)) return;
	paintLayer.set(i);
	sculptOp.set('paint');
}

/** 52 (V3): the tool in force while scatter is armed — the toolbar's reading (the 47 erase flag reads Erase) */
export function vrScatterTool() {
	if (!onTerrain()) return get(scatterErase) ? 'erase' : 'paint';
	return get(scatterErase) && get(scatterTool) === 'paint' ? 'erase' : get(scatterTool);
}

/** 52 (V3): the Scatter ▸ wheel — arm a tool (the toolbar's pickTool; a mesh host keeps Paint + Erase) @param {string} t */
export function setVRScatterTool(t) {
	if (!(/** @type {readonly string[]} */ (SCATTER_TOOLS).includes(t))) return;
	if (!onTerrain() && t !== 'paint' && t !== 'erase') return;
	sculptOp.set('scatter');
	if (!onTerrain()) {
		scatterErase.set(t === 'erase');
		setScatterTool('paint');
		return;
	}
	scatterErase.set(false);
	setScatterTool(/** @type {any} */ (t));
}

/** @type {{at: number, slots: {value: string, label: string, source?: any}[]}} */
let slotCache = { at: 0, slots: [] };
/**
 * 52 (V3): the Source ▸ wheel's choices: the source in use, the ones this host already scatters, then the
 * primitives — the toolbar's catalog (scatterSources.sourceChoices), at most SOURCE_SLOTS. Cached for a
 * second (the radial reads it once per sector).
 * @returns {{value: string, label: string, source?: any}[]}
 */
export function vrSourceSlots() {
	const now = performance.now();
	if (now - slotCache.at < 1000) return slotCache.slots;
	const current = get(scatterSource);
	const uuid = get(sculptObject);
	/** @type {any[]} */
	const inUse = [];
	try {
		for (const set of (uuid ? scatterBlockNow(uuid)?.sets : null) ?? []) for (const src of set?.sources ?? (set?.source ? [set.source] : [])) inUse.push(src?.source ?? src);
	} catch {}
	/** @type {{value: string, label: string, source?: any}[]} */
	const slots = [];
	const push = (/** @type {string} */ value, /** @type {string} */ label, /** @type {any} */ source) => {
		if (value && !slots.some((x) => x.value === value) && slots.length < SOURCE_SLOTS) slots.push({ value, label, source });
	};
	// what is in use first (kept as the source itself: a Library model keeps its name), then the primitives —
	// the toolbar's catalog order (scatterSources.sourceChoices)
	for (const src of [current, ...inUse]) if (src) push(sourceKey(src), sourceLabel(src), src);
	for (const c of sourceChoices({ packs: get(packChoiceList) })) if (c.value.startsWith('p:')) push(c.value, c.name, null);
	slotCache = { at: now, slots };
	return slots;
}

/** 52 (V3): pick a Source ▸ sector (resolves like the toolbar: a prefab exports its look first) @param {number} i */
export async function setVRScatterSource(i) {
	const slot = vrSourceSlots()[i];
	if (!slot) return false;
	const source = slot.source ? sourceOf(slot.source) : await resolveSourceChoice(slot.value);
	if (!source) return false;
	scatterSource.set(source);
	slotCache.at = 0;
	if (vrScatterTool() !== 'paint') setVRScatterTool('paint'); // a source is something to PAINT with
	else sculptOp.set('scatter');
	return true;
}

/** 52 (V3): the source in use, as the wheel names it */
export function vrSourceLabel() {
	try {
		return sourceLabel(get(scatterSource));
	} catch {
		return '';
	}
}

/** 52 (V3): is the stick's Y the scatter DENSITY right now (scatter-painting) rather than the strength? */
function stickIsDensity() {
	return get(sculptOp) === 'scatter' && vrScatterTool() === 'paint';
}

/** 52 (V3): is this controller slot a TRACKED HAND (no gamepad) rather than a controller? @param {number} index */
function isHandSlot(index) {
	const handedness = renderer?.xr?.getController(index)?.userData?.handedness;
	const session = renderer?.xr?.getSession?.();
	if (!session || !handedness) return false;
	const source = [...session.inputSources].find((s) => s.handedness === handedness);
	return !!source?.hand && !source?.gamepad;
}
let handHintAt = 0;
/** 52 rules: a precise tool asks for a controller when a hand pinches it */
function askForController() {
	stats.handRefusals++;
	if (Date.now() - handHintAt < 5000) return;
	handHintAt = Date.now();
	import('../gameAnnounce')
		.then((m) => m.announce('Pick up a controller', { sub: 'The brushes paint with the trigger; hands browse and place', ms: 3500 }))
		.catch(() => {});
}

/** the pointed spot on the sculpted object @param {number} index @returns {any} */
function hitOf(index) {
	const object = target();
	if (!object || index < 0) return null;
	const hits = controllerRay(index).intersectObject(object, false);
	return hits.find((/** @type {any} */ h) => h.object === object) ?? null;
}

/** @param {number} index */
export function sculptTriggerStart(index) {
	if (!get(vrSculptActive) || stroke) return false;
	// the radial or a panel row under the ray owns this press
	if (get(vrMenuOpen) || get(vrHovered)) return false;
	const hit = hitOf(index);
	const uuid = get(sculptObject);
	if (!hit || !uuid) return false; // off the terrain: an ordinary press (a panel, a ping)
	swallowAt = Date.now();
	// 52 (H): a brush is a precise tool — a tracked hand is asked to pick up a controller (the shared gate, one wording)
	if (controllerRequired('sculpt', index)) {
		stats.handRefusals++;
		return true;
	}
	// 52 rules: the brushes are controller tools — a pinching hand gets the ask, no stroke
	if (isHandSlot(index)) {
		askForController();
		return true;
	}
	beginStroke(uuid);
	stroke = { index, last: performance.now() };
	stats.strokes++;
	// 52 (V3): a stroke starts with a tick in the painting hand (felt in Edit too — the brush is the tool)
	stats.strokeTicks++;
	hapticPulse(0.35, 18, pointerHand(), true);
	brushAt(hit, 0.016);
	return true;
}

/** @param {number} index */
export function sculptTriggerEnd(index) {
	if (!stroke || (index >= 0 && index !== stroke.index)) return false;
	stroke = null;
	endStroke(); // ONE snapshot + ONE undo entry, the desktop stroke's own commit
	return true;
}

/** @param {any} hit @param {number} dt */
function brushAt(hit, dt) {
	const object = target();
	const uuid = get(sculptObject);
	if (!object || !uuid) return;
	const local = object.worldToLocal(hit.point.clone());
	strokeMove(uuid, local.x, local.z, dt, local.y);
	stats.moves++;
}

/** stick -> size (x) and strength (y, up = stronger); a tick at every half metre / tenth @param {number} x @param {number} y @param {number} dt */
export function adjustBrush(x, y, dt) {
	let ticked = false;
	if (Math.abs(x) > DEAD) {
		const r0 = get(sculptRadius);
		const r = THREE.MathUtils.clamp(r0 * Math.exp(x * dt * 1.4), RADIUS_MIN, RADIUS_MAX);
		sculptRadius.set(Math.round(r * 100) / 100);
		if (Math.floor(r0 * 2) !== Math.floor(r * 2)) ticked = true;
	}
	if (Math.abs(y) > DEAD && stickIsDensity()) {
		// 52 (V3): scatter-painting — up = denser (the toolbar's density row), a tick every 0.25 / m²
		const d0 = get(scatterDensity);
		const d = THREE.MathUtils.clamp(d0 - y * dt * 1.2, DENSITY_MIN, DENSITY_MAX);
		scatterDensity.set(Math.round(d * 1000) / 1000);
		if (Math.floor(d0 * 4 + 1e-6) !== Math.floor(d * 4 + 1e-6)) ticked = true;
	} else if (Math.abs(y) > DEAD) {
		const s0 = get(sculptStrength);
		const s = THREE.MathUtils.clamp(s0 - y * dt * 0.7, STRENGTH_MIN, STRENGTH_MAX);
		sculptStrength.set(Math.round(s * 1000) / 1000);
		if (Math.floor(s0 * 10 + 1e-6) !== Math.floor(s * 10 + 1e-6)) ticked = true;
	}
	if (ticked) {
		stats.ticks++;
		hapticPulse(0.1, 10, pointerHand());
	}
	return ticked;
}

/** per frame: the ring follows the pointer, a held trigger brushes, the stick sizes */
export function tickVRSculpt() {
	if (!get(vrSculptActive)) return;
	const now = performance.now();
	const dt = Math.min((now - lastFrame) / 1000, 0.1);
	lastFrame = now;
	// the session ended elsewhere (desktop Done, a scene clear, Interact, leaving the headset)
	if (!get(sculptObject) || !renderer?.xr?.getSession?.() || get(editorMode) === 'interact') {
		stopVRSculpt();
		return;
	}
	const index = stroke ? stroke.index : pointerIndex();
	const hit = get(vrMenuOpen) ? null : hitOf(index);
	if (hit) {
		const n = hit.face?.normal ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
		showCursorAt(hit.point, n);
		if (stroke) brushAt(hit, dt);
	} else hideCursor();
	if (!get(vrMenuOpen)) {
		const axes = axesForSlot(pointerIndex());
		adjustBrush(axes[2] ?? 0, axes[3] ?? 0, dt);
	}
	updateLabel();
}

/** the suites' view */
export function vrSculptDebug() {
	return {
		active: get(vrSculptActive),
		uuid: get(sculptObject),
		op: get(sculptOp),
		radius: get(sculptRadius),
		strength: get(sculptStrength),
		stroking: !!stroke,
		label: labelText,
		// 52 (V3)
		layer: get(paintLayer),
		tool: vrScatterTool(),
		density: get(scatterDensity),
		source: vrSourceLabel(),
		mode: get(sculptMode),
		labelHand: label?.parent?.userData?.handedness ?? null,
		...stats
	};
}

// ---- the brush label on the pointer hand ----------------------------------------------------------------
/** @type {any} */ let label = null;
/** @type {any} */ let labelCanvas = null;
let labelText = '';

const OP_LABEL = { raise: 'Raise', lower: 'Lower', smooth: 'Smooth', flatten: 'Flatten' };
const TOOL_LABEL = /** @type {Record<string, string>} */ ({ erase: 'Erase', rotate: 'Rotate', scale: 'Scale', relax: 'Relax' });

/** 52 (V3): what the hand label says — the brush, its size and its strength (density while scatter-painting) */
export function brushLabelText() {
	const op = get(sculptOp);
	const size = get(sculptRadius).toFixed(1) + ' m';
	const pct = Math.round(get(sculptStrength) * 100) + '%';
	if (op === 'paint') return 'Paint ' + (get(paintLayer) + 1) + ' · ' + size + ' · ' + pct;
	if (op === 'scatter') {
		const tool = vrScatterTool();
		if (tool === 'paint') {
			const name = vrSourceLabel();
			return (name ? (name.length > 10 ? name.slice(0, 9) + '…' : name) : 'Scatter') + ' · ' + size + ' · ' + get(scatterDensity).toFixed(2) + '/m²';
		}
		return (TOOL_LABEL[tool] ?? tool) + ' · ' + size + (tool === 'erase' ? '' : ' · ' + pct);
	}
	return (OP_LABEL[/** @type {keyof typeof OP_LABEL} */ (op)] ?? op) + ' · ' + size + ' · ' + pct;
}

function updateLabel() {
	if (typeof document === 'undefined' || !renderer?.xr) return;
	if (!label) {
		labelCanvas = document.createElement('canvas');
		labelCanvas.width = 320;
		labelCanvas.height = 80;
		const texture = new THREE.CanvasTexture(labelCanvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		label = new THREE.Mesh(
			new THREE.PlaneGeometry(0.09, 0.0225),
			new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: true })
		);
		label.name = 'vr-sculpt-label';
		// on the back of the controller, tilted up toward the eyes (the mode label's place on the other hand)
		label.position.set(0, 0.03, 0.07);
		label.rotation.set(-1.0, 0, 0);
		label.renderOrder = 996;
	}
	const index = pointerIndex();
	label.visible = index >= 0;
	if (index < 0) return;
	const controller = renderer.xr.getController(index);
	if (label.parent !== controller) controller.add(label);
	const text = brushLabelText();
	if (text === labelText) return;
	labelText = text;
	const ctx = labelCanvas.getContext('2d');
	if (!ctx) return;
	ctx.clearRect(0, 0, 320, 80);
	ctx.fillStyle = 'rgba(17, 24, 39, 0.88)';
	ctx.beginPath();
	ctx.roundRect?.(4, 4, 312, 72, 18);
	if (!ctx.roundRect) ctx.rect(4, 4, 312, 72);
	ctx.fill();
	ctx.fillStyle = '#5fd0ff'; // the brush ring's colour (terrainSculpt's cursor)
	// 52 (V3): a longer brush line (a source name) shrinks to fit the plate
	let px = 30;
	ctx.font = 'bold ' + px + 'px sans-serif';
	while (px > 18 && ctx.measureText(text).width > 296) ctx.font = 'bold ' + --px + 'px sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(text, 160, 42);
	label.material.map.needsUpdate = true;
}

function hideLabel() {
	if (label) {
		label.visible = false;
		label.parent?.remove(label);
	}
	labelText = '';
}

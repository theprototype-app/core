// 93 LP1 / LP3 — THE PORTAL AND CHECKPOINT OBJECT KINDS (Add ▸ Game ▸ Portal / Checkpoint). Both are
// ordinary meshes from the replicated `/create Portal` / `/create Checkpoint` (deterministic on every peer)
// carrying their record on userData (`portal` / `checkpoint`), so wire, saves, prefabs and undo need nothing
// new: a record edit is an `objectParameters` message + a `props` undo entry (the flowPath precedent).
//
//   Portal       a doorway frame with a glowing membrane and a floor arrow. Walking through it (its TRIGGER
//                box, below) takes THIS player to the target: a Levels-table level, a project scene and / or a
//                start object, through a transition (fade / iris / card). Arriving players stand in front of
//                it, facing its arrow (its local -Z).
//   Checkpoint   a floor pad with an arrow. Stepping on it saves THIS player's progress there: a later death
//                (a fall out of bounds, Respawn at checkpoint) or a reload of an exported game returns here.
//
// Both are SENSORS for physics (a doorway you cannot walk through is not a door; On Enter nodes still fire).
// A LEAF over three: geometries.svelte.js / customGeometries / the runtime import it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** the doorway (metres): opening width + height, frame thickness, depth */
const DOOR = { w: 1.8, h: 2.6, t: 0.16, d: 0.24 };
/** the pad radius (metres) */
const PAD_R = 0.8;

export const PORTAL_TRANSITIONS = ['fade', 'iris', 'card', 'none'];
/** a portal target that returns through the portal the player last came in by */
export const BACK_TARGET = '@back';

/**
 * The trigger box in the object's LOCAL frame (scaled with it): [min, max]. A player point inside it has entered.
 * @param {'portal' | 'checkpoint'} kind
 */
export function triggerBox(kind) {
	return kind === 'portal'
		? { min: [-DOOR.w / 2, 0, -0.45], max: [DOOR.w / 2, DOOR.h, 0.45] }
		: { min: [-PAD_R, -0.3, -PAD_R], max: [PAD_R, 2.2, PAD_R] };
}

/** a floor arrow pointing -Z (the arrival / facing direction), lying at y @param {number} y @param {number} len */
function arrow(y, len) {
	const shape = new THREE.Shape();
	const w = len * 0.22;
	shape.moveTo(-w / 2, 0);
	shape.lineTo(w / 2, 0);
	shape.lineTo(w / 2, len * 0.6);
	shape.lineTo(w * 1.2, len * 0.6);
	shape.lineTo(0, len);
	shape.lineTo(-w * 1.2, len * 0.6);
	shape.lineTo(-w / 2, len * 0.6);
	shape.closePath();
	const g = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false });
	// lay it flat (the shape's +Y becomes world -Z) and lift it
	g.rotateX(-Math.PI / 2);
	g.translate(0, y, 0);
	return new THREE.BufferGeometry().copy(g.toNonIndexed());
}

/** strip a geometry to position + normal + uv + a flat vertex colour, non-indexed (so mergeGeometries agrees)
 * @param {THREE.BufferGeometry} g @param {string} [hex] */
function plain(g, hex = '#ffffff') {
	const src = g.index ? g.toNonIndexed() : g;
	const out = new THREE.BufferGeometry();
	const pos = src.getAttribute('position');
	out.setAttribute('position', pos);
	if (!src.getAttribute('normal')) src.computeVertexNormals();
	out.setAttribute('normal', src.getAttribute('normal'));
	const uv = src.getAttribute('uv');
	out.setAttribute('uv', uv ?? new THREE.Float32BufferAttribute(new Float32Array(pos.count * 2), 2));
	const c = new THREE.Color(hex);
	const colors = new Float32Array(pos.count * 3);
	for (let i = 0; i < pos.count; i++) colors.set([c.r, c.g, c.b], i * 3);
	out.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
	return out;
}

const FRAME = '#9ca3af';
const MEMBRANE = '#7dd3fc';

/**
 * The portal mesh: the frame + the floor arrow (grey) and the membrane (sky blue), ONE material with vertex
 * colours — a material array would come back from the GLTF autosave as a group of meshes. Resting on y = 0,
 * centred on X/Z. Baked to plain buffers (a toJSON copy must rebuild with the same vertices).
 */
export function portalGeometry() {
	const { w, h, t, d } = DOOR;
	const left = new THREE.BoxGeometry(t, h + t, d).translate(-(w + t) / 2, (h + t) / 2, 0);
	const right = new THREE.BoxGeometry(t, h + t, d).translate((w + t) / 2, (h + t) / 2, 0);
	const top = new THREE.BoxGeometry(w + 2 * t, t, d).translate(0, h + t / 2, 0);
	const floor = arrow(0.01, 1.1).translate(0, 0, -0.35);
	const membrane = new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0);
	return /** @type {THREE.BufferGeometry} */ (
		mergeGeometries([plain(left, FRAME), plain(right, FRAME), plain(top, FRAME), plain(floor, FRAME), plain(membrane, MEMBRANE)])
	);
}

/** The checkpoint mesh: a flat pad + an arrow on it (one group). Resting on y = 0. */
export function checkpointGeometry() {
	const pad = plain(new THREE.CylinderGeometry(PAD_R, PAD_R, 0.06, 40).translate(0, 0.03, 0), '#f59e0b');
	const mark = plain(arrow(0.065, 0.9).translate(0, 0, 0.45), '#fff7ed');
	return /** @type {THREE.BufferGeometry} */ (mergeGeometries([pad, mark]));
}

/** @param {any} v @param {number} max */
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** a portal record at every boundary @param {any} raw */
export function normalizePortal(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const transition = PORTAL_TRANSITIONS.includes(r.transition) ? r.transition : 'fade';
	const level = text(r.level, 60);
	const scene = text(r.scene, 120);
	const spawn = text(r.spawn, 120);
	return {
		...(level ? { level } : {}),
		...(scene ? { scene } : {}),
		...(spawn ? { spawn } : {}),
		transition,
		// show the membrane in Play (off = an invisible doorway: a trigger in the world's own arch)
		show: r.show !== false,
		...(r.loading && typeof r.loading === 'object' ? { loading: r.loading } : {})
	};
}

/** a checkpoint record @param {any} raw */
export function normalizeCheckpoint(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	return { show: r.show !== false, ...(text(r.label, 60) ? { label: text(r.label, 60) } : {}) };
}

/** the portal's look: vertex colours, a soft glow, see-through so the membrane reads as a doorway @param {any} object */
function portalLook(object) {
	const m = object.material;
	m.color?.set('#ffffff');
	m.vertexColors = true;
	if ('emissive' in m) {
		m.emissive.set('#0ea5e9');
		m.emissiveIntensity = 0.35;
	}
	if ('roughness' in m) m.roughness = 0.35;
	m.transparent = true;
	m.opacity = 0.8;
	m.side = THREE.DoubleSide;
	m.depthWrite = false;
	m.needsUpdate = true;
}

/** Stamp a fresh portal (from the replicated /create, deterministic on every peer) @param {any} object */
export function stampPortal(object) {
	object.name = 'Portal';
	object.userData.portal = normalizePortal({});
	object.userData.physics = { mode: 'static', sensor: true };
	object.castShadow = false;
	object.userData.shadow = false;
	portalLook(object);
}

/** Stamp a fresh checkpoint @param {any} object */
export function stampCheckpoint(object) {
	object.name = 'Checkpoint';
	object.userData.checkpoint = normalizeCheckpoint({});
	object.userData.physics = { mode: 'static', sensor: true };
	object.castShadow = false;
	object.userData.shadow = false;
	const m = object.material;
	m.color?.set('#ffffff');
	m.vertexColors = true;
	if ('roughness' in m) m.roughness = 0.5;
	if ('emissive' in m) {
		m.emissive.set('#b45309');
		m.emissiveIntensity = 0.3;
	}
	m.needsUpdate = true;
}

/** is a point (world) inside an object's trigger box? @param {any} object @param {'portal'|'checkpoint'} kind @param {THREE.Vector3} world */
export function insideTrigger(object, kind, world) {
	const local = object.worldToLocal(world.clone());
	const { min, max } = triggerBox(kind);
	return local.x >= min[0] && local.x <= max[0] && local.y >= min[1] && local.y <= max[1] && local.z >= min[2] && local.z <= max[2];
}

// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene } from '../stores/sceneStore';

// 39 P2 — THE PLACEMENT GHOST: what an item being dragged into the viewport will look like
// where it would land. Two tiers per item:
//   BOX    a wire box with a faint fill and a ground footprint, sized from the item's dims
//          (the pack row, the library record, a measurement — or the 1 m "size unknown" box);
//   MODEL  the real model, translucent: the template's OWN geometry under ONE shared ghost
//          material — no clone of a buffer, no physics, no scripts, no shadows. Only built when
//          the item is already decoded in memory and the preview setting allows it.
// The box is always drawn first; a model swaps in on a later frame (never inside the pointer
// event that asked for it), so a drag never waits on a build.
//
// LOCAL by construction (golden rule 5): one group at the SCENE ROOT beside objectsGroup, so it
// is never saved, sent, undone or picked (every node's raycast is a no-op as well — the drop
// raycast must see the surface under the ghost, not the ghost).

const ROOT_NAME = 'place-ghost';
/** fallbacks when a theme token is missing (a token is read at build time — a canvas/GL colour
 * cannot take var()) */
const FALLBACK = { ok: '#3ba7ff', warn: '#fbbf24', bad: '#f87171' }; // tokens-ok: GL needs literals; the live values come from --accent/--ink-warn/--ink-bad

/** @param {string} token @param {string} fallback */
function tokenColor(token, fallback) {
	try {
		const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
		return new THREE.Color(v || fallback);
	} catch {
		return new THREE.Color(fallback);
	}
}

const noRaycast = () => {};
const unitEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/** @type {any} */
let root = null;
/** per-state materials, shared by every item @type {Record<string, {line: any, fill: any, foot: any, model: any}> | null} */
let mats = null;
/** @type {{group: any, box: any, model: any, modelKey: string | null}[]} */
let items = [];
/** the state the materials currently show */
let shownState = 'ok';
/** pending model swaps (cancelled when the ghost goes) @type {number[]} */
let swapTimers = [];

function materials() {
	if (mats) return mats;
	/** @param {any} color */
	const set = (color) => ({
		line: new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }),
		fill: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, depthWrite: false }),
		foot: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
		model: new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.55, emissive: color, emissiveIntensity: 0.25 })
	});
	mats = {
		ok: set(tokenColor('--accent', FALLBACK.ok)),
		warn: set(tokenColor('--ink-warn', FALLBACK.warn)),
		bad: set(tokenColor('--ink-bad', FALLBACK.bad))
	};
	return mats;
}

/** re-read the theme (a theme switch between two drags) */
function refreshMaterials() {
	if (!mats) return;
	const pairs = /** @type {const} */ ([['ok', '--accent', FALLBACK.ok], ['warn', '--ink-warn', FALLBACK.warn], ['bad', '--ink-bad', FALLBACK.bad]]);
	for (const [k, token, fb] of pairs) {
		const c = tokenColor(token, fb);
		for (const m of Object.values(mats[k])) {
			m.color.copy(c);
			if (m.emissive) m.emissive.copy(c);
		}
	}
}

/** @param {any} obj */
function quiet(obj) {
	obj.traverse((/** @type {any} */ n) => {
		n.raycast = noRaycast;
		n.castShadow = false;
		n.receiveShadow = false;
		n.matrixAutoUpdate = true;
	});
	return obj;
}

/** @param {number[]} box */
function boxGhost(box) {
	const m = materials()[shownState];
	const g = new THREE.Group();
	g.name = 'place-ghost-box';
	const w = Math.max(box[3] - box[0], 0.02);
	const h = Math.max(box[4] - box[1], 0.02);
	const d = Math.max(box[5] - box[2], 0.02);
	const cx = (box[0] + box[3]) / 2;
	const cy = (box[1] + box[4]) / 2;
	const cz = (box[2] + box[5]) / 2;
	const edges = new THREE.LineSegments(unitEdges, m.line);
	edges.renderOrder = 4990;
	const fill = new THREE.Mesh(unitBox, m.fill);
	for (const o of [edges, fill]) {
		o.scale.set(w, h, d);
		o.position.set(cx, cy, cz);
		g.add(o);
	}
	const foot = new THREE.Mesh(unitPlane, m.foot);
	foot.scale.set(w, 1, d);
	foot.position.set(cx, box[1] + 0.002, cz);
	foot.name = 'place-ghost-footprint';
	g.add(foot);
	return quiet(g);
}

/**
 * A translucent copy of a parsed template that SHARES its geometry (nothing is uploaded twice).
 * @param {any} template
 */
function modelGhost(template) {
	const m = materials()[shownState];
	const g = new THREE.Group();
	g.name = 'place-ghost-model';
	template.updateMatrixWorld(true);
	const inv = new THREE.Matrix4().copy(template.matrixWorld).invert();
	template.traverse((/** @type {any} */ node) => {
		if (!node.isMesh || !node.geometry || node.isSkinnedMesh) return;
		/** @type {any} */
		const copy = node.isInstancedMesh ? new THREE.InstancedMesh(node.geometry, m.model, node.count) : new THREE.Mesh(node.geometry, m.model);
		if (node.isInstancedMesh) copy.instanceMatrix = node.instanceMatrix;
		new THREE.Matrix4().multiplyMatrices(inv, node.matrixWorld).decompose(copy.position, copy.quaternion, copy.scale);
		copy.frustumCulled = false;
		g.add(copy);
	});
	return quiet(g);
}

/**
 * Show a ghost for `specs` (one per dragged item). Replaces any ghost already up.
 * @param {{box: number[], template?: any, key?: string}[]} specs
 */
export function showGhost(specs) {
	hideGhost();
	/** @type {any} */
	const scene = get(globalScene);
	if (!scene) return false;
	materials();
	refreshMaterials();
	root = new THREE.Group();
	root.name = ROOT_NAME;
	root.userData.local = true;
	for (const spec of specs) {
		const group = new THREE.Group();
		const box = boxGhost(spec.box);
		group.add(box);
		root.add(group);
		items.push({ group, box, model: null, modelKey: null });
	}
	quiet(root);
	root.visible = false;
	scene.add(root);
	return true;
}

/**
 * Swap item `i` to its real model on a LATER frame (the build never runs inside the pointer
 * event that asked for it). `null` puts the box back.
 * @param {number} i @param {any} template @param {string} key
 */
export function setGhostModel(i, template, key) {
	const item = items[i];
	if (!item || item.modelKey === key) return;
	const host = root;
	const build = () => {
		if (root !== host || !items[i]) return;
		if (item.model) {
			item.group.remove(item.model);
			item.model = null;
		}
		item.modelKey = key;
		if (!template) {
			item.box.visible = true;
			return;
		}
		item.model = modelGhost(template);
		item.group.add(item.model);
		// the model is the preview now; keep only the footprint of the box under it
		item.box.children.forEach((/** @type {any} */ c) => (c.visible = c.name === 'place-ghost-footprint'));
	};
	swapTimers.push(window.setTimeout(build, 0));
}

/**
 * Pose the ghost: one placement per item (world position + quaternion), its state colour,
 * and whether it is drawn at all (hidden while the pointer is off the viewport).
 * @param {{position: any, quaternion: any}[]} placements @param {'ok'|'warn'|'bad'} state @param {boolean} visible
 */
export function poseGhost(placements, state, visible) {
	if (!root) return;
	root.visible = visible;
	if (!visible) return;
	if (state !== shownState) {
		shownState = state;
		const m = materials()[state];
		root.traverse((/** @type {any} */ n) => {
			if (n.isLineSegments) n.material = m.line;
			else if (n.isMesh && n.name === 'place-ghost-footprint') n.material = m.foot;
			else if (n.isMesh && n.parent?.name === 'place-ghost-box') n.material = m.fill;
			else if (n.isMesh) n.material = m.model;
		});
	}
	placements.forEach((p, i) => {
		const g = items[i]?.group;
		if (!g || !p) return;
		g.position.copy(p.position);
		g.quaternion.copy(p.quaternion);
	});
}

/** Take the ghost down (and drop its object references — the geometry is the template's). */
export function hideGhost() {
	for (const t of swapTimers) clearTimeout(t);
	swapTimers = [];
	if (root) root.parent?.remove(root);
	root = null;
	items = [];
	shownState = 'ok';
}

/** @returns {any} the ghost root, for the suites (null when none) */
export function ghostRoot() {
	return root;
}

/** what the ghost shows, for the suites: per item 'box' | 'model', and the state */
export function ghostInfo() {
	return {
		visible: !!root?.visible,
		state: shownState,
		items: items.map((it) => ({
			tier: it.model ? 'model' : 'box',
			key: it.modelKey,
			position: it.group.position.toArray(),
			quaternion: it.group.quaternion.toArray(),
			boxScale: it.box.children[0]?.scale.toArray() ?? null,
			meshes: it.model ? it.model.children.length : 0
		}))
	};
}

/** the boxes held where a drop is still arriving (an import path parses before it adds) @type {Set<any>} */
const pending = new Set();

/**
 * Hold a box ghost at a drop's spot until the object lands — the import paths (an animated pack
 * item, a library model, a prefab) parse before they add, and the spot must not look empty while
 * they do. LOCAL like the ghost. Returns the release. A pending box gives up after 30 s.
 * @param {number[]} box @param {number[]} position @param {number[]} quaternion @returns {() => void}
 */
export function holdPendingGhost(box, position, quaternion) {
	/** @type {any} */
	const scene = get(globalScene);
	if (!scene) return () => {};
	const prev = shownState;
	shownState = 'ok';
	const g = boxGhost(box);
	shownState = prev;
	g.name = 'place-ghost-pending';
	g.position.fromArray(position);
	g.quaternion.fromArray(quaternion);
	scene.add(g);
	pending.add(g);
	const release = () => {
		clearTimeout(timer);
		g.parent?.remove(g);
		pending.delete(g);
	};
	const timer = setTimeout(release, 30000);
	return release;
}

/** how many drops are still arriving (the suites) */
export function pendingGhostCount() {
	return pending.size;
}

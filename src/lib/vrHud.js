// 36 B12 — THE GAME HUD IN THE HEADSET. The playing screen a template author drew (the score
// card top-left, the clock top-right, the hint along the bottom) drawn on ONE curved band in
// front of the eyes, laid out the way the author laid it out. The maths is the leaf
// vrHudLayout.js (the band, per-group anchored scale-up, the follow, the depth pull-in, texel
// sizing, the U8 action hints); this file owns the mesh, the canvas atlas and the frame.
//
// It REPLACES 30b's head-locked top strip (one row of short lines), and with it the reason
// modules drew their own VR readouts (Untangle's "Level N · crossings" sprite): a module that
// feeds the core HUD is in the headset now (`api.hud.vrHudShown()` is the probe). The wrist
// card stays — it is the way back to Edit mode and the Menu — and in 'wrist' placement it is
// the only HUD, as before.
//
// ONE DRAW CALL: one BufferGeometry (a curved strip per group of elements, nothing over the
// empty middle of the view), one MeshBasicMaterial, one canvas atlas. Not a laser target
// (no raycast, not a panel-group provider): a HUD is read, never pressed — anything pressable
// already makes its screen a board screen (vrGamePanel.isPanelScreen).
//
// LOCAL and non-replicated, at the scene root under a fixed name (golden rule 5), on the
// default layer (both eyes), only while a headset is presenting and the player is in
// Interact/Play — vrGamePanelFrame calls `vrHudFrame` with the head pose and the overlay
// screens it already split off, so the suites drive it with a synthetic head exactly like
// the board.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, globalRenderer, objectsGroup } from '../stores/sceneStore';
import { isRenderableKind } from './hudKinds';
import { drawHudElement, roundRect, imageTick, moduleVrText } from './hudCanvasDraw';
import { PANEL_ORDER } from './vrPanelOverlay';
import { MODULE_WORLD_ROOT } from './moduleWorld';
import { touchSpec } from './touchSpec';
import { bindingOf, controlName } from './vr/bindings.js';
import { vrJumpHeight } from './vrControls';
import { vrHudPlacement, vrHudSize, vrHudHints, vrHudShownNow } from './vrHudPrefs';
import {
	STAGE_W,
	STAGE_H,
	HEADSET_PPD,
	HUD_SIZES,
	HUD_BASE_DIST,
	hudItems,
	scaleClusters,
	clusterRects,
	overlaps,
	degPerPx,
	stageAngles,
	texelScale,
	packShelves,
	bandGeometry,
	followState,
	followHead,
	anchorWorld,
	pickRadius,
	easeRadius,
	vrActionHints
} from './vrHudLayout';

const NAME = 'vr-game-hud';
/** the atlas never gets wider than this (a Quest handles 4096; 2048 keeps it cheap) */
const ATLAS_MAX_W = 2048;
/** the depth probe runs this often (s) — a raycast per group, BVH-accelerated */
const PROBE_EVERY = 0.1;
/** the hint row's look, in stage px (scaled with its group like any element) */
const HINT_H = 30;
const HINT_SIZE = 15;

/** @typedef {{el: any, rect: import('./vrHudLayout').Rect}} Drawn */
/** @typedef {{rect: import('./vrHudLayout').Rect, f: number, k: number, plate: boolean, members: Drawn[], slot: {x: number, y: number}, cw: number, ch: number}} Group */

/** @type {{mesh: THREE.Mesh, canvas: HTMLCanvasElement, g: CanvasRenderingContext2D, texture: THREE.CanvasTexture} | null} */
let surf = null;
/** @type {Group[]} */
let groups = [];
let layoutSig = '';
let contentSig = '';
let halfWidth = HUD_SIZES.medium;
let radius = NaN;
let probeIn = 0;
const pose = /** @type {import('./vrHudLayout').FollowState & {moving?: boolean}} */ (followState());
let posePlacement = '';
const debug = { draws: 0, builds: 0, probes: 0, lastDistances: /** @type {number[]} */ ([]), target: /** @type {number | null} */ (null) };

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
/** @type {any} */ (raycaster).firstHitOnly = true;

function surface() {
	if (!surf) {
		const canvas = document.createElement('canvas');
		canvas.width = 4;
		canvas.height = 4;
		const g = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
		const texture = new THREE.CanvasTexture(canvas);
		texture.colorSpace = THREE.SRGBColorSpace;
		texture.anisotropy = 4;
		texture.minFilter = THREE.LinearMipmapLinearFilter;
		texture.generateMipmaps = true;
		const mesh = new THREE.Mesh(
			new THREE.BufferGeometry(),
			// drawn over the scene (the band is pulled in front of anything nearer, so this never
			// shows the HUD "through" a surface closer than it reads), never written to depth
			new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })
		);
		mesh.name = NAME;
		mesh.renderOrder = PANEL_ORDER;
		mesh.frustumCulled = false;
		mesh.visible = false;
		mesh.raycast = () => {}; // read, never pressed — and never a laser stop
		mesh.userData.localOnly = true;
		mesh.userData.vrOverlay = false;
		surf = { mesh, canvas, g, texture };
	}
	const scene = /** @type {any} */ (get(globalScene));
	if (scene && surf.mesh.parent !== scene) scene.add(surf.mesh);
	return surf;
}

/** the headset controls the game's input actions map to (U8), truthful only */
function hintLine(/** @type {boolean} */ menu) {
	if (!get(vrHudHints)) return [];
	const name = (/** @type {string} */ id) => {
		const b = bindingOf(id);
		return b ? controlName(b.hand, b.control) : null;
	};
	const actions = /** @type {any[]} */ (get(touchSpec)?.actions ?? []);
	return vrActionHints(actions, { jump: vrJumpHeight() > 0 ? name('ptt') : null, trigger: 'Trigger', grip: 'Grip', menu: menu ? name('pause') : null }).map(
		(h) => h.control + '  ' + h.label
	);
}

/** where the hint row goes: bottom-centre, lifted above whatever the author put there
 * @param {import('./vrHudLayout').Rect[]} taken @param {number} w */
function hintRect(taken, w) {
	const rect = { left: STAGE_W / 2 - w / 2, top: STAGE_H - 12 - HINT_H, w, h: HINT_H };
	for (let i = 0; i < 12 && taken.some((t) => overlaps(t, rect, 0)); i++) rect.top -= HINT_H + 6;
	return rect;
}

/**
 * Lay the overlay screens out on the band: groups, their scale, their atlas slots, the
 * geometry. Runs only when the LAYOUT changes (elements moved/added, the size setting, the
 * hint row's length), never per frame.
 * @param {any[]} elements @param {string[]} hints
 */
function buildLayout(elements, hints) {
	halfWidth = HUD_SIZES[get(vrHudSize)] ?? HUD_SIZES.medium;
	const sorted = [...elements].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
	const items = hudItems(sorted, isRenderableKind);
	const kept = items.map((it) => sorted.find((el) => String(el.id ?? '') === it.id && el.kind === it.kind));
	const { rects, clusters } = scaleClusters(items);
	const s = degPerPx(halfWidth);
	/** @type {Group[]} */
	const out = clusters.map((c) => ({
		rect: c.rect,
		f: c.f,
		k: texelScale(s * c.f),
		plate: c.plate,
		members: c.members.map((m) => ({ el: kept[m], rect: rects[m] })),
		slot: { x: 0, y: 0 },
		cw: 0,
		ch: 0
	}));
	if (hints.length) {
		// the hint row: one synthetic text element, its own group, anchored bottom-centre
		const label = hints.join('     ·     ');
		const w = Math.min(STAGE_W - 40, 40 + label.length * 8.6);
		const r = hintRect(
			out.map((g) => g.rect),
			w
		);
		const el = { id: '__vrhints', kind: 'text', label, style: { size: HINT_SIZE, align: 'center', color: '#e5e7eb' } };
		const [g] = clusterRects([r]);
		out.push({ rect: g.rect, f: 1, k: texelScale(s), plate: true, members: [{ el, rect: r }], slot: { x: 0, y: 0 }, cw: 0, ch: 0 });
	}
	for (const g of out) {
		g.cw = Math.ceil(g.rect.w * g.k);
		g.ch = Math.ceil(g.rect.h * g.k);
	}
	const pack = packShelves(
		out.map((g) => ({ w: g.cw, h: g.ch })),
		ATLAS_MAX_W
	);
	out.forEach((g, i) => (g.slot = pack.slots[i]));
	const s0 = surface();
	if (s0.canvas.width !== pack.w || s0.canvas.height !== pack.h) {
		s0.canvas.width = pack.w;
		s0.canvas.height = pack.h;
		s0.texture.dispose(); // a CanvasTexture keeps its GPU allocation at the old size otherwise
	}
	const quads = out.map((g) => ({
		rect: g.rect,
		uv: { u0: g.slot.x / pack.w, u1: (g.slot.x + g.cw) / pack.w, v1: 1 - g.slot.y / pack.h, v0: 1 - (g.slot.y + g.ch) / pack.h }
	}));
	const data = bandGeometry(quads, halfWidth);
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
	geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
	geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
	s0.mesh.geometry.dispose();
	s0.mesh.geometry = geometry;
	groups = out;
	contentSig = '';
	debug.builds++;
}

/** paint every group into its atlas slot @param {Record<string, any>} runtime */
function drawAtlas(runtime) {
	const s0 = surface();
	const g = s0.g;
	g.setTransform(1, 0, 0, 1, 0, 0);
	g.clearRect(0, 0, s0.canvas.width, s0.canvas.height);
	for (const grp of groups) {
		g.save();
		g.beginPath();
		g.rect(grp.slot.x, grp.slot.y, grp.cw, grp.ch);
		g.clip();
		if (grp.plate) {
			// a translucent plate so white text reads against a bright sky or a white wall
			roundRect(g, grp.slot.x + 1, grp.slot.y + 1, grp.cw - 2, grp.ch - 2, Math.min(14 * grp.k, grp.ch / 2));
			g.fillStyle = 'rgba(10, 14, 22, 0.62)';
			g.fill();
		}
		for (const m of grp.members) {
			if (!m.el) continue;
			const x = grp.slot.x + (m.rect.left - grp.rect.left) * grp.k;
			const y = grp.slot.y + (m.rect.top - grp.rect.top) * grp.k;
			drawHudElement(g, m.el, x, y, m.rect.w * grp.k, m.rect.h * grp.k, grp.k * grp.f, runtime?.[m.el.id] ?? null);
		}
		g.restore();
	}
	s0.texture.needsUpdate = true;
	debug.draws++;
}

/** the band's distance: rays from the eye through each group's centre, against the scene's
 * content (objects + module worlds), only VISIBLE hits count @param {any} head */
function probeDepth(head) {
	const scene = /** @type {any} */ (get(globalScene));
	const roots = [/** @type {any} */ (get(objectsGroup)), scene?.getObjectByName?.(MODULE_WORLD_ROOT)].filter(Boolean);
	if (!roots.length || !surf) return [];
	_origin.copy(head.position);
	raycaster.far = HUD_BASE_DIST + 0.5;
	raycaster.near = 0.05;
	// a Sprite's raycast THROWS without a camera (the 31 Untangle trap): the eye camera
	const renderer = /** @type {any} */ (get(globalRenderer));
	raycaster.camera = renderer?.xr?.isPresenting ? renderer.xr.getCamera() : /** @type {any} */ (null);
	/** @type {number[]} */
	const out = [];
	for (const grp of groups) {
		const a = stageAngles(grp.rect.left + grp.rect.w / 2, grp.rect.top + grp.rect.h / 2, halfWidth);
		_dir.set(Math.sin(a.yaw), Math.tan(a.pitch), -Math.cos(a.yaw)).normalize().applyQuaternion(surf.mesh.quaternion);
		raycaster.set(_origin, _dir);
		/** @type {THREE.Intersection[]} */
		let hits = [];
		try {
			hits = raycaster.intersectObjects(roots, true);
		} catch {
			// a module's object that cannot be raycast here (a Sprite with no camera): no answer
		}
		const hit = hits.find((h) => visibleChain(h.object));
		out.push(hit ? hit.distance : Infinity);
	}
	debug.probes++;
	debug.lastDistances = out;
	return out;
}
/** @param {any} o */
function visibleChain(o) {
	for (let n = o; n; n = n.parent) if (n.visible === false) return false;
	return !o.isLine && !o.isPoints && !o.isSprite;
}

/**
 * One frame of the band. `overlay` are the non-menu screens on show (vrGamePanel's split),
 * `head` the headset pose (THREE vector + quaternion) or null, `live` = presenting AND in
 * Interact/Play. Returns what is on show.
 * @param {{head: {position: any, quaternion: any} | null, overlay: {key: string, screen: any}[], runtime: Record<string, any>,
 *   live: boolean, dt?: number, extra?: string | null, menu?: boolean}} opts
 */
export function vrHudFrame(opts) {
	const placement = get(vrHudPlacement);
	const elements = opts.live ? opts.overlay.flatMap((o) => o.screen?.elements ?? []) : [];
	const hints = opts.live ? [...(opts.extra ? [opts.extra] : []), ...hintLine(!!opts.menu)] : [];
	const want = !!opts.head && opts.live && placement !== 'wrist' && (elements.length > 0 || hints.length > 0);
	if (!want) {
		if (surf) surf.mesh.visible = false;
		if (!opts.live || !opts.head) pose.ready = false;
		vrHudShownNow.value = false;
		return { visible: false, placement };
	}
	const head = /** @type {{position: any, quaternion: any}} */ (opts.head);
	const s0 = surface();
	const lsig = JSON.stringify([
		get(vrHudSize),
		hints.join('|').length,
		elements.map((el) => [el.id, el.kind, el.anchor, el.x, el.y, el.w, el.h, el.z ?? 0, el.style?.bg ?? '', el.kind === 'panel'])
	]);
	if (lsig !== layoutSig) {
		layoutSig = lsig;
		buildLayout(elements, hints);
	}
	// a module kind's headset text (its clock ticks with no runtime write) is part of the content
	const csig = JSON.stringify([elements, opts.runtime, hints, imageTick(), elements.map((el) => moduleVrText(el, opts.runtime?.[el.id]))]);
	if (csig !== contentSig) {
		contentSig = csig;
		if (groups.length && groups[groups.length - 1].members[0]?.el?.id === '__vrhints') groups[groups.length - 1].members[0].el.label = hints.join('     ·     ');
		drawAtlas(opts.runtime);
	}
	// ---- the pose: head-locked with lag, or fixed in the world
	const dt = opts.dt ?? 1 / 72;
	_e.setFromQuaternion(head.quaternion, 'YXZ');
	const h = { x: head.position.x, y: head.position.y, z: head.position.z, yaw: _e.y, pitch: _e.x };
	if (posePlacement !== placement) {
		pose.ready = false;
		posePlacement = placement;
	}
	if (placement === 'world') anchorWorld(pose, h, dt);
	else followHead(pose, h, dt);
	s0.mesh.position.set(pose.x, pose.y, pose.z);
	s0.mesh.quaternion.setFromEuler(_e.set(placement === 'world' ? 0 : pose.pitch, pose.yaw, 0, 'YXZ'));
	// ---- the depth: in front of anything nearer along the band, never behind it
	probeIn -= dt;
	if (probeIn <= 0 || !Number.isFinite(radius)) {
		probeIn = PROBE_EVERY;
		s0.mesh.updateMatrixWorld(true);
		radius = easeRadius(radius, pickRadius(probeDepth(head)), Number.isFinite(radius) ? PROBE_EVERY : 0);
		debug.target = pickRadius(debug.lastDistances);
	} else radius = easeRadius(radius, pickRadius(debug.lastDistances), dt);
	s0.mesh.scale.setScalar(radius);
	s0.mesh.updateMatrixWorld(true);
	s0.mesh.visible = true;
	vrHudShownNow.value = true;
	return { visible: true, placement };
}

/** Hide the band (the session ended, the player left the game). */
export function hideVrHud() {
	if (surf) surf.mesh.visible = false;
	pose.ready = false;
	radius = NaN;
	vrHudShownNow.value = false;
}

/** the band's mesh and canvas (suites read poses, groups and pixels) */
export function vrHudSurface() {
	return surf ? { mesh: surf.mesh, canvas: surf.canvas } : null;
}

/** what the band is doing, for the suites and the debug hook */
export function vrHudDebug() {
	const s = degPerPx(halfWidth);
	return {
		visible: !!surf?.mesh.visible,
		placement: get(vrHudPlacement),
		size: get(vrHudSize),
		halfWidth,
		radius,
		target: debug.target ?? null,
		distances: [...debug.lastDistances],
		atlas: surf ? { w: surf.canvas.width, h: surf.canvas.height } : null,
		// canvas texels per headset pixel per group: >= 1 is crisp (33 X1's texelRatio)
		groups: groups.map((g) => ({
			rect: { ...g.rect },
			f: g.f,
			k: g.k,
			plate: g.plate,
			ids: g.members.map((m) => String(m.el?.id ?? '')),
			// each member's box in ATLAS px (the suites read pixels there)
			boxes: g.members.map((m) => ({
				id: String(m.el?.id ?? ''),
				x: g.slot.x + (m.rect.left - g.rect.left) * g.k,
				y: g.slot.y + (m.rect.top - g.rect.top) * g.k,
				w: m.rect.w * g.k,
				h: m.rect.h * g.k
			})),
			slot: { ...g.slot, w: g.cw, h: g.ch },
			texelRatio: g.k / (s * g.f * HEADSET_PPD)
		})),
		pose: surf ? { position: surf.mesh.position.toArray(), yaw: pose.yaw, pitch: pose.pitch } : null,
		hints: groups.find((g) => g.members[0]?.el?.id === '__vrhints')?.members[0].el.label ?? null,
		draws: debug.draws,
		builds: debug.builds,
		probes: debug.probes,
		triangles: surf ? (surf.mesh.geometry.index?.count ?? 0) / 3 : 0
	};
}

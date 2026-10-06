// VR controls — controller rays, the beam + reticle, hover highlight, panel groups and the panel overlay, ray helpers.
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import * as THREE from 'three';
import { get } from 'svelte/store';
import {
	objectsGroup,
	globalCamera,
	globalScene,
	vrMenuHand,
	vrMenuOpen,
	vrSettingsPanelOpen,
	isVRMode,
	vrObjectsPanelOpen,
	vrChatPanelOpen,
	vrPaletteOpen,
	vrPropsPanelOpen,
	vrPrefabsPanelOpen,
	vrEditMenuOpen,
	vrSnapMenuOpen,
	vrApprovePanelOpen
} from '../../stores/sceneStore';
import { moduleGroupList, moduleGroupsRevision } from '../moduleContent';
import { overlayPanel, makeDepthSentinel, PANEL_ORDER, BEAM_ORDER } from '../vrPanelOverlay';
import { moduleWorldChildren } from '../moduleWorld';
import { editingObject, vertexHandleMesh } from '../meshEdit';
import { peers } from '../../stores/appStore';
import { topLevelObjectOf } from '../objectActions';
import { pickStack, primaryIndex } from '../selectThrough'; // 36 S6
import { rayPass } from '../pickPass';
import { vrKeyboardTarget } from '../vrKeyboard';
import { pingColor } from '../ping';
import { peerColor } from '../lockControl';
import { helpersHidden } from '../helperLayer';
import { renderer, raycaster, tempMatrix } from './core.js';
import { panelGroupProviders } from './hooks.js';
import { controllerIndexFor } from './input.js';
import {
	vrMenuGroup,
	vrPanelGroup,
	vrPaletteGroup,
	vrPropsGroup,
	vrEditGroup,
	vrSnapGroup,
	vrSettingsGroup,
	vrPrefabsGroup,
	vrChatGroup,
	vrApproveGroup,
	vrKeyboardGroup
} from './panels.js';
import { vrPingArmed } from './radial.js';

// --- clarity pack: controller rays, hover highlight, snap turn ---
/** @type {any[]} */ let rayLines = []; // fat beam meshes, one per controller
/** @type {any[]} */ let rayReticles = []; // hit-point disc at each beam's tip
/** @type {any} */ let hoveredObject = null;
let hoveredEmissive = 0;
/** @type {any} */ let hoverBox = null; // scene-root shell around the hovered object

const RAY_IDLE = 0x8ab4ff;
const RAY_HOVER = 0x5fd0ff;

function ensureRayLines() {
	if (rayLines.length > 0 || !renderer) return;
	// a tapered cylinder along -Z (spans 0..-1) reads as a visible beam on-device
	// where a 1px THREE.Line vanishes. 31 G5: NORMAL blending — the additive glow it had
	// vanished against a bright sky ("i want to be able to see from controller ray where i
	// point in menu"), the documented additive-burst trap
	const beamGeo = new THREE.CylinderGeometry(0.0014, 0.004, 1, 8, 1, true);
	beamGeo.rotateX(-Math.PI / 2); // axis +Y -> -Z (narrow top ends toward the tip)
	beamGeo.translate(0, 0, -0.5); // span 0 (controller) .. -1 (tip)
	for (let i = 0; i < 2; i++) {
		const beam = new THREE.Mesh(
			beamGeo,
			new THREE.MeshBasicMaterial({
				color: RAY_IDLE,
				transparent: true,
				opacity: 0.8,
				depthWrite: false
			})
		);
		beam.name = 'vr-ray';
		beam.scale.z = 5;
		renderer.xr.getController(i).add(beam);
		rayLines.push(beam);

		// hit reticle: a small ring at the beam tip, scaled with distance so it
		// keeps a constant angular size; shown only when the ray hits something
		const reticle = new THREE.Mesh(
			new THREE.RingGeometry(0.02, 0.03, 20),
			new THREE.MeshBasicMaterial({
				color: RAY_HOVER,
				transparent: true,
				opacity: 0.9,
				depthWrite: false,
				side: THREE.DoubleSide
			})
		);
		reticle.name = 'vr-ray-reticle';
		reticle.visible = false;
		// 31 G5: a solid DOT at the exact hit point inside the ring — the ring alone left the
		// point itself empty, which is where a small button is
		const dot = new THREE.Mesh(
			new THREE.CircleGeometry(0.0075, 16),
			new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide })
		);
		dot.name = 'vr-ray-dot';
		dot.position.z = 0.0005;
		reticle.add(dot);
		renderer.xr.getController(i).add(reticle);
		rayReticles.push(reticle);
	}
}

/** Scene-root shell around the hovered object — emissive-INDEPENDENT (a
 * MeshBasicMaterial object shows no emissive tint), copies world bounds per
 * frame, never parented into objectsGroup (would leak into GLTF sync).
 * Exported for headless tests. @param {any} object */
export function updateHoverBox(object) {
	const scene = get(globalScene);
	if (!scene) return;
	// 30b P1: the hover shell is editor scaffolding — none in Interact/Play
	if (helpersHidden()) object = null;
	if (!hoverBox) {
		hoverBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(RAY_HOVER));
		hoverBox.name = 'vr-hover-box';
		hoverBox.material.transparent = true;
		hoverBox.material.opacity = 0.7;
		hoverBox.material.depthTest = false;
		hoverBox.renderOrder = 997;
		scene.add(hoverBox);
	}
	if (object) {
		hoverBox.visible = true;
		hoverBox.box.setFromObject(object);
	} else hoverBox.visible = false;
}

function setHovered(object) {
	// the shell is the primary, emissive-independent cue; the emissive tint is a
	// secondary touch for materials that support it
	updateHoverBox(object);
	// 30b P1: ...and neither is the emissive hover tint (it paints a replicated material)
	if (helpersHidden()) object = null;
	if (hoveredObject === object) return;
	if (hoveredObject?.material?.emissive) hoveredObject.material.emissive.setHex(hoveredEmissive);
	hoveredObject = null;
	if (object) {
		/** @type {any} */ let target = null;
		object.traverse((/** @type {any} */ node) => {
			if (!target && node.material?.emissive) target = node;
		});
		if (target) {
			hoveredObject = target;
			hoveredEmissive = target.material.emissive.getHex();
			target.material.emissive.setHex(0x2f4f9f);
		}
	}
}

/** D5: the floating panel groups a beam may terminate on — only the OPEN
 * ones (same gating as their raycast* pickers) */
function openPanelGroups() {
	/** @type {any[]} */ const list = [];
	const add = (/** @type {boolean} */ open, /** @type {any} */ store) => {
		const panel = open ? get(store) : null;
		if (panel) list.push(panel);
	};
	for (const provider of panelGroupProviders) {
		try {
			const panel = provider();
			if (panel) list.push(panel);
		} catch {}
	}
	// 31 K2: a module's registered VR panels (api.vrPanel) — the beam ends on them too
	for (const panel of overlayPanels) if (panel.visible !== false && panel.parent) list.push(panel);
	add(get(vrMenuOpen), vrMenuGroup);
	add(get(vrObjectsPanelOpen), vrPanelGroup);
	add(get(vrPropsPanelOpen), vrPropsGroup);
	add(get(vrPrefabsPanelOpen), vrPrefabsGroup);
	add(get(vrChatPanelOpen), vrChatGroup);
	add(get(vrSettingsPanelOpen), vrSettingsGroup);
	add(get(vrApprovePanelOpen), vrApproveGroup);
	add(get(vrEditMenuOpen), vrEditGroup);
	add(get(vrSnapMenuOpen), vrSnapGroup);
	add(!!get(vrKeyboardTarget), vrKeyboardGroup);
	add(get(vrPaletteOpen), vrPaletteGroup);
	return list;
}

/** 31 K2: module-registered VR panels (api.vrPanel) @type {Set<any>} */
const overlayPanels = new Set();
/**
 * 31 K2: make a module's object a VR PANEL — drawn over the scene like core's panels, and
 * a beam end. Returns the undo. @param {any} object @returns {() => void}
 */
export function registerOverlayPanel(object) {
	if (!object) return () => {};
	overlayPanels.add(object);
	overlayPanel(object);
	return () => {
		overlayPanels.delete(object);
	};
}
/** 34 R6: the registered module panels (the lifecycle contract checks a module's go with it) */
export function overlayPanelsDebug() {
	return [...overlayPanels];
}
/** @type {any} */ let depthSentinel = null;
/**
 * 31 K2 (U4): every open panel draws OVER the scene — see vrPanelOverlay.js for why a depth
 * clear rather than depthTest:false. Core's panels (svelte trees whose children change as
 * they re-render) are re-marked every frame (idempotent, allocation-free); the game surfaces
 * and api.vrPanel objects are marked when made. The sentinel is in the scene only while a
 * panel is open, so a frame without one is byte-for-byte the old frame.
 */
function updatePanelOverlay() {
	const panels = openPanelGroups();
	let any = false;
	for (const panel of panels) {
		if (panel.userData?.vrOverlay === false) continue; // a provider's world handles (spline, sleeve)
		overlayPanel(panel);
		any = true;
	}
	const scene = /** @type {any} */ (get(globalScene));
	if (any && scene) {
		if (!depthSentinel) depthSentinel = makeDepthSentinel(THREE);
		if (depthSentinel.parent !== scene) scene.add(depthSentinel);
		depthSentinel.visible = true;
	} else if (depthSentinel) depthSentinel.visible = false;
}
/** 31 K2: how many times the panel depth clear ran (the suites' view) */
export function panelOverlayDebug() {
	return { clears: depthSentinel?.userData.clears ?? 0, visible: !!depthSentinel?.visible, order: PANEL_ORDER };
}

/** 31 G5: the registered INTERACTIVE module groups present in the scene (re-homed under
 * module-world-root since 30b P5, or still at the scene root) @returns {any[]} */
function moduleInteractiveRoots() {
	const revision = get(moduleGroupsRevision);
	if (revision !== interactiveNamesAt) {
		interactiveNamesAt = revision;
		interactiveNames = moduleGroupList()
			.filter((entry) => entry.kinds.has('interactive'))
			.map((entry) => entry.name);
	}
	interactiveRoots.length = 0;
	if (!interactiveNames.length) return interactiveRoots;
	const children = moduleWorldChildren();
	for (const name of interactiveNames) {
		let node = null;
		for (const c of children) if (c.name === name) node = c;
		node = node ?? /** @type {any} */ (get(globalScene))?.getObjectByName(name);
		if (node && node.visible !== false) interactiveRoots.push(node);
	}
	return interactiveRoots;
}
let interactiveNamesAt = -1;
/** @type {string[]} */ let interactiveNames = [];
/** @type {any[]} */ const interactiveRoots = [];

/** D5: where a beam terminates — the NEAREST hit among scene objects and any
 * open floating panel, so navigating menus shows the beam ending in a circle
 * on the hovered control (parity with object selection). Exported for
 * headless tests. @param {any} ray a THREE.Raycaster
 * @returns {{distance: number, hit: boolean, object: any, info: any, panel: boolean}} */
export function beamTarget(ray) {
	const group = get(objectsGroup);
	let distance = 5;
	let hit = false;
	let object = null;
	let info = null;
	if (group) {
		// 36 S6: the laser follows the pick-through rules — it ends on the object a press
		// would select (the fish, not the water in front of it), the editor's or the game's
		const stack = pickStack(ray.intersectObjects(group.children, true), topLevelObjectOf, rayPass());
		const entry = stack.length ? stack[primaryIndex(stack)] : null;
		if (entry) {
			distance = entry.hit.distance;
			hit = true;
			object = entry.target;
			info = entry.hit;
		}
	}
	// 31 G5: a module's INTERACTIVE scene-root content (its board, its buttons, its level
	// picker) ends the beam too — it lives under module-world-root, outside objectsGroup, so
	// the laser used to pass straight through a module's menu with no dot on it
	for (const root of moduleInteractiveRoots()) {
		const hits = safeIntersect(ray, root);
		const first = hits.find((/** @type {any} */ h) => h.object.visible !== false && !h.object.isLine && !h.object.isPoints);
		if (first && first.distance < distance) {
			distance = first.distance;
			hit = true;
			object = null;
			info = first;
		}
	}
	// 31 K2: a VR panel is drawn OVER the scene (vrPanelOverlay), so a panel the ray reaches
	// ends the beam even when a floor or a base stands in front of it — the press goes to the
	// panel there too (a panel hit wins every trigger path), and the beam must agree with it
	let panelDistance = Infinity;
	/** @type {any} */ let panelInfo = null;
	for (const panel of openPanelGroups()) {
		const hits = ray.intersectObject(panel, true);
		if (hits.length > 0 && hits[0].distance < panelDistance) {
			panelDistance = hits[0].distance;
			panelInfo = hits[0];
		}
	}
	if (panelInfo) {
		distance = panelDistance;
		hit = true;
		object = null; // a panel never highlights the object behind it
		info = panelInfo;
	}
	// D8: while vertex-editing, the scene-root handle dots are beam targets too
	// (they live OUTSIDE objectsGroup); a handle hit never highlights an object
	const handles = get(editingObject) ? vertexHandleMesh() : null;
	if (handles) {
		const hits = ray.intersectObject(handles);
		if (hits.length > 0 && hits[0].distance < distance) {
			distance = hits[0].distance;
			hit = true;
			object = null;
			info = hits[0];
		}
	}
	return { distance, hit, object, info, panel: !!panelInfo && info === panelInfo };
}

/** D5: controller-local reticle pose — the ring sits at the beam tip, laid
 * ONTO the hit surface when a world normal is known (flipped toward the
 * viewer, nudged a hair off the surface so it never z-fights), beam-aligned
 * otherwise. Pure for headless tests.
 * @param {any} THREE_NS @param {any} controllerQuat world quaternion
 * @param {number} distance @param {any=} worldNormal */
export function reticlePose(THREE_NS, controllerQuat, distance, worldNormal) {
	const scale = Math.max(distance, 0.2);
	const position = new THREE_NS.Vector3(0, 0, -distance);
	const quaternion = new THREE_NS.Quaternion();
	if (!worldNormal) return { position, quaternion, scale };
	const normal = worldNormal.clone().normalize();
	const beamDir = new THREE_NS.Vector3(0, 0, -1).applyQuaternion(controllerQuat);
	if (normal.dot(beamDir) > 0) normal.negate(); // face the viewer side
	const align = new THREE_NS.Quaternion().setFromUnitVectors(
		new THREE_NS.Vector3(0, 0, 1),
		normal
	);
	quaternion.copy(controllerQuat).invert().multiply(align);
	const localNormal = normal.clone().applyQuaternion(controllerQuat.clone().invert());
	position.add(localNormal.multiplyScalar(0.004 * scale));
	return { position, quaternion, scale };
}

const _hitNormalMatrix = new THREE.Matrix3();
const _hitWorldNormal = new THREE.Vector3();
const _reticleCtrlQuat = new THREE.Quaternion();

/** World-space normal of a raycast hit, or null @param {any} info */
function hitWorldNormal(info) {
	if (!info?.face?.normal || !info.object) return null;
	return _hitWorldNormal
		.copy(info.face.normal)
		.applyNormalMatrix(_hitNormalMatrix.getNormalMatrix(info.object.matrixWorld))
		.normalize();
}

/** Rays follow hits, pointed object glows @param {boolean} presenting */
export function updateRaysAndHover(presenting) {
	ensureRayLines();
	rayLines.forEach((line) => (line.visible = presenting));
	if (!presenting) {
		rayReticles.forEach((r) => (r.visible = false));
		setHovered(null);
		if (depthSentinel) depthSentinel.visible = false;
		return;
	}
	updatePanelOverlay();
	const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
	// D6: an armed one-shot ping tints the beam + reticle with YOUR ping color
	// so the arm state is visible in-headset
	const pingTint = get(vrPingArmed)
		? get(pingColor) || peerColor(/** @type {any} */ (get(peers))?.peer?.id ?? 'me')
		: null;
	for (let i = 0; i < 2; i++) {
		const target = beamTarget(controllerRay(i));
		// 31 K2: on a panel the pointer draws after the panels (seen on the button through the
		// floor); anywhere else it depth-tests like the scene around it
		const order = target.panel ? BEAM_ORDER : 0;
		if (rayLines[i]) rayLines[i].renderOrder = order;
		if (rayReticles[i]) {
			rayReticles[i].renderOrder = order;
			rayReticles[i].children[0] && (rayReticles[i].children[0].renderOrder = order + 1);
		}
		if (rayLines[i]) {
			rayLines[i].scale.z = target.distance;
			if (pingTint) rayLines[i].material.color.set(pingTint);
			else rayLines[i].material.color.setHex(target.hit ? RAY_HOVER : RAY_IDLE);
		}
		if (rayReticles[i]) {
			rayReticles[i].visible = target.hit;
			if (pingTint) rayReticles[i].material.color.set(pingTint);
			else rayReticles[i].material.color.setHex(RAY_HOVER);
			if (target.hit) {
				const controller = renderer.xr.getController(i);
				controller.getWorldQuaternion(_reticleCtrlQuat);
				const pose = reticlePose(
					THREE,
					_reticleCtrlQuat,
					target.distance,
					hitWorldNormal(target.info)
				);
				rayReticles[i].position.copy(pose.position);
				rayReticles[i].quaternion.copy(pose.quaternion);
				rayReticles[i].scale.setScalar(pose.scale);
			}
		}
		if (i === pointerIndex) setHovered(get(vrMenuOpen) ? null : target.object);
	}
}

/** @param {number} index */
export function controllerRay(index) {
	const controller = renderer.xr.getController(index);
	tempMatrix.identity().extractRotation(controller.matrixWorld);
	raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
	raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
	return withRayCamera(raycaster);
}

/**
 * 31 (found by 31-untangle): a THREE.Sprite cannot be raycast without `raycaster.camera` —
 * three warns and Sprite.raycast THROWS on the null camera. Since the VR rays reach module
 * content (G5's beam ends, the bounded teleport's arc and wall probe), one Sprite in a module's
 * group threw inside updateVRControls every frame and aborted it before the grips ran
 * (worldGrab silently dead in Untangle's globe mode). Every VR ray carries the camera the
 * viewer sees through — the XR camera in a session, the editor camera otherwise.
 * @template T @param {T} ray @returns {T}
 */
export function withRayCamera(ray) {
	const camera = renderer?.xr?.isPresenting ? renderer.xr.getCamera() : get(globalCamera);
	if (camera) /** @type {any} */ (ray).camera = camera;
	return ray;
}

/**
 * Module content is not ours: a raycast into it must never take the VR frame down with it
 * (a mesh with a custom raycast, a Sprite before the camera exists). Returns [] on a throw.
 * @param {any} ray @param {any} root @returns {any[]}
 */
export function safeIntersect(ray, root) {
	try {
		return ray.intersectObject(root, true);
	} catch (error) {
		console.log('VR raycast into module content failed', root?.name, error);
		return [];
	}
}

/**
 * SDK (api.pointerRay): the POINTER hand's world ray for modules. Returns a
 * FRESH Raycaster — the shared module-level one above is reused per frame and
 * handing it out would corrupt in-flight raycasts (the temp-vector gotcha).
 * Resolves the hand by handedness (never raw slots). Null outside VR.
 * @returns {any | null}
 */
export function pointerHandRay() {
	if (!get(isVRMode) || !renderer?.xr) return null;
	const index = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
	if (index < 0) return null;
	const controller = renderer.xr.getController(index);
	if (!controller) return null;
	const fresh = new THREE.Raycaster();
	const m = new THREE.Matrix4().identity().extractRotation(controller.matrixWorld);
	fresh.ray.origin.setFromMatrixPosition(controller.matrixWorld);
	fresh.ray.direction.set(0, 0, -1).applyMatrix4(m);
	return withRayCamera(fresh);
}

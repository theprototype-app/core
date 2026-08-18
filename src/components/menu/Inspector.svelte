<script>
	import { Download, Save, Search, Sparkles, SquarePen, Trash2, Upload } from '@lucide/svelte';
	import Icon from '../ui/Icon.svelte';
	// Unified inspector (phase 64): one drawer serves every target — mesh, group,
	// light (from the selection) and the scene itself ($inspectorKind = 'scene').
	// Replication messages are byte-identical to the old three panels.
	import * as THREE from 'three';
	import { Checkbox, Button, Tooltip } from 'flowbite-svelte';
	import { fly } from 'svelte/transition';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import PanelHeader from '../ui/PanelHeader.svelte';
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import ColorPicker, { ChromeVariant } from 'svelte-awesome-color-picker';
	import CustomWrapper from '$lib/ColorWrapper.svelte';
	import { sineIn } from 'svelte/easing';
	import { applyExplorerImage } from '$lib/explorerDrop';
	import { explorerItems, explorerFolders, inspectedFile, itemBlob, renameItem, deleteItem, updateItemBytes } from '$lib/explorer';
	import { openTextEditor, openImagePreview } from '$lib/fileWindows';
	import {
		removeObjectTexture,
		setMaterialParam,
		switchMaterialType,
		recordMaterialChange,
		setObjectColor,
		setObjectsTexture
	} from '$lib/materialsHandler';
	import { recordEntry, beginHistoryBatch, endHistoryBatch, recordTransformSet } from '$lib/history';
	import { canEditObject } from '$lib/objectPermissions';
	import {
		attachMultiPivot,
		applyPivotTransform,
		setPivotOrigin,
		resetPivotOrigin,
		reseatPivot,
		pivotOnly,
		pivotPose
	} from '$lib/multiTransform';
	// 17-D: per-object transform ORIGIN (userData.origin, a local pivot offset)
	import { originOf, originWorld, setOriginFromWorld, resetOrigin, originPreset } from '$lib/objectOrigin';
	// the HINGE point: snap the origin to the vertices picked in Edit Mesh
	import {
		editingObject,
		vertexSelectionWorldPoint,
		vertexSelectionSize,
		enterEditMode
	} from '$lib/meshEdit';
	import { bottomInset } from '$lib/bottomDock';
	import { geometryParamsOf, applyGeometry } from '$lib/geometryEdit';
	import { nameOf } from '$lib/lockControl';
	import { geometrySpec } from '$lib/geometryParams';
	import { LIGHT_PARAMS, SHADOW_TYPES, SHADOW_SIZES, setShadowMapSize, cappedShadowSize } from '$lib/lightParams';
	import { animatedObjects, setAnimationState } from '$lib/animatedImports';
	import { captureAutoKey, playheadOf } from '$lib/animationPreview';
	import { moveObjectToGroup, selectObject, flyTo } from '$lib/objectActions';
	import { listPhysicsObjects, enablePhysicsOnSelection, setPhysicsFor, PHYSICS_MATERIALS } from '$lib/physics';
	import { sceneGravity, setSceneGravity, resetSceneGravity, DEFAULT_GRAVITY } from '$lib/scenePhysics';
	import { scenePost, sceneProvidesAo } from '$lib/scenePost';
	import { viewportOverrides, setRenderLayer, OVERRIDES } from '$lib/viewportOverrides';
	import PostStack from './PostStack.svelte';
	import { showColliders, colliderVizObjects, setColliderViz } from '$lib/colliderHelpers';
	import { enterColliderEdit } from '$lib/colliderEdit';
	import { inferredColliderKind } from '$lib/colliderSpec';
	import { addParticlesPreset, updateObjectParticles, removeObjectParticles, burstObjectParticles } from '$lib/particleActions';
	import { PARTICLE_PRESETS } from '$lib/particlePresets';
	import { flowGraphs } from '../../stores/flowStore';
	import { showLightHelpers } from '$lib/lightHelpers';
	import {
		cameraNear,
		cameraFar,
		setCameraNear,
		setCameraFar,
		orbitPrefs,
		setOrbitPrefs,
		resetOrbitPrefs
	} from '$lib/cameraClip';
	// 16-P4: named, lens-carrying camera bookmarks managed right here
	import {
		bookmarks,
		saveBookmark,
		recallBookmark,
		renameBookmark,
		overwriteBookmark,
		deleteBookmark,
		moveBookmark,
		SHORTCUT_SLOTS
	} from '$lib/cameraBookmarks';
	import { sceneRadius } from '$lib/sceneBounds';
	// 16-P5: camera OBJECTS (marker + userData.camera)
	import {
		isCameraObject,
		cameraSpec,
		setCameraFor,
		setCameraFromView,
		alignViewToCamera,
		captureThroughCamera,
		ASPECTS
	} from '$lib/cameraObjects';
	import { cameraPreview, startCameraPreview, stopCameraPreview } from '$lib/cameraPreview';
	import { showCameraFrustums } from '$lib/cameraHelpers';
	import {
		music,
		musicLocalVolume,
		musicMuted,
		musicBlocked,
		setMusicTrack,
		setMusicPlaying,
		setMusicVolume
	} from '$lib/sceneMusic';
	import {
		environment,
		ENVIRONMENT_PRESETS,
		setEnvironment,
		envPresets,
		peerEnvPresets,
		presetPayload,
		editRigComponent,
		addEnvLight,
		updateEnvLight,
		removeEnvLight,
		convertToEnvironment,
		convertFromEnvironment,
		snapshotPreset,
		saveEnvPreset,
		deleteEnvPreset,
		exportEnvPreset,
		importEnvPreset,
		applyCustomPreset,
		editEnvSky
	} from '$lib/environment';
	import {
		globalScene,
		objectsGroup,
		selectedObject,
		selectedObjects,
		backgroundColor,
		globalCamera,
		viewMode,
		showGrid
	} from '../../stores/sceneStore';
	// 16-P3: grid + snapping prefs (LOCAL, like the clip planes)
	import { gridSettings, setGrid, resetGrid, effectiveCell } from '$lib/gridSettings';
	import { snapEnabled, snapSettings, surfaceSnap, snapTargets } from '$lib/snapping';
	/** 19-B: the element snap target chips (key, label) @type {any[]} */
	const elementTargets = [
		['vertex', 'Vertex'],
		['edge', 'Edge'],
		['face', 'Face'],
		['surface', 'Surface'],
		['object', 'Object']
	];
	/** whether one element target flag is on @param {any} t @param {any} key */
	const targetOn = (t, key) => !!t[key];
	/** how many element targets are armed — the header says so, because five
	 * chips read as "some are on" long before you can tell WHICH.
	 * `$derived`, NOT `$:`: this file is RUNES mode, where a `$:` is a compile
	 * error that takes the whole panel down on mount (the documented trap — it
	 * showed up as the app never finishing boot, not as a styling problem). */
	const activeTargetCount = $derived(
		elementTargets.filter((/** @type {any} */ e) => targetOn($snapTargets, e[0])).length
	);
	/** @param {any} key */
	const toggleTarget = (key) => snapTargets.update((t) => ({ ...t, [key]: !targetOn(t, key) }));
	// 19-B P3: the transient snap anchor (picked point; local-only, never replicated)
	import {
		snapAnchor,
		snapAnchorPicking,
		startSnapAnchorPick,
		cancelSnapAnchorPick,
		clearSnapAnchor,
		saveSnapAnchorAsOrigin
	} from '$lib/snapEngine';
	import { peers, inspectorClose, inspectorKind, inspectorPinned, showToast, inspectorFilter, notesDrawerOpen } from '../../stores/appStore.js';

	// (15-L3 dropped the standalone hex textboxes under each colour picker — the
	// picker's own hex/rgb/hsv field from 15-C2 replaced them, so the validating
	// regex they needed is gone too)
	const RAD_SNAP = Math.PI / 12; // Ctrl-snap rotations to 15°

	// B3 (roadmap #13): camera lens presets. Labels use the familiar full-frame
	// focal-length vocabulary; the value set is three's VERTICAL fov in degrees
	// (vfov = 2·atan(12mm / focal)). Default camera fov is 40° (~33mm) — a natural,
	// low-distortion product-viz look, just wider than a classic 35mm.
	const LENS_PRESETS = [
		{ label: 'Wide', mm: 24, fov: 53 },
		{ label: 'Classic', mm: 35, fov: 38 },
		{ label: 'Natural', mm: 50, fov: 27 },
		{ label: 'Portrait', mm: 85, fov: 16 }
	];

	let transitionParamsRight = { x: 320, duration: 200, easing: sineIn };

	// side drawers live on the --z-drawer tier (68); chat floats on its own now.
	// bottom rises above the docked Flow/Explorer height (105) AND the Controls pill/
	// HUD footprint on narrow screens (--controls-inset) so neither covers the drawer.
	// z sits just above the bottom HUD buttons (mic/chat/+ are at --z-drawer=30) so the
	// settings drawer is never covered by the mic on the bottom-right, but stays BELOW
	// the dock (--z-bottom=35) and floating windows.
	const drawerStyle =
		'bottom: max(var(--bottom-inset, 0px), var(--controls-inset, 0px)); z-index: calc(var(--z-bottom) - 1); height: auto';

	// Round the drawer's bottom-LEFT corner when it floats ABOVE the bottom (a docked
	// Flow/Explorer, or the narrow Controls inset, leave a gap below it). When it sits
	// flush on the viewport bottom it stays square there.
	let narrowDrawer = $state(false);
	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(pointer: coarse), (max-width: 820px)');
		narrowDrawer = mq.matches;
		const on = () => (narrowDrawer = mq.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});
	const bottomRounded = $derived($bottomInset > 0 || narrowDrawer);
	// SHEET mode = the actual bottom-sheet layout (max-width:640, matching the CSS). This
	// is separate from narrowDrawer (<=820) so the 641-820 side-drawer still slides in
	// horizontally, not up.
	let sheetMode = $state(false);
	$effect(() => {
		if (typeof window === 'undefined') return;
		const mq = window.matchMedia('(max-width: 640px)');
		sheetMode = mq.matches;
		const on = () => (sheetMode = mq.matches);
		mq.addEventListener('change', on);
		return () => mq.removeEventListener('change', on);
	});
	// One bottom sheet at a time: opening the settings sheet closes scene notes.
	$effect(() => {
		if (!$inspectorClose && sheetMode) notesDrawerOpen.set(false);
	});
	// SHEET = slide UP from below; side drawer = fly in from the right (horizontal).
	const insTransition = $derived(
		sheetMode ? { y: 500, duration: 240, easing: sineIn } : transitionParamsRight
	);

	// On a narrow/folded screen this drawer is a bottom SHEET (see #inspector in ui.css)
	// with a top drag handle to adjust height — mirrors the scene-notes sheet. Persisted.
	let inspectorH = $state(0);
	$effect(() => {
		if (inspectorH || typeof window === 'undefined') return;
		const saved = parseInt(localStorage.getItem('inspectorSheetH') || '');
		inspectorH = !saved || Number.isNaN(saved) ? Math.round(window.innerHeight * 0.45) : saved;
	});
	let insResizing = $state(false);
	/** @param {PointerEvent} e */
	function insStartResize(e) {
		insResizing = true;
		/** @type {HTMLElement} */ (e.currentTarget).setPointerCapture?.(e.pointerId);
		e.preventDefault();
	}
	/** @param {PointerEvent} e */
	function insDoResize(e) {
		if (!insResizing) return;
		// sheet is bottom:0, so height = viewport height - finger y; cap the top below
		// the Connect bar + top-right chrome (same limit as the Flow/Explorer dock)
		const cb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--connect-bottom')) || 54;
		const maxH = Math.max(200, window.innerHeight - cb - 56);
		inspectorH = Math.min(Math.max(160, window.innerHeight - e.clientY), maxH);
	}
	/** @param {PointerEvent} e */
	function insEndResize(e) {
		if (!insResizing) return;
		insResizing = false;
		/** @type {HTMLElement} */ (e.currentTarget).releasePointerCapture?.(e.pointerId);
		try {
			localStorage.setItem('inspectorSheetH', String(inspectorH));
		} catch {}
	}

	// C1 (roadmap #13): scene-mode physics-objects list. Recomputes on scene/graph
	// changes AND selection updates (setPhysics only pokes selectedObject).
	// H1: depends on flowGraphs so physics nodes in ANY graph document retrigger it.
	const physicsRows = $derived.by(() => {
		$objectsGroup;
		$flowGraphs;
		$selectedObject;
		return listPhysicsObjects();
	});

	// ---- 17-D1: property writes fan over the SELECTION SET --------------------
	// Material, colour, object-flag, shadow and physics edits apply to EVERY
	// selected object; transforms and geometry params deliberately stay on the
	// primary (one shared position would collapse the set onto a point, and
	// geometry rows are per shape type). Every write still goes through the SAME
	// per-uuid entry point as before, so the wire messages are byte-identical —
	// a set of N just wraps them in ONE history batch so undo is a single step.
	// Members a viewer may not edit (objectPermissions) are skipped.
	const insTargets = $derived.by(() => {
		$objectsGroup; // in-place userData/material edits poke this store
		const uuids = $selectedObjects ?? [];
		const group = $objectsGroup;
		const list =
			uuids.length > 1 && group
				? uuids
						.map((/** @type {string} */ uuid) => group.getObjectByProperty('uuid', uuid))
						.filter(Boolean)
				: $selectedObject?.uuid
					? [$selectedObject]
					: [];
		return list.filter((/** @type {any} */ object) => canEditObject(object));
	});
	/** 0 when a single object is being edited, else the number of targets */
	const multiCount = $derived(insTargets.length > 1 ? insTargets.length : 0);
	/** targets that actually carry a single (non-array) material */
	const matTargets = $derived(
		insTargets.filter((/** @type {any} */ o) => o?.material && !Array.isArray(o.material))
	);
	const matCount = $derived(matTargets.length > 1 ? matTargets.length : 0);

	/** Run a per-object write across `list`; N>1 collapses into ONE undo entry.
	 * @param {any[]} list @param {string} label @param {(object:any)=>void} fn */
	function fanOn(list, label, fn) {
		if (!list.length) return;
		if (list.length === 1) {
			fn(list[0]); // single-object undo + replication unchanged
			autoKeyAfterEdit(list);
			return;
		}
		beginHistoryBatch();
		try {
			for (const object of list) fn(object);
		} finally {
			endHistoryBatch(`${label} (${list.length})`);
		}
		autoKeyAfterEdit(list);
	}

	/**
	 * 17-E: with auto-key armed, an edit made HERE keys the channel it changed, the
	 * same as posing the object with the gizmo — typing a position, picking a colour
	 * or dragging opacity all become keys instead of being lost. `captureAutoKey`
	 * checks the arming itself, so this is a no-op for every other object.
	 * @param {any[]} list
	 */
	function autoKeyAfterEdit(list) {
		for (const object of list ?? []) {
			if (object?.uuid) captureAutoKey(object.uuid, playheadOf(object.uuid));
		}
	}
	/** @param {string} label @param {(object:any)=>void} fn */
	function fan(label, fn) {
		fanOn(insTargets, label, fn);
	}
	/** material-only fan (skips lights/groups in the set) @param {string} label @param {(object:any)=>void} fn */
	function fanMat(label, fn) {
		fanOn(matTargets, label, fn);
	}

	/** true when the selection disagrees on a value → the row renders a dash.
	 * @param {(object:any)=>any} read @param {any[]} [list] */
	function mixed(read, list) {
		const targets = list ?? insTargets;
		if (targets.length < 2) return false;
		const first = read(targets[0]);
		return targets.some((object) => read(object) !== first);
	}
	/** @param {(object:any)=>any} read */
	const matMixed = (read) => mixed(read, matTargets);

	// ---- 17-D: the single object's own ORIGIN -------------------------------
	// Shown in WORLD space (where the pivot sits), stored as a local offset. A
	// light has no geometry and its position IS its origin, so it is excluded.
	const originTarget = $derived(!isLight && !multiCount && $selectedObject?.uuid ? $selectedObject : null);
	const originPos = $derived.by(() => {
		$objectsGroup;
		$selectedObject;
		$pivotPose; // a gizmo drag in origin mode moves it live
		return originTarget ? originWorld(originTarget).toArray() : [0, 0, 0];
	});
	const originSet = $derived.by(() => {
		$objectsGroup;
		return !!(originTarget && originOf(originTarget));
	});

	/** @param {'x'|'y'|'z'} axis @param {number} next */
	function setOriginAxis(axis, next) {
		if (!originTarget) return;
		const world = originPos.slice();
		world['xyz'.indexOf(axis)] = next;
		setOriginFromWorld(originTarget.uuid, new THREE.Vector3().fromArray(world));
		reseatPivot(); // the gizmo follows the origin it now has
		selectedObject.update((v) => v);
	}

	/** @param {'bottom'|'center'|'median'|'world'|'children'} kind */
	function applyOriginPreset(kind) {
		if (!originTarget) return;
		originPreset(originTarget.uuid, kind);
		reseatPivot();
		selectedObject.update((v) => v);
	}

	function clearOrigin() {
		if (!originTarget) return;
		resetOrigin(originTarget.uuid);
		pivotOnly.set(false);
		reseatPivot();
		selectedObject.update((v) => v);
	}

	/**
	 * The HINGE workflow, driven from HERE rather than expecting the user to know
	 * the Edit Mesh dance: "Pick from mesh…" enters vertex editing on this object,
	 * then "Set origin here" drops the origin on whatever is picked (one vertex, or
	 * the centroid of several — two verts of an edge IS the hinge case). Spin and a
	 * revolute joint then both turn about that point.
	 *
	 * The button stays visible for the whole edit session instead of gating on the
	 * selection count: a plain click selects a handle WITHOUT adding it to the
	 * multi-selection set, so a size-only gate hid the button while a vertex was
	 * visibly selected. It toasts when there is genuinely nothing picked.
	 */
	const editingThis = $derived(!!originTarget && $editingObject === originTarget.uuid);
	function pickOriginFromMesh() {
		if (!originTarget) return;
		enterEditMode(originTarget.uuid);
		showToast('Click a vertex (ctrl-click for several, e.g. both ends of a hinge edge), then press Set origin here');
	}
	function originFromSelection() {
		if (!originTarget) return;
		const point = vertexSelectionWorldPoint();
		if (!point) {
			showToast('Click a vertex first — ctrl-click both ends of an edge to hinge on it');
			return;
		}
		setOriginFromWorld(originTarget.uuid, point);
		reseatPivot();
		selectedObject.update((v) => v);
		showToast('Origin set from the mesh — Spin and hinges now turn about it');
	}

	const isLight = $derived($selectedObject?.type?.endsWith?.('Light') ?? false);
	const isGroup = $derived($selectedObject?.type === 'Group');
	// live geometry params (78): registry-driven rows; geoTick refreshes after edits
	let geoTick = $state(0);
	const geoParams = $derived.by(() => {
		geoTick;
		return !isLight && !isGroup && $selectedObject ? geometryParamsOf($selectedObject) : null;
	});
	const geoSpec = $derived(geoParams ? geometrySpec(geoParams.gtype) : null);

	// 17-D1 follow-up: geometry rows fan too, but ONLY across one primitive type —
	// a Box's params mean nothing to a Sphere. Members whose mesh was edited are
	// left out: rebuilding their primitive would discard those edits.
	const geoTargets = $derived.by(() => {
		$objectsGroup;
		geoTick;
		if (!geoParams) return [];
		return insTargets.filter((/** @type {any} */ object) => {
			if (object.userData?.vertexEdited || object.userData?.faceEdited) return false;
			return geometryParamsOf(object)?.gtype === geoParams.gtype;
		});
	});
	/** shapes in the selection that the geometry rows cannot touch */
	const geoOtherTypes = $derived.by(() => {
		$objectsGroup;
		if (!geoParams || insTargets.length < 2) return [];
		const others = insTargets
			.filter((/** @type {any} */ object) => !geoTargets.includes(object))
			.map((/** @type {any} */ object) => geometryParamsOf(object)?.gtype ?? object.type);
		return [...new Set(others)];
	});

	/** do the same-type members disagree on one geometry param?
	 * @param {string} key @param {any} fallback */
	function geoMixed(key, fallback) {
		if (geoTargets.length < 2) return false;
		const read = (/** @type {any} */ object) =>
			geometryParamsOf(object)?.params?.[key] ?? fallback;
		const first = read(geoTargets[0]);
		return geoTargets.some((object) => read(object) !== first);
	}

	/** @param {string} key @param {any} value */
	function editGeometry(key, value) {
		const run = () => {
			fanOn(geoTargets.length ? geoTargets : [$selectedObject], 'Geometry', (object) =>
				applyGeometry(object.uuid, { [key]: value })
			);
			geoTick++;
		};
		if ($selectedObject.userData?.vertexEdited) {
			showToast('This mesh has vertex edits — rebuilding the geometry discards them.', [
				{ label: 'Rebuild', action: run },
				{ label: 'Keep edits', action: () => geoTick++ }
			]);
			return;
		}
		run();
	}
	/**
	 * 15-O1: a SNAPSHOT of the selected material, not the material itself.
	 * `setMaterialParam` mutates the material IN PLACE and pokes `objectsGroup`
	 * (never `selectedObject`), and `$derived` compares with `===` — so a derived
	 * returning the same THREE material never propagated and the
	 * Roughness/Metalness/Opacity readouts kept showing the pre-drag value (the
	 * material itself did change; only the UI lagged). A fresh object per poke
	 * fixes every row at once. Object-valued fields keep their live refs, so
	 * `material.color.getHexString()` etc. still work.
	 * NOTE: a new material property rendered below must be added here too.
	 */
	const material = $derived.by(() => {
		$objectsGroup; // in-place material edits poke this store
		const m =
			!isLight && !isGroup && $selectedObject?.material && !Array.isArray($selectedObject.material)
				? $selectedObject.material
				: null;
		if (!m) return null;
		return {
			ref: m,
			type: m.type,
			color: m.color,
			map: m.map,
			userData: m.userData,
			roughness: m.roughness,
			metalness: m.metalness,
			clearcoat: m.clearcoat,
			clearcoatRoughness: m.clearcoatRoughness,
			transmission: m.transmission,
			ior: m.ior,
			shininess: m.shininess,
			opacity: m.opacity,
			wireframe: m.wireframe,
			flatShading: m.flatShading,
			side: m.side,
			emissive: m.emissive,
			emissiveIntensity: m.emissiveIntensity
		};
	});

	let materials = [
		{ value: 'MeshBasicMaterial', name: 'Basic' },
		{ value: 'MeshStandardMaterial', name: 'Standard' },
		{ value: 'MeshPhysicalMaterial', name: 'Physical' },
		{ value: 'MeshPhongMaterial', name: 'Phong' },
		{ value: 'MeshLambertMaterial', name: 'Lambert' },
		{ value: 'MeshToonMaterial', name: 'Toon' },
		{ value: 'MeshMatcapMaterial', name: 'Matcap' },
		{ value: 'MeshNormalMaterial', name: 'Normal' },
		{ value: 'MeshDepthMaterial', name: 'Depth' },
		{ value: 'ShadowMaterial', name: 'Shadow' }
	];

	// Explorer image hovering the texture drop zone (96)
	let textureDropActive = $state(false);

	// Explorer file properties (107)
	const inspectedItem = $derived(
		$inspectorKind === 'file' ? $explorerItems.find((item) => item.id === $inspectedFile) ?? null : null
	);
	const fileFolderPath = $derived.by(() => {
		if (!inspectedItem) return '';
		const parts = [];
		let parent = inspectedItem.folderId ?? null;
		while (parent) {
			const folder = $explorerFolders.find((f) => f.id === parent);
			if (!folder) break;
			parts.unshift(folder.name);
			parent = folder.parentId ?? null;
		}
		return 'Library' + (parts.length ? ' / ' + parts.join(' / ') : '');
	});
	let fileDetails = $state('');
	$effect(() => {
		const item = inspectedItem;
		fileDetails = '';
		if (!item) return;
		itemBlob(item.id).then(async (blob) => {
			if (!blob || inspectedItem?.id !== item.id) return;
			try {
				if (item.kind === 'image') {
					const bitmap = await createImageBitmap(blob);
					fileDetails = bitmap.width + ' × ' + bitmap.height + ' px';
				} else if (item.kind === 'text') {
					fileDetails = (await blob.text()).split('\n').length + ' lines';
				} else if (item.kind === 'audio') {
					const ctx = new AudioContext();
					const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
					fileDetails = decoded.duration.toFixed(2) + ' s · ' + decoded.numberOfChannels + ' ch';
					ctx.close();
				}
			} catch {}
		});
	});
	async function openInspectedItem() {
		const item = inspectedItem;
		if (!item) return;
		const blob = await itemBlob(item.id);
		if (!blob) return;
		if (item.kind === 'text')
			openTextEditor({ title: item.name, code: await blob.text(), onSave: (code) => updateItemBytes(item.id, code) });
		else if (item.kind === 'image') openImagePreview({ title: item.name, url: URL.createObjectURL(blob) });
	}

	// color swatches mirror the target when the selection changes
	/** @type {any} */
	let color = $state('#ffffff');
	/** @type {any} */
	let groundColor = $state('#ffffff');
	$effect(() => {
		const obj = $selectedObject;
		if (!obj) return;
		if (obj.material?.color && !Array.isArray(obj.material))
			color = '#' + obj.material.color.getHexString();
		else if (obj.color?.getHexString) color = '#' + obj.color.getHexString();
		if (obj.groundColor?.getHexString) groundColor = '#' + obj.groundColor.getHexString();
	});

	/**
	 * 15-C follow-up: svelte-awesome-color-picker v4 calls `onInput` ONCE just from
	 * MOUNTING (its updateColor() runs out of an `$effect`, and the first pass always
	 * "changes" from its empty snapshot). A picker that merely appeared must not read
	 * as a user edit — that echo made opening Configure Scene write the environment
	 * and DETACH the preset to custom (the reported "add a box, open configure scene,
	 * the box goes light"), and made selecting a light or a mesh broadcast a colour
	 * update plus record an undo entry.
	 *
	 * So every onInput handler ignores a value equal to the one it already holds.
	 * The comparison is normalized because the picker round-trips through colord:
	 * case, a leading #, and a trailing alpha pair can all differ from THREE's
	 * getHexString.
	 * @param {any} a @param {any} b
	 */
	function sameHex(a, b) {
		/** @param {any} v */
		const norm = (v) =>
			typeof v === 'string' ? v.trim().toLowerCase().replace(/^#/, '').slice(0, 6) : '';
		const left = norm(a);
		return !!left && left === norm(b);
	}

	// one undo entry per color-drag gesture: remember where it started,
	// record 600ms after the last input. 17-D1: with a multi-selection the
	// gesture remembers EVERY target's own starting colour (they may differ) and
	// seals them into one batch, so undo restores each object's original.
	/** @type {Map<string,string>|null} */
	let colorGestureStart = null;
	/** @type {any} */
	let colorGestureTimer;
	/** @param {any} hex */
	function trackColorGesture(hex) {
		if (colorGestureStart == null) {
			colorGestureStart = new Map();
			for (const object of matTargets)
				colorGestureStart.set(object.uuid, '#' + object.material.color.getHexString());
		}
		clearTimeout(colorGestureTimer);
		colorGestureTimer = setTimeout(() => {
			const befores = colorGestureStart;
			colorGestureStart = null;
			if (!befores?.size) return;
			if (befores.size === 1) {
				const [uuid, before] = [...befores][0];
				recordMaterialChange(uuid, 'color', null, before, hex);
				return;
			}
			beginHistoryBatch();
			try {
				for (const [uuid, before] of befores)
					recordMaterialChange(uuid, 'color', null, before, hex);
			} finally {
				endHistoryBatch(`Colour (${befores.size})`);
			}
		}, 600);
		// (auto-key for this picker is NOT wired here: the debounced commit above calls
		// recordMaterialChange, and materialsHandler keys off that single funnel — so
		// every material edit, present or future, behaves the same way.)
	}

	// ---- replication (identical messages to the retired panels) -------------
	/** @param {any} object */
	function sendMove(object) {
		if (!object?.uuid) return;
		$peers.send({
			type: 'move',
			uuid: object.uuid,
			pos: object.position.toArray(),
			rot: object.rotation.toArray(),
			scale: object.scale.toArray()
		});
	}

	/** @param {any} object */
	const poseOf = (object) => ({
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray()
	});

	// ONE undo entry per transform GESTURE (a scrub fires on every pixel), sealed
	// 500ms after the last change through the existing `transformSet` kind — the
	// same one a multi-gizmo drag records, so replay + replication come free.
	// Typed transforms recorded nothing at all before; with a selection they must,
	// because setting an absolute value collapses the whole set onto one plane.
	/** @type {Map<string, any>|null} */
	let xformGestureStart = null;
	/** @type {any} */
	let xformGestureTimer;
	function trackTransformGesture() {
		if (xformGestureStart == null) {
			xformGestureStart = new Map();
			for (const object of insTargets) xformGestureStart.set(object.uuid, poseOf(object));
		}
		clearTimeout(xformGestureTimer);
		xformGestureTimer = setTimeout(() => {
			const keepOrigin = true; // a hand-placed origin survives the re-seat
			const befores = xformGestureStart;
			xformGestureStart = null;
			if (!befores?.size) return;
			/** @type {any[]} */
			const items = [];
			for (const [uuid, before] of befores) {
				const object = $objectsGroup?.getObjectByProperty('uuid', uuid);
				if (!object) continue;
				const after = poseOf(object);
				/** @param {number[]} a @param {number[]} b */
				const same = (a, b) => a.every((n, i) => n === b[i]);
				const still =
					same(before.pos, after.pos) &&
					same(before.rot, after.rot) &&
					same(before.scale, after.scale);
				if (!still) items.push({ uuid, before, after });
			}
			recordTransformSet(items);
			// the pivot's rotation/scale are per-gesture handles: re-seat so the next
			// gesture starts from a fresh frame (and the gizmo tracks the new poses)
			if (items.length > 1)
				attachMultiPivot(
					items.map((item) => item.uuid),
					keepOrigin
				);
		}, 500);
	}

	/**
	 * A multi-selection's Transform rows drive the selection's ORIGIN (the same
	 * pivot the gizmo uses), not each object's own numbers. That is what makes
	 * them show one value per axis instead of a dash, and it means a typed value
	 * MOVES the set rigidly instead of collapsing every member onto one plane.
	 * In "Move origin" mode the rows re-point the origin and leave objects alone.
	 * A single selection keeps writing its own absolute values.
	 * @param {'position'|'rotation'|'scale'} field @param {'x'|'y'|'z'} axis @param {number} next
	 */
	function setTransform(field, axis, next) {
		if (multiCount) {
			if ($pivotOnly) {
				// origin only: local editing aid, nothing to replicate or undo
				if (field !== 'position') return;
				const pos = ($pivotPose?.pos ?? [0, 0, 0]).slice();
				pos['xyz'.indexOf(axis)] = next;
				setPivotOrigin(pos);
				return;
			}
			trackTransformGesture();
			applyPivotTransform((pivot) => {
				pivot[field][axis] = next;
			});
			selectedObject.update((v) => v);
			return;
		}
		trackTransformGesture(); // capture the BEFORE pose before we write
		$selectedObject[field][axis] = next;
		sendMove($selectedObject);
		selectedObject.update((v) => v); // refresh rows + object list
		autoKeyAfterEdit([$selectedObject]); // a typed transform keys too (17-E)
	}

	/** lights resend their whole object — same as the old light panel */
	function sendLightUpdate() {
		$peers.send({ type: 'object', element: $selectedObject.toJSON(), override: true });
	}

	/** Object flag → the whole selection. The checkbox/row has already written the
	 * PRIMARY (bind:checked), so the rest of the set is set to that same value and
	 * every member replicates its own message. No history kind covers these flags,
	 * so the batch stays empty and records nothing (endHistoryBatch no-ops).
	 * @param {string} parameter */
	function sendParam(parameter) {
		const value = $selectedObject[parameter];
		fan(parameter, (object) => {
			if (object !== $selectedObject) object[parameter] = value;
			$peers.send({
				type: 'objectParameters',
				parameter,
				uuid: object.uuid,
				[parameter]: object[parameter]
			});
		});
	}

	// Cast toggle also stamps userData.shadow so the opt-out survives GLTF sync
	// (the bare castShadow flag does not round-trip through GLTFExporter) — V-1
	function setCastShadow() {
		const on = $selectedObject.castShadow;
		fan('Cast shadow', (object) => {
			object.castShadow = on;
			object.userData.shadow = on ? undefined : false;
		});
		sendParam('castShadow');
	}

	// P-A: physics body params live on userData.physics (replicates free via
	// object sync / GLTF extras / sessions); flow nodes override at sim start.
	// Each edit replicates via objectParameters and records a props undo entry.
	// PFX-A: particle emitter config lives on userData.particles (replicates
	// free via object sync / GLTF extras / sessions); particleActions records
	// the props undo entry and replicates each edit via objectParameters.
	/** @param {any} patch */
	function setParticles(patch) {
		fan('Particles', (object) => updateObjectParticles(object.uuid, patch));
	}

	/** @param {any} patch */
	function setPhysics(patch) {
		// shared write path — replicates, records props undo, pokes the collider
		// viz and live-rebuilds mid-sim colliders (CL-A A2) for EVERY caller
		fan('Physics', (object) => setPhysicsFor(object.uuid, patch));
		selectedObject.update((v) => v);
	}

	/** Material parameter → the whole selection (17-D1)
	 * @param {string} key @param {any} value */
	function setMat(key, value) {
		fanMat(key, (object) => setMaterialParam(object.uuid, key, value));
	}

	/**
	 * Textures fan too. The writers are async (read the file, downscale, then
	 * record + replicate), so the batch is opened here and closed after ALL of
	 * them settle — one undo puts every material's previous map back.
	 * @param {(uuid: string) => Promise<any>} apply
	 * @param {string} label
	 */
	async function fanTexture(apply, label) {
		const targets = matTargets;
		if (!targets.length) return;
		if (targets.length === 1) {
			await apply(targets[0].uuid);
		} else {
			beginHistoryBatch();
			try {
				for (const object of targets) await apply(object.uuid);
			} finally {
				endHistoryBatch(`${label} (${targets.length})`);
			}
		}
		selectedObject.update((s) => s);
		objectsGroup.update((v) => v);
	}

	/** A picked image file → every selected material, decoded once. @param {File} file */
	async function setTextureFromFile(file) {
		const uuids = matTargets.map((/** @type {any} */ object) => object.uuid);
		if (!uuids.length) return;
		if (uuids.length > 1) beginHistoryBatch();
		try {
			await setObjectsTexture(uuids, file);
		} finally {
			if (uuids.length > 1) endHistoryBatch(`Texture (${uuids.length})`);
		}
		selectedObject.update((s) => s);
		objectsGroup.update((v) => v);
	}

	/** CL-A A4: which material preset matches the current values (else 'custom') @param {any} p */
	function physicsMaterialOf(p) {
		const r = p?.restitution ?? 0.3;
		const f = p?.friction ?? 0.5;
		const hit = Object.entries(PHYSICS_MATERIALS).find(
			([, m]) => Math.abs(m.restitution - r) < 0.001 && Math.abs(m.friction - f) < 0.001
		);
		return hit ? hit[0] : 'custom';
	}

	/** CL-A A5: toggle one freeze-axis flag @param {string} key @param {boolean} on */
	function setFreeze(key, on) {
		const freeze = { ...($selectedObject.userData.physics?.freeze ?? {}) };
		if (on) freeze[key] = true;
		else delete freeze[key];
		setPhysics({ freeze: Object.keys(freeze).length ? freeze : null });
	}

	function sendName() {
		objectsGroup.update((value) => value); // refresh the object list
		$peers.send({ type: 'name', name: $selectedObject.name, uuid: $selectedObject.uuid });
	}

	/** Object-level property (renderOrder/frustumCulled): local apply + replicate (147) @param {string} parameter @param {any} value */
	function setObjectParam(parameter, value) {
		$selectedObject[parameter] = value;
		selectedObject.update((v) => v);
		sendParam(parameter); // fans the value + messages over the selection
	}

	// ---- move to group (shared by mesh and light targets) -------------------
	let groups = $state([{ value: 'none', name: 'None' }]);
	let rerenderSelectGroup = $state(false);
	function refreshGroups() {
		groups = $selectedObject.parent.children
			.map((/** @type {any} */ item) =>
				item.type === 'Group' ? { name: item.name, value: item.uuid } : null
			)
			.filter(Boolean);
		if ($selectedObject.parent.parent.parent !== null)
			groups.push({ name: 'Level Up', value: $selectedObject.parent.parent.uuid });
		groups = groups.filter((/** @type {any} */ item) => item.value !== $selectedObject.uuid);
	}

	/** total objects in a subtree (group summary) @param {any} obj @returns {number} */
	function countTree(obj) {
		return obj.children.reduce(
			(/** @type {number} */ sum, /** @type {any} */ child) => sum + 1 + countTree(child),
			0
		);
	}

	// ---- scene target (fog state is local, like the old scene panel) --------
	// fogColor is INITIALIZED: svelte 5.56 hard-errors on `bind:hex={undefined}`
	// when the prop has a fallback (props_invalid_value) — undefined here
	// CRASHED the whole scene drawer (pre-existing on release/1.1, deps bump).
	// 15-C: the pickers pass `hex` ONE-WAY now (color-picker v4 writes its own
	// snapshot back through a binding and clobbers external writes — an env
	// preset or a selection change); `onInput` is the input channel.
	/** @type {any} */
	let fogColor = $state('#ffffff');
	/** @type {any} */
	let fogNear = $state(0);
	/** @type {any} */
	let fogFar = $state(50);

	// ---- environment v2 (70) -------------------------------------------------
	const envPayload = $derived(presetPayload($environment));
	const selectedIsSceneLight = $derived(
		!!$selectedObject?.isLight &&
			!!$objectsGroup?.getObjectByProperty?.('uuid', $selectedObject.uuid)
	);

	function savePresetPrompt() {
		const name = prompt('Preset name', $environment.customPreset?.label ?? 'My preset');
		if (name) saveEnvPreset(name);
	}
	function exportCurrentPreset() {
		const payload = snapshotPreset($environment.customPreset?.label ?? envPayload.label ?? 'environment');
		const blob = new Blob([exportEnvPreset(payload)], { type: 'application/json' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = String(payload.label).replace(/[^\w-]+/g, '_') + '.envpreset.json';
		link.click();
		URL.revokeObjectURL(link.href);
	}
	/** @param {any} event */
	async function onImportPreset(event) {
		const file = event.target.files?.[0];
		if (!file) return;
		try {
			await importEnvPreset(await file.text());
		} catch {
			showToast('That file is not an environment preset');
		}
		event.target.value = '';
	}
	// 15-C: sky edits go through the ENVIRONMENT (editEnvSky detaches a live
	// custom preset). Writing scene.background / scene.fog directly was undone
	// by the next applyEnvironment() — the reason "changing the background did
	// nothing" survived even after the picker's dead handler was fixed. The env
	// commit also persists + replicates ({type:'environment'}), so peers and a
	// reload keep the color.
	/** @param {string} hex */
	function setBackground(hex) {
		if (sameHex(hex, $backgroundColor)) return; // mount echo, not an edit
		backgroundColor.set(hex);
		editEnvSky({ background: hex });
	}
	function applyFog() {
		editEnvSky(
			fogNear === null || fogFar === null
				? { fog: null }
				: { fog: { color: fogColor ?? '#ffffff', near: fogNear, far: fogFar } }
		);
	}

	// 16-P4: framing helpers for the Camera section. Both reuse the existing flyTo
	// tween (so they're cancellable and consistent with Focus camera).
	function frameScene() {
		// pull back along the current view direction far enough to see everything
		const radius = Math.max(sceneRadius(), 2);
		/** @type {any} */
		const camera = $globalCamera;
		const fov = ((camera?.fov ?? 40) * Math.PI) / 180;
		const distance = (radius / Math.sin(fov / 2)) * 1.1;
		const direction = camera
			? new THREE.Vector3().subVectors(camera.position, new THREE.Vector3(0, 0, 0)).normalize()
			: new THREE.Vector3(-1, 1, 1).normalize();
		if (!direction.lengthSq()) direction.set(-1, 1, 1).normalize();
		flyTo(direction.multiplyScalar(distance).toArray(), [0, 0, 0]);
	}
	/** shared look for the small bookmark row buttons */
	const bmBtn = 'shrink-0 rounded-sm bg-gray-700 px-1.5 py-0.5 text-xs text-gray-300 hover:bg-gray-600 disabled:opacity-40';
	function resetView() {
		// the editor camera's mount defaults (Scene.svelte)
		flyTo([-10, 10, 10], [0, 1.5, 0]);
	}
</script>

<!-- flowbite-svelte 1.x turned Drawer into a native <dialog> (focus-stealing, modal
     semantics) — this persistent tool panel is a plain div reproducing the v0 drawer
     chrome (fixed inset-e-0 top-16 w-80 + fly) exactly. -->
{#if !$inspectorClose}
<div
	style={drawerStyle + '; --inspector-h: ' + inspectorH + 'px'}
	transition:fly={insTransition}
	class={'fixed inset-e-0 top-16 z-50 w-80 overflow-y-auto bg-white p-4 dark:bg-gray-800 rounded-tl-lg pt-0' + (bottomRounded ? ' rounded-bl-lg' : '')}
	id="inspector"
>
	<!-- bottom-sheet drag handle (shown only in the narrow bottom-sheet layout) -->
	<div
		class="ins-resize"
		title="Drag to resize"
		onpointerdown={insStartResize}
		onpointermove={insDoResize}
		onpointerup={insEndResize}
	>
		<span class="ins-grabber"></span>
	</div>
	{#if $inspectorKind === 'file'}
		<!-- Explorer file properties (107) -->
		<div id="drawer-label" class="sticky top-0 z-10 -mx-4 rounded-tl-lg bg-gray-800 px-4">
			<PanelHeader title={inspectedItem?.name ?? 'File'} badge="File" onclose={() => inspectorClose.set(true)} />
		</div>
		{#if inspectedItem}
			<div id="file-properties" class="flex flex-col gap-3">
				<div class="flex justify-center">
					{#if inspectedItem.thumbnail}
						<img src={inspectedItem.thumbnail} alt={inspectedItem.name} class="h-24 w-24 rounded-sm border border-gray-600 object-cover" />
					{:else}
						<span class="flex h-24 w-24 items-center justify-center rounded-sm border border-gray-600 bg-gray-700 text-4xl text-gray-400">
							<Icon name={inspectedItem.kind === 'audio' ? 'music' : inspectedItem.kind === 'text' ? 'file-text' : 'package'} size={36} class={inspectedItem.kind === 'audio' ? 'ico-audio' : inspectedItem.kind === 'text' ? 'ico-doc' : ''} />
						</span>
					{/if}
				</div>
				<Section label="File">
					<div class="ui-row">
						<span class="w-16 text-gray-400">Name</span>
						<input
							id="file-name"
							class="ui-input flex-1"
							value={inspectedItem.name}
							onchange={(e) => renameItem(inspectedItem.id, e.currentTarget.value)}
						/>
					</div>
					<div class="ui-row"><span class="w-16 text-gray-400">Kind</span><span class="ui-badge-type">{inspectedItem.kind}</span></div>
					<div class="ui-row"><span class="w-16 text-gray-400">Size</span><span>{(inspectedItem.size / 1024).toFixed(1)} KB</span></div>
					<div class="ui-row"><span class="w-16 text-gray-400">Folder</span><span class="truncate">{fileFolderPath}</span></div>
					<div class="ui-row"><span class="w-16 text-gray-400">Added</span><span>{new Date(inspectedItem.createdAt).toLocaleString()}</span></div>
					<div class="ui-row">
						<span class="w-16 text-gray-400">Hash</span>
						<span class="truncate font-mono text-[10px]" title={inspectedItem.hash}>{inspectedItem.hash.slice(0, 16)}…</span>
						<button class="ui-button-quiet" title="Copy the full hash" onclick={() => navigator.clipboard?.writeText(inspectedItem.hash)}>⧉</button>
					</div>
					{#if fileDetails}
						<div class="ui-row"><span class="w-16 text-gray-400">Details</span><span>{fileDetails}</span></div>
					{/if}
				</Section>
				<Section label="Actions">
					<div class="flex flex-wrap gap-2">
						{#if inspectedItem.kind === 'text' || inspectedItem.kind === 'image'}
							<Button size="xs" color="alternative" onclick={() => openInspectedItem()}>
								{#if inspectedItem.kind === 'text'}<SquarePen size={14} class="mr-1" aria-hidden="true" />{:else}<Search size={14} class="mr-1" aria-hidden="true" />{/if}{inspectedItem.kind === 'text' ? 'Edit' : 'Preview'}
							</Button>
						{/if}
						<Button
							size="xs"
							color="alternative"
							onclick={() => {
								deleteItem(inspectedItem.id);
								inspectorClose.set(true);
							}}><Trash2 size={16} class="ico-danger mr-1" aria-hidden="true" />Delete</Button
						>
					</div>
				</Section>
			</div>
		{:else}
			<p class="p-3 text-sm italic text-gray-400">The file was removed.</p>
		{/if}
	{:else if $inspectorKind === 'scene'}
		<div id="drawer-label" class="sticky top-0 z-10 -mx-4 rounded-tl-lg bg-gray-800 px-4">
			<PanelHeader
				title="Scene"
				badge="Scene"
				pinned={$inspectorPinned}
				onpin={() => inspectorPinned.update((v) => !v)}
				onclose={() => inspectorClose.set(true)}
			/>
			<!-- PFX-C follow-up: property search — Sections filter by rendered text -->
			<input
				id="inspector-search"
				type="search"
				class="ui-input mb-2 w-full"
				placeholder="Filter properties…"
				value={$inspectorFilter}
				oninput={(/** @type {any} */ e) => inspectorFilter.set(e.currentTarget.value)}
				onkeydown={(/** @type {any} */ e) => e.key === 'Escape' && inspectorFilter.set('')}
			/>
		</div>

		<div class="flex flex-col gap-3">
			<Section label="Environment">
				<div id="environment-presets" class="flex flex-wrap gap-1">
					{#each Object.entries(ENVIRONMENT_PRESETS) as [key, preset]}
						<button
							class={'ui-chip ' +
								($environment.preset === key
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							onclick={() => setEnvironment(key)}
						>
							{preset.label}
						</button>
					{/each}
					{#if $environment.customPreset}
						<button
							class={'ui-chip ' +
								($environment.preset === 'custom'
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							onclick={() => applyCustomPreset($environment.customPreset)}
						>
							{$environment.customPreset.label ?? 'Custom'}
						</button>
					{/if}
				</div>
				<SliderRow
					label="Exposure"
					min={0.4}
					max={2}
					step={0.05}
					value={$environment.exposure}
					onchange={(v) => setEnvironment($environment.preset, v)}
				/>

				{#if $envPresets.length}
					<p class="ui-section-label">Saved presets</p>
					<div class="flex flex-wrap gap-1">
						{#each $envPresets as saved (saved.name)}
							<span class="inline-flex items-center overflow-hidden rounded-full bg-gray-600">
								<button
									class="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-200 hover:bg-gray-500"
									title="Apply this preset (replicates to peers)"
									onclick={() => applyCustomPreset(saved.payload)}
								>
									{saved.name}
								</button>
								<button
									class="px-1 text-[10px] text-gray-300 hover:bg-red-700 hover:text-white"
									title="Delete saved preset"
									onclick={() => deleteEnvPreset(saved.name)}>✕</button>
							</span>
						{/each}
					</div>
				{/if}
				{#each Object.entries($peerEnvPresets).filter(([, list]) => list.length) as [peerId, list] (peerId)}
					<p class="ui-section-label">{nameOf(peerId)}'s presets</p>
					<div class="flex flex-wrap gap-1">
						{#each list as saved (saved.name)}
							<button
								class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
								title="Apply this peer preset (replicates to everyone)"
								onclick={() => applyCustomPreset(saved.payload)}
							>
								{saved.name}
							</button>
						{/each}
					</div>
				{/each}
				<div class="flex flex-wrap gap-1">
					<button id="env-save-preset" class="ui-button-quiet" title="Save the current environment as a named preset" onclick={savePresetPrompt}>
						<Save size={16} class="mr-1" aria-hidden="true" />Save preset
					</button>
					<button class="ui-button-quiet" title="Download the current environment as JSON" onclick={exportCurrentPreset}><Download size={16} class="mr-1" aria-hidden="true" />Export</button>
					<button class="ui-button-quiet" title="Import a .envpreset.json file" onclick={() => document.getElementById('env-import-file')?.click()}>
						<Upload size={16} class="mr-1" aria-hidden="true" />Import
					</button>
					<input type="file" id="env-import-file" style="display: none" accept=".json" onchange={onImportPreset} />
				</div>

				<p class="ui-section-label">Components</p>
				{#if envPayload.hemi}
					<SliderRow label="Sky light" min={0} max={4} step={0.05} value={envPayload.hemi.intensity}
						onchange={(v) => editRigComponent('hemi', { intensity: v })} />
					<div class="ui-row">
						<span class="w-20 shrink-0 text-xs text-gray-400">Sky / ground</span>
						<input type="color" class="h-6 w-8 cursor-pointer rounded-sm border border-gray-600 bg-transparent" value={envPayload.hemi.sky}
							onchange={(e) => editRigComponent('hemi', { sky: e.currentTarget.value })} />
						<input type="color" class="h-6 w-8 cursor-pointer rounded-sm border border-gray-600 bg-transparent" value={envPayload.hemi.ground}
							onchange={(e) => editRigComponent('hemi', { ground: e.currentTarget.value })} />
					</div>
				{/if}
				{#if envPayload.sun}
					<SliderRow label="Sun" min={0} max={4} step={0.05} value={envPayload.sun.intensity}
						onchange={(v) => editRigComponent('sun', { intensity: v })} />
					<div class="ui-row">
						<span class="w-20 shrink-0 text-xs text-gray-400">Sun color</span>
						<input type="color" class="h-6 w-8 cursor-pointer rounded-sm border border-gray-600 bg-transparent" value={envPayload.sun.color}
							onchange={(e) => editRigComponent('sun', { color: e.currentTarget.value })} />
					</div>
				{/if}

				{#each $environment.lights ?? [] as def (def.id)}
					<div class="env-light rounded-lg border border-gray-700/60 p-1.5">
						<div class="flex items-center gap-1.5">
							<span class="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{def.kind}</span>
							<input type="color" class="h-5 w-7 cursor-pointer rounded-sm border border-gray-600 bg-transparent" value={def.color}
								onchange={(e) => updateEnvLight(def.id, { color: e.currentTarget.value })} />
							{#if def.kind === 'hemisphere'}
								<input type="color" class="h-5 w-7 cursor-pointer rounded-sm border border-gray-600 bg-transparent" value={def.groundColor}
									onchange={(e) => updateEnvLight(def.id, { groundColor: e.currentTarget.value })} />
							{/if}
							<span class="flex-1"></span>
							<button class="ui-button-quiet" title="Convert back into a normal scene object"
								onclick={() => convertFromEnvironment(def.id)}>⇱ object</button>
							<button class="ui-button-quiet hover:bg-red-700" title="Remove"
								onclick={() => removeEnvLight(def.id)}>✕</button>
						</div>
						<SliderRow label="Intensity" min={0} max={4} step={0.05} value={def.intensity}
							onchange={(v) => updateEnvLight(def.id, { intensity: v })} />
					</div>
				{/each}
				<div class="flex flex-wrap gap-1">
					<button id="env-add-hemisphere" class="ui-button-quiet" onclick={() => addEnvLight('hemisphere')}>+ Hemisphere</button>
					<button id="env-add-directional" class="ui-button-quiet" onclick={() => addEnvLight('directional')}>+ Directional</button>
					<button id="env-add-point" class="ui-button-quiet" onclick={() => addEnvLight('point')}>+ Point</button>
				</div>
				<button
					id="env-adopt"
					class="ui-button-quiet disabled:cursor-not-allowed disabled:opacity-40"
					disabled={!selectedIsSceneLight}
					title={selectedIsSceneLight
						? 'Move the selected light out of the scene objects into the environment'
						: 'Select a scene light first'}
					onclick={() => convertToEnvironment($selectedObject.uuid)}
				>
					⇲ Adopt selected light into environment
				</button>

				<p class="text-[10px] italic text-gray-400">
					Everything here replicates to peers; your own lights automatically dim the default rig.
				</p>
			</Section>

			<Section label="Music">
				<p class="ui-section-label">Scene track (shared)</p>
				<select
					class="ui-input w-full"
					value={$music.hash ?? ''}
					onchange={(e) => {
						const hash = e.currentTarget.value || null;
						const item = $explorerItems.find((entry) => entry.hash === hash);
						setMusicTrack(hash, item?.name ?? '');
					}}
				>
					<option value="">— no music —</option>
					{#each $explorerItems.filter((item) => item.kind === 'audio') as item (item.id)}
						<option value={item.hash}>{item.name}</option>
					{/each}
					{#if $music.hash && !$explorerItems.some((item) => item.hash === $music.hash)}
						<option value={$music.hash}>{$music.name || 'shared track'} (fetching…)</option>
					{/if}
				</select>
				<div class="mt-1 flex items-center gap-2">
					<button
						class="ui-chip {$music.playing ? 'bg-primary-600 text-white' : 'bg-gray-600 text-gray-200 hover:bg-gray-500'}"
						disabled={!$music.hash}
						onclick={() => setMusicPlaying(!$music.playing)}
					>
						{$music.playing ? '■ Stop' : '▶ Play'}
					</button>
					{#if $musicBlocked && $music.playing}
						<span class="text-xs text-amber-400">click anywhere to enable audio</span>
					{/if}
				</div>
				<SliderRow label="Shared volume" min={0} max={1} step={0.05} value={$music.volume} onchange={(v) => setMusicVolume(v)} />
				<p class="ui-section-label">This device</p>
				<SliderRow label="Local volume" min={0} max={1} step={0.05} value={$musicLocalVolume} onchange={(v) => musicLocalVolume.set(v)} />
				<Checkbox bind:checked={$musicMuted}>Mute music on this device</Checkbox>
				<p class="mt-1 text-xs text-gray-400">
					One background track for everyone, synced to the same moment. Volume is shared; the local trim + mute affect only you.
				</p>
			</Section>

			<Section label="View">
				<p class="ui-section-label">Viewport — this device</p>
				<div id="view-mode-switch" class="flex flex-wrap gap-1">
					{#each [['shaded', 'Shaded'], ['shaded-ao', 'Shaded + AO'], ['wireframe', 'Wireframe']] as [mode, label] (mode)}
						{@const aoTaken = mode === 'shaded-ao' && sceneProvidesAo($scenePost)}
						<button
							id={'view-mode-' + mode}
							class={'ui-chip ' +
								($viewMode === mode ? 'bg-primary-600 text-white' : 'bg-gray-600 text-gray-200 hover:bg-gray-500') +
								(aoTaken ? ' cursor-not-allowed opacity-40' : '')}
							disabled={aoTaken}
							title={aoTaken
								? 'This scene sets its own ambient occlusion, so your personal setting does not apply'
								: ''}
							onclick={() => viewMode.set(mode)}
						>
							{label}
						</button>
					{/each}
				</div>
				<p class="mb-1 text-xs text-gray-400">
					How YOUR viewport shades the scene — not shown to peers. The scene's own look
					(post-processing) renders for everyone regardless; switch it off below if you need to.
				</p>
				{#if sceneProvidesAo($scenePost)}
					<p class="mb-1 text-[10px] text-gray-400">
						This scene sets its own ambient occlusion, so it is used instead of your personal
						setting.
					</p>
				{/if}
				<!-- B: ONE place for "the scene says X, but not on my screen". Layers 2 and 3
					 add a key here rather than each inventing their own checkbox and their own
					 "do my peers need to switch this on?" question. -->
				<p class="ui-section-label" data-anchor="Overrides">Overrides — this device</p>
				{#each OVERRIDES.filter((o) => o.key !== 'shaders') as override (override.key)}
					<Checkbox
						id={'override-' + override.key}
						checked={$viewportOverrides[override.key] !== false}
						onchange={(e) => setRenderLayer(override.key, e.currentTarget.checked)}
					>
						{override.label}
					</Checkbox>
					<p class="mb-1 text-[10px] italic text-gray-400">{override.hint}</p>
				{/each}
				<Checkbox bind:checked={$showLightHelpers}>Show light helpers</Checkbox>
				<Checkbox bind:checked={$showColliders}>Show colliders — this device</Checkbox>
			</Section>

			<!-- L3: the scene's authored post stack. Its whole UI lives in PostStack.svelte
				 so this shared file keeps a one-line edit. -->
			<Section label="Post-processing">
				<PostStack />
			</Section>

			<!-- 16-P4: everything about the VIEWPORT camera in one place (it used to be a
			     "Camera lens" sub-label buried in View): lens, clip planes, orbit feel,
			     framing shortcuts and the saved views. All LOCAL, never replicated. -->
			<Section label="Camera">
				<div id="lens-presets" class="flex flex-wrap gap-1">
					{#each LENS_PRESETS as p (p.label)}
						<button
							class={'ui-chip ' +
								(Math.round($globalCamera?.fov ?? 0) === p.fov
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							title={p.mm + 'mm equivalent · ' + p.fov + '° vertical FOV'}
							onclick={() => {
								if ($globalCamera) {
									$globalCamera.fov = p.fov;
									$globalCamera.updateProjectionMatrix();
								}
							}}
						>
							{p.label}
						</button>
					{/each}
				</div>
				<SliderRow
					label="Camera FOV"
					min={15}
					max={120}
					step={1}
					decimals={0}
					value={$globalCamera?.fov ?? 60}
					onchange={(v) => {
						$globalCamera.fov = v;
						$globalCamera.updateProjectionMatrix();
					}}
				/>
				<!-- 123: local per-device clip planes; far pairs with orbit zoom -->
				<SliderRow
					label="Near clip"
					min={0.01}
					max={2}
					step={0.01}
					decimals={2}
					value={$cameraNear}
					onchange={(v) => setCameraNear(v)}
				/>
				<div class="ui-row">
					<span class="w-20 shrink-0 text-xs text-gray-400">Far clip</span>
					<div class="w-24 shrink-0">
						<DragRow
							id="camera-far"
							value={$cameraFar}
							decimals={0}
							min={10}
							step={5}
							snap={100}
							ariaLabel="Far clip"
							onchange={(v) => setCameraFar(v)}
						/>
					</div>
					<span class="text-[10px] text-gray-500">grows to fit the scene</span>
				</div>
				<p class="text-[10px] italic text-gray-400">Clip planes are per-device (not shared).</p>
				<p class="ui-section-label">Orbit feel</p>
				<SliderRow
					label="Rotate speed"
					min={0.1}
					max={3}
					step={0.05}
					decimals={2}
					value={$orbitPrefs.rotateSpeed}
					onchange={(v) => setOrbitPrefs({ rotateSpeed: v })}
				/>
				<SliderRow
					label="Zoom speed"
					min={0.1}
					max={3}
					step={0.05}
					decimals={2}
					value={$orbitPrefs.zoomSpeed}
					onchange={(v) => setOrbitPrefs({ zoomSpeed: v })}
				/>
				<SliderRow
					label="Pan speed"
					min={0.1}
					max={3}
					step={0.05}
					decimals={2}
					value={$orbitPrefs.panSpeed}
					onchange={(v) => setOrbitPrefs({ panSpeed: v })}
				/>
				<Checkbox
					id="orbit-damping"
					checked={$orbitPrefs.damping}
					onchange={(/** @type {any} */ e) => setOrbitPrefs({ damping: e.currentTarget.checked })}
					>Smooth (damped) orbiting</Checkbox
				>
				<Checkbox
					id="orbit-invert"
					checked={$orbitPrefs.invertY}
					onchange={(/** @type {any} */ e) => setOrbitPrefs({ invertY: e.currentTarget.checked })}
					>Invert vertical orbit</Checkbox
				>
				<div class="ui-row items-center gap-2">
					<button id="camera-frame-scene" class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500" onclick={() => frameScene()}>
						Frame scene
					</button>
					<button id="camera-reset-view" class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500" onclick={() => resetView()}>
						Reset view
					</button>
					<button id="orbit-reset" class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500" onclick={() => resetOrbitPrefs()}>
						Reset feel
					</button>
				</div>
				<p class="ui-section-label" data-anchor="Saved views">Saved views</p>
				<div class="ui-row items-center gap-2">
					<button id="bookmark-save" class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500" onclick={() => saveBookmark()}>
						Save current view
					</button>
					<span class="text-[10px] text-gray-500">Shift+1..{SHORTCUT_SLOTS} recall the first {SHORTCUT_SLOTS}</span>
				</div>
				{#if $bookmarks.length === 0}
					<p class="text-xs text-gray-400">No saved views yet. Frame something you like, then Save current view.</p>
				{:else}
					<div id="bookmark-list" class="flex flex-col gap-1">
						{#each $bookmarks as bookmark, index (bookmark.id)}
							<div class="bookmark-row flex items-center gap-1">
								<span class="w-8 shrink-0 text-[10px] text-gray-500">{index < SHORTCUT_SLOTS ? '⇧' + (index + 1) : ''}</span>
								<input
									class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
									aria-label="View name"
									value={bookmark.name}
									onchange={(/** @type {any} */ e) => renameBookmark(bookmark.id, e.currentTarget.value)}
								/>
								<button class={bmBtn} title="Recall this view" onclick={() => recallBookmark(index)}>
									<Icon name="eye" size={13} />
								</button>
								<button class={bmBtn} title="Overwrite with the current view" onclick={() => overwriteBookmark(bookmark.id)}>
									<Icon name="camera" size={13} />
								</button>
								<button class={bmBtn} title="Move up" disabled={index === 0} onclick={() => moveBookmark(bookmark.id, -1)}>↑</button>
								<button
									class={bmBtn}
									title="Move down"
									disabled={index === $bookmarks.length - 1}
									onclick={() => moveBookmark(bookmark.id, 1)}>↓</button
								>
								<button class="{bmBtn} text-red-400" title="Delete this view" onclick={() => deleteBookmark(bookmark.id)}>
									<Icon name="trash-2" size={13} />
								</button>
							</div>
						{/each}
					</div>
					<p class="text-[10px] italic text-gray-400">
						Each view stores its lens (FOV + clip planes) and restores it on recall.
					</p>
				{/if}
			</Section>

			<!-- 16-P3: grid + snapping are LOCAL view prefs (like the clip planes and
			     the render mode above) — peers each get their own. -->
			<Section label="Grid">
				<Checkbox
					id="grid-show"
					checked={!!$showGrid}
					onchange={() => {
						showGrid.update((v) => !v);
						if (localStorage.getItem('showGrid')) localStorage.removeItem('showGrid');
						else localStorage.setItem('showGrid', 'false');
					}}>Show grid</Checkbox
				>
				<Checkbox
					id="grid-match-snap"
					checked={$gridSettings.matchSnapStep}
					onchange={(/** @type {any} */ e) => setGrid({ matchSnapStep: e.currentTarget.checked })}
				>
					Match snapping step ({$snapSettings.translate})
				</Checkbox>
				<SliderRow
					label="Cell size"
					min={0.05}
					max={10}
					step={0.05}
					decimals={2}
					value={effectiveCell($gridSettings, $snapSettings.translate)}
					onchange={(v) => setGrid({ cellSize: v, matchSnapStep: false })}
				/>
				<SliderRow
					label="Major every"
					min={2}
					max={20}
					step={1}
					decimals={0}
					value={$gridSettings.sectionEvery}
					onchange={(v) => setGrid({ sectionEvery: Math.round(v) })}
				/>
				<div class="ui-row items-center gap-2">
					<span class="w-20 shrink-0 text-xs text-gray-400">Colours</span>
					<!-- plain swatches: the full picker is overkill for two grid lines,
					     and v4 pickers must never take bind:hex (15-C) -->
					<input
						id="grid-cell-color"
						type="color"
						class="h-6 w-10 rounded-sm bg-transparent"
						aria-label="Grid cell colour"
						value={$gridSettings.cellColor}
						oninput={(/** @type {any} */ e) => setGrid({ cellColor: e.currentTarget.value })}
					/>
					<input
						id="grid-section-color"
						type="color"
						class="h-6 w-10 rounded-sm bg-transparent"
						aria-label="Grid major-line colour"
						value={$gridSettings.sectionColor}
						oninput={(/** @type {any} */ e) => setGrid({ sectionColor: e.currentTarget.value })}
					/>
					<span class="text-[10px] text-gray-500">cell · major</span>
				</div>
				<div class="ui-row items-center gap-1">
					<span class="w-20 shrink-0 text-xs text-gray-400">Fade</span>
					{#each [['auto', 'Auto'], ['fixed', 'Fixed']] as [mode, label]}
						<button
							class={'ui-chip ' +
								($gridSettings.fadeMode === mode
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							title={mode === 'auto' ? 'Fade scales with the camera distance' : 'A fixed fade radius'}
							onclick={() => setGrid({ fadeMode: mode })}>{label}</button
						>
					{/each}
				</div>
				{#if $gridSettings.fadeMode === 'fixed'}
					<SliderRow
						label="Fade radius"
						min={20}
						max={5000}
						step={10}
						decimals={0}
						value={$gridSettings.fadeDistance}
						onchange={(v) => setGrid({ fadeDistance: v })}
					/>
				{/if}
				<SliderRow
					label="Fade edge"
					min={0}
					max={4}
					step={0.1}
					decimals={1}
					value={$gridSettings.fadeStrength}
					onchange={(v) => setGrid({ fadeStrength: v })}
				/>
				<Checkbox
					id="grid-infinite"
					checked={$gridSettings.infinite}
					onchange={(/** @type {any} */ e) => setGrid({ infinite: e.currentTarget.checked })}
					>Infinite grid</Checkbox
				>
				{#if !$gridSettings.infinite}
					<SliderRow
						label="Extent"
						min={10}
						max={1000}
						step={10}
						decimals={0}
						value={$gridSettings.size}
						onchange={(v) => setGrid({ size: v })}
					/>
				{/if}
				<!-- 16-Q2: three-way follow. The old checkbox tracked your POSITION, which
				     is not what "follow the camera" should mean while you're looking
				     somewhere else; Look-at centres the grid under your gaze. -->
				<div id="grid-follow" class="ui-row items-center gap-1">
					<span class="w-20 shrink-0 text-xs text-gray-400">Follow</span>
					{#each [['off', 'Off'], ['lookat', 'Look-at'], ['camera', 'Camera']] as [mode, label]}
						<button
							class={'ui-chip ' +
								($gridSettings.follow === mode
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							title={mode === 'lookat'
								? 'Centre the grid under what you are looking at (horizontal only)'
								: mode === 'camera'
									? 'Centre the grid under the camera itself'
									: 'Keep the grid at the world origin'}
							onclick={() => setGrid({ follow: mode })}>{label}</button
						>
					{/each}
				</div>
				<Checkbox
					id="grid-axes"
					checked={$gridSettings.showAxes}
					onchange={(/** @type {any} */ e) => setGrid({ showAxes: e.currentTarget.checked })}
					>Show origin axes</Checkbox
				>
				<div class="ui-row items-center gap-2">
					<button id="grid-reset" class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500" onclick={() => resetGrid()}>
						Reset grid
					</button>
					<span class="text-[10px] italic text-gray-400">Per-device (not shared).</span>
				</div>
			</Section>

			<Section label="Snapping">
				<Checkbox
					id="snap-enabled"
					checked={$snapEnabled}
					onchange={(/** @type {any} */ e) => snapEnabled.set(e.currentTarget.checked)}
					>Snap transforms to a grid</Checkbox
				>
				<div class="snap-row">
					<span class="text-xs text-gray-400">Position</span>
					<div class="snap-chips">
					{#each [0.1, 0.25, 0.5, 1] as step}
						<button
							class={'ui-chip ' +
								($snapSettings.translate === step
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							onclick={() => snapSettings.update((s) => ({ ...s, translate: step }))}>{step}</button
						>
					{/each}
					</div>
					<div class="snap-field">
						<DragRow
							id="snap-translate"
							value={$snapSettings.translate}
							decimals={2}
							min={0.01}
							step={0.005}
							snap={0.1}
							ariaLabel="translate snap step"
							onchange={(v) => snapSettings.update((s) => ({ ...s, translate: v || s.translate }))}
						/>
					</div>
				</div>
				<div class="snap-row">
					<span class="text-xs text-gray-400">Rotation</span>
					<div class="snap-chips">
					{#each [5, 15, 45, 90] as step}
						<button
							class={'ui-chip ' +
								($snapSettings.rotateDeg === step
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							onclick={() => snapSettings.update((s) => ({ ...s, rotateDeg: step }))}>{step}°</button
						>
					{/each}
					</div>
					<div class="snap-field">
						<DragRow
							id="snap-rotate"
							value={$snapSettings.rotateDeg}
							decimals={1}
							min={0.1}
							step={0.2}
							snap={5}
							ariaLabel="rotateDeg snap step"
							onchange={(v) => snapSettings.update((s) => ({ ...s, rotateDeg: v || s.rotateDeg }))}
						/>
					</div>
				</div>
				<div class="snap-row">
					<span class="text-xs text-gray-400">Scale</span>
					<div class="snap-chips">
					{#each [0.05, 0.1, 0.25] as step}
						<button
							class={'ui-chip ' +
								($snapSettings.scale === step
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							onclick={() => snapSettings.update((s) => ({ ...s, scale: step }))}>{step}</button
						>
					{/each}
					</div>
					<div class="snap-field">
						<DragRow
							id="snap-scale"
							value={$snapSettings.scale}
							decimals={2}
							min={0.01}
							step={0.005}
							snap={0.05}
							ariaLabel="scale snap step"
							onchange={(v) => snapSettings.update((s) => ({ ...s, scale: v || s.scale }))}
						/>
					</div>
				</div>
				<Checkbox
					id="snap-surface"
					checked={$surfaceSnap}
					onchange={(/** @type {any} */ e) => surfaceSnap.set(e.currentTarget.checked)}
					>Rest dragged objects on the surface below</Checkbox
				>
				<!-- 19-B: element snap targets. Same three-column grid as the steps
				     above (label | chips | number), so every control in the section
				     lines up on the same two edges. -->
				<div class="snap-group">
					<span class="ui-section-label">Snap to elements</span>
					<span class="snap-group-hint">beats the grid steps</span>
				</div>
				<!-- five peer toggles are a chip CLOUD, not presets: right-aligning them
				     in the numeric grid stranded the fifth chip alone against the right
				     edge. Own line, left-aligned, wrapping naturally. -->
				<div class="snap-sub">
					<span class="text-xs text-gray-400">Targets</span>
					<span class="snap-sub-hint">
						{activeTargetCount === 0 ? 'none — element snap is idle' : `${activeTargetCount} on`}
					</span>
				</div>
				<div class="snap-cloud">
					{#each elementTargets as target}
						<button
							id={'snap-target-' + target[0]}
							class={'ui-chip ' +
								(targetOn($snapTargets, target[0])
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							aria-pressed={targetOn($snapTargets, target[0])}
							onclick={() => toggleTarget(target[0])}
							>{target[1]}</button
						>
					{/each}
				</div>
				<div class="snap-row">
					<span class="text-xs text-gray-400">Radius</span>
					<div class="snap-chips">
						{#each [15, 25, 40] as preset}
							<button
								class={'ui-chip ' +
									($snapTargets.radiusPx === preset
										? 'bg-primary-600 text-white'
										: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
								onclick={() => snapTargets.update((t) => ({ ...t, radiusPx: preset }))}
								>{preset}</button
							>
						{/each}
					</div>
					<div class="snap-field">
						<DragRow
							id="snap-radius"
							value={$snapTargets.radiusPx}
							decimals={0}
							min={5}
							max={60}
							step={1}
							ariaLabel="element snap radius (screen px)"
							onchange={(v) =>
								snapTargets.update((t) => ({
									...t,
									radiusPx: Math.min(60, Math.max(5, Math.round(v) || 25))
								}))}
						/>
					</div>
				</div>
				<!-- 19-B P4: align to the candidate normal (face/surface targets only) -->
				<Checkbox
					id="snap-align-normal"
					checked={$snapTargets.alignNormal}
					onchange={(/** @type {any} */ e) =>
						snapTargets.update((t) => ({ ...t, alignNormal: e.currentTarget.checked }))}
					>Rotate to the surface (align to normal)</Checkbox
				>
				<!-- Auto/Pivot are the MODE (two chips, so the numeric grid fits them);
				     picking is an ACTION that arms the next viewport click, so it gets a
				     full-width button of its own rather than a third, much wider chip -->
				<div class="snap-row">
					<span class="text-xs text-gray-400">Snap origin</span>
					<div class="snap-chips">
						<button
							id="snap-anchor-auto"
							class={'ui-chip ' +
								($snapTargets.anchorMode === 'auto' && $snapAnchor.mode !== 'picked'
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							title="Snap from the nearest point on the object's bounding box"
							onclick={() => {
								clearSnapAnchor();
								snapTargets.update((t) => ({ ...t, anchorMode: 'auto' }));
							}}>Auto</button
						>
						<button
							id="snap-anchor-pivot"
							class={'ui-chip ' +
								($snapTargets.anchorMode === 'pivot' && $snapAnchor.mode !== 'picked'
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							title="Snap from the object's own origin"
							onclick={() => {
								clearSnapAnchor();
								snapTargets.update((t) => ({ ...t, anchorMode: 'pivot' }));
							}}>Pivot</button
						>
					</div>
				</div>
				<!-- ARMED is a state the VIEWPORT is in, not a selection: it changes what
				     the next click does, so it takes its own colour instead of the accent
				     every other active control uses. -->
				<button
					id="snap-anchor-pick"
					class={'snap-action ' + ($snapAnchorPicking ? 'snap-action-armed' : '')}
					aria-pressed={$snapAnchorPicking}
					title="Click a point on the selected object to snap from"
					onclick={() => ($snapAnchorPicking ? cancelSnapAnchorPick() : startSnapAnchorPick())}
				>
					<span aria-hidden="true">⌖</span>
					{$snapAnchorPicking ? 'Click a point on the object…' : 'Pick a point on the object'}
				</button>
				<!-- the anchor's STATE lives on its own line: crammed in beside the mode
				     chips it wrapped them onto a second row the moment it appeared -->
				{#if $snapAnchorPicking}
					<div class="snap-status snap-status-armed">
						<span class="snap-status-text">Selecting…</span>
						<!-- the button above already says what to do; this line carries what
						     it cannot — the way out that isn't a click -->
						<span class="snap-status-hint">Esc cancels</span>
						<button
							id="snap-anchor-cancel"
							class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
							aria-label="cancel picking the snap origin"
							title="Cancel (Esc)"
							onclick={() => cancelSnapAnchorPick()}>✕</button
						>
					</div>
				{:else if $snapAnchor.mode === 'picked'}
					<div class="snap-status snap-status-picked">
						<span class="snap-status-text">Picked ✓</span>
						<button
							id="snap-anchor-save-origin"
							class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
							title="Keep this point for good: it becomes the object's own origin — shared with peers, undoable, and it survives selecting something else"
							onclick={() => saveSnapAnchorAsOrigin()}>Save as object origin</button
						>
						<button
							id="snap-anchor-clear"
							class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
							aria-label="clear the picked snap origin"
							title="Forget this point"
							onclick={() => clearSnapAnchor()}>✕</button
						>
					</div>
				{/if}
				<p class="text-[10px] italic text-gray-400">
					A picked origin is local and lasts until you select something else — save it to keep it.
				</p>
				<p class="text-[10px] italic text-gray-400">
					Snapping is per-device; the same steps drive the viewport menu.
				</p>
			</Section>

			<Section label="Physics">
				<!-- CL-A A6: shared scene gravity (replicated singleton, applies live) -->
				<SliderRow label="Gravity" min={-20} max={5} step={0.1} value={$sceneGravity} onchange={(v) => setSceneGravity(v)} />
				<div class="ui-row items-center gap-2">
					<button
						id="physics-gravity-reset"
						class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
						onclick={() => resetSceneGravity()}
					>
						Reset gravity ({DEFAULT_GRAVITY})
					</button>
				</div>
				<p class="text-[10px] italic text-gray-400">
					Shared with everyone and applies to running simulations live.
				</p>
				<!-- C1: every object that gets a body at sim start; click = select -->
				{#if physicsRows.length === 0}
					<p class="text-xs text-gray-400">
						No objects have physics yet. Select an object and set its Physics mode to
						Dynamic (or wire a Mass node to an Object Selector in the node editor),
						then press ▶ / P to simulate.
					</p>
				{:else}
					<div id="physics-objects" class="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
						{#each physicsRows as row (row.uuid)}
							<button
								class={'flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs transition-colors ' +
									($selectedObject?.uuid === row.uuid
										? 'bg-primary-600 text-white'
										: 'bg-gray-700 text-gray-200 hover:bg-gray-600')}
								title="Click to select"
								onclick={() => selectObject(row.uuid)}
							>
								<span class="truncate">{row.name}</span>
								<span class="shrink-0 text-[10px] opacity-75">
									{row.mode === 'dynamic'
										? 'dynamic · ' + row.mass + ' kg'
										: row.mode === 'static'
											? 'static'
											: 'collider only'}{row.flow ? ' · flow' : ''}
								</span>
							</button>
						{/each}
					</div>
				{/if}
				<button
					id="physics-enable-selection"
					class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
					onclick={() => enablePhysicsOnSelection()}
				>
					Enable physics on selection
				</button>
				<p class="text-[10px] italic text-gray-400">
					Dynamic objects fall and collide while a simulation runs (▶ or P).
				</p>
			</Section>

			<Section label="Background">
				<ColorPicker
					isAlpha={false}
					isTextInput={true}
					textInputModes={['hex', 'rgb', 'hsv']}
					isDialog={false}
					components={{ ...ChromeVariant, wrapper: CustomWrapper }}
					isOpen={true}
					sliderDirection="horizontal"
					--picker-indicator-size="20px"
					--cp-bg-color="#1f2937"
					--cp-border-color="#353f4e"
					--picker-height="70px"
					--picker-width="50px"
					--slider-width="10px"
					hex={$backgroundColor}
					onInput={(/** @type {any} */ c) => setBackground(c.hex)}
				/>
			</Section>

			<Section label="Fog">
				<ColorPicker
					isAlpha={false}
					isTextInput={true}
					textInputModes={['hex', 'rgb', 'hsv']}
					isDialog={false}
					components={{ ...ChromeVariant, wrapper: CustomWrapper }}
					isOpen={true}
					sliderDirection="horizontal"
					--picker-indicator-size="20px"
					--cp-bg-color="#1f2937"
					--cp-border-color="#353f4e"
					--picker-height="70px"
					--picker-width="50px"
					--slider-width="10px"
					hex={fogColor}
					onInput={(/** @type {any} */ c) => {
						if (sameHex(c.hex, fogColor)) return; // mount echo, not an edit
						fogColor = c.hex;
						applyFog();
					}}
				/>
				<SliderRow label="Near" min={0} max={10} step={0.1} decimals={1} value={fogNear ?? 0}
					onchange={(v) => { fogNear = v; applyFog(); }} />
				<SliderRow label="Far" min={0} max={100} step={0.1} decimals={1} value={fogFar ?? 0}
					onchange={(v) => { fogFar = v; applyFog(); }} />
				<Button
					size="xs"
					color="alternative"
					onclick={() => {
						fogNear = null;
						fogFar = null;
						editEnvSky({ fog: null });
					}}>Remove Fog</Button
				>
			</Section>
		</div>
	{:else if $selectedObject?.name !== undefined}
		<div id="drawer-label" class="sticky top-0 z-10 -mx-4 rounded-tl-lg bg-gray-800 px-4">
			<PanelHeader
				title="Properties"
				badge={multiCount ? `${multiCount} objects` : $selectedObject.type}
				pinned={$inspectorPinned}
				onpin={() => inspectorPinned.update((v) => !v)}
				onclose={() => inspectorClose.set(true)}
			/>
			<!-- PFX-C follow-up: property search — Sections filter by rendered text -->
			<input
				id="inspector-search"
				type="search"
				class="ui-input mb-2 w-full"
				placeholder="Filter properties…"
				value={$inspectorFilter}
				oninput={(/** @type {any} */ e) => inspectorFilter.set(e.currentTarget.value)}
				onkeydown={(/** @type {any} */ e) => e.key === 'Escape' && inspectorFilter.set('')}
			/>
		</div>

		<div class="flex flex-col gap-3">
			{#if multiCount}
				<!-- 17-D1 follow-up: the panel edits the whole SET, so say so — and drop
				     the single-object identity fields entirely rather than let the
				     last-clicked object's name and id read like the target. Renaming or
				     re-grouping one member of a selection is what clicking that one
				     object is for. -->
				<div id="selection-multi-banner" class="rounded-sm border border-primary-500/40 bg-primary-500/10 px-2 py-1.5">
					<p class="text-xs font-semibold text-primary-200">Editing {multiCount} objects</p>
					<p class="text-[10px] text-gray-400">Every value below applies to all of them.</p>
				</div>
			{/if}
			{#if !multiCount}
			<div class="flex flex-col gap-1">
				<input
					id="name"
					type="text"
					class="ui-input w-full"
					value={$selectedObject.name}
					onchange={(e) => {
						$selectedObject.name = e.currentTarget.value;
						sendName();
					}}
				/>
				<Tooltip placement="top" arrow={false} triggeredBy="#name">Name</Tooltip>
				<p id="uuid" class="truncate px-1 text-[10px] text-gray-500" title={$selectedObject.uuid}>
					{$selectedObject.uuid}
				</p>
				<div onclick={refreshGroups} role="presentation">
					{#key rerenderSelectGroup}
						<ThemedSelect
							id="select-group"
							items={groups}
							placeholder="Move to group"
							onchange={(/** @type {any} */ val) => {
								const selected = groups.find((item) => item.value === val);
								moveObjectToGroup(
									$selectedObject.uuid,
									selected?.name === 'Level Up' ? 'up' : val
								);
								objectsGroup.update((v) => v);
								rerenderSelectGroup = !rerenderSelectGroup;
							}}
						/>
					{/key}
				</div>
			</div>
			{/if}

			{#if $animatedObjects[$selectedObject.uuid]}
				{@const anim = $animatedObjects[$selectedObject.uuid]}
				<Section label="Animation">
					<div id="animation-controls">
						<ThemedSelect
							class="mb-1"
							value={anim.clip}
							items={anim.clips.map((clip) => ({ value: clip, name: clip }))}
							onchange={(/** @type {any} */ val) =>
								setAnimationState($selectedObject.uuid, { clip: val })}
						/>
						<div class="flex items-center gap-2">
							<button
								class="rounded-sm bg-primary-700 px-2 py-0.5 text-sm text-white"
								onclick={() => setAnimationState($selectedObject.uuid, { playing: !anim.playing })}
							>
								{anim.playing ? '⏸ Pause' : '▶ Play'}
							</button>
							<span class="text-xs text-gray-400">speed {anim.speed.toFixed(1)}×</span>
							<input
								type="range"
								class="flex-1 accent-primary-600"
								min="0.1"
								max="3"
								step="0.1"
								value={anim.speed}
								oninput={(e) => setAnimationState($selectedObject.uuid, { speed: +e.currentTarget.value })}
							/>
						</div>
						<p class="pt-1 text-[10px] italic text-gray-400">
							Clips run on the synced clock — peers see the same pose.
						</p>
					</div>
				</Section>
			{/if}

			<!-- 16-P5: a camera OBJECT is a marker mesh carrying userData.camera. All
			     writes go through setCameraFor (props history + objectParameters +
			     viz/preview poke) — the setPhysicsFor precedent. -->
			{#if isCameraObject($selectedObject)}
				{@const cam = cameraSpec($selectedObject)}
				<Section label="Camera">
					<div class="ui-row items-center gap-1">
						<span class="w-20 shrink-0 text-xs text-gray-400">Kind</span>
						{#each [['perspective', 'Perspective'], ['orthographic', 'Orthographic']] as [kind, label]}
							<button
								class={'ui-chip ' + (cam.kind === kind ? 'bg-primary-600 text-white' : 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
								onclick={() => setCameraFor($selectedObject.uuid, { kind })}>{label}</button
							>
						{/each}
					</div>
					{#if cam.kind === 'perspective'}
						<SliderRow
							label="FOV"
							min={10}
							max={140}
							step={1}
							decimals={0}
							value={cam.fov}
							onchange={(v) => setCameraFor($selectedObject.uuid, { fov: v })}
						/>
					{:else}
						<SliderRow
							label="Size"
							min={0.5}
							max={50}
							step={0.5}
							decimals={1}
							value={cam.orthoSize}
							onchange={(v) => setCameraFor($selectedObject.uuid, { orthoSize: v })}
						/>
					{/if}
					<SliderRow
						label="Near"
						min={0.01}
						max={5}
						step={0.01}
						decimals={2}
						value={cam.near}
						onchange={(v) => setCameraFor($selectedObject.uuid, { near: v })}
					/>
					<div class="ui-row items-center gap-2">
						<span class="w-20 shrink-0 text-xs text-gray-400">Far</span>
						<div class="w-24 shrink-0">
							<DragRow
								id="camera-object-far"
								value={cam.far}
								decimals={0}
								min={1}
								step={5}
								snap={50}
								ariaLabel="Far plane"
								onchange={(v) => setCameraFor($selectedObject.uuid, { far: v || cam.far })}
							/>
						</div>
					</div>
					<div class="ui-row items-center gap-1">
						<span class="w-20 shrink-0 text-xs text-gray-400">Framing</span>
						{#each ASPECTS as aspect}
							<button
								class={'ui-chip ' + (cam.aspect === aspect ? 'bg-primary-600 text-white' : 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
								onclick={() => setCameraFor($selectedObject.uuid, { aspect })}>{aspect}</button
							>
						{/each}
					</div>
					<Checkbox
						id="camera-guide"
						checked={cam.guide}
						onchange={(/** @type {any} */ e) => setCameraFor($selectedObject.uuid, { guide: e.currentTarget.checked })}
						>Letterbox guide while previewing</Checkbox
					>
					<div class="ui-row flex-wrap items-center gap-2">
						<button
							id="camera-preview"
							class={'ui-chip ' +
								($cameraPreview?.uuid === $selectedObject.uuid
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-200 hover:bg-gray-500')}
							title="Render the scene through this camera (exit from the banner)"
							onclick={() =>
								$cameraPreview?.uuid === $selectedObject.uuid
									? stopCameraPreview()
									: startCameraPreview($selectedObject.uuid)}
							>{$cameraPreview?.uuid === $selectedObject.uuid ? 'Previewing' : 'Preview'}</button
						>
						<button
							id="camera-from-view"
							class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
							title="Move this camera to your current viewpoint (and take its FOV)"
							onclick={() => setCameraFromView($selectedObject.uuid)}>Set from view</button
						>
						<button
							id="camera-align-view"
							class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
							title="Fly YOUR view to look through this camera (stays your camera)"
							onclick={() => alignViewToCamera($selectedObject.uuid)}>Align view</button
						>
					</div>
					<!-- 16-Q4: Capture is a SHOT, not a view change — its own row, with an icon -->
					<div class="ui-row items-center gap-2">
						<button
							id="camera-capture"
							class="ui-chip inline-flex items-center gap-1 bg-gray-600 text-gray-200 hover:bg-gray-500"
							title="Render one frame through this camera and download it as a PNG"
							onclick={() => captureThroughCamera($selectedObject.uuid)}
						>
							<Icon name="camera" size={13} />Capture
						</button>
						<span class="text-[10px] text-gray-500">saves a PNG at the framing aspect</span>
					</div>
					<Checkbox
						id="camera-pip"
						checked={cam.pip !== false}
						onchange={(/** @type {any} */ e) => setCameraFor($selectedObject.uuid, { pip: e.currentTarget.checked })}
						>Preview window while selected</Checkbox
					>
					<Checkbox
						id="camera-frustums"
						checked={$showCameraFrustums}
						onchange={(/** @type {any} */ e) => showCameraFrustums.set(e.currentTarget.checked)}
						>Show camera frustums — this device</Checkbox
					>
					<p class="text-[10px] italic text-gray-400">
						The camera itself is shared; previewing and the frustum lines are yours alone.
					</p>
				</Section>
			{/if}
			<Section label="Transform">
				{#if multiCount}
					<!-- 17-D1 follow-up: for a SET these rows drive the selection's origin
					     (the gizmo's pivot), so every axis has one real value instead of a
					     dash, and typing moves the group rigidly. -->
					<div class="mb-1 flex items-center justify-between gap-2">
						<span class="text-[10px] text-gray-400">
							{$pivotOnly ? 'Moving the origin only' : `Moves all ${multiCount} together`}
						</span>
						<div class="flex items-center gap-1">
							<Button
								id="origin-mode"
								size="xs"
								color={$pivotOnly ? 'primary' : 'alternative'}
								onclick={() => pivotOnly.update((v) => !v)}
							>
								{$pivotOnly ? 'Done' : 'Move origin'}
							</Button>
							<Button id="origin-reset" size="xs" color="alternative" onclick={() => resetPivotOrigin()}>
								Centre
							</Button>
						</div>
					</div>
				{/if}
				<div class="grid grid-cols-[3.2rem_1fr] items-center gap-1">
					<span class="text-[11px] text-gray-400">{multiCount ? 'Origin' : 'Position'}</span>
					<div id="inspector-position" class="grid grid-cols-3 gap-1">
						<DragRow label="X" accent="text-red-400" step={0.02}
							value={multiCount ? ($pivotPose?.pos?.[0] ?? 0) : $selectedObject.position.x}
							onchange={(v) => setTransform('position', 'x', v)} />
						<DragRow label="Y" accent="text-green-400" step={0.02}
							value={multiCount ? ($pivotPose?.pos?.[1] ?? 0) : $selectedObject.position.y}
							onchange={(v) => setTransform('position', 'y', v)} />
						<DragRow label="Z" accent="text-blue-400" step={0.02}
							value={multiCount ? ($pivotPose?.pos?.[2] ?? 0) : $selectedObject.position.z}
							onchange={(v) => setTransform('position', 'z', v)} />
					</div>
					{#if !isLight && !$pivotOnly}
						<span class="text-[11px] text-gray-400">Rotation</span>
						<div id="inspector-rotation" class="grid grid-cols-3 gap-1">
							<DragRow label="X" accent="text-red-400" step={0.01} snap={RAD_SNAP}
								value={multiCount ? ($pivotPose?.rot?.[0] ?? 0) : $selectedObject.rotation.x}
								onchange={(v) => setTransform('rotation', 'x', v)} />
							<DragRow label="Y" accent="text-green-400" step={0.01} snap={RAD_SNAP}
								value={multiCount ? ($pivotPose?.rot?.[1] ?? 0) : $selectedObject.rotation.y}
								onchange={(v) => setTransform('rotation', 'y', v)} />
							<DragRow label="Z" accent="text-blue-400" step={0.01} snap={RAD_SNAP}
								value={multiCount ? ($pivotPose?.rot?.[2] ?? 0) : $selectedObject.rotation.z}
								onchange={(v) => setTransform('rotation', 'z', v)} />
						</div>
						<span class="text-[11px] text-gray-400">Scale</span>
						<div id="inspector-scale" class="grid grid-cols-3 gap-1">
							<DragRow label="X" accent="text-red-400" step={0.01} snap={0.1}
								value={multiCount ? ($pivotPose?.scale?.[0] ?? 1) : $selectedObject.scale.x}
								onchange={(v) => setTransform('scale', 'x', v)} />
							<DragRow label="Y" accent="text-green-400" step={0.01} snap={0.1}
								value={multiCount ? ($pivotPose?.scale?.[1] ?? 1) : $selectedObject.scale.y}
								onchange={(v) => setTransform('scale', 'y', v)} />
							<DragRow label="Z" accent="text-blue-400" step={0.01} snap={0.1}
								value={multiCount ? ($pivotPose?.scale?.[2] ?? 1) : $selectedObject.scale.z}
								onchange={(v) => setTransform('scale', 'z', v)} />
						</div>
					{/if}
				</div>
				{#if originTarget}
					<!-- 17-D: this object's OWN origin (userData.origin). Moving it does not
					     move the mesh — it moves the point rotate/scale happen around, which
					     is what makes hinges, lids and wheels possible. Saved per object, so
					     switching selections brings each one's origin back. -->
					<div id="object-origin" class="mt-1 rounded-sm border border-gray-700/60 p-1.5">
						<div class="mb-1 flex items-center justify-between gap-2">
							<span class="text-[11px] text-gray-300">
								Origin {originSet ? '' : '(default)'}
							</span>
							<div class="flex items-center gap-1">
								<Button
									id="origin-mode-single"
									size="xs"
									color={$pivotOnly ? 'primary' : 'alternative'}
									onclick={() => {
										pivotOnly.update((v) => !v);
										reseatPivot(); // the gizmo has to exist to drag the origin
									}}
								>
									{$pivotOnly ? 'Done' : 'Move origin'}
								</Button>
								<Button id="origin-clear" size="xs" color="alternative" onclick={clearOrigin}>
									Reset
								</Button>
							</div>
						</div>
						<div class="grid grid-cols-[3.2rem_1fr] items-center gap-1">
							<span class="text-[11px] text-gray-400">World</span>
							<div id="inspector-origin" class="grid grid-cols-3 gap-1">
								<DragRow label="X" accent="text-red-400" step={0.02} value={originPos[0]}
									onchange={(v) => setOriginAxis('x', v)} />
								<DragRow label="Y" accent="text-green-400" step={0.02} value={originPos[1]}
									onchange={(v) => setOriginAxis('y', v)} />
								<DragRow label="Z" accent="text-blue-400" step={0.02} value={originPos[2]}
									onchange={(v) => setOriginAxis('z', v)} />
							</div>
						</div>
						<div class="mt-1 flex flex-wrap gap-1">
							<Button id="origin-bottom" size="xs" color="alternative" onclick={() => applyOriginPreset('bottom')}>
								Bottom
							</Button>
							<Button id="origin-center" size="xs" color="alternative" onclick={() => applyOriginPreset('center')}>
								Centre
							</Button>
							<Button id="origin-median" size="xs" color="alternative" onclick={() => applyOriginPreset('median')}>
								Median
							</Button>
							<Button id="origin-world" size="xs" color="alternative" onclick={() => applyOriginPreset('world')}>
								World 0
							</Button>
							{#if isGroup}
								<Button id="origin-children" size="xs" color="alternative" onclick={() => applyOriginPreset('children')}>
									Children
								</Button>
							{/if}
							{#if editingThis}
								<Button id="origin-hinge" size="xs" color="primary" onclick={originFromSelection}>
									Set origin here{$vertexSelectionSize > 1 ? ` (${$vertexSelectionSize} verts)` : ''}
								</Button>
							{:else}
								<Button id="origin-pick" size="xs" color="alternative" onclick={pickOriginFromMesh}>
									Pick from mesh…
								</Button>
							{/if}
						</div>
						{#if editingThis}
							<p class="mt-1 text-[10px] text-primary-200">
								Click a vertex — ctrl-click both ends of an edge to hinge on it — then press Set
								origin here.
							</p>
						{/if}
						<p class="mt-1 text-[10px] text-gray-500">
							{#if $pivotOnly}
								Drag the gizmo (or type above) to place the origin — the mesh stays put. Grid and
								surface snapping apply. Press Done to transform around it.
							{:else}
								Bottom puts the pivot on the footprint so the object sits on the ground. Spin and
								Orbit flow nodes turn around this point — that is how you hinge a door.
							{/if}
						</p>
					</div>
				{/if}
				<p class="text-[10px] text-gray-500">
					{#if multiCount && $pivotOnly}
						Re-place the origin, then press Done to rotate or scale the selection around it. The
						origin is a local editing aid — peers keep their own.
					{:else if multiCount}
						Rotation and scale are per-gesture handles: they turn the whole set around the origin,
						then reset for the next move.
					{:else}
						Drag to scrub — Shift fine, Ctrl snap, click to type.
					{/if}
				</p>
			</Section>

			{#if !isLight}
				<Section label="Object">
					<div class="ui-row items-center gap-2">
						<span class="w-24 shrink-0 text-xs text-gray-400">Render order</span>
						<div class="w-20 shrink-0">
							<DragRow
								id="inspector-render-order"
								value={$selectedObject.renderOrder}
								decimals={0}
								step={0.2}
								snap={5}
								ariaLabel="Render order"
								onchange={(v) => setObjectParam('renderOrder', Math.round(v) || 0)}
							/>
						</div>
					</div>
					<Checkbox
						checked={$selectedObject.frustumCulled}
						onchange={(/** @type {any} */ e) => setObjectParam('frustumCulled', e.target.checked)}
					>
						Frustum culled
					</Checkbox>
					<p class="text-[10px] text-gray-500">Higher render order draws later (over other objects). Disable culling for objects that vanish at screen edges.</p>
				</Section>
			{/if}

			{#if geoParams && geoSpec}
				<Section label="Geometry">
					<p class="px-1 text-[10px] uppercase tracking-wider text-gray-500">
						{geoParams.gtype}{geoTargets.length > 1 ? ` · ${geoTargets.length} objects` : ''}
					</p>
					{#if geoOtherTypes.length}
						<p id="geometry-mixed-note" class="rounded-sm bg-gray-700/50 px-2 py-1 text-[10px] text-gray-300">
							Only the {geoTargets.length} {geoParams.gtype} object{geoTargets.length === 1 ? '' : 's'}
							in this selection change — {geoOtherTypes.join(', ')}
							{geoOtherTypes.length === 1 ? 'has' : 'have'} different parameters.
						</p>
					{/if}
					{#if $selectedObject.userData?.vertexEdited || $selectedObject.userData?.faceEdited}
						<!-- 164: once the mesh is edited, the parametric controls are LOCKED
						     (changing one rebuilds the primitive + discards the edits) -->
						<p id="geometry-locked" class="rounded-sm bg-yellow-900/40 px-2 py-1 text-[10px] text-yellow-200">
							Mesh edited — geometry parameters are locked (changing them would rebuild the shape and discard your edits).
						</p>
					{:else}
						<div id="inspector-geometry" class="flex flex-col gap-1">
							{#each geoSpec.params as spec (spec.key)}
								{#if spec.kind === 'bool'}
									<Checkbox
										checked={!!geoParams.params[spec.key]}
										onchange={(/** @type {any} */ e) => editGeometry(spec.key, e.target.checked)}
									>
										{spec.label}
									</Checkbox>
								{:else}
									<SliderRow
										label={spec.label}
										min={spec.min ?? 0}
										max={spec.max ?? 10}
										step={spec.kind === 'int' ? 1 : spec.step ?? 0.05}
										decimals={spec.kind === 'int' ? 0 : 2}
										value={Number(geoParams.params[spec.key] ?? spec.def)}
										mixed={geoMixed(spec.key, spec.def)}
										onchange={(v) => editGeometry(spec.key, spec.kind === 'int' ? Math.round(v) : v)}
									/>
								{/if}
							{/each}
						</div>
					{/if}
				</Section>
			{/if}

			{#if isGroup}
				<Section label="Group">
					<p class="px-1 text-xs text-gray-400">
						{$selectedObject.children.length} direct child{$selectedObject.children.length === 1 ? '' : 'ren'},
						{countTree($selectedObject)} object{countTree($selectedObject) === 1 ? '' : 's'} in total.
					</p>
				</Section>
			{/if}

			{#if isLight}
				<Section label="Light">
					<ColorPicker
						isAlpha={false}
						isTextInput={true}
						textInputModes={['hex', 'rgb', 'hsv']}
						isDialog={false}
						components={{ ...ChromeVariant, wrapper: CustomWrapper }}
						isOpen={true}
						sliderDirection="horizontal"
						--picker-indicator-size="20px"
						--cp-bg-color="#1f2937"
						--cp-border-color="#353f4e"
						--picker-height="70px"
						--picker-width="50px"
						--slider-width="10px"
						hex={color}
						onInput={(/** @type {any} */ c) => {
							if (sameHex(c.hex, color)) return; // mount echo, not an edit
							$selectedObject.color.set(c.hex);
							color = c.hex;
							sendLightUpdate();
						}}
					/>
					{#if $selectedObject.type === 'HemisphereLight'}
						<p class="ui-section-label">Ground color</p>
						<ColorPicker
							isAlpha={false}
							isTextInput={true}
							textInputModes={['hex', 'rgb', 'hsv']}
							isDialog={false}
							components={{ ...ChromeVariant, wrapper: CustomWrapper }}
							isOpen={true}
							sliderDirection="horizontal"
							--picker-indicator-size="20px"
							--cp-bg-color="#1f2937"
							--cp-border-color="#353f4e"
							--picker-height="70px"
							--picker-width="50px"
							--slider-width="10px"
							hex={groundColor}
							onInput={(/** @type {any} */ c) => {
								if (sameHex(c.hex, groundColor)) return; // mount echo, not an edit
								$selectedObject.groundColor.set(c.hex);
								groundColor = c.hex;
								sendLightUpdate();
							}}
						/>
					{/if}
					<div class="grid grid-cols-[3.2rem_1fr] items-center gap-1">
						<span class="text-[11px] text-gray-400">Intensity</span>
						<div id="inspector-intensity">
							<DragRow label="I" accent="text-yellow-300" step={0.02} min={0} snap={0.5}
								value={$selectedObject.intensity}
								onchange={(v) => {
									$selectedObject.intensity = v;
									selectedObject.update((s) => s);
									sendLightUpdate();
								}} />
						</div>
					</div>
					{#each LIGHT_PARAMS[$selectedObject.type] ?? [] as spec (spec.key)}
						<SliderRow
							label={spec.label}
							min={spec.min ?? 0}
							max={spec.max ?? 10}
							step={spec.step ?? 0.05}
							value={Number($selectedObject[spec.key] ?? 0)}
							onchange={(v) => {
								$selectedObject[spec.key] = v;
								selectedObject.update((s) => s);
								sendLightUpdate();
							}} />
					{/each}

					{#if $selectedObject.type === 'SpotLight'}
						<p class="ui-section-label">Aim at</p>
						<div id="inspector-spot-target" class="grid grid-cols-3 gap-1">
							{#each ['X', 'Y', 'Z'] as axis, index (axis)}
								<DragRow
									label={axis}
									accent={['text-red-400', 'text-green-400', 'text-blue-400'][index]}
									step={0.05}
									value={($selectedObject.userData.spotTarget ?? [0, 0, 0])[index]}
									onchange={(v) => {
										const target = [...($selectedObject.userData.spotTarget ?? [0, 0, 0])];
										target[index] = v;
										$selectedObject.userData.spotTarget = target;
										selectedObject.update((s) => s);
										$peers.send({ type: 'lighttarget', uuid: $selectedObject.uuid, pos: target });
										sendLightUpdate(); // userData rides along for late joiners
									}} />
							{/each}
						</div>
					{/if}

					{#if SHADOW_TYPES.includes($selectedObject.type)}
						<p class="ui-section-label">Shadow</p>
						<Checkbox bind:checked={$selectedObject.castShadow} onchange={() => sendLightUpdate()}>
							Cast Shadow
						</Checkbox>
						<div class="ui-row">
							<span class="w-20 shrink-0 text-xs text-gray-400">Map size</span>
							<ThemedSelect
								class="flex-1"
								items={SHADOW_SIZES.map((size) => ({ value: size, name: size + ' px' }))}
								value={$selectedObject.userData.shadowMapSize ?? $selectedObject.shadow.mapSize.x}
								onchange={(/** @type {any} */ val) => {
									setShadowMapSize($selectedObject, +val);
									selectedObject.update((s) => s);
									sendLightUpdate();
								}}
							/>
						</div>
						{#if cappedShadowSize($selectedObject.userData.shadowMapSize ?? $selectedObject.shadow.mapSize.x) < ($selectedObject.userData.shadowMapSize ?? $selectedObject.shadow.mapSize.x)}
							<p class="text-[10px] italic text-gray-400">Capped by Settings ▸ Shadow quality on this machine.</p>
						{/if}
						<SliderRow label="Bias" min={-0.01} max={0.01} step={0.0005} decimals={4}
							value={$selectedObject.shadow.bias}
							onchange={(v) => {
								$selectedObject.shadow.bias = v;
								sendLightUpdate();
							}} />
						<SliderRow label="Softness" min={0} max={10} step={0.1} decimals={1}
							value={$selectedObject.shadow.radius}
							onchange={(v) => {
								$selectedObject.shadow.radius = v;
								sendLightUpdate();
							}} />
					{/if}
					<Checkbox bind:checked={$selectedObject.visible} onchange={() => sendLightUpdate()}>
						Visible
					</Checkbox>
					{#if $selectedObject.type === 'RectAreaLight'}
						<p class="text-[10px] italic text-gray-400">
							Rect area lights only affect Standard/Physical materials and cast no shadows.
						</p>
					{/if}
				</Section>
			{/if}

			{#if material}
				<Section label="Material">
					{#if matCount}
						<p id="material-multi-note" class="text-[10px] italic text-gray-400">
							Applies to {matCount} selected objects.
						</p>
					{/if}
					<Checkbox bind:checked={$selectedObject.visible} onchange={() => sendParam('visible')}>
						Visible
					</Checkbox>
					<ThemedSelect
						id="select-material"
						items={materials}
						value={material.type}
						onchange={(/** @type {any} */ val) => {
							// switches type but keeps color/texture/opacity, locally and on peers
							fanMat('Material type', (object) => switchMaterialType(object.uuid, val));
							selectedObject.update((s) => s);
						}}
					/>

					{#if material.color && material.type !== 'MeshNormalMaterial'}
						<ColorPicker
							isAlpha={false}
							isTextInput={true}
							textInputModes={['hex', 'rgb', 'hsv']}
							isDialog={false}
							components={{ ...ChromeVariant, wrapper: CustomWrapper }}
							isOpen={true}
							sliderDirection="horizontal"
							--picker-indicator-size="20px"
							--cp-bg-color="#1f2937"
							--cp-border-color="#353f4e"
							--picker-height="70px"
							--picker-width="50px"
							--slider-width="10px"
							hex={color}
							onInput={(/** @type {any} */ c) => {
								if (sameHex(c.hex, color)) return; // mount echo, not an edit
								// live drag: ONE debounced undo entry per gesture (setObjectColor
								// would record on every frame), then apply + replicate. 17-D1:
								// the apply fans over the selection; the gesture (opened here)
								// remembers each target's own before-colour.
								color = c.hex;
								trackColorGesture(c.hex);
								for (const object of matTargets) {
									object.material.color.set(c.hex);
									object.material.needsUpdate = true;
									$peers.send({ type: 'color', uuid: object.uuid, color: c.hex });
								}
								objectsGroup.update((v) => v);
							}}
						/>
					{/if}

					<!-- materials supporting textures initialize map to null; ShadowMaterial has no map at all -->
					{#if typeof material.map !== 'undefined'}
						<p class="ui-section-label">
							Texture{matCount ? ` — applies to all ${matCount}` : ''}
						</p>
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							id="texture-drop"
							class="rounded-sm border border-dashed {textureDropActive ? 'border-primary-500 bg-primary-500/10' : 'border-transparent'}"
							ondragover={(e) => {
								if (e.dataTransfer?.types.includes('application/x-explorer-item')) {
									e.preventDefault();
									textureDropActive = true;
								}
							}}
							ondragleave={() => (textureDropActive = false)}
							ondrop={async (e) => {
								const raw = e.dataTransfer?.getData('application/x-explorer-item');
								textureDropActive = false;
								if (!raw) return;
								e.preventDefault();
								e.stopPropagation();
								const payload = JSON.parse(raw);
								await fanTexture((uuid) => applyExplorerImage(uuid, payload), 'Texture');
							}}
						>
						<input
							type="file"
							id="texture-file"
							accept="image/png, image/jpeg, image/webp"
							style="display: none"
							onchange={(e) => {
								const file = e.currentTarget.files?.[0];
								if (file) setTextureFromFile(file);
								e.currentTarget.value = '';
							}}
						/>
						<div class="flex items-center gap-3">
							{#if material.userData?.mapDataUrl}
								<img
									src={material.userData.mapDataUrl}
									alt="texture"
									class="h-10 w-10 cursor-pointer rounded-sm border border-gray-500 object-cover"
									role="presentation"
									onclick={() => document.getElementById('texture-file')?.click()}
								/>
								<Button
									size="xs"
									color="alternative"
									onclick={() =>
										fanTexture(async (uuid) => removeObjectTexture(uuid), 'Remove texture')}
										>Remove</Button
								>
							{:else}
								<Button
									size="xs"
									color="alternative"
									onclick={() => document.getElementById('texture-file')?.click()}
								>
									Set texture...
								</Button>
								<span class="text-[10px] text-gray-500">or drop an Explorer image</span>
							{/if}
						</div>
						</div>
					{/if}

					{#if material.type === 'MeshStandardMaterial' || material.type === 'MeshPhysicalMaterial'}
						<SliderRow label="Roughness" min={0} max={1} step={0.05} value={material.roughness}
							mixed={matMixed((o) => o.material.roughness)}
							onchange={(v) => setMat('roughness', v)} />
						<SliderRow label="Metalness" min={0} max={1} step={0.05} value={material.metalness}
							mixed={matMixed((o) => o.material.metalness)}
							onchange={(v) => setMat('metalness', v)} />
					{/if}
					{#if material.type === 'MeshPhysicalMaterial'}
						<SliderRow label="Clearcoat" min={0} max={1} step={0.05} value={material.clearcoat}
							mixed={matMixed((o) => o.material.clearcoat)}
							onchange={(v) => setMat('clearcoat', v)} />
						<SliderRow label="Clearcoat rough" min={0} max={1} step={0.05} value={material.clearcoatRoughness}
							mixed={matMixed((o) => o.material.clearcoatRoughness)}
							onchange={(v) => setMat('clearcoatRoughness', v)} />
						<SliderRow label="Transmission" min={0} max={1} step={0.05} value={material.transmission}
							mixed={matMixed((o) => o.material.transmission)}
							onchange={(v) => setMat('transmission', v)} />
						<SliderRow label="IOR" min={1} max={2.333} step={0.01} decimals={2} value={material.ior}
							mixed={matMixed((o) => o.material.ior)}
							onchange={(v) => setMat('ior', v)} />
					{/if}
					{#if material.type === 'MeshPhongMaterial'}
						<SliderRow label="Shininess" min={0} max={100} step={1} decimals={0} value={material.shininess}
							mixed={matMixed((o) => o.material.shininess)}
							onchange={(v) => setMat('shininess', v)} />
					{/if}
					{#if material.type === 'MeshNormalMaterial' || material.type === 'MeshDepthMaterial'}
						<p class="text-[11px] italic text-gray-400">
							This material type derives its look from geometry — no color or surface parameters.
						</p>
					{/if}
					{#if typeof material.opacity !== 'undefined' && material.type !== 'ShadowMaterial'}
						<SliderRow label="Opacity" min={0} max={1} step={0.05} value={material.opacity}
							mixed={matMixed((o) => o.material.opacity)}
							onchange={(v) =>
								fanMat('Opacity', (object) => {
									setMaterialParam(object.uuid, 'transparent', v < 1);
									setMaterialParam(object.uuid, 'opacity', v);
								})} />
					{/if}
					{#if typeof material.wireframe !== 'undefined'}
						<Checkbox
							checked={material.wireframe}
							onchange={(/** @type {any} */ e) => setMat('wireframe', e.target.checked)}
						>
							Wireframe
						</Checkbox>
					{/if}
					{#if 'flatShading' in material}
						<Checkbox
							checked={material.flatShading}
							onchange={(/** @type {any} */ e) => setMat('flatShading', e.target.checked)}
						>
							Flat shading
						</Checkbox>
					{/if}
					{#if typeof material.side !== 'undefined'}
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Side</span>
							<ThemedSelect
								class="flex-1"
								items={[
									{ value: 0, name: 'Front' },
									{ value: 1, name: 'Back' },
									{ value: 2, name: 'Double' }
								]}
								value={material.side}
								onchange={(/** @type {any} */ v) => setMat('side', +v)}
							/>
						</div>
					{/if}
					<!-- EMISSION. One block, one name: this used to be "Emissive"/"Emissive
					     int." here and a second "Glow" pair higher up, which is two controls
					     for the same two properties. `Emission` with Color and Strength is
					     what Blender and Unity both call it, and the animation channel uses
					     the same word. Strength MULTIPLIES the colour, so black means no
					     emission however high it goes — hence the note. -->
					{#if material.emissive}
						<p class="ui-section-label">Emission</p>
						<SliderRow label="Strength" min={0} max={5} step={0.05} value={material.emissiveIntensity ?? 1}
							mixed={matMixed((o) => o.material.emissiveIntensity)}
							onchange={(v) => setMat('emissiveIntensity', v)} />
						<div id="inspector-emissive" class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Color</span>
							<input
								type="color"
								id="emissive-color"
								aria-label="Emission colour"
								class="h-6 w-8 cursor-pointer rounded-sm border border-gray-500 bg-transparent"
								value={'#' + material.emissive.getHexString()}
								oninput={(/** @type {any} */ e) => setMat('emissive', e.currentTarget.value)}
							/>
							<span class="text-[10px] italic text-gray-400">black = no glow</span>
						</div>
					{/if}

					<p class="ui-section-label">Shadow</p>
					<div class="flex gap-4 px-1">
						<Checkbox bind:checked={$selectedObject.castShadow} onchange={() => setCastShadow()}>
							Cast
						</Checkbox>
						<Checkbox
							bind:checked={$selectedObject.receiveShadow}
							onchange={() => sendParam('receiveShadow')}
						>
							Receive
						</Checkbox>
					</div>
				</Section>
			{/if}

			{#if !$selectedObject.isLight}
				<Section label="Physics">
					{#if multiCount}
						<p id="physics-multi-note" class="text-[10px] italic text-gray-400">
							Applies to {multiCount} selected objects.
						</p>
					{/if}
					<div class="ui-row items-center gap-2">
						<span class="w-20 shrink-0 text-xs text-gray-400">Body</span>
						<ThemedSelect
							id="physics-mode"
							items={[
								{ value: 'auto', name: 'Auto (scenery)' },
								{ value: 'static', name: 'Static' },
								{ value: 'dynamic', name: 'Dynamic' }
							]}
							value={$selectedObject.userData.physics?.mode ?? 'auto'}
							onchange={(/** @type {any} */ v) => setPhysics({ mode: v })}
						/>
					</div>
					{#if ($selectedObject.userData.physics?.mode ?? 'auto') === 'dynamic'}
						<SliderRow label="Mass" min={0.1} max={100} step={0.1} value={$selectedObject.userData.physics?.mass ?? 1}
							mixed={mixed((o) => o.userData.physics?.mass ?? 1)}
							onchange={(v) => setPhysics({ mass: v })} />
					{/if}
					<div class="ui-row items-center gap-2">
						<span class="w-20 shrink-0 text-xs text-gray-400">Material</span>
						<ThemedSelect
							id="physics-material"
							items={[
								{ value: 'custom', name: 'Custom' },
								{ value: 'ice', name: 'Ice' },
								{ value: 'rubber', name: 'Rubber' },
								{ value: 'wood', name: 'Wood' },
								{ value: 'metal', name: 'Metal' }
							]}
							value={physicsMaterialOf($selectedObject.userData.physics)}
							onchange={(/** @type {any} */ v) => {
								const m = PHYSICS_MATERIALS[v];
								if (m) setPhysics({ restitution: m.restitution, friction: m.friction });
							}}
						/>
					</div>
					<SliderRow label="Bounciness" min={0} max={1} step={0.05} value={$selectedObject.userData.physics?.restitution ?? 0.3}
						mixed={mixed((o) => o.userData.physics?.restitution ?? 0.3)}
						onchange={(v) => setPhysics({ restitution: v })} />
					<SliderRow label="Friction" min={0} max={2} step={0.05} value={$selectedObject.userData.physics?.friction ?? 0.5}
						mixed={mixed((o) => o.userData.physics?.friction ?? 0.5)}
						onchange={(v) => setPhysics({ friction: v })} />
					<div class="ui-row items-center gap-2">
						<span class="w-20 shrink-0 text-xs text-gray-400">Collider</span>
						<ThemedSelect
							id="physics-collider"
							items={[
								{ value: 'box', name: 'Box' },
								{ value: 'sphere', name: 'Sphere' },
								{ value: 'capsule', name: 'Capsule' },
								{ value: 'cylinder', name: 'Cylinder' },
									{ value: 'cone', name: 'Cone' },
								{ value: 'hull', name: 'Convex hull' },
							{ value: 'custom', name: 'Custom (edit…)' }
							]}
							value={$selectedObject.userData.physics?.collider ?? inferredColliderKind($selectedObject) ?? 'box'}
							onchange={(/** @type {any} */ v) => {
							// A8: picking Custom opens the edit session; Done writes the verts
							if (v === 'custom') enterColliderEdit($selectedObject.uuid);
							else setPhysics({ collider: v });
						}}
						/>
					</div>
					{#if ($selectedObject.userData.physics?.collider ?? 'box') === 'custom'}
						<button
							id="physics-edit-collider"
							class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
							onclick={() => enterColliderEdit($selectedObject.uuid)}
						>
							Edit collider…
						</button>
					{/if}
					<!-- CL-A A3: sensor = trigger volume; overlaps fire On Enter / On Exit -->
					<Checkbox
						id="physics-sensor"
						checked={!!$selectedObject.userData.physics?.sensor}
						onchange={(/** @type {any} */ e) => setPhysics({ sensor: e.currentTarget.checked || null })}
						>Sensor — no collision, fires On Enter / On Exit</Checkbox
					>
					{#if ($selectedObject.userData.physics?.mode ?? 'auto') === 'dynamic'}
						<!-- CL-A A5: freeze axes (dynamic bodies only) -->
						<div id="physics-freeze-rot" class="ui-row items-center gap-2 text-xs text-gray-300">
							<span class="w-20 shrink-0 text-gray-400">Lock rotation</span>
							{#each [['rx', 'X'], ['ry', 'Y'], ['rz', 'Z']] as [key, label] (key)}
								<Checkbox
									checked={!!$selectedObject.userData.physics?.freeze?.[key]}
									onchange={(/** @type {any} */ e) => setFreeze(key, e.currentTarget.checked)}
									>{label}</Checkbox
								>
							{/each}
						</div>
						<div id="physics-freeze-pos" class="ui-row items-center gap-2 text-xs text-gray-300">
							<span class="w-20 shrink-0 text-gray-400">Lock position</span>
							{#each [['px', 'X'], ['py', 'Y'], ['pz', 'Z']] as [key, label] (key)}
								<Checkbox
									checked={!!$selectedObject.userData.physics?.freeze?.[key]}
									onchange={(/** @type {any} */ e) => setFreeze(key, e.currentTarget.checked)}
									>{label}</Checkbox
								>
							{/each}
						</div>
					{/if}
					<!-- CL-A A7: per-object collider preview (local, this device) -->
					<Checkbox
						id="physics-show-collider"
						checked={$colliderVizObjects.has($selectedObject.uuid)}
						onchange={(/** @type {any} */ e) => setColliderViz($selectedObject.uuid, e.currentTarget.checked)}
						>Show collider — this device</Checkbox
					>
					<p class="mt-1 text-xs text-gray-400">
						Dynamic bodies fall and collide when a simulation runs; flow Mass/Bounciness/Friction nodes override these.
					</p>
				</Section>

				<!-- PFX-A: particle emitter — config on userData.particles, every edit
				     replicates + records a props undo entry (setParticles).
				     17-D1 follow-up: this section stays SINGLE-object. An emitter is a
				     whole config (preset, rates, colours, sprite), and the members of a
				     selection rarely share one — fanning a preset write would silently
				     overwrite emitters that were tuned individually, with no way to see
				     what was lost. The right-click menu already offers counted
				     Particles ▸ Add / Burst / Remove for a whole selection, which are
				     the operations that are safe to apply blind. -->
				{#if multiCount}
					<Section label="Particles">
						<p id="particles-multi-note" class="text-[10px] text-gray-400">
							{multiCount} objects selected — an emitter is edited one object at a time so tuned
							configs are not overwritten. Right-click the selection for Particles ▸ Add, Burst or
							Remove across all {multiCount}.
						</p>
					</Section>
				{:else}
				<Section label="Particles">
					{#if !$selectedObject.userData.particles}
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Emitter</span>
							<ThemedSelect
								id="particles-add"
								items={[
									{ value: 'none', name: 'Add emitter…' },
									...PARTICLE_PRESETS.map((p) => ({ value: p.key, name: p.name }))
								]}
								value={'none'}
								onchange={(/** @type {any} */ v) => {
									if (v !== 'none') addParticlesPreset($selectedObject.uuid, v);
								}}
							/>
						</div>
					{:else}
						{@const p = $selectedObject.userData.particles}
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Preset</span>
							<ThemedSelect
								id="particles-preset"
								items={PARTICLE_PRESETS.map((item) => ({ value: item.key, name: item.name }))}
								value={p.preset ?? 'sparkles'}
								onchange={(/** @type {any} */ v) => addParticlesPreset($selectedObject.uuid, v)}
							/>
						</div>
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Emission</span>
							<ThemedSelect
								id="particles-mode"
								items={[
									{ value: 'continuous', name: 'Continuous' },
									{ value: 'burst', name: 'Burst (triggered)' },
									{ value: 'impact', name: 'On impact (physics)' }
								]}
								value={p.mode ?? 'continuous'}
								onchange={(/** @type {any} */ v) => setParticles({ mode: v })}
							/>
						</div>
						{#if (p.mode ?? 'continuous') === 'impact'}
							<p class="text-xs text-gray-400">
								Fires when a physics simulation lands this object on the ground or another object (needs a Dynamic body + a running sim).
							</p>
						{/if}
						{#if (p.mode ?? 'continuous') !== 'continuous'}
							<div class="ui-row items-center gap-2">
								<Button size="xs" color="alternative" onclick={() => burstObjectParticles($selectedObject.uuid)}>
									<Sparkles size={16} class="mr-1" aria-hidden="true" />Burst now
								</Button>
								<span class="text-xs text-gray-400">fires for every peer</span>
							</div>
						{/if}
						<SliderRow label="Count" min={1} max={500} step={1} value={p.count ?? 80}
							onchange={(v) => setParticles({ count: v })} />
						<SliderRow label="Lifetime" min={0.1} max={6} step={0.1} value={p.lifetime ?? 1.5}
							onchange={(v) => setParticles({ lifetime: v })} />
						<SliderRow label="Speed" min={0} max={8} step={0.1} value={p.speed ?? 1}
							onchange={(v) => setParticles({ speed: v })} />
						<SliderRow label="Gravity" min={-10} max={10} step={0.1} value={p.gravity ?? 0}
							onchange={(v) => setParticles({ gravity: v })} />
						<SliderRow label="Turbulence" min={0} max={1} step={0.05} value={p.turbulence ?? 0.2}
							onchange={(v) => setParticles({ turbulence: v })} />
						<SliderRow label="Size start" min={0.01} max={1} step={0.01} value={p.sizeStart ?? 0.1}
							onchange={(v) => setParticles({ sizeStart: v })} />
						<SliderRow label="Size end" min={0} max={1} step={0.01} value={p.sizeEnd ?? 0.03}
							onchange={(v) => setParticles({ sizeEnd: v })} />
						<SliderRow label="Opacity" min={0} max={1} step={0.05} value={p.opacity ?? 0.9}
							onchange={(v) => setParticles({ opacity: v })} />
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400" title="Where particles spawn, relative to the object center (local axes)">Emit from</span>
							{#each ['x', 'y', 'z'] as axis, i}
								<div class="w-14 shrink-0">
									<DragRow
										value={(p.offset ?? [0, 0, 0])[i] ?? 0}
										decimals={2}
										step={0.01}
										snap={0.1}
										ariaLabel={'Emit offset ' + axis}
										onchange={(v) => {
											const off = [...(p.offset ?? [0, 0, 0])];
											off[i] = v;
											setParticles({ offset: off });
										}}
									/>
								</div>
							{/each}
						</div>
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Color</span>
							<input
								type="color"
								aria-label="Particle start color"
								class="h-6 w-8 cursor-pointer rounded-sm border border-gray-500 bg-transparent"
								value={p.colorStart ?? '#ffffff'}
								oninput={(/** @type {any} */ e) => setParticles({ colorStart: e.currentTarget.value })}
							/>
							<span class="text-xs text-gray-400">→</span>
							<input
								type="color"
								aria-label="Particle end color"
								class="h-6 w-8 cursor-pointer rounded-sm border border-gray-500 bg-transparent"
								value={p.colorEnd ?? '#8899aa'}
								oninput={(/** @type {any} */ e) => setParticles({ colorEnd: e.currentTarget.value })}
							/>
						</div>
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Sprite</span>
							<ThemedSelect
								id="particles-sprite"
								items={[
									{ value: 'dot', name: 'Soft dot' },
									{ value: 'streak', name: 'Spark streak' },
									{ value: 'puff', name: 'Smoke puff' },
									{ value: 'star', name: 'Star' },
									{ value: 'square', name: 'Confetti' }
								]}
								value={p.sprite ?? 'dot'}
								onchange={(/** @type {any} */ v) => setParticles({ sprite: v })}
							/>
						</div>
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Blending</span>
							<ThemedSelect
								id="particles-blending"
								items={[
									{ value: 'additive', name: 'Additive (glow)' },
									{ value: 'normal', name: 'Normal' }
								]}
								value={p.blending ?? 'additive'}
								onchange={(/** @type {any} */ v) => setParticles({ blending: v })}
							/>
						</div>
						<div class="ui-row items-center gap-2">
							<span class="w-20 shrink-0 text-xs text-gray-400">Space</span>
							<ThemedSelect
								id="particles-space"
								items={[
									{ value: 'local', name: 'Local (rides object)' },
									{ value: 'world', name: 'World (trails behind)' }
								]}
								value={p.space ?? 'local'}
								onchange={(/** @type {any} */ v) => setParticles({ space: v })}
							/>
						</div>
						<div class="ui-row items-center gap-2">
							<Button size="xs" color="red" onclick={() => removeObjectParticles($selectedObject.uuid)}>
								Remove emitter
							</Button>
						</div>
					{/if}
				</Section>
				{/if}
			{/if}
		</div>
	{/if}
</div>
{/if}

<style>
	/* 16-Q6: the three snapping rows line up — label | chips | field in ONE grid, so
	   the numeric boxes share an edge no matter how many preset chips a row has */
	.snap-row {
		display: grid;
		grid-template-columns: 4.25rem minmax(0, 1fr) 3.75rem;
		align-items: center;
		gap: 0.25rem;
	}
	.snap-chips {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.25rem;
	}
	.snap-field {
		width: 3.75rem;
	}
	/* the preset chips must fit on ONE line in a 320px panel — the shared ui-chip
	   padding + uppercase tracking pushed the fourth one onto a second row */
	.snap-chips button {
		padding-inline: 0.3rem;
		letter-spacing: 0;
	}
	/* 19-B: a label line for a control that owns its own full width (the target
	   cloud) — same type scale as a .snap-row label, with the state on the right */
	.snap-sub {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.snap-sub-hint {
		font-size: 10px;
		font-style: italic;
		color: rgb(156 163 175);
	}
	/* five PEER toggles, not presets: right-aligning them in the numeric grid
	   stranded the fifth chip on a line of its own against the right edge */
	.snap-cloud {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.snap-cloud button {
		padding-inline: 0.3rem;
		letter-spacing: 0;
	}
	/* the pick ACTION: full width, so the armed state is unmissable and the long
	   label never has to compete with the mode chips for room */
	.snap-action {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		width: 100%;
		padding: 0.3rem 0.5rem;
		border-radius: 0.375rem;
		border: 1px dashed rgb(255 255 255 / 0.25);
		background: rgb(255 255 255 / 0.04);
		color: rgb(209 213 219);
		font-size: 11px;
	}
	.snap-action:hover {
		background: rgb(255 255 255 / 0.09);
		color: #fff;
	}
	.snap-action-armed,
	.snap-action-armed:hover {
		background: #d97706;
		border-style: solid;
		border-color: #f59e0b;
		color: #fff;
	}
	.snap-group {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 0.35rem;
		padding-top: 0.4rem;
		border-top: 1px solid rgb(255 255 255 / 0.08);
	}
	.snap-group-hint {
		font-size: 10px;
		font-style: italic;
		color: rgb(156 163 175);
	}
	.snap-status {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.3rem 0.45rem;
		border-radius: 0.375rem;
		border: 1px solid transparent;
	}
	.snap-status-text {
		font-size: 11px;
		font-weight: 600;
	}
	.snap-status-hint {
		flex: 1;
		min-width: 0;
		font-size: 10px;
		font-style: italic;
		color: rgb(156 163 175);
	}
	.snap-status-armed {
		background: rgb(217 119 6 / 0.14);
		border-color: rgb(217 119 6 / 0.45);
	}
	.snap-status-armed .snap-status-text {
		color: #fbbf24;
	}
	.snap-status-picked {
		background: rgb(16 185 129 / 0.12);
		border-color: rgb(16 185 129 / 0.35);
	}
	.snap-status-picked .snap-status-text {
		color: #34d399;
		margin-right: auto;
	}
</style>

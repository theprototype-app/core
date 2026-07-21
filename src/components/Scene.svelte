<script lang="ts">
	import * as THREE from 'three';
	import { onMount } from 'svelte';
	import { T, useTask, useThrelte } from '@threlte/core';
	import { Environment, interactivity, OrbitControls, TransformControls } from '@threlte/extras';
	import { XR, Controller, Hand, useHand } from '@threlte/xr'
	import { spring } from 'svelte/motion';
	import { peers, username, userdata, specatorMode, avatarConfig, viewportMenu, objectContextMenu, viewportMenuOpener } from '../stores/appStore';
	import { get } from 'svelte/store';
	import { isLocked, editorCam, isVRMode, globalScene, objectsGroup, showGrid, TControls, selectedObject, selectedObjects, lockedObjects, marqueeRect, worldRig, vrOverride, specators, globalCamera, globalRenderer, orbitControls, passthroughActive, vrObjectsPanelOpen, vrPaletteOpen, vrPropsPanelOpen, vrPrefabsPanelOpen, vrChatPanelOpen, vrEditMenuOpen, vrSnapMenuOpen, vrSettingsPanelOpen, vrApprovePanelOpen, vrToolMode, viewMode } from '../stores/sceneStore';
	import { selectObject, deselectObject, applySelectionSet, topLevelObjectOf } from '$lib/objectActions';
	import { recordTransform } from '$lib/history';
	import { suspendAnimation, resumeAnimation } from '$lib/flowRuntime';
	import { holdBody, releaseBody } from '$lib/physics';
	import { sculptObject, beginStroke, strokeMove, endStroke as sculptEndStroke, showCursorAt, hideCursor } from '$lib/terrainSculpt';
	import { moduleClickHandlers, moduleInteractiveGroups } from '$lib/moduleSDK';
	import { updateSpatialAudio } from '$lib/voiceChat';
	import { tickAnimatedMixers } from '$lib/animatedImports';
	import { tickAnimationPreview } from '$lib/animationPreview';
	import { drawMode, strokePointFromRay, endStroke, setDrawScene } from '$lib/drawMode';
	import { capturePathClick } from '$lib/pathCapture';
	import { surfaceSnap, dropToSurface } from '$lib/snapping';
	import { editingObject, exitEditMode, raycastHandles, onProxyMoved, onProxyDragChanged, tickMeshEdit } from '$lib/meshEdit';
	import { faceEditObject, commitArmedFaceOp, exitFaceEdit, highlightFaceByTriangle, attachFaceGizmo, onFaceGizmoMoved, onFaceGizmoDragChanged, autoApplyFaceOp, faceEditMulti, toggleFaceSelection } from '$lib/faceEdit';
	import { fireObjectClick } from '$lib/flowRuntime';
	import { initVRControls, updateVRControls, raycastMenu, raycastPanel, raycastPalette, raycastProps, raycastPrefabs, raycastKeyboard, raycastChat, raycastEdit, raycastSnap, raycastSettings, raycastApprove, placePrefabGhost, vrFaceTrigger, vrVertexTrigger, vrVertexGrabStart, vrVertexGrabEnd, beginStretchSliderDrag, endStretchSliderDrag, executeVRMenuAction, resetWorldRig, onInputSourcesChange, worldToContentPose, boxSelectStart, boxSelectEnd, boxSelectActive, applyVRFrameRate, shouldSendHands, onHandPinchStart, onHandPinchEnd, pinchMenuToggledAt, firePingIfArmed } from '$lib/vrControls';
	import { vrKeyboardTarget } from '$lib/vrKeyboard';
	import { measureMode, measureClick } from '$lib/measure';
	import { pinsGroup, openAnnotation } from '$lib/annotationsHandler';
	import { sendPing } from '$lib/ping';
	import { startLightHelpers, updateLightHelpers, lightProxiesGroup } from '$lib/lightHelpers';
	import { startEditorNavigation, updateEditorNavigation } from '$lib/editorNavigation';
	import { vrMenuOpen } from '../stores/sceneStore';
	import VRMenu from './play/VRMenu.svelte';
	import VRStats from './play/VRStats.svelte';
	import VRObjectsPanel from './play/VRObjectsPanel.svelte';
	import VRColorPalette from './play/VRColorPalette.svelte';
	import VRPropertiesPanel from './play/VRPropertiesPanel.svelte';
	import VRPrefabsPanel from './play/VRPrefabsPanel.svelte';
	import VRKeyboard from './play/VRKeyboard.svelte';
	import VRChatPanel from './play/VRChatPanel.svelte';
	import VREditMenu from './play/VREditMenu.svelte';
	import VRSnapMenu from './play/VRSnapMenu.svelte';
	import VRSettingsPanel from './play/VRSettingsPanel.svelte';
	import VRPeerApprove from './play/VRPeerApprove.svelte';
	import VRSelectionShell from './play/VRSelectionShell.svelte';
	import MeasureOverlay from './MeasureOverlay.svelte';
	import AnnotationPins from './AnnotationPins.svelte';
	import PingMarkers from './PingMarkers.svelte';
	import PingHighlights from './PingHighlights.svelte';
	import PathWaypoints from './PathWaypoints.svelte';
	import LockHighlights from './LockHighlights.svelte';
	import Grid from '../extensions/Grid.svelte';
	import Outline from './Outline.svelte'
	import Player from './play/Player.svelte'
	import { Mesh, Vector3 } from 'three'


	let { scene, camera, renderer } = useThrelte();

	$globalScene = scene; // console.log($globalScene)
	$globalRenderer = renderer;

	$globalScene.background = new THREE.Color(0x101010);

	$username = localStorage.getItem('username');
	$userdata.push([$peers.peer.id, localStorage.getItem('username'), localStorage.getItem('avatar'), null, null, get(avatarConfig)]);
	$userdata = $userdata;

	$showGrid = localStorage.getItem('showGrid') === 'false' ? false : true;
	$vrOverride = localStorage.getItem('vrOverride');
	camera.current.position.set(10.5, 7.57, 11.4);
	let fov = camera.current.fov
	let resetSettings = false;
	setTimeout(() => {
		// $peers.send({ type: 'userdata', userdata: $userdata });
		if(localStorage.getItem("camx"))
		camera.current.position.x = localStorage.getItem("camx");
		if(localStorage.getItem("camy"))
		camera.current.position.y = localStorage.getItem("camy");
		if(localStorage.getItem("camz"))
		camera.current.position.z = localStorage.getItem("camz");
	
		// console.log(camera.current.position)
		resetSettings = true;
	}, 1000);

	interactivity();
	const scale = spring(0.5);
	let rotation = 0;
	let lastCameraPosition = new THREE.Vector3();
	let lastCameraQuaternion = new THREE.Quaternion();

	// --- VR presence: broadcast controller poses while in a session ---
	const handPosition = new THREE.Vector3();
	const handQuaternion = new THREE.Quaternion();
	const handEuler = new THREE.Euler();
	const lastHandPositions = [new THREE.Vector3(1e9, 0, 0), new THREE.Vector3(1e9, 0, 0)];
	let lastHandsSendAt = 0; // N5: throttle the heavier articulated-hand payload
	let lastSentJointLens = [-1, -1]; // B2.2: last-SENT representation per hand (rep-flip detector)
	// 195: camera pose reused per-frame, expressed in the shared content frame
	const camContentPos = new THREE.Vector3();
	const camContentQuat = new THREE.Quaternion();
	const camContentEuler = new THREE.Euler();

	function readControllerPose(index) {
		const controller = renderer.xr.getController(index);
		controller.getWorldPosition(handPosition);
		controller.getWorldQuaternion(handQuaternion);
		// 195: express hands in the shared content frame (worldRig-local) so a VR
		// world-grab moves them for peers; no-op when the rig is unbent
		worldToContentPose($worldRig, handPosition, handQuaternion);
		handEuler.setFromQuaternion(handQuaternion);
		// joints: [] (a controller has none) — peers branch on joints.length
		return { pos: handPosition.toArray(), rot: [handEuler.x, handEuler.y, handEuler.z], joints: /** @type {number[]} */ ([]) };
	}

	// N5: articulated hand presence. When a slot is HAND-TRACKED (not a controller),
	// broadcast the 25 WebXR joints so peers see moving fingers. The wrist rides the
	// content frame (like a controller); the joints are sent WRIST-LOCAL, so they're
	// rig-independent and peers reconstruct them under the wrist group.
	const HAND_JOINTS = [
		'wrist',
		'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
		'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
		'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
		'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
		'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'
	];
	const jointPos = new THREE.Vector3();

	// The live inputSource for a controller slot: prefer the stamped handedness
	// (194/210), fall back to the positional index. In hand-tracking the 'connected'
	// stamp can be missing, so this fallback is what keeps hands from broadcasting
	// unlabeled (null) — which made desktop peers see no VR hands at all.
	function inputSourceForSlot(slot = 0) {
		const session = renderer.xr.getSession();
		if (!session) return null;
		const sources = [...session.inputSources];
		const stamped = renderer.xr.getController(slot)?.userData?.handedness;
		return (stamped && sources.find((/** @type {any} */ s) => s.handedness === stamped)) || sources[slot] || null;
	}
	function slotHandedness(slot = 0) {
		return renderer.xr.getController(slot)?.userData?.handedness || inputSourceForSlot(slot)?.handedness || null;
	}
	// threlte's tracked hand spaces, keyed by handedness — the SAME XRHand spaces it
	// renders locally, so their joints are always populated when hands are visible.
	// (Reading renderer.xr.getHand(slot) by slot index was unreliable — the tracked
	// hand isn't necessarily at that slot, so it read empty joints and fell back to
	// the controller box.)
	const leftHandStore = useHand('left');
	const rightHandStore = useHand('right');

	function readHandJoints(handedness = 'left') {
		const handSpace = /** @type {any} */ ((handedness === 'left' ? leftHandStore : rightHandStore).current)?.hand;
		const wrist = handSpace?.joints?.['wrist'];
		if (!wrist || !wrist.visible) return null; // not actively tracked
		// wrist pose -> content frame (same as a controller)
		wrist.getWorldPosition(handPosition);
		wrist.getWorldQuaternion(handQuaternion);
		worldToContentPose($worldRig, handPosition, handQuaternion);
		handEuler.setFromQuaternion(handQuaternion);
		// every joint expressed in the wrist's LOCAL frame (rig-independent)
		const joints = /** @type {number[]} */ ([]);
		for (const name of HAND_JOINTS) {
			const j = handSpace.joints[name];
			if (!j) {
				joints.push(0, 0, 0);
				continue;
			}
			j.getWorldPosition(jointPos);
			wrist.worldToLocal(jointPos);
			joints.push(jointPos.x, jointPos.y, jointPos.z);
		}
		return { pos: handPosition.toArray(), rot: [handEuler.x, handEuler.y, handEuler.z], joints };
	}

	function broadcastVRHands() {
		const session = renderer.xr.getSession();
		if (!session) return;
		// N5: fill each hand by HANDEDNESS — an actively-tracked hand contributes its
		// articulated joints; otherwise the controller slot for that handedness gives
		// the wrist/ray pose (box). Keying by handedness (not slot) is why a tracked
		// hand at either slot now reaches peers.
		let left = readHandJoints('left');
		let right = readHandJoints('right');
		for (let slot = 0; slot < 2; slot++) {
			const hd = slotHandedness(slot);
			if (hd === 'left' && !left) left = readControllerPose(slot);
			else if (hd === 'right' && !right) right = readControllerPose(slot);
		}
		const poses = [left, right];
		const hasJoints = !!(left?.joints?.length || right?.joints?.length);
		// the joints payload is heavier — throttle it to ~30/s (controllers per-frame)
		const now = Date.now();
		if (hasJoints && now - lastHandsSendAt < 33) return;
		let moved = false;
		for (let i = 0; i < 2; i++) {
			const pose = poses[i];
			if (pose && new THREE.Vector3().fromArray(pose.pos).distanceTo(lastHandPositions[i]) > 0.005) moved = true;
		}
		// B2.2: a hands<->controllers switch must ALWAYS send (the old
		// `!moved && !hasJoints` gate ate the hands->controllers message, so peers
		// kept rendering finger spheres). shouldSendHands forces it on a rep flip.
		const lens = [left?.joints?.length ?? 0, right?.joints?.length ?? 0];
		if (!shouldSendHands({ moved, hasJoints, prevLens: lastSentJointLens, lens })) return;
		lastSentJointLens = lens;
		lastHandsSendAt = now;
		for (let i = 0; i < 2; i++) {
			const pose = poses[i];
			if (pose) lastHandPositions[i].fromArray(pose.pos);
		}
		$peers.send({ type: 'vrhands', peerId: $peers.peer.id, left, right, active: true });
	}

	useTask((delta) => {
		rotation += 0.25 * delta;
		// console.log(camera.current.lookAt.)
		if (camera.current.fov !== fov) {
			// console.log('fov changed')
			fov = camera.current.fov;
			$peers.send({ type: 'cameraSettings', peerId: $peers.peer.id, fov: fov });
			// console.log(camera.current.rotation)
		}
		if (resetSettings == true) {
			// localStorage.setItem("camx",camera.current.position.x);
			// localStorage.setItem("camy",camera.current.position.y);
			// localStorage.setItem("camz",camera.current.position.z);
		}
		
		if (!$specatorMode) {
			$globalCamera = camera.current; // console.log($globalScene)
			// 195: broadcast in the shared content frame (worldRig-local) so a VR
			// world-grab repositions you for peers; no-op when the rig is unbent, so
			// desktop + normal VR stay unchanged. Detect movement in the SAME frame,
			// else a grab (which leaves camera.position untouched) never sends.
			camContentPos.copy(camera.current.position);
			camContentQuat.copy(camera.current.quaternion);
			worldToContentPose($worldRig, camContentPos, camContentQuat);
			if (camContentPos.distanceTo(lastCameraPosition) > ($isVRMode ? 0.0001 : 0.01) ||
				camContentQuat.angleTo(lastCameraQuaternion) > THREE.MathUtils.degToRad(1)) {
				camContentEuler.setFromQuaternion(camContentQuat);
				$peers.send({ type: 'camera', peerId: $peers.peer.id, position: camContentPos.toArray(), rotation: [camContentEuler.x, camContentEuler.y, camContentEuler.z] });
				lastCameraPosition.copy(camContentPos);
				lastCameraQuaternion.copy(camContentQuat);
			}
		}
		if (renderer.xr.isPresenting) broadcastVRHands();
		updateVRControls(); // also manages ray/hover visibility outside sessions
		updateSpatialAudio(camera.current, scene); // voices follow avatars (throttled)
		tickAnimatedMixers(); // imported clips run on the synced clock
		tickAnimationPreview(); // Animation window: local transform preview (not synced)
		tickMeshEdit(); // vertex handles follow the object if it moves (119)
		updateLightHelpers();
		if (!renderer.xr.isPresenting) updateEditorNavigation(delta, camera.current, $orbitControls);
	});

	// --- undo/redo: record one history entry per gizmo drag ---
	let dragStartState = null;
	let hookedControls = null;
	$: if ($TControls && $TControls !== hookedControls) {
		hookedControls = $TControls;
		$TControls.addEventListener('dragging-changed', (event) => {
			const object = hookedControls.object;
			if (!object) return;
			// vertex handles record their own history entries
			if (object.userData?.isVertexProxy) {
				onProxyDragChanged(event.value);
				return;
			}
			// face gizmo (163): begin the rigid grab on drag, commit on release
			if (object.userData?.isFaceProxy) {
				onFaceGizmoDragChanged(event.value);
				return;
			}
			// the multi-select pivot records per-member entries (multiTransform)
			if (object.userData?.isMultiPivot) return;
			if (event.value) {
				// animated objects: park at their base so the gizmo edits the base transform
				suspendAnimation(object.uuid);
				// P-A: mid-sim, a grabbed dynamic body follows the gizmo kinematically
				holdBody(object.uuid);
				dragStartState = {
					uuid: object.uuid,
					pos: object.position.toArray(),
					rot: object.rotation.toArray(),
					scale: object.scale.toArray()
				};
			} else if (dragStartState && dragStartState.uuid === object.uuid) {
				resumeAnimation(object.uuid);
				releaseBody(object.uuid); // back to dynamic + throw velocity
				const after = {
					pos: object.position.toArray(),
					rot: object.rotation.toArray(),
					scale: object.scale.toArray()
				};
				const before = { pos: dragStartState.pos, rot: dragStartState.rot, scale: dragStartState.scale };
				if (JSON.stringify(before) !== JSON.stringify(after))
					recordTransform({ uuid: object.uuid, before: before, after: after });
				dragStartState = null;
			}
		});
	}

	// 132: never show the transform gizmo without a real selection — a fresh
	// reload used to leave it attached/visible at the origin with nothing to edit
	$: if ($TControls && !$editingObject && !$faceEditObject && !$selectedObject?.uuid) {
		$TControls.visible = false;
		if ($TControls.object && !$TControls.object.userData?.isMultiPivot) $TControls.detach();
	}

	// --- viewport click selection (desktop) and controller ray selection (VR) ---
	const selectionRaycaster = new THREE.Raycaster();

	function runModuleClickHandlers(hit) {
		for (const handler of moduleClickHandlers) {
			try {
				if (handler(hit)) return true;
			} catch (error) {
				console.log('module click handler failed', error);
			}
		}
		return false;
	}

	function raycastSelect(additive = false) {
		// module-owned interactive groups live at the scene root (piano, pong, ...)
		for (const name of moduleInteractiveGroups) {
			const root = scene.getObjectByName(name);
			if (!root) continue;
			const moduleHits = selectionRaycaster.intersectObject(root, true);
			if (moduleHits.length > 0 && runModuleClickHandlers(moduleHits[0].object)) return true;
		}
		const hits = selectionRaycaster.intersectObjects($objectsGroup.children, true);
		if (hits.length > 0) {
			// modules may consume the click (buttons, instruments, ...)
			if (runModuleClickHandlers(hits[0].object)) return true;
			const target = topLevelObjectOf(hits[0].object);
			if (target) {
				// shift-click toggles set membership (13)
				selectObject(target.uuid, !additive, additive);
				fireObjectClick(target.uuid); // 134: pulse any OnClick node targeting it
				return true;
			}
		}
		return false;
	}

	onMount(() => {
		startLightHelpers();
		startEditorNavigation();
		// tell peers our controllers are gone when the VR session ends
		const onSessionEnd = () => {
			exitEditMode(); // leave vertex edit mode cleanly (113)
			exitFaceEdit(); // and face edit mode (118)
			$isVRMode = false; // back to the editor whichever way the session ended
			resetWorldRig(); // the grabbed world snaps back to 1:1 (least surprise)
			$peers?.send({ type: 'vrhands', peerId: $peers.peer.id, left: null, right: null, active: false });
		};
		renderer.xr.addEventListener('sessionend', onSessionEnd);

		// 188: rebind on hands<->controllers / reconnect — the controller slot can
		// flip handedness, so reset per-slot input state + drop in-progress grabs
		const onSourcesChange = () => onInputSourcesChange();
		const onSessionStart = () => {
			renderer.xr.getSession()?.addEventListener('inputsourceschange', onSourcesChange);
		};
		renderer.xr.addEventListener('sessionstart', onSessionStart);

		const element = renderer.domElement;
		let downPosition = null;
		let downTime = 0;
		let strokeActive = false;
		let sculptActive = false; // T-2 brush drag in progress
		let lastSculptAt = 0;
		let marqueeStart = null; // shift-drag box select (13)
		let rightDown = null; // right-click TAP opens the Add/object menu (77)

		const setRayFromEvent = (event) => {
			const rect = element.getBoundingClientRect();
			const ndc = new THREE.Vector2(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				-((event.clientY - rect.top) / rect.height) * 2 + 1
			);
			selectionRaycaster.setFromCamera(ndc, camera.current);
		};

		const onPointerDown = (event) => {
			if (event.button === 2) {
				rightDown = [event.clientX, event.clientY, Date.now()];
				return;
			}
			if (event.button !== 0) return;
			// draw mode: dragging paints a stroke instead of orbiting
			if ($drawMode && !$isLocked && !$isVRMode) {
				strokeActive = true;
				if ($orbitControls) $orbitControls.enabled = false;
				setRayFromEvent(event);
				strokePointFromRay(selectionRaycaster);
				return;
			}
			// T-2: sculpt mode — dragging brushes the terrain instead of orbiting
			if ($sculptObject && !$isLocked && !$isVRMode) {
				const terrain = $objectsGroup?.getObjectByProperty('uuid', $sculptObject);
				setRayFromEvent(event);
				const hit = terrain ? selectionRaycaster.intersectObject(terrain, false)[0] : null;
				if (hit) {
					sculptActive = true;
					lastSculptAt = performance.now();
					if ($orbitControls) $orbitControls.enabled = false;
					beginStroke($sculptObject);
					const local = terrain.worldToLocal(hit.point.clone());
					strokeMove($sculptObject, local.x, local.z);
				}
				return;
			}
			// Shift+drag = marquee select (13) — orbit pauses for the gesture
			if (event.shiftKey && !$isLocked && !$isVRMode && !$specatorMode && !$editingObject && !$faceEditObject) {
				marqueeStart = [event.clientX, event.clientY];
				if ($orbitControls) $orbitControls.enabled = false;
			}
			downPosition = [event.clientX, event.clientY];
			downTime = Date.now();
		};

		const onPointerMove = (event) => {
			if (marqueeStart) {
				$marqueeRect = {
					x0: Math.min(marqueeStart[0], event.clientX),
					y0: Math.min(marqueeStart[1], event.clientY),
					x1: Math.max(marqueeStart[0], event.clientX),
					y1: Math.max(marqueeStart[1], event.clientY)
				};
			}
			// T-2: the brush cursor tracks the terrain; a held button keeps sculpting
			if ($sculptObject) {
				const terrain = $objectsGroup?.getObjectByProperty('uuid', $sculptObject);
				setRayFromEvent(event);
				const hit = terrain ? selectionRaycaster.intersectObject(terrain, false)[0] : null;
				if (hit) {
					showCursorAt(hit.point);
					if (sculptActive) {
						const now = performance.now();
						const dt = Math.min((now - lastSculptAt) / 1000, 0.1);
						lastSculptAt = now;
						const local = terrain.worldToLocal(hit.point.clone());
						strokeMove($sculptObject, local.x, local.z, dt);
					}
				} else hideCursor();
				if (sculptActive) return;
			}
			if (!strokeActive) return;
			setRayFromEvent(event);
			strokePointFromRay(selectionRaycaster);
		};

		const marqueePick = () => {
			// screen-project every top-level object's bounds center; inside = picked
			const rect = element.getBoundingClientRect();
			const area = $marqueeRect;
			const picked = [];
			const center = new THREE.Vector3();
			for (const object of $objectsGroup?.children ?? []) {
				const box = new THREE.Box3().setFromObject(object);
				if (!isFinite(box.min.x)) continue;
				box.getCenter(center).project(camera.current);
				const sx = rect.left + ((center.x + 1) / 2) * rect.width;
				const sy = rect.top + ((1 - center.y) / 2) * rect.height;
				if (center.z < 1 && sx >= area.x0 && sx <= area.x1 && sy >= area.y0 && sy <= area.y1)
					picked.push(object.uuid);
			}
			return picked;
		};

		const onPointerUp = (event) => {
			if (marqueeStart && event.button === 0) {
				const start = marqueeStart;
				marqueeStart = null;
				if ($orbitControls) $orbitControls.enabled = true;
				const moved = Math.hypot(event.clientX - start[0], event.clientY - start[1]);
				if ($marqueeRect && moved > 8) {
					// marquee ADDS to the selection (it already needs Shift to start)
					const picked = marqueePick();
					$marqueeRect = null;
					downPosition = null;
					if (picked.length) {
						applySelectionSet([...new Set([...$selectedObjects, ...picked])]);
					}
					return;
				}
				$marqueeRect = null;
				// fall through: a stationary shift-click toggles the hit object
			}
			if (sculptActive && event.button === 0) {
				sculptActive = false;
				if ($orbitControls) $orbitControls.enabled = true;
				sculptEndStroke(); // flush the pending preview + ONE undoable snapshot
				return;
			}
			if (strokeActive && event.button === 0) {
				strokeActive = false;
				if ($orbitControls) $orbitControls.enabled = true;
				endStroke();
				return;
			}
			if (event.button !== 0 || !downPosition) return;
			const moved = Math.hypot(event.clientX - downPosition[0], event.clientY - downPosition[1]);
			downPosition = null;
			// only a short, stationary click selects — dragging orbits the camera
			if (moved > 5 || Date.now() - downTime > 400) return;
			if ($isLocked || $isVRMode || $specatorMode) return;
			// ignore clicks on the transform gizmo (axis is set while hovering a handle)
			if ($TControls && ($TControls.dragging || $TControls.axis)) return;
			if (!$objectsGroup) return;

			const rect = element.getBoundingClientRect();
			const ndc = new THREE.Vector2(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				-((event.clientY - rect.top) / rect.height) * 2 + 1
			);
			selectionRaycaster.setFromCamera(ndc, camera.current);
			// Alt+click pings the pointed spot for every peer
			if (event.altKey) {
				const hits = $objectsGroup ? selectionRaycaster.intersectObjects($objectsGroup.children, true) : [];
				const planePoint = new THREE.Vector3();
				const point = hits[0]?.point ??
					(selectionRaycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), planePoint)
						? planePoint : null);
				if (point) sendPing(point);
				return;
			}
			// a Path patrol node capturing waypoints takes the click
			if (capturePathClick(selectionRaycaster)) return;
			// measure mode captures clicks entirely
			if ($measureMode) {
				measureClick(selectionRaycaster, $objectsGroup);
				return;
			}
			// while editing a mesh, clicks pick vertex handles instead of objects;
			// ctrl/shift-click adds to the Create-face multi-selection (177)
			if ($editingObject) {
				raycastHandles(selectionRaycaster, event.ctrlKey || event.shiftKey || event.metaKey);
				return;
			}
			// face edit mode (135 desktop): a click highlights the face under it,
			// and 163 attaches the transform gizmo to it (drag = move/rotate/scale)
			if ($faceEditObject) {
				const edited = $objectsGroup?.getObjectByProperty('uuid', $faceEditObject);
				const hit = edited ? selectionRaycaster.intersectObject(edited, false)[0] : null;
				const tri = hit && hit.faceIndex != null ? hit.faceIndex : -1;
				highlightFaceByTriangle(tri);
				// 212: Multi mode accumulates picks (the op button applies to the set);
				// otherwise 176 auto-applies the active extrude/inset on the click
				if (tri >= 0) {
					if ($faceEditMulti) toggleFaceSelection(tri);
					else autoApplyFaceOp();
				}
				attachFaceGizmo(); // 163: gizmo on the highlighted face (or detaches on a miss)
				return;
			}
			// light pick-proxies select their light (lights have no raycastable geometry)
			if ($lightProxiesGroup) {
				const proxyHits = selectionRaycaster.intersectObject($lightProxiesGroup, true);
				const proxyHit = proxyHits.find((hit) => hit.object.userData.lightUuid && hit.object.visible);
				if (proxyHit) {
					selectObject(proxyHit.object.userData.lightUuid, true);
					return;
				}
			}
			// note pins take priority over object selection
			if ($pinsGroup) {
				const pinHits = selectionRaycaster.intersectObject($pinsGroup, true);
				let pinNode = pinHits[0]?.object;
				while (pinNode && !pinNode.name?.startsWith('pin-')) pinNode = pinNode.parent;
				if (pinNode) {
					openAnnotation(pinNode.name.slice(4));
					return;
				}
			}
			if (!raycastSelect(event.shiftKey) && !event.shiftKey) deselectObject();
		};

		// pointerdown on the canvas proves the gesture started in the viewport;
		// pointerup is captured on window because the canvas can lose hit-testing
		// mid-gesture (the Canvas wrapper div swallows the up event)
		element.addEventListener('pointerdown', onPointerDown);
		// window, not canvas: the Canvas wrapper swallows pointer events mid-gesture
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		// right-click TAP opens the Add/object menu (77). Opening happens on the
		// contextmenu event (which trails pointerup) — opening on pointerup lets
		// that trailing event hit the fresh menu backdrop and close it instantly.
		// Shared opener for the viewport/object context menu — reused by right-click,
		// a touch long-press, and the mobile "+" HUD button (via viewportMenuOpener).
		// forceEmpty skips the object hit so "+" always opens the create menu.
		// menuX/menuY position the MENU (default to the ray coords); a HUD button
		// with no pointer location rays from screen-centre but anchors the menu to
		// itself by passing its own rect.
		const openViewportMenuAt = (clientX = 0, clientY = 0, forceEmpty = false, menuX = clientX, menuY = clientY) => {
			if ($isLocked || $isVRMode || $specatorMode || $drawMode || $editingObject || $faceEditObject || $measureMode) return;
			setRayFromEvent({ clientX, clientY });
			const hits = $objectsGroup ? selectionRaycaster.intersectObjects($objectsGroup.children, true) : [];
			const top = !forceEmpty && hits.length ? topLevelObjectOf(hits[0].object) : null;
			if (top) {
				// an object under the cursor gets its regular context menu; the
				// hit point rides along so Add note pins exactly there (87)
				$objectContextMenu = {
					x: menuX,
					y: menuY,
					uuid: top.uuid,
					point: hits[0].point.toArray(),
					locked: !!$lockedObjects.find((lock) => lock[1] === top.uuid)
				};
				return;
			}
			const planePoint = new THREE.Vector3();
			const point =
				hits[0]?.point ??
				(selectionRaycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), planePoint)
					? planePoint
					: new THREE.Vector3());
			viewportMenu.set({ x: menuX, y: menuY, point: point.toArray() });
		};
		// HUD/touch entry point (mobile "+" button, no right-click available)
		viewportMenuOpener.set(openViewportMenuAt);

		const onContextMenu = (event) => {
			event.preventDefault(); // the browser menu never belongs on the canvas
			const down = rightDown;
			rightDown = null;
			if (!down) return;
			// only a short stationary tap opens menus — right-DRAG keeps panning
			const moved = Math.hypot(event.clientX - down[0], event.clientY - down[1]);
			if (moved > 5 || Date.now() - down[2] > 400) return;
			openViewportMenuAt(event.clientX, event.clientY);
		};
		element.addEventListener('contextmenu', onContextMenu);

		// touch long-press = right-click (touch has no contextmenu). A stationary
		// ~500ms hold opens the same menu at the touch point.
		let holdTimer = 0; // 0 = no pending long-press (setTimeout returns a number)
		let holdX = 0;
		let holdY = 0;
		const clearTouchHold = () => {
			if (holdTimer) clearTimeout(holdTimer);
			holdTimer = 0;
		};
		// inline handlers so `e` is contextually typed (TouchEvent) off element's
		// HTMLCanvasElement.addEventListener overload — a named const wouldn't be
		element.addEventListener(
			'touchstart',
			(e) => {
				if (e.touches.length !== 1) return clearTouchHold();
				holdX = e.touches[0].clientX;
				holdY = e.touches[0].clientY;
				holdTimer = setTimeout(() => {
					openViewportMenuAt(holdX, holdY);
					holdTimer = 0;
				}, 500);
			},
			{ passive: true }
		);
		element.addEventListener(
			'touchmove',
			(e) => {
				if (!holdTimer) return;
				const t = e.touches[0];
				if (Math.hypot(t.clientX - holdX, t.clientY - holdY) > 10) clearTouchHold();
			},
			{ passive: true }
		);
		element.addEventListener('touchend', clearTouchHold);
		element.addEventListener('touchcancel', clearTouchHold);
		setDrawScene(scene);

		// VR: trigger press activates a quick-menu tile, otherwise selects
		// the object the controller points at
		initVRControls(renderer);
		const tempMatrix = new THREE.Matrix4();
		const xrControllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
		const onXRSelect = (event) => {
			const controller = event.target;
			// B2.4: a pinch-HOLD that just toggled the radial also fires 'select' on
			// release — swallow that click so it doesn't immediately pick a sector
			if (Date.now() - pinchMenuToggledAt < 250) return;
			// the keyboard is modal on top of any panel (116)
			if ($vrKeyboardTarget) {
				const key = raycastKeyboard(xrControllers.indexOf(controller));
				if (key) executeVRMenuAction(key);
				return;
			}
			if ($vrMenuOpen) {
				const action = raycastMenu(xrControllers.indexOf(controller));
				if (action) {
					executeVRMenuAction(action);
					return;
				}
			}
			if ($vrObjectsPanelOpen) {
				// objects panel rows select on trigger (101)
				const action = raycastPanel(xrControllers.indexOf(controller));
				if (action) {
					executeVRMenuAction(action);
					return;
				}
			}
			// the palette paint loop owns triggers landing on it (110)
			if ($vrPaletteOpen && raycastPalette(xrControllers.indexOf(controller))) return;
			if ($vrPropsPanelOpen) {
				// properties panel controls act on trigger (112)
				const action = raycastProps(xrControllers.indexOf(controller));
				if (action) {
					executeVRMenuAction(action);
					return;
				}
			}
			if ($vrPrefabsPanelOpen) {
				// prefab cells arm the placement ghost (115)
				const action = raycastPrefabs(xrControllers.indexOf(controller));
				if (action) {
					executeVRMenuAction(action);
					return;
				}
			}
			if ($vrChatPanelOpen) {
				// chat panel controls (117): close, input row → keyboard
				const action = raycastChat(xrControllers.indexOf(controller));
				if (action) {
					executeVRMenuAction(action);
					return;
				}
			}
			if ($vrSettingsPanelOpen) {
				// VR Settings panel buttons (187)
				const action = raycastSettings(xrControllers.indexOf(controller));
				if (action) {
					executeVRMenuAction(action);
					return;
				}
			}
			if ($vrApprovePanelOpen) {
				// VR peer-approval panel buttons (211): Approve / Deny
				const action = raycastApprove(xrControllers.indexOf(controller));
				if (action) {
					executeVRMenuAction(action);
					return;
				}
			}
			if ($vrEditMenuOpen) {
				// Edit Mesh side-menu buttons win over a face-pick (137)
				const action = raycastEdit(xrControllers.indexOf(controller));
				if (action) {
					executeVRMenuAction(action);
					return;
				}
			}
			if ($vrSnapMenuOpen) {
				// Snap side-menu buttons (156)
				const action = raycastSnap(xrControllers.indexOf(controller));
				if (action) {
					executeVRMenuAction(action);
					return;
				}
			}
			// D6: an armed radial ping consumes the trigger and pings the exact
			// pointed spot (one-shot, from the FIRING controller)
			if (firePingIfArmed(xrControllers.indexOf(controller))) return;
			// an armed ghost places on trigger and stays armed (115)
			if (placePrefabGhost()) return;
			// face edit mode (122): a pending extrude/inset adjust commits on the
			// next trigger; otherwise extrude/inset START a live adjust, move/delete
			// commit immediately
			if ($faceEditObject) {
				vrFaceTrigger();
				return;
			}
			// 159: in vertex edit mode a trigger no longer EXITS the session (a
			// stray click off the object used to cancel it); exit is explicit
			// (Edit ▸ Done / ring). 160 makes the trigger drag a vertex.
			if ($editingObject) {
				vrVertexTrigger(xrControllers.indexOf(controller));
				return;
			}
			if ($drawMode) return; // VR trigger feeds the stroke poll instead
			// 214: in Box Select mode the marquee (selectstart/selectend) owns the
			// trigger — the click never falls through to a single ray pick
			if ($vrToolMode === 'box' || boxSelectActive()) return;
			if (!$objectsGroup) return;
			tempMatrix.identity().extractRotation(controller.matrixWorld);
			selectionRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
			selectionRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
			raycastSelect();
		};
		// 182: hold-to-move a vertex — grab on trigger press, drop on release
		// (the functions no-op unless in vertex mode with the hold setting on)
		const onXRSelectStart = (event: any) => {
			const idx = xrControllers.indexOf(event.target);
			vrVertexGrabStart(idx); // 182: hold to move a vertex (no-op unless vertex mode)
			beginStretchSliderDrag(idx); // 193: grab a stretch slider (no-op unless stretch mode)
			boxSelectStart(idx); // 214: start a box-select marquee (no-op unless tool = box)
		};
		const onXRSelectEnd = () => {
			vrVertexGrabEnd();
			endStretchSliderDrag();
			boxSelectEnd(); // 214: finalize a box-select marquee (no-op unless active)
		};
		// 194: stamp handedness onto the persistent controller objects so anything
		// resolving a controller by hand (radial, menus) survives a reorder
		const onConn = (e: any) => { e.target.userData.handedness = e.data?.handedness ?? null; };
		const onDisc = (e: any) => { e.target.userData.handedness = null; };
		xrControllers.forEach((controller) => {
			controller.addEventListener('select', onXRSelect);
			controller.addEventListener('selectstart', onXRSelectStart);
			controller.addEventListener('selectend', onXRSelectEnd);
			controller.addEventListener('connected', onConn);
			controller.addEventListener('disconnected', onDisc);
		});

		return () => {
			element.removeEventListener('pointerdown', onPointerDown);
			element.removeEventListener('contextmenu', onContextMenu);
			window.removeEventListener('pointerup', onPointerUp);
			xrControllers.forEach((controller) => {
				controller.removeEventListener('select', onXRSelect);
				controller.removeEventListener('selectstart', onXRSelectStart);
				controller.removeEventListener('selectend', onXRSelectEnd);
				controller.removeEventListener('connected', onConn);
				controller.removeEventListener('disconnected', onDisc);
			});
			renderer.xr.removeEventListener('sessionend', onSessionEnd);
			renderer.xr.removeEventListener('sessionstart', onSessionStart);
			renderer.xr.getSession()?.removeEventListener('inputsourceschange', onSourcesChange);
		};
	});

	function oncreate() { $TControls.visible = false; }
	function onchange() {
		// vertex-edit proxy: write through to the geometry, never broadcast a move
		if ($TControls.object?.userData?.isVertexProxy) {
			$TControls.visible = true;
			onProxyMoved();
			return;
		}
		// face gizmo proxy (163): apply the rigid face transform live
		if ($TControls.object?.userData?.isFaceProxy) {
			$TControls.visible = true;
			onFaceGizmoMoved();
			return;
		}
		// multi-select pivot: multiTransform drives + broadcasts the members,
		// the pivot itself is local-only (its uuid means nothing to peers)
		if ($TControls.object?.userData?.isMultiPivot) {
			$TControls.visible = true;
			$selectedObject = $selectedObject; // keep the inspector rows fresh
			return;
		}
		//This would update reactively the object properties UI
		$selectedObject = $selectedObject // Trigger reactivity
		if (typeof $TControls.object !== 'undefined')
			if (typeof $TControls.object.parent !== 'undefined')
				if (typeof $TControls.object.uuid !== 'undefined') {
					// surface snap: keep the dragged object resting on whatever is below
					// (skipped when dragging the Y axis on purpose — that's a lift)
					if (
						$surfaceSnap &&
						$TControls.dragging &&
						$TControls.mode === 'translate' &&
						['X', 'Z', 'XZ', 'XYZ'].includes($TControls.axis) &&
						$objectsGroup
					) {
						dropToSurface($TControls.object, $objectsGroup);
					}
					$TControls.visible = true;
					$peers.send({
						type: 'move',
						uuid: $TControls.object.uuid,
						pos: $TControls.object.position.toArray(),
						rot: $TControls.object.rotation.toArray(),
						scale: $TControls.object.scale.toArray()
					});
				}
	}

	let playerMesh: Mesh
	let positionHasBeenSet = false
	const smoothPlayerPosX = spring(0)
	const smoothPlayerPosZ = spring(0)
	const t3 = new Vector3()
	useTask(() => {
		if (!playerMesh) return
		// console.log('test')
		playerMesh.getWorldPosition(t3)
		smoothPlayerPosX.set(t3.x, {
		hard: !positionHasBeenSet
		})
		smoothPlayerPosZ.set(t3.z, {
		hard: !positionHasBeenSet
		})
		if (!positionHasBeenSet) positionHasBeenSet = true
	})
</script>

<T.PerspectiveCamera makeDefault position={[-10, 10, 10]} fov={40} far={5000} bind:ref={$editorCam}>
	{#if !$specatorMode}
		<OrbitControls bind:ref={$orbitControls} enableZoom={true} enableDamping autoRotateSpeed={0.5} target.y={1.5} />
	{/if}
</T.PerspectiveCamera>

<!-- <T.DirectionalLight position={[0, 10, 10]} castShadow />

<T.Mesh
	rotation.y={rotation}
	position.y={1}
	scale={$scale}
	on:pointerenter={() => scale.set(1.5)}
	on:pointerleave={() => scale.set(1)}
	castShadow
>
	<T.BoxGeometry args={[1, 2, 1]} />
	<T.MeshStandardMaterial color="lightblue" />
</T.Mesh> -->

<!-- <T.Mesh rotation.x={-Math.PI / 2} receiveShadow>
	<T.CircleGeometry args={[4, 40]} />
	<T.MeshStandardMaterial color="white" />
</T.Mesh> -->

<!-- world rig (71): everything a VR world-grab should move/scale lives here;
     its transform is LOCAL-only (identity on desktop, reset on VR exit) -->
<T.Group bind:ref={$worldRig} name="world-grab-rig">
	<T.Group bind:ref={$objectsGroup} name="sceneObjects" />

	<Grid showGrid={$showGrid && $viewMode !== 'wireframe'} />

	<MeasureOverlay />

	<AnnotationPins />

	<PingMarkers />
	<PingHighlights />
	<PathWaypoints />
	<LockHighlights />
</T.Group>

{#if !$isLocked && !$isVRMode}
<TransformControls bind:controls={$TControls} {onchange} {oncreate} />

<Outline />
{/if}

<Player
bind:playerMesh
position={[0, 2, 3]}
/>

<VRMenu />
<VRStats />
<VRObjectsPanel />
<VRColorPalette />
<VRPropertiesPanel />
<VRPrefabsPanel />
<VRChatPanel />
<VREditMenu />
<VRSnapMenu />
<VRSettingsPanel />
<VRPeerApprove />
<VRKeyboard />
<VRSelectionShell />

<XR
	onsessionstart={() => {
		// passthrough (90): AR sessions blend with the room — drop the local sky
		const session = renderer.xr.getSession();
		passthroughActive.set(!!session && session.environmentBlendMode !== 'opaque');
		// B2.1: request the preferred refresh rate (auto = highest supported) —
		// without this the Quest stays at its 90Hz default
		applyVRFrameRate();
	}}
	onsessionend={() => passthroughActive.set(false)}
>
	<Controller left />
	<Controller right />
	<!-- B2.4: pinch-HOLD on the menu hand toggles the radial (hands have no B/Y) -->
	<Hand left onpinchstart={() => onHandPinchStart('left')} onpinchend={() => onHandPinchEnd('left')} />
	<Hand right onpinchstart={() => onHandPinchStart('right')} onpinchend={() => onHandPinchEnd('right')} />
</XR>
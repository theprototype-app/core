<script lang="ts">
	import * as THREE from 'three';
	import { onMount } from 'svelte';
	import { T, useTask, useThrelte } from '@threlte/core';
	import { Environment, interactivity, OrbitControls, TransformControls } from '@threlte/extras';
	import { XR, Controller, Hand } from '@threlte/xr'
	import { spring } from 'svelte/motion';
	import { peers, username, userdata, specatorMode, avatarConfig, viewportMenu, objectContextMenu } from '../stores/appStore';
	import { get } from 'svelte/store';
	import { isLocked, editorCam, isVRMode, globalScene, objectsGroup, showGrid, TControls, selectedObject, selectedObjects, lockedObjects, marqueeRect, worldRig, vrOverride, specators, globalCamera, globalRenderer, orbitControls, passthroughActive, vrObjectsPanelOpen, vrPaletteOpen, vrPropsPanelOpen, vrPrefabsPanelOpen, vrChatPanelOpen, vrEditMenuOpen, vrSnapMenuOpen } from '../stores/sceneStore';
	import { selectObject, deselectObject, applySelectionSet, topLevelObjectOf } from '$lib/objectActions';
	import { recordTransform } from '$lib/history';
	import { suspendAnimation, resumeAnimation } from '$lib/flowRuntime';
	import { moduleClickHandlers, moduleInteractiveGroups } from '$lib/moduleSDK';
	import { updateSpatialAudio } from '$lib/voiceChat';
	import { tickAnimatedMixers } from '$lib/animatedImports';
	import { drawMode, strokePointFromRay, endStroke, setDrawScene } from '$lib/drawMode';
	import { capturePathClick } from '$lib/pathCapture';
	import { surfaceSnap, dropToSurface } from '$lib/snapping';
	import { editingObject, exitEditMode, raycastHandles, onProxyMoved, onProxyDragChanged, tickMeshEdit } from '$lib/meshEdit';
	import { faceEditObject, commitArmedFaceOp, exitFaceEdit, highlightFaceByTriangle } from '$lib/faceEdit';
	import { fireObjectClick } from '$lib/flowRuntime';
	import { initVRControls, updateVRControls, raycastMenu, raycastPanel, raycastPalette, raycastProps, raycastPrefabs, raycastKeyboard, raycastChat, raycastEdit, raycastSnap, placePrefabGhost, vrFaceTrigger, vrVertexTrigger, executeVRMenuAction, resetWorldRig } from '$lib/vrControls';
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
	import VRSelectionShell from './play/VRSelectionShell.svelte';
	import MeasureOverlay from './MeasureOverlay.svelte';
	import AnnotationPins from './AnnotationPins.svelte';
	import PingMarkers from './PingMarkers.svelte';
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

	function readControllerPose(index) {
		const controller = renderer.xr.getController(index);
		controller.getWorldPosition(handPosition);
		controller.getWorldQuaternion(handQuaternion);
		handEuler.setFromQuaternion(handQuaternion);
		return { pos: handPosition.toArray(), rot: [handEuler.x, handEuler.y, handEuler.z] };
	}

	function broadcastVRHands() {
		const session = renderer.xr.getSession();
		if (!session) return;
		let moved = false;
		const poses = [readControllerPose(0), readControllerPose(1)];
		for (let i = 0; i < 2; i++) {
			const position = new THREE.Vector3().fromArray(poses[i].pos);
			if (position.distanceTo(lastHandPositions[i]) > 0.005) moved = true;
		}
		if (!moved) return;
		lastHandPositions[0].fromArray(poses[0].pos);
		lastHandPositions[1].fromArray(poses[1].pos);

		const hands = { left: null, right: null };
		[...session.inputSources].forEach((source, index) => {
			if (index < 2 && (source.handedness === 'left' || source.handedness === 'right'))
				hands[source.handedness] = poses[index];
		});
		$peers.send({ type: 'vrhands', peerId: $peers.peer.id, left: hands.left, right: hands.right, active: true });
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
			// console.log($specators)
			if (camera.current.position.distanceTo(lastCameraPosition) > ($isVRMode ? 0.0001 : 0.01) ||
				camera.current.quaternion.angleTo(lastCameraQuaternion) > THREE.MathUtils.degToRad(1)) {
				$peers.send({ type: 'camera', peerId: $peers.peer.id, position: camera.current.position.toArray(), rotation: camera.current.rotation.toArray() });
				lastCameraPosition.copy(camera.current.position);
				lastCameraQuaternion.copy(camera.current.quaternion);
			}
		}
		if (renderer.xr.isPresenting) broadcastVRHands();
		updateVRControls(); // also manages ray/hover visibility outside sessions
		updateSpatialAudio(camera.current, scene); // voices follow avatars (throttled)
		tickAnimatedMixers(); // imported clips run on the synced clock
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
			// the multi-select pivot records per-member entries (multiTransform)
			if (object.userData?.isMultiPivot) return;
			if (event.value) {
				// animated objects: park at their base so the gizmo edits the base transform
				suspendAnimation(object.uuid);
				dragStartState = {
					uuid: object.uuid,
					pos: object.position.toArray(),
					rot: object.rotation.toArray(),
					scale: object.scale.toArray()
				};
			} else if (dragStartState && dragStartState.uuid === object.uuid) {
				resumeAnimation(object.uuid);
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

		const element = renderer.domElement;
		let downPosition = null;
		let downTime = 0;
		let strokeActive = false;
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
			// while editing a mesh, clicks pick vertex handles instead of objects
			if ($editingObject) {
				raycastHandles(selectionRaycaster);
				return;
			}
			// face edit mode (135 desktop): a click highlights the face under it
			if ($faceEditObject) {
				const edited = $objectsGroup?.getObjectByProperty('uuid', $faceEditObject);
				const hit = edited ? selectionRaycaster.intersectObject(edited, false)[0] : null;
				highlightFaceByTriangle(hit && hit.faceIndex != null ? hit.faceIndex : -1);
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
		const onContextMenu = (event) => {
			event.preventDefault(); // the browser menu never belongs on the canvas
			const down = rightDown;
			rightDown = null;
			if (!down) return;
			if ($isLocked || $isVRMode || $specatorMode || $drawMode || $editingObject || $faceEditObject || $measureMode) return;
			// only a short stationary tap opens menus — right-DRAG keeps panning
			const moved = Math.hypot(event.clientX - down[0], event.clientY - down[1]);
			if (moved > 5 || Date.now() - down[2] > 400) return;
			setRayFromEvent(event);
			const hits = $objectsGroup ? selectionRaycaster.intersectObjects($objectsGroup.children, true) : [];
			const top = hits.length ? topLevelObjectOf(hits[0].object) : null;
			if (top) {
				// an object under the cursor gets its regular context menu; the
				// hit point rides along so Add note pins exactly there (87)
				$objectContextMenu = {
					x: event.clientX,
					y: event.clientY,
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
			viewportMenu.set({ x: event.clientX, y: event.clientY, point: point.toArray() });
		};
		element.addEventListener('contextmenu', onContextMenu);
		setDrawScene(scene);

		// VR: trigger press activates a quick-menu tile, otherwise selects
		// the object the controller points at
		initVRControls(renderer);
		const tempMatrix = new THREE.Matrix4();
		const xrControllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
		const onXRSelect = (event) => {
			const controller = event.target;
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
			if (!$objectsGroup) return;
			tempMatrix.identity().extractRotation(controller.matrixWorld);
			selectionRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
			selectionRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
			raycastSelect();
		};
		xrControllers.forEach((controller) => controller.addEventListener('select', onXRSelect));

		return () => {
			element.removeEventListener('pointerdown', onPointerDown);
			element.removeEventListener('contextmenu', onContextMenu);
			window.removeEventListener('pointerup', onPointerUp);
			xrControllers.forEach((controller) => controller.removeEventListener('select', onXRSelect));
			renderer.xr.removeEventListener('sessionend', onSessionEnd);
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

<T.PerspectiveCamera makeDefault position={[-10, 10, 10]} fov={15} far={5000} bind:ref={$editorCam}>
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

	<Grid showGrid={$showGrid} />

	<MeasureOverlay />

	<AnnotationPins />

	<PingMarkers />
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
<VRKeyboard />
<VRSelectionShell />

<XR
	onsessionstart={() => {
		// passthrough (90): AR sessions blend with the room — drop the local sky
		const session = renderer.xr.getSession();
		passthroughActive.set(!!session && session.environmentBlendMode !== 'opaque');
	}}
	onsessionend={() => passthroughActive.set(false)}
>
	<Controller left />
	<Controller right />
	<Hand left />
	<Hand right />
</XR>
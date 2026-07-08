<script lang="ts">
	import * as THREE from 'three';
	import { onMount } from 'svelte';
	import { T, useTask, useThrelte } from '@threlte/core';
	import { Environment, interactivity, OrbitControls, TransformControls } from '@threlte/extras';
	import { XR, Controller, Hand } from '@threlte/xr'
	import { spring } from 'svelte/motion';
	import { peers, username,userdata, specatorMode, avatarConfig } from '../stores/appStore';
	import { get } from 'svelte/store';
	import { isLocked, editorCam, isVRMode, globalScene, objectsGroup, showGrid, TControls, selectedObject, vrOverride, specators, globalCamera, globalRenderer, orbitControls } from '../stores/sceneStore';
	import { selectObject, deselectObject, topLevelObjectOf } from '$lib/objectActions';
	import { recordTransform } from '$lib/history';
	import { surfaceSnap, dropToSurface } from '$lib/snapping';
	import { editingObject, raycastHandles, onProxyMoved, onProxyDragChanged } from '$lib/meshEdit';
	import { initVRControls, updateVRControls, raycastMenu, executeVRMenuAction } from '$lib/vrControls';
	import { measureMode, measureClick } from '$lib/measure';
	import { pinsGroup, openAnnotation } from '$lib/annotationsHandler';
	import { startLightHelpers, updateLightHelpers, lightProxiesGroup } from '$lib/lightHelpers';
	import { startEditorNavigation, updateEditorNavigation } from '$lib/editorNavigation';
	import { vrMenuOpen } from '../stores/sceneStore';
	import VRMenu from './play/VRMenu.svelte';
	import MeasureOverlay from './MeasureOverlay.svelte';
	import AnnotationPins from './AnnotationPins.svelte';
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
		if (renderer.xr.isPresenting) {
			broadcastVRHands();
			updateVRControls();
		}
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
			if (event.value) {
				dragStartState = {
					uuid: object.uuid,
					pos: object.position.toArray(),
					rot: object.rotation.toArray(),
					scale: object.scale.toArray()
				};
			} else if (dragStartState && dragStartState.uuid === object.uuid) {
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

	// --- viewport click selection (desktop) and controller ray selection (VR) ---
	const selectionRaycaster = new THREE.Raycaster();

	function raycastSelect() {
		const hits = selectionRaycaster.intersectObjects($objectsGroup.children, true);
		if (hits.length > 0) {
			const target = topLevelObjectOf(hits[0].object);
			if (target) {
				selectObject(target.uuid, true);
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
			$peers?.send({ type: 'vrhands', peerId: $peers.peer.id, left: null, right: null, active: false });
		};
		renderer.xr.addEventListener('sessionend', onSessionEnd);

		const element = renderer.domElement;
		let downPosition = null;
		let downTime = 0;

		const onPointerDown = (event) => {
			if (event.button !== 0) return;
			downPosition = [event.clientX, event.clientY];
			downTime = Date.now();
		};

		const onPointerUp = (event) => {
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
			if (!raycastSelect()) deselectObject();
		};

		// pointerdown on the canvas proves the gesture started in the viewport;
		// pointerup is captured on window because the canvas can lose hit-testing
		// mid-gesture (the Canvas wrapper div swallows the up event)
		element.addEventListener('pointerdown', onPointerDown);
		window.addEventListener('pointerup', onPointerUp);

		// VR: trigger press activates a quick-menu tile, otherwise selects
		// the object the controller points at
		initVRControls(renderer);
		const tempMatrix = new THREE.Matrix4();
		const xrControllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
		const onXRSelect = (event) => {
			const controller = event.target;
			if ($vrMenuOpen) {
				const action = raycastMenu(xrControllers.indexOf(controller));
				if (action) {
					executeVRMenuAction(action);
					return;
				}
			}
			if (!$objectsGroup) return;
			tempMatrix.identity().extractRotation(controller.matrixWorld);
			selectionRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
			selectionRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
			raycastSelect();
		};
		xrControllers.forEach((controller) => controller.addEventListener('select', onXRSelect));

		return () => {
			element.removeEventListener('pointerdown', onPointerDown);
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

<T.PerspectiveCamera makeDefault position={[-10, 10, 10]} fov={15} bind:ref={$editorCam}>
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

<T.Group bind:ref={$objectsGroup} name="sceneObjects" />

<Grid showGrid={$showGrid} />

{#if !$isLocked && !$isVRMode}
<TransformControls bind:controls={$TControls} {onchange} {oncreate} />

<Outline />
{/if}

<Player
bind:playerMesh
position={[0, 2, 3]}
/>

<VRMenu />

<MeasureOverlay />

<AnnotationPins />

<XR>
	<Controller left />
	<Controller right />
	<Hand left />
	<Hand right />
</XR>
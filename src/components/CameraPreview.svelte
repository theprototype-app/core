<script lang="ts">
	import { T, useTask, useThrelte } from '@threlte/core';
	import { OrbitControls } from '@threlte/extras';
	import * as THREE from 'three';
	import { objectsGroup, TControls } from '../stores/sceneStore';
	import { cameraPreview, writeBackPose, previewOrbit, seatOrbitBehind } from '$lib/cameraPreview';
	import { cameraSpec, aspectRatio, syncCameraToObject } from '$lib/cameraObjects';

	// 16-P5: while a camera OBJECT is previewed, THIS is the render camera — a real
	// perspective/orthographic camera (`makeDefault`, so threlte's `camera.current`
	// and everything reading it follow the swap; Outline re-points its composer).
	// It rides the marker's world pose every frame, EXCEPT while controlling, when
	// the flow reverses: the viewport navigation drives this camera (it owns the
	// OrbitControls, so Scene's existing per-frame nav call just works) and each
	// frame writes the pose back onto the marker.

	const { size, camera: activeCamera } = useThrelte();

	const object = $derived(
		$cameraPreview ? ($objectsGroup?.getObjectByProperty('uuid', $cameraPreview.uuid) ?? null) : null
	);
	const spec = $derived(object ? cameraSpec(object) : null);
	const viewportAspect = $derived($size.width && $size.height ? $size.width / $size.height : 16 / 9);
	// 'free' framing follows the viewport; a preset letterboxes (the guide overlay
	// in Menu.svelte masks the leftover bars)
	const ratio = $derived(spec ? aspectRatio(spec.aspect) || viewportAspect : viewportAspect);
	const halfH = $derived(spec ? Math.max(0.01, spec.orthoSize) : 5);

	/** @type {any} */
	let cameraRef: any = $state(null);
	/** @type {any} */
	let controlsRef: any = $state(null);

	// debug probe for the suites (opt-in, like __outlineDebug)
	$effect(() => {
		if (typeof window === 'undefined' || !localStorage.getItem('debugStores')) return;
		(window as any).__cameraPreviewDebug = () => ({
			preview: $cameraPreview,
			hasObject: !!object,
			hasSpec: !!spec,
			cameraMounted: !!cameraRef,
			controlsMounted: !!controlsRef,
			cameraParent: cameraRef?.parent?.name || cameraRef?.parent?.type || null,
			defaultCamera: (activeCamera as any)?.current?.type ?? null,
			defaultIsMine: (activeCamera as any)?.current === cameraRef
		});
	});

	// pose sync, both directions
	const pos = new THREE.Vector3();
	const quat = new THREE.Quaternion();
	const scale = new THREE.Vector3();
	useTask(() => {
		if (!cameraRef || !object) return;
		if ($cameraPreview?.controlling) {
			// the nav/orbit already moved the camera this frame — push it to the marker
			writeBackPose(cameraRef, object);
			return;
		}
		object.updateWorldMatrix(true, false);
		object.matrixWorld.decompose(pos, quat, scale);
		cameraRef.position.copy(pos);
		cameraRef.quaternion.copy(quat);
	});

	// a previewed camera must not also be gizmo-attached (dragging the marker while
	// looking through it is a fight nobody wins)
	$effect(() => {
		if ($cameraPreview) ($TControls as any)?.detach?.();
	});

	// Control on/off: publish the preview's controls (own store — see the comment
	// in cameraPreview.js) and SEAT them behind the camera so pressing Control
	// doesn't snap the view to the world origin.
	$effect(() => {
		const controls = $cameraPreview?.controlling ? controlsRef : null;
		previewOrbit.set(controls);
		if (!controls || !cameraRef) return;
		// OrbitControls already ran one update() during construction, targeting the
		// world origin — that rotated the camera before this effect runs. Re-sync the
		// camera from the MARKER (still untouched: the write-back task runs on the next
		// frame), then seat the target ahead of it so the controls' own lookAt is a
		// no-op. Without the re-sync the small mount rotation gets baked into the pose.
		if (object) syncCameraToObject(cameraRef, object);
		seatOrbitBehind(controls, cameraRef);
	});
</script>

{#if $cameraPreview && spec}
	{#if spec.kind === 'orthographic'}
		<T.OrthographicCamera
			makeDefault
			left={-halfH * ratio}
			right={halfH * ratio}
			top={halfH}
			bottom={-halfH}
			near={spec.near}
			far={spec.far}
			bind:ref={cameraRef}
		>
			{#if $cameraPreview.controlling}
				<!-- taking the controls: same OrbitControls the editor camera uses, so
				     mouse look + Scene's WASD nav behave identically -->
				<OrbitControls bind:ref={controlsRef} enableZoom={true} enableDamping />
			{/if}
		</T.OrthographicCamera>
	{:else}
		<T.PerspectiveCamera
			makeDefault
			fov={spec.fov}
			aspect={ratio}
			near={spec.near}
			far={spec.far}
			bind:ref={cameraRef}
		>
			{#if $cameraPreview.controlling}
				<OrbitControls bind:ref={controlsRef} enableZoom={true} enableDamping />
			{/if}
		</T.PerspectiveCamera>
	{/if}
{/if}

<script lang="ts">
	// 64-2d (Q4): the 2D EDITOR VIEW — while `view2d.on` (and no camera preview, no play, no
	// spectating) THIS orthographic camera is the render camera (`makeDefault`, the CameraPreview
	// swap: camera.current and everything reading it follow), looking straight down -Z. Its
	// OrbitControls cannot rotate: left / right drag pans, the wheel zooms. They are published to
	// the editor's `orbitControls` store, so the gizmo's auto-pause, the trackpad and the keyboard
	// navigation drive them like the perspective pair. LOCAL — nothing here is sent or saved.
	import { untrack } from 'svelte';
	import { T, useThrelte } from '@threlte/core';
	import { OrbitControls } from '@threlte/extras';
	import * as THREE from 'three';
	import { orbitControls, isLocked } from '../../stores/sceneStore';
	import { specatorMode } from '../../stores/appStore';
	import { cameraPreview } from '$lib/cameraPreview';
	import { view2d } from '$lib/sprite2d/view2d.js';

	const { size } = useThrelte();
	const active = $derived($view2d.on && !$cameraPreview && !$specatorMode && $isLocked !== true);
	const aspect = $derived($size.width && $size.height ? $size.width / $size.height : 16 / 9);
	// the frustum is fixed at the height the view opened with; the wheel zooms (camera.zoom)
	const halfH = $derived($view2d.halfH);

	let controlsRef: any = $state(null);
	let cameraRef: any = $state(null);

	// seat the pair ONCE per mount (the refs are the only dependencies — the store is read
	// untracked, or the write-back below would re-run this forever)
	$effect(() => {
		const controls = controlsRef;
		const camera = cameraRef;
		if (!controls || !camera) return;
		const at = untrack(() => $view2d);
		controls.target.set(at.x, at.y, 0);
		camera.position.set(at.x, at.y, 100);
		camera.lookAt(at.x, at.y, 0);
		controls.update();
		controls.__view2d = true; // exit2dView waits for the perspective pair, not this one
		orbitControls.set(controls);
		return () => {
			// remember where the view was (a later 2D view resumes there) and dispose: an
			// OrbitControls that is merely dropped keeps its DOM listeners (the 16-Q5 zombie)
			view2d.update((v) => ({ ...v, x: controls.target.x, y: controls.target.y, halfH: v.halfH / Math.max(0.01, camera.zoom || 1) }));
			controls.dispose?.();
		};
	});

	// the frustum is OURS (`manual`): threlte otherwise resets an orthographic camera to the
	// canvas size in PIXELS (1 m = 1 px) on every resize
	$effect(() => {
		const camera = cameraRef;
		if (!camera) return;
		camera.left = -halfH * aspect;
		camera.right = halfH * aspect;
		camera.top = halfH;
		camera.bottom = -halfH;
		camera.updateProjectionMatrix();
	});

	// debug probe for the suites (opt-in, like __cameraPreviewDebug)
	$effect(() => {
		if (typeof window === 'undefined') return;
		(window as any).__view2dDebug = () => ({
			active,
			ortho: !!cameraRef?.isOrthographicCamera,
			pos: cameraRef ? [cameraRef.position.x, cameraRef.position.y, cameraRef.position.z] : null,
			zoom: cameraRef?.zoom ?? null,
			frustum: cameraRef ? [cameraRef.left, cameraRef.right, cameraRef.top, cameraRef.bottom] : null,
			rotate: controlsRef?.enableRotate ?? null
		});
	});
</script>

{#if active}
	<T.OrthographicCamera
		makeDefault
		manual
		left={-halfH * aspect}
		right={halfH * aspect}
		top={halfH}
		bottom={-halfH}
		near={0.1}
		far={1000}
		bind:ref={cameraRef}
	>
		<OrbitControls
			bind:ref={controlsRef}
			enableRotate={false}
			enableDamping
			screenSpacePanning
			minZoom={0.05}
			maxZoom={40}
			mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
			touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }}
		/>
	</T.OrthographicCamera>
{/if}

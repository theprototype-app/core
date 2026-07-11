<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrPaletteOpen, vrMenuHand, selectedObject } from '../../stores/sceneStore'
	import { vrPaletteGroup, vrPaletteLightness } from '$lib/vrControls'
	import { menuPoseFromController } from '$lib/vrRadialMenu'
	import { paletteTexture } from '$lib/vrPalette'

	// VR color palette (110): a hue/saturation disc + lightness bar. Holding
	// the pointer trigger over the disc paints the selection CONTINUOUSLY
	// (vrControls streams the color); the panel stays open until ✕.

	const { renderer } = useThrelte()

	const DISC_R = 0.085
	let group: any = $state(null)
	let texture: any = $state(null)

	$effect(() => {
		vrPaletteGroup.set($vrPaletteOpen ? group : null)
	})
	$effect(() => {
		if ($vrPaletteOpen && !texture) texture = paletteTexture(256)
	})

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.16, 0)
	let liveHex = $state('#ffffff')

	useTask(() => {
		if (!group || !$vrPaletteOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = [...session.inputSources].findIndex((s) => s.handedness === $vrMenuHand)
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		group.position.copy(pose.position).add(LIFT.clone().applyQuaternion(controllerQuaternion))
		group.quaternion.copy(pose.quaternion)
		const material: any = ($selectedObject as any)?.material
		if (material?.color) liveHex = '#' + material.color.getHexString()
	})
</script>

{#if $vrPaletteOpen}
	<T.Group bind:ref={group} name="vr-color-palette">
		<!-- backdrop -->
		<T.Mesh position={[0, -0.012, -0.004]}>
			<T.PlaneGeometry args={[DISC_R * 2 + 0.03, DISC_R * 2 + 0.085]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.88} side={THREE.DoubleSide} />
		</T.Mesh>
		<!-- hue/saturation disc -->
		<T.Mesh name="vrpalette-disc">
			<T.CircleGeometry args={[DISC_R, 48]} />
			{#if texture}
				<T.MeshBasicMaterial map={texture} side={THREE.DoubleSide} />
			{/if}
		</T.Mesh>
		<!-- lightness bar -->
		<T.Mesh name="vrpalette-bar" position={[0, -DISC_R - 0.02, 0]}>
			<T.PlaneGeometry args={[DISC_R * 2, 0.016]} />
			<T.MeshBasicMaterial color="#888888" side={THREE.DoubleSide} />
		</T.Mesh>
		<T.Mesh position={[-DISC_R + $vrPaletteLightness * DISC_R * 2, -DISC_R - 0.02, 0.002]}>
			<T.CircleGeometry args={[0.006, 16]} />
			<T.MeshBasicMaterial color="#ffffff" />
		</T.Mesh>
		<!-- live swatch + close -->
		<T.Mesh position={[-DISC_R + 0.012, DISC_R + 0.014, 0]}>
			<T.CircleGeometry args={[0.011, 20]} />
			<T.MeshBasicMaterial color={liveHex} side={THREE.DoubleSide} />
		</T.Mesh>
		<T.Mesh name="vrpalette-close" position={[DISC_R - 0.012, DISC_R + 0.014, 0]}>
			<T.CircleGeometry args={[0.011, 20]} />
			<T.MeshBasicMaterial color="#39404d" side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text="✕"
			color="#ffffff"
			fontSize={0.009}
			anchorX="center"
			anchorY="middle"
			position={[DISC_R - 0.012, DISC_R + 0.014, 0.002]}
		/>
		<Text
			text="hold trigger to paint"
			color="#9aa4b2"
			fontSize={0.0065}
			anchorX="center"
			anchorY="middle"
			position={[0, -DISC_R - 0.042, 0.002]}
		/>
	</T.Group>
{/if}

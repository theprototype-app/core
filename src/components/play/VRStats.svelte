<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrStatsOpen, vrMenuHand, objectsGroup } from '../../stores/sceneStore'
	import { userdata } from '../../stores/appStore'
	import { statsHand } from '$lib/vrRadialMenu'

	// VR statistics card (102): FPS + frame ms + draw calls + triangles +
	// object and peer counts on a small plate riding the POINTER controller
	// (the hand that does not open the radial menu — swaps automatically).
	// Toggled from System ▸ Statistics; the preference persists.

	const { renderer } = useThrelte()

	let group: any
	let lines = $state('')
	let frames = 0
	let last = typeof performance !== 'undefined' ? performance.now() : 0
	let acc = 0

	const pos = new THREE.Vector3()
	const quat = new THREE.Quaternion()
	const OFFSET = new THREE.Vector3(0, 0.045, -0.015)
	const TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI * 0.3)

	useTask(() => {
		if (!$vrStatsOpen || !group) return
		// stats refresh ~4x/s (readable, cheap) — runs headless too for tests
		frames++
		const now = performance.now()
		acc += now - last
		last = now
		if (acc >= 250) {
			const fps = Math.round((frames / acc) * 1000)
			const ms = (acc / frames).toFixed(1)
			const info = renderer.info.render
			const objects = $objectsGroup?.children.length ?? 0
			let meshes = 0
			$objectsGroup?.traverse((o: any) => {
				if (o.isMesh) meshes++
			})
			lines =
				`FPS ${fps} · ${ms} ms\n` +
				`draw ${info.calls} · tris ${info.triangles}\n` +
				`objects ${objects} (${meshes} meshes)\n` +
				// userdata includes ourselves — show CONNECTED peers
				`peers ${Math.max(0, ($userdata?.length ?? 1) - 1)}`
			frames = 0
			acc = 0
		}
		// the plate only poses (and shows) while presenting
		const session = renderer.xr.getSession()
		group.visible = !!session
		if (!session) return
		const index = [...session.inputSources].findIndex((s) => s.handedness === statsHand($vrMenuHand))
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(pos)
		controller.getWorldQuaternion(quat)
		group.position.copy(OFFSET.clone().applyQuaternion(quat).add(pos))
		group.quaternion.copy(quat.clone().multiply(TILT))
	})
</script>

{#if $vrStatsOpen}
	<T.Group bind:ref={group} name="vr-stats-card">
		<T.Mesh>
			<T.PlaneGeometry args={[0.115, 0.06]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.88} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text={lines}
			color="#9fe8a9"
			outlineColor="#000000"
			outlineWidth={0.0006}
			fontSize={0.0075}
			lineHeight={1.45}
			anchorX="center"
			anchorY="middle"
			position={[0, 0, 0.002]}
		/>
	</T.Group>
{/if}

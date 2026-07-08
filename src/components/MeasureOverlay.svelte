<script lang="ts">
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { measurement } from '$lib/measure'

	// Renders the current measurement: two point markers, a line and a
	// billboarded distance label at the midpoint.

	const { camera } = useThrelte()

	$: a = $measurement?.a ?? null
	$: b = $measurement?.b ?? null
	$: distance = a && b ? new THREE.Vector3().fromArray(a).distanceTo(new THREE.Vector3().fromArray(b)) : 0
	$: mid = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.25, (a[2] + b[2]) / 2] : [0, 0, 0]
	$: lineGeometry = (() => {
		const geometry = new THREE.BufferGeometry()
		if (a && b)
			geometry.setFromPoints([new THREE.Vector3().fromArray(a), new THREE.Vector3().fromArray(b)])
		return geometry
	})()

	let label: any
	const cameraPosition = new THREE.Vector3()
	useTask(() => {
		if (!label) return
		camera.current.getWorldPosition(cameraPosition)
		label.lookAt(cameraPosition)
	})
</script>

{#if a}
	<T.Mesh position={a}>
		<T.SphereGeometry args={[0.06, 10, 10]} />
		<T.MeshBasicMaterial color="#ff4000" depthTest={false} />
	</T.Mesh>
{/if}
{#if a && b}
	<T.Mesh position={b}>
		<T.SphereGeometry args={[0.06, 10, 10]} />
		<T.MeshBasicMaterial color="#ff4000" depthTest={false} />
	</T.Mesh>
	<T.Line geometry={lineGeometry}>
		<T.LineBasicMaterial color="#ff4000" depthTest={false} />
	</T.Line>
	<T.Group bind:ref={label} position={mid}>
		<Text
			color="#ffffff"
			outlineColor="#000000"
			outlineWidth={0.008}
			fontSize={0.22}
			anchorX="center"
			anchorY="middle"
			text={`${distance.toFixed(2)} m`}
		/>
	</T.Group>
{/if}

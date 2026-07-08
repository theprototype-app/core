<script lang="ts">
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { annotations, pinsGroup } from '$lib/annotationsHandler'
	import { objectsGroup } from '../stores/sceneStore'

	// Billboarded note pins. Each pin re-anchors to its object every frame
	// (objects move) and faces the camera.

	const { camera } = useThrelte()

	let root: any
	$: pinsGroup.set(root ?? null)

	const pinRefs: Record<string, any> = {}
	const local = new THREE.Vector3()
	const cameraPosition = new THREE.Vector3()

	useTask(() => {
		const group = $objectsGroup
		if (!group) return
		camera.current.getWorldPosition(cameraPosition)
		$annotations.forEach((annotation) => {
			const pin = pinRefs[annotation.id]
			const owner = group.getObjectByProperty('uuid', annotation.objectUuid)
			if (!pin || !owner) return
			owner.localToWorld(local.fromArray(annotation.offset))
			pin.position.copy(local)
			pin.lookAt(cameraPosition)
		})
	})
</script>

<T.Group bind:ref={root} name="annotation-pins">
	{#each $annotations as annotation, index (annotation.id)}
		<T.Group oncreate={({ ref }) => (pinRefs[annotation.id] = ref)} name={`pin-${annotation.id}`}>
			<T.Mesh>
				<T.CircleGeometry args={[0.16, 20]} />
				<T.MeshBasicMaterial color="#f59e0b" depthTest={false} side={THREE.DoubleSide} />
			</T.Mesh>
			<T.Mesh position={[0, -0.19, 0]}>
				<T.ConeGeometry args={[0.05, 0.12, 8]} />
				<T.MeshBasicMaterial color="#f59e0b" depthTest={false} />
			</T.Mesh>
			<Text
				color="#1c1917"
				fontSize={0.16}
				anchorX="center"
				anchorY="middle"
				position={[0, 0, 0.002]}
				text={String(index + 1)}
			/>
		</T.Group>
	{/each}
</T.Group>

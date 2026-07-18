<script lang="ts">
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { annotations, pinsGroup } from '$lib/annotationsHandler'
	import { objectsGroup, globalScene } from '../stores/sceneStore'

	// Billboarded note pins. Each pin re-anchors to its object every frame
	// (objects move) and faces the camera.

	const { camera } = useThrelte()

	let root: any
	$: pinsGroup.set(root ?? null)

	const pinRefs: Record<string, any> = {}
	const local = new THREE.Vector3()
	const cameraPosition = new THREE.Vector3()

	useTask(() => {
		camera.current.getWorldPosition(cameraPosition)
		$annotations.forEach((annotation) => {
			const pin = pinRefs[annotation.id]
			if (!pin) return
			// N1: resolve the owner from BOTH objectsGroup (normal objects) AND the scene
			// root (system/env/module objects, annotatable since 87) — mirrors
			// annotationsHandler.objectOf. Resolving from objectsGroup only left scene-root
			// pins stranded; resolving neither (the broken ref capture below) left ALL of
			// them at the origin, which was the reported "center of world" bug.
			const owner =
				$objectsGroup?.getObjectByProperty('uuid', annotation.objectUuid) ??
				$globalScene?.getObjectByProperty('uuid', annotation.objectUuid)
			if (!owner) {
				pin.visible = false // orphaned (object gone) — hide rather than sit at origin
				return
			}
			pin.visible = true
			owner.localToWorld(local.fromArray(annotation.offset))
			pin.position.copy(local)
			pin.lookAt(cameraPosition)
			// NOTE: pins are positioned in WORLD coords but this layer rides
			// world-grab-rig, so an ACTIVE VR world-grab would double-count. Left as a
			// separate follow-up (pre-existing; desktop + normal VR are unaffected).
		})
	})
</script>

<T.Group bind:ref={root} name="annotation-pins">
	{#each $annotations as annotation, index (annotation.id)}
		<T.Group oncreate={(ref) => (pinRefs[annotation.id] = ref)} name={`pin-${annotation.id}`}>
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

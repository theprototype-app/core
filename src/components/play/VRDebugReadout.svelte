<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore
	import { Text } from '@threlte/extras'
	import { isVRMode, vrDebugOverlay } from '../../stores/sceneStore'
	import { vrDebugSnapshot } from '$lib/vrControls'

	// 194-debug: head-locked readout of the live controller<->handedness mapping.
	// Watch it while placing controllers / switching to hands and back / reconnecting;
	// a wrong binding shows as a slot whose stamp != input, or a grip/grab on a slot
	// that does not match the acting hand. Toggle in VR Settings; remove after 194.

	const { renderer } = useThrelte()
	let group: any = $state(null)
	let lines = $state('CONTROLLER DEBUG')

	const p = new THREE.Vector3()
	const q = new THREE.Quaternion()
	const FWD = new THREE.Vector3(0, 0, -1)
	const DOWN = new THREE.Vector3(0, -1, 0)

	useTask(() => {
		if (!group || !$vrDebugOverlay || !renderer.xr.isPresenting) return
		const cam = renderer.xr.getCamera()
		cam.getWorldPosition(p)
		cam.getWorldQuaternion(q)
		group.position.copy(p).add(FWD.clone().applyQuaternion(q).multiplyScalar(0.75)).add(DOWN.clone().applyQuaternion(q).multiplyScalar(0.28))
		group.quaternion.copy(q)
		const s = vrDebugSnapshot()
		lines =
			'CONTROLLER DEBUG\n' +
			`slot0  in:${s.slot0.input}  stamp:${s.slot0.stamp}\n` +
			`slot1  in:${s.slot1.input}  stamp:${s.slot1.stamp}\n` +
			`menuHand:${s.menuHand}  menuIdx:${s.menuIdx}  ptrIdx:${s.pointerIdx}\n` +
			`L:${s.leftIdx}  R:${s.rightIdx}  grip:[${s.grip0 ? 1 : 0},${s.grip1 ? 1 : 0}]  grab:${s.grabIdx}`
	})
</script>

{#if $isVRMode && $vrDebugOverlay}
	<T.Group bind:ref={group}>
		<T.Mesh position={[0, 0, -0.002]}>
			<T.PlaneGeometry args={[0.4, 0.17]} />
			<T.MeshBasicMaterial color="#0b0e14" transparent opacity={0.85} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text={lines}
			color="#7cfc98"
			fontSize={0.014}
			lineHeight={1.35}
			anchorX="center"
			anchorY="middle"
			maxWidth={0.38}
			position={[0, 0, 0]}
		/>
	</T.Group>
{/if}

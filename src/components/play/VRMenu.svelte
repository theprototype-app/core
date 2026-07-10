<script lang="ts">
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrMenuOpen, vrMenuHand, vrTransformMode, showGrid, vrPassthrough, vrSnapAngle, selectedObject } from '../../stores/sceneStore'
	import { snapEnabled } from '$lib/snapping'
	import { drawMode } from '$lib/drawMode'
	import { vrMicMode, micActive } from '$lib/voiceChat'
	import { environment } from '$lib/environment'
	import { vrHovered, vrMenuGroup } from '$lib/vrControls'
	import { activeRing, ringEntries, ringVersion, sectorLayout, hubEntry, RING_INNER, RING_OUTER, HUB_RADIUS } from '$lib/vrRadialMenu'

	// The in-world radial menu (74): an 8-sector base ring above the menu-hand
	// controller with nested sub-rings; the other hand's ray or thumbstick
	// highlights a sector, trigger or stick-click activates (vrControls routes
	// input). The center hub is Close / Object ▸ / Back depending on context.

	const { renderer, camera } = useThrelte()

	let group: any

	$: vrMenuGroup.set($vrMenuOpen ? group : null)

	// sectors re-derive when the registry, the ring, or any state a built-in
	// entry displays changes (the listed stores are those states)
	$: sectors = deriveSectors(
		$activeRing,
		$ringVersion,
		$vrTransformMode,
		$snapEnabled,
		$showGrid,
		$drawMode,
		$vrMicMode,
		$micActive,
		$vrMenuHand,
		$vrPassthrough,
		$vrSnapAngle,
		$environment,
		$selectedObject
	)
	function deriveSectors(ring: string, ..._deps: any[]) {
		const entries = ringEntries(ring)
		return entries.map((entry: any, index: number) => ({
			entry,
			...sectorLayout(index, entries.length)
		}))
	}

	// selectedObject is [] when nothing is selected — presence = has a uuid
	$: hub = hubEntry($activeRing, !!$selectedObject?.uuid)

	function sectorColor(entry: any) {
		if ($vrHovered === entry.id) return '#ff4000'
		if (entry.color) return entry.color
		return entry.active?.() ? '#2f81f7' : '#2a2f38'
	}

	const controllerPosition = new THREE.Vector3()
	const cameraPosition = new THREE.Vector3()
	const followTarget = new THREE.Vector3()
	let snapNextFrame = true

	$: if (!$vrMenuOpen) snapNextFrame = true

	useTask(() => {
		if (!group || !$vrMenuOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = [...session.inputSources].findIndex((s) => s.handedness === $vrMenuHand)
		if (index < 0) return
		renderer.xr.getController(index).getWorldPosition(controllerPosition)
		followTarget.set(controllerPosition.x, controllerPosition.y + 0.32, controllerPosition.z)
		// damped follow (74.4): the ring trails the hand instead of jittering
		if (snapNextFrame) {
			group.position.copy(followTarget)
			snapNextFrame = false
		} else group.position.lerp(followTarget, 0.18)
		camera.current.getWorldPosition(cameraPosition)
		group.lookAt(cameraPosition)
	})
</script>

{#if $vrMenuOpen}
	<T.Group bind:ref={group} name="vr-quick-menu">
		<!-- backdrop disc -->
		<T.Mesh position={[0, 0, -0.006]}>
			<T.CircleGeometry args={[RING_OUTER + 0.03, 48]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.82} side={THREE.DoubleSide} />
		</T.Mesh>
		{#each sectors as s (s.entry.id)}
			<T.Mesh name={`vrmenu-${s.entry.id}`}>
				<T.RingGeometry args={[RING_INNER, RING_OUTER, 20, 1, s.thetaStart, s.thetaLength]} />
				<T.MeshBasicMaterial
					color={sectorColor(s.entry)}
					transparent
					opacity={0.94}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			{#if s.entry.label}
				<Text
					text={s.entry.label}
					color={$vrHovered === s.entry.id ? '#ffffff' : '#e8ecf2'}
					outlineColor="#000000"
					outlineWidth={0.0022}
					fontSize={sectors.length > 8 ? 0.02 : 0.024}
					anchorX="center"
					anchorY="middle"
					position={[s.labelX, s.labelY, 0.004]}
				/>
			{/if}
		{/each}
		<!-- center hub: Close / Object ▸ / Back -->
		<T.Mesh name={`vrmenu-${hub.id}`}>
			<T.CircleGeometry args={[HUB_RADIUS, 32]} />
			<T.MeshBasicMaterial
				color={$vrHovered === hub.id ? '#ff4000' : '#39404d'}
				transparent
				opacity={0.96}
				side={THREE.DoubleSide}
			/>
		</T.Mesh>
		<Text
			text={hub.label}
			color="#ffffff"
			outlineColor="#000000"
			outlineWidth={0.002}
			fontSize={0.018}
			anchorX="center"
			anchorY="middle"
			position={[0, 0, 0.004]}
		/>
	</T.Group>
{/if}

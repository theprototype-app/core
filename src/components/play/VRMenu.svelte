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
	import { vrHovered, vrMenuGroup, vrChatUnread, controllerIndexFor } from '$lib/vrControls'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { activeRing, ringEntries, ringVersion, sectorLayout, hubEntry, menuPoseFromController, RING_INNER, RING_OUTER, HUB_RADIUS } from '$lib/vrRadialMenu'

	// The in-world radial menu (74, anchored in 99): an 8-sector ring riding ON
	// the menu-hand controller — centered at the thumbstick, tilted into the
	// top-button plane, moving and rotating rigidly with the hand. It expands
	// FROM the controller on open. The other hand's ray or thumbstick
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
	const controllerQuaternion = new THREE.Quaternion()
	let openedAt = 0

	$: if (!$vrMenuOpen) openedAt = 0

	useTask(() => {
		if (!group || !$vrMenuOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = controllerIndexFor($vrMenuHand) // 194: by handedness, reorder-safe
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		// rigid attach (99): center at the thumbstick, tilted to the button plane;
		// a user offset from a window grab (111) composes on top
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		// expand FROM the controller on open (~120ms ease-out)
		if (!openedAt) openedAt = performance.now()
		const t = Math.min(1, (performance.now() - openedAt) / 120)
		const s = 0.05 + 0.95 * (1 - (1 - t) * (1 - t))
		applyWindowPose(group, 'menu', pose, s)
	})
</script>

{#if $vrMenuOpen}
	<T.Group bind:ref={group} name="vr-quick-menu">
		<!-- backdrop disc -->
		<T.Mesh position={[0, 0, -0.004]}>
			<T.CircleGeometry args={[RING_OUTER + 0.012, 48]} />
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
					outlineWidth={0.0012}
					fontSize={sectors.length > 8 ? 0.0095 : 0.0115}
					anchorX="center"
					anchorY="middle"
					position={[s.labelX, s.labelY, 0.003]}
				/>
			{/if}
			<!-- unread chat badge (117): a red dot + count on the Chat sector -->
			{#if s.entry.id === 'chat' && $vrChatUnread > 0}
				<T.Mesh name="vrmenu-chat-badge" position={[s.labelX + 0.014, s.labelY + 0.012, 0.004]}>
					<T.CircleGeometry args={[0.008, 20]} />
					<T.MeshBasicMaterial color="#e5484d" side={THREE.DoubleSide} />
				</T.Mesh>
				<Text
					text={$vrChatUnread > 9 ? '9+' : String($vrChatUnread)}
					color="#ffffff"
					fontSize={0.008}
					anchorX="center"
					anchorY="middle"
					position={[s.labelX + 0.014, s.labelY + 0.012, 0.005]}
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
			outlineWidth={0.001}
			fontSize={0.009}
			anchorX="center"
			anchorY="middle"
			position={[0, 0, 0.003]}
		/>
	</T.Group>
{/if}

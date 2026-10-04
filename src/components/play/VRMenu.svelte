<script lang="ts">
	import * as THREE from 'three'
	import { onDestroy } from 'svelte'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrMenuOpen, vrMenuHand, vrTransformMode, showGrid, vrPassthrough, vrSnapAngle, selectedObject, selectedObjects } from '../../stores/sceneStore'
	import { snapEnabled } from '$lib/snapping'
	import { drawMode } from '$lib/drawMode'
	import { vrMicMode, micActive } from '$lib/voiceChat'
	import { environment } from '$lib/environment'
	import { simulating, remoteSimulating } from '$lib/physics'
	import { vrHovered, vrMenuGroup, vrChatUnread, controllerIndexFor } from '$lib/vrControls'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { activeRing, ringEntries, ringVersion, sectorLayout, hubEntry, menuPoseFromController, RING_INNER, RING_OUTER, HUB_RADIUS, vrMenuPressed, ringTitle, radialTourId, entryLabel, entryIcon } from '$lib/vrRadialMenu'
	import { vrIconTexture } from '$lib/vr/icons.js'
	import { vrSettingsVersion } from '$lib/vr/settingsSchema.js'

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
		$simulating,
		$remoteSimulating, // PFX-C: the Physics sector label/dot tracks the sim
		$selectedObject,
		$selectedObjects, // D4: counted labels + Make Group re-derive on the SET
		$vrSettingsVersion // 36: a setting's value line follows any VR setting change
	)
	// 36: label / icon / value are resolved HERE (a function label read inside the template would be
	// untracked — the legacy-mode rule the 31 R1 note below describes)
	function deriveSectors(ring: string, ..._deps: any[]) {
		const entries = ringEntries(ring)
		const n = entries.length
		// the text box a sector can hold: its chord at the label radius, less a margin
		const rMid = (RING_INNER + RING_OUTER) / 2
		const chord = 2 * rMid * Math.sin(Math.PI / Math.max(n, 2)) * 0.88
		return entries.map((entry: any, index: number) => {
			const label = entryLabel(entry)
			const fontSize = n > 8 ? 0.0078 : 0.0088
			const maxWidth = Math.min(chord, 0.07)
			// will the label wrap? (troika lays text out later; ~0.55 em per glyph is close enough) — a
			// two-line label pushes the icon up and the value down so the three never collide
			const two = (label.length + (entry.ring ? 2 : 0)) * 0.55 * fontSize > maxWidth
			const value = entry.value ? entry.value() : ''
			const layout = sectorLayout(index, n)
			const shift = two ? 0.005 : 0
			return {
				entry,
				label,
				icon: entryIcon(entry),
				value,
				nav: !!entry.ring,
				maxWidth,
				fontSize,
				iconY: layout.labelY + (value ? 0.016 : 0.012) + shift,
				textY: layout.labelY + (value ? 0.006 : 0.002) + shift,
				valueY: layout.labelY - 0.012 - (two ? 0.007 : 0),
				...layout
			}
		})
	}
	$: title = ringTitle($activeRing)

	// 36 (R11): press feedback — the activated sector flashes for a moment
	let flashId = ''
	let flashTimer: any = null
	const offPressed = vrMenuPressed.subscribe((p) => {
		if (!p?.id) return
		flashId = p.id
		clearTimeout(flashTimer)
		flashTimer = setTimeout(() => (flashId = ''), 180)
	})
	onDestroy(() => {
		offPressed()
		clearTimeout(flashTimer)
	})
	/** stamp the T1 tour id on a sector mesh (onto userData, never replacing it) */
	function tourTag(id: string) {
		return (ref: any) => {
			if (ref) ref.userData.tour = radialTourId(id)
		}
	}

	// selectedObject is [] when nothing is selected — presence = has a uuid
	$: hub = hubEntry($activeRing, !!$selectedObject?.uuid)

	// 31 R1: the hovered id is a PARAMETER, never read inside. This file is legacy mode, where
	// `color={sectorColor(s.entry, $vrHovered)}` compiles to untrack(() => sectorColor(...)) depending on
	// `s` alone — so a $vrHovered read in here registered nothing and no sector ever lit up
	// under the stick or the ray (the hub, which reads it inline, did). The Quest report.
	function sectorColor(entry: any, hovered: string | null, flash: string) {
		if (entry.disabled?.()) return '#1b1f26' // D4: greyed out, hover never lights it
		if (flash === entry.id) return '#ffd2bf' // 36: the press flash
		if (hovered === entry.id) return '#ff4000'
		if (entry.color) return entry.color
		return entry.active?.() ? '#2f81f7' : '#2a2f38'
	}
	function labelColor(entry: any, hovered: string | null) {
		if (entry.disabled?.()) return '#6b7280'
		return hovered === entry.id ? '#ffffff' : '#e8ecf2'
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
			<T.CircleGeometry args={[RING_OUTER + 0.012, 64]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.86} side={THREE.DoubleSide} />
		</T.Mesh>
		<!-- 36: which ring this is (Settings ▸ Comfort reads "Comfort") -->
		{#if title}
			<Text
				text={title}
				color="#c9d1dc"
				outlineColor="#000000"
				outlineWidth={0.0008}
				fontSize={0.0085}
				anchorX="center"
				anchorY="bottom"
				position={[0, RING_OUTER + 0.016, 0.003]}
			/>
		{/if}
		{#each sectors as s (s.entry.id)}
			<!-- 36 (R11): the hovered sector lifts toward the eye -->
			<T.Mesh name={`vrmenu-${s.entry.id}`} position={[0, 0, $vrHovered === s.entry.id ? 0.002 : 0]} oncreate={tourTag(s.entry.id)}>
				<T.RingGeometry args={[RING_INNER, RING_OUTER, 24, 1, s.thetaStart, s.thetaLength]} />
				<T.MeshBasicMaterial
					color={sectorColor(s.entry, $vrHovered, flashId)}
					transparent
					opacity={0.94}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			<!-- 36 (R1): the desktop's icon for the same command, above the label -->
			{#if s.icon && vrIconTexture(s.icon)}
				<T.Mesh name={`vricon-${s.entry.id}`} position={[s.labelX, s.iconY, 0.0035]}>
					<T.PlaneGeometry args={[0.014, 0.014]} />
					<T.MeshBasicMaterial map={vrIconTexture(s.icon)} color={labelColor(s.entry, $vrHovered)} transparent depthWrite={false} side={THREE.DoubleSide} />
				</T.Mesh>
			{/if}
			{#if s.label}
				<Text
					text={s.nav ? s.label + ' ›' : s.label}
					color={labelColor(s.entry, $vrHovered)}
					outlineColor="#000000"
					outlineWidth={0.0009}
					fontSize={s.fontSize}
					maxWidth={s.maxWidth}
					textAlign="center"
					lineHeight={1.05}
					anchorX="center"
					anchorY={s.icon ? 'top' : 'middle'}
					position={[s.labelX, s.icon ? s.textY : s.labelY, 0.003]}
				/>
			{/if}
			{#if s.value}
				<Text
					text={s.value}
					color={$vrHovered === s.entry.id || s.entry.active?.() ? '#ffffff' : '#b4c4d6'}
					fontSize={0.0072}
					maxWidth={s.maxWidth}
					textAlign="center"
					anchorX="center"
					anchorY="top"
					position={[s.labelX, s.valueY, 0.003]}
				/>
			{/if}
			<!-- unread chat badge (117): a red dot + count on the Chat sector -->
			{#if s.entry.id === 'chat' && $vrChatUnread > 0}
				<T.Mesh name="vrmenu-chat-badge" position={[s.labelX + 0.016, s.labelY + 0.02, 0.004]}>
					<T.CircleGeometry args={[0.008, 20]} />
					<T.MeshBasicMaterial color="#e5484d" side={THREE.DoubleSide} />
				</T.Mesh>
				<Text
					text={$vrChatUnread > 9 ? '9+' : String($vrChatUnread)}
					color="#ffffff"
					fontSize={0.008}
					anchorX="center"
					anchorY="middle"
					position={[s.labelX + 0.016, s.labelY + 0.02, 0.005]}
				/>
			{/if}
		{/each}
		<!-- center hub: Close / Selected / Back (36: icon + word, the same in every ring) -->
		<T.Mesh name={`vrmenu-${hub.id}`} position={[0, 0, $vrHovered === hub.id ? 0.002 : 0]} oncreate={(ref: any) => ref && (ref.userData.tour = 'radial:hub')}>
			<T.CircleGeometry args={[HUB_RADIUS, 40]} />
			<T.MeshBasicMaterial
				color={flashId === hub.id ? '#ffd2bf' : $vrHovered === hub.id ? '#ff4000' : '#39404d'}
				transparent
				opacity={0.96}
				side={THREE.DoubleSide}
			/>
		</T.Mesh>
		{#if vrIconTexture(hub.icon)}
			<T.Mesh name="vricon-hub" position={[0, 0.006, 0.0035]}>
				<T.PlaneGeometry args={[0.013, 0.013]} />
				<T.MeshBasicMaterial map={vrIconTexture(hub.icon)} color="#ffffff" transparent depthWrite={false} side={THREE.DoubleSide} />
			</T.Mesh>
		{/if}
		<Text
			text={hub.label}
			color="#ffffff"
			outlineColor="#000000"
			outlineWidth={0.0007}
			fontSize={0.0062}
			anchorX="center"
			anchorY="middle"
			position={[0, -0.009, 0.003]}
		/>
	</T.Group>
{/if}

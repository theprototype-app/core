<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrPrefabsPanelOpen, vrPrefabsPinned } from '../../stores/sceneStore'
	import { vrHovered, vrPrefabsGroup, vrPrefabsCursor, vrPrefabGhost } from '$lib/vrControls'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { prefabs, loadPrefabs } from '$lib/prefabs'

	// VR prefabs window (115): a thumbnail grid over the local prefab library.
	// It LAZY-FOLLOWS the view at arm's length (smoothed); 📌 freezes it
	// world-fixed, unpin resumes following. Trigger on a cell arms a
	// translucent placement ghost on the pointer ray (vrControls owns it);
	// trigger in the world instantiates, grip cancels. The 111 grab applies.

	const { renderer } = useThrelte()

	const COLS = 2
	const CELL = 0.075
	const GAP = 0.012
	const VISIBLE_ROWS = 3
	const WIDTH = COLS * CELL + (COLS + 1) * GAP

	let group: any = $state(null)

	$effect(() => {
		vrPrefabsGroup.set($vrPrefabsPanelOpen ? group : null)
	})
	$effect(() => {
		if ($vrPrefabsPanelOpen) loadPrefabs()
		else vrPrefabsCursor.set(0)
	})

	// thumbnail textures cached per prefab id
	const textures = new Map<string, any>()
	function thumbTexture(prefab: any) {
		if (!prefab.thumbnail) return null
		let texture = textures.get(prefab.id)
		if (!texture) {
			texture = new THREE.TextureLoader().load(prefab.thumbnail)
			texture.colorSpace = THREE.SRGBColorSpace
			textures.set(prefab.id, texture)
		}
		return texture
	}

	const visibleCount = COLS * VISIBLE_ROWS
	const panelH = 0.045 + VISIBLE_ROWS * (CELL + GAP) + 0.03
	let cursor = $derived(Math.min(Math.max(0, $vrPrefabsCursor), Math.max(0, $prefabs.length - 1)))
	let start = $derived(
		Math.min(
			Math.floor(cursor / COLS) * COLS - (VISIBLE_ROWS - 1) * COLS < 0
				? 0
				: Math.floor(cursor / COLS) * COLS - (VISIBLE_ROWS - 1) * COLS,
			Math.max(0, Math.ceil($prefabs.length / COLS) * COLS - visibleCount)
		)
	)
	let cells = $derived(
		$prefabs.slice(start, start + visibleCount).map((prefab: any, i: number) => ({
			prefab,
			index: start + i,
			x: -WIDTH / 2 + GAP + CELL / 2 + (i % COLS) * (CELL + GAP),
			y: panelH / 2 - 0.045 - CELL / 2 - Math.floor(i / COLS) * (CELL + GAP)
		}))
	)

	// lazy-follow (quiz UX): the window drifts to arm's length ahead of the
	// view; pinning freezes the anchor (grab offsets still compose on top)
	const camPos = new THREE.Vector3()
	const camDir = new THREE.Vector3()
	const targetPos = new THREE.Vector3()
	const targetQuat = new THREE.Quaternion()
	const lookMatrix = new THREE.Matrix4()
	const smoothedPos = new THREE.Vector3()
	const smoothedQuat = new THREE.Quaternion()
	let following = false

	useTask((delta: number) => {
		if (!group || !$vrPrefabsPanelOpen) {
			following = false
			return
		}
		if (!renderer.xr.isPresenting) return
		const camera = renderer.xr.getCamera()
		camera.getWorldPosition(camPos)
		camera.getWorldDirection(camDir)
		camDir.y = 0
		if (camDir.lengthSq() < 1e-6) camDir.set(0, 0, -1)
		camDir.normalize()
		targetPos.copy(camPos).addScaledVector(camDir, 0.55)
		targetPos.y = camPos.y - 0.06
		lookMatrix.lookAt(camPos, targetPos, new THREE.Vector3(0, 1, 0))
		targetQuat.setFromRotationMatrix(lookMatrix)
		if (!$vrPrefabsPinned) {
			if (!following) {
				following = true
				smoothedPos.copy(targetPos)
				smoothedQuat.copy(targetQuat)
			} else {
				const t = 1 - Math.exp(-4 * delta)
				smoothedPos.lerp(targetPos, t)
				smoothedQuat.slerp(targetQuat, t)
			}
		}
		applyWindowPose(group, 'prefabs', { position: smoothedPos, quaternion: smoothedQuat })
	})

	function cellColor(prefab: any) {
		if ($vrHovered === 'prefabs:cell:' + prefab.id) return '#ff4000'
		if ($vrPrefabGhost?.id === prefab.id) return '#2f81f7'
		return '#2a2f38'
	}
</script>

{#if $vrPrefabsPanelOpen}
	<T.Group bind:ref={group} name="vr-prefabs-panel">
		<!-- backdrop -->
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.9} side={THREE.DoubleSide} />
		</T.Mesh>
		<!-- header: title · 📌 pin · ✕ -->
		<Text
			text={$vrPrefabGhost ? `Placing: ${$vrPrefabGhost.name}` : `Prefabs (${$prefabs.length})`}
			color="#e8ecf2"
			fontSize={0.01}
			anchorX="left"
			anchorY="middle"
			position={[-WIDTH / 2 + 0.006, panelH / 2 - 0.016, 0.002]}
		/>
		<T.Mesh name="vrprefabs-pin" position={[WIDTH / 2 - 0.036, panelH / 2 - 0.016, 0]}>
			<T.CircleGeometry args={[0.009, 20]} />
			<T.MeshBasicMaterial
				color={$vrPrefabsPinned ? '#2f81f7' : $vrHovered === 'prefabs:pin' ? '#ff4000' : '#39404d'}
				side={THREE.DoubleSide}
			/>
		</T.Mesh>
		<Text text="pin" color="#ffffff" fontSize={0.0065} anchorX="center" anchorY="middle"
			position={[WIDTH / 2 - 0.036, panelH / 2 - 0.016, 0.002]} />
		<T.Mesh name="vrprefabs-close" position={[WIDTH / 2 - 0.014, panelH / 2 - 0.016, 0]}>
			<T.CircleGeometry args={[0.009, 20]} />
			<T.MeshBasicMaterial
				color={$vrHovered === 'prefabs:close' ? '#ff4000' : '#39404d'}
				side={THREE.DoubleSide}
			/>
		</T.Mesh>
		<Text text="✕" color="#ffffff" fontSize={0.008} anchorX="center" anchorY="middle"
			position={[WIDTH / 2 - 0.014, panelH / 2 - 0.016, 0.002]} />

		{#if $prefabs.length === 0}
			<Text
				text={'No prefabs yet.\nEdit ▸ Save prefab adds the selection.'}
				color="#9aa4b2"
				fontSize={0.008}
				lineHeight={1.5}
				anchorX="center"
				anchorY="middle"
				position={[0, 0, 0.002]}
			/>
		{/if}
		{#each cells as cell (cell.prefab.id)}
			<!-- cursor ring -->
			{#if cursor === cell.index}
				<T.Mesh position={[cell.x, cell.y, -0.002]}>
					<T.PlaneGeometry args={[CELL + 0.008, CELL + 0.008]} />
					<T.MeshBasicMaterial color="#5a3a12" side={THREE.DoubleSide} />
				</T.Mesh>
			{/if}
			<T.Mesh name={`vrprefabs-cell:${cell.prefab.id}`} position={[cell.x, cell.y, -0.001]}>
				<T.PlaneGeometry args={[CELL, CELL]} />
				<T.MeshBasicMaterial color={cellColor(cell.prefab)} side={THREE.DoubleSide} />
			</T.Mesh>
			{#if cell.prefab.thumbnail}
				<T.Mesh position={[cell.x, cell.y + 0.006, 0.001]}>
					<T.PlaneGeometry args={[CELL - 0.014, CELL - 0.024]} />
					<T.MeshBasicMaterial map={thumbTexture(cell.prefab)} transparent side={THREE.DoubleSide} />
				</T.Mesh>
			{/if}
			<Text
				text={cell.prefab.name.length > 12 ? cell.prefab.name.slice(0, 11) + '…' : cell.prefab.name}
				color="#e8ecf2"
				fontSize={0.0065}
				anchorX="center"
				anchorY="middle"
				position={[cell.x, cell.y - CELL / 2 + 0.008, 0.002]}
			/>
		{/each}
		<Text
			text={$vrPrefabGhost ? 'trigger = place · grip = cancel' : 'trigger a tile to start placing'}
			color="#9aa4b2"
			fontSize={0.0065}
			anchorX="center"
			anchorY="middle"
			position={[0, -panelH / 2 + 0.012, 0.002]}
		/>
	</T.Group>
{/if}

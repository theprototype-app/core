<script lang="ts">
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrMenuOpen, vrMenuHand, vrTransformMode, showGrid, vrPassthrough } from '../../stores/sceneStore'
	import { snapEnabled } from '$lib/snapping'
	import { drawMode } from '$lib/drawMode'
	import { vrMicMode, micActive } from '$lib/voiceChat'
	import { vrHovered, vrMenuGroup } from '$lib/vrControls'

	// The in-world quick-menu: a small tile panel floating above the menu-hand
	// controller, facing the user. The other hand points at tiles and confirms
	// with the trigger (routed through Scene.svelte's select handler).

	const { renderer, camera } = useThrelte()

	let group: any

	$: vrMenuGroup.set($vrMenuOpen ? group : null)

	// tiles: [action, label, row, col]; active state is derived per-frame from stores
	$: tiles = [
		{ name: 'move', label: 'Move', active: $vrTransformMode === 'move' },
		{ name: 'rotate', label: 'Rotate', active: $vrTransformMode === 'rotate' },
		{ name: 'snap', label: 'Snap', active: $snapEnabled },
		{ name: 'grid', label: 'Grid', active: !!$showGrid },
		{ name: 'undo', label: 'Undo', active: false },
		{ name: 'redo', label: 'Redo', active: false },
		{ name: 'box', label: '+ Box', active: false },
		{ name: 'wedge', label: '+ Wedge', active: false },
		{ name: 'stairs', label: '+ Stairs', active: false },
		{ name: 'draw', label: 'Draw', active: $drawMode },
		{ name: 'mic', label: 'Mic: ' + ($vrMicMode === 'ptt' ? 'PTT' : $vrMicMode === 'open' ? 'Open' : 'Off'), active: $micActive },
		{ name: 'world', label: 'World 1:1', active: false },
		{ name: 'hand', label: $vrMenuHand === 'right' ? 'To left' : 'To right', active: false },
		{ name: 'passthru', label: 'Passthru', active: $vrPassthrough },
		{ name: 'exitvr', label: 'Exit VR', active: false },
		{ name: 'close', label: 'Close', active: false }
	].map((tile, index) => ({
		...tile,
		x: ((index % 4) - 1.5) * 0.1,
		y: 0.28 - Math.floor(index / 4) * 0.1
	}))

	function tileColor(tile: any) {
		if ($vrHovered === tile.name) return '#ff4000'
		return tile.active ? '#2f81f7' : '#2a2f38'
	}

	const controllerPosition = new THREE.Vector3()
	const cameraPosition = new THREE.Vector3()

	useTask(() => {
		if (!group || !$vrMenuOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = [...session.inputSources].findIndex((s) => s.handedness === $vrMenuHand)
		if (index < 0) return
		renderer.xr.getController(index).getWorldPosition(controllerPosition)
		group.position.set(controllerPosition.x, controllerPosition.y + 0.25, controllerPosition.z)
		camera.current.getWorldPosition(cameraPosition)
		group.lookAt(cameraPosition)
	})
</script>

{#if $vrMenuOpen}
	<T.Group bind:ref={group} name="vr-quick-menu">
		<!-- backdrop panel -->
		<T.Mesh position={[0, 0.13, -0.005]}>
			<T.PlaneGeometry args={[0.46, 0.42]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.85} side={THREE.DoubleSide} />
		</T.Mesh>
		{#each tiles as tile (tile.name)}
			<T.Group position={[tile.x, tile.y, 0]}>
				<T.Mesh name={`vrmenu-${tile.name}`}>
					<T.PlaneGeometry args={[0.09, 0.09]} />
					<T.MeshBasicMaterial color={tileColor(tile)} side={THREE.DoubleSide} />
				</T.Mesh>
				<Text
					color="white"
					fontSize={0.02}
					anchorX="center"
					anchorY="middle"
					position={[0, 0, 0.004]}
					text={tile.label}
				/>
			</T.Group>
		{/each}
	</T.Group>
{/if}

<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrSnapMenuOpen, vrSnapMode, vrMenuHand } from '../../stores/sceneStore'
	import { vrHovered, vrSnapGroup, controllerIndexFor } from '$lib/vrControls'
	import { snapSettings } from '$lib/snapping'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'

	// VR Snap side-menu (156, reworked into tabs in 181): Off | Grid | Surface |
	// Rotation as a horizontal TAB bar with the active mode lit; Grid + Rotation
	// expand to their sub-values below; an ✕ close in the corner (was a "Done"
	// row). Control meshes stay named vrsnap-<full action> for the raycast; the
	// 111 grab applies (id snapmenu).

	const { renderer } = useThrelte()

	const WIDTH = 0.22
	const ROW_H = 0.026
	const TAB_H = 0.03

	let group: any = $state(null)
	$effect(() => {
		vrSnapGroup.set($vrSnapMenuOpen ? group : null)
	})

	type Row = { action: string; label: string; active?: boolean; sub?: boolean; danger?: boolean }
	// the four mode TABS (horizontal bar)
	let modeTabs = $derived<Row[]>([
		{ action: 'snap:mode:off', label: 'Off', active: $vrSnapMode === 'off' },
		{ action: 'snap:mode:grid', label: 'Grid', active: $vrSnapMode === 'grid' },
		{ action: 'snap:mode:surface', label: 'Surface', active: $vrSnapMode === 'surface' },
		{ action: 'snap:mode:rotation', label: 'Rotation', active: $vrSnapMode === 'rotation' }
	])
	// the active tab's sub-values (grid steps / rotation angles), vertical
	let subRows = $derived.by(() => {
		const mode = $vrSnapMode
		const t = $snapSettings.translate
		const r = $snapSettings.rotateDeg
		const list: Row[] = []
		if (mode === 'grid') {
			for (const v of [0.1, 0.5, 1])
				list.push({ action: `snap:grid:${v}`, label: `${v}`, sub: true, active: Math.abs(t - v) < 1e-6 })
		} else if (mode === 'rotation') {
			for (const v of [15, 30, 45])
				list.push({ action: `snap:rot:${v}`, label: `${v}°`, sub: true, active: r === v })
			list.push({ action: 'snap:rot:reset', label: '↺ Reset', sub: true })
		}
		return list
	})
	let panelH = $derived(0.024 + TAB_H + 0.008 + subRows.length * ROW_H + 0.02)

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.14, 0)

	useTask(() => {
		if (!group || !$vrSnapMenuOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = controllerIndexFor($vrMenuHand) // 194/210: by handedness, reorder-safe
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		pose.position.add(LIFT.clone().applyQuaternion(controllerQuaternion))
		applyWindowPose(group, 'snapmenu', pose)
	})

	function rowColor(row: Row) {
		if ($vrHovered === row.action) return '#ff4000'
		if (row.active) return '#2f81f7'
		if (row.danger) return '#5a2a2a'
		if (row.sub) return '#1f2530'
		return '#2a2f38'
	}
	const TAB_GAP = 0.004
	let tabW = $derived((WIDTH - TAB_GAP * 3) / 4)
	function tabX(i: number) {
		return -WIDTH / 2 + tabW / 2 + i * (tabW + TAB_GAP)
	}
	let titleY = $derived(panelH / 2 - 0.011)
	let tabY = $derived(panelH / 2 - 0.026 - TAB_H / 2)
	function subY(i: number) {
		return tabY - TAB_H / 2 - 0.008 - ROW_H / 2 - i * ROW_H
	}
</script>

{#if $vrSnapMenuOpen}
	<T.Group bind:ref={group} name="vr-snap-menu">
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.9} side={THREE.DoubleSide} />
		</T.Mesh>

		<!-- title -->
		<Text text={'Snap'} color="#e8ecf2" fontSize={0.01} anchorX="left" anchorY="middle" position={[-WIDTH / 2, titleY, 0.002]} />

		<!-- ✕ close (was the "Done" row) -->
		<T.Mesh name="vrsnap-snap:close" position={[WIDTH / 2 - 0.011, titleY, 0]}>
			<T.PlaneGeometry args={[0.022, 0.022]} />
			<T.MeshBasicMaterial color={rowColor({ action: 'snap:close', label: '', danger: true })} transparent opacity={0.95} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text text="✕" color="#e8a0a0" fontSize={0.011} anchorX="center" anchorY="middle" position={[WIDTH / 2 - 0.011, titleY, 0.002]} />

		<!-- mode TAB bar (horizontal) -->
		{#each modeTabs as tab, i (tab.action)}
			<T.Mesh name={`vrsnap-${tab.action}`} position={[tabX(i), tabY, 0]}>
				<T.PlaneGeometry args={[tabW, TAB_H - 0.004]} />
				<T.MeshBasicMaterial color={rowColor(tab)} transparent opacity={0.95} side={THREE.DoubleSide} />
			</T.Mesh>
			<Text text={tab.label} color="#e8ecf2" fontSize={0.0075} anchorX="center" anchorY="middle" position={[tabX(i), tabY, 0.002]} />
		{/each}

		<!-- active tab's sub-values (vertical) -->
		{#each subRows as row, i (row.action)}
			<T.Mesh name={`vrsnap-${row.action}`} position={[0, subY(i), 0]}>
				<T.PlaneGeometry args={[WIDTH - 0.03, ROW_H - 0.004]} />
				<T.MeshBasicMaterial color={rowColor(row)} transparent opacity={0.95} side={THREE.DoubleSide} />
			</T.Mesh>
			<Text
				text={(row.active ? '● ' : '') + row.label}
				color="#e8ecf2"
				fontSize={0.008}
				anchorX="center"
				anchorY="middle"
				position={[0, subY(i), 0.002]}
			/>
		{/each}
	</T.Group>
{/if}

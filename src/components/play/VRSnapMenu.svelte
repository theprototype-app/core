<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrSnapMenuOpen, vrSnapMode, vrMenuHand } from '../../stores/sceneStore'
	import { vrHovered, vrSnapGroup } from '$lib/vrControls'
	import { snapSettings } from '$lib/snapping'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'

	// VR Snap side-menu (156): the Edit ▸ Snap toggle opens this controller-stuck
	// list — Off / Grid / Surface / Rotation, the active mode lit. Grid + Rotation
	// expand to their sub-values (grid step / rotate angle + Reset). Control meshes
	// are named vrsnap-<full action> for the vrControls raycast; the 111 grab
	// applies (id snapmenu).

	const { renderer } = useThrelte()

	const WIDTH = 0.22
	const ROW_H = 0.026

	let group: any = $state(null)
	$effect(() => {
		vrSnapGroup.set($vrSnapMenuOpen ? group : null)
	})

	type Row = { action: string; label: string; active?: boolean; sub?: boolean; danger?: boolean }
	let rows = $derived.by(() => {
		const mode = $vrSnapMode
		const t = $snapSettings.translate
		const r = $snapSettings.rotateDeg
		const list: Row[] = [{ action: 'snap:mode:off', label: 'Off', active: mode === 'off' }]
		list.push({ action: 'snap:mode:grid', label: 'Grid', active: mode === 'grid' })
		if (mode === 'grid') {
			for (const v of [0.1, 0.5, 1]) {
				list.push({ action: `snap:grid:${v}`, label: `   ${v}`, sub: true, active: Math.abs(t - v) < 1e-6 })
			}
		}
		list.push({ action: 'snap:mode:surface', label: 'Surface', active: mode === 'surface' })
		list.push({ action: 'snap:mode:rotation', label: 'Rotation', active: mode === 'rotation' })
		if (mode === 'rotation') {
			for (const v of [15, 30, 45]) {
				list.push({ action: `snap:rot:${v}`, label: `   ${v}°`, sub: true, active: r === v })
			}
			list.push({ action: 'snap:rot:reset', label: '   ↺ Reset', sub: true })
		}
		list.push({ action: 'snap:close', label: '✕ Done', danger: true })
		return list
	})
	let panelH = $derived(rows.length * ROW_H + 0.05)

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.14, 0)

	useTask(() => {
		if (!group || !$vrSnapMenuOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = [...session.inputSources].findIndex((s) => s.handedness === $vrMenuHand)
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
	function rowY(i: number) {
		return panelH / 2 - ROW_H * 1.1 - i * ROW_H
	}
</script>

{#if $vrSnapMenuOpen}
	<T.Group bind:ref={group} name="vr-snap-menu">
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.9} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text={'Snap · ' + $vrSnapMode}
			color="#e8ecf2"
			fontSize={0.01}
			anchorX="center"
			anchorY="middle"
			position={[0, panelH / 2 - ROW_H * 0.45, 0.002]}
		/>
		{#each rows as row (row.action)}
			<T.Mesh name={`vrsnap-${row.action}`} position={[0, rowY(rows.indexOf(row)), 0]}>
				<T.PlaneGeometry args={[row.sub ? WIDTH - 0.03 : WIDTH, ROW_H - 0.004]} />
				<T.MeshBasicMaterial color={rowColor(row)} transparent opacity={0.95} side={THREE.DoubleSide} />
			</T.Mesh>
			<Text
				text={(row.active ? '● ' : '') + row.label}
				color={row.danger ? '#e8a0a0' : '#e8ecf2'}
				fontSize={row.sub ? 0.008 : 0.009}
				anchorX="center"
				anchorY="middle"
				position={[0, rowY(rows.indexOf(row)), 0.002]}
			/>
		{/each}
	</T.Group>
{/if}

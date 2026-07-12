<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import {
		vrSettingsPanelOpen,
		vrMenuHand,
		vrTeleportEnabled,
		vrMirrorSnapTurn,
		vrSnapAngle,
		vrVertexHold,
		vrPassthrough
	} from '../../stores/sceneStore'
	import { vrHovered, vrSettingsGroup } from '$lib/vrControls'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'

	// VR Settings panel (187): a controller-stuck replica of the desktop VR
	// settings — teleport / mirror snap / snap angle / vertex-grab style /
	// passthrough (+ restart note) / reset panel positions. Control meshes are
	// named vrsettings-<full action> for the vrControls raycast; grabbable (id
	// settingspanel).

	const { renderer } = useThrelte()

	const WIDTH = 0.26
	const ROW_H = 0.03

	let group: any = $state(null)
	$effect(() => {
		vrSettingsGroup.set($vrSettingsPanelOpen ? group : null)
	})

	type Row = { action: string; label: string; active?: boolean; toggle?: boolean; danger?: boolean }
	let rows = $derived<Row[]>([
		{ action: 'settings:teleport', label: 'Teleport', toggle: true, active: $vrTeleportEnabled },
		{ action: 'settings:mirror', label: 'Mirror snap turn', toggle: true, active: $vrMirrorSnapTurn },
		{ action: 'settings:angle', label: 'Snap turn: ' + ($vrSnapAngle ? $vrSnapAngle + ' deg' : 'Off') },
		{ action: 'settings:vertexhold', label: 'Hold to move vertex', toggle: true, active: $vrVertexHold },
		{ action: 'settings:passthrough', label: 'Passthrough', toggle: true, active: $vrPassthrough },
		{ action: 'settings:resetpanels', label: 'Reset panel positions' },
		{ action: 'settings:close', label: 'Close', danger: true }
	])
	let panelH = $derived(rows.length * ROW_H + 0.06)

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.16, 0)

	useTask(() => {
		if (!group || !$vrSettingsPanelOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = [...session.inputSources].findIndex((s) => s.handedness === $vrMenuHand)
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		pose.position.add(LIFT.clone().applyQuaternion(controllerQuaternion))
		applyWindowPose(group, 'settingspanel', pose)
	})

	function rowColor(row: Row) {
		if ($vrHovered === row.action) return '#ff4000'
		if (row.toggle && row.active) return '#2f81f7'
		if (row.danger) return '#5a2a2a'
		return '#2a2f38'
	}
	function rowLabel(row: Row) {
		if (row.toggle) return (row.active ? '[x] ' : '[ ] ') + row.label
		return row.label
	}
	function rowY(i: number) {
		return panelH / 2 - ROW_H * 1.35 - i * ROW_H
	}
</script>

{#if $vrSettingsPanelOpen}
	<T.Group bind:ref={group} name="vr-settings-panel">
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.92} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text={'VR Settings'}
			color="#e8ecf2"
			fontSize={0.011}
			anchorX="center"
			anchorY="middle"
			position={[0, panelH / 2 - ROW_H * 0.5, 0.002]}
		/>
		{#each rows as row (row.action)}
			<T.Mesh name={`vrsettings-${row.action}`} position={[0, rowY(rows.indexOf(row)), 0]}>
				<T.PlaneGeometry args={[WIDTH, ROW_H - 0.004]} />
				<T.MeshBasicMaterial color={rowColor(row)} transparent opacity={0.95} side={THREE.DoubleSide} />
			</T.Mesh>
			<Text
				text={rowLabel(row)}
				color={row.danger ? '#e8a0a0' : '#e8ecf2'}
				fontSize={0.0085}
				anchorX="center"
				anchorY="middle"
				position={[0, rowY(rows.indexOf(row)), 0.002]}
			/>
		{/each}
		{#if $vrPassthrough}
			<Text
				text={'(restart VR to apply passthrough)'}
				color="#8a93a0"
				fontSize={0.006}
				anchorX="center"
				anchorY="middle"
				position={[0, -panelH / 2 + 0.012, 0.002]}
			/>
		{/if}
	</T.Group>
{/if}

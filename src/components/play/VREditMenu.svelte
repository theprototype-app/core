<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrEditMenuOpen, vrMenuHand, vrStretchObject, vrStretchAxis } from '../../stores/sceneStore'
	import { vrHovered, vrEditGroup } from '$lib/vrControls'
	import { editingObject } from '$lib/meshEdit'
	import { faceEditObject, faceEditOp } from '$lib/faceEdit'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'

	// VR Edit Mesh side-menu (137): a NON-radial list stuck to the menu hand —
	// mode rows (Vertices/Faces, active lit) + the active mode's tools. Control
	// meshes are named vredit-<full action> for the vrControls raycast; the
	// 111 grab/persist applies (id editmenu).

	const { renderer } = useThrelte()

	const WIDTH = 0.22
	const ROW_H = 0.026

	let group: any = $state(null)
	$effect(() => {
		vrEditGroup.set($vrEditMenuOpen ? group : null)
	})

	// active mode from which edit session is live
	let mode = $derived(
		$faceEditObject ? 'faces' : $editingObject ? 'vertices' : $vrStretchObject ? 'stretch' : 'none'
	)

	// rows: three mode toggles, then the active mode's tools + a close row
	type Row = { action: string; label: string; active?: boolean; danger?: boolean }
	let rows = $derived.by(() => {
		const list: Row[] = [
			{ action: 'edit:mode:vertices', label: 'Vertices', active: mode === 'vertices' },
			{ action: 'edit:mode:faces', label: 'Faces', active: mode === 'faces' },
			{ action: 'edit:mode:stretch', label: 'Stretch', active: mode === 'stretch' }
		]
		if (mode === 'faces') {
			const op = $faceEditOp
			list.push(
				{ action: 'face:extrude', label: 'Extrude', active: op === 'extrude' },
				{ action: 'face:inset', label: 'Inset', active: op === 'inset' },
				{ action: 'face:move', label: 'Move', active: op === 'move' },
				{ action: 'face:delete', label: 'Delete', active: op === 'delete', danger: true }
			)
		} else if (mode === 'stretch') {
			// pick the axis; the joystick then resizes that extent
			;['Width', 'Height', 'Depth'].forEach((label, axis) =>
				list.push({ action: `stretch:axis:${axis}`, label, active: $vrStretchAxis === axis })
			)
		}
		list.push({ action: 'edit:close', label: '✕ Done', danger: true })
		return list
	})
	let panelH = $derived(rows.length * ROW_H + 0.05)

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.14, 0)

	useTask(() => {
		if (!group || !$vrEditMenuOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = [...session.inputSources].findIndex((s) => s.handedness === $vrMenuHand)
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		pose.position.add(LIFT.clone().applyQuaternion(controllerQuaternion))
		applyWindowPose(group, 'editmenu', pose)
	})

	function rowColor(row: Row) {
		if ($vrHovered === row.action) return '#ff4000'
		if (row.active) return '#2f81f7'
		if (row.danger) return '#5a2a2a'
		return '#2a2f38'
	}
	function rowY(i: number) {
		return panelH / 2 - ROW_H * 1.1 - i * ROW_H
	}
</script>

{#if $vrEditMenuOpen}
	<T.Group bind:ref={group} name="vr-edit-menu">
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.9} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text={'Edit Mesh · ' + (mode === 'none' ? '' : mode)}
			color="#e8ecf2"
			fontSize={0.01}
			anchorX="center"
			anchorY="middle"
			position={[0, panelH / 2 - ROW_H * 0.45, 0.002]}
		/>
		{#each rows as row (row.action)}
			<T.Mesh name={`vredit-${row.action}`} position={[0, rowY(rows.indexOf(row)), 0]}>
				<T.PlaneGeometry args={[WIDTH, ROW_H - 0.004]} />
				<T.MeshBasicMaterial color={rowColor(row)} transparent opacity={0.95} side={THREE.DoubleSide} />
			</T.Mesh>
			<Text
				text={(row.active ? '● ' : '') + row.label}
				color={row.danger ? '#e8a0a0' : '#e8ecf2'}
				fontSize={0.009}
				anchorX="center"
				anchorY="middle"
				position={[0, rowY(rows.indexOf(row)), 0.002]}
			/>
		{/each}
	</T.Group>
{/if}

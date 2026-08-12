<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrEditMenuOpen, vrMenuHand, vrStretchObject, vrStretchFactors } from '../../stores/sceneStore'
	import { vrHovered, vrEditGroup, vrFaceCreateMode, controllerIndexFor } from '$lib/vrControls'
	import { editingObject, vertexSelectionSize } from '$lib/meshEdit'
	import { faceEditObject, faceEditOp, faceEditGranularity, faceEditMulti, faceEditSelectedTris } from '$lib/faceEdit'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'

	// VR Edit Mesh side-menu (137, reworked into tabs in 181): a horizontal
	// Vertices | Faces | Stretch TAB bar with the active tab lit, an ✕ close in
	// the corner (replaced the "Done" row), and the active mode's tools below.
	// Control meshes stay named vredit-<full action> for the vrControls raycast;
	// the 111 grab/persist applies (id editmenu).

	// 15-G: one label map instead of a nested ternary — that ternary predated
	// 'object' and would have shown BOTH 'quad' and 'object' as "Triangle"
	const GRAN_LABELS: Record<string, string> = {
		quad: 'Quad',
		face: 'Face',
		triangle: 'Triangle',
		shell: 'Shell',
		object: 'Object'
	}

	const { renderer } = useThrelte()

	const WIDTH = 0.22
	const ROW_H = 0.026
	const TAB_H = 0.03

	let group: any = $state(null)
	$effect(() => {
		vrEditGroup.set($vrEditMenuOpen ? group : null)
	})

	// active mode from which edit session is live
	let mode = $derived(
		$faceEditObject ? 'faces' : $editingObject ? 'vertices' : $vrStretchObject ? 'stretch' : 'none'
	)

	type Row = { action: string; label: string; active?: boolean; danger?: boolean }
	// the three mode TABS (horizontal bar)
	let modeTabs = $derived<Row[]>([
		{ action: 'edit:mode:vertices', label: 'Vertices', active: mode === 'vertices' },
		{ action: 'edit:mode:faces', label: 'Faces', active: mode === 'faces' },
		{ action: 'edit:mode:stretch', label: 'Stretch', active: mode === 'stretch' }
	])
	// the active tab's tools (vertical list below the tab bar)
	let toolRows = $derived.by(() => {
		const list: Row[] = []
		if (mode === 'faces') {
			const op = $faceEditOp
			// 212: granularity + multi toggles above the ops
			const nSel = $faceEditSelectedTris.length
			list.push(
				{ action: 'edit:granularity', label: `Select: ${GRAN_LABELS[$faceEditGranularity] ?? 'Quad'}`, active: $faceEditGranularity !== 'quad' },
				{ action: 'edit:multi', label: `Multi: ${$faceEditMulti ? 'On' : 'Off'}${$faceEditMulti && nSel ? ` (${nSel})` : ''}`, active: $faceEditMulti },
				{ action: 'face:extrude', label: 'Extrude', active: op === 'extrude' },
				{ action: 'face:inset', label: 'Inset', active: op === 'inset' },
				{ action: 'face:move', label: 'Move', active: op === 'move' },
				{ action: 'face:delete', label: 'Delete', active: op === 'delete', danger: true }
			)
		} else if (mode === 'vertices') {
			// 183: create a face from 3-4 trigger-tapped vertices
			const n = $vertexSelectionSize
			const creating = $vrFaceCreateMode
			const label = creating ? (n >= 3 && n <= 4 ? `Build face (${n})` : `Select verts (${n})`) : 'Create face'
			list.push({ action: 'edit:createface', label, active: creating })
		}
		return list
	})
	// stretch shows 3 sliders in place of tool rows (193)
	let bodyRows = $derived(mode === 'stretch' ? 3 : toolRows.length)
	let panelH = $derived(0.024 + TAB_H + 0.008 + bodyRows * ROW_H + 0.02)
	const AXES = ['W', 'H', 'D']

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.14, 0)

	useTask(() => {
		if (!group || !$vrEditMenuOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = controllerIndexFor($vrMenuHand) // 194: by handedness, reorder-safe
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
	// tab bar geometry (horizontal)
	const TAB_GAP = 0.004
	let tabW = $derived((WIDTH - TAB_GAP * 2) / 3)
	function tabX(i: number) {
		return (i - 1) * (tabW + TAB_GAP)
	}
	let titleY = $derived(panelH / 2 - 0.011)
	let tabY = $derived(panelH / 2 - 0.026 - TAB_H / 2)
	function toolY(i: number) {
		return tabY - TAB_H / 2 - 0.008 - ROW_H / 2 - i * ROW_H
	}
</script>

{#if $vrEditMenuOpen}
	<T.Group bind:ref={group} name="vr-edit-menu">
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.9} side={THREE.DoubleSide} />
		</T.Mesh>

		<!-- title -->
		<Text
			text={'Edit Mesh'}
			color="#e8ecf2"
			fontSize={0.01}
			anchorX="left"
			anchorY="middle"
			position={[-WIDTH / 2, titleY, 0.002]}
		/>

		<!-- ✕ close (was the "Done" row) -->
		<T.Mesh name="vredit-edit:close" position={[WIDTH / 2 - 0.011, titleY, 0]}>
			<T.PlaneGeometry args={[0.022, 0.022]} />
			<T.MeshBasicMaterial color={rowColor({ action: 'edit:close', label: '', danger: true })} transparent opacity={0.95} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text text="✕" color="#e8a0a0" fontSize={0.011} anchorX="center" anchorY="middle" position={[WIDTH / 2 - 0.011, titleY, 0.002]} />

		<!-- mode TAB bar (horizontal) -->
		{#each modeTabs as tab, i (tab.action)}
			<T.Mesh name={`vredit-${tab.action}`} position={[tabX(i), tabY, 0]}>
				<T.PlaneGeometry args={[tabW, TAB_H - 0.004]} />
				<T.MeshBasicMaterial color={rowColor(tab)} transparent opacity={0.95} side={THREE.DoubleSide} />
			</T.Mesh>
			<Text
				text={tab.label}
				color="#e8ecf2"
				fontSize={0.0085}
				anchorX="center"
				anchorY="middle"
				position={[tabX(i), tabY, 0.002]}
			/>
		{/each}

		<!-- active tab's tools (vertical) -->
		{#each toolRows as row, i (row.action)}
			<T.Mesh name={`vredit-${row.action}`} position={[0, toolY(i), 0]}>
				<T.PlaneGeometry args={[WIDTH, ROW_H - 0.004]} />
				<T.MeshBasicMaterial color={rowColor(row)} transparent opacity={0.95} side={THREE.DoubleSide} />
			</T.Mesh>
			<Text
				text={(row.active ? '● ' : '') + row.label}
				color={row.danger ? '#e8a0a0' : '#e8ecf2'}
				fontSize={0.009}
				anchorX="center"
				anchorY="middle"
				position={[0, toolY(i), 0.002]}
			/>
		{/each}

		<!-- 193: stretch = three W/H/D infinite sliders (grab a handle + move the
		     controller horizontally to scale that axis live) -->
		{#if mode === 'stretch'}
			{#each AXES as ax, i (ax)}
				<T.Mesh position={[0.03, toolY(i), -0.001]}>
					<T.PlaneGeometry args={[WIDTH - 0.06, 0.004]} />
					<T.MeshBasicMaterial color="#2a2f38" side={THREE.DoubleSide} />
				</T.Mesh>
				<T.Mesh name={`vrstretch-${i}`} position={[0.03, toolY(i), 0]}>
					<T.PlaneGeometry args={[0.05, ROW_H - 0.006]} />
					<T.MeshBasicMaterial color="#2f81f7" transparent opacity={0.95} side={THREE.DoubleSide} />
				</T.Mesh>
				<Text
					text={ax + ' ' + $vrStretchFactors[i].toFixed(2) + 'x'}
					color="#e8ecf2"
					fontSize={0.0075}
					anchorX="left"
					anchorY="middle"
					position={[-WIDTH / 2, toolY(i), 0.002]}
				/>
			{/each}
		{/if}
	</T.Group>
{/if}

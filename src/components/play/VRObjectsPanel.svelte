<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrObjectsPanelOpen, vrMenuHand, objectsGroup, lockedObjects, selectedObject } from '../../stores/sceneStore'
	import { vrHovered, vrPanelGroup, vrPanelCursor, vrPanelCursorAction } from '$lib/vrControls'
	import { menuPoseFromController } from '$lib/vrRadialMenu'
	import { peerColor } from '$lib/lockControl'

	// Native VR objects panel (101, quiz: no HTMLMesh): a floating plate above
	// the menu-hand controller listing the scene's top-level objects. The
	// pointer hand's ray highlights rows, trigger selects (and closes), the
	// pointer stick scrolls. Rows are named vrpanel-* for the vrControls
	// raycast; actions route through executeVRMenuAction ('panel:...').

	const { renderer } = useThrelte()

	const ROWS = 8
	const ROW_H = 0.03
	const WIDTH = 0.26

	let group: any = null

	$: vrPanelGroup.set($vrObjectsPanelOpen ? group : null)
	$: if (!$vrObjectsPanelOpen) vrPanelCursor.set(0)

	const TYPE_ICONS: Record<string, string> = {
		Mesh: '▣',
		Group: '⧉',
		Line: '✎'
	}
	function iconFor(child: any) {
		if (child.type?.endsWith('Light')) return '☀'
		return TYPE_ICONS[child.type] ?? '▪'
	}

	$: children = ($objectsGroup?.children ?? []) as any[]
	$: maxScroll = Math.max(0, children.length - ROWS)
	// the stick moves a ROW CURSOR (109.4); the page scrolls to keep it visible
	$: cursor = Math.min(Math.max(0, $vrPanelCursor), Math.max(0, children.length - 1))
	$: if ($vrPanelCursor !== cursor) vrPanelCursor.set(cursor)
	$: start = Math.min(Math.max(0, cursor - ROWS + 1), maxScroll)
	$: rows = children.slice(start, start + ROWS).map((child, i) => ({
		child,
		index: start + i,
		y: (ROWS / 2 - i - 0.5) * ROW_H,
		lock: $lockedObjects.find((lock: any) => lock[1] === child.uuid)?.[0] ?? null
	}))
	$: panelHeight = ROWS * ROW_H + 0.05
	// publish the cursored row's action so stick-press selects it (109.4)
	$: vrPanelCursorAction.set(
		$vrObjectsPanelOpen && children[cursor] ? 'panel:select:' + children[cursor].uuid : null
	)

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.16, 0)

	useTask(() => {
		if (!group || !$vrObjectsPanelOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = [...session.inputSources].findIndex((s) => s.handedness === $vrMenuHand)
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		// the panel floats a hand-width above the ring anchor, same tilt
		group.position.copy(pose.position).add(LIFT.clone().applyQuaternion(controllerQuaternion))
		group.quaternion.copy(pose.quaternion)
	})
</script>

{#if $vrObjectsPanelOpen}
	<T.Group bind:ref={group} name="vr-objects-panel">
		<!-- backdrop -->
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelHeight + 0.045]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.88} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text={`Objects (${children.length})${maxScroll ? ` · stick ↕ ${start + 1}-${Math.min(children.length, start + ROWS)}` : ''}`}
			color="#ffffff"
			fontSize={0.011}
			anchorX="center"
			anchorY="middle"
			position={[0, panelHeight / 2 + 0.002, 0.002]}
		/>
		{#each rows as row (row.child.uuid)}
			<T.Mesh name={`vrpanel-select:${row.child.uuid}`} position={[0, row.y, 0]}>
				<T.PlaneGeometry args={[WIDTH, ROW_H - 0.004]} />
				<T.MeshBasicMaterial
					color={$vrHovered === `panel:select:${row.child.uuid}`
						? '#ff4000'
						: row.index === cursor
							? '#5a3a12'
							: $selectedObject?.uuid === row.child.uuid
								? '#2f81f7'
								: '#242a34'}
					transparent
					opacity={0.95}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			<Text
				text={`${iconFor(row.child)} ${row.child.name || row.child.type}`}
				color={row.lock ? '#ffb3b3' : '#e8ecf2'}
				fontSize={0.0105}
				anchorX="left"
				anchorY="middle"
				position={[-WIDTH / 2 + 0.012, row.y, 0.002]}
				maxWidth={WIDTH - 0.05}
				clipRect={[-0.01, -ROW_H, WIDTH - 0.05, ROW_H]}
			/>
			{#if row.lock}
				<T.Mesh position={[WIDTH / 2 - 0.016, row.y, 0.002]}>
					<T.CircleGeometry args={[0.006, 16]} />
					<T.MeshBasicMaterial color={peerColor(row.lock)} />
				</T.Mesh>
			{/if}
		{/each}
		<!-- close hub under the list -->
		<T.Mesh name="vrpanel-close" position={[0, -panelHeight / 2 - 0.018, 0]}>
			<T.CircleGeometry args={[0.014, 24]} />
			<T.MeshBasicMaterial
				color={$vrHovered === 'panel:close' ? '#ff4000' : '#39404d'}
				transparent
				opacity={0.95}
				side={THREE.DoubleSide}
			/>
		</T.Mesh>
		<Text
			text="✕"
			color="#ffffff"
			fontSize={0.011}
			anchorX="center"
			anchorY="middle"
			position={[0, -panelHeight / 2 - 0.018, 0.002]}
		/>
	</T.Group>
{/if}

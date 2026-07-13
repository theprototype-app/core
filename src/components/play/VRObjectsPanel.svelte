<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrObjectsPanelOpen, vrMenuHand, objectsGroup, lockedObjects, selectedObject } from '../../stores/sceneStore'
	import { vrHovered, vrPanelGroup, vrPanelCursor, vrPanelCursorAction, vrPanelExpanded, flattenPanelRows, controllerIndexFor } from '$lib/vrControls'
	import { applyWindowPose } from '$lib/vrWindowPoses'
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
	const INDENT = 0.016 // 215: per-depth indent for group children

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

	$: topLevel = ($objectsGroup?.children ?? []) as any[]
	// 215: flattened rows — expanded groups inline their children (indented)
	$: visibleRows = flattenPanelRows(topLevel, $vrPanelExpanded)
	$: maxScroll = Math.max(0, visibleRows.length - ROWS)
	// the stick moves a ROW CURSOR (109.4); the page scrolls to keep it visible
	$: cursor = Math.min(Math.max(0, $vrPanelCursor), Math.max(0, visibleRows.length - 1))
	$: if ($vrPanelCursor !== cursor) vrPanelCursor.set(cursor)
	$: start = Math.min(Math.max(0, cursor - ROWS + 1), maxScroll)
	$: rows = visibleRows.slice(start, start + ROWS).map((entry, i) => ({
		child: entry.object,
		uuid: entry.uuid,
		depth: entry.depth,
		isGroup: entry.isGroup,
		expanded: $vrPanelExpanded.has(entry.uuid),
		index: start + i,
		y: (ROWS / 2 - i - 0.5) * ROW_H,
		lock: $lockedObjects.find((lock: any) => lock[1] === entry.uuid)?.[0] ?? null
	}))
	$: panelHeight = ROWS * ROW_H + 0.05
	// publish the cursored row's action so stick-press selects it (109.4)
	$: vrPanelCursorAction.set(
		$vrObjectsPanelOpen && visibleRows[cursor] ? 'panel:select:' + visibleRows[cursor].uuid : null
	)
	// scrollbar thumb (120): the visible window over the whole list
	$: thumbH = visibleRows.length ? Math.max(panelHeight * (ROWS / visibleRows.length), 0.02) : panelHeight
	$: thumbY = visibleRows.length
		? panelHeight / 2 - ((start + ROWS / 2) / visibleRows.length) * panelHeight
		: 0
	// cursor-row action buttons (116/120): focus, visibility, rename, props, delete
	function rowActions(child: any) {
		return [
			{ act: 'focus', glyph: '⊕', base: '#39404d' },
			{ act: 'visible', glyph: child.visible === false ? '◎' : '◉', base: '#39404d' },
			{ act: 'rename', glyph: '✎', base: '#39404d' },
			{ act: 'props', glyph: 'ⓘ', base: '#39404d' },
			{ act: 'delete', glyph: '✕', base: '#5a2a2a' }
		]
	}

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.16, 0)

	useTask(() => {
		if (!group || !$vrObjectsPanelOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = controllerIndexFor($vrMenuHand) // 194/210: by handedness, reorder-safe
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		// the panel floats a hand-width above the ring anchor, same tilt; a
		// user offset from a window grab (111) composes on top
		pose.position.add(LIFT.clone().applyQuaternion(controllerQuaternion))
		applyWindowPose(group, 'objects', pose)
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
			text={`Objects (${topLevel.length})${maxScroll ? ` · stick ↕ ${start + 1}-${Math.min(visibleRows.length, start + ROWS)}` : ''}`}
			color="#ffffff"
			fontSize={0.011}
			anchorX="center"
			anchorY="middle"
			position={[0, panelHeight / 2 + 0.002, 0.002]}
		/>
		{#each rows as row (row.uuid)}
			<T.Mesh name={`vrpanel-select:${row.uuid}`} position={[0, row.y, 0]}>
				<T.PlaneGeometry args={[WIDTH, ROW_H - 0.004]} />
				<T.MeshBasicMaterial
					color={$vrHovered === `panel:select:${row.uuid}`
						? '#ff4000'
						: row.index === cursor
							? '#5a3a12'
							: $selectedObject?.uuid === row.uuid
								? '#2f81f7'
								: '#242a34'}
					transparent
					opacity={0.95}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			<!-- 215: caret toggles a group open/closed; children indent by depth -->
			{#if row.isGroup}
				<T.Mesh name={`vrpanel-expand:${row.uuid}`} position={[-WIDTH / 2 + 0.014 + row.depth * INDENT, row.y, 0.001]}>
					<T.CircleGeometry args={[0.008, 4]} />
					<T.MeshBasicMaterial color={$vrHovered === `panel:expand:${row.uuid}` ? '#ff4000' : '#39404d'} side={THREE.DoubleSide} />
				</T.Mesh>
				<Text text={row.expanded ? '▾' : '▸'} color="#e8ecf2" fontSize={0.0095}
					anchorX="center" anchorY="middle" position={[-WIDTH / 2 + 0.014 + row.depth * INDENT, row.y, 0.003]} />
			{/if}
			<Text
				text={`${iconFor(row.child)} ${row.child.name || row.child.type}`}
				color={row.lock ? '#ffb3b3' : '#e8ecf2'}
				fontSize={0.0105}
				anchorX="left"
				anchorY="middle"
				position={[-WIDTH / 2 + 0.028 + row.depth * INDENT, row.y, 0.002]}
				maxWidth={(row.index === cursor ? WIDTH - 0.15 : WIDTH - 0.065) - row.depth * INDENT}
				clipRect={[-0.01, -ROW_H, (row.index === cursor ? WIDTH - 0.15 : WIDTH - 0.065) - row.depth * INDENT, ROW_H]}
			/>
			{#if row.lock}
				<T.Mesh position={[WIDTH / 2 - 0.016, row.y, 0.002]}>
					<T.CircleGeometry args={[0.006, 16]} />
					<T.MeshBasicMaterial color={peerColor(row.lock)} />
				</T.Mesh>
			{:else if row.index === cursor}
				<!-- row actions (116/120): focus, visibility, rename, properties, delete -->
				{#each rowActions(row.child) as a, bi (a.act)}
					<T.Mesh name={`vrpanel-${a.act}:${row.child.uuid}`} position={[WIDTH / 2 - 0.09 + bi * 0.02, row.y, 0.001]}>
						<T.CircleGeometry args={[0.008, 18]} />
						<T.MeshBasicMaterial color={$vrHovered === `panel:${a.act}:${row.child.uuid}` ? '#ff4000' : a.base} side={THREE.DoubleSide} />
					</T.Mesh>
					<Text text={a.glyph} color={a.act === 'delete' ? '#e8a0a0' : '#e8ecf2'} fontSize={0.009}
						anchorX="center" anchorY="middle" position={[WIDTH / 2 - 0.09 + bi * 0.02, row.y, 0.003]} />
				{/each}
			{/if}
		{/each}
		<!-- vertical scrollbar indicator (120): display-only track + thumb -->
		{#if maxScroll > 0}
			<T.Mesh position={[WIDTH / 2 + 0.006, 0, 0.001]}>
				<T.PlaneGeometry args={[0.004, panelHeight]} />
				<T.MeshBasicMaterial color="#2a2f38" transparent opacity={0.7} side={THREE.DoubleSide} />
			</T.Mesh>
			<T.Mesh position={[WIDTH / 2 + 0.006, thumbY, 0.002]}>
				<T.PlaneGeometry args={[0.004, thumbH]} />
				<T.MeshBasicMaterial color="#6b7482" side={THREE.DoubleSide} />
			</T.Mesh>
		{/if}
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

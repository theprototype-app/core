<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrPropsPanelOpen, vrMenuHand, selectedObject } from '../../stores/sceneStore'
	import { vrHovered, vrPropsGroup, vrPropsCursor, PROPS_ROWS, controllerIndexFor } from '$lib/vrControls'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'

	// VR properties panel (112, quiz: core editable set): name + transform
	// nudges + opacity + color + visibility/duplicate/delete for the current
	// selection, in the objects-panel visual language. Controls are named
	// vrprops-* for the vrControls raycast; every edit routes through the
	// normal replicated paths (move message, setMaterialParam, objectActions).
	// The stick moves a row cursor; left/right nudges, press activates.

	const { renderer } = useThrelte()

	const WIDTH = 0.24
	const ROW_H = 0.022

	let group: any = $state(null)
	let values = $state<Record<string, string>>({})
	let title = $state('Properties')
	let visibleState = $state(true)
	let liveHex = $state('#ffffff')
	let refreshAt = 0

	$effect(() => {
		vrPropsGroup.set($vrPropsPanelOpen ? group : null)
	})
	$effect(() => {
		if (!$vrPropsPanelOpen) vrPropsCursor.set(0)
	})

	const AXIS_ROWS = PROPS_ROWS.filter((r: string) => r.includes(':') && r !== 'opacity')
	const KIND_LABEL: Record<string, string> = { pos: 'Pos', rot: 'Rot', scale: 'Scale' }
	function rowLabel(row: string) {
		if (row === 'opacity') return 'Opacity'
		const [kind, axis] = row.split(':')
		return `${KIND_LABEL[kind]} ${axis.toUpperCase()}`
	}
	function rowY(index: number) {
		return panelH / 2 - ROW_H * 1.6 - index * ROW_H
	}
	const rows = PROPS_ROWS as string[]
	const panelH = (rows.length + 2.2) * ROW_H

	function readValues(object: any) {
		const next: Record<string, string> = {}
		for (const row of AXIS_ROWS) {
			const [kind, axis] = row.split(':')
			if (kind === 'pos') next[row] = object.position[axis].toFixed(2)
			else if (kind === 'rot') next[row] = ((object.rotation[axis] * 180) / Math.PI).toFixed(0) + '°'
			else next[row] = object.scale[axis].toFixed(2)
		}
		next.opacity = (object.material?.opacity ?? 1).toFixed(1)
		return next
	}

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.2, 0)

	useTask(() => {
		if (!group || !$vrPropsPanelOpen) return
		// live refresh ~6x/s: values follow peer edits too (112.2)
		const now = performance.now()
		if (now - refreshAt > 150) {
			refreshAt = now
			const object: any = $selectedObject
			if (object?.uuid) {
				title = object.name || object.type || 'Properties'
				values = readValues(object)
				visibleState = object.visible !== false
				if (object.material?.color) liveHex = '#' + object.material.color.getHexString()
			} else {
				title = 'No selection'
			}
		}
		if (!renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = controllerIndexFor($vrMenuHand) // 194/210: by handedness, reorder-safe
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		// floats above the ring anchor; a user offset from a window grab (111)
		// composes on top
		pose.position.add(LIFT.clone().applyQuaternion(controllerQuaternion))
		applyWindowPose(group, 'props', pose)
	})

	function buttonColor(action: string) {
		return $vrHovered === 'props:' + action ? '#ff4000' : '#39404d'
	}
	function rowBg(index: number) {
		return $vrPropsCursor === index ? '#5a3a12' : '#1d232d'
	}
</script>

{#if $vrPropsPanelOpen}
	<T.Group bind:ref={group} name="vr-props-panel">
		<!-- backdrop -->
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.9} side={THREE.DoubleSide} />
		</T.Mesh>
		<!-- title + close -->
		<Text
			text={title.length > 22 ? title.slice(0, 21) + '…' : title}
			color="#e8ecf2"
			fontSize={0.011}
			anchorX="left"
			anchorY="middle"
			position={[-WIDTH / 2 + 0.008, panelH / 2 - ROW_H * 0.7, 0.002]}
		/>
		<T.Mesh name="vrprops-close" position={[WIDTH / 2 - 0.012, panelH / 2 - ROW_H * 0.7, 0]}>
			<T.CircleGeometry args={[0.009, 20]} />
			<T.MeshBasicMaterial color={buttonColor('close')} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text text="✕" color="#ffffff" fontSize={0.008} anchorX="center" anchorY="middle"
			position={[WIDTH / 2 - 0.012, panelH / 2 - ROW_H * 0.7, 0.002]} />

		{#each rows as row, i (row)}
			<!-- row background doubles as the cursor highlight -->
			<T.Mesh
				name={row === 'color' ? 'vrprops-color' : row === 'visible' ? 'vrprops-visible' : row === 'duplicate' ? 'vrprops-duplicate' : row === 'delete' ? 'vrprops-delete' : undefined}
				position={[0, rowY(i), -0.001]}
			>
				<T.PlaneGeometry args={[WIDTH, ROW_H - 0.003]} />
				<T.MeshBasicMaterial
					color={['color', 'visible', 'duplicate', 'delete'].includes(row) && $vrHovered === 'props:' + row ? '#5a2a12' : rowBg(i)}
					transparent
					opacity={0.92}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			{#if row === 'color'}
				<Text text="Color" color="#c8d0da" fontSize={0.009} anchorX="left" anchorY="middle"
					position={[-WIDTH / 2 + 0.008, rowY(i), 0.002]} />
				<T.Mesh position={[WIDTH / 2 - 0.02, rowY(i), 0.001]}>
					<T.PlaneGeometry args={[0.024, 0.013]} />
					<T.MeshBasicMaterial color={liveHex} side={THREE.DoubleSide} />
				</T.Mesh>
			{:else if row === 'visible'}
				<Text text="Visible" color="#c8d0da" fontSize={0.009} anchorX="left" anchorY="middle"
					position={[-WIDTH / 2 + 0.008, rowY(i), 0.002]} />
				<Text text={visibleState ? '✓' : '✗'} color={visibleState ? '#9fe8a9' : '#e8a0a0'}
					fontSize={0.01} anchorX="center" anchorY="middle"
					position={[WIDTH / 2 - 0.02, rowY(i), 0.002]} />
			{:else if row === 'duplicate' || row === 'delete'}
				<Text
					text={row === 'duplicate' ? '⧉ Duplicate' : 'Delete'}
					color={row === 'delete' ? '#e8a0a0' : '#c8d0da'}
					fontSize={0.009}
					anchorX="left"
					anchorY="middle"
					position={[-WIDTH / 2 + 0.008, rowY(i), 0.002]}
				/>
			{:else}
				<!-- axis + opacity rows: label · value · − / + -->
				<Text text={rowLabel(row)} color="#c8d0da" fontSize={0.009} anchorX="left" anchorY="middle"
					position={[-WIDTH / 2 + 0.008, rowY(i), 0.002]} />
				<Text text={values[row] ?? ''} color="#e8ecf2" fontSize={0.009} anchorX="right" anchorY="middle"
					position={[WIDTH / 2 - 0.062, rowY(i), 0.002]} />
				<T.Mesh
					name={row === 'opacity' ? 'vrprops-opacity:-1' : `vrprops-nudge:${row}:-1`}
					position={[WIDTH / 2 - 0.042, rowY(i), 0]}
				>
					<T.CircleGeometry args={[0.0075, 18]} />
					<T.MeshBasicMaterial
						color={buttonColor(row === 'opacity' ? 'opacity:-1' : `nudge:${row}:-1`)}
						side={THREE.DoubleSide}
					/>
				</T.Mesh>
				<Text text="−" color="#ffffff" fontSize={0.009} anchorX="center" anchorY="middle"
					position={[WIDTH / 2 - 0.042, rowY(i), 0.002]} />
				<T.Mesh
					name={row === 'opacity' ? 'vrprops-opacity:1' : `vrprops-nudge:${row}:1`}
					position={[WIDTH / 2 - 0.016, rowY(i), 0]}
				>
					<T.CircleGeometry args={[0.0075, 18]} />
					<T.MeshBasicMaterial
						color={buttonColor(row === 'opacity' ? 'opacity:1' : `nudge:${row}:1`)}
						side={THREE.DoubleSide}
					/>
				</T.Mesh>
				<Text text="+" color="#ffffff" fontSize={0.009} anchorX="center" anchorY="middle"
					position={[WIDTH / 2 - 0.016, rowY(i), 0.002]} />
			{/if}
		{/each}
		<Text
			text="stick ↕ row · ↔ adjust · press = apply"
			color="#9aa4b2"
			fontSize={0.0065}
			anchorX="center"
			anchorY="middle"
			position={[0, -panelH / 2 + ROW_H * 0.5, 0.002]}
		/>
	</T.Group>
{/if}

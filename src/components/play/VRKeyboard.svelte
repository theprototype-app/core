<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrMenuHand } from '../../stores/sceneStore'
	import { vrHovered, vrKeyboardGroup } from '$lib/vrControls'
	import { vrKeyboardTarget, KEY_ROWS, keyLabel } from '$lib/vrKeyboard'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'

	// VR keyboard (116, expert call: native key grid over an external dep). Key
	// meshes are named vrkey-* for the vrControls raycast; presses route through
	// pressVRKey via executeVRMenuAction('kbd:<id>'). A buffer line with a caret
	// sits above the keys. Anchored like the panels; the 111 grab/persist
	// applies (id keyboard). Reused by object rename (116) and chat (117).

	const { renderer } = useThrelte()

	const KEY = 0.03
	const GAP = 0.006
	const WIDTH = 10 * KEY + 11 * GAP // widest row (digits) sets the plate width

	let group: any = $state(null)

	$effect(() => {
		vrKeyboardGroup.set($vrKeyboardTarget ? group : null)
	})

	// each key: id, glyph, x/y, and a width multiple (space/enter/shift wider)
	const WIDE: Record<string, number> = { space: 4, enter: 2, backspace: 1.6, shift: 1.6, esc: 1.4 }
	let rows = $derived(
		KEY_ROWS.map((keys, r) => {
			const widths = keys.map((k) => (WIDE[k] ?? 1) * KEY + ((WIDE[k] ?? 1) - 1) * GAP)
			const total = widths.reduce((a, b) => a + b, 0) + (keys.length - 1) * GAP
			let x = -total / 2
			const y = (KEY_ROWS.length / 2 - r - 0.5) * (KEY + GAP)
			return keys.map((k, i) => {
				const w = widths[i]
				const cell = { id: k, glyph: keyLabel(k, $vrKeyboardTarget?.shift), x: x + w / 2, y, w }
				x += w + GAP
				return cell
			})
		}).flat()
	)
	const plateH = KEY_ROWS.length * (KEY + GAP) + 0.06

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, -0.12, 0)

	useTask(() => {
		if (!group || !$vrKeyboardTarget || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = [...session.inputSources].findIndex((s) => s.handedness === $vrMenuHand)
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		// sits a little below the ring anchor so both hands can reach it
		pose.position.add(LIFT.clone().applyQuaternion(controllerQuaternion))
		applyWindowPose(group, 'keyboard', pose)
	})

	function keyColor(id: string) {
		if ($vrHovered === 'kbd:' + id) return '#ff4000'
		if (id === 'enter') return '#1f6f43'
		if (id === 'esc') return '#6f2f2f'
		if (id === 'shift' && $vrKeyboardTarget?.shift) return '#2f81f7'
		return '#2a2f38'
	}
</script>

{#if $vrKeyboardTarget}
	<T.Group bind:ref={group} name="vr-keyboard">
		<!-- backdrop -->
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.03, plateH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.92} side={THREE.DoubleSide} />
		</T.Mesh>
		<!-- title -->
		<Text
			text={$vrKeyboardTarget.title}
			color="#9aa4b2"
			fontSize={0.008}
			anchorX="left"
			anchorY="middle"
			position={[-WIDTH / 2, plateH / 2 - 0.012, 0.002]}
		/>
		<!-- buffer line + caret -->
		<T.Mesh position={[0, plateH / 2 - 0.033, -0.001]}>
			<T.PlaneGeometry args={[WIDTH, 0.026]} />
			<T.MeshBasicMaterial color="#05070b" side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text={($vrKeyboardTarget.buffer || '') + '▏'}
			color="#e8ecf2"
			fontSize={0.013}
			anchorX="left"
			anchorY="middle"
			position={[-WIDTH / 2 + 0.008, plateH / 2 - 0.033, 0.002]}
			maxWidth={WIDTH - 0.016}
		/>
		{#each rows as key (key.id)}
			<T.Mesh name={`vrkey-${key.id}`} position={[key.x, key.y - 0.02, 0]}>
				<T.PlaneGeometry args={[key.w, KEY - 0.003]} />
				<T.MeshBasicMaterial color={keyColor(key.id)} side={THREE.DoubleSide} />
			</T.Mesh>
			<Text
				text={key.glyph}
				color="#e8ecf2"
				fontSize={key.id.length > 1 ? 0.009 : 0.013}
				anchorX="center"
				anchorY="middle"
				position={[key.x, key.y - 0.02, 0.002]}
			/>
		{/each}
	</T.Group>
{/if}

<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrChatPanelOpen, vrMenuHand } from '../../stores/sceneStore'
	import { peers, messages, username } from '../../stores/appStore'
	import { vrHovered, vrChatGroup } from '$lib/vrControls'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'
	import { nameOf, peerColor } from '$lib/lockControl'

	// VR chat panel (117): the last ~8 messages with sender-colored chips, live
	// from the messages store. An input row opens the 116 keyboard; Enter sends
	// through the normal chat path ($peers.sendMessage) so desktop peers see it
	// too. Rows are named vrchat-* for the vrControls raycast; follows the menu
	// hand and the 111 grab/persist applies (id chat).

	const { renderer } = useThrelte()

	const WIDTH = 0.3
	const ROW_H = 0.026
	const MAX = 8

	let group: any = $state(null)

	$effect(() => {
		vrChatGroup.set($vrChatPanelOpen ? group : null)
	})

	let recent = $derived(($messages as any[]).slice(-MAX))
	const panelH = MAX * ROW_H + 0.09

	const isNote = (m: any) => m.type === 'info' || m.type === 'system' || m.type === ''
	const authorName = (m: any) =>
		m.type === 'sent' || m.sender === $peers?.peer?.id ? $username || 'You' : nameOf(m.sender)

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.18, 0)

	useTask(() => {
		if (!group || !$vrChatPanelOpen || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = [...session.inputSources].findIndex((s) => s.handedness === $vrMenuHand)
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		pose.position.add(LIFT.clone().applyQuaternion(controllerQuaternion))
		applyWindowPose(group, 'chat', pose)
	})
</script>

{#if $vrChatPanelOpen}
	<T.Group bind:ref={group} name="vr-chat-panel">
		<!-- backdrop -->
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, panelH + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.9} side={THREE.DoubleSide} />
		</T.Mesh>
		<!-- header + close -->
		<Text
			text="Chat"
			color="#e8ecf2"
			fontSize={0.011}
			anchorX="left"
			anchorY="middle"
			position={[-WIDTH / 2 + 0.008, panelH / 2 - 0.016, 0.002]}
		/>
		<T.Mesh name="vrchat-close" position={[WIDTH / 2 - 0.014, panelH / 2 - 0.016, 0]}>
			<T.CircleGeometry args={[0.009, 20]} />
			<T.MeshBasicMaterial color={$vrHovered === 'chat:close' ? '#ff4000' : '#39404d'} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text text="✕" color="#ffffff" fontSize={0.008} anchorX="center" anchorY="middle"
			position={[WIDTH / 2 - 0.014, panelH / 2 - 0.016, 0.002]} />

		{#if recent.length === 0}
			<Text text="No messages yet." color="#9aa4b2" fontSize={0.008}
				anchorX="center" anchorY="middle" position={[0, 0.02, 0.002]} />
		{/if}
		{#each recent as m, i (m.id ?? i)}
			{@const y = panelH / 2 - 0.04 - i * ROW_H}
			{#if isNote(m)}
				<Text
					text={`${m.text}`}
					color="#8b93a1"
					fontSize={0.0075}
					anchorX="center"
					anchorY="middle"
					position={[0, y, 0.002]}
					maxWidth={WIDTH - 0.02}
				/>
			{:else}
				<T.Mesh position={[-WIDTH / 2 + 0.012, y, 0.002]}>
					<T.CircleGeometry args={[0.004, 14]} />
					<T.MeshBasicMaterial color={peerColor(m.sender)} side={THREE.DoubleSide} />
				</T.Mesh>
				<Text
					text={`${authorName(m)}: ${m.text}`}
					color="#e8ecf2"
					fontSize={0.008}
					anchorX="left"
					anchorY="middle"
					position={[-WIDTH / 2 + 0.022, y, 0.002]}
					maxWidth={WIDTH - 0.032}
					clipRect={[-0.005, -ROW_H, WIDTH - 0.032, ROW_H * 0.5]}
				/>
			{/if}
		{/each}

		<!-- input row opens the VR keyboard (116) -->
		<T.Mesh name="vrchat-input" position={[0, -panelH / 2 + 0.02, 0]}>
			<T.PlaneGeometry args={[WIDTH - 0.02, 0.024]} />
			<T.MeshBasicMaterial color={$vrHovered === 'chat:input' ? '#2f5fa0' : '#2a2f38'} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text="＋ Type a message…"
			color="#c8d0da"
			fontSize={0.0085}
			anchorX="center"
			anchorY="middle"
			position={[0, -panelH / 2 + 0.02, 0.002]}
		/>
	</T.Group>
{/if}

<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { vrApprovePanelOpen, vrMenuHand, isVRMode } from '../../stores/sceneStore'
	import { pendingApprovals } from '../../stores/appStore'
	import { vrHovered, vrApproveGroup, controllerIndexFor } from '$lib/vrControls'
	import { applyWindowPose } from '$lib/vrWindowPoses'
	import { menuPoseFromController } from '$lib/vrRadialMenu'

	// VR peer-approval panel (211): while presenting, a pending connection request
	// pops a controller-anchored card showing the requester's id + Approve / Deny
	// (ray + trigger). Mirrors the desktop Toasts approval card; the buttons route
	// through the shared approvePeer/denyPeer path. Meshes are named vrapprove-*
	// for the vrControls raycast; the card follows the menu hand.

	const { renderer } = useThrelte()

	const WIDTH = 0.34
	const HEIGHT = 0.14

	let group: any = $state(null)
	let first = $derived(($pendingApprovals as any[])[0])
	let count = $derived(($pendingApprovals as any[]).length)
	// only in VR — desktop surfaces the same request through the Toasts card
	let show = $derived($isVRMode && !!first)

	// this component is the single writer of the panel gate + group (vrControls
	// reads them for the raycast / hover loop / window-grab registry)
	$effect(() => {
		vrApprovePanelOpen.set(show)
		vrApproveGroup.set(show ? group : null)
	})

	const shortId = (id: string) => (id && id.length > 18 ? id.slice(0, 17) + '…' : id || '')

	const controllerPosition = new THREE.Vector3()
	const controllerQuaternion = new THREE.Quaternion()
	const LIFT = new THREE.Vector3(0, 0.2, 0)

	useTask(() => {
		if (!group || !show || !renderer.xr.isPresenting) return
		const session = renderer.xr.getSession()
		if (!session) return
		const index = controllerIndexFor($vrMenuHand) // 194/210: by handedness, reorder-safe
		if (index < 0) return
		const controller = renderer.xr.getController(index)
		controller.getWorldPosition(controllerPosition)
		controller.getWorldQuaternion(controllerQuaternion)
		const pose = menuPoseFromController(THREE, controllerPosition, controllerQuaternion)
		pose.position.add(LIFT.clone().applyQuaternion(controllerQuaternion))
		applyWindowPose(group, 'approve', pose)
	})
</script>

{#if show}
	<T.Group bind:ref={group} name="vr-approve-panel">
		<!-- backdrop -->
		<T.Mesh position={[0, 0, -0.004]}>
			<T.PlaneGeometry args={[WIDTH + 0.02, HEIGHT + 0.02]} />
			<T.MeshBasicMaterial color="#11151c" transparent opacity={0.92} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text
			text="Connection request"
			color="#e8ecf2"
			fontSize={0.012}
			anchorX="center"
			anchorY="middle"
			position={[0, HEIGHT / 2 - 0.02, 0.002]}
		/>
		<Text
			text={shortId(first?.peerId)}
			color="#9aa4b2"
			fontSize={0.0095}
			anchorX="center"
			anchorY="middle"
			maxWidth={WIDTH - 0.03}
			position={[0, HEIGHT / 2 - 0.045, 0.002]}
		/>
		{#if count > 1}
			<Text
				text={`+${count - 1} more waiting`}
				color="#6b7280"
				fontSize={0.007}
				anchorX="center"
				anchorY="middle"
				position={[0, HEIGHT / 2 - 0.064, 0.002]}
			/>
		{/if}

		<!-- Approve -->
		<T.Mesh name="vrapprove-yes" position={[-WIDTH / 4, -HEIGHT / 2 + 0.03, 0]}>
			<T.PlaneGeometry args={[WIDTH / 2 - 0.03, 0.036]} />
			<T.MeshBasicMaterial color={$vrHovered === 'approve:yes' ? '#2f9e57' : '#227a43'} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text text="✓ Approve" color="#ffffff" fontSize={0.0095} anchorX="center" anchorY="middle"
			position={[-WIDTH / 4, -HEIGHT / 2 + 0.03, 0.002]} />

		<!-- Deny -->
		<T.Mesh name="vrapprove-no" position={[WIDTH / 4, -HEIGHT / 2 + 0.03, 0]}>
			<T.PlaneGeometry args={[WIDTH / 2 - 0.03, 0.036]} />
			<T.MeshBasicMaterial color={$vrHovered === 'approve:no' ? '#c8443a' : '#963029'} side={THREE.DoubleSide} />
		</T.Mesh>
		<Text text="✕ Deny" color="#ffffff" fontSize={0.0095} anchorX="center" anchorY="middle"
			position={[WIDTH / 4, -HEIGHT / 2 + 0.03, 0.002]} />
	</T.Group>
{/if}

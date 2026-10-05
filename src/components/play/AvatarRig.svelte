<script lang="ts">
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import * as THREE from 'three'
	import { onDestroy } from 'svelte'
	import { speakingPeers } from '$lib/voiceChat'
	import { resolveAvatar, hatAnchorY, usesPhotoCard } from '$lib/avatarModel'
	import { peerHands } from '../../stores/sceneStore'
	import { RiggedAvatar, lookOf } from '$lib/avatars/riggedAvatar'
	import { avatarIkPeers, avatarInstances } from '$lib/avatars/avatarState'
	import { feetBelowHead } from '$lib/avatars/catalog'

	// Builds a peer's character from their replicated avatar config (userdata
	// slot 5: { character, head, outfit, body, hat, face, shape, showLabel }).
	// 36-avatars: a RIGGED body (KayKit CC0 characters) stands under the head and
	// walks/idles from the camera stream, arms reaching for the VR hands; the
	// pre-36 floating head stays as the "Classic" choice. Photo avatars (129)
	// render as a camera-facing square CARD; the name label floats above the head.
	// The root group keeps the peer id (moveCamera poses it from the `camera`
	// stream); the rigged body is its SIBLING because a body must stand upright.
	export let user: any[]
	/** the customise panel's self-preview: a fixed pose instead of a camera stream */
	export let preview: { position: number[]; yaw: number } | null = null
	/** the id `auto` hashes (the preview shows what PEERS will see for your real id) */
	export let lookId: string = ''

	const { camera } = useThrelte()
	$: config = resolveAvatar(user[5])
	$: look = lookOf(config, lookId || user[0], user[2] || '')
	$: photoCard = usesPhotoCard(config, user[2])

	let avatar: RiggedAvatar | null = null
	$: syncAvatar(look)
	function syncAvatar(l: any) {
		if (!l) {
			if (avatar) dropAvatar()
			return
		}
		if (!avatar) {
			avatar = new RiggedAvatar(user[0], l, { onIk: (sides) => setIk(sides) })
			avatarInstances.set(user[0], avatar)
		} else avatar.setLook(l)
	}
	function dropAvatar() {
		avatar?.dispose()
		avatarInstances.delete(user[0])
		avatar = null
		setIk(null)
	}
	function setIk(sides: { left: boolean; right: boolean } | null) {
		avatarIkPeers.update((m) => {
			const next = { ...m }
			if (sides && (sides.left || sides.right)) next[user[0]] = sides
			else delete next[user[0]]
			return next
		})
	}
	onDestroy(() => {
		if (avatar) dropAvatar()
	})

	let faceTexture: any = null
	$: if (!look && config.face === 'image' && user[2]) {
		new THREE.TextureLoader().load(user[2], (texture) => {
			texture.colorSpace = THREE.SRGBColorSpace
			faceTexture = texture
		})
	} else {
		faceTexture = null
	}

	// the photo card + the label billboard toward the viewer each frame; the rigged body updates
	let root: any = null
	let card: any = null
	let labelGroup: any = null
	const viewer = new THREE.Vector3()
	useTask((delta) => {
		const cam: any = camera.current
		if (!cam) return
		cam.getWorldPosition(viewer)
		if (preview && root) {
			root.position.set(preview.position[0], preview.position[1], preview.position[2])
			root.rotation.set(0, preview.yaw, 0, 'YXZ')
		}
		if (card) card.lookAt(viewer)
		if (labelGroup) labelGroup.lookAt(viewer)
		if (avatar && root) avatar.update(Math.min(delta, 0.1), performance.now() / 1000, root, preview ? null : $peerHands[user[0]], viewer)
	})
</script>

<T.Group bind:ref={root} position={[0, 1000, 0]} name={user[0]}>
	{#if !look}
		<!-- name label ABOVE the head (129): hi-res, camera-facing, toggleable -->
		{#if config.showLabel}
			<T.Group bind:ref={labelGroup} position={[0, 1.05, 0]} name={`${user[0]}-label`}>
				<Text
					color="#ffffff"
					outlineColor="#0b0e14"
					outlineWidth={0.02}
					fontSize={0.26}
					anchorX="center"
					anchorY="middle"
					text={user[1] || user[0]}
				/>
			</T.Group>
		{/if}

		{#if photoCard && faceTexture}
			<!-- 129: a camera-facing square card carries the photo (no sphere) -->
			<T.Mesh bind:ref={card} name={`${user[0]}-face-card`}>
				<T.PlaneGeometry args={[1.1, 1.1]} />
				<T.MeshBasicMaterial map={faceTexture} transparent side={THREE.DoubleSide} />
			</T.Mesh>
		{:else}
			<!-- head shape (unlit so avatars show in unlit scenes) -->
			<T.Mesh castShadow name={`${user[0]}-body`}>
				{#if config.shape === 'box'}
					<T.BoxGeometry args={[1.0, 1.0, 1.0]} />
				{:else if config.shape === 'capsule'}
					<T.CapsuleGeometry args={[0.45, 0.7, 6, 12]} />
				{:else if config.shape === 'cone'}
					<T.ConeGeometry args={[0.62, 1.2, 20]} />
				{:else}
					<T.SphereGeometry args={[0.59, 16, 12]} />
				{/if}
				<T.MeshBasicMaterial color={config.body} />
			</T.Mesh>
		{/if}

		<!-- speaking indicator -->
		{#if $speakingPeers.includes(user[0])}
			<T.Mesh rotation.x={-Math.PI / 2} position.y={-0.55} name={`${user[0]}-speaking`}>
				<T.RingGeometry args={[0.62, 0.78, 24]} />
				<T.MeshBasicMaterial color="#22c55e" side={THREE.DoubleSide} />
			</T.Mesh>
		{/if}

		<!-- hat: seated on top of the current shape (129 per-shape anchor) -->
		{#if config.hat !== 'none'}
			<T.Group position={[0, hatAnchorY(config.shape), 0]} name={`${user[0]}-hat`}>
				{#if config.hat === 'cap'}
					<T.Mesh position={[0, 0.45, 0]}>
						<T.SphereGeometry args={[0.36, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
						<T.MeshBasicMaterial color="#2d5c9e" />
					</T.Mesh>
					<T.Mesh position={[0, 0.47, -0.35]} rotation={[-0.15, 0, 0]}>
						<T.BoxGeometry args={[0.42, 0.04, 0.35]} />
						<T.MeshBasicMaterial color="#2d5c9e" />
					</T.Mesh>
				{:else if config.hat === 'tophat'}
					<T.Mesh position={[0, 0.78, 0]}>
						<T.CylinderGeometry args={[0.26, 0.26, 0.45]} />
						<T.MeshBasicMaterial color="#1c1c1c" />
					</T.Mesh>
					<T.Mesh position={[0, 0.56, 0]}>
						<T.CylinderGeometry args={[0.45, 0.45, 0.05]} />
						<T.MeshBasicMaterial color="#1c1c1c" />
					</T.Mesh>
				{:else if config.hat === 'crown'}
					<T.Mesh position={[0, 0.6, 0]}>
						<T.CylinderGeometry args={[0.3, 0.34, 0.22, 8, 1, true]} />
						<T.MeshBasicMaterial color="#d4af37" side={THREE.DoubleSide} />
					</T.Mesh>
					{#each [0, 1, 2, 3, 4, 5] as spike}
						<T.Mesh
							position={[Math.cos((spike * Math.PI) / 3) * 0.29, 0.76, Math.sin((spike * Math.PI) / 3) * 0.29]}
						>
							<T.ConeGeometry args={[0.05, 0.14, 4]} />
							<T.MeshBasicMaterial color="#d4af37" />
						</T.Mesh>
					{/each}
				{/if}
			</T.Group>
		{/if}
	{/if}
</T.Group>

{#if avatar}
	<!-- 36: the rigged body (a sibling of the head group: upright, yaw-only, feet at its origin) -->
	<T is={avatar.object}>
		{#if config.showLabel}
			<T.Group bind:ref={labelGroup} position={[0, feetBelowHead() + 0.95, 0]} name={`${user[0]}-label`}>
				<Text
					color="#ffffff"
					outlineColor="#0b0e14"
					outlineWidth={0.02}
					fontSize={0.22}
					anchorX="center"
					anchorY="middle"
					text={user[1] || user[0]}
				/>
			</T.Group>
		{/if}
		{#if $speakingPeers.includes(user[0])}
			<T.Mesh rotation.x={-Math.PI / 2} position.y={0.03} name={`${user[0]}-speaking`}>
				<T.RingGeometry args={[0.42, 0.55, 24]} />
				<T.MeshBasicMaterial color="#22c55e" side={THREE.DoubleSide} />
			</T.Mesh>
		{/if}
	</T>
{/if}

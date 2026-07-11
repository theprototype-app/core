<script lang="ts">
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import * as THREE from 'three'
	import { speakingPeers } from '$lib/voiceChat'
	import { resolveAvatar, hatAnchorY, usesPhotoCard } from '$lib/avatarModel'

	// Builds a peer's character from their replicated avatar config (userdata
	// slot 5: { body, hat, face, shape, showLabel }). Photo avatars (129) render
	// as a camera-facing square CARD instead of the sphere that used to swallow
	// the image; the name label floats hi-res ABOVE the head; the head shape is
	// selectable and the hat re-seats per shape. Root group keeps the peer id.
	export let user: any[]

	const { camera } = useThrelte()
	$: config = resolveAvatar(user[5])
	$: photoCard = usesPhotoCard(config, user[2])

	let faceTexture: any = null
	$: if (config.face === 'image' && user[2]) {
		new THREE.TextureLoader().load(user[2], (texture) => {
			texture.colorSpace = THREE.SRGBColorSpace
			faceTexture = texture
		})
	} else {
		faceTexture = null
	}

	// the photo card + the label billboard toward the viewer each frame
	let card: any = null
	let labelGroup: any = null
	useTask(() => {
		const cam: any = camera.current
		if (!cam) return
		if (card) card.lookAt(cam.getWorldPosition(new THREE.Vector3()))
		if (labelGroup) labelGroup.lookAt(cam.getWorldPosition(new THREE.Vector3()))
	})
</script>

<T.Group position={[0, 1000, 0]} name={user[0]}>
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
</T.Group>

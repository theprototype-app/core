<script lang="ts">
	import { T } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import * as THREE from 'three'
	import { speakingPeers } from '$lib/voiceChat'

	// Builds a peer's character from their replicated avatar config
	// (userdata slot 5: { body, hat, face }). The root group keeps the peer id
	// as its name — moveCamera and spectating look players up by name.
	export let user: any[]

	const defaults = { body: '#4f83cc', hat: 'none', face: 'label' }
	$: config = { ...defaults, ...(user[5] ?? {}) }

	let faceTexture: any = null
	$: if (config.face === 'image' && user[2]) {
		new THREE.TextureLoader().load(user[2], (texture) => {
			texture.colorSpace = THREE.SRGBColorSpace
			faceTexture = texture
		})
	} else {
		faceTexture = null
	}
</script>

<T.Group position={[0, 1000, 0]} name={user[0]}>
	<Text
		color="black"
		fontSize={0.2}
		anchorX="center"
		position={[0, 0.75, -0.2]}
		rotation={[0, Math.PI, 0]}
		text={user[1] || user[0]}
	/>

	<!-- body (unlit so avatars are visible in unlit scenes) -->
	<T.Mesh castShadow name={`${user[0]}-body`}>
		<T.SphereGeometry args={[0.59, 16, 12]} />
		<T.MeshBasicMaterial color={config.body} />
	</T.Mesh>

	<!-- speaking indicator -->
	{#if $speakingPeers.includes(user[0])}
		<T.Mesh rotation.x={-Math.PI / 2} position.y={-0.55} name={`${user[0]}-speaking`}>
			<T.RingGeometry args={[0.62, 0.78, 24]} />
			<T.MeshBasicMaterial color="#22c55e" side={THREE.DoubleSide} />
		</T.Mesh>
	{/if}

	<!-- face: the avatar photo on the front, when chosen and available -->
	{#if config.face === 'image' && faceTexture}
		<T.Mesh position={[0, 0.05, -0.52]} rotation={[0, Math.PI, 0]} name={`${user[0]}-face`}>
			<T.CircleGeometry args={[0.28, 24]} />
			<T.MeshBasicMaterial map={faceTexture} />
		</T.Mesh>
	{/if}

	{#if config.hat === 'cap'}
		<T.Group name={`${user[0]}-hat`}>
			<T.Mesh position={[0, 0.45, 0]}>
				<T.SphereGeometry args={[0.36, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
				<T.MeshBasicMaterial color="#2d5c9e" />
			</T.Mesh>
			<T.Mesh position={[0, 0.47, -0.35]} rotation={[-0.15, 0, 0]}>
				<T.BoxGeometry args={[0.42, 0.04, 0.35]} />
				<T.MeshBasicMaterial color="#2d5c9e" />
			</T.Mesh>
		</T.Group>
	{:else if config.hat === 'tophat'}
		<T.Group name={`${user[0]}-hat`}>
			<T.Mesh position={[0, 0.78, 0]}>
				<T.CylinderGeometry args={[0.26, 0.26, 0.45]} />
				<T.MeshBasicMaterial color="#1c1c1c" />
			</T.Mesh>
			<T.Mesh position={[0, 0.56, 0]}>
				<T.CylinderGeometry args={[0.45, 0.45, 0.05]} />
				<T.MeshBasicMaterial color="#1c1c1c" />
			</T.Mesh>
		</T.Group>
	{:else if config.hat === 'crown'}
		<T.Group name={`${user[0]}-hat`}>
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
		</T.Group>
	{/if}
</T.Group>

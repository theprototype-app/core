<script lang="ts">
	import * as THREE from 'three'
	import { T, useTask } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { pings, PING_TTL } from '$lib/ping'

	// Expanding ring + beam + author label per ping; rings pulse via useTask.

	function colorOf(id: string) {
		let hash = 0
		for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360
		return `hsl(${hash}, 75%, 55%)`
	}

	const rings: Record<string, any> = {}

	useTask(() => {
		const now = Date.now()
		$pings.forEach((ping) => {
			const ring = rings[ping.id]
			if (!ring) return
			const phase = ((now - ping.ts) % 900) / 900
			const scale = 0.3 + phase * 2.2
			ring.scale.set(scale, scale, scale)
			if (ring.material) ring.material.opacity = 0.9 * (1 - phase)
		})
	})
</script>

{#each $pings as ping (ping.id)}
	<T.Group position={ping.pos}>
		<!-- pulsing ring on the ground plane of the point -->
		<T.Mesh
			rotation.x={-Math.PI / 2}
			oncreate={({ ref }) => (rings[ping.id] = ref)}
		>
			<T.RingGeometry args={[0.42, 0.5, 32]} />
			<T.MeshBasicMaterial color={colorOf(ping.peerId)} transparent side={THREE.DoubleSide} depthTest={false} />
		</T.Mesh>
		<!-- beam -->
		<T.Mesh position.y={1}>
			<T.CylinderGeometry args={[0.02, 0.02, 2]} />
			<T.MeshBasicMaterial color={colorOf(ping.peerId)} transparent opacity={0.6} depthTest={false} />
		</T.Mesh>
		<Text
			color="white"
			outlineColor="#000000"
			outlineWidth={0.01}
			fontSize={0.25}
			anchorX="center"
			position={[0, 2.2, 0]}
			text={ping.name}
		/>
	</T.Group>
{/each}

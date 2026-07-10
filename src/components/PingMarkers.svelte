<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { pings, PING_TTL } from '$lib/ping'
	import { peerColor } from '$lib/lockControl'

	// Ping v2 (87): layered burst at the EXACT pinged point — expanding halo
	// ring pair, additive glow disc, soft light column and a spinning spark.
	// Color comes from the sender's preference (fallback: their peer color).

	const colorOf = (ping: any) => ping.color ?? peerColor(ping.peerId)

	const parts: Record<string, any> = {}
	const track = (id: string, key: string) => ({ ref }: any) => {
		;(parts[id] ??= {})[key] = ref
	}

	useTask(() => {
		const now = Date.now()
		$pings.forEach((ping) => {
			const p = parts[ping.id]
			if (!p) return
			const age = now - ping.ts
			const life = 1 - age / PING_TTL
			// two halo rings, phase-shifted
			const phaseA = (age % 900) / 900
			const phaseB = ((age + 450) % 900) / 900
			if (p.ringA) {
				const s = 0.3 + phaseA * 2.4
				p.ringA.scale.set(s, s, s)
				if (p.ringA.material) p.ringA.material.opacity = 0.9 * (1 - phaseA) * life
			}
			if (p.ringB) {
				const s = 0.3 + phaseB * 2.4
				p.ringB.scale.set(s, s, s)
				if (p.ringB.material) p.ringB.material.opacity = 0.5 * (1 - phaseB) * life
			}
			// glow disc breathes, column fades out over the ping's life
			if (p.glow?.material) p.glow.material.opacity = (0.25 + 0.15 * Math.sin(age / 120)) * life
			if (p.beam?.material) p.beam.material.opacity = 0.55 * life
			if (p.beamOuter?.material) p.beamOuter.material.opacity = 0.18 * life
			// the spark pops in the first 600ms, then gently spins
			if (p.spark) {
				const burst = Math.min(age / 600, 1)
				const s = 0.12 + 0.1 * (1 - burst)
				p.spark.scale.set(s, s, s)
				p.spark.rotation.y = age / 300
				if (p.spark.material) p.spark.material.opacity = life
			}
		})
	})
</script>

{#each $pings as ping (ping.id)}
	<T.Group position={ping.pos}>
		<!-- halo ring pair at the exact hit point -->
		<T.Mesh rotation.x={-Math.PI / 2} oncreate={track(ping.id, 'ringA')}>
			<T.RingGeometry args={[0.42, 0.5, 40]} />
			<T.MeshBasicMaterial color={colorOf(ping)} transparent side={THREE.DoubleSide} depthTest={false} />
		</T.Mesh>
		<T.Mesh rotation.x={-Math.PI / 2} oncreate={track(ping.id, 'ringB')}>
			<T.RingGeometry args={[0.46, 0.5, 40]} />
			<T.MeshBasicMaterial color={colorOf(ping)} transparent side={THREE.DoubleSide} depthTest={false} />
		</T.Mesh>
		<!-- additive glow disc -->
		<T.Mesh rotation.x={-Math.PI / 2} position.y={0.01} oncreate={track(ping.id, 'glow')}>
			<T.CircleGeometry args={[0.55, 40]} />
			<T.MeshBasicMaterial
				color={colorOf(ping)}
				transparent
				blending={THREE.AdditiveBlending}
				side={THREE.DoubleSide}
				depthWrite={false}
				depthTest={false}
			/>
		</T.Mesh>
		<!-- soft light column: bright core + wide faint sheath -->
		<T.Mesh position.y={1} oncreate={track(ping.id, 'beam')}>
			<T.CylinderGeometry args={[0.015, 0.03, 2, 8, 1, true]} />
			<T.MeshBasicMaterial color={colorOf(ping)} transparent depthTest={false} />
		</T.Mesh>
		<T.Mesh position.y={1} oncreate={track(ping.id, 'beamOuter')}>
			<T.CylinderGeometry args={[0.06, 0.14, 2, 10, 1, true]} />
			<T.MeshBasicMaterial
				color={colorOf(ping)}
				transparent
				blending={THREE.AdditiveBlending}
				side={THREE.DoubleSide}
				depthWrite={false}
				depthTest={false}
			/>
		</T.Mesh>
		<!-- impact spark -->
		<T.Mesh position.y={0.12} oncreate={track(ping.id, 'spark')}>
			<T.OctahedronGeometry args={[1, 0]} />
			<T.MeshBasicMaterial color="#ffffff" transparent depthTest={false} />
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

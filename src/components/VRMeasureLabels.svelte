<script lang="ts">
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - the Text typing re-exports a const enum that clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import { chainLabels, layoutLabels } from '$lib/measureCore'
	import { labelWorldHeight, labelPxMetrics } from '$lib/vrMeasureCore'

	// 52 V1: the measure labels in a HEADSET — the desktop's labels are DOM pills (MeasureLabels), which a
	// headset cannot see, so here every length / angle / total is a troika text on a dark plate in the scene.
	// Each label FACES the viewer and is the same ANGLE tall at any distance (vrMeasureCore.labelWorldHeight),
	// so a 3 m wall reads as well from across the room as from beside it; and because every label is then the
	// same number of pixels tall, the desktop's own screen-space layout (measureCore.layoutLabels) keeps them
	// apart — a crowded chain hides what it cannot place rather than stacking text. Presentation only: the
	// chains come from MeasureOverlay (the drawn one + every measurement item), nothing here is replicated.

	type Chain = { id: string; points: number[][]; item: boolean }
	let { chains }: { chains: Chain[] } = $props()

	const { renderer } = useThrelte()

	/** the labels of every chain, keyed stably per chain + index (the troika meshes survive a hover move) */
	const labels = $derived(chains.flatMap((c) => chainLabels(c.points, c.id).map((l) => ({ ...l, item: c.item }))))

	/** one group per label, posed every frame (plain: nothing renders from it) */
	const refs: Record<string, any> = {}
	/** ONE base material for the numbers: troika derives a per-label material from it (AnnotationPins) */
	const textBase = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true })
	const H = 1000 // the virtual view the layout runs in (px)
	const eye = new THREE.Vector3()
	const right = new THREE.Vector3()
	const up = new THREE.Vector3()
	const quat = new THREE.Quaternion()
	const projected = new THREE.Vector3()
	const anchor = new THREE.Vector3()
	/** plate width in em for a label text (tabular digits ~0.56 em each, plus the pill's padding) */
	const plateW = (text: string) => text.length * 0.56 + 0.7

	/** the suites' view: what each label is doing this frame */
	const debug: { key: string; text: string; hidden: boolean; height: number; distance: number }[] = []
	/** and what posing them costs (the 52 frame-time row reads it) */
	const cost = { frames: 0, ms: 0 }
	if (typeof window !== 'undefined') {
		;(window as any).__vrMeasureLabels = debug
		;(window as any).__vrMeasureLabelsCost = cost
	}

	useTask(() => {
		const xr = (renderer as any)?.xr
		if (!xr?.isPresenting || !labels.length) {
			debug.length = 0
			return
		}
		const t0 = performance.now()
		const cam: any = xr.getCamera()
		const view: any = cam.cameras?.[0] ?? cam
		cam.getWorldPosition(eye)
		cam.getWorldQuaternion(quat)
		right.set(1, 0, 0).applyQuaternion(quat)
		up.set(0, 1, 0).applyQuaternion(quat)
		const fovDeg = (2 * Math.atan(1 / (view.projectionMatrix.elements[5] || 1)) * 180) / Math.PI
		const tanHalf = Math.tan((fovDeg * Math.PI) / 360)
		// project every anchor into one virtual view of the left eye, lay them out like the desktop pills
		const anchors: any[] = []
		const byKey = new Map<string, any>()
		for (const l of labels) {
			anchor.set(l.point[0], l.point[1], l.point[2])
			projected.copy(anchor).project(view)
			if (projected.z >= 1 || projected.z <= -1) continue
			const a = { key: l.key, kind: l.kind, text: l.text, point: l.point, x: ((projected.x + 1) / 2) * H, y: ((1 - projected.y) / 2) * H }
			anchors.push(a)
			byKey.set(l.key, a)
		}
		const placed = layoutLabels(anchors, labelPxMetrics(H, fovDeg))
		const seen = new Set<string>()
		debug.length = 0
		for (const p of placed) {
			const g = refs[p.key]
			if (!g) continue
			seen.add(p.key)
			anchor.set(p.point[0], p.point[1], p.point[2])
			const distance = Math.max(anchor.distanceTo(eye), 0.05)
			// the layout's px move from the anchor, back into metres at that distance
			const metresPerPx = (2 * tanHalf * distance) / H
			const a = byKey.get(p.key)
			const dx = (p.x - a.x) * metresPerPx
			const dy = -(p.y - a.y) * metresPerPx
			g.position.copy(anchor).addScaledVector(right, dx).addScaledVector(up, dy)
			g.quaternion.copy(quat)
			const height = labelWorldHeight(distance)
			g.scale.setScalar(height)
			g.visible = !p.hidden
			debug.push({ key: p.key, text: p.text, hidden: !!p.hidden, height, distance })
		}
		for (const key of Object.keys(refs)) if (!seen.has(key) && refs[key]) refs[key].visible = false
		cost.frames++
		cost.ms += performance.now() - t0
	})
</script>

<!-- tokens-ok-begin: troika text + plates of the headset's measure labels (meshes cannot read CSS var()) -->
{#each labels as l (l.key)}
	<T.Group
		name="vr-measure-label"
		visible={false}
		oncreate={(ref: any) => {
			refs[l.key] = ref
			return () => {
				if (refs[l.key] === ref) delete refs[l.key]
			}
		}}
	>
		<T.Mesh scale={[plateW(l.text), 1.45, 1]} renderOrder={998}>
			<T.PlaneGeometry />
			<T.MeshBasicMaterial color="#0b0f17" transparent opacity={0.84} depthTest={false} depthWrite={false} />
		</T.Mesh>
		<Text
			text={l.text}
			color={l.kind === 'angle' ? '#cbd5e1' : '#ffffff'}
			outlineColor={l.item ? '#0369a1' : '#c2410c'}
			outlineWidth={0.06}
			fontSize={1}
			anchorX="center"
			anchorY="middle"
			position={[0, 0, 0.02]}
			renderOrder={999}
			material={textBase}
		/>
	</T.Group>
{/each}
<!-- tokens-ok-end -->

<script lang="ts">
	import * as THREE from 'three'
	import { T, useTask, useThrelte, useScheduler } from '@threlte/core'
	import { measurement, measureHover, measureMode, measureEditing, measureLabelViews } from '$lib/measure'
	import { chainLabels, layoutLabels } from '$lib/measureCore'
	import { isMeasurement, worldPointsOf } from '$lib/measureItems'
	import { isVRMode, isLocked, objectsGroup, selectedObjects } from '../stores/sceneStore'
	import VRMeasureLabels from './VRMeasureLabels.svelte'

	// 47 M1 + 48 B2: the measure chains in the 3D view — the one being drawn (with a dashed rubber
	// band to where the next click would land) and every measurement ITEM in the scene (48 B2:
	// they are objects in objectsGroup now, so this draws them from their records and follows
	// their transforms). Lines and dots only: the labels are DOM (MeasureLabels.svelte), placed
	// from the screen positions this component publishes in the RENDER stage, after OrbitControls
	// has moved the camera for the frame. Scene-root, never in objectsGroup. Hidden in Play (a
	// measurement is an editing aid). 52 V1: in a headset the lines and dots draw as well and the labels
	// are troika text in the scene instead (VRMeasureLabels) — DOM is invisible there.

	const { camera, renderer } = useThrelte()
	const { renderStage } = useScheduler()

	const DOT_PX = 9
	const EDIT_DOT_PX = 13

	type Chain = { id: string; points: number[][]; item: boolean; selected: boolean; editing: boolean }

	/** the hover point while measuring — none while the pointer rests on the last point (a
	 *  0 m preview segment and a "Total" equal to the chain read as a measurement) */
	const hoverPoint = $derived.by(() => {
		const points = $measurement?.points ?? []
		const hover = $measureMode ? $measureHover?.point : null
		if (!hover || !points.length) return null
		const last = points[points.length - 1]
		return Math.hypot(hover[0] - last[0], hover[1] - last[1], hover[2] - last[2]) < 1e-4 ? null : hover
	})

	/** the scene's measurement items, in WORLD space — refreshed per frame (a gizmo drag, a peer's
	 *  move) but only re-published when something actually moved, so the geometry below is
	 *  rebuilt on change, not every frame */
	let items: Chain[] = $state.raw([])
	let itemsKey = ''

	function collectItems(): Chain[] {
		const group = $objectsGroup as any
		if (!group || $isLocked === true) return []
		const sel = new Set($selectedObjects as string[])
		const editing = $measureEditing
		const out: Chain[] = []
		group.traverse((o: any) => {
			if (!isMeasurement(o)) return
			for (let n = o; n; n = n.parent) if (n.visible === false) return
			let points: number[][] = worldPointsOf(o)
			const isEditing = editing?.uuid === o.uuid
			// a picked-up point follows the hover (the snapped spot the next click would put it)
			if (isEditing && editing && editing.active >= 0 && $measureHover?.point && points[editing.active])
				points = points.map((p, i) => (i === editing.active ? ($measureHover!.point as number[]) : p))
			out.push({ id: o.uuid, points, item: true, selected: sel.has(o.uuid), editing: isEditing })
		})
		return out
	}

	/** the drawn chain plus the hover point while measuring (the preview segment) */
	const live = $derived.by((): Chain | null => {
		const points = $measurement?.points ?? []
		const hover = hoverPoint
		if (!points.length) return null
		return { id: 'cur', points: hover ? [...points, hover] : points, item: false, selected: false, editing: false }
	})
	const chains = $derived([...items, ...(live ? [live] : [])] as Chain[])

	function lineOf(points: number[][]) {
		return new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])))
	}

	// one geometry per chain for the solid part, plus the preview segment; rebuilt only when a
	// chain changes (a click, a keep, an item moved, the throttled hover) and disposed with it
	const solid = $derived(
		chains.map((c) => {
			const fixed = c.item ? c.points : ($measurement?.points ?? [])
			return { id: c.id, item: c.item, selected: c.selected, editing: c.editing, line: lineOf(fixed), dots: lineOf(fixed) }
		})
	)
	const preview = $derived.by(() => {
		const points = $measurement?.points ?? []
		const hover = hoverPoint
		if (!points.length || !hover) return null
		const a = points[points.length - 1]
		const geometry = lineOf([a, hover])
		// the dashed material reads `lineDistance`; written here because the geometry is swapped
		// under one Line as the hover moves (computeLineDistances would need the Line)
		const length = Math.hypot(hover[0] - a[0], hover[1] - a[1], hover[2] - a[2])
		geometry.setAttribute('lineDistance', new THREE.Float32BufferAttribute([0, length], 1))
		return geometry
	})
	$effect(() => {
		const built = solid
		return () => built.forEach((s) => (s.line.dispose(), s.dots.dispose()))
	})
	$effect(() => {
		const built = preview
		return () => built?.dispose()
	})

	const projected = new THREE.Vector3()
	const anchor = new THREE.Vector3()
	let published = false

	useTask(
		() => {
			const next = collectItems()
			const key = next.map((c) => c.id + (c.selected ? 's' : '') + (c.editing ? 'e' : '') + c.points.map((p) => p.map((n) => n.toFixed(4)).join(',')).join(';')).join('|')
			if (key !== itemsKey) {
				itemsKey = key
				items = next
			}
			if ($isVRMode || !chains.length) {
				if (published) measureLabelViews.set([])
				published = false
				return
			}
			const cam = camera.current as any
			const element = renderer?.domElement
			if (!cam || !element) return
			const rect = element.getBoundingClientRect()
			const anchors: any[] = []
			for (const chain of chains) {
				for (const label of chainLabels(chain.points, chain.id)) {
					anchor.set(label.point[0], label.point[1], label.point[2])
					projected.copy(anchor).project(cam)
					if (projected.z >= 1 || projected.z <= -1) continue // behind the camera
					anchors.push({
						key: label.key,
						kind: label.kind,
						text: label.text,
						item: chain.item,
						x: rect.left + ((projected.x + 1) / 2) * rect.width,
						y: rect.top + ((1 - projected.y) / 2) * rect.height
					})
				}
			}
			// 48 B2: labels of short segments used to stack on top of each other
			measureLabelViews.set(layoutLabels(anchors))
			published = true
		},
		{ stage: renderStage }
	)
</script>

<!-- tokens-ok-begin: three.js line/point materials drawn in the 3D view (no CSS tokens reach a shader) -->
{#each solid as s (s.id)}
	<T.Line geometry={s.line} renderOrder={997}>
		<T.LineBasicMaterial color={!s.item ? '#ff6a1a' : s.selected || s.editing ? '#facc15' : '#38bdf8'} depthTest={false} transparent />
	</T.Line>
	<T.Points geometry={s.dots} renderOrder={998}>
		<T.PointsMaterial
			color={!s.item ? '#ff6a1a' : s.selected || s.editing ? '#facc15' : '#38bdf8'}
			size={s.editing ? EDIT_DOT_PX : DOT_PX}
			sizeAttenuation={false}
			depthTest={false}
			transparent
		/>
	</T.Points>
{/each}
{#if $isVRMode}
	<VRMeasureLabels {chains} />
{/if}
{#if preview}
	<T.Line geometry={preview} renderOrder={997}>
		<T.LineDashedMaterial color="#ff6a1a" dashSize={0.08} gapSize={0.06} depthTest={false} transparent opacity={0.85} />
	</T.Line>
{/if}
<!-- tokens-ok-end -->

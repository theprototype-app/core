<script lang="ts">
	import * as THREE from 'three'
	import { T, useTask, useThrelte, useScheduler } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import {
		annotations,
		pinsGroup,
		showNotePins,
		noteMarkers,
		displayName,
		displayAuthor,
		contrastOn,
		shadeHex,
		DEFAULT_NOTE_COLOR
	} from '$lib/annotationsHandler'
	import { objectsGroup, globalScene, isVRMode } from '../stores/sceneStore'

	// In-scene note pins — the VR path. Each pin group re-anchors to its object
	// every frame (objects move) and faces the camera; the GROUP is the note's
	// anchor and stays live in every mode (annotationWorldPosition, the popover and
	// the anchor suite all read it), while the VISUALS only render in a headset.
	//
	// On desktop the markers are screen-space DOM badges with a leader line
	// (menu/AnnotationMarkers.svelte): an in-scene quad gets CUT IN HALF by any
	// surface it touches and its occlusion is a per-pixel depth test, neither of
	// which we want. DOM can't clip against geometry and gives real typography,
	// hover states and clustering. Keeping this path for VR is deliberate — DOM is
	// invisible in a headset.
	//
	// Two passes here for the same reason as the DOM badge's translucency: the
	// depth-tested SOLID pass disappears behind geometry, the depth-test-off GHOST
	// pass survives dimly, and the number never depth-tests so an overlapping pin
	// can't hide it. Shapes (round/star/square) + a darker border + contrast ink.

	const { camera, renderer } = useThrelte()

	let root: any
	$: pinsGroup.set(root ?? null)

	const pinRefs: Record<string, any> = {}
	const local = new THREE.Vector3()
	const cameraPosition = new THREE.Vector3()

	// --- H9 shape geometries (shared instances: one per shape, not per pin) ------
	const RADIUS = 0.16
	/** the border is the SAME shape scaled up behind the fill — works for all three */
	const BORDER_SCALE = 1.2
	const SOLID_OPACITY = 0.95
	const GHOST_OPACITY = 0.3
	// The GHOST pass draws FIRST (lower renderOrder) and the depth-tested SOLID pass
	// paints over it: a visible pin then reads as its own saturated colour instead of
	// the ghost's darker border bleeding up through the fill, while an occluded pin
	// loses the solid pass to the depth test and only the dim ghost survives.
	const GHOST_BORDER = 870
	const GHOST_FILL = 871
	const SOLID_BORDER = 880
	const SOLID_FILL = 881
	const NUMBER_ORDER = 910

	function roundedSquare(half: number, radius: number) {
		const shape = new THREE.Shape()
		const inner = half - radius
		shape.moveTo(-inner, -half)
		shape.lineTo(inner, -half)
		shape.absarc(inner, -inner, radius, -Math.PI / 2, 0, false)
		shape.lineTo(half, inner)
		shape.absarc(inner, inner, radius, 0, Math.PI / 2, false)
		shape.lineTo(-inner, half)
		shape.absarc(-inner, inner, radius, Math.PI / 2, Math.PI, false)
		shape.lineTo(-half, -inner)
		shape.absarc(-inner, -inner, radius, Math.PI, Math.PI * 1.5, false)
		return new THREE.ShapeGeometry(shape, 6)
	}

	function star(outer: number, inner: number, points: number) {
		const shape = new THREE.Shape()
		for (let i = 0; i < points * 2; i++) {
			const r = i % 2 === 0 ? outer : inner
			const angle = -Math.PI / 2 + (i * Math.PI) / points
			const x = Math.cos(angle) * r
			const y = Math.sin(angle) * r
			if (i === 0) shape.moveTo(x, y)
			else shape.lineTo(x, y)
		}
		shape.closePath()
		return new THREE.ShapeGeometry(shape, 6)
	}

	const shapeGeometries: Record<string, any> = {
		round: new THREE.CircleGeometry(RADIUS, 28),
		square: roundedSquare(RADIUS * 0.94, RADIUS * 0.3),
		star: star(RADIUS * 1.32, RADIUS * 0.66, 5)
	}
	const geometryFor = (shape: string) => shapeGeometries[shape] ?? shapeGeometries.round

	// ONE shared base material for the numbers: troika derives a per-instance
	// material from it, so the per-pin `color` still applies (see its material getter)
	const numberBase = new THREE.MeshBasicMaterial({ depthTest: false, transparent: true })

	const fillOf = (a: any) => a.color || DEFAULT_NOTE_COLOR

	useTask(() => {
		if (!$showNotePins) return
		camera.current.getWorldPosition(cameraPosition)
		$annotations.forEach((annotation) => {
			const pin = pinRefs[annotation.id]
			if (!pin) return
			// N1: resolve the owner from BOTH objectsGroup (normal objects) AND the scene
			// root (system/env/module objects, annotatable since 87) — mirrors
			// annotationsHandler.objectOf. Resolving from objectsGroup only left scene-root
			// pins stranded; resolving neither (the broken ref capture below) left ALL of
			// them at the origin, which was the reported "center of world" bug.
			const owner =
				$objectsGroup?.getObjectByProperty('uuid', annotation.objectUuid) ??
				$globalScene?.getObjectByProperty('uuid', annotation.objectUuid)
			if (!owner) {
				pin.visible = false // orphaned (object gone) — hide rather than sit at origin
				return
			}
			pin.visible = true
			owner.localToWorld(local.fromArray(annotation.offset))
			pin.position.copy(local)
			pin.lookAt(cameraPosition)
			// NOTE: pins are positioned in WORLD coords but this layer rides
			// world-grab-rig, so an ACTIVE VR world-grab would double-count. Left as a
			// separate follow-up (pre-existing; desktop + normal VR are unaffected).
		})
	})

	// --- screen positions for the DOM marker layer ------------------------------
	// This runs in the RENDER stage, i.e. AFTER the main stage where OrbitControls
	// calls controls.update(). A plain requestAnimationFrame loop (what the marker
	// component used to own) is a separate callback queue: when it happened to run
	// before threlte's tick it projected LAST frame's camera, so the badge trailed
	// the geometry by a frame while orbiting — the reported jiggle. It "fixed
	// itself" after an XR session only because entering VR re-registers threlte's
	// loop and flips the callback order.
	const { renderStage } = useScheduler()
	const OCCLUSION_SLACK = 0.08 // 8cm — geometry this close never counts as cover
	const OCCLUSION_MS = 120 // raycast budget: ~8Hz; positions stay per-frame
	const NEAR_FADE = 0.9 // metres: fade when the camera is right on top of a marker
	const NEAR_HIDE = 0.35

	const anchor = new THREE.Vector3()
	const projected = new THREE.Vector3()
	const toPoint = new THREE.Vector3()
	const raycaster = new THREE.Raycaster()
	const occlusion = new Map<string, boolean>()
	let lastOcclusion = 0

	/** Is `point` genuinely behind scene geometry, ignoring anything within the slack? */
	function isOccluded(cameraPos: THREE.Vector3, point: THREE.Vector3) {
		const group = $objectsGroup
		if (!group) return false
		toPoint.subVectors(point, cameraPos)
		const distance = toPoint.length()
		if (distance <= OCCLUSION_SLACK) return false
		raycaster.set(cameraPos, toPoint.normalize())
		raycaster.near = 0
		raycaster.far = distance - OCCLUSION_SLACK
		// three does not skip hidden objects for us — a hidden mesh must not occlude
		return raycaster.intersectObject(group, true).some((hit) => {
			for (let node: any = hit.object; node && node !== group; node = node.parent)
				if (!node.visible) return false
			return true
		})
	}

	useTask(
		() => {
			if (!$showNotePins || $isVRMode) {
				if ($noteMarkers.length) noteMarkers.set([])
				return
			}
			const cam = camera.current as any
			const element = renderer?.domElement
			if (!cam || !element || !$annotations.length) {
				if ($noteMarkers.length) noteMarkers.set([])
				return
			}
			const now = performance.now()
			const testOcclusion = now - lastOcclusion > OCCLUSION_MS
			if (testOcclusion) lastOcclusion = now
			const rect = element.getBoundingClientRect()
			cam.getWorldPosition(cameraPosition)

			const views: any[] = []
			$annotations.forEach((annotation, index) => {
				const pin = pinRefs[annotation.id]
				if (!pin || !pin.visible) return
				pin.getWorldPosition(anchor)
				projected.copy(anchor).project(cam)
				if (projected.z >= 1) return // behind the camera
				const x = rect.left + ((projected.x + 1) / 2) * rect.width
				const y = rect.top + ((1 - projected.y) / 2) * rect.height
				if (x < -80 || y < -80 || x > window.innerWidth + 80 || y > window.innerHeight + 80)
					return // off-screen: skip the raycast too
				if (testOcclusion) occlusion.set(annotation.id, isOccluded(cameraPosition, anchor))
				const distance = cameraPosition.distanceTo(anchor)
				if (distance < NEAR_HIDE) return
				const color = fillOf(annotation)
				views.push({
					id: annotation.id,
					number: index + 1,
					color,
					ink: contrastOn(color),
					title: displayName(annotation),
					author: displayAuthor(annotation),
					ts: annotation.ts,
					text: annotation.text || '',
					px: x,
					py: y,
					occluded: occlusion.get(annotation.id) ?? false,
					fade: distance < NEAR_FADE ? 0.35 : 1
				})
			})
			noteMarkers.set(views)
		},
		{ stage: renderStage }
	)
</script>

<!-- H3: the pins group hides wholesale with the LOCAL showNotePins pref (the
     Scene raycast branch is gated on the same store, so hidden pins can't be
     clicked either) -->
<T.Group bind:ref={root} name="annotation-pins" visible={$showNotePins}>
	{#each $annotations as annotation, index (annotation.id)}
		<T.Group oncreate={(ref) => (pinRefs[annotation.id] = ref)} name={`pin-${annotation.id}`}>
			<!-- The pin GROUP stays exactly on the anchor (annotationWorldPosition and
			     every test read it), while the visuals sit a hair toward the camera along
			     the group's local +Z — which lookAt points at the viewer. Without it a
			     pin anchored flat ON a face half-sinks into it as the billboard rotates. -->
			{#if $isVRMode}
			<T.Group position={[0, 0, 0.06]}>
			<!-- GHOST pass (no depth test): keeps an occluded pin visible but dim -->
			<T.Mesh
				geometry={geometryFor(annotation.shape)}
				scale={BORDER_SCALE}
				position={[0, 0, -0.002]}
				renderOrder={GHOST_BORDER}
			>
				<T.MeshBasicMaterial
					color={shadeHex(fillOf(annotation))}
					transparent
					opacity={GHOST_OPACITY}
					depthTest={false}
					depthWrite={false}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			<T.Mesh geometry={geometryFor(annotation.shape)} renderOrder={GHOST_FILL}>
				<T.MeshBasicMaterial
					color={fillOf(annotation)}
					transparent
					opacity={GHOST_OPACITY}
					depthTest={false}
					depthWrite={false}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			<!-- SOLID pass (depth-tested): an object in front of the pin hides this,
			     leaving only the ghost — that is the "dim, not gone" behaviour -->
			<!-- depthWrite on purpose: the postprocessing passes (outline, N8AO) read the
			     depth buffer, so a pin that writes no depth gets the AO and selection
			     edges of whatever sits BEHIND it painted across its face -->
			<T.Mesh
				geometry={geometryFor(annotation.shape)}
				scale={BORDER_SCALE}
				position={[0, 0, -0.002]}
				renderOrder={SOLID_BORDER}
			>
				<T.MeshBasicMaterial
					color={shadeHex(fillOf(annotation))}
					transparent
					opacity={SOLID_OPACITY}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			<T.Mesh geometry={geometryFor(annotation.shape)} renderOrder={SOLID_FILL}>
				<T.MeshBasicMaterial
					color={fillOf(annotation)}
					transparent
					opacity={SOLID_OPACITY}
					side={THREE.DoubleSide}
				/>
			</T.Mesh>
			<Text
				color={contrastOn(fillOf(annotation))}
				outlineColor={contrastOn(fillOf(annotation)) === '#1c1917' ? '#ffffff' : '#000000'}
				outlineWidth={0.006}
				outlineOpacity={0.6}
				material={numberBase}
				renderOrder={NUMBER_ORDER}
				fontSize={0.16}
				anchorX="center"
				anchorY="middle"
				position={[0, 0, 0.004]}
				text={String(index + 1)}
			/>
			</T.Group>
			{/if}
		</T.Group>
	{/each}
</T.Group>

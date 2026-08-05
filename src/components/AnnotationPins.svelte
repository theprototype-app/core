<script lang="ts">
	import * as THREE from 'three'
	import { T, useTask, useThrelte } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import {
		annotations,
		pinsGroup,
		showNotePins,
		DEFAULT_NOTE_COLOR,
		shadeHex,
		contrastOn
	} from '$lib/annotationsHandler'
	import { objectsGroup, globalScene } from '../stores/sceneStore'

	// Billboarded note pins. Each pin re-anchors to its object every frame
	// (objects move) and faces the camera.
	//
	// H8 (notes v2 follow-up): every pin draws TWICE. The SOLID pass is
	// depth-tested, so scene geometry hides it; the GHOST pass skips the depth
	// test at a low opacity, so a pin behind an object stays findable as a dim
	// silhouette instead of either vanishing or punching through at full strength.
	// The old single pass was `depthTest: false` with NO renderOrder, which made
	// "does this pin draw over that object" depend on scene ADD ORDER — that is
	// why your own new pins floated on top while the ones a late joiner received
	// (objects added after the pins group) were covered.
	// The NUMBER is one pass, never depth-tested, on top of every pin mesh: it is
	// the pin's identity, so it must stay readable even when a neighbouring pin
	// overlaps it (H8 item: "number should passthrough always").
	//
	// H9: shape (round/star/square) + a darker border ring + contrast-aware ink.

	const { camera } = useThrelte()

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
			<T.Mesh position={[0, -0.19, 0]} renderOrder={GHOST_FILL}>
				<T.ConeGeometry args={[0.05, 0.12, 8]} />
				<T.MeshBasicMaterial
					color={fillOf(annotation)}
					transparent
					opacity={GHOST_OPACITY}
					depthTest={false}
					depthWrite={false}
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
			<T.Mesh position={[0, -0.19, 0]} renderOrder={SOLID_FILL}>
				<T.ConeGeometry args={[0.05, 0.12, 8]} />
				<T.MeshBasicMaterial color={fillOf(annotation)} transparent opacity={SOLID_OPACITY} />
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
		</T.Group>
	{/each}
</T.Group>

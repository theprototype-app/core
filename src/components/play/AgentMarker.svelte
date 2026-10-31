<script>
	// 55 A7 — WHERE AN AI AGENT LOOKED. An agent has no body (owner: "when AI is connected over MCP
	// it should not show a character"), so the only thing of it in the world is this: a small
	// wire camera at its last screenshot's pose and an "AI" label. Local to every peer (scene
	// root, inside Player's peer frame — never in objectsGroup, so nothing saves or replicates
	// it); on the helper layer, so it hides in Play and Interact like every other helper.
	import { T } from '@threlte/core'
	// @ts-ignore - Text typing clashes with verbatimModuleSyntax
	import { Text } from '@threlte/extras'
	import * as THREE from 'three'
	import { markHelper } from '$lib/helperLayer'

	/** @type {{ view: { pos: number[], quat: number[] }, peerId: string }} */
	let { view, peerId } = $props()
	const pos = $derived(/** @type {[number, number, number]} */ (/** @type {unknown} */ (view.pos)))
	const quat = $derived(/** @type {[number, number, number, number]} */ (/** @type {unknown} */ (view.quat)))

	// a four-sided pyramid, apex at the eye, opening along -Z (the camera convention)
	const frustum = (() => {
		const w = 0.16
		const h = 0.1
		const d = 0.24
		const p = [0, 0, 0, -w, -h, -d, w, -h, -d, w, h, -d, -w, h, -d]
		const idx = [0, 1, 0, 2, 0, 3, 0, 4, 1, 2, 2, 3, 3, 4, 4, 1]
		const g = new THREE.BufferGeometry()
		g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
		g.setIndex(idx)
		return g
	})()
	const material = new THREE.LineBasicMaterial({ color: 0x8fb3ff, transparent: true, opacity: 0.9 })

	/** @type {any} */
	let group = $state(null)
	$effect(() => {
		if (!group) return
		markHelper(group)
		// troika builds the label mesh a beat later — mark it too
		const t = setTimeout(() => markHelper(group), 600)
		return () => clearTimeout(t)
	})
	$effect(() => () => {
		frustum.dispose()
		material.dispose()
	})
</script>

<T.Group
	bind:ref={group}
	name={'agent-marker-' + peerId}
	position={pos}
	quaternion={quat}
>
	<T.LineSegments geometry={frustum} {material} />
	<!-- tokens-ok-begin: troika label drawn into the 3D view (canvas pixels), the marker frustum's blue -->
	<Text text="AI" fontSize={0.09} color="#8fb3ff" anchorX="center" anchorY="bottom" position={[0, 0.12, 0]} />
	<!-- tokens-ok-end -->
</T.Group>

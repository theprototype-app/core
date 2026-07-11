<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask } from '@threlte/core'
	import { selectedObject, isVRMode, objectsGroup, vrWireframeSelection } from '../../stores/sceneStore'

	// VR selection indicator (101/110): the desktop outline is a postprocessing
	// composer and does NOT render in WebXR. Default is a two-tone wireframe —
	// bright edges over a slightly larger dark halo, so it reads on ANY object
	// color (110); Edit ▸ Wireframe toggles back to the inflated BackSide
	// shell. It lives at the SCENE ROOT (never inside objectsGroup, so it can't
	// leak into GLTF sync) and copies the selection's world transform every
	// frame. Mesh selections derive edges from the mesh geometry; groups/
	// lights/rigs get bounding-box edges.

	let group: any = $state(null)
	let indicator: any = null
	let currentUuid = ''
	let currentStyle = ''
	let isBoxIndicator = false
	let ownedGeometries: any[] = []
	const boxSize = new THREE.Vector3(1, 1, 1)
	const boxCenter = new THREE.Vector3()

	const shellMaterial = new THREE.MeshBasicMaterial({
		color: '#ff7a1a',
		side: THREE.BackSide,
		transparent: true,
		opacity: 0.55,
		depthWrite: false
	})
	// the halo draws first and slightly larger — its dark rim keeps the bright
	// core readable whatever color the object is painted
	const haloMaterial = new THREE.LineBasicMaterial({
		color: '#10131a',
		transparent: true,
		opacity: 0.9,
		depthWrite: false
	})
	const coreMaterial = new THREE.LineBasicMaterial({
		color: '#ff7a1a',
		transparent: true,
		opacity: 0.95,
		depthWrite: false
	})

	const tempPos = new THREE.Vector3()
	const tempQuat = new THREE.Quaternion()
	const tempScale = new THREE.Vector3()

	function disposeOwned() {
		for (const geometry of ownedGeometries) geometry.dispose()
		ownedGeometries = []
	}

	// mesh selections reuse the mesh geometry (NOT disposed); everything else
	// gets an owned box fitted to the world bounds
	function baseGeometryFor(target: any) {
		if (target.isMesh && target.geometry) return { geometry: target.geometry, box: false, owned: false }
		const box = new THREE.Box3().setFromObject(target)
		if (!isFinite(box.min.x)) return null
		box.getSize(boxSize)
		const geometry = new THREE.BoxGeometry(
			Math.max(boxSize.x, 0.05),
			Math.max(boxSize.y, 0.05),
			Math.max(boxSize.z, 0.05)
		)
		return { geometry, box: true, owned: true }
	}

	function rebuild(target: any, style: string) {
		if (indicator) group?.remove(indicator)
		disposeOwned()
		indicator = null
		isBoxIndicator = false
		if (!target?.uuid) return
		const base = baseGeometryFor(target)
		if (!base) return
		isBoxIndicator = base.box
		if (base.owned) ownedGeometries.push(base.geometry)
		if (style === 'wire') {
			// 8°: low enough that curved primitives keep their grid lines
			const edges = new THREE.EdgesGeometry(base.geometry, 8)
			ownedGeometries.push(edges)
			indicator = new THREE.Group()
			const halo = new THREE.LineSegments(edges, haloMaterial)
			halo.scale.setScalar(1.015)
			halo.renderOrder = 998
			const core = new THREE.LineSegments(edges, coreMaterial)
			core.scale.setScalar(1.005)
			core.renderOrder = 999
			indicator.add(halo, core)
		} else {
			indicator = new THREE.Mesh(base.geometry, shellMaterial)
		}
		indicator.name = 'vr-selection-shell-mesh'
		group?.add(indicator)
	}

	useTask(() => {
		if (!group) return
		const target: any = $selectedObject
		const active = $isVRMode && !!target?.uuid && !!$objectsGroup?.getObjectByProperty('uuid', target.uuid)
		group.visible = active
		if (!active) return
		const style = $vrWireframeSelection ? 'wire' : 'shell'
		if (target.uuid !== currentUuid || style !== currentStyle) {
			currentUuid = target.uuid
			currentStyle = style
			rebuild(target, style)
		}
		if (!indicator) return
		target.updateMatrixWorld(true)
		target.matrixWorld.decompose(tempPos, tempQuat, tempScale)
		if (isBoxIndicator) {
			const box = new THREE.Box3().setFromObject(target)
			box.getCenter(boxCenter)
			indicator.position.copy(boxCenter)
			indicator.quaternion.identity()
			indicator.scale.set(1.04, 1.04, 1.04)
		} else {
			indicator.position.copy(tempPos)
			indicator.quaternion.copy(tempQuat)
			indicator.scale.copy(tempScale).multiplyScalar(currentStyle === 'wire' ? 1 : 1.05)
		}
	})
</script>

<T.Group bind:ref={group} name="vr-selection-shell" visible={false} />

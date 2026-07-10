<script lang="ts">
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three'
	import { T, useTask } from '@threlte/core'
	import { selectedObject, isVRMode, objectsGroup } from '../../stores/sceneStore'

	// VR selection indicator (101): the desktop outline is a postprocessing
	// composer and does NOT render in WebXR, so VR gets an inflated BackSide
	// shell instead. It lives at the SCENE ROOT (never inside objectsGroup, so
	// it can't leak into GLTF sync) and copies the selection's world transform
	// every frame. Mesh selections share the mesh geometry; groups/lights get
	// a bounding-box shell.

	let group: any = $state(null)
	let shellMesh: any = null
	let currentUuid = ''
	let boxSize = new THREE.Vector3(1, 1, 1)
	let boxCenter = new THREE.Vector3()
	let isBoxShell = false

	const shellMaterial = new THREE.MeshBasicMaterial({
		color: '#ff7a1a',
		side: THREE.BackSide,
		transparent: true,
		opacity: 0.55,
		depthWrite: false
	})

	const tempPos = new THREE.Vector3()
	const tempQuat = new THREE.Quaternion()
	const tempScale = new THREE.Vector3()

	function rebuild(target: any) {
		shellMesh?.geometry && isBoxShell && shellMesh.geometry.dispose()
		shellMesh = null
		isBoxShell = false
		if (!target?.uuid) return
		if (target.isMesh && target.geometry) {
			shellMesh = new THREE.Mesh(target.geometry, shellMaterial)
		} else {
			// groups / lights / rigs: a box shell around the world bounds
			const box = new THREE.Box3().setFromObject(target)
			if (!isFinite(box.min.x)) return
			box.getSize(boxSize)
			isBoxShell = true
			shellMesh = new THREE.Mesh(
				new THREE.BoxGeometry(Math.max(boxSize.x, 0.05), Math.max(boxSize.y, 0.05), Math.max(boxSize.z, 0.05)),
				shellMaterial
			)
		}
		shellMesh.name = 'vr-selection-shell-mesh'
		group?.add(shellMesh)
	}

	useTask(() => {
		if (!group) return
		const target: any = $selectedObject
		const active = $isVRMode && !!target?.uuid && !!$objectsGroup?.getObjectByProperty('uuid', target.uuid)
		group.visible = active
		if (!active) return
		if (target.uuid !== currentUuid) {
			currentUuid = target.uuid
			if (shellMesh) group.remove(shellMesh)
			rebuild(target)
		}
		if (!shellMesh) return
		target.updateMatrixWorld(true)
		target.matrixWorld.decompose(tempPos, tempQuat, tempScale)
		if (isBoxShell) {
			const box = new THREE.Box3().setFromObject(target)
			box.getCenter(boxCenter)
			shellMesh.position.copy(boxCenter)
			shellMesh.quaternion.identity()
			shellMesh.scale.set(1.04, 1.04, 1.04)
		} else {
			shellMesh.position.copy(tempPos)
			shellMesh.quaternion.copy(tempQuat)
			shellMesh.scale.copy(tempScale).multiplyScalar(1.05)
		}
	})
</script>

<T.Group bind:ref={group} name="vr-selection-shell" visible={false} />

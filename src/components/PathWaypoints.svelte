<script>
	import * as THREE from 'three';
	import { T, useThrelte } from '@threlte/core';
	import { Text } from '@threlte/extras';
	import { flowNodes } from '../stores/flowStore';
	import { objectsGroup, orbitControls } from '../stores/sceneStore';
	import { pathCaptureNode } from '$lib/pathCapture';
	import { setNodeData } from '$lib/nodesHandler';

	// Shows the waypoints of the path node being captured (or selected in the
	// flow editor) as numbered markers + a polyline. Markers drag on surfaces
	// (writes back through setNodeData -> replicated); right-click removes one.

	const { camera, renderer } = useThrelte();

	$: node =
		$flowNodes.find(
			(n) => n.type === 'pathpatrol' && (n.id === $pathCaptureNode || n.selected)
		) ?? null;
	$: points = node?.data.points ?? [];
	$: closed = (node?.data.mode ?? 'loop') === 'loop';
	$: linePoints =
		points.length >= 2
			? [...points, ...(closed ? [points[0]] : [])].map((p) => new THREE.Vector3(p[0], p[1], p[2]))
			: [];

	/** @type {any} */ let lineObject;
	$: if (lineObject) {
		lineObject.geometry.dispose();
		lineObject.geometry = new THREE.BufferGeometry().setFromPoints(linePoints);
	}

	/** @type {any} */ let markersGroup;
	const raycaster = new THREE.Raycaster();
	const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
	let dragIndex = -1;
	let lastSent = 0;

	function setRay(event) {
		const rect = renderer.domElement.getBoundingClientRect();
		raycaster.setFromCamera(
			new THREE.Vector2(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				-((event.clientY - rect.top) / rect.height) * 2 + 1
			),
			camera.current
		);
	}

	function markerAt(event) {
		if (!markersGroup) return null;
		setRay(event);
		const hits = raycaster.intersectObject(markersGroup, true);
		return hits.find((h) => h.object.userData.wpIndex != null) ?? null;
	}

	function onPointerDown(event) {
		if (!node || event.button !== 0) return;
		const hit = markerAt(event);
		if (!hit) return;
		dragIndex = hit.object.userData.wpIndex;
		if ($orbitControls) $orbitControls.enabled = false;
	}

	function onPointerMove(event) {
		if (dragIndex < 0 || !node) return;
		const now = performance.now();
		if (now - lastSent < 60) return;
		lastSent = now;
		setRay(event);
		const group = $objectsGroup;
		const hits = group ? raycaster.intersectObjects(group.children, true) : [];
		const target = new THREE.Vector3();
		const point = hits[0]?.point ?? (raycaster.ray.intersectPlane(ground, target) ? target : null);
		if (!point) return;
		setNodeData(node.id, {
			points: points.map((p, i) => (i === dragIndex ? [point.x, point.y, point.z] : p))
		});
	}

	function onPointerUp() {
		if (dragIndex < 0) return;
		dragIndex = -1;
		if ($orbitControls) $orbitControls.enabled = true;
	}

	function onContextMenu(event) {
		if (!node) return;
		const hit = markerAt(event);
		if (!hit) return;
		event.preventDefault();
		setNodeData(node.id, {
			points: points.filter((_, i) => i !== hit.object.userData.wpIndex)
		});
	}
</script>

<svelte:window
	on:pointerdown={onPointerDown}
	on:pointermove={onPointerMove}
	on:pointerup={onPointerUp}
	on:contextmenu={onContextMenu}
/>

{#if node && points.length > 0}
	<T.Group bind:ref={markersGroup} name="path-waypoints">
		{#each points as p, index (index)}
			<T.Mesh position={[p[0], p[1], p[2]]} userData={{ wpIndex: index }} renderOrder={5}>
				<T.SphereGeometry args={[0.09, 12, 10]} />
				<T.MeshBasicMaterial color="#ff8800" depthTest={false} transparent opacity={0.9} />
			</T.Mesh>
			<Text
				position={[p[0], p[1] + 0.28, p[2]]}
				text={String(index + 1)}
				fontSize={0.2}
				anchorX="center"
				color="#ffbb66"
			/>
		{/each}
	</T.Group>
	{#if linePoints.length >= 2}
		<T.Line bind:ref={lineObject} renderOrder={4}>
			<T.LineBasicMaterial color="#ff8800" transparent opacity={0.8} depthTest={false} />
		</T.Line>
	{/if}
{/if}

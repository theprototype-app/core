<!-- VR stick locomotion (agreed map): LEFT stick moves/strafes — toward the
     controller aim when "VR flying" is on, horizontally otherwise; holding
     the LEFT grip switches the stick to pan/elevate. The right stick does
     snap turn + teleport (vrControls.js); right grip drags the world. -->
<script lang="ts">
	import * as THREE from 'three';
	import { useThrelte, useTask } from '@threlte/core';
	import { vrFlying } from '../../stores/sceneStore';
	import { computeMoveOffset } from '$lib/vrControls';

	const { renderer, camera, scene } = useThrelte();
	const { xr } = renderer;

	// dolly keeps camera + controllers together (peers/spectate rely on it)
	const dolly = new THREE.Group();
	dolly.position.set(0, 0, 0);
	dolly.name = 'dolly';
	scene.add(dolly);
	dolly.add(camera.current);

	const cameraDir = new THREE.Vector3();
	const aimDir = new THREE.Vector3();

	useTask(() => {
		const controller1 = xr.getController(0);
		const controller2 = xr.getController(1);
		// controls must live on the dolly or they will not move with it
		dolly.add(controller1);
		dolly.add(controller2);
		dolly.add(xr.getControllerGrip(0));
		dolly.add(xr.getControllerGrip(1));

		const session = renderer.xr.getSession();
		if (!session) return;
		const space = xr.getReferenceSpace();
		if (!space) return;

		xr.getCamera(camera.current).getWorldDirection(cameraDir);

		let index = -1;
		for (const source of session.inputSources) {
			index++;
			if (!source.gamepad || source.handedness !== 'left') continue;
			const axes = source.gamepad.axes;
			const grip = !!source.gamepad.buttons[1]?.pressed;
			// aim of the left controller (pitch included) for flying
			aimDir.set(0, 0, -1).applyQuaternion(xr.getController(index).getWorldQuaternion(new THREE.Quaternion()));
			const offset = computeMoveOffset({
				x: axes[2] ?? 0,
				y: axes[3] ?? 0,
				grip,
				flying: $vrFlying,
				aimDir: { x: aimDir.x, y: aimDir.y, z: aimDir.z },
				cameraDir: { x: cameraDir.x, y: cameraDir.y, z: cameraDir.z }
			});
			if (offset.x || offset.y || offset.z) {
				xr.setReferenceSpace(space.getOffsetReferenceSpace(new XRRigidTransform(offset)));
			}
		}
	});
</script>

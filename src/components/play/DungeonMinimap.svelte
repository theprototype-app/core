<script lang="ts">
	import { onMount } from 'svelte';
	import { isLocked, globalScene, playerCam } from '../../stores/sceneStore';
	import { userdata, peers } from '../../stores/appStore';
	import { peerColor } from '$lib/lockControl';
	import { dungeonData } from '$lib/dungeonPlay';
	import { playMarkers } from '$lib/playSettings';
	// @ts-ignore - no bundled three type declarations (project-wide)
	import * as THREE from 'three';

	// Dungeon minimap (58.3): raster to canvas, you + peers as dots. Shows only
	// in play mode while a dungeon exists. Peers' world positions come from
	// their avatar groups (named by peer id).

	let canvas: HTMLCanvasElement | undefined = $state();
	let visible = $state(false);
	// B3: marker colours by KIND — a publisher names the kind, core picks the paint
	const MARKER_COLORS: Record<string, string> = {
		key: '#ffc93d',
		door: '#39d0ff',
		goal: '#f472b6',
		spawn: '#4ade80'
	};
	const SCALE = 3;
	const worldPos = new THREE.Vector3();

	function dot(ctx: CanvasRenderingContext2D, data: any, x: number, z: number, color: string) {
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc((x - data.minX) * SCALE, (z - data.minY) * SCALE, SCALE, 0, Math.PI * 2);
		ctx.fill();
	}

	function draw() {
		const data = dungeonData($globalScene);
		visible = !!($isLocked && data);
		if (!visible || !canvas || !data) return;
		const { grid, width, height, floorValue } = data;
		canvas.width = width * SCALE;
		canvas.height = height * SCALE;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.fillStyle = 'rgba(10, 12, 16, 0.92)';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = '#5c6470';
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++)
				if (grid[y * width + x] === floorValue) ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
		// the key + door landmarks. Kept as the FALLBACK, because the dungeon module
		// still names its objects that way; 21-B B3 generalises it so any publisher
		// of the play contract can put markers here (DEVX #13).
		const group = $globalScene?.getObjectByName('dungeon-module');
		const key = group?.getObjectByName('dungeon-key');
		if (key?.visible) dot(ctx, data, key.position.x, key.position.z, '#ffc93d');
		const door = group?.getObjectByName('dungeon-door');
		if (door) dot(ctx, data, door.position.x, door.position.z, '#39d0ff');
		for (const marker of playMarkers($globalScene)) {
			dot(ctx, data, marker.x, marker.z, MARKER_COLORS[marker.kind] ?? '#ffffff');
		}
		// me
		if ($playerCam) {
			($playerCam as any).getWorldPosition(worldPos);
			dot(ctx, data, worldPos.x, worldPos.z, '#4ade80');
		}
		// peers = their avatar groups
		const myId = ($peers as any)?.peer?.id;
		for (const user of $userdata ?? []) {
			if (!user[0] || user[0] === myId) continue;
			const avatar = $globalScene?.getObjectByName(user[0]);
			if (!avatar || avatar.position.y > 500) continue; // parked avatars
			dot(ctx, data, avatar.position.x, avatar.position.z, peerColor(user[0]));
		}
	}

	onMount(() => {
		const timer = setInterval(draw, 150);
		return () => clearInterval(timer);
	});
</script>

<canvas
	bind:this={canvas}
	id="dungeon-minimap"
	class="fixed bottom-4 left-4 rounded-lg border border-gray-600/70 shadow-lg {visible ? '' : 'hidden'}"
	style="z-index: var(--z-hud); image-rendering: pixelated; max-width: 260px; max-height: 220px;"
></canvas>

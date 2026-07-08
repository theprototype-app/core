<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import ContextMenu from '../ContextMenu.svelte';
	import { undo, redo, canUndo, canRedo } from '$lib/history';
	import { snapEnabled, snapSettings, surfaceSnap } from '$lib/snapping';
	import { focusObject, duplicateObject, alignToGround } from '$lib/objectActions';
	import { showGrid, isLocked, globalScene, globalCamera, globalRenderer, selectedObject } from '../../stores/sceneStore';
	import { specatorMode } from '../../stores/appStore';

	// Right-click on the viewport (a click, not an orbit-pan drag) opens this menu
	let menu: any = null;
	let downPosition: [number, number] | null = null;

	onMount(() => {
		const isViewportTarget = (target: any) => {
			const canvas = document.querySelector('canvas');
			if (!canvas || !target) return false;
			return target === canvas || (target !== document.body && target.contains?.(canvas));
		};

		const onPointerDown = (event: PointerEvent) => {
			if (event.button === 2 && isViewportTarget(event.target)) {
				downPosition = [event.clientX, event.clientY];
			}
		};

		const onContextMenu = (event: MouseEvent) => {
			if (!isViewportTarget(event.target)) return;
			event.preventDefault();
			if (!downPosition) return;
			const moved = Math.hypot(event.clientX - downPosition[0], event.clientY - downPosition[1]);
			downPosition = null;
			// right-drag pans the camera — only a stationary right-click opens the menu
			if (moved > 5) return;
			if ($isLocked || $specatorMode) return;
			menu = { x: event.clientX, y: event.clientY };
		};

		window.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('contextmenu', onContextMenu, true);
		return () => {
			window.removeEventListener('pointerdown', onPointerDown, true);
			window.removeEventListener('contextmenu', onContextMenu, true);
		};
	});

	function screenshot() {
		const renderer = get(globalRenderer) as any;
		const scene = get(globalScene) as any;
		const camera = get(globalCamera) as any;
		if (!renderer || !scene || !camera) return;
		// explicit render right before capture — the drawing buffer is not preserved
		renderer.render(scene, camera);
		renderer.domElement.toBlob((blob: Blob | null) => {
			if (!blob) return;
			const a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = `ThePrototype-${new Date().toISOString().replace(/[T:.Z]/g, '-')}.png`;
			a.click();
			URL.revokeObjectURL(a.href);
		});
	}

	const tbi = 'to be implemented';

	function snapSizeItem(key: 'translate' | 'scale', value: number, label: string) {
		return {
			label: ($snapSettings[key] === value ? '● ' : '') + label,
			action: () => snapSettings.update((s) => ({ ...s, [key]: value }))
		};
	}
	function snapRotItem(value: number) {
		return {
			label: ($snapSettings.rotateDeg === value ? '● ' : '') + `Rotate ${value}°`,
			action: () => snapSettings.update((s) => ({ ...s, rotateDeg: value }))
		};
	}

	$: items = [
		{ label: 'Undo', disabled: !$canUndo, tooltip: 'Ctrl+Z', action: undo },
		{ label: 'Redo', disabled: !$canRedo, tooltip: 'Ctrl+Y', action: redo },
		{
			label: 'Snapping',
			children: [
				{
					label: $snapEnabled ? 'Disable snapping' : 'Enable snapping',
					action: () => snapEnabled.update((v) => !v)
				},
				snapSizeItem('translate', 0.1, 'Grid 0.1'),
				snapSizeItem('translate', 0.5, 'Grid 0.5'),
				snapSizeItem('translate', 1, 'Grid 1'),
				snapRotItem(5),
				snapRotItem(15),
				snapRotItem(45),
				snapSizeItem('scale', 0.05, 'Scale 0.05'),
				snapSizeItem('scale', 0.1, 'Scale 0.1'),
				{
					label: ($surfaceSnap ? '● ' : '') + 'Snap to surface',
					tooltip: 'Dragged objects rest on whatever is underneath',
					action: () => surfaceSnap.update((v) => !v)
				}
			]
		},
		{
			label: 'Focus selected',
			disabled: !$selectedObject?.uuid,
			tooltip: 'F',
			action: () => focusObject()
		},
		{
			label: 'Duplicate selected',
			disabled: !$selectedObject?.uuid,
			tooltip: 'Ctrl+D',
			action: () => duplicateObject()
		},
		{
			label: $showGrid ? 'Hide grid' : 'Show grid',
			action: () => {
				showGrid.update((v) => !v);
				if (localStorage.getItem('showGrid')) localStorage.removeItem('showGrid');
				else localStorage.setItem('showGrid', 'false');
			}
		},
		{ label: 'Screenshot', action: screenshot },
		{
			label: 'Align to ground',
			disabled: !$selectedObject?.uuid,
			tooltip: 'Drop the selected object onto the surface below (undoable)',
			action: () => alignToGround()
		},
		{ label: 'Measure distance', disabled: true, tooltip: tbi }
	];
</script>

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} {items} on:close={() => (menu = null)} />
{/if}

<script lang="ts">
	import { get } from 'svelte/store';
	import ContextMenu from '../ContextMenu.svelte';
	import { undo, redo, canUndo, canRedo } from '$lib/history';
	import { drawMode, toggleDrawMode } from '$lib/drawMode';
	import { simulating, remoteSimulating, toggleSimulation } from '$lib/physics';
	import { nameOf } from '$lib/lockControl';
	import { snapEnabled, snapSettings, surfaceSnap } from '$lib/snapping';
	import { measureMode, toggleMeasure } from '$lib/measure';
	import { bookmarks, saveBookmark, recallBookmark, clearBookmarks } from '$lib/cameraBookmarks';
	import { showGrid, globalScene, globalCamera, globalRenderer, selectedObject } from '../../stores/sceneStore';
	import { viewportMenu, objectSearch, objectSearchEnabled } from '../../stores/appStore';
	import { buildAddChildren } from '$lib/addObjects';
	import { buildObjectMenuItems } from '$lib/objectMenu';

	// Scene.svelte routes right-TAPS here (77): empty viewport → this menu with
	// the clicked ground point; an object under the cursor → its own context
	// menu instead. Right-drag keeps orbiting.
	$: menu = $viewportMenu;
	const close = () => viewportMenu.set(null);

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
		// 125: real scene-object search + focus — opt-in via settings, hidden otherwise
		...($objectSearchEnabled
			? [
					{
						label: '🔍 Search objects…',
						tooltip: 'Find a scene object and fly to it',
						action: () => objectSearch.set({ x: menu.x, y: menu.y })
					}
				]
			: []),
		{
			label: 'Add',
			children: buildAddChildren(() => menu?.point ?? null)
		},
		{ label: 'Undo', disabled: !$canUndo, tooltip: 'Ctrl+Z', action: undo },
		{ label: 'Redo', disabled: !$canRedo, tooltip: 'Ctrl+Y', action: redo },
		// 124: everything that acts on the CURRENT SELECTION lives in one submenu.
		// Fixed "Selected" label (object names get very long) + the SAME items as the
		// direct object right-click menu (buildObjectMenuItems), so the two are in parity.
		...($selectedObject?.uuid
			? [
					{
						label: 'Selected ▸',
						children: buildObjectMenuItems($selectedObject.uuid)
					}
				]
			: []),
		{
			label: 'Tools',
			children: [
				{
					label: ($drawMode ? '● ' : '') + 'Draw mode',
					tooltip: 'Drag on surfaces to draw 3D strokes (Esc exits)',
					action: toggleDrawMode
				},
				{
					label: $measureMode ? 'Stop measuring' : 'Measure distance',
					tooltip: 'Click two points; Esc stops',
					action: () => toggleMeasure()
				},
				{
					label: $simulating ? '⏹ Stop simulation' : '▶ Simulate physics',
					disabled: !!$remoteSimulating,
					tooltip: $remoteSimulating
						? nameOf($remoteSimulating) + ' is simulating'
						: 'Objects wired to a Mass node fall and collide; stop leaves one undo step',
					action: toggleSimulation
				}
			]
		},
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
			label: 'View',
			children: [
				{
					label: $showGrid ? 'Hide grid' : 'Show grid',
					action: () => {
						showGrid.update((v) => !v);
						if (localStorage.getItem('showGrid')) localStorage.removeItem('showGrid');
						else localStorage.setItem('showGrid', 'false');
					}
				},
				{ label: 'Screenshot', action: screenshot }
			]
		},
		{
			label: 'Camera bookmarks',
			children: [
				{ label: 'Save current view', action: () => saveBookmark() },
				...$bookmarks.map((bookmark, index) => ({
					label: `View ${index + 1} — ${new Date(bookmark.ts).toLocaleTimeString()}`,
					tooltip: `Shift+${index + 1}`,
					action: () => recallBookmark(index)
				})),
				{ label: 'Clear bookmarks', disabled: $bookmarks.length === 0, action: () => clearBookmarks() }
			]
		}
	];
</script>

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} {items} on:close={close} />
{/if}

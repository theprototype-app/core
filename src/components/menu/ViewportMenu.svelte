<script lang="ts">
	import { get } from 'svelte/store';
	import ContextMenu from '../ContextMenu.svelte';
	import { undo, redo, canUndo, canRedo } from '$lib/history';
	import { drawMode, toggleDrawMode } from '$lib/drawMode';
	import { simulating, simPaused, remoteSimulating, toggleSimulation, pauseSimulation, resetSimulation } from '$lib/physics';
	import { nameOf } from '$lib/lockControl';
	import { snapEnabled, snapSettings, surfaceSnap, snapTargets } from '$lib/snapping';
	import { startSnapAnchorPick } from '$lib/snapEngine';
	import { measureMode, toggleMeasure } from '$lib/measure';
	import { bookmarks, saveBookmark, recallBookmark, clearBookmarks, SHORTCUT_SLOTS } from '$lib/cameraBookmarks';
	import { showGrid, globalScene, globalCamera, globalRenderer, selectedObject, selectedObjects, lockedObjects } from '../../stores/sceneStore';
	import { viewportMenu, objectSearch, objectSearchEnabled, openSceneSection } from '../../stores/appStore';
	import { buildAddChildren } from '$lib/addObjects';
	import { buildObjectMenuItems } from '$lib/objectMenu';
	import { sendPing } from '$lib/ping';

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

	// 16-P3: the active choice is `checked` (bold + accent) instead of a '● ' label
	// prefix, which shifted the label sideways as it appeared and read as a glitch.
	/** 16-Q5: 0.8 typed into the panel arrived here as 0.7999999999999999 — binary
	 *  floats never print cleanly, so every step label and hint goes through this. */
	const stepLabel = (value: number) => String(Number(Number(value).toFixed(4)));
	function snapSizeItem(key: 'translate' | 'scale', value: number, label?: string) {
		return {
			label: label ?? stepLabel(value),
			checked: $snapSettings[key] === value,
			action: () => snapSettings.update((s) => ({ ...s, [key]: value }))
		};
	}
	function snapRotItem(value: number) {
		return {
			label: `${stepLabel(value)}°`,
			checked: $snapSettings.rotateDeg === value,
			action: () => snapSettings.update((s) => ({ ...s, rotateDeg: value }))
		};
	}
	// 16-Q2: a step typed in Configure Scene has to be reachable — and visible as the
	// ACTIVE one — here too, so it joins the presets whenever it isn't one of them.
	function snapRow(key: 'translate' | 'scale', presets: number[]) {
		const current = $snapSettings[key];
		const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
		return values.map((value) => snapSizeItem(key, value));
	}
	function snapRotRow(presets: number[]) {
		const current = $snapSettings.rotateDeg;
		const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
		return values.map((value) => snapRotItem(value));
	}
	// 19-B: element snap targets — independent checked rows + a compact hint tag
	const ELEMENT_TARGETS: [string, string][] = [
		['vertex', 'Vertex'],
		['edge', 'Edge'],
		['face', 'Face'],
		['surface', 'Surface'],
		['object', 'Object']
	];
	function elementTargetItem(key: string, label: string) {
		return {
			label,
			checked: !!($snapTargets as any)[key],
			action: () => snapTargets.update((t: any) => ({ ...t, [key]: !t[key] }))
		};
	}
	// 'V F' when vertex + face are on — rides the parent row's hint
	$: elementTag = $snapTargets.enabled
		? ELEMENT_TARGETS.filter(([key]) => ($snapTargets as any)[key])
				.map(([, label]) => label[0])
				.join(' ')
		: '';

	$: hasSelection =
		$selectedObjects.length > 0 ||
		(!!$selectedObject?.uuid && $lockedObjects.some((lock: any) => lock[1] === $selectedObject.uuid));

	// 15-Q: same chrome family as the object menu — icons, shortcut hints, quiet
	// section labels; functionality unchanged.
	$: items = [
		// 125: real scene-object search + focus — opt-in via settings, hidden otherwise
		...($objectSearchEnabled
			? [
					{
						label: 'Search objects…',
						icon: 'search',
						tooltip: 'Find a scene object and fly to it',
						action: () => objectSearch.set({ x: menu.x, y: menu.y })
					}
				]
			: []),
		{
			label: 'Add',
			icon: 'plus',
			children: buildAddChildren(() => menu?.point ?? null)
		},
		{ label: 'Undo', icon: 'undo-2', hint: 'Ctrl+Z', disabled: !$canUndo, action: undo },
		{ label: 'Redo', icon: 'redo-2', hint: 'Ctrl+Y', disabled: !$canRedo, action: redo },
		{
			label: 'Ping here',
			icon: 'radar',
			tooltip: 'Everyone sees a pulse at this spot (or Alt+click anywhere)',
			action: () => sendPing(menu?.point ?? [0, 0, 0])
		},
		// 124: everything that acts on the CURRENT SELECTION lives in one submenu.
		// Fixed "Selected" label (object names get very long — the renderer adds the
		// ▸ chevron itself) + the SAME items as the direct object right-click menu
		// (buildObjectMenuItems), so the two are in parity.
		// 16-P6: gate on the live SET — `selectedObject` is STICKY (it keeps the last
		// object after a deselect so the open inspector has something to bind to), so
		// this submenu used to linger after clicking empty space. The one legitimate
		// empty-set state is VIEWING a peer-locked object (15-K), which keeps its
		// view-only actions (Request control, Focus…).
		...(hasSelection
			? [
					{
						label: 'Selected',
						icon: 'box',
						children: buildObjectMenuItems($selectedObject.uuid)
					}
				]
			: []),
		{ section: 'Tools & view' },
		{
			label: 'Tools',
			icon: 'wrench',
			children: [
				{
					label: 'Draw mode',
					checked: $drawMode,
					tooltip: 'Drag on surfaces to draw 3D strokes (Esc exits)',
					action: toggleDrawMode
				},
				{
					label: $measureMode ? 'Stop measuring' : 'Measure distance',
					checked: $measureMode,
					tooltip: 'Click two points; Esc stops',
					action: () => toggleMeasure()
				},
				{
					label: $simulating ? '⏹ Stop simulation' : '▶ Simulate physics',
					disabled: !!$remoteSimulating,
					tooltip: $remoteSimulating
						? nameOf($remoteSimulating) + ' is simulating'
						: 'Dynamic objects fall and collide; stop leaves one undo step (P)',
					action: toggleSimulation
				},
				...($simulating
					? [
							{
								label: $simPaused ? '▶ Resume simulation' : '⏸ Pause simulation',
								action: () => pauseSimulation()
							},
							{
								label: '↺ Reset simulation',
								tooltip: 'Restore the initial layout (no undo entry)',
								action: () => resetSimulation()
							}
						]
					: [])
			]
		},
		{
			// 16-P3: sectioned instead of one flat run of steps — the parent row shows
			// the live values so you can read the current setup without opening it
			label: 'Snapping',
			icon: 'grid-3x3',
			hint:
				($snapEnabled
					? `${stepLabel($snapSettings.translate)} · ${stepLabel($snapSettings.rotateDeg)}° · ${stepLabel($snapSettings.scale)}`
					: 'off') + (elementTag ? ` · ${elementTag}` : ''),
			children: [
				{
					label: $snapEnabled ? 'Disable snapping' : 'Enable snapping',
					icon: 'magnet',
					action: () => snapEnabled.update((v) => !v)
				},
				{ section: 'Position' },
				...snapRow('translate', [0.1, 0.25, 0.5, 1]),
				{ section: 'Rotation' },
				...snapRotRow([5, 15, 45, 90]),
				{ section: 'Scale' },
				...snapRow('scale', [0.05, 0.1, 0.25]),
				{ section: 'Surface' },
				{
					label: 'Snap to surface',
					checked: $surfaceSnap,
					tooltip: 'Dragged objects rest on whatever is underneath',
					action: () => surfaceSnap.update((v) => !v)
				},
				// 19-B: element targets — while one is under the cursor during a gizmo
				// translate drag, it takes priority over the grid steps
				{ section: 'Elements' },
				...ELEMENT_TARGETS.map(([key, label]) => elementTargetItem(key, label)),
				// P4: rotate the dragged object onto the candidate normal (face/surface)
				{
					label: 'Align to normal',
					checked: $snapTargets.alignNormal,
					tooltip: 'Snapping to a face also turns the object onto that surface',
					action: () => snapTargets.update((t: any) => ({ ...t, alignNormal: !t.alignNormal }))
				},
				// P3: pick the transient snap anchor (needs exactly one selection)
				...($selectedObjects.length === 1
					? [
							{
								label: 'Pick snap origin',
								icon: 'crosshair',
								tooltip: 'Click a point on the selected object — drags snap that point',
								action: () => startSnapAnchorPick()
							}
						]
					: []),
				{ section: ' ' },
				{
					label: 'More snapping settings…',
					icon: 'sliders-horizontal',
					tooltip: 'Custom steps live in Configure Scene ▸ Snapping',
					action: () => openSceneSection('Snapping')
				}
			]
		},
		{
			label: 'View',
			icon: 'eye',
			children: [
				{
					label: 'Show grid',
					checked: !!$showGrid,
					action: () => {
						showGrid.update((v) => !v);
						if (localStorage.getItem('showGrid')) localStorage.removeItem('showGrid');
						else localStorage.setItem('showGrid', 'false');
					}
				},
				{
					label: 'Grid & axes settings…',
					icon: 'sliders-horizontal',
					tooltip: 'Cell size, colours, fade and the origin axes (Configure Scene ▸ Grid)',
					action: () => openSceneSection('Grid')
				},
				{ label: 'Screenshot', icon: 'camera', action: screenshot }
			]
		},
		{
			// 16-P4: bookmarks are NAMED now (and unlimited) — list them by name with
			// the Shift+N hint on the first five; managing them lives in the panel
			label: 'Camera bookmarks',
			icon: 'camera',
			hint: $bookmarks.length ? String($bookmarks.length) : '',
			children: [
				{ label: 'Save current view', icon: 'plus', action: () => saveBookmark() },
				...($bookmarks.length ? [{ section: 'Saved views' }] : []),
				...$bookmarks.map((bookmark, index) => ({
					label: bookmark.name,
					hint: index < SHORTCUT_SLOTS ? `⇧${index + 1}` : '',
					tooltip: bookmark.lens
						? `Restores the view and its lens (${Math.round(bookmark.lens.fov)}° FOV)`
						: 'Saved before lenses were stored — restores the view only',
					action: () => recallBookmark(index)
				})),
				{ section: ' ' },
				{
					label: 'Manage saved views…',
					icon: 'sliders-horizontal',
					tooltip: 'Rename, re-shoot, reorder or delete (Configure Scene ▸ Camera)',
					// 16-Q5: land on SAVED VIEWS, not the top of the Camera section
					action: () => openSceneSection('Camera:Saved views')
				},
				{
					label: 'Clear bookmarks',
					icon: 'trash-2',
					danger: true,
					disabled: $bookmarks.length === 0,
					action: () => clearBookmarks()
				}
			]
		}
	];
</script>

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} {items} sizeKey="viewport" on:close={close} />
{/if}

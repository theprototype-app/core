import { get } from 'svelte/store';
import { objectsGroup, lockedObjects } from '../stores/sceneStore';
import { mutedFlowObjects } from '../stores/flowStore';
import { renamingObject } from '../stores/appStore';
import {
	focusObject,
	duplicateObject,
	duplicateSelection,
	alignToGround,
	requestDeleteSelection,
	groupSelection,
	ungroupObject,
	selectObject,
	selectionUuids
} from './objectActions';
import { requestControl, nameOf } from './lockControl';
import { createJoint, detachJoints, jointsFor } from './joints';
import { addParticlesPreset, removeObjectParticles, burstObjectParticles } from './particleActions';
import { PARTICLE_PRESETS } from './particlePresets';
import { savePrefab, savePrefabSelection } from './prefabs';
import { enterEditMode } from './meshEdit';
import { addAnnotation } from './annotationsHandler';
import { pingObject, pingObjects } from './ping';

/**
 * The FULL object context menu, shared so the direct object menu (right-click an
 * object / an object-list row, Controls.svelte) and the empty-space menu's
 * "Selected" submenu (ViewportMenu.svelte) expose the SAME actions — they used to
 * drift (the indirect path had fewer). Reads stores via get() (menus rebuild on
 * open, so this is fine).
 *
 * Multi-select aware (U-2): when the right-clicked uuid is part of the current
 * selection AND the selection has 2+ members, set-oriented items act on the whole
 * SET with a counted label; a "Group selection" item appears. Object-specific
 * items (rename / edit mesh / add note / request control) stay on the clicked one.
 * @param {string} uuid @param {{ point?: number[] | null, locked?: boolean, selection?: string[] }} [opts]
 */
export function buildObjectMenuItems(uuid, opts = {}) {
	const point = opts.point ?? null;
	const locks = get(lockedObjects);
	const locked = opts.locked ?? !!locks.find((lock) => lock[1] === uuid);
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	const muted = get(mutedFlowObjects).includes(uuid);
	const lockHolder = locks.find((lock) => lock[1] === uuid)?.[0];
	const lockedTooltip = locked ? 'Locked by ' + nameOf(lockHolder) : '';

	// selection set the clicked object belongs to (empty when it's a lone click)
	const selection = opts.selection ?? selectionUuids();
	const multi = selection.length > 1 && selection.includes(uuid);
	const targets = multi ? selection : [uuid];
	const suffix = multi ? ` (${targets.length})` : '';
	const isGroup = object?.type === 'Group';

	/** run a per-object action across the target set */
	const forEach = (/** @type {(u: string) => void} */ fn) => () => targets.forEach(fn);

	// 15-Q approved layout: header (what this acts on) · transform/create ops ·
	// EDIT · PHYSICS & EFFECTS · SHARE · Delete. Show/Hide removed — the object
	// list's eye toggle owns visibility (an object hidden from the menu can't be
	// right-clicked back). Icons are lucide kebab names (ui/Icon.svelte);
	// shortcut hints render as the dimmed right column.
	return [
		{
			header: {
				title: multi ? targets.length + ' objects selected' : object?.name || object?.type || 'Object',
				badge: multi ? 'set' : object?.type,
				locked: locked ? nameOf(lockHolder) : null
			}
		},
		...(locked
			? [
					{
						label: 'Request control',
						icon: 'hand',
						tooltip: 'Ask ' + nameOf(lockHolder) + ' to hand the object over',
						action: () => requestControl(uuid)
					}
				]
			: []),
		{ label: 'Focus camera' + suffix, icon: 'focus', hint: 'F', action: () => focusObject(multi ? undefined : uuid) },
		{
			label: 'Duplicate' + suffix,
			icon: 'copy',
			hint: 'Ctrl+D',
			action: () => (multi ? duplicateSelection() : duplicateObject(uuid))
		},
		...(multi
			? [
					{
						label: 'Group selection' + suffix,
						icon: 'group',
						tooltip: 'Move the selected objects into one new group',
						action: () => groupSelection()
					}
				]
			: []),
		...(isGroup
			? [
					{
						label: 'Ungroup',
						icon: 'ungroup',
						disabled: locked,
						tooltip: locked ? lockedTooltip : 'Move the children out, then remove the empty group',
						action: () => ungroupObject(uuid)
					}
				]
			: []),
		{
			label: 'Align to ground' + suffix,
			icon: 'arrow-down-to-line',
			disabled: locked,
			tooltip: locked ? lockedTooltip : 'Drop onto the surface below (undoable)',
			action: forEach((u) => alignToGround(u))
		},
		{ section: 'Edit' },
		// 15-O: an explicit way in — a plain click only selects now, so this and a
		// double-click are how the panel opens when it is not pinned
		{
			label: 'Properties',
			icon: 'sliders-horizontal',
			tooltip: 'Open the properties panel (double-click does this too)',
			action: () => selectObject(uuid, true)
		},
		{ label: 'Rename', icon: 'pencil', disabled: locked, tooltip: lockedTooltip, action: () => renamingObject.set(uuid) },
		// 15-B8: Edit mesh / Sculpt are SINGLE-object modes — with a set selected
		// they'd silently act on the last-picked object only (the ViewportMenu path
		// passes the sticky primary), so hide them rather than mislead.
		...(multi
			? []
			: [
					{
						label: 'Edit mesh',
						icon: 'pen-tool',
						disabled: locked || !object?.geometry?.attributes?.position,
						tooltip: locked ? lockedTooltip : 'Drag vertex handles; Esc to finish',
						action: () => enterEditMode(uuid)
					}
				]),
		// T-2: brush sculpting — Terrain keeps its column brush; any other mesh
		// gets the normal-brush MESH sculpt (same toolbar + replication)
		...(multi
			? []
			: object?.userData?.terrain
				? [
						{
							label: 'Sculpt terrain',
							icon: 'brush',
							disabled: locked,
							tooltip: locked ? lockedTooltip : 'Brush raise/lower/smooth/flatten — drag on the terrain',
							action: () => import('./terrainSculpt').then((m) => m.enterSculpt(uuid))
						}
					]
				: object?.geometry?.attributes?.position
					? [
							{
								label: 'Sculpt mesh',
								icon: 'brush',
								disabled: locked,
								tooltip: locked
									? lockedTooltip
									: 'Brush raise/lower/smooth/flatten along the surface normals',
								action: () => import('./terrainSculpt').then((m) => m.enterSculpt(uuid))
							}
						]
					: []),
		{ section: 'Physics & effects' },
		// P-B: joints — attach exactly TWO objects (weld holds the pose, a hinge
		// spins about the FIRST-clicked object's chosen local axis, anchored at
		// the second object's origin); Detach appears when any joint touches this
		...(targets.length === 2 || jointsFor(targets).length
			? [
					{
						label: 'Physics',
						icon: 'magnet',
						children: [
							...(targets.length === 2
								? [
										{
											label: 'Weld together',
											tooltip: 'Fixed joint — they move as one during simulations',
											action: () => createJoint('fixed', targets[0], targets[1])
										},
										...['x', 'y', 'z'].map((axis) => ({
											label: `Hinge (${axis.toUpperCase()} axis)`,
											tooltip: 'Revolute joint about the first object’s local ' + axis.toUpperCase() + ' axis, anchored at the second object',
											action: () => createJoint('revolute', targets[0], targets[1], /** @type {'x'|'y'|'z'} */ (axis))
										}))
									]
								: []),
							...(jointsFor(targets).length
								? [
										{
											label: `Detach joints (${jointsFor(targets).length})`,
											danger: true,
											action: () => detachJoints(targets)
										}
									]
								: [])
						]
					}
				]
			: []),
		// PFX-A: particle emitters — add a preset / burst / remove, set-aware
		{
			label: 'Effects',
			icon: 'sparkles',
			children: [
				...PARTICLE_PRESETS.map((preset) => ({
					label: preset.name + suffix,
					tooltip: 'Attach a ' + preset.name + ' particle emitter (tweak it in Properties)',
					action: forEach((u) => addParticlesPreset(u, preset.key))
				})),
				...(targets.some((u) => group?.getObjectByProperty('uuid', u)?.userData?.particles?.mode === 'burst')
					? [
							{
								label: 'Burst now' + suffix,
								tooltip: 'Fire the burst emitters — every peer sees it',
								action: forEach((u) => burstObjectParticles(u))
							}
						]
					: []),
				...(targets.some((u) => group?.getObjectByProperty('uuid', u)?.userData?.particles)
					? [
							{
								label: 'Remove particles' + suffix,
								danger: true,
								action: forEach((u) => removeObjectParticles(u))
							}
						]
					: [])
			]
		},
		{
			label: (muted ? 'Enable flow effects' : 'Disable flow effects') + suffix,
			icon: 'workflow',
			action: forEach((u) =>
				mutedFlowObjects.update((list) =>
					list.includes(u) ? list.filter((entry) => entry !== u) : [...list, u]
				)
			)
		},
		{
			// H5: embed this object's flow into the SCENE graph as an Object Flow node
			label: 'Add flow to Scene graph',
			icon: 'git-branch-plus',
			tooltip: 'Embed this object’s flow as a node with its declared inputs/outputs',
			action: () =>
				Promise.all([import('./objectFlow'), import('../stores/flowStore'), import('../stores/appStore')]).then(
					([objectFlow, flowStore, appStore]) => {
						if (!flowStore.graphExists(uuid)) {
							appStore.showToast('This object has no flow yet — select it in the Flow editor and click Create flow.');
							return;
						}
						const added = objectFlow.addObjectFlowToScene(uuid, object?.name || object?.type);
						appStore.showToast(added ? 'Object Flow node added to the Scene graph' : 'This flow is already embedded in the Scene graph');
					}
				)
		},
		{ section: 'Share' },
		{
			label: multi ? 'Ping selection' + suffix : 'Ping this object',
			icon: 'radar',
			tooltip: 'Everyone sees a pulse here (Alt+click pings anywhere)',
			action: () => (multi ? pingObjects(targets) : pingObject(uuid))
		},
		{ label: 'Add note', icon: 'sticky-note', tooltip: 'Pin a synced note exactly where you pointed', action: () => addAnnotation(uuid, point) },
		{
			label: 'Save as prefab' + suffix,
			icon: 'package',
			tooltip: 'Reusable copy in your Library (local, instances replicate)',
			action: () => (multi ? savePrefabSelection(targets) : savePrefab(uuid))
		},
		{ section: ' ' },
		{
			label: 'Delete' + suffix,
			icon: 'trash-2',
			hint: 'Del',
			danger: true,
			disabled: locked,
			tooltip: locked ? lockedTooltip : 'A group asks first',
			// when the clicked object is part of the selection, delete the whole set;
			// otherwise select just this one first so the delete acts on it
			action: () => {
				if (!multi) selectObject(uuid);
				requestDeleteSelection();
			}
		}
	];
}

import { get } from 'svelte/store';
import { objectsGroup, lockedObjects } from '../stores/sceneStore';
import { mutedFlowObjects } from '../stores/flowStore';
import { renamingObject } from '../stores/appStore';
import {
	focusObject,
	duplicateObject,
	duplicateSelection,
	toggleObjectVisibility,
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

	return [
		...(locked
			? [
					{
						label: 'Request control',
						tooltip: 'Ask ' + nameOf(lockHolder) + ' to hand the object over',
						action: () => requestControl(uuid)
					}
				]
			: []),
		{ label: 'Focus camera' + suffix, tooltip: 'F', action: () => focusObject(multi ? undefined : uuid) },
		{
			label: 'Duplicate' + suffix,
			tooltip: 'Ctrl+D',
			action: () => (multi ? duplicateSelection() : duplicateObject(uuid))
		},
		...(multi
			? [
					{
						label: 'Group selection' + suffix,
						tooltip: 'Move the selected objects into one new group',
						action: () => groupSelection()
					}
				]
			: []),
		// P-B: joints — attach exactly TWO objects (weld holds the pose, a hinge
		// spins about the FIRST-clicked object's chosen local axis, anchored at
		// the second object's origin); Detach appears when any joint touches this
		...(targets.length === 2 || jointsFor(targets).length
			? [
					{
						label: 'Physics',
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
		...(isGroup
			? [
					{
						label: 'Ungroup',
						disabled: locked,
						tooltip: locked ? lockedTooltip : 'Move the children out, then remove the empty group',
						action: () => ungroupObject(uuid)
					}
				]
			: []),
		{
			label: 'Save as prefab' + suffix,
			tooltip: 'Reusable copy in your Library (local, instances replicate)',
			action: () => (multi ? savePrefabSelection(targets) : savePrefab(uuid))
		},
		{
			label: 'Align to ground' + suffix,
			disabled: locked,
			tooltip: locked ? lockedTooltip : 'Drop onto the surface below (undoable)',
			action: forEach((u) => alignToGround(u))
		},
		{
			label: 'Edit mesh',
			disabled: locked || !object?.geometry?.attributes?.position,
			tooltip: locked ? lockedTooltip : 'Drag vertex handles; Esc to finish',
			action: () => enterEditMode(uuid)
		},
		// T-2: brush sculpting — Terrain keeps its column brush; any other mesh
		// gets the normal-brush MESH sculpt (same toolbar + replication)
		...(object?.userData?.terrain
			? [
					{
						label: 'Sculpt terrain',
						disabled: locked,
						tooltip: locked ? lockedTooltip : 'Brush raise/lower/smooth/flatten — drag on the terrain',
						action: () => import('./terrainSculpt').then((m) => m.enterSculpt(uuid))
					}
				]
			: object?.geometry?.attributes?.position
				? [
						{
							label: 'Sculpt mesh',
							disabled: locked,
							tooltip: locked
								? lockedTooltip
								: 'Brush raise/lower/smooth/flatten along the surface normals',
							action: () => import('./terrainSculpt').then((m) => m.enterSculpt(uuid))
						}
					]
				: []),
		{ label: 'Add note', tooltip: 'Pin a synced note exactly where you pointed', action: () => addAnnotation(uuid, point) },
		{
			label: multi ? 'Ping selection' + suffix : 'Ping this object',
			tooltip: 'Everyone sees a pulse here (Alt+click pings anywhere)',
			action: () => (multi ? pingObjects(targets) : pingObject(uuid))
		},
		{ label: 'Rename', disabled: locked, tooltip: lockedTooltip, action: () => renamingObject.set(uuid) },
		{
			label: object?.visible === false ? 'Show' + suffix : 'Hide' + suffix,
			disabled: locked,
			tooltip: lockedTooltip,
			action: forEach((u) => toggleObjectVisibility(u))
		},
		{
			label: (muted ? 'Enable flow effects' : 'Disable flow effects') + suffix,
			action: forEach((u) =>
				mutedFlowObjects.update((list) =>
					list.includes(u) ? list.filter((entry) => entry !== u) : [...list, u]
				)
			)
		},
		{
			// H5: embed this object's flow into the SCENE graph as an Object Flow node
			label: 'Add flow to Scene graph',
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
		{
			label: 'Delete' + suffix,
			danger: true,
			disabled: locked,
			tooltip: locked ? lockedTooltip : 'Del — a group asks first',
			// when the clicked object is part of the selection, delete the whole set;
			// otherwise select just this one first so the delete acts on it
			action: () => {
				if (!multi) selectObject(uuid);
				requestDeleteSelection();
			}
		}
	];
}

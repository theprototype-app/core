import { get } from 'svelte/store';
import { objectsGroup, lockedObjects } from '../stores/sceneStore';
import { mutedFlowObjects } from '../stores/flowStore';
import { renamingObject } from '../stores/appStore';
import {
	focusObject,
	duplicateObject,
	toggleObjectVisibility,
	alignToGround,
	requestDeleteSelection,
	selectObject
} from './objectActions';
import { requestControl, nameOf } from './lockControl';
import { savePrefab } from './prefabs';
import { enterEditMode } from './meshEdit';
import { addAnnotation } from './annotationsHandler';
import { pingObject } from './ping';

/**
 * The FULL object context menu, shared so the direct object menu (right-click an
 * object / an object-list row, Controls.svelte) and the empty-space menu's
 * "Selected" submenu (ViewportMenu.svelte) expose the SAME actions — they used to
 * drift (the indirect path had fewer). Reads stores via get() (menus rebuild on
 * open, so this is fine).
 * @param {string} uuid @param {{ point?: number[] | null, locked?: boolean }} [opts]
 */
export function buildObjectMenuItems(uuid, opts = {}) {
	const point = opts.point ?? null;
	const locks = get(lockedObjects);
	const locked = opts.locked ?? !!locks.find((lock) => lock[1] === uuid);
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const muted = get(mutedFlowObjects).includes(uuid);
	const lockHolder = locks.find((lock) => lock[1] === uuid)?.[0];
	const lockedTooltip = locked ? 'Locked by ' + nameOf(lockHolder) : '';
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
		{ label: 'Focus camera', tooltip: 'F', action: () => focusObject(uuid) },
		{ label: 'Duplicate', tooltip: 'Ctrl+D', action: () => duplicateObject(uuid) },
		{
			label: 'Save as prefab',
			tooltip: 'Reusable copy in your Library (local, instances replicate)',
			action: () => savePrefab(uuid)
		},
		{
			label: 'Align to ground',
			disabled: locked,
			tooltip: locked ? lockedTooltip : 'Drop the object onto the surface below (undoable)',
			action: () => alignToGround(uuid)
		},
		{
			label: 'Edit mesh',
			disabled: locked || !object?.geometry?.attributes?.position,
			tooltip: locked ? lockedTooltip : 'Drag vertex handles; Esc to finish',
			action: () => enterEditMode(uuid)
		},
		{ label: 'Add note', tooltip: 'Pin a synced note exactly where you pointed', action: () => addAnnotation(uuid, point) },
		{
			label: 'Ping this object',
			tooltip: 'Everyone sees a pulse here (Alt+click pings anywhere)',
			action: () => pingObject(uuid)
		},
		{ label: 'Rename', disabled: locked, tooltip: lockedTooltip, action: () => renamingObject.set(uuid) },
		{
			label: object?.visible === false ? 'Show' : 'Hide',
			disabled: locked,
			tooltip: lockedTooltip,
			action: () => toggleObjectVisibility(uuid)
		},
		{
			label: muted ? 'Enable flow effects' : 'Disable flow effects',
			action: () =>
				mutedFlowObjects.update((list) => (muted ? list.filter((u) => u !== uuid) : [...list, uuid]))
		},
		{
			label: 'Delete',
			danger: true,
			disabled: locked,
			tooltip: locked ? lockedTooltip : 'Del — a group asks first',
			// select the target first so the (selection-based) delete acts on it
			action: () => {
				selectObject(uuid);
				requestDeleteSelection();
			}
		}
	];
}

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
	convertToMesh,
	selectObject,
	applySelectionSet,
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
		// Ungroup is single-target (the clicked object); during a multi-select the
		// header says "N objects selected", so acting on one of them would mislead
		...(isGroup && !multi
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
		// 15-G: bake a group / a set of meshes down to ONE mesh (materials kept as
		// slots, originals deleted, one undo step)
		...(multi || isGroup
			? [
					{
						label: 'Convert to mesh' + suffix,
						icon: 'combine',
						disabled: locked,
						tooltip: locked
							? lockedTooltip
							: 'Merge into a single mesh — every material is kept as a slot',
						action: () => convertToMesh(targets)
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
		// 16-P5: camera objects get their two headline actions right here (the rest
		// live in Properties ▸ Camera)
		...(!multi && object?.userData?.camera
			? [
					{
						label: 'Preview camera',
						icon: 'camera',
						tooltip: 'Render the scene through this camera (exit from the banner)',
						action: () =>
							import('./cameraPreview').then((m) => m.startCameraPreview(uuid))
					},
					{
						label: 'Set from current view',
						icon: 'focus',
						disabled: locked,
						tooltip: locked ? lockedTooltip : 'Move this camera to where you are looking from',
						action: () => import('./cameraObjects').then((m) => m.setCameraFromView(uuid))
					}
				]
			: []),
		{ section: 'Edit' },
		// 15-O: an explicit way in — a plain click only selects now, so this and a
		// double-click are how the panel opens when it is not pinned
		{
			label: 'Properties',
			icon: 'sliders-horizontal',
			tooltip: 'Open the properties panel (double-click does this too)',
			// 15-G audit: during a multi-select, selectObject(uuid) would COLLAPSE the
			// set to the clicked object — re-apply the set instead so the panel opens
			// on what the header says it acts on
			action: () => (multi ? applySelectionSet(targets, true) : selectObject(uuid, true))
		},
		// 15-G audit: renaming is inherently single-target (one name field)
		...(multi
			? []
			: [
					{
						label: 'Rename',
						icon: 'pencil',
						disabled: locked,
						tooltip: lockedTooltip,
						action: () => renamingObject.set(uuid)
					}
				]),
		// SH5: the Shader editor is scoped by the SELECTION, so this entry makes the object
		// current and shows the tab. Single-object for the same reason Edit mesh is — with a
		// set selected the editor scopes to the SCENE-wide graph, which is a different thing
		// from "this object's material" and would silently be the wrong target.
		...(multi
			? []
			: [
					{
						label: 'Edit shader',
						icon: 'sparkles',
						disabled: locked || !object?.material || Array.isArray(object?.material),
						tooltip: locked
							? lockedTooltip
							: Array.isArray(object?.material)
								? 'Shader graphs support single-material objects for now'
								: 'Author this material as a node graph',
						action: () => {
							selectObject(uuid, false);
							import('./shaderGraph').then((m) => m.openShaderEditor());
						}
					}
				]),
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
		// 57.3: a spline carries its authoring record, so it gets its OWN editor
		// (control-point + radius handles) instead of the raw vertex tools
		...(multi || !object?.userData?.spline?.points?.length
			? []
			: [
				{
					label: 'Edit spline',
					icon: 'spline',
					disabled: locked,
					tooltip: locked ? lockedTooltip : 'Move control points, set thickness, insert or delete points',
					action: () => import('./splineEdit').then((m) => m.enterSplineEdit(uuid))
				},
				// 21-C3: FLATTEN is two operations, not one. Once a scene holds a spline
				// AND some ground, "flatten" is ambiguous, and the two readings are
				// genuinely different jobs: cut a bed for the path, or lay the path over
				// ground you want left exactly as it is. So it is a CATEGORY, and each
				// side names which of the two things moves.
				//
				// Neither lists its targets by NAME: you click the partner in the viewport
				// (the snapAnchorPicking shape), because the thing you mean is under the
				// cursor and a ring of ten terrain tiles makes a list of names useless.
				{
					label: 'Flatten',
					icon: 'mountain',
					children: [
						{
							label: 'Terrain to this spline…',
							icon: 'mountain',
							disabled: locked,
							tooltip: locked
								? lockedTooltip
								: 'Then click a terrain: levels a strip under this spline, blended into the slope either side',
							action: () => import('./flattenActions').then((m) => m.startFlattenPick('carve', uuid))
						},
						{
							label: 'This spline onto a surface…',
							icon: 'spline',
							disabled: locked,
							tooltip: locked
								? lockedTooltip
								: 'Then click an object: drops every control point onto it, so the spline comes to rest on the surface and the surface is untouched',
							action: () => import('./flattenActions').then((m) => m.startFlattenPick('drape', uuid))
						}
					]
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
		// 21-E8: RECIPES - a whole authored behaviour in one click. "Make collectible" is
		// five nodes and four wires a user would otherwise draw ONCE PER GEM, and every
		// piece of it already existed (E4 latch/gate, the game variables, the replicated
		// click) - assembling it was the only thing missing. What it leaves behind is an
		// ORDINARY graph, so it replicates, undoes and can be taken apart afterwards.
		//
		// Reached by dynamic import like physics/terrainSculpt: this builder stays lean and
		// a recipe writes to the flow graph and records history.
		{
			label: 'Game',
			icon: 'gamepad-2',
			children: [
				{
					label: 'Make collectible' + suffix,
					disabled: locked,
					tooltip: locked
						? lockedTooltip
						: multi
							? 'Each one hides itself for everyone when clicked and adds 1 to the shared “gems” variable'
							: 'Clicking it hides it for everyone and adds 1 to the shared “gems” variable - and it stays collected',
					action: () => import('./gameRecipes').then((m) => m.makeCollectible(targets))
				},
				// listed rather than hidden, so the shape of the feature is visible: a
				// respawning pickup needs something to spawn it back, which is a different
				// batch. A greyed row with the reason beats a missing one.
				{
					label: 'Collectible (respawns)' + suffix,
					disabled: true,
					tooltip: '21-B B7 (spawn) ships this'
				}
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
		// 15-G audit: one embed carries ONE object's declared sockets — single-target
		...(multi
			? []
			: [
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
					}
				]),
		{ section: 'Share' },
		{
			label: multi ? 'Ping selection' + suffix : 'Ping this object',
			icon: 'radar',
			tooltip: 'Everyone sees a pulse here (Alt+click pings anywhere)',
			action: () => (multi ? pingObjects(targets) : pingObject(uuid))
		},
		// 15-G audit: a note pins to ONE point on ONE object. The ViewportMenu path
		// passes the sticky primary (not necessarily what is under the cursor), so
		// during a multi-select this would anchor somewhere the user did not point.
		...(multi
			? []
			: [
					{
						label: 'Add note',
						icon: 'sticky-note',
						tooltip: 'Pin a synced note exactly where you pointed',
						action: () => addAnnotation(uuid, point)
					}
				]),
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

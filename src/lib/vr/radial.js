// VR controls — the radial menu: menu raycast + stick selection, executeVRMenuAction, spawning primitives, ping.
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import {
	objectsGroup,
	lockedObjects,
	globalCamera,
	showGrid,
	vrMenuHand,
	vrMenuOpen,
	vrTransformMode,
	vrSnapAngle,
	vrMirrorSnapTurn,
	vrTeleportEnabled,
	vrVertexHold,
	vrSettingsPanelOpen,
	selectedObject,
	isVRMode,
	vrPassthrough,
	vrObjectsPanelOpen,
	vrChatPanelOpen,
	vrPaletteOpen,
	vrPropsPanelOpen,
	vrPrefabsPanelOpen,
	vrPrefabsPinned,
	vrEditMenuOpen,
	vrStretchAxis,
	vrSnapMenuOpen,
	vrWireframeSelection,
	vrStatsOpen,
	vrGrabStyle,
	vrToolMode,
	vrTargetHz,
	vrSleeveEnabled,
	peerHandStyle,
	pokeScene
} from '../../stores/sceneStore';
import { activeRing, findMenuEntry, pushRing, popRing, vrMenuPressed } from '../vrRadialMenu';
import { registerSettingsRings } from './settingsRings.js';
import { activateVRSetting, vrSettingsPage, openVRSettingsPage, cycleBinding, vrSettingsCursor } from './settingsSchema.js';
import { perfStatsShown } from '../fpsMeter';
import {
	editingObject,
	enterEditMode,
	exitEditMode,
	vrVertexEditable,
	vrVertexCap,
	vertexCount,
	createSelectedFace,
	clearVertexSelection,
	vertexSelectionSize
} from '../meshEdit';
import { sealEditHistorySession } from '../editSession';
import {
	faceEditObject,
	faceEditAmount,
	enterFaceEdit,
	exitFaceEdit,
	vrFaceEditable,
	vrFaceCap,
	triangleCount,
	editCapToast,
	setFaceOp,
	commitFaceOp,
	cancelFaceAdjust,
	faceGesturePending,
	faceEditMulti,
	faceEditSelectedTris,
	toggleFaceGranularity,
	toggleFaceMulti
} from '../faceEdit';
import { peers, showToast, pendingApprovals } from '../../stores/appStore';
import { approvePeer, denyPeer } from '../peerApproval';
import { undo, redo, recordTransform } from '../history';
import { snapSettings } from '../snapping';
import {
	selectObject,
	topLevelObjectOf,
	toggleObjectVisibility,
	deleteSelection,
	renameObject,
	focusObject,
	ungroupObject
} from '../objectActions';
import { openVRKeyboard, pressVRKey } from '../vrKeyboard';
import { sceneCommand } from '../commandsHandler.svelte';
import { sendPing } from '../ping';
import { drawMode, toggleDrawMode } from '../drawMode';
import { cycleMicMode } from '../voiceChat';
import { safeStorage } from '../safeStorage';
import { resetWindowPoses } from '../vrWindowPoses';
import { S } from './state.js';
import { renderer, tempVector } from './core.js';
import { transformStateOf, broadcastMove, resetWorldRig } from './grip.js';
import { hapticPulse } from './haptics.js';
import { controllerIndexFor, applyVRFrameRate } from './input.js';
import {
	vrFaceCreateMode,
	vrMenuGroup,
	vrPanelExpanded,
	vrFocusObject,
	applySnapMode,
	handlePropsAction,
	armPrefabGhost
} from './panels.js';
import { controllerRay } from './pointer.js';
import { boxSelectEnd, beginStretch, commitStretch } from './tools.js';
import { handleAiAction } from './aiPanel.js';
// 36 X4: the collider session, PRIMED (colliderEdit reaches faceEdit/history — a static
// edge from here is the documented cycle family); every use below is null-safe
/** @type {any} */ let colliderEditRef = null;
if (typeof window !== 'undefined') import('../colliderEdit').then((m) => (colliderEditRef = m));

/** Raycast the quick-menu tiles @param {number} index @returns {string|null} tile action name */
export function raycastMenu(index) {
	const menu = get(vrMenuGroup);
	if (!menu || !get(vrMenuOpen)) return null;
	const hits = controllerRay(index).intersectObject(menu, true);
	const tile = hits.find((h) => h.object.name?.startsWith('vrmenu-'));
	return tile ? tile.object.name.slice('vrmenu-'.length) : null;
}
/** @returns {string | null} */
export function radialStickSelection() {
	return get(vrMenuOpen) ? S.radialStickHover : null;
}

/** Spawn a primitive ~2m in front of the VR camera and replicate its position */
/** @param {string} command */
function spawnPrimitive(command) {
	sceneCommand(command);
	const object = get(selectedObject);
	const camera = get(globalCamera);
	if (!object?.uuid || !camera) return;
	camera.getWorldDirection(tempVector);
	tempVector.y = 0;
	tempVector.normalize().multiplyScalar(2);
	const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
	// spawn point is a REAL-space spot 2m ahead; convert into the (possibly
	// grabbed/scaled) world before writing objectsGroup-local coords
	const spawn = new THREE.Vector3(
		cameraPosition.x + tempVector.x,
		object.position.y,
		cameraPosition.z + tempVector.z
	);
	const group = get(objectsGroup);
	if (group) {
		group.updateMatrixWorld(true);
		const local = group.worldToLocal(spawn.clone());
		object.position.set(local.x, object.position.y, local.z);
	} else {
		object.position.set(spawn.x, object.position.y, spawn.z);
	}
	pokeScene();
	broadcastMove(object, true);
}

/** Radial-menu sector actions (74): navigation + registry first, then the
 * built-in switch @param {string} name */
export function executeVRMenuAction(name) {
	// D4: a disabled registry entry (greyed sector) never activates, whether
	// its behavior lives in a registry action or the built-in switch below
	const menuEntry = findMenuEntry(name);
	if (menuEntry?.disabled?.()) return;
	// 36 (R11): press feedback — the sector flashes (VRMenu) and the hand ticks (silent in Edit, C4)
	if (menuEntry || name === 'back' || name === 'close' || name === 'nav:object') {
		vrMenuPressed.set({ id: name, at: performance.now() });
		hapticPulse(0.3, 25);
	}
	// 36: the in-headset Settings panel (rows from the one settings table)
	if (name.startsWith('vrset:')) {
		handleSettingsPanelAction(name.slice('vrset:'.length));
		return;
	}
	if (name.startsWith('vrbind:')) {
		cycleBinding(name.slice('vrbind:'.length));
		return;
	}
	// ring navigation + close (109: a STACK — Back pops one level)
	if (name === 'close') {
		vrMenuOpen.set(false);
		return;
	}
	if (name === 'back') {
		// a pending extrude/inset adjust reverts on Back before leaving (122)
		if (faceGesturePending()) {
			cancelFaceAdjust();
			return;
		}
		// leaving the Faces ring exits face-edit mode (118)
		if (get(activeRing) === 'faces') exitFaceEdit();
		popRing();
		return;
	}
	if (name === 'obj:ungroup') {
		// 216: dissolve the selected group (children move up, group deleted)
		const grp = /** @type {any} */ (get(selectedObject));
		if (grp?.uuid && grp.type === 'Group') ungroupObject(grp.uuid);
		return;
	}
	if (name === 'obj:editmesh') {
		// 137: TOGGLE mesh-edit mode + the controller side-menu (Vertices/Faces)
		if (get(vrEditMenuOpen)) {
			commitStretch(); // 161: bake a pending stretch on close
			exitEditMode();
			exitFaceEdit();
			sealEditHistorySession(); // 15-F: the VR done path seals synchronously
			vrEditMenuOpen.set(false);
			return;
		}
		const object = /** @type {any} */ (get(selectedObject));
		if (!object?.uuid) return;
		// default to Faces when the mesh qualifies, else Vertices, else refuse
		if (vrFaceEditable(object)) enterFaceEdit(object.uuid);
		else if (vrVertexEditable(object)) enterEditMode(object.uuid);
		else {
			// D7: say WHICH limit blocks + deep-link the setting
			editCapToast(
				'Mesh exceeds the edit limits (' +
					Math.round(triangleCount(object)) +
					' tris of ' +
					get(vrFaceCap) +
					', ' +
					vertexCount(object) +
					' verts of ' +
					get(vrVertexCap) +
					') — raise them in Settings ▸ VR'
			);
			return;
		}
		if (get(faceEditObject) || get(editingObject)) {
			vrObjectsPanelOpen.set(false);
			vrPaletteOpen.set(false);
			vrPropsPanelOpen.set(false);
			vrChatPanelOpen.set(false);
			vrMenuOpen.set(false);
			vrEditMenuOpen.set(true);
		}
		return;
	}
	if (name === 'edit:createface') {
		// 183: toggle create-face select mode; a second tap with 3-4 verts builds
		if (!get(editingObject)) return;
		if (!get(vrFaceCreateMode)) {
			vrFaceCreateMode.set(true);
			clearVertexSelection();
		} else {
			const n = get(vertexSelectionSize);
			if (n >= 3 && n <= 4) {
				// 191: wind the new face to face the viewer's head, not the mesh centre
				const viewer = renderer?.xr?.isPresenting
					? renderer.xr.getCamera().getWorldPosition(new THREE.Vector3())
					: null;
				createSelectedFace(viewer);
			} else clearVertexSelection();
			vrFaceCreateMode.set(false);
		}
		return;
	}
	if (name.startsWith('collider:')) {
		// 36 X4: the collider session's rows in the edit side-menu
		const cmd = name.slice('collider:'.length);
		const ce = colliderEditRef;
		if (!ce || !get(ce.colliderEditObject)) return;
		if (cmd === 'add:box' || cmd === 'add:sphere') ce.addColliderPiece(cmd.slice(4));
		else if (cmd === 'done') {
			if (ce.commitColliderEdit()) vrEditMenuOpen.set(false); // false = over the cap, stays open
		} else if (cmd === 'cancel') {
			ce.exitColliderEdit();
			vrEditMenuOpen.set(false);
		} else if (cmd === 'decompose') {
			// X3 from the headset: leave the hand-edit session, decompose the mesh instead
			const target = ce.colliderTargetUuid();
			ce.exitColliderEdit(false);
			vrEditMenuOpen.set(false);
			if (target) import('../colliderDecompose').then((m) => m.decomposeCollider(target));
		}
		return;
	}
	if (name === 'edit:close') {
		// 36 X4: closing the side-menu during a collider session CANCELS it (the proxy
		// must not outlive its menu); Done is the explicit save
		if (colliderEditRef && get(colliderEditRef.colliderEditObject)) {
			colliderEditRef.exitColliderEdit();
			vrEditMenuOpen.set(false);
			return;
		}
		// side-menu close = exit mesh edit (137); bake a pending stretch (161)
		commitStretch();
		vrFaceCreateMode.set(false);
		exitEditMode();
		exitFaceEdit();
		sealEditHistorySession(); // 15-F: the VR done path seals synchronously
		vrEditMenuOpen.set(false);
		return;
	}
	if (name.startsWith('edit:mode:')) {
		// switch Vertices / Faces / Stretch from the side-menu (137/161)
		const mode = name.slice('edit:mode:'.length);
		// 36 X4: inside a collider session the tabs drive the PROXY (the real object is
		// never mesh-edited by it), and Stretch has no meaning there
		const proxyUuid = colliderEditRef && get(colliderEditRef.colliderEditObject) ? colliderEditRef.colliderProxyUuid() : null;
		if (proxyUuid) {
			vrFaceCreateMode.set(false);
			if (mode === 'vertices') {
				exitFaceEdit();
				enterEditMode(proxyUuid);
			} else if (mode === 'faces') {
				exitEditMode();
				enterFaceEdit(proxyUuid);
			}
			return;
		}
		const object = /** @type {any} */ (get(selectedObject));
		if (!object?.uuid) return;
		vrFaceCreateMode.set(false); // leaving/re-entering a mode exits create-face
		commitStretch(); // leaving stretch bakes it (no-op otherwise)
		if (mode === 'vertices') {
			exitFaceEdit();
			if (vrVertexEditable(object)) enterEditMode(object.uuid);
			else
				editCapToast(
					'Mesh exceeds the vertex edit limit (' +
						vertexCount(object) +
						' of ' +
						get(vrVertexCap) +
						' verts) — raise it in Settings ▸ VR'
				);
		} else if (mode === 'stretch') {
			exitEditMode();
			exitFaceEdit();
			beginStretch(object.uuid);
		} else {
			exitEditMode();
			// enterFaceEdit guards the cap itself and shows the D7 toast
			enterFaceEdit(object.uuid);
		}
		return;
	}
	if (name.startsWith('stretch:axis:')) {
		// select which axis the joystick stretches (161)
		vrStretchAxis.set(parseInt(name.slice('stretch:axis:'.length)) || 0);
		return;
	}
	if (name.startsWith('nav:')) {
		pushRing(name.slice(4));
		return;
	}
	if (name.startsWith('tool:')) {
		// 214: pick the trigger tool from the Tools submenu, then close the ring
		const tool = name.slice('tool:'.length); // select | box | draw
		vrToolMode.set(tool);
		if ((tool === 'draw') !== get(drawMode)) toggleDrawMode();
		if (tool !== 'box') boxSelectEnd(true); // drop any in-progress marquee
		vrMenuOpen.set(false);
		return;
	}
	if (name === 'ping') {
		// U-1 ping, reworked in D6: activating the sector used to ping
		// IMMEDIATELY from the pointer hand — but on a trigger activation that
		// ray is parked on the radial itself, so the ping landed wherever the
		// menu floated. Now the sector ARMS a one-shot: the ring closes, the
		// beam/reticle tint to your ping color, and the next trigger pings the
		// exact pointed x,y,z (firePingIfArmed).
		vrPingArmed.set(true);
		vrMenuOpen.set(false);
		return;
	}
	if (name === 'edit:granularity') {
		toggleFaceGranularity(); // B3/15-G: cycles QUAD -> FACE -> TRIANGLE -> SHELL -> OBJECT
		return;
	}
	if (name === 'edit:multi') {
		toggleFaceMulti(); // 212: accumulate picks on/off
		return;
	}
	if (name.startsWith('face:')) {
		// arm a face op (side-menu, 137); the pointer trigger picks + commits (118/122)
		const op = /** @type {any} */ (name.slice('face:'.length));
		setFaceOp(op);
		// 212: in Multi mode the button APPLIES the op to the accumulated selection
		if (get(faceEditMulti) && get(faceEditSelectedTris).length) commitFaceOp(op, get(faceEditAmount));
		return;
	}
	if (name.startsWith('settings:')) {
		// 187: VR Settings panel controls
		const key = name.slice('settings:'.length);
		if (key === 'close') vrSettingsPanelOpen.set(false);
		else if (key === 'teleport') {
			vrTeleportEnabled.update((v) => !v);
			try { safeStorage.setItem('vrTeleportEnabled', String(get(vrTeleportEnabled))); } catch {}
		} else if (key === 'mirror') {
			vrMirrorSnapTurn.update((v) => !v);
			try { safeStorage.setItem('vrMirrorSnapTurn', String(get(vrMirrorSnapTurn))); } catch {}
		} else if (key === 'vertexhold') {
			vrVertexHold.update((v) => !v);
			try { safeStorage.setItem('vrVertexHold', String(get(vrVertexHold))); } catch {}
		} else if (key === 'angle') {
			// cycle Off -> 15 -> 30 -> 45 -> Off
			const steps = [0, 15, 30, 45];
			const next = steps[(steps.indexOf(get(vrSnapAngle)) + 1) % steps.length];
			vrSnapAngle.set(next);
			try { safeStorage.setItem('vrSnapAngle', String(next)); } catch {}
		} else if (key === 'hz') {
			// B2.1: cycle Auto(max) -> 90 -> 120 and apply live if presenting
			const steps = ['auto', '90', '120'];
			const next = steps[(steps.indexOf(get(vrTargetHz)) + 1) % steps.length];
			vrTargetHz.set(next);
			applyVRFrameRate();
		} else if (key === 'handstyle') {
			// B2.3/R-3: how hand-tracked peers render locally (3-way cycle)
			const styles = ['model', 'hands', 'spheres'];
			peerHandStyle.set(styles[(styles.indexOf(get(peerHandStyle)) + 1) % styles.length]);
		} else if (key === 'passthrough') {
			// WebXR can't hot-swap session modes — applies on the next VR entry
			const next = !get(vrPassthrough);
			vrPassthrough.set(next);
			try { safeStorage.setItem('vrPassthrough', String(next)); } catch {}
			showToast('Passthrough ' + (next ? 'on' : 'off') + ' — takes effect on the next VR entry');
		} else if (key === 'sleeve') {
			// K1: experimental forearm sleeve palette (default off)
			vrSleeveEnabled.update((v) => !v);
			try { safeStorage.setItem('vrSleeveEnabled', String(get(vrSleeveEnabled))); } catch {}
		} else if (key === 'perf') {
			// 33 Q1: the app-wide "Show FPS + draw calls" (fpsMeter persists it)
			perfStatsShown.update((v) => !v);
		} else if (key === 'resetpanels') {
			resetWindowPoses();
			showToast('VR panel positions reset');
		}
		return;
	}
	if (name === 'snap:close') {
		vrSnapMenuOpen.set(false);
		return;
	}
	if (name.startsWith('snap:mode:')) {
		// Off / Grid / Surface / Rotation — sets the snap mode + shared stores (156)
		applySnapMode(name.slice('snap:mode:'.length));
		return;
	}
	if (name.startsWith('snap:grid:')) {
		// grid sub-value: pick the translate step + ensure grid mode (156)
		const step = parseFloat(name.slice('snap:grid:'.length));
		if (step > 0) snapSettings.update((s) => ({ ...s, translate: step }));
		applySnapMode('grid');
		return;
	}
	if (name === 'snap:rot:reset') {
		// snap-to-identity: zero the selected object's rotation, replicated + undoable (156)
		const object = /** @type {any} */ (get(selectedObject));
		if (!object?.uuid) return;
		if (get(lockedObjects).find((lock) => lock[1] === object.uuid)) {
			showToast('That object is locked by another peer');
			return;
		}
		const before = transformStateOf(object);
		object.rotation.set(0, 0, 0);
		recordTransform({ uuid: object.uuid, before, after: transformStateOf(object) });
		broadcastMove(object, true);
		pokeScene();
		hapticPulse(0.3, 40);
		return;
	}
	if (name.startsWith('snap:rot:')) {
		// rotation sub-value: pick the rotate-snap angle + ensure rotation mode (156)
		const deg = parseInt(name.slice('snap:rot:'.length));
		if (deg > 0) snapSettings.update((s) => ({ ...s, rotateDeg: deg }));
		applySnapMode('rotation');
		return;
	}
	if (name === 'chat') {
		// the VR chat panel (117) replaces the ring on screen
		vrChatPanelOpen.update((v) => !v);
		vrObjectsPanelOpen.set(false);
		vrPaletteOpen.set(false);
		vrPropsPanelOpen.set(false);
		vrMenuOpen.set(false);
		return;
	}
	if (name.startsWith('approve:')) {
		// 211: Approve / Deny the FIRST pending request (the one the panel shows).
		// Routes through the same accept/reject path the desktop Toasts card uses.
		const action = name.slice('approve:'.length);
		const first = /** @type {any} */ (get(pendingApprovals))[0];
		if (first) {
			if (action === 'yes') approvePeer(first.peerId);
			else if (action === 'no') denyPeer(first.peerId);
		}
		return;
	}
	if (name.startsWith('ai:')) {
		// 36-vr-ai: the AI panel's controls (close, input row -> keyboard, stop)
		handleAiAction(name.slice('ai:'.length));
		return;
	}
	if (name.startsWith('chat:')) {
		const action = name.slice('chat:'.length);
		if (action === 'close') vrChatPanelOpen.set(false);
		else if (action === 'input')
			openVRKeyboard({
				title: 'Chat message',
				onCommit: (text) => {
					const trimmed = text.trim();
					if (trimmed) /** @type {any} */ (get(peers))?.sendMessage(trimmed);
				}
			});
		return;
	}
	if (name === 'obj:color') {
		// the continuous palette (110) replaces the ring on screen
		vrPaletteOpen.set(true);
		vrObjectsPanelOpen.set(false);
		vrChatPanelOpen.set(false);
		vrPropsPanelOpen.set(false);
		vrMenuOpen.set(false);
		return;
	}
	if (name === 'obj:props') {
		// the properties panel (112) replaces the ring on screen
		vrPropsPanelOpen.set(true);
		vrObjectsPanelOpen.set(false);
		vrChatPanelOpen.set(false);
		vrPaletteOpen.set(false);
		vrMenuOpen.set(false);
		return;
	}
	if (name.startsWith('props:')) {
		handlePropsAction(name.slice('props:'.length));
		return;
	}
	if (name === 'prefabs') {
		// the thumbnail window (115) lazy-follows the view
		vrPrefabsPanelOpen.update((v) => !v);
		vrObjectsPanelOpen.set(false);
		vrChatPanelOpen.set(false);
		vrPaletteOpen.set(false);
		vrPropsPanelOpen.set(false);
		vrMenuOpen.set(false);
		return;
	}
	if (name.startsWith('prefabs:')) {
		const action = name.slice('prefabs:'.length);
		if (action === 'close') vrPrefabsPanelOpen.set(false);
		else if (action === 'pin') vrPrefabsPinned.update((v) => !v);
		else if (action.startsWith('select:')) armPrefabGhost(action.slice('select:'.length));
		return;
	}
	if (name === 'wireframe') {
		vrWireframeSelection.update((v) => {
			const next = !v;
			try {
				safeStorage.setItem('vrWireframe', String(next));
			} catch {}
			return next;
		});
		return;
	}
	if (name === 'palette:close') {
		vrPaletteOpen.set(false);
		return;
	}
	if (name.startsWith('kbd:')) {
		pressVRKey(name.slice('kbd:'.length));
		return;
	}
	// registry entries carry their own action (env presets, mic modes, object
	// ops, color swatches, module-registered entries)
	const entry = findMenuEntry(name);
	if (entry?.action) {
		entry.action();
		if (entry.closes) vrMenuOpen.set(false);
		return;
	}
	if (name.startsWith('panel:')) {
		// objects panel actions (101) + row actions v2 (116/120)
		if (name === 'panel:close') vrObjectsPanelOpen.set(false);
		else if (name.startsWith('panel:expand:')) {
			// 215: toggle a group row open/closed (children inline + indent)
			const uuid = name.slice('panel:expand:'.length);
			vrPanelExpanded.update((set) => {
				const next = new Set(set);
				if (next.has(uuid)) next.delete(uuid);
				else next.add(uuid);
				return next;
			});
			hapticPulse(0.15, 18);
		} else if (name.startsWith('panel:select:')) {
			// 120: selecting no longer closes the panel; a second select on the
			// SAME row within the double-click window focuses it instead
			const uuid = name.slice('panel:select:'.length);
			const now = Date.now();
			if (uuid === S.lastPanelSelect.uuid && now - S.lastPanelSelect.at < 400) {
				S.lastPanelSelect = { uuid: '', at: 0 };
				executeVRMenuAction('panel:focus:' + uuid);
			} else {
				S.lastPanelSelect = { uuid, at: now };
				selectObject(uuid);
				hapticPulse(0.2, 30);
			}
		} else if (name.startsWith('panel:focus:')) {
			const uuid = name.slice('panel:focus:'.length);
			selectObject(uuid);
			if (renderer?.xr?.isPresenting) vrFocusObject(uuid);
			else focusObject(uuid);
		} else if (name.startsWith('panel:props:')) {
			// open the 112 properties panel for this row's object
			selectObject(name.slice('panel:props:'.length));
			vrPropsPanelOpen.set(true);
			vrObjectsPanelOpen.set(false);
			vrPaletteOpen.set(false);
			vrChatPanelOpen.set(false);
		} else if (name.startsWith('panel:visible:')) {
			toggleObjectVisibility(name.slice('panel:visible:'.length));
		} else if (name.startsWith('panel:delete:')) {
			const uuid = name.slice('panel:delete:'.length);
			if (get(lockedObjects).find((lock) => lock[1] === uuid)) {
				showToast('That object is locked by another peer');
			} else {
				selectObject(uuid);
				deleteSelection();
			}
		} else if (name.startsWith('panel:rename:')) {
			const uuid = name.slice('panel:rename:'.length);
			if (get(lockedObjects).find((lock) => lock[1] === uuid)) {
				showToast('That object is locked by another peer');
				return;
			}
			const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
			openVRKeyboard({
				title: 'Rename object',
				initial: object?.name ?? '',
				onCommit: (text) => {
					if (text.trim()) renameObject(uuid, text.trim());
				}
			});
		}
		return;
	}
	if (name === 'move' || name === 'rotate') vrTransformMode.set(name);
	else if (name === 'objects') {
		// the native VR list panel (101) replaces the menu on screen
		vrObjectsPanelOpen.update((v) => !v);
		vrPaletteOpen.set(false);
		vrPropsPanelOpen.set(false);
		vrMenuOpen.set(false);
	} else if (name === 'stats') {
		vrStatsOpen.update((v) => {
			const next = !v;
			try {
				safeStorage.setItem('vrStats', String(next));
			} catch {}
			return next;
		});
	} else if (name === 'grabmode') {
		// cycle the grip style (100): rigid (default) -> legacy move -> legacy rotate
		const order = ['rigid', 'move', 'rotate'];
		const next = order[(order.indexOf(get(vrGrabStyle)) + 1) % order.length];
		vrGrabStyle.set(next);
		try {
			safeStorage.setItem('vrGrabStyle', next);
		} catch {}
		showToast(
			next === 'rigid'
				? 'Grab: rigid (controller is the handle — stick reels + scales)'
				: 'Grab: legacy ' + next
		);
	} else if (name === 'snap') {
		// 156: toggle the controller Snap side-menu (Off/Grid/Surface/Rotation)
		if (get(vrSnapMenuOpen)) {
			vrSnapMenuOpen.set(false);
		} else {
			vrObjectsPanelOpen.set(false);
			vrPaletteOpen.set(false);
			vrPropsPanelOpen.set(false);
			vrChatPanelOpen.set(false);
			vrEditMenuOpen.set(false);
			vrMenuOpen.set(false);
			vrSnapMenuOpen.set(true);
		}
	} else if (name === 'grid') {
		showGrid.update((v) => !v);
		if (safeStorage.getItem('showGrid')) safeStorage.removeItem('showGrid');
		else safeStorage.setItem('showGrid', 'false');
	} else if (name === 'undo') undo();
	else if (name === 'redo') redo();
	else if (name === 'box') spawnPrimitive('/create Box 1 1 1');
	else if (name === 'wedge') spawnPrimitive('/create Wedge 1 1 1');
	else if (name === 'stairs') spawnPrimitive('/create Stairs 1 1 1 4');
	else if (name === 'sphere') spawnPrimitive('/create Sphere 0.7');
	else if (name === 'cylinder') spawnPrimitive('/create Cylinder 0.5 0.5 1');
	else if (name === 'torus') spawnPrimitive('/create Torus 0.6 0.25');
	else if (name === 'hand') {
		vrMenuHand.update((hand) => {
			const next = hand === 'right' ? 'left' : 'right';
			safeStorage.setItem('vrMenuHand', next);
			return next;
		});
	} else if (name === 'mic') {
		cycleMicMode();
	} else if (name === 'world') {
		resetWorldRig(); // back to 1:1 mid-session
	} else if (name === 'settings') {
		// 187: Settings ▸ All settings opens the VR settings panel. 36 (R9): it REPLACES the ring on
		// screen like every other panel — the ring left open used to own the pointer, so the panel's
		// rows could not be hovered until B closed the ring
		vrObjectsPanelOpen.set(false);
		vrPaletteOpen.set(false);
		vrPropsPanelOpen.set(false);
		vrChatPanelOpen.set(false);
		vrMenuOpen.set(false);
		vrSettingsPanelOpen.set(true);
	} else if (name === 'exitvr') {
		vrMenuOpen.set(false);
		isVRMode.set(false);
		renderer?.xr?.getSession?.()?.end();
	} else if (name === 'close') vrMenuOpen.set(false);
}

/** D6: armed one-shot ping (radial Ping). True while the next trigger press
 * should ping instead of select. @type {import('svelte/store').Writable<boolean>} */
export const vrPingArmed = writable(false);
// re-opening the radial cancels a pending ping (the tinted reticle reads as
// armed; opening the menu is the natural back-out)
vrMenuOpen.subscribe((open) => {
	if (open) vrPingArmed.set(false);
});

/** D6: fire the armed ping from the FIRING controller's ray — the exact
 * pointed spot. Returns true when it consumed the trigger; a sky-miss keeps
 * the arm (the tint shows it is still live). Exported for Scene's trigger
 * path + headless tests. @param {number} index */
export function firePingIfArmed(index) {
	if (!get(vrPingArmed)) return false;
	if (!pingFromController(index)) return true; // consumed, still armed (sky)
	vrPingArmed.set(false);
	return true;
}

/** D6: the pointer hand's controller slot (the hand OPPOSITE the menu hand —
 * its beam/reticle drives hover highlights). NOT used for pings anymore:
 * pings fire from the hand that ACTED (stick click / armed trigger), D10.
 * Exported for tests + panel work. */
export function pointerHandIndex() {
	return controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
}

/** Right-stick click / radial Ping: ping where the controller ray lands. When
 * it lands ON an object, carry that object's uuid so peers highlight it too
 * (U-1). (87.6) Returns whether a ping landed. @param {number} index */
export function pingFromController(index) {
	if (index < 0) return false;
	const ray = controllerRay(index);
	const group = get(objectsGroup);
	const hits = group ? ray.intersectObjects(group.children, true) : [];
	if (hits[0]) {
		const top = topLevelObjectOf(hits[0].object);
		sendPing(hits[0].point, top?.uuid);
		hapticPulse(0.4, 60);
		return true;
	}
	const point = pingPointFromRay(ray, group);
	if (!point) return false;
	sendPing(point);
	hapticPulse(0.4, 60);
	return true;
}

/**
 * Where a controller ray pings: the first object hit, else where it meets the
 * ground plane, else nowhere (aiming at the sky). Exported for headless tests.
 * @param {THREE.Raycaster} ray @param {any} group @returns {THREE.Vector3 | null}
 */
export function pingPointFromRay(ray, group) {
	const hits = group ? ray.intersectObjects(group.children, true) : [];
	if (hits[0]) return hits[0].point;
	const planePoint = new THREE.Vector3();
	return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), planePoint)
		? planePoint
		: null;
}

/** 36: the Settings panel's own actions — pages, the − / + of a range, back to the ring, close
 * @param {string} key */
function handleSettingsPanelAction(key) {
	if (key === 'close') {
		vrSettingsPanelOpen.set(false);
		return;
	}
	if (key === 'back') {
		// Back to the radial's Settings ring — the place the panel is reached from
		vrSettingsPanelOpen.set(false);
		vrMenuOpen.set(true);
		pushRing('settings');
		return;
	}
	if (key.startsWith('page:')) {
		vrSettingsPage.set(key.slice('page:'.length));
		vrSettingsCursor.set(0);
		return;
	}
	const minus = key.endsWith(':-');
	const plus = key.endsWith(':+');
	const id = minus || plus ? key.slice(0, -2) : key;
	if (id === 'remap') {
		openVRSettingsPage('buttons');
		return;
	}
	activateVRSetting(id, minus ? -1 : 1);
}

// 36: the Settings rings (built from the settings table) — registered here, where the settings' own
// modules (faceEdit, meshEdit, voiceChat…) are already loaded
registerSettingsRings();

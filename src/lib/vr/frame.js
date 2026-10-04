// VR controls — the per-frame driver: updateVRControls, navigation suppression, the mic HUD.
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import * as THREE from 'three';
import { get } from 'svelte/store';
import {
	objectsGroup,
	lockedObjects,
	globalCamera,
	vrMenuHand,
	vrMenuOpen,
	vrSettingsPanelOpen,
	selectedObject,
	vrMenuHold,
	vrObjectsPanelOpen,
	vrChatPanelOpen,
	vrPaletteOpen,
	vrPropsPanelOpen,
	vrPrefabsPanelOpen,
	vrEditMenuOpen,
	vrSnapMenuOpen,
	vrGrabbedHand,
	vrApprovePanelOpen
} from '../../stores/sceneStore';
import { setJumpRequested } from '../charController';
import { activeRing, ringEntries, sectorFromStick, hubEntry } from '../vrRadialMenu';
import { gameFeelActive } from '../gameFeel';
import { toggleShellMenu, shellMenuAvailable } from '../gameShell';
import { noteArtificialMotion } from '../comfortVignette';
import { prefabs } from '../prefabs';
import { editingObject, vrRaycastHandle, vrDragHandleTo, setHoveredHandle } from '../meshEdit';
import {
	faceEditObject,
	highlightFaceByTriangle,
	applyFaceGrab,
	adjustFaceGesture,
	faceGesturePending
} from '../faceEdit';
import { snapEnabled, snapSettings } from '../snapping';
import { selectObject } from '../objectActions';
import { vrKeyboardTarget } from '../vrKeyboard';
import { setVRAxes, setVRButtons, isClaimed } from '../inputRuntime';
import { drawMode, addStrokePoint, endStroke } from '../drawMode';
import { setPttHeld, vrMicMode, micActive, pttActive } from '../voiceChat';
import { HOLD_MS } from '../vrWindowPoses';
import { S } from './state.js';
import { renderer, previousButtons } from './core.js';
import {
	grabs,
	worldReelStep,
	_reelDir,
	_reelQuat,
	gripHeld,
	updateWorldGrab,
	vertexGrab,
	faceGrabHand,
	faceAdjustHand,
	onSqueezeStart,
	onSqueezeEnd,
	updateGrab,
	updateScaleGrab
} from './grip.js';
import { hapticPulse } from './haptics.js';
import { navSuppressors, vrFrameHooks } from './hooks.js';
import { controllerIndexFor, axesForSlot } from './input.js';
import { actionPressed, handOf, CONTROL_INDEX } from './bindings.js';
import { settingsPanelRows, vrSettingsPage, vrSettingsCursor, neighbourTab, activateVRSetting } from './settingsSchema.js';
import {
	hideArc,
	updateTeleport,
	updateBlink,
	lastSmoothTurn,
	updateSnapTurn,
	vrJumpHeight,
	updateHeightLift
} from './locomotion.js';
import { modeHand, toggleVRMode, payPendingSpawn, updateModeLabel } from './modes.js';
import {
	vrHovered,
	vrPanelCursor,
	vrPanelExpanded,
	flattenPanelRows,
	vrPanelCursorAction,
	raycastPanel,
	vrPropsCursor,
	PROPS_ROWS,
	raycastProps,
	raycastEdit,
	raycastSnap,
	raycastSettings,
	propsRowAction,
	vrPrefabsCursor,
	vrPrefabGhost,
	raycastChat,
	raycastApprove,
	raycastKeyboard,
	raycastPrefabs,
	updatePrefabGhost,
	updatePalettePaint,
	beginWindowAdjust,
	updateWindowAdjust
} from './panels.js';
import { updateRaysAndHover, controllerRay } from './pointer.js';
import { raycastMenu, executeVRMenuAction, pingFromController } from './radial.js';
import {
	boxSelect,
	updateBoxSelect,
	stretch,
	stretchSliderDrag,
	updateStretchSliderDrag
} from './tools.js';

/** @type {any} */ let micHud = null;

/** Small camera-locked dot, top right: green = transmitting, grey = muted */
function updateMicHud(presenting) {
	const camera = get(globalCamera);
	if (!camera) return;
	if (!micHud) {
		micHud = new THREE.Mesh(
			new THREE.CircleGeometry(0.012, 16),
			new THREE.MeshBasicMaterial({ color: 0x555b66, transparent: true, opacity: 0.9, depthTest: false })
		);
		micHud.renderOrder = 998;
		micHud.position.set(0.28, 0.18, -0.8);
	}
	const show = presenting && get(vrMicMode) !== 'off';
	micHud.visible = show;
	if (show) {
		if (micHud.parent !== camera) camera.add(micHud);
		const transmitting = get(micActive) || get(pttActive);
		micHud.material.color.setHex(transmitting ? 0x22cc55 : 0x555b66);
	}
}

/** 31-towers P1: is push-to-talk open because A is held? (A jumps instead while the game's
 * controller can jump — a switch mid-hold must not strand the mic open) */
let pttByA = false;

/** D9 (roadmap 13): true while a manipulation gesture owns the sticks or the
 * reference space — world pan/grab write reference-space offsets themselves,
 * two-hand object scale uses both hands, and the mesh-edit gestures read the
 * sticks for reel/scale — so stick NAVIGATION (left-stick move, right-stick
 * teleport/snap-turn) must stand down or it double-drives the rig.
 * `grips: true` additionally suppresses while EITHER grip is held (the
 * teleport/snap gate — a held grip always means manipulation). The plain call
 * (no opts) gates left-stick locomotion in VRControls.svelte and deliberately
 * does NOT include bare grips: left-grip + left-stick pan/elevate is itself a
 * locomotion mode. Exported for VRControls.svelte + headless tests.
 * @param {{grips?: boolean}=} opts */
export function vrNavigationSuppressed(opts = {}) {
	if (S.worldPan || S.worldGrab || S.scaleGrab) return true;
	// 33 (G2): a module that reads the sticks itself claimed them (`api.claimInput('sticks')`):
	// move, turn and teleport all stand down — Untangle's held globe reels on Y, scales on X
	if (isClaimed('sticks')) return true;
	if (vertexGrab || S.vertexTriggerGrab) return true;
	if (faceGrabHand || faceGesturePending()) return true;
	if (stretchSliderDrag || boxSelect) return true;
	// K1: module gestures (a held sleeve preview) own the sticks too
	if (
		navSuppressors.some((fn) => {
			try {
				return !!fn();
			} catch {
				return false;
			}
		})
	)
		return true;
	if (opts.grips && (gripHeld[0] || gripHeld[1])) return true;
	return false;
}

/** 36: the Settings panel's sideways flick fires once per flick (re-armed at centre) */
let settingsFlickArmed = true;

/** 36: a sector id that moves through the rings (a ▸ sector or the Back hub) rather than acting @param {string} id */
function navigatesRing(id) {
	return id.startsWith('nav:') || id === 'back';
}

/** 36: is something up that owns the stick press (the radial, the keyboard, a list panel)? */
function panelModal() {
	return !!(
		get(vrKeyboardTarget) ||
		get(vrMenuOpen) ||
		get(vrObjectsPanelOpen) ||
		get(vrPropsPanelOpen) ||
		get(vrPrefabsPanelOpen) ||
		get(vrChatPanelOpen) ||
		get(vrSettingsPanelOpen)
	);
}

/** Per-frame update while presenting (called from Scene's useTask) */
export function updateVRControls() {
	const session = renderer?.xr.getSession();
	updateRaysAndHover(!!session);
	updateBlink();
	updateMicHud(!!session);
	// K1: module frame hooks (the sleeve re-anchors/updates its held preview)
	for (const hook of vrFrameHooks) {
		try {
			hook();
		} catch (error) {
			console.log('VR frame hook failed', error);
		}
	}
	updateModeLabel(); // 30b P4: the wrist label follows the mode (hidden outside a session)
	if (!session) {
		hideArc();
		S.teleportEngaged = false;
		return;
	}
	payPendingSpawn(); // 30b P4
	updateHeightLift(); // 36: Settings ▸ VR ▸ Body (seated / height), applied once per change
	// open menu/panel are modal for the sticks: sector nav / scrolling own them;
	// a RIGHT-hand grab owns the right stick too (reel/scale beats teleport, 100);
	// D9: manipulation gestures + ANY held grip stand navigation down entirely
	if (
		!get(vrMenuOpen) &&
		!get(vrObjectsPanelOpen) &&
		!get(vrPropsPanelOpen) &&
		!get(vrPrefabsPanelOpen) &&
		!get(vrChatPanelOpen) &&
		!get(vrSettingsPanelOpen) && // 36: its row cursor owns the sticks
		!get(vrKeyboardTarget) &&
		// 36 (plan 55): a grab owns ITS hand's stick — the turn/teleport stick stands down when that hand holds
		get(vrGrabbedHand) !== handOf('turn') &&
		get(vrGrabbedHand) !== handOf('teleport') &&
		get(vrGrabbedHand) !== 'both' &&
		!vrNavigationSuppressed({ grips: true })
	) {
		updateTeleport(session);
		updateSnapTurn(session);
	} else {
		// D9: a gesture/grip released mid-stick-deflection must not fire a
		// queued teleport or an instant snap — disarm while suppressed; the
		// stick has to return to center before navigating again
		S.teleportEngaged = false;
		S.snapArmed = false;
		hideArc();
	}

	[...session.inputSources].forEach((source, srcIndex) => {
		if (srcIndex > 1 || !source.gamepad) return;
		const buttons = source.gamepad.buttons;
		// 210: everything downstream (pose, ray, grabs, per-slot state) keys by the
		// three.js controller SLOT resolved from handedness, NOT the inputSources
		// order - the two DIVERGE after a hands<->controllers swap (seen in-headset:
		// slot0 in:right stamp:left), which drove grips onto the wrong controller.
		// Buttons/axes still read from `source` (the acting hand); fall back to the
		// raw order only if the slot isn't stamped yet.
		let index = controllerIndexFor(source.handedness);
		if (index < 0) index = srcIndex;
		const prev = previousButtons[index];

		// the MENU button (B on the menu hand by default; 36: any binding, plan 55): toggle the radial menu,
		// or (hold mode, 74) hold to show + release over a sector to activate it
		const menuPressed = actionPressed('menu', source);
		if (source.handedness === handOf('menu')) {
			if (get(vrMenuHold)) {
				if (menuPressed && !prev.menu) {
					vrObjectsPanelOpen.set(false); // ring replaces the panel (101)
					vrPaletteOpen.set(false);
					vrPropsPanelOpen.set(false);
					vrMenuOpen.set(true);
				}
				if (!menuPressed && prev.menu) {
					// 36 (R8): releasing over a ▸ sector (or the Back hub) NAVIGATES and keeps the ring up;
					// it used to close the menu and leave the sub-ring pushed for the next open
					const hovered = get(vrHovered);
					if (hovered && navigatesRing(hovered)) executeVRMenuAction(hovered);
					else {
						vrMenuOpen.set(false);
						if (hovered) executeVRMenuAction(hovered);
					}
				}
			} else if (menuPressed && !prev.menu) {
				vrObjectsPanelOpen.set(false);
				vrPaletteOpen.set(false);
				vrPropsPanelOpen.set(false);
				vrMenuOpen.update((v) => !v);
			}
		}
		prev.menu = menuPressed;

		// 30b P4: the MODE button — Y on the LEFT hand (B on the right when the radial menu
		// lives on the left, so the two never share a button): Edit <-> Interact, in VR
		if (source.handedness === modeHand()) {
			const modePressed = actionPressed('mode', source);
			if (modePressed && !prev.mode) toggleVRMode();
			prev.mode = modePressed;
		}


		// 31 K3: LEFT X = the game's pause menu (A on the right is push-to-talk, B/Y are
		// the radial menu and the mode button, so X is the one face button left free)
		if (source.handedness === handOf('pause')) {
			const xPressed = actionPressed('pause', source);
			if (xPressed && !prev.x && gameFeelActive() && shellMenuAvailable()) toggleShellMenu();
			prev.x = xPressed;
		}

		// right A held = push-to-talk — or, 31-towers P1, JUMP while the game's Character
		// Controller can jump (Interact walking). The edge is the charController's own, so a held
		// A is one jump and landing with it down is none (no bunny-hopping).
		const aPressed = actionPressed('ptt', source);
		if (source.handedness === handOf('ptt') && aPressed !== !!prev.a) {
			if (vrJumpHeight() > 0) {
				setJumpRequested(aPressed);
				if (pttByA) setPttHeld(false);
				pttByA = false;
			} else {
				setPttHeld(aPressed);
				pttByA = aPressed;
			}
		}
		if (source.handedness === handOf('ptt')) prev.a = aPressed;

		// K-C: publish this hand's stick + trigger/squeeze into the SDK input
		// layer (inputRuntime is store-only; this is the safe import direction)
		if (source.handedness === 'left' || source.handedness === 'right') {
			setVRAxes(source.handedness, source.gamepad.axes?.[2] ?? 0, source.gamepad.axes?.[3] ?? 0);
			// 31 K3: the comfort vignette hears the locomotion stick + this frame's smooth turn
			if (source.handedness === handOf('move')) noteArtificialMotion(Math.hypot(source.gamepad.axes?.[2] ?? 0, source.gamepad.axes?.[3] ?? 0), lastSmoothTurn);
			setVRButtons(source.handedness, !!buttons[0]?.pressed, !!buttons[1]?.pressed);
		}

		// squeeze grabs (the 'grab' row of the bindings table: either grip, the platform convention)
		const squeezePressed = !!buttons[CONTROL_INDEX.grip]?.pressed;
		gripHeld[index] = squeezePressed; // 186: track for the two-grip stretch
		if (squeezePressed && !prev.squeeze) onSqueezeStart(index);
		if (!squeezePressed && prev.squeeze) onSqueezeEnd(index);
		prev.squeeze = squeezePressed;

		// thumbstick CLICK (buttons[3] — the press, not the axes): with the menu
		// open it activates the hovered sector (74); otherwise the RIGHT stick
		// pings the pointed spot with the v2 visual/chime + a haptic tick (87.6)
		// 36 (plan 55): a stick PRESS still activates whatever panel is up, from either hand; with
		// nothing up, the PING binding fires (the right stick press by default)
		const stickPressed = !!buttons[CONTROL_INDEX.stickClick]?.pressed;
		const pingPressed = actionPressed('ping', source);
		if (pingPressed && !prev.ping && !panelModal()) pingFromController(index);
		prev.ping = pingPressed;
		if (stickPressed && !prev.stick) {
			if (get(vrKeyboardTarget)) {
				// keyboard is modal on top (116): stick-press taps the hovered key
				const hovered = get(vrHovered);
				if (hovered) executeVRMenuAction(hovered);
			} else if (get(vrMenuOpen)) {
				// activate the hovered sector; a centered stick presses the HUB
				// (the 'middle option', 109)
				const hovered = get(vrHovered);
				if (hovered) executeVRMenuAction(hovered);
				else
					executeVRMenuAction(
						hubEntry(get(activeRing), !!(/** @type {any} */ (get(selectedObject))?.uuid)).id
					);
			} else if (get(vrObjectsPanelOpen)) {
				// ray hover wins; otherwise the row cursor's action (109.4)
				const action = get(vrHovered) ?? get(vrPanelCursorAction);
				if (action) executeVRMenuAction(action);
			} else if (get(vrPropsPanelOpen)) {
				// ray hover wins; otherwise activate the cursored row (112)
				const action = get(vrHovered) ?? propsRowAction(PROPS_ROWS[get(vrPropsCursor)]);
				if (action) executeVRMenuAction(action);
			} else if (get(vrPrefabsPanelOpen)) {
				// ray hover wins; otherwise arm the cursored cell (115)
				const cell = get(prefabs)[get(vrPrefabsCursor)];
				const action = get(vrHovered) ?? (cell ? 'prefabs:select:' + cell.id : null);
				if (action) executeVRMenuAction(action);
			} else if (get(vrChatPanelOpen)) {
				// ray hover wins; otherwise the stick-press opens the input (117)
				const action = get(vrHovered) ?? 'chat:input';
				executeVRMenuAction(action);
			} else if (get(vrSettingsPanelOpen)) {
				// 36 (S23): ray hover wins; otherwise press the cursored row (the tab strip pages on)
				const rows = settingsPanelRows(get(vrSettingsPage));
				const row = rows[Math.min(Math.max(0, get(vrSettingsCursor)), rows.length - 1)];
				const action = get(vrHovered) ?? (row?.kind === 'tabs' ? 'vrset:page:' + neighbourTab(get(vrSettingsPage), 1) : row?.action || null);
				if (action) executeVRMenuAction(action);
			}
			// D10: the ping fires from the hand that pressed — its ray is what you aimed (D6 briefly
			// routed it through the "pointer hand", the on-device report). 36: that hand is the
			// ping binding's, handled above.
		}
		prev.stick = stickPressed;

		// draw mode: holding the trigger draws at the controller tip
		const triggerPressed = !!buttons[CONTROL_INDEX.trigger]?.pressed;
		if (get(drawMode)) {
			if (triggerPressed)
				addStrokePoint(renderer.xr.getController(index).getWorldPosition(new THREE.Vector3()));
			if (!triggerPressed && prev.trigger) endStroke();
		}
		// continuous palette painting (110): hold the trigger over the disc
		if (get(vrPaletteOpen) && source.handedness !== get(vrMenuHand))
			updatePalettePaint(index, triggerPressed);
		prev.trigger = triggerPressed;
	});

	if (S.scaleGrab) updateScaleGrab();
	else for (const held of grabs) if (held) updateGrab(held);

	// window grab (111): the hold timer arms, then the grip drives the window
	if (S.windowGrabPending && Date.now() - S.windowGrabPending.startedAt >= HOLD_MS)
		beginWindowAdjust();
	if (S.windowGrab) updateWindowAdjust();

	// 214: box-select marquee grows to the controller while the trigger is held
	if (boxSelect) updateBoxSelect();

	// prefab placement ghost (115) rides the pointer-hand ray
	if (get(vrPrefabGhost))
		updatePrefabGhost(controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right'));

	// 193: stretch mode — drag a W/H/D slider handle (trigger held on the pointer),
	// horizontal controller motion scales that axis live (an infinite slider)
	if (stretch && session && stretchSliderDrag) updateStretchSliderDrag();

	// a trigger drag left dangling by an exit (160) — drop it cleanly
	if (S.vertexTriggerGrab && !get(editingObject)) S.vertexTriggerGrab = null;
	// vertex handle drag (113 grip / 160 trigger): the handle rides the controller
	const vgrab = vertexGrab || S.vertexTriggerGrab;
	if (vgrab) {
		const controllerPos = renderer.xr
			.getController(vgrab.index)
			.getWorldPosition(new THREE.Vector3());
		const step = get(snapEnabled) ? get(snapSettings).translate : 0;
		vrDragHandleTo(controllerPos.add(vgrab.offset), step);
	} else if (get(editingObject)) {
		// vertex hover (119): the pointer ray tints the handle under it
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hit = pointerIndex >= 0 ? vrRaycastHandle(controllerRay(pointerIndex)) : -1;
		if (setHoveredHandle(hit) && hit >= 0) hapticPulse(0.1, 12);
	}

	// face edit (118/122)
	if (get(faceEditObject) && !get(vrMenuOpen)) {
		if (faceGrabHand) {
			// rigid face grab (122): move/rotate 1:1 from the grip hand; that
			// hand's stick reels along the normal (fwd/back) + scales (left/right)
			const controller = renderer.xr.getController(faceGrabHand.index);
			const pos1 = controller.getWorldPosition(new THREE.Vector3());
			const quat1 = controller.getWorldQuaternion(new THREE.Quaternion());
			const edited = get(objectsGroup)?.getObjectByProperty('uuid', get(faceEditObject));
			// world delta since grab-start, converted into the object's local frame
			const objQuatInv = edited
				? edited.getWorldQuaternion(new THREE.Quaternion()).invert()
				: new THREE.Quaternion();
			const dPosW = pos1.clone().sub(faceGrabHand.pos0);
			const dPos = dPosW.applyQuaternion(objQuatInv);
			const dQuat = objQuatInv
				.clone()
				.multiply(quat1.clone().multiply(faceGrabHand.quat0.clone().invert()))
				.multiply(objQuatInv.clone().invert());
			const axes = axesForSlot(faceGrabHand.index);
			const sy = Math.abs(axes[3] ?? 0) > 0.15 ? axes[3] : 0;
			const sx = Math.abs(axes[2] ?? 0) > 0.15 ? axes[2] : 0;
			faceGrabHand.push += -sy * 0.01;
			faceGrabHand.scale = Math.min(Math.max(faceGrabHand.scale + sx * 0.01, 0.05), 5);
			applyFaceGrab({ dPos, dQuat, push: faceGrabHand.push, scale: faceGrabHand.scale });
		} else if (faceGesturePending()) {
			// 184/185: controller motion along the face normal drives depth (extrude)
			// / size (inset); the stick still fine-tunes the cap scale (l/r)
			const menuIndex = [...session.inputSources].findIndex((s) => s.handedness === get(vrMenuHand));
			const axes = menuIndex >= 0 ? (session.inputSources[menuIndex]?.gamepad?.axes ?? []) : [];
			const sx = Math.abs(axes[2] ?? 0) > 0.15 ? axes[2] : 0;
			let dAmount = 0;
			if (faceAdjustHand && faceAdjustHand.index >= 0) {
				const cur = renderer.xr.getController(faceAdjustHand.index).getWorldPosition(new THREE.Vector3());
				dAmount = cur.clone().sub(faceAdjustHand.lastPos).dot(faceAdjustHand.normal);
				faceAdjustHand.lastPos = cur;
			}
			if (dAmount || sx) adjustFaceGesture(dAmount, sx * 0.01);
		} else {
			// idle: the pointer ray highlights the face under it (121)
			const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
			if (pointerIndex >= 0) {
				const edited = get(objectsGroup)?.getObjectByProperty('uuid', get(faceEditObject));
				if (edited) {
					const hits = controllerRay(pointerIndex).intersectObject(edited, false);
					const tri = hits.length && hits[0].faceIndex != null ? hits[0].faceIndex : -1;
					if (highlightFaceByTriangle(tri) && tri >= 0) hapticPulse(0.1, 12);
				}
			}
		}
	}

	// both-grips world grab (71): scale/rotate/pan the rig around the hands
	if (S.worldGrab) updateWorldGrab();

	// drag-the-world: the grabbed spot follows the hand (prev stays fixed at
	// grab start — the applied offset self-corrects the measured delta)
	if (S.worldPan) {
		// 33 (G2): the pan hand's stick reels the world along its ray, as an Edit grab reels a
		// held object — moving the fixed `prev` makes the pan below apply the push itself
		const reel = worldReelStep(S.worldPan.reach, axesForSlot(S.worldPan.index)[3] ?? 0);
		if (reel.push) {
			S.worldPan.reach = reel.reach;
			renderer.xr.getController(S.worldPan.index).getWorldQuaternion(_reelQuat);
			_reelDir.set(0, 0, -1).applyQuaternion(_reelQuat);
			S.worldPan.prev.addScaledVector(_reelDir, -reel.push);
		}
		const current = renderer.xr.getController(S.worldPan.index).getWorldPosition(new THREE.Vector3());
		const delta = current.sub(S.worldPan.prev);
		if (delta.lengthSq() > 1e-8) {
			const space = renderer.xr.getReferenceSpace();
			if (space)
				renderer.xr.setReferenceSpace(
					space.getOffsetReferenceSpace(new XRRigidTransform({ x: delta.x, y: delta.y, z: delta.z }))
				);
		}
	}

	// sector highlight (74/109): pointer-hand ray first, then the MENU hand's
	// own thumbstick (one-handed control), then the pointer stick as fallback;
	// a hover change gives a small haptic tick
	if (get(vrKeyboardTarget)) {
		// keyboard is modal on top (116): the pointer ray highlights keys, either
		// stick nudges through them left-to-right / row-to-row via the raycast
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hovered = pointerIndex >= 0 ? raycastKeyboard(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.1, 12);
			vrHovered.set(hovered);
		}
	} else if (get(vrMenuOpen)) {
		const sources = [...session.inputSources];
		const menuHand = get(vrMenuHand);
		const pointerHand = menuHand === 'right' ? 'left' : 'right';
		const pointerIndex = controllerIndexFor(pointerHand);
		let hovered = pointerIndex >= 0 ? raycastMenu(pointerIndex) : null;
		S.radialStickHover = null;
		if (!hovered) {
			const entries = ringEntries(get(activeRing));
			// 31 R1: each stick is read from ITS OWN inputSource, found by handedness — the
			// pointer's used to be `sources[<controller slot>]`, which is the other hand's
			// source after a hands<->controllers swap (the 194/210 divergence)
			for (const hand of [menuHand, pointerHand]) {
				const axes = sources.find((s) => s.handedness === hand)?.gamepad?.axes ?? [];
				const sector = sectorFromStick(axes[2] ?? 0, axes[3] ?? 0, entries.length);
				if (sector !== null) {
					const entry = entries[sector];
					// a greyed sector never lights (D4) — nor may a stick pick it
					hovered = entry && !entry.disabled?.() ? entry.id : null;
					S.radialStickHover = hovered;
					break;
				}
			}
		}
		if (hovered !== get(vrHovered)) {
			// one tick per sector change (Edit-silent through hapticPulse's own gate, C4)
			if (hovered) hapticPulse(0.15, 18);
			vrHovered.set(hovered);
		}
	} else if (get(vrObjectsPanelOpen)) {
		// objects panel (101/109): ray highlights rows; EITHER stick moves a row
		// cursor (scrolls with it), stick-press/trigger selects the cursored row
		const sources = [...session.inputSources];
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const menuIndex = sources.findIndex((s) => s.handedness === get(vrMenuHand));
		const hovered = pointerIndex >= 0 ? raycastPanel(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
		let y = 0;
		for (const index of [pointerIndex, menuIndex])
			if (index >= 0 && Math.abs(sources[index]?.gamepad?.axes?.[3] ?? 0) > Math.abs(y))
				y = sources[index].gamepad.axes[3];
		const now = Date.now();
		if (Math.abs(y) > 0.6 && now - S.panelScrollAt > 220) {
			S.panelScrollAt = now;
			hapticPulse(0.08, 10);
			vrPanelCursor.update((v) => Math.max(0, v + (y > 0 ? 1 : -1)));
			// 120: selection FOLLOWS the cursor (lock-respecting) so navigating
			// the list selects live — no separate press needed. 215: over the
			// FLATTENED rows (expanded groups' children inline).
			const rows = flattenPanelRows(get(objectsGroup)?.children ?? [], get(vrPanelExpanded));
			const idx = Math.min(Math.max(0, get(vrPanelCursor)), Math.max(0, rows.length - 1));
			const target = rows[idx]?.object;
			if (target && !get(lockedObjects).find((lock) => lock[1] === target.uuid))
				selectObject(target.uuid);
		}
	} else if (get(vrPropsPanelOpen)) {
		// props panel (112): ray highlights controls; EITHER stick moves the row
		// cursor, stick left/right nudges the cursored row, press activates it
		const sources = [...session.inputSources];
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const menuIndex = sources.findIndex((s) => s.handedness === get(vrMenuHand));
		const hovered = pointerIndex >= 0 ? raycastProps(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
		let x = 0;
		let y = 0;
		for (const index of [pointerIndex, menuIndex]) {
			const axes = index >= 0 ? (sources[index]?.gamepad?.axes ?? []) : [];
			if (Math.abs(axes[3] ?? 0) > Math.abs(y)) y = axes[3];
			if (Math.abs(axes[2] ?? 0) > Math.abs(x)) x = axes[2];
		}
		const now = Date.now();
		if (Math.abs(y) > 0.6 && Math.abs(y) >= Math.abs(x) && now - S.panelScrollAt > 220) {
			S.panelScrollAt = now;
			hapticPulse(0.08, 10);
			vrPropsCursor.update((v) =>
				Math.min(Math.max(0, v + (y > 0 ? 1 : -1)), PROPS_ROWS.length - 1)
			);
		} else if (Math.abs(x) > 0.6 && Math.abs(x) > Math.abs(y) && now - S.panelScrollAt > 220) {
			// left/right adjusts the cursored row (axis nudges + opacity)
			const row = PROPS_ROWS[get(vrPropsCursor)];
			const sign = x > 0 ? 1 : -1;
			if (row === 'opacity' || row === 'lod' || row.includes(':')) {
				S.panelScrollAt = now;
				hapticPulse(0.1, 12);
				executeVRMenuAction(
					row === 'opacity' ? 'props:opacity:' + sign : row === 'lod' ? 'props:lod:' + sign : 'props:nudge:' + row + ':' + sign
				);
			}
		}
	} else if (get(vrPrefabsPanelOpen)) {
		// prefabs window (115): ray highlights cells; EITHER stick moves the
		// cell cursor, press arms the cursored prefab's ghost
		const sources = [...session.inputSources];
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const menuIndex = sources.findIndex((s) => s.handedness === get(vrMenuHand));
		const hovered = pointerIndex >= 0 ? raycastPrefabs(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
		let y = 0;
		for (const index of [pointerIndex, menuIndex])
			if (index >= 0 && Math.abs(sources[index]?.gamepad?.axes?.[3] ?? 0) > Math.abs(y))
				y = sources[index].gamepad.axes[3];
		const now = Date.now();
		if (Math.abs(y) > 0.6 && now - S.panelScrollAt > 220) {
			S.panelScrollAt = now;
			hapticPulse(0.08, 10);
			const count = get(prefabs).length;
			vrPrefabsCursor.update((v) => Math.min(Math.max(0, v + (y > 0 ? 1 : -1)), Math.max(0, count - 1)));
		}
	} else if (get(vrChatPanelOpen)) {
		// chat panel (117): the pointer ray highlights close / input
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hovered = pointerIndex >= 0 ? raycastChat(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
	} else if (get(vrSettingsPanelOpen)) {
		// VR Settings panel (187): the pointer ray highlights its rows. 36 (S23): EITHER stick walks a row
		// cursor (the Objects/Props panel pattern) — up/down moves it, left/right changes the cursored
		// choice (or the page, on the tab strip); a stick press presses (the chain above)
		const sources = [...session.inputSources];
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hovered = pointerIndex >= 0 ? raycastSettings(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
		let x = 0;
		let y = 0;
		for (const src of sources) {
			const axes = src?.gamepad?.axes ?? [];
			if (Math.abs(axes[3] ?? 0) > Math.abs(y)) y = axes[3];
			if (Math.abs(axes[2] ?? 0) > Math.abs(x)) x = axes[2];
		}
		const now = Date.now();
		// a sideways flick changes a value ONCE per flick (the stick must come back to centre): a repeat
		// would cycle a two-option choice straight back to where it was. Up/down repeats like a list.
		if (Math.abs(x) < 0.4) settingsFlickArmed = true;
		const rows = settingsPanelRows(get(vrSettingsPage));
		const at = Math.min(Math.max(0, get(vrSettingsCursor)), rows.length - 1);
		if (Math.abs(y) > 0.6 && Math.abs(y) >= Math.abs(x) && now - S.panelScrollAt > 220) {
			S.panelScrollAt = now;
			hapticPulse(0.08, 10);
			vrSettingsCursor.set(Math.min(Math.max(0, at + (y > 0 ? 1 : -1)), rows.length - 1));
		} else if (Math.abs(x) > 0.6 && Math.abs(x) > Math.abs(y) && settingsFlickArmed) {
			settingsFlickArmed = false;
			S.panelScrollAt = now;
			hapticPulse(0.08, 10);
			const row = rows[at];
			const dir = x > 0 ? 1 : -1;
			if (row?.kind === 'tabs') vrSettingsPage.set(neighbourTab(get(vrSettingsPage), dir));
			else if (row?.rowId && (row.kind === 'choice' || row.kind === 'range')) activateVRSetting(row.rowId, dir);
		}
	} else if (get(vrApprovePanelOpen)) {
		// VR peer-approval panel (211): the pointer ray highlights Approve / Deny
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hovered = pointerIndex >= 0 ? raycastApprove(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
	} else if (get(vrEditMenuOpen)) {
		// Edit Mesh side-menu (137): the pointer ray highlights its rows
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hovered = pointerIndex >= 0 ? raycastEdit(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
	} else if (get(vrSnapMenuOpen)) {
		// Snap side-menu (156): the pointer ray highlights its rows
		const pointerIndex = controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
		const hovered = pointerIndex >= 0 ? raycastSnap(pointerIndex) : null;
		if (hovered !== get(vrHovered)) {
			if (hovered) hapticPulse(0.12, 14);
			vrHovered.set(hovered);
		}
	} else if (get(vrHovered) !== null) {
		vrHovered.set(null);
	}
}

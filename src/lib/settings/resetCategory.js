// 37-settings (R21) — "Reset <Category> to defaults". The spec: reset always asks, and is scoped to
// the current category. This puts back the default of EVERY SETTING ROW on that page and nothing
// else — it never runs an action row (Reset tours, Window positions, Clear stored anchor…) and never
// touches DATA (saved AI providers and keys, colocation anchors, tour progress, checkpoints).
//
// Each value goes back through its OWN store / setter, so the store, its storage key and any side
// effect (the theme class, vrBindings ↔ vrMenuHand, <html>.allow-undock …) stay in step — never a
// raw removeItem behind a store's back. The one exception is a key whose default is ABSENCE and
// whose store does not write it (Show grid, VR override, placeholderStyleChosen): those are removed
// exactly the way their own controls remove them.
//
// The key list per category is docs/settings-inventory.md §6; tests/unit/settingsReset.test.js holds
// every row to it. 1.25.0's footer "Reset settings" (safeStorage.clear()) survives unchanged as
// About › Danger zone › Reset all settings (resetAllSettings below).
import { get, writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { showConfirm } from '../confirmDialog';
import {
	advancedMode,
	showEnvInList,
	objectSearchEnabled,
	showSimControls,
	toastsInDrawerOnly,
	showRoomsButton,
	mobileUndockAllowed,
	enableShiftAdd,
	noteDoubleClickToOpen,
	duplicateCarriesAnimation,
	duplicateCarriesFlow,
	duplicateCarriesShader,
	touchTools,
	floatingToolbar,
	toolbarAlwaysOnTop,
	showToast
} from '../../stores/appStore.js';
import {
	showGrid,
	vrOverride,
	vrSnapAngle,
	vrMirrorSnapTurn,
	vrTeleportEnabled,
	vrFlying,
	vrMenuHold,
	vrGrabStyle,
	vrTargetHz,
	vrStatsOpen,
	peerHandStyle,
	vrPassthrough,
	vrWireframeSelection,
	vrVertexHold,
	vrSleeveEnabled
} from '../../stores/sceneStore.js';
import { syncedAnimations } from '../../stores/flowStore';
import { allowTextSelection } from '../textSelection';
import { peersAsClassic, knockedAfterSeconds, KNOCKED_AFTER_DEFAULT } from '../avatars/avatarState';
import { offerUndo } from '../undoToast';
import { theme } from '../themes';
import { gameSoundVolume } from '../gameSfx';
import { gameMusicVolume } from '../gameMusic';
import { showWelcomeOnStart, showWhatsNewNotice } from '../whatsNew';
import { tours } from '../tours/index.js';
import { xrOfferEnabled } from '../xrOffer';
import { perfStatsShown } from '../fpsMeter';
import { perfReportsOn } from '../perf/beacon';
import { setViewPrefs, DEFAULT_VIEW_PREFS } from '../viewPrefs';
import { uiDensity } from '../uiDensity';
import { helpersInPlay } from '../helperLayer';
import { trackpadMode, allowBrowserZoom, reversePan, panEnabled, pinchZoomEnabled } from '../trackpadNav';
import { resetGamepadPrefs } from '../gamepadPrefs';
import { flowMouseBindings } from '../flowPrefs';
import { nodeEditorOpens } from '../flowView';
import { setTouchPrefs, DEFAULT_TOUCH_PREFS, touchTextures, touchLayouts } from '../touchActions';
import { setTouchLookSpeed } from '../touchControls';
import { resetAllShortcuts } from '../shortcuts';
import { lightHelperLength } from '../lightHelpers';
import { shadowQuality } from '../lightParams';
import { autoQuality } from '../qualityGovernor';
import { lodEnabled } from '../lod';
import { kitInstancingEnabled } from '../kitInstancing';
import { waterQuality } from '../water/waterPrefs.js';
import { spatialVoice } from '../voiceChat';
import { pingColor, pingSound } from '../ping';
import { autosaveEnabled, autoRestoreEnabled } from '../autosave';
import { autoCheckpoints, autoCheckpointMinutes, checkpointCapMb } from '../checkpoints';
import { modulesOnOpen } from '../sceneSwitch';
import { doubleClickAction } from '../selectionPrefs';
import { lengthUnit, angleUnit } from '../units';
import { shareDuplicatedMaterials } from '../materialSharing';
import { placeholderStyle, placeholderGrid, placeholderStuckSeconds, DEFAULT_GRID, DEFAULT_PLACEHOLDER_STYLE } from '../loadStates';
import { shareNewFiles, autoDownload, unshareAuthority, recycleBinEnabled, keepRecycleBin, deletedLogEnabled, deleteWithoutConfirm } from '../sharedLibrary';
import { mergeOnConnect, softPeerCap, SOFT_PEER_CAP_DEFAULT } from '../connectionState';
import { keepVersionsSetting, KEEP_VERSIONS } from '../projectManifest';
import { duplicateImportMode } from '../importDuplicates';
import { saveNameTemplate, DEFAULT_TEMPLATE } from '../saveName';
import { disabledNodeTypes } from '../nodeTypePrefs';
import { setExportPrefs, DEFAULT_EXPORT_PREFS } from '../export/exportStores.js';
import { vrSmoothTurn, vrSmoothTurnSpeed, vrComfortVignette, vrStance, vrHeightOffset, vrSnapAngleLast } from '../vr/prefs.js';
import { resetBindings } from '../vr/bindings.js';
import { setVrHudPlacement, setVrHudSize, setVrHudHints } from '../vrHudPrefs';
import { vrFaceCap, VR_FACE_CAP } from '../faceEdit';
import { vrVertexCap, VR_VERTEX_CAP } from '../meshEdit';
import { setMyHandModel, myHandModel } from '../handModels';
import { colocatedGhostHands } from '../colocationPresence';
import { setAiEnabled } from '../ai/providers';
import { setMeshGenEnabled } from '../ai/meshProviders';
import { setSttConfig, sttPresetFor } from '../ai/stt.js';
import { peerServerConfig } from '../peerServer';

/** the VR schema's `put`: these stores have no persisting subscriber, the row writes the key itself
 * @param {import('svelte/store').Writable<any>} store @param {string} key @param {any} value */
function put(store, key, value) {
	store.set(value);
	safeStorage.setItem(key, String(value));
}

/** the default "Touch tools" picks on a fresh device (appStore.js) — coarse pointer or a narrow screen */
function touchToolsDefault() {
	if (typeof window === 'undefined') return false;
	return !!window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth <= 820;
}

/** @type {Record<string, () => void>} section key → reset */
const RESETS = {
	interface() {
		allowTextSelection.set(false);
		peersAsClassic.set(false);
		knockedAfterSeconds.set(KNOCKED_AFTER_DEFAULT);
		theme.set('dark');
		gameSoundVolume.set(0.8);
		gameMusicVolume.set(0.6);
		showWelcomeOnStart.set(false);
		showWhatsNewNotice.set(true);
		toastsInDrawerOnly.set(false);
		tours.setAutoStart(true);
		xrOfferEnabled.set(true);
		showRoomsButton.set(true);
		floatingToolbar.set(true);
		toolbarAlwaysOnTop.set(false);
		touchTools.set(touchToolsDefault());
		mobileUndockAllowed.set(false);
		advancedMode.set(false);
		showEnvInList.set(false);
		objectSearchEnabled.set(false);
		perfStatsShown.set(false);
		perfReportsOn.set(false);
		setViewPrefs({ dockPushesViewport: DEFAULT_VIEW_PREFS.dockPushesViewport });
		uiDensity.set('comfortable');
	},
	controls() {
		enableShiftAdd.set(false);
		helpersInPlay.set(false);
		noteDoubleClickToOpen.set(false);
		trackpadMode.set('auto');
		panEnabled.set(true);
		reversePan.set(false);
		pinchZoomEnabled.set(true);
		allowBrowserZoom.set(false);
	},
	input() {
		resetGamepadPrefs();
		flowMouseBindings.set('classic');
		nodeEditorOpens.set('left');
	},
	touchcontrols() {
		const { visibility, showInEdit, haptics } = DEFAULT_TOUCH_PREFS;
		setTouchPrefs({ visibility, showInEdit, haptics });
		setTouchLookSpeed(1);
		touchTextures.set({});
		safeStorage.removeItem('touchControlsTextures');
		touchLayouts.set({ global: null, games: {} });
		safeStorage.removeItem('touchControlsLayouts');
	},
	shortcuts() {
		resetAllShortcuts();
	},
	scene() {
		showGrid.set(true);
		safeStorage.removeItem('showGrid');
		lightHelperLength.set(2);
		showSimControls.set(false);
		shadowQuality.set('high');
		autoQuality.set(true);
		lodEnabled.set(true);
		kitInstancingEnabled.set(true);
		waterQuality.set('auto');
		syncedAnimations.set(true);
		spatialVoice.set(true);
		pingColor.set('');
		pingSound.set('ding');
		autosaveEnabled.set(true);
		autoRestoreEnabled.set(false);
		autoCheckpoints.set(true);
		autoCheckpointMinutes.set(10);
		checkpointCapMb.set(250);
		modulesOnOpen.set('ask');
		doubleClickAction.set('properties');
		lengthUnit.set('m');
		angleUnit.set('deg');
		duplicateCarriesAnimation.set(true);
		duplicateCarriesFlow.set(true);
		duplicateCarriesShader.set(true);
		shareDuplicatedMaterials.set(false);
		const { wireColor, outlineColor, editWireColor } = DEFAULT_VIEW_PREFS;
		setViewPrefs({ wireColor, outlineColor, editWireColor });
		placeholderStyle.set(DEFAULT_PLACEHOLDER_STYLE);
		safeStorage.removeItem('placeholderStyleChosen');
		placeholderGrid.set({ ...DEFAULT_GRID });
		placeholderStuckSeconds.set(10);
	},
	explorer() {
		shareNewFiles.set('ask');
		autoDownload.set(true);
		mergeOnConnect.set(false);
		unshareAuthority.set('anyone');
		keepVersionsSetting.set(KEEP_VERSIONS);
		duplicateImportMode.set('ask');
		saveNameTemplate.set(DEFAULT_TEMPLATE);
		recycleBinEnabled.set(true);
		deleteWithoutConfirm.set(false);
		keepRecycleBin.set(false);
		deletedLogEnabled.set(true);
	},
	nodetypes() {
		disabledNodeTypes.set([]);
	},
	export() {
		const { startFullscreen, showFps, quality, vrButton, useCdnForPacks } = DEFAULT_EXPORT_PREFS;
		setExportPrefs({ startFullscreen, showFps, quality, vrButton, useCdnForPacks });
	},
	vr() {
		vrOverride.set(false);
		safeStorage.removeItem('vrOverride');
		put(vrSmoothTurn, 'vrSmoothTurn', false);
		put(vrSnapAngle, 'vrSnapAngle', 45);
		vrSnapAngleLast.set(45);
		vrSmoothTurnSpeed.set(90);
		put(vrMirrorSnapTurn, 'vrMirrorSnapTurn', false);
		vrComfortVignette.set(false);
		put(vrTeleportEnabled, 'vrTeleportEnabled', true);
		put(vrFlying, 'vrFlying', false);
		vrStance.set('standing');
		vrHeightOffset.set(0);
		resetBindings(); // vrBindings + vrMenuHand 'right' (Left-handed off)
		put(vrMenuHold, 'vrMenuHold', false);
		put(vrGrabStyle, 'vrGrabStyle', 'rigid');
		vrTargetHz.set('auto');
		put(vrStatsOpen, 'vrStats', false);
		peerHandStyle.set('hands');
		put(vrPassthrough, 'vrPassthrough', false);
		put(vrWireframeSelection, 'vrWireframe', true);
		setVrHudPlacement('head');
		setVrHudSize('medium');
		setVrHudHints(true);
		put(vrVertexHold, 'vrVertexHold', true);
		put(vrSleeveEnabled, 'vrSleeveEnabled', false);
		vrFaceCap.set(VR_FACE_CAP);
		vrVertexCap.set(VR_VERTEX_CAP);
		if (get(myHandModel)) setMyHandModel('');
		colocatedGhostHands.set(true);
	},
	ai() {
		// Decision G: saved providers and API keys are DATA and stay; only the switches and the
		// voice-typing endpoint go back (its API key stays too)
		setAiEnabled(false);
		setMeshGenEnabled(false);
		const p = sttPresetFor('openai');
		setSttConfig({ preset: p.preset, baseUrl: p.baseUrl, model: p.defaultModel, language: '' });
	},
	connection() {
		softPeerCap.set(SOFT_PEER_CAP_DEFAULT);
		peerServerConfig.update((c) => ({
			...c,
			mode: 'default',
			custom: { host: '', port: 443, path: '/peerjs', secure: true, key: '', stunUrls: '', turnUrls: '', turnUsername: '', turnCredential: '' }
		}));
	}
};

/** can this section be reset (About and an unknown section cannot) @param {string} key */
export function canResetCategory(key) {
	return Object.prototype.hasOwnProperty.call(RESETS, key);
}

/** bumped after every reset — a page drawn from something that is not a store (the shortcut
 * registry, tour records) re-reads on it */
export const settingsResetTick = writable(0);

/** put every setting row of one category back to its default @param {string} key @returns {boolean} */
export function resetCategory(key) {
	const fn = RESETS[key];
	if (!fn) return false;
	fn();
	settingsResetTick.update((n) => n + 1);
	return true;
}

/** 1.25.0's footer "Reset settings", unchanged: this browser's whole local storage for the app */
export function resetAllSettings() {
	safeStorage.clear();
}

/** the section keys a reset exists for (the unit test walks them) */
export const RESETTABLE = Object.keys(RESETS);

/**
 * The footer link: ask, then reset one category. Resolves true when it reset.
 * @param {string} key the section key @param {string} label its title ("Interface")
 */
export async function askResetCategory(key, label) {
	if (!canResetCategory(key)) return false;
	const ok = await showConfirm({
		title: `Reset ${label} to defaults?`,
		message:
			key === 'ai'
				? 'The assistant, mesh generation and voice typing go back to their defaults on this device. Your saved providers and API keys stay.'
				: `Every setting on the ${label} page goes back to its default, on this device only. Nothing else changes.`,
		confirmLabel: 'Reset',
		cancelLabel: 'Cancel'
	});
	if (!ok) return false;
	resetCategory(key);
	showToast(`${label} reset to defaults`);
	return true;
}

/** About › Danger zone: ask, then wipe every setting on this device (1.25.0's "Reset settings") */
export async function askResetAllSettings() {
	const ok = await showConfirm({
		title: 'Reset all settings?',
		message:
			'Every setting on this device goes back to its default — including window positions, saved AI providers and their keys. Your scenes, library and saved sessions are not touched.',
		confirmLabel: 'Reset all settings',
		cancelLabel: 'Cancel'
	});
	if (!ok) return false;
	// 37 R25 (37-editor-small): the wipe happens at once and a toast offers Undo for ~8 s — every
	// stored key and value is held by the offer and written back (the values apply on the next
	// reload either way, so restoring the storage IS the undo). LOCAL, like the settings.
	const saved = safeStorage.keys().map((key) => /** @type {const} */ ([key, safeStorage.getItem(key)]));
	resetAllSettings();
	offerUndo({
		id: 'reset-settings',
		text: 'All settings reset — reload the app to see every default.',
		done: 'Settings restored',
		undo: () => {
			for (const [key, value] of saved) if (value !== null) safeStorage.setItem(key, value);
		}
	});
	return true;
}

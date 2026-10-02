// VR controls — the public face (34 R4 A5). The implementation is src/lib/vr/, one file per concern
// (core, pointer, panels, hooks, locomotion, haptics, input, grip, tools, radial, frame, modes, + the
// cross-concern state in state.js). This file re-exports EXACTLY the names it exported before the split,
// so every importer of ./vrControls is unchanged; a new VR feature goes in the concern file it belongs to
// (or a new one) and is listed here only if code outside src/lib/vr/ needs it.

export {
	initVRControls
} from './vr/core.js';
export {
	updateHoverBox,
	registerOverlayPanel,
	panelOverlayDebug,
	beamTarget,
	reticlePose,
	withRayCamera,
	pointerHandRay
} from './vr/pointer.js';
export {
	vrHovered,
	vrFaceCreateMode,
	vrMenuGroup,
	vrPanelGroup,
	vrPanelCursor,
	vrPanelExpanded,
	flattenPanelRows,
	vrFocusObject,
	vrPanelCursorAction,
	vrStatsGroup,
	vrChatUnread,
	raycastPanel,
	vrPaletteGroup,
	raycastPalette,
	vrPaletteLightness,
	vrPropsGroup,
	vrPropsCursor,
	PROPS_ROWS,
	cycleForceLod,
	lodReadout,
	raycastProps,
	vrEditGroup,
	raycastEdit,
	vrSnapGroup,
	raycastSnap,
	vrSettingsGroup,
	raycastSettings,
	applySnapMode,
	nudgeStep,
	propsRowAction,
	vrPrefabsGroup,
	vrPrefabsCursor,
	vrPrefabGhost,
	vrChatGroup,
	raycastChat,
	vrApproveGroup,
	raycastApprove,
	vrKeyboardGroup,
	raycastKeyboard,
	raycastPrefabs,
	cancelPrefabGhost,
	placePrefabGhost,
	registerVRWindow,
	vrWindowIds,
	windowGroupFor
} from './vr/panels.js';
export {
	registerNavSuppressor,
	registerPanelGroupProvider,
	registerVRTriggerHooks,
	triggerClaimed,
	vrModuleTriggerStart,
	vrModuleTriggerEnd,
	vrModuleSelectSwallowed,
	registerGripDropHook,
	registerVRFrameHook,
	registerWorldGrabDivert
} from './vr/hooks.js';
export {
	computeMoveOffset,
	computeTeleportArc,
	teleportVerdict,
	teleportPreview,
	teleportArms,
	teleportState,
	updateTeleport,
	teleportArcPose,
	snapTurnRadians,
	turningInForce,
	SMOOTH_TURN_DPS,
	lastSmoothTurn,
	VR_WALK_SPEED,
	noteXRBaseSpace,
	vrLocomotionNow,
	vrWalkStep,
	tickVRInteractLocomotion,
	vrJumpHeight,
	spawnPlayer
} from './vr/locomotion.js';
export {
	hapticPulse,
	hapticPattern,
	hapticKnock,
	hapticDebug
} from './vr/haptics.js';
export {
	controllerIndexFor,
	handSnapshot,
	worldToContentPose,
	applyVRFrameRate,
	shouldSendHands,
	handBoneSegments,
	handModelSegments,
	PINCH_HOLD_MS,
	pinchMenuToggledAt,
	onHandPinchStart,
	onHandPinchEnd,
	onInputSourcesChange
} from './vr/input.js';
export {
	vrGrabbedUuid,
	vrGrabbedUuids,
	worldReelStep,
	vrGripDebug,
	stretchDivergence,
	twoGripStretchActive,
	worldScale,
	resetWorldRig,
	computeWorldGrabTransform,
	containedTopLevel,
	vrFaceTrigger,
	vrVertexTrigger,
	vrVertexGrabStart,
	vrVertexGrabEnd,
	vertexTriggerActive,
	gripTargetOf,
	lastGripRefusalDebug,
	rigidGrabPose,
	grabStickAdjust
} from './vr/grip.js';
export {
	boxSelectStart,
	selectObjectsInBox,
	boxSelectEnd,
	boxSelectActive,
	beginStretch,
	setStretch,
	nudgeStretch,
	commitStretch,
	cancelStretch,
	stretchState,
	stretchFactors,
	raycastStretchSlider,
	beginStretchSliderDrag,
	updateStretchSliderDrag,
	endStretchSliderDrag,
	stretchSliderAxis
} from './vr/tools.js';
export {
	raycastMenu,
	radialStickSelection,
	executeVRMenuAction,
	vrPingArmed,
	firePingIfArmed,
	pointerHandIndex,
	pingPointFromRay
} from './vr/radial.js';
export {
	vrNavigationSuppressed,
	updateVRControls
} from './vr/frame.js';
export {
	sceneIsGame,
	modeHand,
	onVRSessionStart,
	toggleVRMode,
	vrModeLabelDebug
} from './vr/modes.js';

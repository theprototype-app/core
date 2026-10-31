// The debug hook — `window.__stores`, how e2e suites (and a curious developer) reach the app's
// singletons. Opt-in: App.svelte installs it only when safeStorage holds `debugStores`.
//
// 34 R4 (A2): ONE ROW PER HOOK, its name and its loader on the same line. This replaced App.svelte's
// three POSITIONAL tails (a Promise.all import list, a destructured parameter list and the
// `window.__stores` object literal) that every lane edited and every merge could silently shift —
// a missing binding bound each later module to its neighbour's name with no error anywhere. A row
// cannot shift: add `['name', () => import('./x')]` anywhere in the list (order does not matter;
// names must be unique — the debug-hooks suite checks). `'*'` SPREADS a module's exports straight
// onto `__stores` (the three stores, as before); every named row is applied after them, so a named
// hook wins a clash exactly as it did in the old object literal.
//
// The loaders stay DYNAMIC on purpose: this table must never pull ~200 modules into the boot graph
// of a session that did not ask for the hook. Code that already holds an object can publish it with
// `registerDebugHook(name, obj)` (before or after the install) instead of adding a row.

/** @type {[string, () => Promise<any>][]} */
export const DEBUG_HOOKS = [
	['*', () => import('../stores/sceneStore')],
	['*', () => import('../stores/appStore')],
	['*', () => import('../stores/flowStore')],
	// 34 R2: the game kit (kit, kitDebug, kitAuthorityId)
	['kit', () => import('./kit/runtime.js')],
	// 55: the pure authority pick, so a suite can re-run it on a page's live facts
	['kitAuthority', () => import('./kit/authority.js')],
	// 34 R2 (kit-entities): entities drawn / world / api (kitEntitiesDebug, kitEntitiesApi, entityOfObject)
	['kitEntities', () => import('./kit/entityApp.js')],
	// 34 R3 (D1/D2): behaviours (runtime, behaviourStatus, behavioursDebug)
	['behaviours', () => import('./behaviours/app.js')],
	// 69: the sandbox engine (sandboxReady / loadSandbox / sandboxLoadError) — probes on built apps
	['sandbox', () => import('./sandbox/engine.js')],
	['meshEdit', () => import('./meshEdit')],
	['perf', () => import('./perf/recorder')],
	['perfDetailed', () => import('./perf/detailed')],
	['perfBeacon', () => import('./perf/beacon')],
	['errorReports', () => import('./errorReports')],
	['hideMyIp', () => import('./hideMyIp')],
	['peerRateGate', () => import('./peerRateGate')],
	['staleModules', () => import('./staleModules')],
	['perfMoment', () => import('./perf/moment')],
	['problemReport', () => import('./problemReport')],
	['profilerView', () => import('./perf/profilerView')],
	['profilerModel', () => import('./perf/profilerModel.js')],
	['vrRecIndicator', () => import('./vrRecIndicator')],
	// 36 U3b/I5: the tour engine (tours, activeTour, toursDebug) + the built-in tours
	['tours', () => import('./tours/index.js')],
	['toursBuiltin', () => import('./tours/builtin.js')],
	// 39: drag to place — the preview setting, the measured dims, the pack downloads, the ghost
	['placementPrefs', () => import('./placementPrefs.js')],
	['placementDims', () => import('./placementDims.js')],
	['packCache', () => import('./packCache.js')],
	// 60 Q6: the local asset cache (OPFS) — index, stats, clear, persist
	['assetCache', () => import('./assetCache.js')],
	['placeGhost', () => import('./placeGhost.js')],
	['vrPlace', () => import('./vr/placeRay.js')],
	['vrAssetBrowser', () => import('./vr/assetBrowser.js')],
	// 74 VH1: the logic graph as a VR panel · VH3: the agent presence marker
	['vrLogic', () => import('./vr/logicPanel.js')],
	['agentPresence', () => import('./agentPresence.js')],
	['vrHands', () => import('./vr/handInput.js')],
	['tourVR', () => import('./tours/vrPanel.js')],
	// 36-share (B13): the recorder + its stores
	['recording', () => import('./recording/recorder.js')],
	['recordingStores', () => import('./recording/recordingStores.js')],
	['webmDuration', () => import('./recording/webmDuration.js')],
	// 36 A2: the offerSession decision (xrOfferMode, xrOfferEnabled, xrOfferDebug)
	['xrOffer', () => import('./xrOffer')],
	// 36-avatars: rigged avatars (avatarsDebug, avatarInstances, avatarIkPeers, avatarPreview) + assets/catalog
	['avatars', () => import('./avatars/avatarState.js')],
	['avatarAssets', () => import('./avatars/assets.js')],
	['avatarCatalog', () => import('./avatars/catalog.js')],
	// 57: characters — humanoid maps + applied clips, provenance / licence flags, the dialogs' open state
	['humanoidRig', () => import('./humanoid/humanoidRig.js')],
	['provenance', () => import('./provenance.js')],
	['characterUi', () => import('./characterUi.js')],
	// 41 G9: the customise panel's presets / Custom / Surprise me (lookSignature for the e2e)
	['characterLooks', () => import('./avatars/characterLooks.js')],
	['perfLiveSource', () => import('./perf/liveSource')],
	['perfLiveSink', () => import('./perf/liveSink')],
	['perfLiveWire', () => import('./perf/liveWire')],
	['vrControls', () => import('./vrControls')],
	['autosave', () => import('./autosave')],
	// 60 Q4: files shared into the app / opened from the OS (lastLaunch, receiveLaunchFiles, readShareInbox)
	['launchInbox', () => import('./launchInbox.js')],
	// 36 B14: named checkpoints / the version timeline (checkpoints, checkpointsDebug, saveCheckpoint…)
	['checkpoints', () => import('./checkpoints')],
	['voiceChat', () => import('./voiceChat')],
	['audioEngine', () => import('./audioEngine')],
	['musicClock', () => import('./musicClock')],
	['audioDevices', () => import('./audioDevices')],
	['audioPatch', () => import('./audioPatch')],
	['vrPatch', () => import('./vrPatch')],
	['musicToolbox', () => import('./musicToolbox')],
	['micCapture', () => import('./micCapture')],
	['annotationsHandler', () => import('./annotationsHandler')],
	['noteHistory', () => import('./noteHistory')],
	['flowRuntime', () => import('./flowRuntime')],
	// 48 D1: the node graph debugger (stores + requests; the runtime half is flowRuntime.flowDebugRuntime)
	['flowDebug', () => import('./flowDebug.js')],
	['history', () => import('./history')],
	['materialsHandler', () => import('./materialsHandler')],
	// 37 R5: material presets (materialPresets, peerMaterialPresets, applyMaterialPreset, materialPresetsDebug…)
	['materialPresets', () => import('./materialPresets')],
	// 40 F16: the look tier (materialTiersDebug, pinMaterialTier, applyMaterialTiers)
	['materialTiers', () => import('./materialTiers.js')],
	// 40 F15: the motion nodes (motionNodesDebug, resetMotionNodes)
	['motionNodes', () => import('./motion/motionNodes.js')],
	['objectActions', () => import('./objectActions')],
	['commandsHandler', () => import('./commandsHandler.svelte')],
	['moduleSDK', () => import('./moduleSDK')],
	['moduleLifecycle', () => import('./sdk/lifecycleEnv.js')],
	['drawMode', () => import('./drawMode')],
	['pathCapture', () => import('./pathCapture')],
	['lockControl', () => import('./lockControl')],
	['prefabs', () => import('./prefabs')],
	['prefabLinks', () => import('./prefabLinks')],
	['prefabSync', () => import('./prefabSync')],
	['prefabLibrary', () => import('./prefabLibrary')],
	['physics', () => import('./physics')],
	// 36-sim: buoyancy/jiggle/fluid/splash state
	['sim', () => import('./sim/debug.js')],
	// 49-fluid W2: the GPU fluid switch + verdict (gpuFluidDebug, remeasureGpuFluid, loseGpuDeviceForTest)
	['fluidGpu', () => import('./sim/fluidGpuHost.js')],
	// 36-fb-water S8: the undoable "Start simulation on load"
	['simOnLoad', () => import('./sim/simOnLoadHistory.js')],
	['joints', () => import('./joints')],
	['possess', () => import('./possess')],
	['handModels', () => import('./handModels')],
	['terrainSculpt', () => import('./terrainSculpt')],
	// 47 T1/T2: terrain paint + scatter (the brushes / undo / wire) and the look (shader, instances)
	['terrainPaint', () => import('./terrainPaint')],
	['terrainSurface', () => import('./terrainSurface')],
	['terrainPaintCore', () => import('./terrainPaintCore')],
	// 51 E4/E5: editing scatter instances (tools, selection, gizmo) and its pure half
	['scatterEdit', () => import('./scatterEdit')],
	['scatterEditCore', () => import('./scatterEditCore')],
	['scatterConvert', () => import('./scatterConvert')],
	['scatterColliders', () => import('./scatterColliders')],
	['terrainScatterCore', () => import('./terrainScatterCore')],
	// 51 E1: the scatter source catalog (pack items, prefabs + objects as their look)
	['scatterSources', () => import('./scatterSources')],
	['scatterThin', () => import('./scatterThin')],
	['userModules', () => import('./userModules')],
	['environment', () => import('./environment')],
	// 37-hdri: the HDRI layer (hdriDebug, installHdriLayer) + its leaf stores (skyEnv, envToneMapping, hdriStatus) + the pure core
	['hdri', () => import('./hdri/hdriRuntime.js')],
	['hdriStores', () => import('./hdri/skyEnv.js')],
	['hdriCore', () => import('./hdri/hdriCore.js')],
	['hdriPrefs', () => import('./hdri/hdriPrefs.js')],
	['sceneMusic', () => import('./sceneMusic')],
	['animatedImports', () => import('./animatedImports')],
	// 57 M1: .tpanim clip assets (format, binder, humanoid map)
	['tpanim', () => import('./tpanim/format.js')],
	['clipAssets', () => import('./tpanim/clipAssets.js')],
	['motionKit', () => import('./tpanim/motionKit.js')],
	['humanoidMap', () => import('./tpanim/humanoidMap.js')],
	// 57 M3/M8/M11: clip edits + ops, the Animation states graph + runtime
	['clipEdit', () => import('./tpanim/clipEdit.js')],
	['clipOps', () => import('./tpanim/clipOps.js')],
	['animGraph', () => import('./tpanim/animGraph.js')],
	['animGraphRuntime', () => import('./tpanim/animGraphRuntime.js')],
	['fileHandler', () => import('./fileHandler.svelte')],
	['fileWindows', () => import('./fileWindows')],
	['imageEditor', () => import('./image/imageEditor')],
	['imageOps', () => import('./image/imageOps')],
	['imageVersions', () => import('./image/imageVersions')],
	['sceneBounds', () => import('./sceneBounds')],
	['cameraClip', () => import('./cameraClip')],
	['ping', () => import('./ping')],
	['sessions', () => import('./sessions')],
	['geometryEdit', () => import('./geometryEdit')],
	['lightParams', () => import('./lightParams')],
	// 46-media R1: the budgeted shadow (claims, fit state) — the perf gate reads shadowsKeptInXR
	['shadowClaims', () => import('./shadowClaims')],
	['shadowBudget', () => import('./shadowBudget')],
	// 46-media H1: HEIC import (heicDebug: was the decoder ever started, how many photos it made)
	['heic', () => import('./heic.js')],
	['shadowDefaults', () => import('./shadowDefaults')],
	['palette', () => import('./palette')],
	['viewModeCtl', () => import('./viewMode')],
	['inputRuntime', () => import('./inputRuntime')],
	['shortcutsRegistry', () => import('./shortcuts')],
	['keyScope', () => import('./keyScope')],
	// 36 F3/F4: the window-chrome rules (isHeaderDrag, windowDragActive)
	['windowGrip', () => import('./windowGrip')],
	['windowBodyDrag', () => import('./windowBodyDrag')],
	['windowMenu', () => import('./windowMenu')],
	['windowFocus', () => import('./windowFocus')],
	['nodeGroups', () => import('./nodeGroups')],
	['nodeEditorActions', () => import('./nodeEditorActions')],
	['themes', () => import('./themes')],
	// 53 A1 / A5: the UI scale + reduced-motion settings
	['uiScale', () => import('./uiScale')],
	['settingsReset', () => import('./settings/resetCategory')],
	['motion', () => import('./motion')],
	['captionsPref', () => import('./captionsPref')],
	['phoneShell', () => import('./ui/phoneShell.js')],
	// 42 I5: the phone bar list (phoneBar / setBar) and More's three chrome switches
	['phoneBar', () => import('./ui/phoneBar.js')],
	['phonePrefs', () => import('./ui/phonePrefs.js')],
	// 42 I8/I9: the top-right / touch slots (toolbar-slots-42)
	['toolbarSlots', () => import('./toolbarSlots')],
	['textSelection', () => import('./textSelection')],
	['vrRadialMenu', () => import('./vrRadialMenu')],
	['vrBindings', () => import('./vr/bindings.js')],
	['vrSettingsSchema', () => import('./vr/settingsSchema.js')],
	['vrDollhouse', () => import('./vr/dollhouse.js')],
	['vrWorldSnap', () => import('./vr/worldSnap.js')],
	['vrSculpt', () => import('./vr/sculpt.js')],
	// 52 V1/V2: VR measure (the laser tool + its leaf) and the build-tool radial entries (Arrange's runArrange)
	['vrMeasure', () => import('./vr/measure.js')],
	['vrMeasureCore', () => import('./vrMeasureCore')],
	['vrBuildRings', () => import('./vr/buildRings.js')],
	['align', () => import('./align')],
	['vrTourTargets', () => import('./vr/tourTargets.js')],
	['vrPrefs', () => import('./vr/prefs.js')],
	// 53 (A7): recenter + the lift / recenter counts
	['vrLocomotion', () => import('./vr/locomotion.js')],
	['vrPalette', () => import('./vrPalette')],
	['vrWindowPoses', () => import('./vrWindowPoses')],
	['vrKeyboard', () => import('./vrKeyboard')],
	['vrAiPanel', () => import('./vr/aiPanel.js')],
	['aiStt', () => import('./ai/stt.js')],
	['sttCapture', () => import('./ai/sttCapture.js')],
	['faceEdit', () => import('./faceEdit')],
	['meshToolParams', () => import('./meshToolParams')],
	['avatarModel', () => import('./avatarModel')],
	['explorer', () => import('./explorer')],
	// 47-cc0: the CC0 asset browser — import paths + jobs, the window's leaf stores, the pure core
	['cc0', () => import('./cc0/cc0Import.js')],
	['cc0State', () => import('./cc0/assetBrowserState.js')],
	['cc0Core', () => import('./cc0/cc0Core.js')],
	['cc0Fetch', () => import('./cc0/cc0Fetch.js')],
	['bottomDock', () => import('./bottomDock')],
	['dockMenu', () => import('./dockMenu')],
	['phoneDock', () => import('./phoneDock')],
	// 42 I6/I14: the hosted dock tabs, focus mode
	['dockHost', () => import('./dockHost')],
	['focusMode', () => import('./focusMode')],
	['explorerDrop', () => import('./explorerDrop')],
	['assetShare', () => import('./assetShare')],
	['soundRuntime', () => import('./soundRuntime')],
	['dungeonPlay', () => import('./dungeonPlay')],
	['modelLoader', () => import('./modelLoader')],
	['sceneAssets', () => import('./sceneAssets')],
	['THREE', () => import('three')],
	['GLTFExporterModule', () => import('three/addons/exporters/GLTFExporter.js')],
	['snapping', () => import('./snapping')],
	['flowSockets', () => import('./flowSockets')],
	['networkQuality', () => import('./networkQuality')],
	['packs', () => import('./packs')],
	['customNodes', () => import('./customNodes')],
	['nodesHandler', () => import('./nodesHandler')],
	['nodeCatalog', () => import('./nodeCatalog')],
	['objectMenu', () => import('./objectMenu')],
	['animationPreview', () => import('./animationPreview')],
	['aiProviders', () => import('./ai/providers')],
	['aiTools', () => import('./ai/tools')],
	['aiAssistant', () => import('./ai/assistant')],
	['meshProviders', () => import('./ai/meshProviders')],
	['meshJobs', () => import('./ai/meshJobs')],
	['flowGraphsCtl', () => import('./flowGraphs')],
	// 37 (R6): socket add/remove + the switcher type
	['variadic', () => import('./variadicEdit.js')],
	// 36 F10: where the node editor opens (saved views, the setting)
	['flowView', () => import('./flowView')],
	['objectFlow', () => import('./objectFlow')],
	['peerServer', () => import('./peerServer')],
	['cloudHooks', () => import('./cloudHooks')],
	['cloudPlugin', () => import('./cloudPlugin')],
	['connectionState', () => import('./connectionState')],
	['peerApproval', () => import('./peerApproval')],
	['inviteStore', () => import('./inviteStore')],
	['agentLog', () => import('./agentLog')],
	// 56 C1: the agent chat window; `tpchatStore` = the same module as `tpchats` below (56-chat's suites read it by this name)
	['agentChat', () => import('./agentChat')],
	['tpchatStore', () => import('./chat/tpchatStore.js')],
	// 86: the Claude connector's UI state (a leaf — the connector itself stays a lazy chunk)
	['connectorStore', () => import('./connector/connectorStore.js')],
	['peerModeration', () => import('./peerModeration')],
	['peerHide', () => import('./peerHide')],
	['peerFacts', () => import('./peerFacts')],
	['particleRuntime', () => import('./particleRuntime')],
	['particleActions', () => import('./particleActions')],
	['particlePresets', () => import('./particlePresets')],
	['waterVolumes', () => import('./water/volumes.js')],
	['waterRuntime', () => import('./water/waterRuntime.js')],
	['waterPresets', () => import('./water/presets.js')],
	['waterActions', () => import('./water/waterActions.js')],
	['waterPrefs', () => import('./water/waterPrefs.js')],
	['waterSdk', () => import('./sdk/index.js')],
	['waterVrPanels', () => import('./vr/panels.js')],
	['version', () => import('./version')],
	['whatsNew', () => import('./whatsNew')],
	['confirmDialog', () => import('./confirmDialog')],
	['scenePhysics', () => import('./scenePhysics')],
	['playInteract', () => import('./playInteract')],
	// 37: the module pointer seam (DEVX #29)
	['modulePointer', () => import('./modulePointer.js')],
	['moveSmoothing', () => import('./moveSmoothing')],
	['knock', () => import('./knock')],
	['playSettings', () => import('./playSettings')],
	['colliderSpec', () => import('./colliderSpec')],
	['colliderHelpers', () => import('./colliderHelpers')],
	['colliderDecompose', () => import('./colliderDecompose')],
	['colliderEdit', () => import('./colliderEdit')],
	['editSession', () => import('./editSession')],
	['trackpadNav', () => import('./trackpadNav')],
	['vrSleeve', () => import('./vrSleeve')],
	['gridSettings', () => import('./gridSettings')],
	['viewPrefs', () => import('./viewPrefs')],
	['cameraBookmarks', () => import('./cameraBookmarks')],
	['cameraObjects', () => import('./cameraObjects')],
	['cameraHelpers', () => import('./cameraHelpers')],
	['onionSkin', () => import('./onionSkin')],
	['cameraPreview', () => import('./cameraPreview')],
	['addObjects', () => import('./addObjects')],
	['cameraPip', () => import('./cameraPip')],
	// 43 K5: the shared PiP renderer + the maximized dock's viewport PiP
	['pipViews', () => import('./pipViews')],
	['viewportPip', () => import('./viewportPip')],
	['inputDevice', () => import('./inputDevice')],
	['sceneTemplates', () => import('./sceneTemplates')],
	['bvhPicking', () => import('./bvhPicking')],
	['multiTransform', () => import('./multiTransform')],
	['objectOrigin', () => import('./objectOrigin')],
	['moduleGallery', () => import('./moduleGallery')],
	['moduleInstallJobs', () => import('./moduleInstallJobs')],
	['uvEditor', () => import('./uvEditor')],
	['uvUnwrap', () => import('./uvUnwrap')],
	['meshTopology', () => import('./meshTopology')],
	['meshBoolean', () => import('./meshBoolean')],
	['meshBudget', () => import('./meshBudget')],
	['proportional', () => import('./proportional')],
	['proportionalRing', () => import('./proportionalRing')],
	['scenePick', () => import('./scenePick')],
	['snapEngine', () => import('./snapEngine')],
	// 47 M1/M2: the measure tool (chains, pins, snap pref) and its pure arithmetic
	['measure', () => import('./measure')],
	['measureCore', () => import('./measureCore')],
	['measureItems', () => import('./measureItems')],
	['meshPivot', () => import('./meshPivot')],
	['selectionPrefs', () => import('./selectionPrefs')],
	['editOverlays', () => import('./editOverlays')],
	['objectPermissions', () => import('./objectPermissions')],
	['scenePost', () => import('./scenePost')],
	['postEffects', () => import('./postEffects')],
	['viewportOverrides', () => import('./viewportOverrides')],
	['postprocessing', () => import('postprocessing')],
	['shaderBackends', () => import('./shaderBackends')],
	['shaderGraph', () => import('./shaderGraph')],
	['shaderSync', () => import('./shaderSync')],
	['shaderTextures', () => import('./shaderTextures')],
	['shaderCatalog', () => import('./shaderCatalog')],
	['units', () => import('./units')],
	['fieldMenu', () => import('./fieldMenu')],
	['postBackends', () => import('./postBackends')],
	['workspace', () => import('./workspace')],
	['uiLayouts', () => import('./uiLayouts')],
	['undoToast', () => import('./undoToast')],
	['docking', () => import('./docking')],
	['sidebars', () => import('./sidebars')],
	// 43 J9: dismissible tips (the phone More sheet's drag how-to) + Reset tips
	['tips', () => import('./tips')],
	// 43: the layout reloaders (a suite swaps the stored toolbar without reloading the page)
	['uiLayoutsCore', () => import('./uiLayoutsCore')],
	['editResume', () => import('./editResume')],
	['moduleRequirements', () => import('./moduleRequirements')],
	['hudDocs', () => import('./hudDocs')],
	['hudSync', () => import('./hudSync')],
	// 48 S1/S2: the Timeline — data, sync, player
	['sequences', () => import('./sequences')],
	// 56 C10: the scene's chats (.tpchat store + format)
	['tpchats', () => import('./chat/tpchatStore.js')],
	['tpchatCore', () => import('./chat/tpchatCore.js')],
	// 56 C8: the composer's picture pipeline (prepareImage, lastPrepare, composerPending) + its pure half
	['chatAttach', () => import('./chat/attachments.js')],
	['chatAttachCore', () => import('./chat/attachCore.js')],
	// 56 C9: the import_model tool (importModelTool, inspectGlb)
	['importModel', () => import('./ai/importModel.js')],
	// 66 S4b: the import_file tool + its pure half + the scene cards
	['importFile', () => import('./ai/importFile.js')],
	['importFileCore', () => import('./ai/importFileCore.js')],
	['imageCards', () => import('./ai/imageCards.js')],
	// 56: fflate for the suites that look INSIDE an exported .tpscene / .tp (the app's own copy)
	['fflate', () => import('fflate')],
	['sequenceSync', () => import('./sequenceSync')],
	['sequencePlayer', () => import('./sequencePlayer')],
	['idb', () => import('./idb')],
	['hudKinds', () => import('./hudKinds')],
	['hudImages', () => import('./hudImages')],
	['gameState', () => import('./gameState')],
	['gameSync', () => import('./gameSync')],
	['hudActions', () => import('./hudActions')],
	['moduleNodeIO', () => import('./moduleNodeIO')],
	['moduleToolboxes', () => import('./moduleToolboxes')],
	['splineTube', () => import('./splineTube')],
	['splineTool', () => import('./splineTool')],
	['splineEdit', () => import('./splineEdit')],
	['terrainCarve', () => import('./terrainCarve')],
	['flattenActions', () => import('./flattenActions')],
	['hudViewportDrag', () => import('./hudViewportDrag')],
	['gamepadPrefs', () => import('./gamepadPrefs')],
	['charController', () => import('./charController')],
	['hudRichText', () => import('./hudRichText')],
	['moduleHudKinds', () => import('./moduleHudKinds')],
	['hudMinimap', () => import('./hudMinimap')],
	['hudArrange', () => import('./hudArrange')],
	['gamePresence', () => import('./gamePresence')],
	['levels', () => import('./levels')],
	['peerVars', () => import('./peerVars')],
	['projectManifest', () => import('./projectManifest')],
	['projectFile', () => import('./projectFile')],
	['transientObjects', () => import('./transientObjects')],
	['spawner', () => import('./spawner')],
	['triggerSync', () => import('./triggerSync')],
	['saveName', () => import('./saveName')],
	['sceneIdentity', () => import('./sceneIdentity')],
	['importDuplicates', () => import('./importDuplicates')],
	['peerScenes', () => import('./peerScenes')],
	['sharedLibrary', () => import('./sharedLibrary')],
	['transferLedger', () => import('./transferLedger')],
	['explorerView', () => import('./explorerView')],
	['filePreview', () => import('./filePreview')],
	['saveAs', () => import('./saveAs')],
	['windowTabs', () => import('./windowTabs')],
	['colocation', () => import('./colocation')],
	['colocationCalibrate', () => import('./colocationCalibrate')],
	['colocationPresence', () => import('./colocationPresence')],
	['xrAnchors', () => import('./xrAnchors')],
	['colocationAnchors', () => import('./colocationAnchors')],
	['colocationNudge', () => import('./colocationNudge')],
	['mountedVolumes', () => import('./mountedVolumes')],
	['storageUsage', () => import('./storageUsage')],
	['scenePrivacy', () => import('./scenePrivacy')],
	['touchControls', () => import('./touchControls')],
	['touchActions', () => import('./touchActions')],
	['touchSpec', () => import('./touchSpec')],
	['playMode', () => import('./playMode')],
	['arTable', () => import('./arTable')],
	// 60 Q1: Play here
	['playHere', () => import('./playHere')],
	// 60 Q5: reference image underlays
	['underlays', () => import('./underlays')],
	['underlayPose', () => import('./underlayPose')],
	// 36-export: the export builder, its stores, the export boot + runtime state
	['exportBuilder', () => import('./export/exportBuilder.js')],
	['exportStores', () => import('./export/exportStores.js')],
	// 41b: the burger's Project actions setting + Save options (H14), the settings-row fit (H12)
	['projectActions', () => import('./projectActions.js')],
	['saveOptions', () => import('./saveOptions.js')],
	// 42 I1: sticky panel headers
	['panelHeaderPrefs', () => import('./panelHeaderPrefs.js')],
	['rowFit', () => import('./ui/rowFit.js')],
	['exportBoot', () => import('./export/exportBoot.js')],
	['exportRuntime', () => import('./export/exportRuntime.js')],
	// 36-community (C4): the open scene's permanent game id
	['gameIdentity', () => import('./gameIdentity.js')],
	['gameSettings', () => import('./gameSettings')],
	['objectListNav', () => import('./objectListNav')],
	['inviteLinks', () => import('./inviteLinks')],
	['helperLayer', () => import('./helperLayer')],
	['explorerClipboard', () => import('./explorerClipboard')],
	['lookPresence', () => import('./lookPresence')],
	['postGraphs', () => import('./postGraphs')],
	['postGraphPresets', () => import('./postGraphPresets')],
	['materialSharing', () => import('./materialSharing')],
	['diagnostics', () => import('./diagnostics')],
	['wireValidate', () => import('./wireValidate')],
	['wireErrors', () => import('./wireErrors')],
	['safeStorage', () => import('./safeStorage')],
	['sceneBudget', () => import('./sceneBudget')],
	// 46 B1/B2: the budget chip + Statistics ▸ Budget (budgetTarget, sceneCost, sampleBudget, openBudget, TARGETS)
	['budgetMeter', () => import('./budgetMeter')],
	['budgetMeterCore', () => import('./budgetMeterCore')],
	['overloadGuard', () => import('./overloadGuard')],
	['qualityGovernor', () => import('./qualityGovernor')],
	['importBudget', () => import('./importBudget')],
	['importGate', () => import('./importGate')],
	['decimate', () => import('./decimate')],
	['playCursor', () => import('./playCursor')],
	['gameStorage', () => import('./gameStorage')],
	// 30b (vr-play): the game-feel leaves under ONE name
	['gameKit', () => import('./gameKit')],
	['moduleWorld', () => import('./moduleWorld')],
	['playSpawn', () => import('./playSpawn')],
	['packRefs', () => import('./packRefs')],
	// 36 U9: per-file load states + the placeholder renderer
	['loadStates', () => import('./loadStates')],
	['placeholders', () => import('./placeholders')],
	['replaceModel', () => import('./replaceModel')],
	['lod', () => import('./lod')],
	['gltfOptimize', () => import('./gltfOptimize.js')],
	['gltfLoader', () => import('./gltfLoader.js')],
	['ktx2Twins', () => import('./ktx2Twins.js')],
	['importOptimize', () => import('./importOptimize.js')],
	['lodGroup', () => import('./lodGroup')],
	['lodGroupCore', () => import('./lodGroupCore')],
	// 40 F14: the substitutes a fallback group draws
	['lodTrees', () => import('./lodTrees.js')],
	['lodGroupActions', () => import('./lodGroupActions')],
	['lodLevelEdit', () => import('./lodLevelEdit')],
	['packBehavior', () => import('./packBehavior')],
	// 37 R3: parametric architecture parts (archPartsDebug, reconcileArchParts)
	['arch', () => import('./arch/archParts.js')],
	['sceneLoader', () => import('./sceneLoader')],
	['pickCycle', () => import('./pickCycle')],
	['a11yAnnounce', () => import('./a11y/announce')],
	['pickPass', () => import('./pickPass')],
	['selectThrough', () => import('./selectThrough')],
	['vrGameInput', () => import('./vrGameInput')],
	// 36 L2: the scene start view + the camera hold (startViewDebug, releaseHold, backToStartView)
	['startView', () => import('./startView')],
	['sceneSwitch', () => import('./sceneSwitch')],
	['sceneScope', () => import('./sceneScope')],
	['kitInstancing', () => import('./kitInstancing')],
	['scriptSockets', () => import('./scriptSockets')],
	['scriptLint', () => import('./scriptLint')],
	['codeWorkspace', () => import('./codeWorkspace')],
	// 50 Y1/Y2: the shared code/text buffers
	['sharedText', () => import('./sharedText')],
	// 50-window (C1): the code workspace in its own browser window
	['codePopout', () => import('./codePopout')],
	// 70 W2-W5: pop-out windows (the live layout + the window host)
	['panelPlaces', () => import('./windows/panelPlaces.js')],
	['panelHost', () => import('./windows/panelHost.js')],
	['panelLayout', () => import('./windows/panelLayout.js')],
	['codeSidebars', () => import('./codeSidebars')],
	// 70 W1: files and folders from the Code tab (create / rename / move / delete, their undo)
	['codeFiles', () => import('./codeFiles')],
	['scriptAssets', () => import('./scriptAssets')],
	['codeTabs', () => import('./codeTabs')],
	['aiExtensions', () => import('./ai/aiExtensions')],
	['graphText', () => import('./graphText')],
	// 36 (G1): code <-> node (openCode seam, module source, fork) + the Main graph migration
	['codeOpen', () => import('./codeOpen')],
	['mainGraph', () => import('./mainGraph.js')],
	// 36 (U10, games-graphs): engine pieces, the behaviour runtime, authored-group sockets
	['engines', () => import('./behaviours/engines.js')],
	['groupReconcile', () => import('./groupReconcile.js')]
];

/** hooks published at runtime through registerDebugHook @type {Record<string, any>} */
const registered = {};

/** Publish `obj` on the debug hook as `__stores[name]` — now if the hook is installed, else when
 * it is. @param {string} name @param {any} obj */
export function registerDebugHook(name, obj) {
	registered[name] = obj;
	/** @type {any} */
	const w = typeof window !== 'undefined' ? window : null;
	if (w?.__stores) w.__stores[name] = obj;
}

/** Load every row and publish `window.__stores`. @returns {Promise<Record<string, any>>} */
export function installDebugHooks() {
	return Promise.all(DEBUG_HOOKS.map(([, load]) => load())).then((mods) => {
		/** @type {Record<string, any>} */
		const stores = {};
		DEBUG_HOOKS.forEach(([name], i) => {
			if (name === '*') Object.assign(stores, mods[i]);
		});
		DEBUG_HOOKS.forEach(([name], i) => {
			if (name !== '*') stores[name] = mods[i];
		});
		Object.assign(stores, registered);
		/** @type {any} */ (window).__stores = stores;
		return stores;
	});
}

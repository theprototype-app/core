// Module SDK — the ONE table the api object is assembled from (34 R4 / A1).
//
// Each row is a slice of `api` built by its own file in this folder. A NEW namespace or
// method group is a NEW FILE plus ONE row here — never another 200 lines in a shared file
// (moduleSDK.js used to be 2,300 lines that seven lanes edited at once). Row order is the
// api's key order. Every slice gets the same per-module context (sdk/context.js): the
// module id and name, `onDispose` (the teardown journal deactivateModule replays) and the
// few bits of state two slices share. Rules a slice keeps (unchanged from moduleSDK.js):
// heavy or cyclic edges stay DYNAMIC (`import('../x')`, or a primed ref in sdk/refs.js);
// every registration journals its undo through `onDispose`.
import { makeModuleContext } from './context.js';
import { sdkNodes } from './nodes.js';
import { sdkScene } from './scene.js';
import { sdkPlayer } from './player.js';
import { sdkNet } from './net.js';
import { sdkUi } from './ui.js';
import { sdkInput } from './input.js';
import { sdkPhysics } from './physics.js';
import { sdkFeel } from './feel.js';
import { sdkWorld } from './world.js';
import { sdkSound } from './sound.js';
import { sdkView } from './view.js';
import { sdkFlowTriggers, sdkFlow } from './flow.js';
import { sdkViewer } from './viewer.js';
import { sdkGame } from './game.js';
import { sdkStorage } from './storage.js';
import { sdkBehavior } from './behavior.js';
import { sdkQuality } from './quality.js';
import { sdkPeerVars } from './peerVars.js';
import { sdkPossess } from './possess.js';
import { sdkCore } from './core.js';
import { sdkBackends } from './backends.js';
import { sdkAudio } from './audio.js';
import { sdkPost } from './post.js';
import { sdkHud } from './hud.js';
import { sdkOwn } from './own.js';
import { sdkKit } from './kit.js';

/** The api, slice by slice, in key order. @type {[string, (ctx: import('./context.js').SdkContext) => object][]} */
export const SDK_TABLE = [
	['nodes', sdkNodes], // registerNodeGroup, registerEffect, registerValueNode, registerNodeDefs
	['scene', sdkScene], // registerPrimitive … onSceneClear, inScene, editorMode
	['player', sdkPlayer], // setSpawn, respawnPlayer, pointerRay
	['net', sdkNet], // onMessage, send, registerStateSync
	['ui', sdkUi], // registerMenu, *Toolbox, registerVRMenuEntry
	['input', sdkInput], // registerBindings, input, keyOf, letterOf, onInput, claim/releaseInput
	['physics', sdkPhysics], // api.physics
	['feel', sdkFeel], // haptic, hapticPattern, onHit, hitLog
	['world', sdkWorld], // locomotion, isVR, isPlaying, peerIds, peerNames, create, moveObject, flyTo
	['sound', sdkSound], // playSound, effects, announce, music
	['view', sdkView], // followCam, stopFollowCam, vrHand, vrPanel
	['flowTriggers', sdkFlowTriggers], // fireObjectClick, fireNodeTrigger
	['viewer', sdkViewer], // playerPosition, selectObject, selectedUuids
	['game', sdkGame], // api.game
	['storage', sdkStorage], // api.storage, lod
	['behavior', sdkBehavior], // api.behavior
	['quality', sdkQuality], // api.quality
	['peerVars', sdkPeerVars], // api.peerVars
	['flow', sdkFlow], // api.flow
	['possess', sdkPossess], // possess, releasePossess, possessModes
	['core', sdkCore], // selectedUuid, scene, objectsGroup, sceneAssets, peerId, toast, now, THREE, assetUrl
	['backends', sdkBackends], // registerUnwrapBackend, registerShaderBackend, registerAudioDevice
	['audio', sdkAudio], // api.audio
	['post', sdkPost], // registerPostEffect, registerPostBackend
	['hud', sdkHud], // api.hud, registerHudElement
	['kit', sdkKit], // api.kit (34 R2: the game kit, one namespace per piece)
	['own', sdkOwn] // onUnload, timers, listen, own (34 R6)
];

/** @param {string} moduleId @param {string} [moduleName] the DISPLAY name, needed while
 * register() runs: loadedModules is not appended until it RETURNS, so anything reading the
 * name from there during registration gets the raw id (which is how a module HUD kind was
 * filed under 'hudmod' instead of 'HUD extras'). */
export function makeApi(moduleId, moduleName = moduleId) {
	const ctx = makeModuleContext(moduleId, moduleName);
	/** @type {any} */
	const api = {};
	for (const [, slice] of SDK_TABLE) {
		// descriptors, not values: a slice may define a GETTER (possessModes), which a plain
		// spread / Object.assign would freeze into the value it had at register time
		Object.defineProperties(api, Object.getOwnPropertyDescriptors(slice(ctx)));
	}
	return api;
}

import Peer from 'peerjs';
import { backoffDelay } from '$lib/netBackoff';
import { sceneCommand, lockRestore, checkLocks, createObject, sendObjects, deleteObject, colorObject, createLoader, userData, handleDisconnected, specator, cameraSettings, objectParameters, applyClearScene } from './commandsHandler.svelte';
import { gateCreationBroadcast } from './objectPermissions';
import { createGeometry, createLight, createGroup, changeName, moveGeometry, lockGeometry, moveCamera } from '$lib/geometries.svelte';
import { sendNodes, applyNodesSnapshot, applyNodeSync, noteNodesSnapshot, forgetNodeSyncPeer, createFlowNode, moveFlowNode, updateFlowNodeData, deleteFlowNodes, createFlowEdge, deleteFlowEdges, applyFlowCursor } from '$lib/nodesHandler';
import { preloadSandboxFor } from '$lib/sandbox/preload.js';
import { applyGraphCreate, applyGraphDelete } from '$lib/flowGraphs';
import { applyNodeTrigger } from '$lib/flowRuntime';
import { applyBurst } from '$lib/particleRuntime';
import { applyNodeDef, applyNodeDefDelete, applyNodeDefsSnapshot, sendNodeDefs } from '$lib/customNodes';
import { applyRemoteDuplicate } from '$lib/objectActions';
import { applyVerts } from '$lib/meshEdit';
import { applyMeshGeo } from '$lib/faceEdit';
// UV3 texture paint: live stroke segments. Safe as a STATIC import — uvEditor
// registers no history kind at module eval and its own imports (faceEdit,
// materialsHandler, history) are already in this file's subtree.
import { applyUvPaint, applyUvPaintEnd } from '$lib/uvEditor';
import { applySplineEdit } from '$lib/splineTool';
import { initVoiceChat, attachVoiceToPeer, voicePeerConnected, releaseMic } from '$lib/voiceChat';
import { resolvePeerOptions, describePeerServer, peerServerStatus, parseInviteHash, decodeInviteServer, applyInviteServerOverride, inviteServerOverride } from '$lib/peerServer';
import { hideMyIp, applyHideMyIp, whenRelayReady, relayDialWait, RELAY_DIAL_FAILED } from '$lib/hideMyIp';
// 27-B/27-G integration: the RECOVERY story belongs in the copyable bundle, not in a
// console nobody reads. diagnostics.js is a zero-dependency leaf, so this closes no cycle.
import { log } from '$lib/diagnostics';
// 25-F: the join result (peerApproval is store-only, so a static edge closes no cycle)
import { isRefusal, noteSnapshotAsked } from '$lib/connectionState';
import { applyJoinRefusal } from '$lib/peerApproval';
// 55 A4: invite links — the host's check and the joiner's proof (store-only, no cycle)
// 55 A7/A8: the agent action log + where an agent looked (store-only)
import { applyAgentLog, applyAgentUndo, applyAgentView, dropAgentView, sendAgentLogTo } from '$lib/agentLog';
import { applyAgentChatMessage, sendAgentChatBacklogTo, agentChatPeerGone } from '$lib/agentChat'; // 56 C1
import { captureInviteHash, verifyInviteDial, joinerInviteMeta, dialingWithInvite, myKind, noteDialKind, noteJoinedVia, agentsAsGuests, isAgentSession } from '$lib/inviteStore';
import { applyKick, isBlocked, isHeldOut, resetModeration, blockReplay } from '$lib/peerModeration'; // 55 A9
import { notePeerFacts, notePeerActivity, dropPeerFacts, myDevice } from '$lib/peerFacts'; // 55 A9
import { sessionHost, markPeerJoined, resetSession, signalingRetry, noteSignalingRetry, clearSignalingRetry, noteApprovalStarted, clearApprovalStarted, approvalStartedAt, APPROVAL_WINDOW_MS, MAX_PENDING_APPROVALS, HARD_PEER_CAP, roomIsFull } from '$lib/connectionState';
import { canApply, getAuthProvider, dispatchCloudMessage, rolesInfo } from '$lib/cloudHooks';
// 27-A (audit H1): shape validation + per-peer failure counters. Both are LEAVES, so the
// dispatcher can reject a malformed message before any applier sees it.
import { validateWireMessage } from '$lib/wireValidate';
import { holdForWireBatch } from '$lib/wireBatch';
// 60 Q2: the fast movement channel (an unordered, unreliable second channel for pose streams)
import { tapAgentEdit } from '$lib/agentPresence';
import { createFastLinks, createStaleFilter, createKeyframer, stampPose, poseKey, fastChannelEnabled, setPoseTap, tapPose } from '$lib/fastChannel';
import { registerDebugHook } from '$lib/debugHooks';
import { routePerfLive, perfLivePeerGone } from '$lib/perf/liveWire.js'; // 34 PF: the live perf stream (an import-free leaf)
import { noteWireError } from '$lib/wireErrors';
import { composeAdmitNotice, shortPeer } from '$lib/admitNotice';
import { ICE_DROP_GRACE_MS, LINK_POLL_MS, strikesNeeded, quietPeerError, unavailablePeerId, consentCounters, linkSilence, keepPeerId, silenceCloseAllowed, meshHosts } from '$lib/peerDrop';
import { takeRejoin, rememberRejoin, settleRejoin, REJOIN_WINDOW_MS, REJOIN_DIAL_MS } from '$lib/rejoin'; // fix-agenttest 6
import { createDialBackQueue } from '$lib/dialBackQueue'; // scatter-sync: room edits held for an opening approval dial-back
import { noteWire } from '$lib/sceneBudget';
import { applyAnnotation, applyAnnotationsSnapshot, sendAnnotations } from '$lib/annotationsHandler';
import { applyPing } from '$lib/ping';
import { applyAssetFile, answerAssetRequest, applyAssetThumb, answerAssetThumbRequest, applyAssetStart, applyAssetChunk, applyAssetMissing } from '$lib/assetShare';
import { applyRemoteCameraPreview, clearPeerPreview, sendCameraPreviewState } from '$lib/cameraPreview';
// 21-F3: play-mode PRESENCE, the campreview shape — a tiny per-peer message, a reply
// riding the getmodulestate request, and a drop on disconnect (golden rule 3).
import { applyRemotePlayMode, dropPeerPlayMode, sendPlayModeState } from '$lib/gamePresence';
// P2: watch adopts the watched peer's LOOK STATE — the campreview shape, one row per peer
import { applyRemoteLookState, dropPeerLook, sendLookState } from '$lib/lookPresence';
// P2b: which SCENE each peer is standing in — the gamePresence shape exactly
import { applyRemotePeerScene, dropPeerScene, sendMySceneState, peerScenes, myScene, mySceneWire, amPrivate, privacySplit, elsewhereThan, sceneOfPeer, ROOM_SCOPED, canApplyByRoom, sameRoomOrUnknown, myRoomLabel, roomLabelOf } from '$lib/peerScenes';
// 21-G2: the project manifest — a latest-wins singleton like environment/scenephysics
import { applyRemoteManifest, sendProjectManifest } from '$lib/projectManifest';
// 21-G4: PEER-OWNED variables. The same three obligations as the mode above (dispatch,
// late-joiner reply, drop on disconnect) and a DIFFERENT lifetime on purpose — a row
// survives its owner leaving PLAY and is dropped only when they leave the SESSION.
import { applyRemotePeerVars, dropPeerVars, sendPeerVarsState } from '$lib/peerVars';
import { applyModuleMessage, moduleVersions, checkModuleVersions, checkPeerAppVersion, sendModuleStates, applyModuleStates } from '$lib/moduleSDK';
import { APP_VERSION, COMMIT_SHA } from '$lib/version.js';
import { applyLockRequest, applyUnlock, applyLockDenied } from '$lib/lockControl';
import { applyDrawLive, applyDrawEnd } from '$lib/drawMode';
import { applySimulate, physicsExternalMove, applyThrow, applyHit, simulating, simPaused } from '$lib/physics';
import { noteRemoteMove } from '$lib/moveSmoothing';
import { noteRemoteHit, endKnockPrediction } from '$lib/knock';
import { applyJointCreate, applyJointDelete, applyJointsSnapshot, sendJoints } from '$lib/joints';
import { applyAnimData, applyAnimPlay, applyAnimationsSnapshot, sendAnimations } from '$lib/animationPreview';
import { applyHandModel, handModelState, dropPeerHandModel } from '$lib/handModels';
import { applyRemoteEnvironment, environmentState, envPresetsState, applyRemoteEnvPresets, dropPeerEnvPresets } from '$lib/environment';
import { materialPresetsState, applyRemoteMaterialPresets, dropPeerMaterialPresets, answerMaterialPresetRequest, applyMaterialPresetPart } from '$lib/materialPresets'; // 37 R5, 48 F2
import { applyRemoteMusic, musicState } from '$lib/sceneMusic';
import { applyRemoteScenePhysics, scenePhysicsState } from '$lib/scenePhysics';
// CO1: where the physical room's origin sits in content coords. The scenephysics
// shape — one latest-wins singleton + a getroomanchor reply. The per-device ALIGNMENT
// that composes with it is deliberately not on the wire at all.
import { applyRoomAnchorRemote, sendRoomAnchor } from '$lib/colocation';
// CO5: which physical ROOM a peer is in, if any — the playmode shape (a tiny per-peer
// message, a reply riding getmodulestate, a drop at every disconnect site). Everything it
// drives is LOCAL receive-side filtering; nobody stops broadcasting because of it.
import { applyRemoteColocation, dropPeerColocation, sendColocationState } from '$lib/colocationPresence';
import { applyRemoteScenePost, scenePostStates, sendScenePost } from '$lib/scenePost';
// 23-A2: the musical transport (a latest-wins singleton like scenephysics) and the
// peer clock-offset estimate it carries alongside
import { applyRemoteTransport, transportState, sendTransport } from '$lib/musicClock';
// 25-E: the clock round trip is the SESSION's now, not the music line's (sessionClock.js)
import { answerClockPing, applyClockPong, startClockSync } from '$lib/clockSync';
import { sessionNow } from '$lib/sessionClock';
import { applyRemoteDeviceNote } from '$lib/audioDevices';
// 23-A4: the patch (cables between device ports), a latest-wins singleton
import { applyRemotePatch, patchState, sendPatch } from '$lib/audioPatch';
import { applyRemoteShaderGraph, applyRemoteShaderGraphDelete, applyRemoteShaderGraphs, sendShaderGraphs } from '$lib/shaderSync';
import {
	applyRemoteHud,
	applyRemoteHudDelete,
	applyRemoteHuds,
	sendHuds,
	applyRemoteHudValue,
	applyRemoteHudValues,
	sendHudValues
} from '$lib/hudSync';
import { applyRemoteGameState, sendGameState, gameStatePayload } from '$lib/gameSync';
import { applyGameVarOp } from '$lib/gameState';
// 60 Q5: shared reference images (a leaf: stores + idb)
import { applyRemoteUnderlay, applyRemoteUnderlayDelete, sendUnderlays, dropPeerUnderlays } from '$lib/underlays';
// 48 S2: sequences (Timeline) — scene data, latest-wins per sequence (sequenceSync.js)
import { applyRemoteSequence, applyRemoteSequenceDelete, applyRemoteSequences, sendSequences } from '$lib/sequenceSync';
// 50 Y1/Y2: shared text in the Code tab (Yjs, loaded lazily with the editor)
import { applyRemoteYText, applyRemoteYAwareness, answerYText } from '$lib/sharedText';
// 56 C10/C8: the scene's AI chats (.tpchat) + the pictures kept from them (store-only leaf)
import { applyRemoteTpchat, applyRemoteTpchatDelete, applyRemoteTpchats, applyRemoteChatRefs, sendTpchats } from '$lib/chat/tpchatStore.js';
// 34 R2 (T3): the game kit's document + requests (kit/runtime.js; a leaf-side module)
import { receiveKitMessage, kitPayload } from '$lib/kit/runtime.js';
import { kitEntityPayloads } from '$lib/kit/entityApp.js'; // 34 R2 (kit-entities)
// 34 R3 (D1): behaviours' replicated documents (behaviours/app.js)
import { receiveBehaviourMessage, behaviourPayloads } from '$lib/behaviours/app.js';
import { applyRemoteTriggers, sendTriggers } from '$lib/triggerSync';
import { applySessionProposal, applySessionAnswer, deferUntilShareChoice, localSceneCount, gateHolds, registerWorldStatePush, connectDecisionApplies, noteHandshakeDeferred } from '$lib/sessions';
import { applyRemoteGeometry } from '$lib/geometryEdit';
import { applyLightTarget } from '$lib/lightParams';
import { applyObjectFile } from '$lib/animatedImports';
import { applyRemoteBehavior } from '$lib/packBehavior';
import { sendArchBehaviorStates } from '$lib/arch/archParts.js';
import { lockedObjects, selectedObject, peerHands, objectsGroup, pokeScene, isVRMode } from '../stores/sceneStore';
import { addMessage, peers, userdata, pendingApprovals, waitingForApproval, showToast, showLastingToast, pushNotification, chatHistory, mergeChatHistory } from '../stores/appStore';
// 41 G21: the signaling link's ups and downs are a STATE on the Connect pill's dot, never toasts
import { GIVE_UP_ATTEMPTS } from '$lib/connectionStatus';
import { get } from 'svelte/store';
import { exportMode } from './export/exportBoot.js';

/** 55: the full-state requests an AGENT page leaves unanswered — every one whose reply is scene content
 * (see the dispatch gate). Not getasset/getproject/getchat/getmodulestate/getnodedefs: bytes, the manifest,
 * chat and module versions are not a world, and a getasset answer is how a scene's files reach the room. */
export const AGENT_UNANSWERED = new Set(['getobjects', 'getnodes', 'getjoints', 'getanim', 'getscenepost', 'gettransport', 'getpatch', 'getshadergraphs', 'gethuds', 'getseqs', 'gethudvalues', 'getgame', 'getunderlays', 'gettriggers', 'getannotations', 'getkitentities', 'getytext']);

/**
 * 36-export: the Peer an exported game holds — the same shape the rest of the app reads
 * (`id`, `open`, `connections`, `on`/`connect`/`call`/`destroy`…) with nothing behind it.
 * It never opens and never dials, so the app runs exactly as it does with signaling down.
 * @param {string} id @returns {any}
 */
export function offlinePeer(id) {
	const peer = {
		id,
		open: false,
		disconnected: true,
		destroyed: false,
		connections: {},
		on() {
			return peer;
		},
		off() {
			return peer;
		},
		once() {
			return peer;
		},
		removeAllListeners() {
			return peer;
		},
		connect() {
			return undefined;
		},
		call() {
			return undefined;
		},
		reconnect() {},
		disconnect() {},
		destroy() {
			peer.destroyed = true;
		},
		listAllPeers(/** @type {any} */ cb) {
			if (typeof cb === 'function') cb([]);
		}
	};
	return peer;
}

export function createPeer() {
	return 'xxxxx'.replace(/[xy]/g, function (c) {
		var r = (Math.random() * 16) | 0,
			v = c == 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

// B5: how long a freshly dialed conn may sit un-open before a re-entrant
// connectToPeer is allowed to close-and-redial it. WebRTC negotiation takes
// seconds (2-3s even on localhost, more over TURN), and the two ends fire
// 'open' at DIFFERENT times — the stress run caught a peer killing a conn the
// remote had already adopted as its send channel. Killing young conns is how
// mesh formation shredded itself above ~5 peers.
const DIAL_GRACE_MS = 10000;
/** test-health-1: what the reconnect window's FINAL verdict gives a dial still negotiating (either
 * direction). Longer than DIAL_GRACE_MS on purpose: a redial after a 5 s drop starts late (when the
 * signaling link returns) and measured ~12 s to open on a loaded box — the 10 s grace tore it down a
 * second before it opened (net-drop HARD). A teardown is the expensive mistake here. */
const VERDICT_GRACE_MS = 20000;
// 27-F: the SIGNALING schedule — 800ms doubling to a 8s ceiling, forever, +/-25% so a
// room full of tabs does not return in lockstep. Separate from the per-peer conn
// backoff below, which is bounded on purpose (a peer really can be gone).
const RETRY_BACKOFF = { base: 800, cap: 8000, max: Infinity, jitter: 0.25 };
// restoreConnection's own retry cadence (pre-existing 4s) — also used to spot
// a restore dial that is already in flight so parallel calls don't stack.
const RESTORE_RETRY_MS = 4000;

//Access locked objects
let locked = $state();
lockedObjects.subscribe(value => { locked = value });

//Access selected object
let selected = $state();
selectedObject.subscribe(value => { selected = value });

//Access userData
let users = $state();
userdata.subscribe(value => { users = value });


/** P2b: the only messages `broadcast` will withhold from a peer in another scene.
 * Pure presence, re-sent continuously, useless to somebody in a different world. */
const STREAM_TYPES = new Set(['camera', 'vrhands']);

/**
 * 25-F: what every dial carries. `jr: 1` says this build understands a join RESULT, which
 * is what lets a host send a refusal without an older joiner mistaking the refusal dial
 * for an approval (see `JOIN_RESULTS` in connectionState). `result` is set only by the
 * host's approve dial-back.
 * 29: `cloud` is a plugin's dial data (peerApproval.boundCloudMeta), never on a result dial.
 * @param {string} [result] @param {any} [cloud] @param {any} [extra] 55 A4: {invite, kind, invited}
 * @returns {{metadata: Record<string, any>}}
 */
function dialOptions(result, cloud, extra) {
	/** @type {Record<string, any>} */
	const metadata = result ? { jr: 1, joinresult: result } : { jr: 1 };
	// 29 (rooms access): a cloud plugin's own dial data — a knock's name, a room-code
	// proof — rides the join dial so the host's auth hook reads it BEFORE any data flows
	// (an unapproved conn is closed at once). Absent = the dial is byte-identical.
	if (cloud !== undefined && !result) metadata.cloud = cloud;
	// 55 A4: an invite proof (bound to both peer ids — never the token) and `kind: "agent"`
	// ride the join dial the same way; an approval dial-back says the role an invite carried.
	// Absent = byte-identical again.
	if (extra?.invite && !result) metadata.invite = extra.invite;
	if (extra?.kind && !result) metadata.kind = extra.kind;
	if (extra?.invited && result === 'approved') metadata.invited = extra.invited;
	return { metadata };
}


/**
 * 55 A4: the approval card's line for a dial whose invite did not check out. The joiner is
 * told nothing more than any other knock; the host sees why it was not automatic.
 * @param {string} reason @param {string} [kind]
 */
function inviteRefusalLabel(reason, kind) {
	const who = kind === 'agent' ? 'An AI agent' : 'Someone';
	const why =
		reason === 'expired' ? 'an expired invite'
		: reason === 'revoked' ? 'a revoked invite'
		: reason === 'used' ? 'an invite that was already used'
		: 'an invite this device cannot confirm';
	return who + ' came with ' + why + ' — approve to let them in';
}

/** How long a refusal dial may hang before it is closed regardless. The answer is in its
 * metadata, which the joiner has at its `connection` event — the conn never needs to
 * open, and a joiner that closes it at once is the normal case. */
const REFUSAL_DIAL_MS = 15000;

/**
 * 27-E: keep the pending queue bounded, dropping the EXPIRED first and only then the
 * oldest still-live request. A missed request is worse than a stale card, so nothing is
 * dropped while there is room — this only decides who goes when there is not.
 * @param {any[]} approvals @returns {any[]}
 */
function boundApprovals(approvals) {
	if (approvals.length <= MAX_PENDING_APPROVALS) return approvals;
	const started = get(approvalStartedAt);
	const age = (/** @type {any} */ a) => Date.now() - (started[a.peerId] ?? 0);
	const expired = approvals.filter((a) => age(a) > APPROVAL_WINDOW_MS).sort((a, b) => age(b) - age(a));
	const live = approvals.filter((a) => age(a) <= APPROVAL_WINDOW_MS).sort((a, b) => age(b) - age(a));
	const drop = new Set();
	for (const a of [...expired, ...live]) {
		if (approvals.length - drop.size <= MAX_PENDING_APPROVALS) break;
		drop.add(a.peerId);
	}
	for (const peerId of drop) clearApprovalStarted(peerId);
	return approvals.filter((a) => !drop.has(a.peerId));
}

export class PeerConnection {
	constructor(id, updateIdFn) {
		this.updateIdFn = updateIdFn;
		// fix-agenttest 6: a reload while joined comes back on the SAME id and dials the host
		// (rejoin.js); the host re-admits an id that left by unloading (unloadedPeers)
		const rejoin = takeRejoin();
		/** @type {string | null} */
		this.rejoinHost = rejoin?.host ?? null;
		/** @type {Map<string, number>} id -> when it said goodbye from a pagehide */
		this.unloadedPeers = new Map();
		this.myId = rejoin?.id ?? id;
		this.reconnectAttempts = 0;
		this.hasOpened = false;   // the signaling link has opened at least once
		this.didFallback = false; // we've already switched to the public cloud
		this.idRetries = 0;       // fresh-id attempts after an id collision (B5)
		this.serverErrorAt = 0;   // 24-D2: last signaling-level error (switchServer fails fast)
		// 44 L2: the servers THIS id has opened on (a key per server). An "ID is taken" there is our
		// own registration the server has not let go of yet — wait it out on the same id; anywhere
		// else it is somebody else's, take a fresh one. `hasOpened` cannot say this: a runtime
		// switch resets it, and the way BACK to the previous server then minted a new id.
		/** @type {Set<string>} */
		this.registeredOn = new Set();
		this.serverKey = '';
		this.freshIds = 0;        // fresh ids minted after a collision (bounded, like idRetries)
		this.switchSeq = 0;       // 44 L2: a newer switchServer supersedes an older one's ticks
		/** 44 L2: every pending reconnect/recreate timer — a rebuild cancels them all, since each
		 * was scheduled for a peer that no longer exists @type {Set<ReturnType<typeof setTimeout>>} */
		this.recreateTimers = new Set();

		/** @type {Record<string, any>} outgoing DataConnections, keyed by peer id */
		this.connections = {};
		/** @type {Set<string>} peers whose conn actually opened — so a conn that
		 * closes without ever opening (a failed connect) doesn't fire a spurious
		 * 'disconnected' teardown; the error handler already messaged the user */
		this.openedPeers = new Set();
		/** @type {Map<string, number>} peerId -> retry attempt while we redial a
		 * peer whose OPEN conn dropped without a goodbye. Teardown (and its
		 * toast) waits until the backoff exhausts; checkLocks keeps the peer's
		 * locks and roster entry alive for the window (B5, 172 deferred item 1) */
		this.reconnecting = new Map();
		// test-health-1: inbound dials from a peer in the reconnect window, while they negotiate
		// (the higher id only ever heals through one) — scheduleReconnect's final verdict waits
		// for them as it waits for its own dial
		/** @type {Map<string, any>} */
		this.inboundDials = new Map();
		/** @type {Set<string>} peers that ANNOUNCED they were leaving (the
		 * `disconnected` self-message) — their close is expected, don't redial */
		this.gracefulLeft = new Set();
		/** F-3: when a peer last left or dropped (or we left) — peer-level errors right after
		 * one are its symptoms, not news (peerDrop.quietPeerError) */
		this.lastLeaveAt = 0;
		/** F-3: peerId -> "not on the signaling server" answers while we redial them
		 * @type {Map<string, number>} */
		this.unavailableStrikes = new Map();
		/** F-3: peers whose link WE closed for ICE silence — one "not on the server" answer
		 * then ends the wait (peerDrop.strikesNeeded) @type {Set<string>} */
		this.silentDrops = new Set();
		/** fix-agenttest 4: peerId -> Date.now() of its `linkaway {hidden: true}` @type {Map<string, number>} */
		this.awayPeers = new Map();
		/** F-5: peers the host removed from an automatic admission — their re-dials are
		 * refused for the rest of this tab's session, guests setting or not @type {Set<string>} */
		this.removedPeers = new Set();
		/** @type {Set<string>} peers we mean to exchange FULL STATE with — the
		 * host we're joining (requestConnect) or a joiner we approved. Mesh-fill
		 * dials (the `hosts` flow) don't request state, and an adopted inbound
		 * conn requests it only when it stands in for one of these (B5) */
		this.wantsStateFrom = new Set();
		/** 25-F: peers whose NEXT dial is an approval dial-back, so its handshake opens with
		 * `joinresult: approved` @type {Set<string>} */
		this.approvedDialBacks = new Set();
		/** scatter-sync: room broadcasts HELD for a peer whose approval dial-back has not opened
		 * yet, flushed after its handshake (dialBackQueue.js says why) */
		this.dialBackQueue = createDialBackQueue();
		// 37 R1: peers that advertised `wb: 1` (the `modules` handshake) and so understand a
		// `{type:'batch'}` envelope; everyone else gets the envelope's items one by one
		/** @type {Set<string>} */
		this.wireBatchPeers = new Set();
		/** @type {Map<string, any>} 29 (rooms access): a cloud plugin's dial data per peer we
		 * are joining — read by every join dial and its restore re-dials (dialOptions) */
		this.dialCloud = new Map();
		/** 55 A4: joiners we admitted by invite → the role it carried (said on the dial-back) @type {Map<string, string>} */
		this.invitedRoles = new Map();
		/** 25-F: peers a refusal dial is out to — their `peer-unavailable` is not news @type {Set<string>} */
		this.refusalDials = new Set();
		// 60 Q2: the fast movement channel (fastChannel.js). `fastLinks` = one unreliable channel per
		// peer that advertised `fc: 1`; `staleFilter` drops a pose older than the newest applied from
		// its sender; `keyframer` re-sends a stream's last pose reliably once the stream goes quiet.
		this.fastLinks = createFastLinks();
		this.staleFilter = createStaleFilter();
		this.keyframer = createKeyframer((payload, peerIds) => this.sendReliableTo(payload, peerIds));
		registerDebugHook('fastChannel', {
			links: this.fastLinks,
			stale: this.staleFilter,
			keyframes: this.keyframer,
			enabled: fastChannelEnabled,
			isOpen: (/** @type {string} */ peerId) => this.fastLinks.isOpen(peerId),
			setPoseTap
		});

		// 55 A4: an invite link's `&invite=<token>` is read HERE, first, and consumed from the
		// URL at once (replaceState) — the token lives in inviteStore's memory, never in history.
		if (typeof location !== 'undefined' && location.hash) captureInviteHash(location.hash);

		// CN-3: an invite link can name the signaling world (#A1B2C~srv=…). 69 T8: it is
		// never switched to SILENTLY any more — a signaling server sees every peer's address
		// and relays how they connect, and a link is something anybody can send. A link that
		// names a server takes the hash whole (no auto-dial on our own server) and, once the
		// app is up, asks with the host named (inviteLinks.confirmInviteServer — the same
		// question a link pasted into a running tab gets). A link without one keeps the
		// auto-connect flow on the bare id.
		if (typeof location !== 'undefined' && location.hash.includes('~')) {
			const { peerId: hashPeer, srv } = parseInviteHash(location.hash);
			const ov = srv ? decodeInviteServer(srv) : null;
			if (ov && hashPeer) {
				location.hash = '';
				const self = this;
				setTimeout(() => {
					import('./inviteLinks.js').then((m) => m.confirmInviteServer(self, hashPeer.toLowerCase(), ov)).catch(() => {});
				}, 0);
			} else location.hash = hashPeer ? '#' + hashPeer : '';
		}

		// A non-production hostname (localhost etc.) means the local dev signaling
		// server; production consults the peer-server Settings (default self-hosted
		// with public fallback / user's custom server / public cloud).
		const isLocalDev = !/(\.io|\.app)$/i.test(location.hostname);

		const createPeerForMode = (/** @type {boolean} */ forcePublic) => {
			const { options, canFallback } = resolvePeerOptions({ isLocalDev, forcePublic });
			this.canFallback = canFallback;
			this.serverKey = options?.host ? `${options.host}:${options.port ?? ''}${options.path ?? ''}` : 'public';
			// Publish the resolved server for the Connect indicator (I5); carry the
			// fallback flag once we've switched to the public cloud.
			peerServerStatus.set({ ...describePeerServer({ isLocalDev, forcePublic }), didFallback: this.didFallback });
			// 36-export: an exported game is single-player and opens NO signaling socket — a stub
			// Peer that never opens (`connect()` answers undefined, which every dial site already
			// guards, the signaling-down rule), so `$peers.peer.id` and every send stay valid
			// net-drop-1: the id stays readable through a signaling drop (peerDrop.keepPeerId)
			this.peer = exportMode ? /** @type {Peer} */ (offlinePeer(this.myId)) : keepPeerId(new Peer(this.myId, options), this.myId);
			// 71 TR4: on the live Peer, so every rebuild (fallback, server switch) keeps it
			applyHideMyIp(this.peer);
		};

		// 27-F (audit H2): THE recreate ritual, in one place. Four callers had their own
		// copy of destroy -> createPeerForMode -> attachVoiceToPeer -> wire (the public
		// fallback, the runtime switchServer, the id-collision retry) and the fourth —
		// a peer whose link CLOSED — did not exist at all, which is why a closed peer
		// stayed dead: `reconnect()` cannot revive a spent Peer object.
		// 44 L2: a REPLACED peer is retired before it is destroyed, so the 'disconnected'/'close'
		// its destroy emits — and anything it emits later — is ignored by its own handlers (they
		// used to act on `this.peer`, i.e. on the rebuild that replaced it). Every timer scheduled
		// for an older peer is cancelled for the same reason: a burst of failures on a dead server
		// left 0.8-8 s timers that destroyed the way-back peer before it could open.
		/** @type {WeakSet<any>} */
		const retired = new WeakSet();
		const later = (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
			const t = setTimeout(() => {
				this.recreateTimers.delete(t);
				fn();
			}, ms);
			this.recreateTimers.add(t);
		};
		const cancelTimers = () => {
			for (const t of this.recreateTimers) clearTimeout(t);
			this.recreateTimers.clear();
		};
		// 44 L2: a rebuilt link that neither opens nor fails — no 'open', no 'error', no 'close' —
		// had nothing left to retry it (invite-link-live §7 sat 45 s+ at open/disconnected/destroyed
		// all false). Give a rebuilt peer the length of a switch to open, then rebuild it again on
		// the capped schedule. Rebuilds only: the boot peer keeps its old behaviour.
		const OPEN_WATCH_MS = 10000;
		let watchAttempt = 0;
		const watchOpen = (/** @type {any} */ p) => {
			if (exportMode) return;
			const wait = Math.max(OPEN_WATCH_MS, backoffDelay(++watchAttempt, RETRY_BACKOFF) ?? 8000);
			later(() => {
				if (p !== this.peer || retired.has(p) || p.open || p.destroyed || p.disconnected) return;
				log('warn', 'net', 'signaling link never opened — rebuilding', { id: p.id, after: wait });
				recreatePeer(this.didFallback);
			}, wait);
		};
		const recreatePeer = (/** @type {boolean} */ forcePublic) => {
			cancelTimers();
			const old = this.peer;
			if (old) retired.add(old);
			// test-health-1: rebuilding the SIGNALING link must not cut the PEER links. destroy() closes
			// every DataConnection the old Peer owns (peerjs _cleanup), and an open DataConnection needs
			// no server — so a reconnect that stalled (watchOpen, 10 s after a wifi drop) used to end
			// every live conn with it and push them all into the reconnect window. disconnect() drops the
			// server socket only ("does not close any active connections"); the old Peer is retired, so
			// none of its handlers act again. Nothing open to keep -> destroy, as before.
			const keepLinks = !!old && !old.destroyed && Object.values(this.connections).some((/** @type {any} */ c) => c?.open);
			try { if (keepLinks) old.disconnect(); else old.destroy(); } catch (e) { /* already gone */ }
			// …but only the OPEN links survive: a conn still negotiating needed the old socket for its
			// answer and candidates and can never finish now — close it exactly as destroy() did, so its
			// close runs the usual paths (reconnect window / mesh restore) instead of wedging
			if (keepLinks)
				for (const c of Object.values(this.connections))
					if (c && !(/** @type {any} */ (c).open)) try { /** @type {any} */ (c).close(); } catch (e) { /* never opened */ }
			createPeerForMode(!!forcePublic);
			attachVoiceToPeer(this); // rebind the incoming-call handler to the new peer
			wire();
			watchOpen(this.peer);
		};

		// The pinned self-hosted server never opened -> rebuild against the public
		// PeerJS cloud and re-wire. Default mode only; custom/public never fall back.
		const fallbackToPublic = () => {
			this.didFallback = true;
			this.canFallback = false;
			// 41 G21: a status the user did not ask about — the notification centre, not a toast
			// (the chevron's warn dot already says it while it lasts)
			pushNotification('Your peer server is unreachable — switched to the public PeerJS server.');
			recreatePeer(true);
		};

		// 24-D2: switch the signaling server at RUNTIME — fallbackToPublic generalised.
		// `override` is an invite pin ({forcePublic} | {custom:{host,port,path,secure}})
		// or null for "whatever Settings says" (the Apply button). Session-only, never
		// persisted (CN-3). A live mesh is LEFT first (never switch under one); the id
		// is kept (ids are per-server registrations, so the invite link the user copied
		// a minute ago still works if they come back). Resolves true once the new link
		// opens; on a server that never opens the previous override is restored AND the
		// peer is rebuilt on it, so the user is back where they were — a link-pinned
		// server must never fall back to public (CN-3), and "staying disconnected" on a
		// dead server would leave them with a reconnect loop and no way back but reload.
		const SWITCH_TIMEOUT_MS = 8000;
		/** @param {any} override @returns {Promise<boolean>} */
		this.switchServer = (override) => {
			const target = override || null;
			const label = target?.forcePublic
				? 'the public PeerJS cloud'
				: target?.custom?.host
					? target.custom.host + (target.custom.port && Number(target.custom.port) !== 443 ? ':' + target.custom.port : '')
					: 'the configured peer server';
			if (Object.keys(this.connections).length || this.openedPeers.size) this.leaveSession();
			const previous = inviteServerOverride();
			const rebuild = (/** @type {any} */ ov) => {
				applyInviteServerOverride(ov);
				this.didFallback = false;
				this.hasOpened = false;
				this.idRetries = 0;
				this.freshIds = 0;
				this.reconnectAttempts = 0;
				this.serverErrorAt = 0;
				recreatePeer(!!ov?.forcePublic);
			};
			const seq = ++this.switchSeq;
			watchAttempt = 0;
			rebuild(target);
			const pinned = !!(target && (target.forcePublic || target.custom?.host));
			return new Promise((resolve) => {
				const startedAt = Date.now();
				const tick = () => {
					// 44 L2: another switch started since — its own ticks own the outcome now
					if (seq !== this.switchSeq) {
						resolve(false);
						return;
					}
					if (this.peer?.open) {
						peers.update((value) => value);
						resolve(true);
						return;
					}
					// a network error with no fallback in play, or the clock: give up
					const failed = (this.serverErrorAt > startedAt && !this.canFallback) || Date.now() - startedAt > SWITCH_TIMEOUT_MS;
					if (!failed) {
						setTimeout(tick, 200);
						return;
					}
					if (pinned) {
						rebuild(previous);
						showToast('Could not reach ' + label + ' — back on your previous peer server.');
					} else {
						showToast('Could not reach ' + label + ' — check Settings ▸ Connection, or reload.');
					}
					peers.update((value) => value);
					resolve(false);
				};
				setTimeout(tick, 200);
			});
		};

		// 41 G21: a drop and its retries are the Connect dot's job (yellow, pulsing); past
		// GIVE_UP_ATTEMPTS the dot turns red and ONE notification-centre entry says so — once per
		// outage, never a toast (a phone tab switch drops the socket, and it used to say so three times)
		this.signalingNotified = false;
		const signalingDown = (/** @type {number} */ attempt) => {
			noteSignalingRetry(attempt);
			if (attempt >= GIVE_UP_ATTEMPTS && !this.signalingNotified) {
				this.signalingNotified = true;
				pushNotification("Can't reach the peer server — still retrying. Peers you are connected to are unaffected; check your connection or Settings ▸ Connection.");
			}
		};

		const wire = () => {
		// 44 L2: THIS peer — every handler below acts on it, and only while it is the live one
		const p = this.peer;
		const live = () => p === this.peer && !retired.has(p);
		p.on('open', (id) => {
			if (!live()) return;
			console.log(id);
			this.hasOpened = true;
			this.registeredOn.add(this.serverKey);
			watchAttempt = 0;
			// 41 G21: no "Reconnected" toast — the dot turning back says it
			clearSignalingRetry();
			this.signalingNotified = false;
			peers.update((value) => value); // the dot reads peer.open: tick the store
			this.reconnectAttempts = 0; // a fresh/re-established server link resets the backoff
			// test-health-1: the window's dials while the server was unreachable never left
			// (`peer.connect` is undefined with the link down) — redial NOW, not on the next
			// backoff tick, which can be the verdict-only one (a 5 s wifi drop: no dial until 7.5 s)
			// A dial still un-open at this moment was made while the link was down — its offer never
			// reached the server, yet it holds the slot until its DIAL_GRACE expires, and after a 5 s
			// drop that is past the window's last dial (net-drop HARD: the session tore down with one
			// such dial "negotiating" for 15 s). Replace it (delete first, so onConnClose ignores the
			// close of a conn we no longer hold).
			for (const peerId of this.reconnecting.keys()) {
				const stale = this.connections[peerId];
				if (stale && !stale.open) {
					delete this.connections[peerId];
					try { stale.close(); } catch (e) { /* never opened */ }
				}
				this.reconnectDial(peerId);
			}
			if (this.updateIdFn) this.updateIdFn(id);
			// fix-agenttest 6: the session this tab was in before its reload, dialled like an invite
			const rejoinHost = this.rejoinHost;
			this.rejoinHost = null;
			if (rejoinHost) later(() => settleRejoin('failed'), REJOIN_DIAL_MS);
			if (!rejoinHost && !window.location.hash.slice(1)) return;
			// 55: `#<id>&agent…` — the id is everything before the first `&` (parseInviteHash)
			let connect = rejoinHost ?? parseInviteHash(window.location.hash).peerId.toLocaleLowerCase()
			if (!connect) return;
			// Whitelist connection by adding to userdata
			let data = [connect, '', '']
			users.push(data);
			userdata.set(users);
			userdata.update((value) => value);
			// // Add peer to pending approvals
			let waiting = get(waitingForApproval);
			waiting.push([connect, 'pending']);
			waitingForApproval.set(waiting);
			waitingForApproval.update((value) => value);
			// // Initiate connection request to peer and await approval
			// 71 TR4: with Hide my IP on, this first dial waits for the plugin's relay credential
			if (get(hideMyIp)) whenRelayReady(p).then(() => this.connectToPeer(connect, true));
			else this.connectToPeer(connect, true);
			// 55: the invite key in the hash is consumed whatever was dialled (a rejoin leaves an empty hash alone)
			if (!rejoinHost || window.location.hash.slice(1)) window.location.hash = '';
		});

		// 27-F: a closed Peer is SPENT — `reconnect()` does nothing for it, which is why
		// this used to be a dead end with only a page reload out of it. Rebuild on the
		// SAME id (an id is a per-server registration, so the invite link a user copied
		// a minute ago still works when the link comes back).
		p.on('close', () => {
			if (!live()) return;
			log('error', 'net', 'signaling server closed');
			this.reconnectAttempts++;
			const delay = backoffDelay(this.reconnectAttempts, RETRY_BACKOFF) ?? 8000;
			signalingDown(this.reconnectAttempts);
			later(() => { if (live() && !p.open) recreatePeer(this.didFallback); }, delay);
		});

		// 27-F (audit H2): THE RETRY NEVER GIVES UP. It used to stop after five attempts
		// (~20 s) and tell the user to reload — but a reload drops every live
		// DataConnection AND the invite id, while the thing that failed is usually a lid
		// closing, a phone locking or a wifi hop. What protects the server is the CAPPED
		// interval (plus jitter, so N tabs dropped by one hop do not return in lockstep);
		// the attempt COUNT protected nobody. One toast on the way in, a CHIP for the
		// live state — an unbounded retry that toasts per attempt is spam.
		this.reconnectAttempts = 0;
		p.on('disconnected', () => {
			if (!live()) return;
			log('warn', 'net', 'signaling server disconnected');
			if (p.destroyed) return;
			this.reconnectAttempts++;
			const delay = backoffDelay(this.reconnectAttempts, RETRY_BACKOFF) ?? 8000;
			signalingDown(this.reconnectAttempts);
			later(() => {
				if (!live() || p.destroyed || !p.disconnected) return;
				p.reconnect();
				watchOpen(p); // a reconnect can stall exactly like a rebuild
			}, delay);
		});
		p.on('error', (err) => {
			if (!live()) return;
			log('error', 'net', 'peer error', { type: err?.type, error: String(err) });
			// Pinned self-hosted server never opened -> retry on the public cloud
			// (default mode only; custom/public keep canFallback false).
			if (!this.hasOpened && this.canFallback && !this.didFallback &&
				['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
				fallbackToPublic();
				return;
			}
			// 24-D2: a runtime switch waiting on `open` reads this to fail fast
			if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) this.serverErrorAt = Date.now();
			// B5: session ids are 5 hex chars = 20 bits, so a birthday collision is
			// likely well before a million concurrent sessions (~1k live ids gives a
			// ~40% chance of one). The id is generated fresh on every page load and
			// never persisted, so nothing is pinned to it before the link opens —
			// take a new one instead of making the user reload. Lengthening the id
			// was assumed to be a compat break; it isn't, but it also isn't needed.
			// 27-F: the SAME collision, met on a REBUILD. The branch below only covers the
			// first open, so a peer rebuilt after a close — while the server still holds the
			// old registration for a moment — fell through to "please reload", which is the
			// dead end this phase exists to remove. Wait out the registration and rebuild.
			// 44 L2: "ours" is decided by the SERVER this id opened on, not by `hasOpened` (see
			// registeredOn). Once the waits are spent, a fresh id beats "please reload".
			// fix-agenttest 6: so is the id a rejoin brought back from before the reload
			const ownHeld = this.registeredOn.has(this.serverKey) || !!this.rejoinHost;
			if (err.type === 'unavailable-id' && ownHeld && this.idRetries < 3) {
				this.idRetries++;
				const wait = backoffDelay(this.idRetries, RETRY_BACKOFF) ?? 8000;
				log('warn', 'net', 'id still held by the old registration — rebuilding', { wait });
				noteSignalingRetry(this.idRetries);
				later(() => { if (live() && !p.open) recreatePeer(this.didFallback); }, wait);
				return;
			}
			if (err.type === 'unavailable-id' && this.freshIds < 3) {
				this.freshIds++;
				this.idRetries++;
				this.registeredOn.clear(); // a fresh id is registered nowhere yet
				this.myId = createPeer();
				if (this.rejoinHost) { this.rejoinHost = null; settleRejoin('failed'); } // the host would not know a new id
				log('warn', 'net', 'session id collided — retrying', { id: this.myId });
				recreatePeer(this.didFallback);
				return;
			}
			if (err.type === 'peer-unavailable') {
				// 27-E: end the request this names. The pill used to sit on "Requesting"
				// beside this very toast, and the optimistic whitelist row never went away.
				const id = unavailablePeerId(err.message);
				settleRejoin('failed'); // fix-agenttest 6: the only dial a pending rejoin has is to its host
				// 25-F: a refusal to somebody who already gave up and left is not news
				if (id && this.refusalDials.has(id)) return;
				// F-3: a REDIAL of a peer that dropped — the server no longer holds them. Not
				// news either; a few answers in a row mean they are gone, so stop waiting.
				if (id && this.reconnecting.has(id)) {
					this.noteUnavailable(id);
					return;
				}
				if (id) import('$lib/peerApproval').then((m) => m.abandonOutboundRequest(id)).catch(() => {});
				showToast('Peer is unreachable. Check the ID and ask them to stay online.');
			} else if (err.type === 'unavailable-id') {
				showToast('Your session ID is already in use. Please reload the page.');
			} else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
				// 41 G21: no toast — a link that was up retries through 'disconnected'/'close' (the
				// dot pulses); one that NEVER opened has nothing else to say it, so it is failed
				if (!this.hasOpened) signalingDown(Math.max(GIVE_UP_ATTEMPTS, get(signalingRetry).attempt || 0));
			} else if (quietPeerError(err.type, { lastLeaveAt: this.lastLeaveAt, reconnecting: this.reconnecting.size, now: Date.now() })) {
				// F-3: the tail of a leave or a drop (late candidates for a closed link) — the
				// leave itself is what the user hears about
				log('info', 'net', 'peer error during a leave — not shown', { type: err.type });
			} else {
				showToast('Connection error: ' + err.type);
			}
		});

		p.on('connection', handleConnection.bind(this));
		};

		createPeerForMode(false);
		// 71 TR4: the Settings switch reaches the Peer at once; later connections use it
		hideMyIp.subscribe((on) => applyHideMyIp(this.peer, on));
		initVoiceChat(this);
		wire();

		// Courtesy goodbye on tab close / refresh (best-effort). Without it,
		// peers treat the close as a transient drop and spend the whole backoff
		// window redialing — and if the leaver's page is still open (leaveSession
		// keeps the peer registration so the invite id stays valid), every redial
		// would land there as a fresh approval request.
		if (typeof window !== 'undefined') {
			window.addEventListener('pagehide', () => {
				// fix-agenttest 6: joined as a guest → remember the session for a reload (rejoin.js);
				// `unload` tells the host this goodbye may come back on the same id
				const host = get(sessionHost);
				rememberRejoin(this.peer?.id, host && this.openedPeers.has(host) ? host : null);
				try { this.broadcast({ type: 'disconnected', peerId: this.peer.id, unload: true }); } catch (e) { /* going down anyway */ }
			});
			// 27-F: the two events that mean "there is a point in trying NOW" — a wifi hop
			// ends as `online`, a lid or a phone lock ends as `visible`. Both RESET the
			// schedule: the wait is there to be kind to a server that is down, not to a
			// link that has just come back.
			const retryNow = () => {
				if (!this.peer || this.peer.open) return;
				this.reconnectAttempts = 0;
				if (this.peer.destroyed) recreatePeer(this.didFallback);
				else if (this.peer.disconnected) this.peer.reconnect();
			};
			window.addEventListener('online', retryNow);
			document.addEventListener('visibilitychange', () => {
				// fix-agenttest 4: tell the peers BEFORE the tab is throttled, so they hold the link
				try { this.broadcast({ type: 'linkaway', hidden: document.hidden }); } catch (e) { /* no peers yet */ }
				if (!document.hidden) retryNow();
			});
		}

		// Wire the message dispatcher onto a connection. Historically only INBOUND
		// conns listened for data; with the adopted-inbound channel (see below) a
		// peer may send back over OUR outgoing conn, so those wire it too (P-A).
		this.wireData = handleData.bind(this);

		/** @this {any} @param {any} conn */
		function handleConnection(conn) {

			// 25-F: A REFUSAL DIAL. Its metadata IS the answer, so it is read here, before
			// anything below can treat an incoming conn from the host as the approval it
			// used to mean. Never whitelisted, never adopted, never wired — closed at once.
			if (isRefusal(conn?.metadata?.joinresult)) {
				const ended = applyJoinRefusal(conn.peer, conn.metadata.joinresult);
				log('info', 'net', 'join refused', { peer: conn.peer, result: conn.metadata.joinresult, ended });
				try { conn.close(); } catch {}
				return;
			}

			// 55 A9: a peer REMOVED AND BLOCKED from this session. Refused before anything
			// below can whitelist it (an auth provider's auto-admit included), and told so when
			// its dial can hear a join result — "You were removed from this session".
			if (isBlocked(conn.peer)) {
				log('info', 'net', 'blocked peer refused', { peer: conn.peer });
				if (conn?.metadata?.jr) this.sendJoinResult(conn.peer, 'removed');
				try { conn.close(); } catch {}
				return;
			}

			// Update approval status on expected connections
			let waiting = get(waitingForApproval);
			waiting.forEach(element => {
				if(element[0] === conn.peer) {
					// 27-E (audit M10): the row is REMOVED on approval, not mutated in place
					// with a discarded filter — the old shape grew one dead row per join for
					// the tab's lifetime, and mutating a store's array in place is how the
					// next reader gets a value nobody published.
					clearApprovalStarted(conn.peer);
					waitingForApproval.set(get(waitingForApproval).filter((/** @type {any} */ w) => w[0] !== conn.peer));
					element[1] = 'approved';

					// CN: OUR outbound request was approved — that peer is the session
					// host (first approval wins; null while hosting ourselves).
					if (!get(sessionHost)) sessionHost.set(conn.peer);
					settleRejoin('joined'); // fix-agenttest 6: no-op unless this was the reload's dial

					// Show approved toast message
					// 55 A4: an invite's dial-back says the role it carried — no approval happened
					const invited = conn?.metadata?.invited;
					if (invited || dialingWithInvite(conn.peer)) {
						showToast('Joined ' + String(element[0]).slice(0, 6).toUpperCase() + "'s session by invite" + (invited === 'edit' ? ' — you can edit.' : invited === 'view' ? ' — view-only.' : '.'));
					} else
					// with roles active (cloud), joiners default to view-only — say so + link docs
					if (get(rolesInfo)) {
						showToast(String(element[0]).slice(0, 6).toUpperCase() + ' approved your request. You joined with view-only access — an admin can grant edit access.', [{ label: 'Read more', action: () => { try { window.open('https://docs.theprototype.app', '_blank'); } catch {} } }]);
					} else {
						showToast(String(element[0]).slice(0, 6).toUpperCase() + ' has approved your connection request.');
					}
					// waitingForApproval.set(waiting);
					// waitingForApproval.update((value) => value);
				}
			})
			//Trigger reactivity to hide connnection request toast
			waitingForApproval.update((value) => value);

			// This block prevents unauthorized peers from accessing data
			const users = get(userdata);
			let found = users.some(element => element[0] === conn.peer);

			// M1b (open-core): a cloud auth provider may pre-approve a known /
			// authenticated peer, skipping the manual Approve. Default — no provider
			// — keeps the whitelist + approval flow byte-identical.
			/** 29: the approval card's plugin label ("Ada wants to join Amber Mesa") */
			let knockLabel = '';
			// 55 A4: what the dial says it is — self-declared, so it decides intent and what the
			// host SEES (the robot on the card), never what anybody may do
			const dialKind = conn?.metadata?.kind === 'agent' ? 'agent' : undefined;
			if (dialKind) noteDialKind(conn.peer, dialKind);
			// 55 owner finding 1(a): an AGENT page is never anybody's host — nothing auto-admits through it
			// (no invite check, no plugin admit). A mesh dial that beat the roster takes the ordinary card
			// path and is let in when the host's roster names it, as on any page.
			const agentPage = myKind() === 'agent';
			if (!found) {
				const auth = agentPage ? null : getAuthProvider();
				try {
					// 55 A4: AN INVITE FIRST. The proof is checked here, by the one peer holding the
					// key, before any plugin is asked: a valid one admits with the role the link
					// carries (the cloud roles plugin grants it from `inviteGrantFor`); an invalid one
					// is NEVER auto-admitted — the normal card, saying why, and the host decides.
					const inviteMeta = conn?.metadata?.invite;
					/** @type {any} */
					let invite = null;
					if (inviteMeta !== undefined && !agentPage) {
						invite = verifyInviteDial(conn.peer, inviteMeta, this.peer.id, { kind: dialKind });
						log('info', 'net', 'invite dial', { peer: conn.peer, ok: invite.ok, reason: invite.ok ? undefined : invite.reason });
						if (!invite.ok) knockLabel = inviteRefusalLabel(invite.reason, dialKind);
					}
					// 29 (rooms access): a provider with `decide(peerId, cloudMeta)` answers
					// 'admit' | 'deny' | {label} (knock). 'deny' refuses with no card — told to a
					// joiner that can hear it. Without `decide`, `authorize` as before.
					const cloudMeta = conn?.metadata?.cloud ?? null;
					// F-5: someone the host removed stays out (the setting would just let them back,
					// and so would an invite: a removal outranks the link they arrived with)
					if (this.removedPeers.has(conn.peer)) {
						if (conn?.metadata?.jr) this.sendJoinResult(conn.peer, 'denied');
						conn.close();
						return;
					}
					// fix-agenttest 6: a guest that RELOADED (its goodbye said `unload`) is back on the id
					// we approved a moment ago — re-admitted as the auto-approve below does, no new card
					const leftAt = this.unloadedPeers.get(conn.peer);
					this.unloadedPeers.delete(conn.peer);
					if (leftAt !== undefined && Date.now() - leftAt <= REJOIN_WINDOW_MS && !roomIsFull(this)) {
						found = true;
						const roster = /** @type {any[]} */ (get(userdata));
						if (!roster.some((/** @type {any} */ e) => e[0] === conn.peer))
							// 55 A7: an agent's row keeps saying so (slot 6), so no avatar is built
							userdata.set(/** @type {any} */ ([...roster, dialKind ? [conn.peer, '', '', null, null, null, { kind: dialKind }] : [conn.peer, '', '']]));
						// the HOST answers as an approval (roster + dial-back); a fellow guest just takes the
						// mesh link, as it would with the host's roster already in hand
						if (!get(sessionHost)) {
							this.send({ type: 'userdata', userdata: get(userdata) });
							this.approveDialBack(conn.peer);
						}
						log('info', 'net', 'a guest reloaded and is back on its id — re-admitted', { peer: conn.peer });
					}
					const verdict = found
						? undefined
						: invite
							? invite.ok ? 'admit' : { label: knockLabel }
							: auth && typeof auth.decide === 'function' ? auth.decide(conn.peer, cloudMeta, { kind: dialKind }) : undefined;
					if (verdict === 'deny') {
						if (conn?.metadata?.jr) this.sendJoinResult(conn.peer, 'denied');
						conn.close();
						return;
					}
					if (verdict && typeof verdict === 'object' && verdict.label) knockLabel = String(verdict.label).slice(0, 120);
					let authorized =
						!found &&
						(verdict !== undefined
							? verdict === 'admit'
							: !!auth && typeof auth.authorize === 'function' && auth.authorize(conn.peer));
					// 55 A4: AGENTS NEVER RIDE THE GUEST AUTO-ADMIT. A plugin's admit (guests join
					// automatically, a room code) becomes the card for a dial that says it is an agent,
					// unless the host ticked "Let AI agents join as guests". Only an invite skips it.
					if (authorized && !invite && dialKind === 'agent' && !get(agentsAsGuests)) {
						authorized = false;
						knockLabel = knockLabel || 'An AI agent wants to join (guests join automatically, but AI agents ask first)';
					}
					if (authorized) {
						// the OSS build has no roles: an invite simply admits, and everyone edits
						if (invite?.ok) this.invitedRoles.set(conn.peer, get(rolesInfo) ? invite.role : 'edit');
						noteJoinedVia(conn.peer, invite?.ok ? 'invite' : 'guest');
					}
					if (authorized && roomIsFull(this) && conn?.metadata?.jr) {
						// 25-F: a plugin would let them in, but the mesh cannot take one more —
						// say so rather than auto-approving past the hard cap
						this.sendJoinResult(conn.peer, 'full');
						conn.close();
						return;
					} else if (authorized) {
						found = true;
						// AUTO-APPROVE == the manual Approve: whitelist the peer, broadcast the
						// roster, and DIAL BACK. The joiner only leaves its "waiting for
						// approval" state on an INCOMING connection from us, so without the
						// dial-back it waits forever (the autoaccept join bug).
						const roster = /** @type {any[]} */ (get(userdata));
						if (!roster.some((/** @type {any} */ e) => e[0] === conn.peer)) {
							// 55 A7: an agent's row says so from the start (slot 6), so no avatar is built
							roster.push(dialKind ? [conn.peer, '', '', null, null, null, { kind: dialKind }] : [conn.peer, '', '']);
							userdata.set(roster);
						}
						get(peers).send({ type: 'userdata', userdata: get(userdata) });
						this.approveDialBack(conn.peer);
						this.announceAutoAdmit(conn.peer, auth, cloudMeta, invite?.ok ? invite.role : undefined);
					}
				} catch (e) {
					console.error('cloud auth provider threw:', e);
				}
			}

			if (!found) {
				// If peer is not found, add it to the pending approvals
				var approvals = get(pendingApprovals);
				// 25-F: remember whether this dial can HEAR a refusal (see denyPeer). A re-dial
				// refreshes the answer on the card that is already there.
				const hearsNo = !!conn?.metadata?.jr;
				const known = approvals.find(toast => toast.peerId === conn.peer);
				if (known && (known.hearsNo !== hearsNo || (knockLabel && known.label !== knockLabel) || (dialKind && known.kind !== dialKind))) {
					pendingApprovals.set(/** @type {any} */ (approvals.map((/** @type {any} */ a) => (a.peerId === conn.peer ? { ...a, hearsNo, ...(knockLabel ? { label: knockLabel } : {}), ...(dialKind ? { kind: dialKind } : {}) } : a))));
				}
				if (!known) {
					// 55 A4: the card carries the dial's kind (the robot badge)
					/** @type {any} */
					const card = knockLabel ? { peerId: conn.peer, hearsNo, label: knockLabel } : { peerId: conn.peer, hearsNo };
					if (dialKind) card.kind = dialKind;
					approvals.push(card);
					// 27-E: stamp the SAME clock the joiner's countdown uses, so the card's
					// age and their pill agree; and BOUND the queue — a host who walked away
					// used to collect a card per dial with nothing dropping them (audit H3).
					noteApprovalStarted(conn.peer);
					pendingApprovals.set(boundApprovals(approvals));
				}
				conn.close();
			}

			// test-health-1: an inbound redial from a peer we are waiting for is a heal in progress
			if (this.reconnecting.has(conn.peer)) {
				/** @type {any} */ (conn).__dialedAt = Date.now();
				this.inboundDials.set(conn.peer, conn);
			}

			// ADOPT an open inbound conn as our send channel when our outgoing one
			// is dead (P-A find): the host closes the joiner's original conn before
			// approving, the close is often never signaled, and the fresh reopen can
			// wedge mid-ICE — leaving the JOINER unable to send ANYTHING to the host.
			// DataConnections are bidirectional, and this one is provably alive.
			conn.on('open', () => {
				const existing = this.connections[conn.peer];
				if (existing?.open) return; // stable outgoing conn stays preferred
				log('warn', 'net', 'adopting inbound connection as the send channel', { peer: conn.peer });
				if (existing) { try { existing.close(); } catch {} }
				this.connections[conn.peer] = conn;
				conn.on('close', () => this.onConnClose(conn.peer, conn));
				this.openedPeers.add(conn.peer);
				markPeerJoined(conn.peer);
				peers.update((value) => value);
				// the adopted conn stands in for OUR dead outgoing dial, so it asks
				// for full state only when that dial would have: a join/approve
				// relationship, or a reconnect resyncing what the blip dropped. A
				// mesh-fill adoption asking a JOINER for its objects was pure
				// duplication — and could pop a bogus share-or-stash prompt (B5).
				const healing = this.reconnecting.has(conn.peer);
				const wantState = this.wantsStateFrom.has(conn.peer) || healing;
				this.sendHandshake(conn, conn.peer, wantState, this.peer.id, { heal: healing });
			});

			this.wireData(conn);
		}

		/** @this {any} @param {any} conn */
		function handleData(conn) {
			// 27-A: a conn reports its OWN failures now. eventemitter3 swallows an 'error'
			// nobody listens for, so a send to a half-open conn and a failed negotiation were
			// both invisible. This is the one function every creation site already calls —
			// the four dials and the adopted inbound conn — so one listener pair covers all.
			conn.on('error', (/** @type {any} */ err) => noteWireError(conn.peer, 'conn-error', err?.type ?? err));
			// F-3: a peer that died without closing its channel (a killed process, a crashed tab)
			// leaves the conn "open" — a ghost in Users. Two watches close it ourselves, and the
			// close runs the ordinary reconnect window, which redials a live peer and drops a gone
			// one: ICE held `disconnected` past the grace (ICE took ~15 s to say so in the crash
			// probe), and the selected pair's consent checks going unanswered (peerDrop.linkSilence).
			/** @type {ReturnType<typeof setTimeout> | null} */
			let iceDropTimer = null;
			/** @type {ReturnType<typeof setInterval> | null} */
			let silenceTimer = null;
			const closeSilent = (/** @type {string} */ why) => {
				if (!conn.open) return;
				// fix-agenttest 4: a peer that told us its page went hidden (a phone in the background)
				// keeps its link through the grace; the poll comes back and closes it after that
				if (!silenceCloseAllowed(this.awayPeers.get(conn.peer), Date.now())) return;
				log('warn', 'net', 'link silent — closing it so the peer is redialled or dropped', { peer: conn.peer, why });
				this.silentDrops.add(conn.peer);
				try { conn.close(); } catch (e) { /* already dead */ }
			};
			conn.on('iceStateChanged', (/** @type {any} */ state) => {
				if (state === 'failed' || state === 'closed') noteWireError(conn.peer, 'ice-' + state);
				if (state === 'disconnected') {
					if (iceDropTimer) clearTimeout(iceDropTimer);
					iceDropTimer = setTimeout(() => {
						iceDropTimer = null;
						if (conn.peerConnection?.iceConnectionState === 'disconnected') closeSilent('ice-disconnected');
					}, ICE_DROP_GRACE_MS);
				} else if (iceDropTimer) {
					clearTimeout(iceDropTimer);
					iceDropTimer = null;
				}
			});
			const watchSilence = () => {
				if (silenceTimer) return;
				/** @type {any} */
				let seen = null;
				silenceTimer = setInterval(async () => {
					const pc = conn.peerConnection;
					if (!conn.open || !pc || typeof pc.getStats !== 'function') return;
					try {
						const verdict = linkSilence(seen, consentCounters(await pc.getStats()), Date.now());
						seen = verdict.state;
						if (verdict.silent) closeSilent('consent-unanswered');
					} catch (e) { /* stats unavailable: the ICE watch still stands */ }
				}, LINK_POLL_MS);
			};
			if (conn.open) watchSilence();
			conn.on('open', watchSilence);
			conn.on('close', () => {
				if (iceDropTimer) clearTimeout(iceDropTimer);
				if (silenceTimer) clearInterval(silenceTimer);
				silenceTimer = null;
			});
			// The dispatch chain itself, called from the guarded handler below. Naming it is
			// what lets a try/catch wrap 440 lines without re-indenting any of them.
			const dispatch = (/** @type {any} */ data) => {
				// M1a (open-core): the ONE receive-side capability gate. Default allows
				// everything (byte-identical OSS behavior); a cloud plugin's provider
				// drops disallowed message types from a peer (e.g. a viewer's mutations).
				if (data && !canApply(conn.peer, data.type)) return;
				// A2: the ROOM gate. A message describing the content of a scene is not
				// applied when its sender is demonstrably standing in a different one.
				//
				// The SEND side (`broadcast`) already withholds these, so in a mesh of
				// current builds this is the backstop rather than the mechanism - and a
				// backstop is exactly what a destructive message deserves: a `clearscene`
				// from an older peer, or from one whose row we have not yet seen move,
				// would otherwise wipe a world its author is not looking at.
				//
				// Conservative by construction (`canApplyByRoom` -> `elsewhereThan`): an
				// absent row, or an empty scene on either side, APPLIES. That is today's
				// behaviour byte for byte.
				if (data && !canApplyByRoom(conn.peer, data.type)) return;
				// R22 round 32: THE SHARE-OR-STASH ASK IS SYMMETRIC NOW. It only ever gated
				// what we SEND, so while our own question sat on screen the other side could
				// answer Share (or arrive with a latched verdict) and pour its world into ours
				// — the merge happening before the person was asked to consent to it. A peer
				// queued behind our gate is withheld exactly as `canApplyByRoom` withholds a
				// peer standing elsewhere. Nothing is lost: answering re-requests full state
				// from every queued sender (`resolveGate`), and Stay means it never lands.
				//
				// The get* REQUESTS are not in ROOM_SCOPED, deliberately — they are the gate's
				// own queue mechanism, and dropping them would strand both sides in silence.
				if (data && ROOM_SCOPED.has(data.type) && gateHolds(conn.peer)) return;
				// 55 (41's P0 on preview-55): AN AGENT PAGE IS NEVER A SOURCE OF WORLD. It works in the host's
				// scene and takes the host's scene; it answers no full-state request, so a host walking into a
				// new or another scene cannot be handed the agent's old world (the reported silent merge: the
				// host opened an empty scene, the agent followed and answered its re-sync with 8 old objects and
				// their flows). Its live edits still broadcast as they happen; requests are just unanswered —
				// the Stay shape, which every requester already handles (a later joiner gets the host's reply).
				if (data && AGENT_UNANSWERED.has(data.type) && myKind() === 'agent') return;
				// 55 A9: who did what, for the peer menu's "Show their recent changes" (LOCAL,
				// past every gate — only what was actually applied here is recorded)
				notePeerActivity(conn.peer, data);
				// 74 VH3: an applied edit from an AI agent moves its presence marker (nothing new on the wire)
				tapAgentEdit(conn.peer, data);
				// console.log(data);
				if(data.type == 'cloud') {
					// open-core (M1): the cloud plugin's own replicated channel
					dispatchCloudMessage(conn.peer, data.payload);
				} else if(data.type == 'batch') {
					// 37 R1: ONE multi-object edit (wireBatch.js). Every item goes back through
					// the WHOLE chain — the shape table, canApply, the room and share-or-stash
					// gates — exactly as if it had arrived alone, so an envelope can never carry
					// what its items could not. Envelopes do not nest.
					for (const item of data.items) {
						if (!item || typeof item !== 'object' || item.type === 'batch') {
							noteWireError(conn.peer, 'shape', 'batch-item');
							continue;
						}
						if (!validateWireMessage(item)) {
							noteWireError(conn.peer, 'invalid:' + item.type);
							continue;
						}
						if (!this.staleFilter.accept(conn.peer, item)) continue; // 60 Q2, as for a bare message
						try {
							dispatch(item);
						} catch (error) {
							noteWireError(conn.peer, item.type, error);
						}
					}
				} else if(data.type == 'hosts') {
					console.log('Connecting to received hosts');
					data.hosts.forEach( id =>
					{
						// 27-E (audit L7): a joiner must not fill the mesh past the cap the
						// approving side is enforcing, or the room grows by the back door.
						// Counted off the OPEN connections, never `userdata` — that roster is
						// the whitelist, written at dial time, so it counts people who were
						// invited and never arrived.
						if (roomIsFull(this)) return;
						// 55 A9: never fill the mesh back in with a peer just removed / blocked
						// (a `hosts` list from a peer that had not heard the kick yet);
						// F-5: nor with someone this host removed from an automatic admission
						if (isHeldOut(id) || this.removedPeers.has(id)) return;
						// mesh fill: connect, but DON'T request full state — the scene
						// is one shared state and we already pull it from the peer we
						// joined. Requesting it from everyone made a joiner download
						// N-1 copies of the same scene (measured 3x at N=4), and the
						// mirror-image requests hit every existing peer too (B5).
						this.connectToPeer(id, false);
					}
					);
				} else if(data.type == 'sent') {
					// 37 R15: `id` + `at` are additive (an older peer sends neither; addMessage mints)
					addMessage({message: data.message, type: 'received', sender: data.sender, id: data.id, at: data.at});
				} else if(data.type == 'getchat') {
					// 37 R15: a joiner's chat history. MESH-WIDE like chat itself (never room-gated)
					// and answered over the stable channel; empty history = no reply at all.
					const history = chatHistory();
					const back = this.connections[conn.peer] ?? conn;
					if (history.length && back?.open) back.send({type: 'chathistory', messages: history});
				} else if(data.type == 'chathistory') {
					mergeChatHistory(data.messages);
				} else if(data.type == 'info') {
					addMessage({message: data.message, type: data.type, sender: data.sender});
				} else if(data.type == 'create') {
					createGeometry(data.command, data.uuid);
				} else if(data.type == 'light') {
					createLight(data.command, data.uuid);
				} else if(data.type == 'group') {
					// `override` (R22 round 32) rides an ARRIVAL HEAL only — see sendObject
					createGroup(data.command, data.uuid, data.group, data.name, data.groupparent, data.pos, data.rot, data.scale, data.override);
					// 23-C1 fix: the late-joiner group message may carry userData (a device's
					// document rides there); merge it onto the group just made
					if (data.userData && typeof data.userData === 'object' && data.uuid) {
						const made = get(objectsGroup)?.getObjectByProperty('uuid', data.uuid);
						if (made) {
							made.userData = { ...made.userData, ...data.userData };
							pokeScene();
						}
					}
				} else if(data.type == 'name') {
					changeName(data.uuid, data.name);
				} else if(data.type == 'move') {
					// the pose BEFORE the write, so a remote physics stream can be eased
					// across rather than stepped through (moveSmoothing; ~10 Hz on the wire
					// looked like 10 fps on the watching peer)
					// 24-A A1: authority has spoken for this body, so a knock prediction of
					// ours ends HERE — before the pose below is captured, so the ease starts
					// from where the prediction left the object, not from where the hit found it
					endKnockPrediction(data.uuid);
					const movedObject = get(objectsGroup)?.getObjectByProperty('uuid', data.uuid);
					const movedFrom = movedObject
						? { pos: movedObject.position.clone(), quat: movedObject.quaternion.clone() }
						: null;
					moveGeometry(data.uuid, data.pos, data.rot, data.scale);
					if (movedFrom) noteRemoteMove(data.uuid, movedObject, movedFrom);
					// P-A: mid-sim, a peer's move stream on a dynamic body becomes a
					// kinematic hold (drops back to dynamic after 250ms of silence).
					// B5: the sending peer is the CLAIM, so two carry streams cannot
					// fight over one crate.
					physicsExternalMove(data.uuid, conn.peer);
				} else if(data.type == 'throw') {
					// B5: a peer's EXACT release. Initiator-only, never re-broadcast —
					// the flight itself replicates through the existing move stream.
					applyThrow(data);
				} else if(data.type == 'hit') {
					// 24-A A1: a peer's hand (or head) KNOCKED a body — the throw's sibling.
					// The initiator puts the velocity into the body (clamped again, never
					// re-broadcast: the flight rides the move stream); EVERY peer logs it,
					// stamped with the connection's peer, never the payload's. CONTENT, so it
					// is gateable by canApply like `throw` and ROOM_SCOPED like `move`.
					applyHit(data);
					noteRemoteHit(data, conn.peer);
				} else if(data.type == 'simulate') {
					applySimulate(data);
				} else if(data.type == 'jointcreate') {
					applyJointCreate(data);
				} else if(data.type == 'jointdelete') {
					applyJointDelete(data);
				} else if(data.type == 'joints') {
					applyJointsSnapshot(data.joints);
				} else if(data.type == 'getjoints') {
					// A2: a full-state REPLY is scene CONTENT, so it goes only to somebody in
					// our room. The REQUEST above stays ungated (asking is never the harm) -
					// the same line `canApply`'s ALWAYS_ALLOWED floor draws.
					if (sameRoomOrUnknown(conn.peer)) sendJoints(data.sender);
				} else if(data.type == 'animdata') {
					// 17-E: authored keyframes, latest-wins per object
					applyAnimData(data);
				} else if(data.type == 'animplay') {
					// transport only — the pose comes from evaluating the keys on the
					// synced clock, never off the wire
					applyAnimPlay(data);
				} else if(data.type == 'animations') {
					applyAnimationsSnapshot(data);
				} else if(data.type == 'getanim') {
					if (sameRoomOrUnknown(conn.peer)) sendAnimations(data.sender);
					// 37 R3: procedural doors have no objectfile to carry their open/shut state
					if (sameRoomOrUnknown(conn.peer)) sendArchBehaviorStates(conn);
				} else if(data.type == 'handmodel') {
					applyHandModel(data);
				} else if(data.type == 'environment') {
					applyRemoteEnvironment(data);
				} else if(data.type == 'music') {
					applyRemoteMusic(data);
				} else if(data.type == 'scenephysics') {
					applyRemoteScenePhysics(data);
				} else if(data.type == 'roomanchor') {
					// CO1: the room anchor, latest-wins on `at`. Applying it never re-poses
					// the rig here — a peer that is not colocated has no alignment to
					// compose it with, and one that is re-composes on its own next apply.
					applyRoomAnchorRemote(data);
				} else if(data.type == 'getroomanchor') {
					sendRoomAnchor(data.sender);
				} else if(data.type == 'manifest') {
					// 21-G2: the project manifest, latest-wins on changedAt
					applyRemoteManifest(data);
				} else if(data.type == 'getproject') {
					sendProjectManifest(data.sender);
				} else if(data.type == 'scenepost') {
					// L1/L2: the authored post stack, latest-wins on changedAt. An effect
					// KIND we don't know is kept and skipped at render time, never dropped.
					applyRemoteScenePost(data);
				} else if(data.type == 'getscenepost') {
					if (sameRoomOrUnknown(conn.peer)) sendScenePost(data.sender);
				} else if(data.type == 'transport') {
					// 23-A2: the musical transport, latest-wins on changedAt (the scenephysics
					// shape). Every peer then derives the beat LOCALLY from the shared startedAt.
					applyRemoteTransport(data);
				} else if(data.type == 'gettransport') {
					// the room gate every full-state reply here takes: a peer standing in
					// another scene must not be handed this one's tempo
					if (sameRoomOrUnknown(conn.peer)) sendTransport(data.sender);
				} else if(data.type == 'kick') {
					// 55 A9: remove (and block / allow back) a peer. The SENDER is checked
					// receive-side (session host, or an admin under roles); every entitled
					// receiver closes its own connection to that peer — see peerModeration.
					const verdict = applyKick(data, conn.peer, this);
					if (verdict === 'ignore') log('warn', 'net', 'kick ignored', { from: conn.peer, peer: data?.peer });
				} else if(data.type == 'joinresult') {
					// 25-F: the answer to our join request as a MESSAGE. A refusal normally
					// arrives as dial metadata and never reaches here; this path is the same
					// answer from a sender that has an open conn to say it on. 'approved' needs
					// nothing — the conn it arrived on already approved us (handleConnection).
					if (isRefusal(data.result)) applyJoinRefusal(conn.peer, data.result);
				} else if(data.type == 'clockping') {
					// 23-A2: the peer clock-offset round trip. Answered over the stable OUTGOING
					// conn to the sender (golden rule 9), this conn only as the fallback. 25-E:
					// the pong now also says which clock WE keep, so a joiner of a joiner
					// inherits the session's time (clockSync.js).
					answerClockPing(data, conn);
				} else if(data.type == 'clockpong') {
					applyClockPong(data);
				} else if(data.type == 'patch') {
					// 23-A4: the routing document, latest-wins on changedAt. Orphan cables ride
					// along and simply do not route until their object exists here.
					applyRemotePatch(data);
				} else if(data.type == 'getpatch') {
					if (sameRoomOrUnknown(conn.peer)) sendPatch(data.sender);
				} else if(data.type == 'devicenote') {
					// 23-A3: a note on a device object, stamped on the sender's wall clock and
					// synthesized HERE (the deterministic-events model, golden rule 8)
					applyRemoteDeviceNote(data);
				} else if(data.type == 'shadergraph') {
					applyRemoteShaderGraph(data);
				} else if(data.type == 'shadergraphdelete') {
					applyRemoteShaderGraphDelete(data);
				} else if(data.type == 'shadergraphs') {
					applyRemoteShaderGraphs(data);
				} else if(data.type == 'getshadergraphs') {
					if (sameRoomOrUnknown(conn.peer)) sendShaderGraphs(data.sender);
				} else if(data.type == 'hud') {
					// A2: the authored HUD document, latest-wins on changedAt. An element KIND
					// we don't know is kept and skipped at render, never dropped. The RUNTIME
					// half is derived from the replicated flow graph and never sent.
					applyRemoteHud(data);
				} else if(data.type == 'huddelete') {
					applyRemoteHudDelete(data);
				} else if(data.type == 'huds') {
					preloadSandboxFor(data);
					applyRemoteHuds(data);
				} else if(data.type == 'gethuds') {
					if (sameRoomOrUnknown(conn.peer)) sendHuds(data.sender);
				} else if(data.type == 'seq') {
					// 48 S2: one authored sequence, latest-wins on changedAt. Playback sends
					// nothing: every peer plays from the replicated trigger stamp itself.
					applyRemoteSequence(data);
				} else if(data.type == 'seqdelete') {
					applyRemoteSequenceDelete(data);
				} else if(data.type == 'seqs') {
					applyRemoteSequences(data);
				} else if(data.type == 'getseqs') {
					if (sameRoomOrUnknown(conn.peer)) sendSequences(data.sender);
				} else if(data.type == 'ytext') {
					// 50 Y1: a shared code/text buffer's update (or a `none` answer) — applied only to a
					// document this peer holds open; the Y.Doc is session state, never saved
					applyRemoteYText(data, conn.peer);
				} else if(data.type == 'ytextaw') {
					applyRemoteYAwareness(data);
				} else if(data.type == 'getytext') {
					// answered across rooms too, with `none`, so the asker stops waiting at once
					answerYText(data, conn.peer, sameRoomOrUnknown(conn.peer));
				} else if(data.type == 'tpchat') {
					// 56 C10: one chat, whole-doc latest-wins on changedAt (one writer per session)
					applyRemoteTpchat(data);
				} else if(data.type == 'tpchatdel') {
					applyRemoteTpchatDelete(data);
				} else if(data.type == 'tpchats') {
					applyRemoteTpchats(data);
				} else if(data.type == 'gettpchats') {
					if (sameRoomOrUnknown(conn.peer)) sendTpchats(data.sender);
				} else if(data.type == 'tprefs') {
					applyRemoteChatRefs(data.refs); // 56 C8: the scene's kept chat pictures
				} else if(data.type == 'hudvalue') {
					// 21-D4: a SHARED input's value - the one runtime HUD message, because what a
					// player dragged is the only HUD state a peer cannot derive for itself.
					// Latest-wins per element on a monotonic stamp.
					applyRemoteHudValue(data);
				} else if(data.type == 'hudvalues') {
					applyRemoteHudValues(data);
				} else if(data.type == 'gethudvalues') {
					if (sameRoomOrUnknown(conn.peer)) sendHudValues(data.sender);
				} else if(data.type == 'game') {
					// 21-D6: the game state, a latest-wins singleton like scenephysics/music.
					// Every peer then reacts LOCALLY (screens, the start camera) - the camera
					// itself is never on the wire.
					applyRemoteGameState(data);
				} else if(data.type == 'getgame') {
					if (sameRoomOrUnknown(conn.peer)) sendGameState(data.sender);
				} else if(data.type == 'gamevarop') {
					// fix-agenttest 10: a shared Set Variable's event, sent to us as the authority;
					// applied once per rid, and the write replicates as `game`
					applyGameVarOp(data);
				} else if(data.type == 'underlay') {
					// 60 Q5: a peer's shared reference image (owner = this conn, never a field)
					applyRemoteUnderlay(data, conn.peer);
				} else if(data.type == 'underlaydelete') {
					applyRemoteUnderlayDelete(data, conn.peer);
				} else if(data.type == 'getunderlays') {
					if (sameRoomOrUnknown(conn.peer)) sendUnderlays(conn.peer);
				} else if(data.type == 'kit' || data.type == 'kitreq') {
					// 34 R2: the kit document (authority-written, latest-wins) and a request
					// to the authority; the shapes were checked by wireValidate
					receiveKitMessage(data, conn.peer);
				} else if(data.type == 'bhv') {
					// 34 R3 (D1): a behaviour's document (authority-written, latest-wins; behaviours/app.js)
					receiveBehaviourMessage(data)
				} else if(data.type == 'kitentity' || data.type == 'getkitentities') {
					// 34 R2 (kit-entities): the kit's entities (authority-written; the applier
					// refuses any other sender) and a joiner's ask for the whole set
					receiveKitMessage(data, conn.peer);
				} else if(data.type == 'envpresets') {
					applyRemoteEnvPresets(data);
				} else if(data.type == 'matpresets') {
					applyRemoteMaterialPresets(data); // 37 R5: a person's material library
				} else if(data.type == 'getmatpreset') {
					answerMaterialPresetRequest(data, conn.peer); // 48 F2: a peer pulls one of my big presets
				} else if(data.type == 'matpresetpart') {
					applyMaterialPresetPart(data); // 48 F2: one part of a big preset
				} else if(data.type == 'geometry') {
					applyRemoteGeometry(data);
				} else if(data.type == 'lighttarget') {
					applyLightTarget(data);
				} else if(data.type == 'sessionproposal') {
					applySessionProposal(data);
				} else if(data.type == 'sessionanswer') {
					applySessionAnswer(data);
				} else if(data.type == 'drawlive') {
					applyDrawLive(data);
				} else if(data.type == 'drawend') {
					applyDrawEnd(data);
				} else if(data.type == 'lockrequest') {
					// lock messages act for the CONNECTION (`conn.peer`); the payload's peerId /
					// from stay on the wire for older peers and are not read (lockTrust.js)
					applyLockRequest(data, conn.peer);
				} else if(data.type == 'unlock') {
					applyUnlock(data, conn.peer);
				} else if(data.type == 'lockdenied') {
					applyLockDenied(data, conn.peer);
				} else if(data.type == 'lock') {
					lockGeometry(data.uuid, conn.peer, data.uuids);
				} else if(data.type == 'locked') {
					// the host forwards the room's table; anyone else speaks for its own rows,
					// and only if it may take locks at all (`locked` is on the canApply floor)
					lockRestore(data.lockeditems, conn.peer, get(sessionHost) === conn.peer, canApply(conn.peer, 'lock'));
				} else if(data.type == 'userdata') {
					// F-5: the roster applier UNIONS, so a third peer still linked to someone this host
					// removed would put them straight back in Users — a removed peer stays out of ours
					userData(this.removedPeers.size && Array.isArray(data.userdata)
						? data.userdata.filter((/** @type {any} */ e) => !this.removedPeers.has(e?.[0]))
						: data.userdata);
				} else if(data.type == 'specator') {
					specator(data, data.watching);
				} else if(data.type == 'cameraSettings') {
					cameraSettings(data, data.vrmode);
				} else if(data.type == 'camera') {
					moveCamera(data);
				} else if(data.type == 'sceneaccess') {
					// R22 round 35: "may I see your private scene?" / "yes" / "no". DELIBERATELY
					// NOT ROOM_SCOPED — see the note in peerScenes' MESH-WIDE list: a private
					// peer is elsewhere from everybody by construction, so a scoped request
					// could never reach the one person able to answer it.
					//
					// DYNAMIC, the `sceneadopt` precedent one case below: scenePrivacy sits on
					// top of levels.js, and this dispatcher has never had a static edge into
					// that subtree.
					import('$lib/scenePrivacy').then((m) => m.applySceneAccess(conn.peer, data)).catch(() => {});
				} else if(data.type == 'getobjects') {
					// share-or-stash (50): the reply may wait for the user's choice.
					// A1: the request carries CONTEXT now — not just how much they hold, but
					// which scene they are standing in and whether they are the peer we joined.
					// Their `atscene` row is already fresh: it is the first thing a handshake
					// sends, and this conn delivers in order.
					// A3: …and WHERE WE ARE, which the decision table is written in. It is
					// passed rather than read, because sessions.js may not import peerScenes
					// statically (peerScenes -> levels -> sessions closes the cycle) and the
					// gate has to decide SYNCHRONOUSLY - it either replies or queues, and a
					// dynamic import is a tick too late for either.
					//
					// R22 round 35: the two full-state requests that do NOT go through
					// `sameRoomOrUnknown` — they go through the share-or-stash table instead,
					// which is written in scene NAMES and reads a private peer's empty one as
					// the session's unnamed world. A privacy split is decided here, before the
					// table, and it withholds SILENTLY: it is the same shape as the table's own
					// row 2, and there is nothing for either side to be asked about.
					if (privacySplit(conn.peer)) return;
					//
					// R22 ROUND 36 (rooms): THE TABLE IS HANDED ROOMS, NOT NAMES. Its `split`
					// test was `elsewhereThan`'s rule spelled out locally, so it inherited the
					// same hole — a peer in the session's unnamed world beside a peer in a named
					// one read as ONE room, which is the report. `myRoomLabel`/`roomLabelOf`
					// resolve both sides through the host; the NAMES ride along as `mineName`/
					// `theirName` because two of the table's readers need the name and not the
					// room (the connect decision asks "has THIS scene ever been saved", and Bring
					// travels to a scene, which the unnamed room is not).
					deferUntilShareChoice('objects', data.sender, {
						otherCount: data.count ?? 0,
						theirScene: roomLabelOf(conn.peer),
						theirName: sceneOfPeer(conn.peer),
						theirHash: get(peerScenes)[conn.peer]?.hash ?? '',
						fromHost: get(sessionHost) === conn.peer,
						mineScene: myRoomLabel(),
						mineName: myScene()?.scene ?? '',
						arriving: !!data.arriving
					});
				} else if(data.type == 'objectfile') {
					applyObjectFile(data);
				} else if(data.type == 'behavior') {
					// 33 P2: a functional pack item was triggered (a door, a lid, a lever).
					// Latest-wins on the sessionNow stamp; every peer derives the pose itself.
					applyRemoteBehavior(data);
				} else if(data.type == 'object') {
					createObject(data, data.uuids, data.override, data.groupuuid, data.pos, data.rot, data.scale);
				} else if(data.type == 'objectParameters') {
					objectParameters(data);
				} else if(data.type == 'duplicate') {
					// B7: `transient` is additive — absent for every ordinary duplicate.
					// D2: so is `shareMaterial` — absent means the copy gets its own material,
					// which is what every peer before this build did unconditionally.
					applyRemoteDuplicate(data.sourceUuid, data.uuids, data.name, data.pos, data.transient, data.shareMaterial);
				} else if(data.type == 'clearscene') {
					applyClearScene(conn.peer);
				} else if(data.type == 'delete') {
					deleteObject(data.uuid);
				} else if(data.type == 'color') {
					colorObject(data.uuid, data.color, data.near, data.far);
				} else if(data.type == 'loading') {
					// 26-B (audit M2): WHO announced it, so their teardown can clear the batch. Local
					// only — the message is unchanged, so an older peer is unaffected.
					createLoader(data.count, data.uuids, conn.peer);
				} else if(data.type == 'disconnected') {
					if (data.peerId === conn.peer) {
						// the peer says goodbye ITSELF (leaveSession / tab close): tear
						// down now — the close that follows is often never signaled (the
						// P-A finding), and marking it graceful stops the transient-drop
						// reconnect from redialing someone who left on purpose (B5)
						this.gracefulLeft.add(data.peerId);
						// fix-agenttest 6: a tab that unloaded may reload and dial back on this id
						if (data.unload === true && this.openedPeers.has(data.peerId)) {
							const now = Date.now();
							for (const [id, at] of this.unloadedPeers) if (now - at > REJOIN_WINDOW_MS) this.unloadedPeers.delete(id);
							this.unloadedPeers.set(data.peerId, now);
						}
						if (this.openedPeers.has(data.peerId)) this.finalizeDisconnect(data.peerId, false);
					} else if (this.connections[data.peerId] || this.reconnecting.has(data.peerId)) {
						// a relayed rumor about a peer we have FIRST-HAND state on — our
						// own conn (or reconnect window) decides, a third party doesn't.
						// Honoring these evicted live peers meshwide during formation (B5).
					} else {
						handleDisconnected(data.peerId);
						dropPeerPlayMode(data.peerId); // 21-F3
						dropPeerScene(data.peerId); // P2b
						dropPeerVars(data.peerId); // 21-G4
						dropPeerColocation(data.peerId); // CO5
						dropPeerEnvPresets(data.peerId);
						dropPeerMaterialPresets(data.peerId);
						dropPeerHandModel(data.peerId);
					}
				} else if(data.type == 'getnodes') {
					if (privacySplit(conn.peer)) return; // R22 round 35, as `getobjects` above
					deferUntilShareChoice('nodes', data.sender, {
						// R22 round 36 (rooms): resolved rooms, as `getobjects` above
						theirScene: roomLabelOf(conn.peer),
						theirName: sceneOfPeer(conn.peer),
						theirHash: get(peerScenes)[conn.peer]?.hash ?? '',
						fromHost: get(sessionHost) === conn.peer,
						mineScene: myRoomLabel(),
						mineName: myScene()?.scene ?? ''
					});
				} else if(data.type == 'nodes') {
					preloadSandboxFor(data); // 69: a joiner's scene with code starts the engine before its first tick
					applyNodesSnapshot(data.nodes, data.edges, data.graphs);
					noteNodesSnapshot(conn.peer); // fix-agenttest 5: the handshake's graphs are here
				} else if(data.type == 'nodesync') {
					applyNodeSync(data);
				} else if(data.type == 'graphcreate') {
					applyGraphCreate(data.uuid);
				} else if(data.type == 'graphdelete') {
					applyGraphDelete(data.uuid);
				} else if(data.type == 'nodedef') {
					applyNodeDef(data.def);
				} else if(data.type == 'nodedefdelete') {
					applyNodeDefDelete(data.id);
				} else if(data.type == 'nodedefs') {
					applyNodeDefsSnapshot(data.defs);
				} else if(data.type == 'getnodedefs') {
					sendNodeDefs(data.sender);
				} else if(data.type == 'nodecreate') {
					createFlowNode(data.node, data.graphId);
				} else if(data.type == 'nodemove') {
					moveFlowNode(data.id, data.position, data.graphId);
				} else if(data.type == 'nodedata') {
					updateFlowNodeData(data.id, data.data, data.graphId);
				} else if(data.type == 'nodedelete') {
					deleteFlowNodes(data.ids, data.graphId);
				} else if(data.type == 'edgecreate') {
					createFlowEdge(data.edge, data.graphId);
				} else if(data.type == 'edgedelete') {
					deleteFlowEdges(data.ids, data.graphId);
				} else if(data.type == 'nodetrigger') {
						applyNodeTrigger(data.id, data.t, false, null, data.at ?? null, data.other, true); // 134: shared-timestamp pulse (31: + where, for a clap; 36 X6: + the contact's other body)
					} else if(data.type == 'gettriggers') {
						// DEVX #18: the trigger LOG for a late joiner. Deliberately NOT behind
						// share-or-stash like getobjects/getnodes: there is nothing here for a
						// user to choose about — the log is runtime state, not their authored
						// work — and the payload prunes to live nodes, so after a stash we
						// answer with nothing at all.
						if (sameRoomOrUnknown(conn.peer)) sendTriggers(data.sender);
					} else if(data.type == 'triggers') {
						// merged per node (newer stamp wins), and the merge marks the history
						// epoch so nothing in it can be ACTED on — see triggerSync
						applyRemoteTriggers(data);
					} else if(data.type == 'particleburst') {
						// PFX-A: shared-timestamp burst — every peer seeds the identical
						// particle burst from t (no re-broadcast)
						applyBurst(data.uuid, data.t);
					} else if(data.type == 'flowcursor') {
					applyFlowCursor(data);
				} else if(data.type == 'ping') {
					applyPing(data);
				} else if(data.type == 'assetfile') {
					// shared Explorer bytes (97) — dedup by content hash
					applyAssetFile(data);
				} else if(data.type == 'assetmissing') {
					// R22-R8: "I do not have that hash." When every peer has said so the pull is
					// resolved immediately instead of waiting out a timeout.
					applyAssetMissing(conn.peer, data);
				} else if(data.type == 'assetstart') {
					// R22-R8: a sliced transfer is announced, then its slices arrive. Chunking is
					// what makes per-file progress and an integrity check possible — peerjs chunks
					// internally but tells us nothing about it.
					applyAssetStart(data);
				} else if(data.type == 'assetchunk') {
					applyAssetChunk(data);
				} else if(data.type == 'assetthumb') {
					// R22: the PICTURE of a hash, not the file — so a shared file a peer has not
					// downloaded still shows a thumbnail on its card
					applyAssetThumb(data);
				} else if(data.type == 'getasset') {
					// a peer is missing a hash we may hold — answer over our
					// stable outgoing connection to them.
					// R22: `thumb` is an ADDITIVE flag asking for the thumbnail INSTEAD of the
					// bytes; an older peer never sets it and is unaffected.
					if (data.thumb) answerAssetThumbRequest(conn.peer, data);
					else answerAssetRequest(conn.peer, data);
				} else if(data.type == 'module') {
					applyModuleMessage(data);
				} else if(data.type == 'meshgenask' || data.type == 'meshgenstate' || data.type == 'meshgenreq' || data.type == 'meshgenack') {
					// 55 A6: an agent's generate_mesh relayed to the host's provider — lazy, so a session with no agent never loads it
					const from = conn.peer;
					import('$lib/agent/meshRelay.js').then((m) => m.handleMeshRelay(from, data)).catch(() => {});
				} else if(data.type == 'agentsimreq' || data.type == 'agentsimack') {
					// 55 (41's physics research): an agent's control_simulation runs on the HOST — a headless
					// page stepping the world slowed the whole session's physics 4-6x
					const from = conn.peer;
					import('$lib/agent/simRelay.js').then((m) => m.handleSimRelay(from, data)).catch(() => {});
				} else if(data.type == 'modules') {
					// 37 R1: `wb` is ADDITIVE — an older peer omits it and keeps getting bare messages
					if (data.wb === 1) this.wireBatchPeers.add(conn.peer);
					else this.wireBatchPeers.delete(conn.peer);
					// 60 Q2: `fc` is ADDITIVE too — they can take a fast channel, so open ours on THIS
					// conn and say so down it (`fastchan`), so both ends pick the same RTCPeerConnection
					if (data.fc === 1 && this.openFastChannel(conn)) conn.send({ type: 'fastchan', v: 1 });
					checkModuleVersions(data.versions, conn.peer); // 55 T6: + who, for tpAgent.missingModules
					checkPeerAppVersion(data.appVersion);
					notePeerFacts(conn.peer, { appVersion: data.appVersion, device: data.dev }); // 55 A9: the profile card
				} else if(data.type == 'relink') {
					this.adoptRelink(conn);
				} else if(data.type == 'linkaway') {
					// fix-agenttest 4: their page went hidden / came back (see peerDrop.AWAY_GRACE_MS)
					if (data.hidden === true) this.awayPeers.set(conn.peer, Date.now());
					else this.awayPeers.delete(conn.peer);
				} else if(data.type == 'fastchan') {
					// 60 Q2: the other end opened its fast channel on this conn's RTCPeerConnection
					this.openFastChannel(conn);
				} else if(data.type == 'getmodulestate') {
					sendModuleStates(data.sender);
					sendCameraPreviewState(); // 16-P5: ride the same late-joiner request
					sendLookState(); // P2: ...and how we are looking at the scene (view mode, look switches)
					sendPlayModeState(); // 21-F3: ...and so does play-mode presence
					sendMySceneState(); // P2b: ...and where we are standing
					sendPeerVarsState(); // 21-G4: ...and our own per-player row, if we hold one
					sendColocationState(); // CO5: ...and our physical room, if we are in one
				} else if(data.type == 'peervars') {
					// 21-G4: ONE peer's OWN numbers, whole-map latest-wins. Owner-only writer,
					// so this applier can never be the thing that clobbers somebody's score.
					applyRemotePeerVars(data);
				} else if(data.type == 'colocated') {
					// CO5: presence only — "X is in physical room K". ADDITIVE: sent only on a
					// CHANGE and only when there IS a room, so an absent peer (or one on an
					// older build that never sends it) reads as not colocated, which is what it
					// is. Applying it hides nothing by itself — the renderers and the voice
					// chain compare K against OUR OWN key, so a remote peer holding two
					// colocated rows still sees and hears both of them.
					applyRemoteColocation(data);
				} else if(data.type == 'playmode') {
					// 21-F3: presence only — "X is in play mode". ADDITIVE: the message goes out
					// only while PLAYING, so an absent peer (or one on an older build that never
					// sends it) reads as an editor, which is what it is.
					applyRemotePlayMode(data);
				} else if(data.type == 'atscene') {
					// P2b: which scene a peer is in. Latest-wins per SENDER, and only that
					// sender ever writes its own row, so the map cannot race.
					applyRemotePeerScene(data);
				} else if(data.type == 'sceneadopt') {
					// R22 round 34: a peer SAVED the unnamed world we are all standing in, so
					// the world has a name now and everybody in it takes it. ROOM_SCOPED, so
					// both gates above have already had their say (elsewhere, and queued
					// behind our own open ask); the applier adds the unnamed-only rule and
					// repeats the room test for an older sender that does not gate on send.
					//
					// DYNAMIC, and the only dynamic import in this dispatcher: levels.js pulls
					// the whole sessions/explorer subtree in behind it and nothing here has
					// ever had a static edge into it. The module is already resolved in
					// practice (App.svelte's debug hook imports it at boot), and a message
					// that arrives before it is not one anybody is waiting on.
					import('$lib/levels').then((m) => m.applyRemoteSceneAdopt(data)).catch(() => {});
				} else if(data.type == 'modulestate') {
					applyModuleStates(data.states);
				} else if(data.type == 'campreview') {
					// 16-P5: presence only — "X is previewing camera Y" (peers may join it)
					applyRemoteCameraPreview(data);
				} else if(data.type == 'lookstate') {
					// P2: presence only — how X is LOOKING at the scene, so a watcher renders
					// X's chain rather than its own. ADDITIVE: an older build never sends it.
					applyRemoteLookState(data);
				} else if(data.type == 'annotation') {
					applyAnnotation(data);
				} else if(data.type == 'annotations') {
					applyAnnotationsSnapshot(data.annotations);
				} else if(data.type == 'getannotations') {
					if (sameRoomOrUnknown(conn.peer)) sendAnnotations(data.sender);
				} else if(data.type == 'verts') {
					applyVerts(data.uuid, data.indices, data.position);
				} else if(data.type == 'meshgeo') {
					applyMeshGeo(data.uuid, data.positions, data.groups, data.uvs, data.faceCounts, data.faceTris);
				} else if(data.type == 'uvpaint') {
					applyUvPaint(data);
				} else if(data.type == 'uvpaintend') {
					applyUvPaintEnd(data);
				} else if(data.type == 'splineedit') {
					// 57.3: only the RECORD travels — the receiver rebuilds the tube
					applySplineEdit(data.uuid, data.spline);
				} else if(data.type == 'perflive') {
					// 34 PF (profiler-xr): a peer's live perf stream, or a request to stream ours.
					// LOCAL presence-like data: never re-broadcast, never saved, never undone.
					routePerfLive(conn.peer, data);
				} else if(data.type == 'agentlog') {
					applyAgentLog(conn.peer, data); // 55 A8: one agent tool call (or the handshake's recent N)
				} else if(data.type == 'agentundo') {
					applyAgentUndo(conn.peer, data); // 55 A8: an editor's per-line Undo, to the agent that holds it
				} else if(data.type == 'agentview') {
					applyAgentView(conn.peer, data); // 55 A7: where the agent's last screenshot looked
				} else if(data.type == 'agentchat') {
					// 56: ONE branch for both halves — the window's reducer (56-chat: a request / streamed reply / Stop /
					// status, or the backlog) and, on an AGENT page, its inbox that holds the message for the bridge (56-bridge)
					applyAgentChatMessage(conn.peer, data);
					const from = conn.peer;
					if (isAgentSession()) import('$lib/agent/agentInbox.js').then((m) => m.receiveAgentChat(from, data)).catch(() => {});
				} else if(data.type == 'vrhands') {
					peerHands.update((map) => ({
						...map,
						[data.peerId]: { left: data.left, right: data.right, active: data.active !== false, ts: Date.now() }
					}));
				} else {
					// 27-A (audit M11): THE RAW-STRING BRANCH IS GONE. It routed a peer's
					// string straight into sceneCommand, where '/clear all' wipes the scene
					// AND re-broadcasts it — a receiver re-broadcasting is golden rule 1
					// inverted. Nothing sends raw strings (sendMessage runs slash commands
					// locally), so an unreachable branch was standing armed. What is here now
					// is the counter that says a peer sent something this build cannot apply,
					// which is how version skew becomes visible instead of silent.
					noteWireError(conn.peer, 'unknown:' + data.type);
				}
			};

			// 60 Q2: ONE receive path for both channels — the reliable conn and the fast channel
			// opened on its RTCPeerConnection (`openFastChannel` reads it off the conn)
			const receive = (/** @type {any} */ data, /** @type {'fast' | 'reliable'} */ via = 'reliable') => {
				// 27-A (audit H1): SHAPE FIRST, before any gate reads `data.type`. A null, a
				// string or a number used to fall through the whole chain to
				// `data.startsWith(...)` and throw out of the handler, where peerjs swallowed
				// it and nothing counted it. canApply stays the first POLICY gate; this is
				// only "is this a message at all".
				if (!data || typeof data !== 'object') {
					noteWireError(conn.peer, 'shape', typeof data);
					return;
				}
				// 26-A (roadmap 26 section 3, audit H7): WHICH STREAM IS CHATTY. Counted per
				// type here and in `broadcast`; local only, never replicated, and the byte
				// figure is a 1-in-16 sample so the measurement cannot become the cost.
				noteWire('in', data);
				// …then the shape its own type implies, so an applier cannot throw halfway
				// through applying half a message. A type absent from the table is ALLOWED,
				// which is what keeps a newer peer's messages working.
				if (!validateWireMessage(data)) {
					noteWireError(conn.peer, 'invalid:' + data.type);
					return;
				}
				// 60 Q2: a pose older than the newest one applied from this sender is stale — an
				// unordered datagram overtaken by the next one, or a streamed move that lost the race
				// to the committed (reliable, newer) move that ended the drag
				if (!this.staleFilter.accept(conn.peer, data)) return;
				tapPose(conn.peer, data, via);
				try {
					dispatch(data);
				} catch (error) {
					// One bad message must not take this connection's handler down with it.
					noteWireError(conn.peer, data.type, error);
				}
			};
			conn.__tpReceive = receive;
			conn.on('data', (/** @type {any} */ data) => receive(data));
		}
	}

	/**
	 * A1: WHERE WE ARE, and in the handshake it goes out AHEAD of everything else. Until
	 * A1 the only thing that taught a joiner the host's scene name was the `atscene`
	 * riding the `getmodulestate` reply — which lands AFTER the handshake has already
	 * decided what to do with the objects, so every scene-aware read during the one
	 * moment that matters saw no evidence at all. PeerJS conns are ordered and reliable,
	 * so sending it first means the receiver's row for us is fresh before ANY handshake
	 * decision is taken on the far side.
	 *
	 * Both-unnamed stays byte-identical: an empty scene gates nothing (the
	 * only-on-evidence rule), and `sendMySceneState` still answers getmodulestate — that
	 * is the path for a peer on an older build, and the unconditional-reply contract that
	 * module documents.
	 * @param {any} conn
	 */
	sendMyScene(conn) {
		// R22 round 35: `mySceneWire` is the ONE builder of this row — while we are editing a
		// scene privately it answers `{scene:'', hash:'', private:true}`, so the very first
		// message of a handshake is where the name stops. Reading `myScene()` here (which is
		// the SCREEN's answer, name and all) would leak it to every peer that ever connects.
		conn.send({ type: 'atscene', peerId: this.peer.id, ...mySceneWire(), at: sessionNow() });
	}

	/**
	 * A2: THE FULL-STATE BURST, factored out of `sendHandshake` so that ARRIVING in a
	 * room can ask for exactly what opening a connection asks for. It has to be the same
	 * burst, not a subset: the room gate withholds every ROOM_SCOPED family while a peer
	 * is away, so a traveller owes itself all of them on arrival, and a hand-picked list
	 * would silently rot the day a domain is added (the `scenePostState` lesson - a field
	 * that hand-lists what it sends drops the next field somebody adds).
	 *
	 * ORDER IS PRESERVED VERBATIM from the handshake, and one line of it is load-bearing:
	 * `gettriggers` AHEAD of `getnodes` (DEVX #18), so a node lands in a COMPLETE trigger
	 * history rather than history landing on a node that has already been ticking. Core
	 * does not need it - the epoch and the merge are order-independent - but a CONSUMER
	 * with a first-sight rule of its own (the collectible module seeds each node's stamp
	 * without counting) is racy in the other order and correct in this one.
	 *
	 * `atscene` LEADS, for the same reason it leads the handshake: the peer we are asking
	 * has to know we are in its room before it decides whether to answer - its reply side
	 * is gated by `sameRoomOrUnknown`, so an unrefreshed row would have it withhold the
	 * very state we just travelled to get.
	 *
	 * THERE IS NO `getgame` HERE, and it was tried. The handshake covers the game by a
	 * PUSH, so a pull looked like the obvious completion of the burst - and it is
	 * MEASURABLY INERT for the only caller there is. `travelToLevel` re-asserts the
	 * traveller's CARRIED game state through `gameStateRestore`, which stamps
	 * `Date.now()` on purpose (21-F4 fork 3, campaign semantics: your progress comes
	 * with you), so the arriving state is always the newest and the room's reply always
	 * loses latest-wins. Measured: the traveller read `{state:'menu'}` beside a room
	 * sitting at `'playing'`, and that is fork 3 working, not a gap. The room's game
	 * converges the ordinary way - the NEXT transition broadcasts, and the traveller is
	 * in the room to receive it (scene-isolation section 5 asserts both halves).
	 * ARRIVING is the one field this burst adds to the handshake's. Without it the
	 * re-sync pops a share-or-stash prompt on everybody already in the room: a traveller
	 * asks for objects while HOLDING objects (the scene file it just loaded), which is
	 * the exact shape `deferUntilShareChoice` reads as two worlds merging. It is not one
	 * - what the traveller holds is that room's OWN scene - so the flag says so and the
	 * receiver answers instead of asking. Additive: absent means false, so the handshake
	 * is byte-identical and an older peer simply asks the question it always asked.
	 * @param {any} conn @param {{arriving?: boolean}} [opts]
	 */
	requestFullState(conn, opts = {}) {
		this.sendMyScene(conn)
		conn.send({type: 'getobjects', sender: this.peer.id, count: localSceneCount(), ...(opts.arriving ? { arriving: true } : {})})
		noteSnapshotAsked(conn.peer)
		conn.send({type: 'gettriggers', sender: this.peer.id})
		conn.send({type: 'getnodes', sender: this.peer.id})
		conn.send({type: 'getannotations', sender: this.peer.id})
		conn.send({type: 'getjoints', sender: this.peer.id})
		conn.send({type: 'getanim', sender: this.peer.id})
		conn.send({type: 'getscenepost', sender: this.peer.id})
		// CO1: a REQUEST rather than a push, because a scene that never colocated must
		// send nothing at all — `sendRoomAnchor` returns early on a null anchor, so the
		// handshake of a non-colocated session is byte-identical to what it always was.
		conn.send({type: 'getroomanchor', sender: this.peer.id})
		conn.send({type: 'getshadergraphs', sender: this.peer.id})
		conn.send({type: 'gethuds', sender: this.peer.id})
		conn.send({type: 'gethudvalues', sender: this.peer.id})
		conn.send({type: 'getseqs', sender: this.peer.id}) // 48 S2
		conn.send({type: 'gettpchats', sender: this.peer.id}) // 56 C10
		conn.send({type: 'getunderlays', sender: this.peer.id}) // 60 Q5
	}

	// Send the initial handshake (locks, known hosts, whitelist, object/node sync requests).
	// Must only be called once the connection is open — messages sent earlier are dropped by peerjs.
	/** @param {any} conn @param {string} peerId @param {boolean} getobjects @param {string} id
	 * @param {{heal?: boolean}} [opts] heal: this conn REPLACES one that dropped (the reconnect window) */
	sendHandshake(conn, peerId, getobjects, id, opts = {}) {
		// 25-F: an approval dial-back SAYS it is one, ahead of everything else (the roadmap's
		// "first message"). The metadata already carried it; this is the same answer for a
		// peer that reads messages rather than metadata, and it is idempotent on a joiner
		// that has already moved on.
		if (this.approvedDialBacks.delete(peerId)) conn.send({ type: 'joinresult', result: 'approved' });
		// 60-int: a HEAL says so before anything that is answered. Our end of the old link is
		// closed (F-3's silence close, or a drop), but theirs may still read `open` — a close
		// never crosses a dead link — and they would keep sending, and answering this very
		// handshake, into it (net-drop on the deployed preview: one direction's edits lost)
		if (opts.heal || this.reconnecting.has(peerId)) conn.send({ type: 'relink' });
		// a conn opened to them — whatever goodbye they once sent is history
		this.gracefulLeft.delete(peerId);
		// fix-agenttest 5: only the peers we are LINKED to now (peerDrop.meshHosts) — a closed conn
		// waiting out its reconnect window is still a key here, and a joiner told about it
		// dialled a departed peer (peer-unavailable)
		let hosts = meshHosts(id, peerId, this.connections, this.reconnecting);
		console.log("sending to " + peerId + "  remote " + hosts)
		let locks = [...locked];
		if(typeof selected.uuid != 'undefined' && selected.uuid) locks.push([id, selected.uuid]);
		// A1: WHERE WE ARE, ahead of everything else — the reasoning lives on
		// `sendMyScene`, which A2 shares with the arrival re-sync for the same reason.
		this.sendMyScene(conn);
		// 25-E: the clock round trip goes out SECOND — ahead of every full-state request —
		// so on an ordered conn the host's first pong lands before its content does, and a
		// grossly wrong joiner clock is corrected before the history it would mis-stamp
		// arrives (flowRuntime shifts its cutoffs for whatever still lands first).
		startClockSync(peerId);
		// R22 round 35: `locked` is ROOM_SCOPED and this is a DIRECT send, so the broadcast
		// gate never sees it — a private peer would hand a stranger the uuids it is holding in
		// a scene that stranger cannot see. Our own table is stale while private anyway (every
		// incoming lock is dropped by the room gate), so forwarding it would be wrong twice.
		// `hostsPrivate` is read once here and reused by the content hold further down.
		const hostsPrivate = amPrivate();
		if (!hostsPrivate) conn.send({type: 'locked', lockeditems: locks})
		conn.send({type: 'hosts', hosts: hosts})
		conn.send({type: 'userdata', userdata: users.filter((/** @type {any} */ u) => !isHeldOut(u[0]))})
		// 55 A8: the newest agent log lines, so a late joiner's AI window shows what was built
		sendAgentLogTo(conn);
		sendAgentChatBacklogTo(conn); // 56 C1: the agent chats so far
		// 55 A9: a moderator hands its block list on, so a blocked re-dial is refused by
		// whichever peer it reaches — including one that joined after the block
		for (const k of blockReplay()) conn.send(k);
		// V3: app version rides the modules handshake — old peers ignore the extras,
		// old senders omit them (checkPeerAppVersion is silent on absence)
		conn.send({type: 'modules', versions: moduleVersions(), appVersion: APP_VERSION, sha: COMMIT_SHA, wb: 1, dev: myDevice(get(isVRMode)), ...(fastChannelEnabled() ? { fc: 1 } : {})}) // 55 A9: `dev` is additive
		// 37 R15: the chat so far. Chat is MESH-WIDE (not a room's content), so this goes out
		// whatever the connect decision / privacy hold below decides about the scene.
		conn.send({type: 'getchat', sender: this.peer.id})
		// R22 round 33 — NOTHING MOVES UNTIL THE DECISION, INCLUDING WHAT WE ASK FOR.
		//
		// When this handshake is the one that will put the connect decision on screen (we
		// joined THEM, our scene has never been saved, and we are holding work), the CONTENT
		// half of it waits. Two different leaks, one condition:
		//
		//   · the scene SINGLETONS describe a world that is about to be saved-and-left or
		//     dismissed, and they are latest-wins — a joiner's fresher `changedAt` would
		//     CLOBBER the host's sky, gravity and game with the look of a world nobody in
		//     the room ever agreed to receive. Identity is not content, so `handmodel` and
		//     the preset library still go.
		//   · `requestFullState` (and `getnodedefs`) is an INVITATION for a world to arrive.
		//     The share-or-stash gate can drop what a peer sends unasked, but the honest
		//     thing is not to ask until there is a decision behind the asking.
		//
		// The request is DEFERRED, never cancelled: whatever ends the decision issues it
		// (`askDeferredState` in sessions.js), by which time we hold a saved-and-cleared
		// scene or nothing at all — so the request goes out with count 0 and the host's own
		// row-1/row-5 fast path answers it without a question of its own.
		//
		// THE DEGENERATE EDGE, and it is safe: a host that never sends `getobjects` opens no
		// gate here, so no decision is ever put and nothing is exchanged in either direction.
		// Only a build that would not have asked us anything can reach it.
		//
		// R22 ROUND 35 — AND THE SAME WITHHOLDING FOR A PRIVATE SCENE, for a different
		// reason. These singletons are ROOM_SCOPED types sent straight down the conn, so
		// `broadcast`'s gate never sees them: a peer connecting while we edit privately would
		// receive our private scene's sky, gravity, music, look and game state. The request
		// half goes with it — asking for a world every gate will make us drop is bytes for
		// nothing. It is NOT `noteHandshakeDeferred`, which promises a request at the end of a
		// DECISION: there is no decision here, and the ask comes back the moment we share or
		// rejoin (both end in a full-state re-sync of their own).
		const secret = hostsPrivate;
		// test-health-1: the connect decision is a FIRST-CONTACT question; a healed conn is the same
		// session coming back, so it never holds (it deferred our state for a decision nobody asked:
		// net-drop HARD healed, open both ways, and no edit crossed)
		const holdContent = secret || (getobjects && !opts.heal && connectDecisionApplies(get(sessionHost) === peerId, myScene()?.scene ?? ''));
		if (holdContent && !secret) noteHandshakeDeferred(peerId);
		if (!holdContent) {
			conn.send(environmentState())
			conn.send(musicState())
			conn.send(scenePhysicsState())
			// 23-A2/A4: the musical transport and the patch are scene singletons like the
			// three above, so they are withheld by the same condition — a joiner's fresher
			// `changedAt` would otherwise clobber the host's tempo and routing
			conn.send(transportState())
			conn.send(patchState())
			// L-C: one per post DOCUMENT — the scene look and any camera looks
			for (const state of scenePostStates()) conn.send(state)
		}
		conn.send(handModelState())
		conn.send(envPresetsState())
		conn.send(materialPresetsState())
		// test-health-1: a HEALED conn re-syncs as `arriving` — what each side holds is the same room's
		// scene, so it is not two worlds merging: without the flag the far side asked share-or-stash
		// and its gate DROPPED everything we sent (net-reconnect / net-drop: open both ways, edits lost)
		if (getobjects && !holdContent) this.requestFullState(conn, opts.heal ? { arriving: true } : {})
		// singleton PUSH, like environmentState/scenePhysicsState above
		if (!holdContent) conn.send(gameStatePayload())
		// 34 R2: the kit document, the same singleton push (its events are NOT sent: history fires nothing)
		if (!holdContent) conn.send(kitPayload())
		// 34 R2 (kit-entities): the entity set, from every peer that holds one (kit.snapshots)
		if (!holdContent) for (const msg of kitEntityPayloads()) conn.send(msg)
		// 34 R3 (D1): every behaviour document this peer holds (a joiner takes the newer)
		if (!holdContent) for (const msg of behaviourPayloads()) conn.send(msg)
		// 24-A A2: WHETHER A SIM IS RUNNING HERE, for a late joiner. `simulate` went out at
		// start/stop only, so a peer joining mid-run kept `remoteSimulating` null and neither
		// the knock probes nor play-mode grab armed until the sim restarted (A1's finding;
		// football's late joiner mid-match is the case). The start message's own shape, so
		// an older joiner applies it exactly as it applies the live one, and held with the
		// singletons — a running sim is content about THIS room.
		if (!holdContent && get(simulating))
			conn.send({ type: 'simulate', running: true, paused: get(simPaused), peerId: this.peer.id })
		// module state is the one PER-PEER payload in the get* family (each peer
		// answers with its OWN states — e.g. campreview presence), so it can't be
		// deduped down to the host like the shared-scene requests above (B5)
		conn.send({type: 'getmodulestate', sender: this.peer.id})
		// 21-G2: the project manifest (scene histories + asset list) for late joiners
		conn.send({type: 'getproject', sender: this.peer.id})
		if (getobjects && !holdContent) conn.send({type: 'getnodedefs', sender: this.peer.id})
		// join them into the voice mesh if our mic is live
		voicePeerConnected(peerId);
		// scatter-sync: what we said while this approved joiner's conn was still opening, in
		// order, re-gated NOW (their room row may have arrived since). After the handshake, so
		// the joiner already knows where we stand; the full-state reply after it is add-only.
		for (const payload of this.dialBackQueue.take(peerId)) {
			if (!conn.open) break;
			if (this.withholdFrom(peerId, payload)) continue;
			this.sendTo(peerId, conn, payload);
		}
	}

	/**
	 * 25-F: approve and dial back, marking the dial as the approval so the joiner is told
	 * rather than left to infer it. @param {string} peerId
	 */
	approveDialBack(peerId) {
		this.approvedDialBacks.add(peerId);
		this.connectToPeer(peerId, true);
	}

	/**
	 * 55 A4: what a dial to `peerId` carries besides `jr`/`cloud` — our invite proof when the
	 * invite names that peer, `kind: "agent"` when this page is an agent's, and on an approval
	 * dial-back the role the joiner's invite carried. @param {string} peerId
	 */
	dialExtra(peerId) {
		const myId = this.peer?.id || '';
		return {
			invite: joinerInviteMeta(myId, peerId),
			kind: myKind(),
			invited: this.invitedRoles?.get(peerId)
		};
	}

	/**
	 * 25-F: tell a would-be joiner "no" (or "full"). A short dial whose METADATA is the
	 * answer — delivered through signaling with the offer, so it arrives even where a data
	 * channel could never open — never added to `connections`, never wired, closed by the
	 * joiner at once and by us after REFUSAL_DIAL_MS whatever happens. Callers only send
	 * this to a dial that advertised `jr` (see denyPeer). 55 A9: 'removed' answers a blocked
	 * peer's re-dial. @param {string} peerId
	 * @param {'denied' | 'full' | 'removed'} result @returns {boolean} whether a dial went out
	 */
	sendJoinResult(peerId, result) {
		if (!isRefusal(result) || !this.peer?.open) return false;
		const conn = this.peer.connect(peerId, dialOptions(result));
		if (!conn) return false;
		this.refusalDials.add(peerId);
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			try { conn.close(); } catch {}
			// keep the quiet-unavailable mark a little longer: the error can trail the close
			setTimeout(() => this.refusalDials.delete(peerId), 5000);
		};
		conn.on?.('close', finish);
		conn.on?.('error', finish);
		conn.on?.('open', () => setTimeout(finish, 1000));
		setTimeout(finish, REFUSAL_DIAL_MS);
		log('info', 'net', 'join result sent', { peer: peerId, result });
		return true;
	}

	/**
	 * 71 TR4: a relay-only dial that cannot get through fails without any error of its own (with no
	 * candidates ICE just waits), so say why instead of leaving "Requesting" up.
	 * @param {any} conn @param {string} peerId
	 */
	watchRelayDial(conn, peerId) {
		const wait = relayDialWait(this.peer);
		if (wait == null) return;
		setTimeout(() => {
			if (conn.open || this.connections[peerId] !== conn) return;
			log('warn', 'net', 'relay-only dial did not open', { peer: peerId, wait });
			showToast(RELAY_DIAL_FAILED);
		}, wait);
	}

	connectToPeer(peerId, getobjects = true, id = this.peer.id) {
		// remember the intent: if this dial dies and an adopted inbound conn takes
		// its place, the adoption still owes them the full-state requests (B5)
		if (getobjects) this.wantsStateFrom.add(peerId);
		if (!this.connections[peerId]) {
			console.log("Connecting to " + peerId);
            // 25-F: an approval dial-back says so in its metadata; every dial says it can
            // hear a join result
            const conn = this.peer.connect(peerId, dialOptions(this.approvedDialBacks.has(peerId) ? 'approved' : undefined, this.dialCloud?.get(peerId), this.dialExtra(peerId)));
            // peer.connect returns undefined when the signaling link is down
            // (disconnected peer) — bail instead of throwing on conn.on below (CN)
            if (!conn) {
                log('error', 'net', 'connect failed: signaling link is down', { peer: peerId });
                showToast('Cannot reach the signaling server - the connection request was not sent.');
                return;
            }
            /** @type {any} */ (conn).__dialedAt = Date.now();
            this.connections[peerId] = conn;
			this.watchRelayDial(conn, peerId);

			conn.on('close', () => this.onConnClose(peerId, conn));

            conn.on('open', () => {
				console.log('Connection to ' + peerId + ' established');
				this.openedPeers.add(peerId);
				markPeerJoined(peerId);
				//Trigger reactivity for UI list of objects
				peers.update((value) => value);
				this.sendHandshake(conn, peerId, getobjects, id);
			});
			// the remote may adopt THIS conn as their send channel (bidirectional)
			this.wireData(conn);
        } else {
			if (this.connections[peerId].peer == peerId) {
				console.log(`Peer ${peerId} is already connected or has a pending request. Connection status: ${this.connections[peerId].open}`)
				if(!this.connections[peerId].open) {
					this.restoreWhenStale(peerId, getobjects, id);
				}

			}

		}
    }

	// B5: a conn that hasn't opened yet is NOT broken — it's negotiating. During
	// mesh formation every `hosts` message re-enters connectToPeer for every
	// known peer, and the old immediate restoreConnection closed conns that were
	// milliseconds from opening (the remote often had ALREADY adopted the inbound
	// half). The close then cascaded: the remote ran a full teardown, dropped us
	// from its whitelist, and every redial after that was refused as a stranger —
	// two live peers permanently deaf to each other, with a stray approval prompt.
	// So: young conn -> leave it alone and re-check once the grace expires; only
	// a genuinely stale conn is closed and redialed.
	/** @param {string} peerId @param {boolean} getobjects @param {string} id */
	restoreWhenStale(peerId, getobjects, id) {
		const conn = this.connections[peerId];
		if (!conn || conn.open) return;
		const age = Date.now() - (conn.__dialedAt ?? 0);
		if (age >= DIAL_GRACE_MS) {
			this.restoreConnection(peerId, getobjects, id, 0);
			return;
		}
		if (conn.__staleCheck) return; // one deferred check per conn is plenty
		conn.__staleCheck = true;
		setTimeout(() => {
			// same conn, still never opened -> now it's genuinely wedged
			if (this.connections[peerId] !== conn || conn.open) return;
			this.restoreConnection(peerId, getobjects, id, 0);
		}, DIAL_GRACE_MS - age);
	}

	// Post-approval reopen of OUR outgoing conn to a host. The host closed our
	// original conn before approving, and real WebRTC often never signals that
	// close — the first fresh connect can wedge on the stale negotiation state
	// and silently never open. RETRY with a bounded backoff until one opens
	// (same fix the headless agent's peerBridge needed, roadmap #10) — without
	// this the JOINING peer can never send anything to the host.
	/** @param {string} peerId @param {boolean} getobjects @param {string} id @param {number} attempt */
	restoreConnection(peerId, getobjects, id, attempt) {
		if (this.connections[peerId]?.open) return; // an adopted inbound conn already covers this peer
		// a restore dial from a parallel caller is already in flight — let it
		// finish its own 4s cycle instead of resetting the negotiation (B5)
		const inFlight = this.connections[peerId];
		if (inFlight && Date.now() - (inFlight.__dialedAt ?? 0) < RESTORE_RETRY_MS && attempt === 0) return;
		log('warn', 'net', 'restoring connection', { peer: peerId, attempt: (attempt || 0) + 1 });
		// drop the stale never-opened conn FIRST — left in peerjs's per-peer
		// bookkeeping it can wedge the fresh negotiation (offer never starts)
		const stale = this.connections[peerId];
		if (stale && !stale.open) {
			try { stale.close(); } catch {}
			delete this.connections[peerId];
		}
		const conn = this.peer.connect(peerId, dialOptions(undefined, this.dialCloud?.get(peerId), this.dialExtra(peerId)));
		if (!conn) {
			log('error', 'net', 'restore failed: signaling link is down', { peer: peerId });
			return;
		}
		/** @type {any} */ (conn).__dialedAt = Date.now();
		this.connections[peerId] = conn;
		conn.on('close', () => this.onConnClose(peerId, conn));
		conn.on('open', () => {
			log('info', 'net', 'connection restored', { peer: peerId });
			this.openedPeers.add(peerId);
			markPeerJoined(peerId);
			peers.update((value) => value);
			this.sendHandshake(conn, peerId, getobjects, id);
		});
		this.wireData(conn);
		setTimeout(() => {
			// still ours, still never opened -> replace the stale conn and retry
			if (this.connections[peerId] !== conn || conn.open) return;
			if (attempt >= 4) {
				log('error', 'net', 'restore gave up', { peer: peerId, attempts: attempt + 1 });
				return;
			}
			try { conn.close(); } catch {}
			delete this.connections[peerId];
			this.restoreConnection(peerId, getobjects, id, attempt + 1);
		}, 4000);
	}

	// A peer's outgoing connection dropped. If the peer never said goodbye this
	// is usually a transient blip (ICE restart, wifi hop, laptop lid) — try to
	// get them back on a bounded backoff BEFORE tearing anything down, so their
	// locks / avatar / roster entry survive a wobble (B5, 172 deferred item 1).
	// Announced leaves (the `disconnected` self-message from leaveSession /
	// pagehide) skip the retries and tear down at once.
	/** @param {string} peerId @param {any} conn */
	onConnClose(peerId, conn) {
		// ignore a close from a stale conn we've already replaced or removed
		if (this.connections[peerId] !== conn) return;
		console.log('connection to ' + peerId + ' closed');
		delete this.connections[peerId];
		peers.update((value) => value);
		// a conn that never opened was a failed connect, not a live peer dropping
		// (peer.on('error') already told the user) — just re-check locks and bail
		if (!this.openedPeers.has(peerId)) {
			checkLocks();
			return;
		}
		this.lastLeaveAt = Date.now();
		if (this.gracefulLeft.delete(peerId)) {
			this.finalizeDisconnect(peerId, false);
			return;
		}
		log('warn', 'net', 'connection dropped without a goodbye — trying to get them back', { peer: peerId });
		this.scheduleReconnect(peerId, 1);
	}

	// Bounded reconnect window for a peer whose open conn dropped ungracefully:
	// checks at 500/1000/2000/4000/8000ms (netBackoff, ~15s window), silent — the
	// disconnect toast belongs to the teardown, which only runs once the window
	// exhausts. Only the LOWER peer id dials; the higher id keeps the window open
	// and waits to adopt the inbound conn — a blip fires close on BOTH ends at
	// once, and two simultaneous redials are WebRTC glare (mutual offers), which
	// wedges peerjs's negotiation and made mutual healing fail outright (B5).
	// A successful reopen re-runs the full handshake, so anything missed during
	// the blip resyncs (the appliers are uuid-keyed and idempotent — the same
	// resync every adoption already does).
	/** @param {string} peerId @param {number} attempt */
	scheduleReconnect(peerId, attempt) {
		const delay = backoffDelay(attempt, { base: 500, max: 5 });
		if (delay === null) {
			// test-health-1: the verdict waits out a dial that is still negotiating, either way
			// round (6-12 s measured on a loaded box, VERDICT_GRACE_MS). After a 5 s drop the
			// first dial that can leave goes out at ~5-7.5 s, so tearing down at 15.5 s killed
			// heals in flight: "disconnected" toasts and a dead session (net-drop HARD).
			const inFlight = [this.connections[peerId], this.inboundDials.get(peerId)]
				.filter((c) => c && !c.open)
				.map((c) => VERDICT_GRACE_MS - (Date.now() - (c.__dialedAt ?? 0)))
				.filter((left) => left > 0);
			if (inFlight.length) {
				this.reconnecting.set(peerId, attempt); // still in the window, under a fresh token
				setTimeout(() => {
					if (this.reconnecting.get(peerId) !== attempt) return; // healed, superseded or left
					if (this.connections[peerId]?.open) { this.reconnecting.delete(peerId); this.inboundDials.delete(peerId); return; }
					this.reconnecting.delete(peerId);
					this.finalizeDisconnect(peerId, true);
				}, Math.max(...inFlight));
				return;
			}
			this.reconnecting.delete(peerId);
			this.finalizeDisconnect(peerId, true);
			return;
		}
		this.reconnecting.set(peerId, attempt);
		setTimeout(() => {
			if (this.reconnecting.get(peerId) !== attempt) return; // superseded or cancelled
			if (!this.openedPeers.has(peerId)) { this.reconnecting.delete(peerId); return; } // torn down elsewhere
			const existing = this.connections[peerId];
			if (existing?.open) { this.reconnecting.delete(peerId); this.inboundDials.delete(peerId); return; } // healed (redial or adopted inbound)
			// a dial un-open past the dial grace is genuinely wedged — clear it.
			// Anything younger is just negotiating (measured 6-9s on a loaded
			// headless box; closing it early poisons the NEXT negotiation too —
			// the same lesson as the mesh-formation grace).
			if (existing && Date.now() - (existing.__dialedAt ?? 0) >= DIAL_GRACE_MS) {
				try { existing.close(); } catch (e) { /* wedged */ }
				delete this.connections[peerId];
			}
			// dial (lower id only), unless this is the verdict-only final check —
			// a dial started now would be torn down before it could ever open
			const lastCheck = backoffDelay(attempt + 1, { base: 500, max: 5 }) === null;
			if (!lastCheck) this.reconnectDial(peerId);
			this.scheduleReconnect(peerId, attempt + 1);
		}, delay);
	}

	// F-5: an AUTOMATIC admission is never silent. A toast AND a notification-history entry
	// that keeps its buttons: Turn off (when the provider offers it — e.g. "Allow guests to
	// join automatically") and Remove. The provider says why; without one, a generic line.
	// 55 owner finding 4: an INVITE admission is the invite's notice, never the provider's
	// ("joined as a guest (view-only)" for an Edit invite, with a Turn off that is not why).
	/** @param {string} peerId @param {any} auth @param {any} cloudMeta @param {string} [invitedRole] */
	announceAutoAdmit(peerId, auth, cloudMeta, invitedRole) {
		let provided = null;
		if (invitedRole) {
			const canEdit = invitedRole === 'edit' || !get(rolesInfo);
			provided = { text: shortPeer(peerId) + ' joined with your invite (' + (canEdit ? 'can edit' : 'view-only') + ').' };
		} else try {
			provided = typeof auth?.admitNotice === 'function' ? auth.admitNotice(peerId, cloudMeta) : null;
		} catch (e) {
			console.error('cloud auth provider admitNotice threw:', e);
		}
		const notice = composeAdmitNotice(peerId, provided);
		/** @type {{label: string, action: () => void}[]} */
		const actions = [];
		if (notice.turnOff) {
			const turnOff = notice.turnOff;
			actions.push({ label: notice.turnOffLabel, action: () => { try { turnOff(); } catch (e) { console.error('turnOff threw:', e); } } });
		}
		actions.push({ label: 'Remove', action: () => this.removeAdmittedPeer(peerId) });
		log('info', 'net', 'peer admitted automatically', { peer: peerId });
		showLastingToast(notice.text, actions);
	}

	// F-5: Remove from the auto-admit notice. Local to this host: drop them from the roster,
	// close our link, and refuse their re-dials for the rest of the session. (The mesh-wide
	// kick with a block list is roadmap 55 A9; this is the host's own door.)
	/** @param {string} peerId */
	removeAdmittedPeer(peerId) {
		this.removedPeers.add(peerId);
		this.gracefulLeft.add(peerId); // their close is expected — no redial
		const roster = /** @type {any[]} */ (get(userdata)).filter((/** @type {any} */ e) => e[0] !== peerId);
		userdata.set(roster);
		if (this.openedPeers.has(peerId)) this.finalizeDisconnect(peerId, true);
		else {
			const conn = this.connections[peerId];
			delete this.connections[peerId];
			try { conn?.close(); } catch (e) { /* never opened */ }
		}
		this.broadcast({ type: 'userdata', userdata: get(userdata) });
		showToast(shortPeer(peerId) + ' was removed. They cannot rejoin while this tab stays open.');
	}

	// F-3: the signaling server answered "no such peer" to a redial. The dial it named
	// stays un-open (peerjs does not close it), so clear it — the next check redials at
	// once instead of waiting out the dial grace — and after a few answers in a row stop
	// waiting: the peer is gone, not blipping.
	/** @param {string} peerId */
	noteUnavailable(peerId) {
		const strikes = (this.unavailableStrikes.get(peerId) ?? 0) + 1;
		this.unavailableStrikes.set(peerId, strikes);
		const dead = this.connections[peerId];
		if (dead && !dead.open) {
			delete this.connections[peerId];
			try { dead.close(); } catch (e) { /* never opened */ }
		}
		log('info', 'net', 'redial: peer not on the server', { peer: peerId, strikes });
		if (strikes >= strikesNeeded(this.silentDrops.has(peerId))) this.finalizeDisconnect(peerId, true);
	}

	/**
	 * 60-int: the far end says the link we send on is closed at THEIR end (`relink`, the first
	 * thing a healed handshake sends). A drop is not always seen by both sides: F-3 closes a link
	 * whose ICE sat `disconnected` past its grace on one end while the other end's ICE came back,
	 * and that close never crosses the dead link — so our conn still reads `open`, the inbound
	 * heal was refused as "the stable outgoing conn stays preferred", and every edit and every
	 * full-state reply went into a conn nobody reads. Adopt the conn the relink came on, close
	 * the stale one (already replaced, so its close is ignored) and re-sync both ways.
	 * Only when our conn still reads open: a side that saw the drop itself has none to replace,
	 * and its ordinary heal adoption already ran.
	 * @param {any} conn
	 */
	adoptRelink(conn) {
		const peerId = conn.peer;
		const stale = this.connections[peerId];
		if (!stale || stale === conn || !stale.open || !conn.open) return;
		log('warn', 'net', 'relink: the peer closed our old link — this conn replaces it', { peer: peerId });
		this.connections[peerId] = conn;
		conn.on('close', () => this.onConnClose(peerId, conn));
		this.fastLinks.close(peerId);
		try { stale.close(); } catch (e) { /* already dead */ }
		this.openedPeers.add(peerId);
		peers.update((value) => value);
		// what we sent while the link was dead never arrived, and what they answered went to it
		this.sendHandshake(conn, peerId, true, this.peer.id, { heal: true });
	}

	/** One reconnect-window dial: the lower id only, and never over a dial already in flight.
	 * Called from the window's timers and when the signaling link comes back.
	 * @param {string} peerId */
	reconnectDial(peerId) {
		// a Peer off the signaling server cannot dial (its id still reads, keepPeerId): the `open` handler redials
		if (this.connections[peerId] || this.peer.disconnected || !(this.peer.id < peerId)) return;
		const conn = this.peer.connect(peerId, dialOptions(undefined, undefined, this.dialExtra(peerId))); // 55: dialExtra = the agent's kind
		if (!conn) return; // the signaling link is down: the next tick (or its return) redials
		/** @type {any} */ (conn).__dialedAt = Date.now();
		this.connections[peerId] = conn;
		conn.on('close', () => this.onConnClose(peerId, conn));
		conn.on('open', () => {
			log('info', 'net', 'reconnected', { peer: peerId });
			this.reconnecting.delete(peerId);
			this.inboundDials.delete(peerId);
			this.unavailableStrikes.delete(peerId);
			this.silentDrops.delete(peerId);
			this.awayPeers.delete(peerId);
			peers.update((value) => value);
			this.sendHandshake(conn, peerId, true, this.peer.id, { heal: true });
		});
		this.wireData(conn);
	}

	// The peer is really gone: full per-peer teardown (self-heal — a relayed
	// 'disconnected' never reaches the last peer in a 2-peer session, so voice
	// nodes / VR hands / flow cursors / env presets used to leak, 172). With
	// `relay` we ALSO tell the mesh: peers without a direct conn to them (partial
	// mesh) have no close of their own to witness — receivers with first-hand
	// state ignore it. checkLocks releases the peer's object locks.
	/** @param {string} peerId @param {boolean} relay */
	finalizeDisconnect(peerId, relay) {
		this.reconnecting.delete(peerId);
		this.unavailableStrikes.delete(peerId);
		this.silentDrops.delete(peerId);
		this.awayPeers.delete(peerId);
		forgetNodeSyncPeer(peerId);
		this.lastLeaveAt = Date.now();
		this.inboundDials.delete(peerId);
		const conn = this.connections[peerId];
		if (conn) {
			delete this.connections[peerId];
			try { conn.close(); } catch (e) { /* already dead */ }
		}
		this.openedPeers.delete(peerId);
		this.dropFastPeer(peerId); // 60 Q2
		handleDisconnected(peerId);
		clearPeerPreview(peerId); // 16-P5
		perfLivePeerGone(peerId); // 34 PF
		dropPeerLook(peerId); // P2
		dropPeerPlayMode(peerId); // 21-F3
		dropPeerScene(peerId); // P2b
		dropPeerVars(peerId); // 21-G4
		dropPeerColocation(peerId); // CO5
		dropPeerEnvPresets(peerId);
		dropPeerMaterialPresets(peerId);
		dropPeerHandModel(peerId);
		dropAgentView(peerId); // 55 A7
		agentChatPeerGone(peerId); // 56: an agent that left is away
		dropPeerFacts(peerId); // 55 A9
		dropPeerUnderlays(peerId); // 60 Q5
		if (relay) this.broadcast({ type: 'disconnected', peerId });
		checkLocks();
		peers.update((value) => value);
	}

	// CN (roadmap #14): leave the WHOLE session — close every peer connection and
	// run the full per-peer teardown, keep the local scene. Teardown is EXPLICIT
	// (not via close events): real WebRTC closes are often never signaled (the P-A
	// finding), and each conn is deleted from `connections` BEFORE close() so the
	// onConnClose stale-guard no-ops any late events. The signaling registration is
	// KEPT (no peer.destroy()) so our invite id stays valid; remote peers self-heal
	// via their own onConnClose + checkLocks sweep.
	leaveSession() {
		// tell everyone we're leaving ON PURPOSE — otherwise their transient-drop
		// reconnect redials our still-registered peer id and every attempt lands
		// here as a fresh approval request
		this.broadcast({ type: 'disconnected', peerId: this.peer.id });
		this.lastLeaveAt = Date.now(); // F-3: the closes below make peer-level noise
		this.unavailableStrikes.clear();
		this.silentDrops.clear();
		this.awayPeers.clear();
		forgetNodeSyncPeer();
		dropPeerUnderlays(null); // 60 Q5: every peer's shared reference images go with the session
		this.reconnecting.clear(); // pending retry timers see a cleared map and no-op
		this.inboundDials.clear();
		this.gracefulLeft.clear();
		this.wantsStateFrom.clear();
		// 60 Q2: every fast channel, sequence and owed keyframe goes with the session
		this.fastLinks.closeAll();
		this.staleFilter.clear();
		this.keyframer.clear();
		this.dialBackQueue.clear();
		// 55 A9: ALSO every peer still counted open whose conn already closed — one inside its
		// reconnect window (onConnClose deletes the conn and keeps it in `openedPeers` while the
		// backoff runs). Leaving then used to keep them: the pill read "connected" to nobody.
		for (const peerId of new Set([...Object.keys(this.connections), ...this.openedPeers])) {
			const conn = this.connections[peerId];
			delete this.connections[peerId];
			try { conn?.close(); } catch {}
			if (this.openedPeers.has(peerId)) {
				this.openedPeers.delete(peerId);
				handleDisconnected(peerId);
				clearPeerPreview(peerId); // 16-P5
				perfLivePeerGone(peerId); // 34 PF
				dropPeerLook(peerId); // P2
				dropPeerPlayMode(peerId); // 21-F3
				dropPeerScene(peerId); // P2b
				dropPeerVars(peerId); // 21-G4
				dropPeerColocation(peerId); // CO5
				dropPeerEnvPresets(peerId);
				dropPeerMaterialPresets(peerId);
				dropPeerHandModel(peerId);
			}
		}
		// roster -> self only (entry [0] is SELF); both approval queues cleared
		userdata.set(get(userdata).filter(u => u[0] === this.peer.id));
		waitingForApproval.set([]);
		pendingApprovals.set([]);
		// 27-H (audit M9): leaving a session must hand the microphone back. Nothing here
		// touched voice, so the tab's recording indicator stayed on and the device stayed
		// claimed after you left — for the life of the page.
		releaseMic();
		resetSession();
		resetModeration(); // 55 A9: a block list belongs to the session it was made in
		checkLocks();
		peers.update((value) => value);
	}

	// Broadcast to every OPEN outgoing connection. Guards conn.open (peerjs
	// silently drops pre-open sends) and isolates each send so one dead/half-open
	// conn can't throw mid-loop and starve the rest of the mesh (172).
	/**
	 * @param {any} payload
	 * @param {{fast?: boolean}} [opts] 60 Q2: `fast` = a latest-wins pose of a STREAM (a drag, a held
	 * object, a physics body, the avatar) that may ride the unreliable fast channel to peers that
	 * have one. Only pose types honour it (`poseKey`); everything else is reliable whatever it says.
	 */
	broadcast(payload, opts) {
		// 60 Q2: every pose carries its sequence number — batched, fast or reliable alike
		stampPose(payload);
		// 37 R1: inside a multi-object edit, room content is HELD and leaves as one envelope
		// when the edit closes (wireBatch.js); anything else flushes the held edit first
		if (holdForWireBatch(payload, ROOM_SCOPED.has(payload?.type), (out) => this.broadcast(out))) return;
		noteWire('out', payload);
		// TWO REASONS TO WITHHOLD, and they are different arguments about the same peer.
		//
		// P2b, BANDWIDTH: pose streams (`camera`, `vrhands`) are bytes nobody in another
		// scene can use - Player.svelte refuses to draw that avatar and Watch refuses to
		// follow it - and they are re-derived continuously, so the worst a skip costs is
		// one stale frame, covered by Scene.svelte's re-publish.
		//
		// A2, CORRECTNESS: `ROOM_SCOPED` is scene CONTENT, and an edit made in one scene
		// must not land in another. THE OLD COMMENT HERE ARGUED THE OPPOSITE - that
		// skipping scene state "would desync a peer who travels back", so the allowlist
		// had to stay deliberately tiny. That argument was correct and is now ANSWERED:
		// arriving in a room re-asks for full state (`resyncRoomPeers` ->
		// `requestFullState`, the same burst a fresh conn sends), so what was withheld
		// while a peer was away is delivered the moment it is back. Without that half
		// this gate WOULD be a staleness regression - they ship together, and the next
		// reader must not re-shrink this set on the strength of the sentence it replaced.
		//
		// The room test is only-on-evidence (`elsewhereThan`): an absent row or an empty
		// scene on either side sends, exactly as before.
		//
		// R22 round 32, THE THIRD REASON: a peer queued behind our own share-or-stash ask.
		// An edit we make while the merge question is open must not pre-empt its answer —
		// the whole point of the ask is that our work reaches them when we say so. Nothing
		// is lost, because the Share reply is a FULL sync of everything we hold. Only
		// ROOM_SCOPED is withheld: STREAM_TYPES keep flowing, since presence is how the
		// person deciding can see who they are deciding about.
		//
		// R22 ROUND 35, THE FOURTH: WE are editing a scene privately. The three tests above
		// all read the OTHER peer's row, and none of them can see this one — while private our
		// own name is a secret we are keeping, so `mine` is the empty string and an empty
		// `mine` gates NOTHING by the only-on-evidence rule. That is precisely the hole a
		// private scene would fall through: every edit would reach a room that cannot see the
		// scene it is being made in. ROOM_SCOPED only, exactly as the gate above: the pose
		// STREAMS keep flowing (private is not offline, and the far side draws nothing anyway
		// — its own `elsewhereThan` reads our private row as elsewhere).
		const roomScoped = ROOM_SCOPED.has(payload?.type);
		// 60 Q2: which peers took it unreliably (they are owed the trailing keyframe)
		const key = poseKey(payload);
		const fast = !!opts?.fast && key !== null && fastChannelEnabled();
		/** @type {string | null} */
		let text = null;
		/** @type {string[]} */
		const fastPeers = [];
		Object.keys(this.connections).forEach(peerId => {
			const conn = this.connections[peerId];
			if (!conn) return;
			if (!conn.open) {
				// scatter-sync: an APPROVED joiner whose dial-back is still opening gets this after
				// its handshake instead of never (dialBackQueue.js). Room content only — streams
				// are re-derived every frame, and the rest has handshake replies of its own.
				if (roomScoped && this.approvedDialBacks.has(peerId)) this.dialBackQueue.hold(peerId, payload);
				return;
			}
			if (this.withholdFrom(peerId, payload)) return;
			if (fast && this.fastLinks.isOpen(peerId)) {
				if (text === null) {
					try {
						text = JSON.stringify(payload);
					} catch {
						text = '';
					}
				}
				if (text && this.fastLinks.trySend(peerId, text)) {
					fastPeers.push(peerId);
					return;
				}
			}
			this.sendTo(peerId, conn, payload);
		});
		if (key !== null) {
			if (fastPeers.length) this.keyframer.noteFast(key, payload, fastPeers);
			else this.keyframer.noteReliable(key);
		}
	}

	/**
	 * The per-peer half of `broadcast`'s gate (the reasons are written above it), shared with
	 * the dial-back flush and the 60 Q2 trailing keyframe, so a message sent later is judged by
	 * the same rules when it finally goes.
	 * @param {string} peerId @param {any} payload @returns {boolean} true = do not send
	 */
	withholdFrom(peerId, payload) {
		const roomScoped = ROOM_SCOPED.has(payload?.type);
		const gated = STREAM_TYPES.has(payload?.type) || roomScoped;
		if (roomScoped && amPrivate()) return true;
		// R22 round 36 (rooms): THE HOST, because the unnamed world is a room with an
		// identity now and only the host's row can say which. `null` is a real answer here
		// (we are hosting, so the unnamed room is OURS) — it is OMITTING the argument that
		// would ask round 35's question, which is why it is passed unconditionally.
		if (gated && elsewhereThan(get(peerScenes), myScene()?.scene ?? '', peerId, get(sessionHost))) return true;
		if (roomScoped && gateHolds(peerId)) return true;
		return false;
	}

	/** @param {string} peerId @param {any} conn @param {any} payload */
	sendTo(peerId, conn, payload) {
		try {
			// 37 R1: a peer that never said `wb: 1` gets the envelope's items one by one
			if (payload?.type === 'batch' && !this.wireBatchPeers.has(peerId))
				for (const item of payload.items) conn.send(item);
			else conn.send(payload);
		} catch (err) {
			log('error', 'net', 'send failed', { peer: peerId, error: String(err) });
		}
	}

	/**
	 * 60 Q2: the trailing keyframe — a stream's LAST pose, re-sent on the reliable conn to the peers
	 * that got it unreliably, with its original `ps` (a duplicate where the datagram arrived).
	 * Re-checks the gates `broadcast` applies: the peer may have walked into another scene since.
	 * @param {any} payload @param {string[]} peerIds
	 */
	sendReliableTo(payload, peerIds) {
		for (const peerId of peerIds) {
			const conn = this.connections[peerId];
			if (!conn || !conn.open) continue;
			if (this.withholdFrom(peerId, payload)) continue;
			this.sendTo(peerId, conn, payload);
		}
	}

	/**
	 * 60 Q2: open the fast channel to `conn.peer` on `conn`'s RTCPeerConnection (idempotent).
	 * Answers true when it created or already had one there; false when this device has the
	 * channel switched off or the conn exposes no RTCPeerConnection (the reliable path carries on).
	 * @param {any} conn @returns {boolean}
	 */
	openFastChannel(conn) {
		if (!fastChannelEnabled() || !conn?.peer || typeof conn.__tpReceive !== 'function') return false;
		return this.fastLinks.open(conn.peer, conn, conn.__tpReceive);
	}

	/** 60 Q2: forget a peer's fast channel, its sequence numbers and its owed keyframes @param {string} peerId */
	dropFastPeer(peerId) {
		this.fastLinks.close(peerId);
		this.staleFilter.dropPeer(peerId);
		this.keyframer.dropPeer(peerId);
	}

	/** @param {string} message @param {string} [type] */
	sendMessage(message, type) {
		if(message.startsWith('/')) {
			sceneCommand(message);
		} else {
			if(type === undefined) type = 'sent';
			// 37 R15: a stable id (the history merge keys on it) and the sender's clock
			const at = Date.now();
			const id = this.peer.id + '-' + at.toString(36) + '-' + Math.random().toString(36).slice(2, 7);
			addMessage({message: message, type: type, sender: this.peer.id, id, at});
			this.broadcast({message: message, type: type, sender: this.peer.id, id, at});
		}
	}

	/** @param {any} data @param {{fast?: boolean}} [opts] 60 Q2: see `broadcast` */
	send(data, opts) {
		// viewer perms: a viewer's object CREATIONS never leave this machine — mark
		// them local-only + warn, and skip the broadcast (peers drop them anyway).
		if (gateCreationBroadcast(data)) return;
		if(data.type == 'create')
		this.sendMessage('created a ' + data.command.split(' ')[1], 'info');
		this.broadcast(data, opts);
	}
}

/**
 * R22 round 33 — WHAT A CONSENTED OBJECTS REPLY OWES BESIDE THE OBJECTS.
 *
 * The five scene singletons below are PUSHED by `sendHandshake` and never requested:
 * only `scenepost` has a `get*` of its own. So anything the share-or-stash gate DROPS
 * from them (round 32 holds both directions) is gone for good — `resolveGate`'s refetch
 * can ask for objects, nodes, annotations, joints, anim, huds and shader graphs, and has
 * nothing to ask for the sky, the music, the gravity or the game. The peer who answers
 * the question is left in the stock studio look while the room has a sunset, until
 * somebody happens to touch a slider.
 *
 * Sending them with the reply closes that: an objects reply is "here is my world", and
 * the world's look is part of it. Every one is latest-wins on its own stamp, so an
 * ordinary ungated reply just repeats what the handshake said a moment before.
 *
 * Straight down the peer's own conn, the way `sendObjects` answers — never `broadcast`,
 * which would state our look at the whole mesh because one peer asked.
 *
 * Registered rather than imported: `sessions.js` is in the history family and may not
 * reach environment/scenePost/gameSync statically (the `registerToneMappingOwner`
 * shape). Declared as a function statement, so the registration below is safe wherever
 * it sits in this file. @param {string} peerId
 */
function pushWorldState(peerId) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn?.open) return;
	conn.send(environmentState());
	conn.send(musicState());
	conn.send(scenePhysicsState());
	// L-C: one per post DOCUMENT — the scene look and any camera looks
	for (const state of scenePostStates()) conn.send(state);
	conn.send(gameStatePayload());
	conn.send(kitPayload());
	for (const msg of kitEntityPayloads()) conn.send(msg);
	for (const msg of behaviourPayloads()) conn.send(msg);
}
registerWorldStatePush(pushWorldState);

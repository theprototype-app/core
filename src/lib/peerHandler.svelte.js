import Peer from 'peerjs';
import { backoffDelay } from '$lib/netBackoff';
import { sceneCommand, lockRestore, checkLocks, createObject, sendObjects, deleteObject, colorObject, createLoader, userData, handleDisconnected, specator, cameraSettings, objectParameters, applyClearScene } from './commandsHandler.svelte';
import { gateCreationBroadcast } from './objectPermissions';
import { createGeometry, createLight, createGroup, changeName, moveGeometry, lockGeometry, moveCamera } from '$lib/geometries.svelte';
import { sendNodes, applyNodesSnapshot, applyNodeSync, createFlowNode, moveFlowNode, updateFlowNodeData, deleteFlowNodes, createFlowEdge, deleteFlowEdges, applyFlowCursor } from '$lib/nodesHandler';
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
import { initVoiceChat, attachVoiceToPeer, voicePeerConnected } from '$lib/voiceChat';
import { resolvePeerOptions, describePeerServer, peerServerStatus, parseInviteHash, decodeInviteServer, applyInviteServerOverride } from '$lib/peerServer';
import { sessionHost, markPeerJoined, resetSession } from '$lib/connectionState';
import { canApply, getAuthProvider, dispatchCloudMessage, rolesInfo } from '$lib/cloudHooks';
import { applyAnnotation, applyAnnotationsSnapshot, sendAnnotations } from '$lib/annotationsHandler';
import { applyPing } from '$lib/ping';
import { applyAssetFile, answerAssetRequest } from '$lib/assetShare';
import { applyRemoteCameraPreview, clearPeerPreview, sendCameraPreviewState } from '$lib/cameraPreview';
// 21-F3: play-mode PRESENCE, the campreview shape — a tiny per-peer message, a reply
// riding the getmodulestate request, and a drop on disconnect (golden rule 3).
import { applyRemotePlayMode, dropPeerPlayMode, sendPlayModeState } from '$lib/gamePresence';
import { applyModuleMessage, moduleVersions, checkModuleVersions, checkPeerAppVersion, sendModuleStates, applyModuleStates } from '$lib/moduleSDK';
import { APP_VERSION, COMMIT_SHA } from '$lib/version.js';
import { applyLockRequest, applyUnlock, applyLockDenied } from '$lib/lockControl';
import { applyDrawLive, applyDrawEnd } from '$lib/drawMode';
import { applySimulate, physicsExternalMove, applyThrow } from '$lib/physics';
import { noteRemoteMove } from '$lib/moveSmoothing';
import { applyJointCreate, applyJointDelete, applyJointsSnapshot, sendJoints } from '$lib/joints';
import { applyAnimData, applyAnimPlay, applyAnimationsSnapshot, sendAnimations } from '$lib/animationPreview';
import { applyHandModel, handModelState, dropPeerHandModel } from '$lib/handModels';
import { applyRemoteEnvironment, environmentState, envPresetsState, applyRemoteEnvPresets, dropPeerEnvPresets } from '$lib/environment';
import { applyRemoteMusic, musicState } from '$lib/sceneMusic';
import { applyRemoteScenePhysics, scenePhysicsState } from '$lib/scenePhysics';
import { applyRemoteScenePost, scenePostStates, sendScenePost } from '$lib/scenePost';
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
import { applySessionProposal, applySessionAnswer, deferUntilShareChoice, localSceneCount } from '$lib/sessions';
import { applyRemoteGeometry } from '$lib/geometryEdit';
import { applyLightTarget } from '$lib/lightParams';
import { applyObjectFile } from '$lib/animatedImports';
import { lockedObjects, selectedObject, peerHands, objectsGroup } from '../stores/sceneStore';
import { addMessage, peers, userdata, pendingApprovals, waitingForApproval, showToast } from '../stores/appStore';
import { get } from 'svelte/store';

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


export class PeerConnection {
	constructor(id, updateIdFn) {
		this.updateIdFn = updateIdFn;
		this.myId = id;
		this.reconnectAttempts = 0;
		this.hasOpened = false;   // the signaling link has opened at least once
		this.didFallback = false; // we've already switched to the public cloud
		this.idRetries = 0;       // fresh-id attempts after an id collision (B5)

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
		/** @type {Set<string>} peers that ANNOUNCED they were leaving (the
		 * `disconnected` self-message) — their close is expected, don't redial */
		this.gracefulLeft = new Set();
		/** @type {Set<string>} peers we mean to exchange FULL STATE with — the
		 * host we're joining (requestConnect) or a joiner we approved. Mesh-fill
		 * dials (the `hosts` flow) don't request state, and an adopted inbound
		 * conn requests it only when it stands in for one of these (B5) */
		this.wantsStateFrom = new Set();

		// CN-3: an invite link can pin the signaling world (#A1B2C~srv=…). Parse it
		// HERE, before resolvePeerOptions runs — the peer.on('open') hash flow below
		// fires too late for server selection. Strip only the ~srv tail so the
		// auto-connect flow keeps working on the bare id.
		if (typeof location !== 'undefined' && location.hash.includes('~')) {
			const { peerId: hashPeer, srv } = parseInviteHash(location.hash);
			if (srv) {
				const ov = decodeInviteServer(srv);
				if (ov) {
					applyInviteServerOverride(ov);
					console.log('invite link pinned the signaling server:', srv);
				}
			}
			location.hash = hashPeer ? '#' + hashPeer : '';
		}

		// A non-production hostname (localhost etc.) means the local dev signaling
		// server; production consults the peer-server Settings (default self-hosted
		// with public fallback / user's custom server / public cloud).
		const isLocalDev = !/(\.io|\.app)$/i.test(location.hostname);

		const createPeerForMode = (/** @type {boolean} */ forcePublic) => {
			const { options, canFallback } = resolvePeerOptions({ isLocalDev, forcePublic });
			this.canFallback = canFallback;
			// Publish the resolved server for the Connect indicator (I5); carry the
			// fallback flag once we've switched to the public cloud.
			peerServerStatus.set({ ...describePeerServer({ isLocalDev, forcePublic }), didFallback: this.didFallback });
			this.peer = new Peer(this.myId, options);
		};

		// The pinned self-hosted server never opened -> rebuild against the public
		// PeerJS cloud and re-wire. Default mode only; custom/public never fall back.
		const fallbackToPublic = () => {
			this.didFallback = true;
			this.canFallback = false;
			showToast('Your peer server is unreachable - switching to the public PeerJS server.');
			try { this.peer.destroy(); } catch (e) { /* already gone */ }
			createPeerForMode(true);
			attachVoiceToPeer(this); // rebind the incoming-call handler to the new peer
			wire();
		};

		const wire = () => {
		this.peer.on('open', (id) => {
			console.log(id);
			this.hasOpened = true;
			this.reconnectAttempts = 0; // a fresh/re-established server link resets the backoff
			if (this.updateIdFn) this.updateIdFn(id);
			if (!window.location.hash.slice(1)) return;
			let connect = window.location.hash.slice(1).toLocaleLowerCase()
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
			this.connectToPeer(connect, true);
			window.location.hash = '';	
		});

		this.peer.on('close', function() { console.log('server closed') });

		// Surface signaling-server problems to the user. Reconnect on a bounded
		// exponential backoff instead of hammering reconnect() immediately (172).
		this.reconnectAttempts = 0;
		this.peer.on('disconnected', () => {
			console.log('server disconnected');
			if (this.peer.destroyed) return;
			this.reconnectAttempts++;
			const delay = backoffDelay(this.reconnectAttempts, { base: 800, max: 5 });
			if (delay === null) {
				showToast('Could not reach the peer server. Please reload the page.');
				return;
			}
			showToast('Lost connection to the peer server, reconnecting... (attempt ' + this.reconnectAttempts + ')');
			setTimeout(() => {
				if (!this.peer.destroyed && this.peer.disconnected) this.peer.reconnect();
			}, delay);
		});
		this.peer.on('error', (err) => {
			console.log('peer error: ' + err.type, err);
			// Pinned self-hosted server never opened -> retry on the public cloud
			// (default mode only; custom/public keep canFallback false).
			if (!this.hasOpened && this.canFallback && !this.didFallback &&
				['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
				fallbackToPublic();
				return;
			}
			// B5: session ids are 5 hex chars = 20 bits, so a birthday collision is
			// likely well before a million concurrent sessions (~1k live ids gives a
			// ~40% chance of one). The id is generated fresh on every page load and
			// never persisted, so nothing is pinned to it before the link opens —
			// take a new one instead of making the user reload. Lengthening the id
			// was assumed to be a compat break; it isn't, but it also isn't needed.
			if (err.type === 'unavailable-id' && !this.hasOpened && this.idRetries < 3) {
				this.idRetries++;
				this.myId = createPeer();
				console.log('session id collided — retrying as ' + this.myId);
				try { this.peer.destroy(); } catch (e) { /* already gone */ }
				createPeerForMode(this.didFallback);
				attachVoiceToPeer(this); // rebind the incoming-call handler to the new peer
				wire();
				return;
			}
			if (err.type === 'peer-unavailable') {
				showToast('Peer is unreachable. Check the ID and ask them to stay online.');
			} else if (err.type === 'unavailable-id') {
				showToast('Your session ID is already in use. Please reload the page.');
			} else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
				showToast('Cannot reach the peer server. Retrying...');
			} else {
				showToast('Connection error: ' + err.type);
			}
		});

		this.peer.on('connection', handleConnection.bind(this));
		};

		createPeerForMode(false);
		initVoiceChat(this);
		wire();

		// Courtesy goodbye on tab close / refresh (best-effort). Without it,
		// peers treat the close as a transient drop and spend the whole backoff
		// window redialing — and if the leaver's page is still open (leaveSession
		// keeps the peer registration so the invite id stays valid), every redial
		// would land there as a fresh approval request.
		if (typeof window !== 'undefined') {
			window.addEventListener('pagehide', () => {
				try { this.broadcast({ type: 'disconnected', peerId: this.peer.id }); } catch (e) { /* going down anyway */ }
			});
		}

		// Wire the message dispatcher onto a connection. Historically only INBOUND
		// conns listened for data; with the adopted-inbound channel (see below) a
		// peer may send back over OUR outgoing conn, so those wire it too (P-A).
		this.wireData = handleData.bind(this);

		function handleConnection(conn) {

			// Update approval status on expected connections
			let waiting = get(waitingForApproval);
			waiting.forEach(element => {
				if(element[0] === conn.peer) {
					// Clear waiting list for approved peers
					waiting = waiting.filter(e => e[1] !== 'approved');
					element[1] = 'approved';

					// CN: OUR outbound request was approved — that peer is the session
					// host (first approval wins; null while hosting ourselves).
					if (!get(sessionHost)) sessionHost.set(conn.peer);

					// Show approved toast message
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
			if (!found) {
				const auth = getAuthProvider();
				try {
					if (auth && typeof auth.authorize === 'function' && auth.authorize(conn.peer)) {
						found = true;
						// AUTO-APPROVE == the manual Approve: whitelist the peer, broadcast the
						// roster, and DIAL BACK. The joiner only leaves its "waiting for
						// approval" state on an INCOMING connection from us, so without the
						// dial-back it waits forever (the autoaccept join bug).
						const roster = /** @type {any[]} */ (get(userdata));
						if (!roster.some((/** @type {any} */ e) => e[0] === conn.peer)) {
							roster.push([conn.peer, '', '']);
							userdata.set(roster);
						}
						get(peers).send({ type: 'userdata', userdata: get(userdata) });
						get(peers).connectToPeer(conn.peer, true);
					}
				} catch (e) {
					console.error('cloud auth provider threw:', e);
				}
			}

			if (!found) {
				// If peer is not found, add it to the pending approvals
				var approvals = get(pendingApprovals);
				if (!approvals.some(toast => toast.peerId === conn.peer)) {
					approvals.push({ peerId: conn.peer });
					pendingApprovals.set(approvals);
				}
				conn.close();
			}

			// ADOPT an open inbound conn as our send channel when our outgoing one
			// is dead (P-A find): the host closes the joiner's original conn before
			// approving, the close is often never signaled, and the fresh reopen can
			// wedge mid-ICE — leaving the JOINER unable to send ANYTHING to the host.
			// DataConnections are bidirectional, and this one is provably alive.
			conn.on('open', () => {
				const existing = this.connections[conn.peer];
				if (existing?.open) return; // stable outgoing conn stays preferred
				console.log('adopting inbound connection from ' + conn.peer + ' as the send channel');
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
				const wantState = this.wantsStateFrom.has(conn.peer) || this.reconnecting.has(conn.peer);
				this.sendHandshake(conn, conn.peer, wantState, this.peer.id);
			});

			this.wireData(conn);
		}

		/** @this {any} @param {any} conn */
		function handleData(conn) {
			conn.on('data', (data) => {
				// M1a (open-core): the ONE receive-side capability gate. Default allows
				// everything (byte-identical OSS behavior); a cloud plugin's provider
				// drops disallowed message types from a peer (e.g. a viewer's mutations).
				if (data && !canApply(conn.peer, data.type)) return;
				// console.log(data);
				if(data.type == 'cloud') {
					// open-core (M1): the cloud plugin's own replicated channel
					dispatchCloudMessage(conn.peer, data.payload);
				} else if(data.type == 'hosts') {
					console.log('Connecting to received hosts');
					data.hosts.forEach( id =>
					{
						// mesh fill: connect, but DON'T request full state — the scene
						// is one shared state and we already pull it from the peer we
						// joined. Requesting it from everyone made a joiner download
						// N-1 copies of the same scene (measured 3x at N=4), and the
						// mirror-image requests hit every existing peer too (B5).
						this.connectToPeer(id, false);
					}
					);
				} else if(data.type == 'sent') {
					addMessage({message: data.message, type: 'received', sender: data.sender});
				} else if(data.type == 'info') {
					addMessage({message: data.message, type: data.type, sender: data.sender});
				} else if(data.type == 'create') {
					createGeometry(data.command, data.uuid);
				} else if(data.type == 'light') {
					createLight(data.command, data.uuid);
				} else if(data.type == 'group') {
					createGroup(data.command, data.uuid, data.group, data.name, data.groupparent, data.pos, data.rot, data.scale);
				} else if(data.type == 'name') {
					changeName(data.uuid, data.name);
				} else if(data.type == 'move') {
					// the pose BEFORE the write, so a remote physics stream can be eased
					// across rather than stepped through (moveSmoothing; ~10 Hz on the wire
					// looked like 10 fps on the watching peer)
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
				} else if(data.type == 'simulate') {
					applySimulate(data);
				} else if(data.type == 'jointcreate') {
					applyJointCreate(data);
				} else if(data.type == 'jointdelete') {
					applyJointDelete(data);
				} else if(data.type == 'joints') {
					applyJointsSnapshot(data.joints);
				} else if(data.type == 'getjoints') {
					sendJoints(data.sender);
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
					sendAnimations(data.sender);
				} else if(data.type == 'handmodel') {
					applyHandModel(data);
				} else if(data.type == 'environment') {
					applyRemoteEnvironment(data);
				} else if(data.type == 'music') {
					applyRemoteMusic(data);
				} else if(data.type == 'scenephysics') {
					applyRemoteScenePhysics(data);
				} else if(data.type == 'scenepost') {
					// L1/L2: the authored post stack, latest-wins on changedAt. An effect
					// KIND we don't know is kept and skipped at render time, never dropped.
					applyRemoteScenePost(data);
				} else if(data.type == 'getscenepost') {
					sendScenePost(data.sender);
				} else if(data.type == 'shadergraph') {
					applyRemoteShaderGraph(data);
				} else if(data.type == 'shadergraphdelete') {
					applyRemoteShaderGraphDelete(data);
				} else if(data.type == 'shadergraphs') {
					applyRemoteShaderGraphs(data);
				} else if(data.type == 'getshadergraphs') {
					sendShaderGraphs(data.sender);
				} else if(data.type == 'hud') {
					// A2: the authored HUD document, latest-wins on changedAt. An element KIND
					// we don't know is kept and skipped at render, never dropped. The RUNTIME
					// half is derived from the replicated flow graph and never sent.
					applyRemoteHud(data);
				} else if(data.type == 'huddelete') {
					applyRemoteHudDelete(data);
				} else if(data.type == 'huds') {
					applyRemoteHuds(data);
				} else if(data.type == 'gethuds') {
					sendHuds(data.sender);
				} else if(data.type == 'hudvalue') {
					// 21-D4: a SHARED input's value - the one runtime HUD message, because what a
					// player dragged is the only HUD state a peer cannot derive for itself.
					// Latest-wins per element on a monotonic stamp.
					applyRemoteHudValue(data);
				} else if(data.type == 'hudvalues') {
					applyRemoteHudValues(data);
				} else if(data.type == 'gethudvalues') {
					sendHudValues(data.sender);
				} else if(data.type == 'game') {
					// 21-D6: the game state, a latest-wins singleton like scenephysics/music.
					// Every peer then reacts LOCALLY (screens, the start camera) - the camera
					// itself is never on the wire.
					applyRemoteGameState(data);
				} else if(data.type == 'getgame') {
					sendGameState(data.sender);
				} else if(data.type == 'envpresets') {
					applyRemoteEnvPresets(data);
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
					applyLockRequest(data);
				} else if(data.type == 'unlock') {
					applyUnlock(data);
				} else if(data.type == 'lockdenied') {
					applyLockDenied(data);
				} else if(data.type == 'lock') {
					lockGeometry(data.uuid, data.peerId, data.uuids);
				} else if(data.type == 'locked') {
					lockRestore(data.lockeditems);
				} else if(data.type == 'userdata') {
					userData(data.userdata);
				} else if(data.type == 'specator') {
					specator(data, data.watching);
				} else if(data.type == 'cameraSettings') {
					cameraSettings(data, data.vrmode);
				} else if(data.type == 'camera') {
					moveCamera(data);
				} else if(data.type == 'getobjects') {
					// share-or-stash (50): the reply may wait for the user's choice
					deferUntilShareChoice('objects', data.sender, data.count ?? 0);
				} else if(data.type == 'objectfile') {
					applyObjectFile(data);
				} else if(data.type == 'object') {
					createObject(data, data.uuids, data.override, data.groupuuid, data.pos, data.rot, data.scale);
				} else if(data.type == 'objectParameters') {
					objectParameters(data);
				} else if(data.type == 'duplicate') {
					applyRemoteDuplicate(data.sourceUuid, data.uuids, data.name, data.pos);
				} else if(data.type == 'clearscene') {
					applyClearScene(data.peerId);
				} else if(data.type == 'delete') {
					deleteObject(data.uuid);
				} else if(data.type == 'color') {
					colorObject(data.uuid, data.color, data.near, data.far);
				} else if(data.type == 'loading') {
					createLoader(data.count, data.uuids);
				} else if(data.type == 'disconnected') {
					if (data.peerId === conn.peer) {
						// the peer says goodbye ITSELF (leaveSession / tab close): tear
						// down now — the close that follows is often never signaled (the
						// P-A finding), and marking it graceful stops the transient-drop
						// reconnect from redialing someone who left on purpose (B5)
						this.gracefulLeft.add(data.peerId);
						if (this.openedPeers.has(data.peerId)) this.finalizeDisconnect(data.peerId, false);
					} else if (this.connections[data.peerId] || this.reconnecting.has(data.peerId)) {
						// a relayed rumor about a peer we have FIRST-HAND state on — our
						// own conn (or reconnect window) decides, a third party doesn't.
						// Honoring these evicted live peers meshwide during formation (B5).
					} else {
						handleDisconnected(data.peerId);
						dropPeerPlayMode(data.peerId); // 21-F3
						dropPeerEnvPresets(data.peerId);
						dropPeerHandModel(data.peerId);
					}
				} else if(data.type == 'getnodes') {
					deferUntilShareChoice('nodes', data.sender);
				} else if(data.type == 'nodes') {
					applyNodesSnapshot(data.nodes, data.edges, data.graphs);
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
						applyNodeTrigger(data.id, data.t, false); // 134: shared-timestamp pulse
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
				} else if(data.type == 'getasset') {
					// a peer is missing a hash we may hold — answer over our
					// stable outgoing connection to them
					answerAssetRequest(conn.peer, data);
				} else if(data.type == 'module') {
					applyModuleMessage(data);
				} else if(data.type == 'modules') {
					checkModuleVersions(data.versions);
					checkPeerAppVersion(data.appVersion);
				} else if(data.type == 'getmodulestate') {
					sendModuleStates(data.sender);
					sendCameraPreviewState(); // 16-P5: ride the same late-joiner request
					sendPlayModeState(); // 21-F3: ...and so does play-mode presence
				} else if(data.type == 'playmode') {
					// 21-F3: presence only — "X is in play mode". ADDITIVE: the message goes out
					// only while PLAYING, so an absent peer (or one on an older build that never
					// sends it) reads as an editor, which is what it is.
					applyRemotePlayMode(data);
				} else if(data.type == 'modulestate') {
					applyModuleStates(data.states);
				} else if(data.type == 'campreview') {
					// 16-P5: presence only — "X is previewing camera Y" (peers may join it)
					applyRemoteCameraPreview(data);
				} else if(data.type == 'annotation') {
					applyAnnotation(data);
				} else if(data.type == 'annotations') {
					applyAnnotationsSnapshot(data.annotations);
				} else if(data.type == 'getannotations') {
					sendAnnotations(data.sender);
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
				} else if(data.type == 'vrhands') {
					peerHands.update((map) => ({
						...map,
						[data.peerId]: { left: data.left, right: data.right, active: data.active !== false, ts: Date.now() }
					}));
				} else if(data.startsWith('/')) {
					sceneCommand(data);
				}
			}
			);
		}
	}

	// Send the initial handshake (locks, known hosts, whitelist, object/node sync requests).
	// Must only be called once the connection is open — messages sent earlier are dropped by peerjs.
	/** @param {any} conn @param {string} peerId @param {boolean} getobjects @param {string} id */
	sendHandshake(conn, peerId, getobjects, id) {
		// a conn opened to them — whatever goodbye they once sent is history
		this.gracefulLeft.delete(peerId);
		let hosts = [id];
		Object.keys(this.connections).forEach(element => {
			if(element != peerId)
			hosts.push(element)
		});
		console.log("sending to " + peerId + "  remote " + hosts)
		let locks = [...locked];
		if(typeof selected.uuid != 'undefined' && selected.uuid) locks.push([id, selected.uuid]);
		conn.send({type: 'locked', lockeditems: locks})
		conn.send({type: 'hosts', hosts: hosts})
		conn.send({type: 'userdata', userdata: users})
		// V3: app version rides the modules handshake — old peers ignore the extras,
		// old senders omit them (checkPeerAppVersion is silent on absence)
		conn.send({type: 'modules', versions: moduleVersions(), appVersion: APP_VERSION, sha: COMMIT_SHA})
		conn.send(environmentState())
		conn.send(musicState())
		conn.send(scenePhysicsState())
		// L-C: one per post DOCUMENT — the scene look and any camera looks
		for (const state of scenePostStates()) conn.send(state)
		conn.send(handModelState())
		conn.send(envPresetsState())
		if (getobjects) conn.send({type: 'getobjects', sender: this.peer.id, count: localSceneCount()})
		if (getobjects) conn.send({type: 'getnodes', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getannotations', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getjoints', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getanim', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getscenepost', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getshadergraphs', sender: this.peer.id})
		if (getobjects) conn.send({type: 'gethuds', sender: this.peer.id})
		if (getobjects) conn.send({type: 'gethudvalues', sender: this.peer.id})
		// singleton PUSH, like environmentState/scenePhysicsState above
		conn.send(gameStatePayload())
		// module state is the one PER-PEER payload in the get* family (each peer
		// answers with its OWN states — e.g. campreview presence), so it can't be
		// deduped down to the host like the shared-scene requests above (B5)
		conn.send({type: 'getmodulestate', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getnodedefs', sender: this.peer.id})
		// join them into the voice mesh if our mic is live
		voicePeerConnected(peerId);
	}

	connectToPeer(peerId, getobjects = true, id = this.peer.id) {
		// remember the intent: if this dial dies and an adopted inbound conn takes
		// its place, the adoption still owes them the full-state requests (B5)
		if (getobjects) this.wantsStateFrom.add(peerId);
		if (!this.connections[peerId]) {
			console.log("Connecting to " + peerId);
            const conn = this.peer.connect(peerId);
            // peer.connect returns undefined when the signaling link is down
            // (disconnected peer) — bail instead of throwing on conn.on below (CN)
            if (!conn) {
                console.log('connect to ' + peerId + ' failed: signaling link is down');
                showToast('Cannot reach the signaling server - the connection request was not sent.');
                return;
            }
            /** @type {any} */ (conn).__dialedAt = Date.now();
            this.connections[peerId] = conn;

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
		console.log('Restoring connection: ' + peerId + (attempt ? ' (attempt ' + (attempt + 1) + ')' : ''));
		// drop the stale never-opened conn FIRST — left in peerjs's per-peer
		// bookkeeping it can wedge the fresh negotiation (offer never starts)
		const stale = this.connections[peerId];
		if (stale && !stale.open) {
			try { stale.close(); } catch {}
			delete this.connections[peerId];
		}
		const conn = this.peer.connect(peerId);
		if (!conn) {
			console.log('restore to ' + peerId + ' failed: signaling link is down');
			return;
		}
		/** @type {any} */ (conn).__dialedAt = Date.now();
		this.connections[peerId] = conn;
		conn.on('close', () => this.onConnClose(peerId, conn));
		conn.on('open', () => {
			console.log('Connection to ' + peerId + ' restored');
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
				console.log('restore to ' + peerId + ' gave up after ' + (attempt + 1) + ' attempts');
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
		if (this.gracefulLeft.delete(peerId)) {
			this.finalizeDisconnect(peerId, false);
			return;
		}
		console.log('connection to ' + peerId + ' dropped without a goodbye - trying to get them back');
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
			this.reconnecting.delete(peerId);
			this.finalizeDisconnect(peerId, true);
			return;
		}
		this.reconnecting.set(peerId, attempt);
		setTimeout(() => {
			if (this.reconnecting.get(peerId) !== attempt) return; // superseded or cancelled
			if (!this.openedPeers.has(peerId)) { this.reconnecting.delete(peerId); return; } // torn down elsewhere
			const existing = this.connections[peerId];
			if (existing?.open) { this.reconnecting.delete(peerId); return; } // healed (redial or adopted inbound)
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
			if (!this.connections[peerId] && !lastCheck && this.peer.id < peerId) {
				const conn = this.peer.connect(peerId);
				if (conn) {
					/** @type {any} */ (conn).__dialedAt = Date.now();
					this.connections[peerId] = conn;
					conn.on('close', () => this.onConnClose(peerId, conn));
					conn.on('open', () => {
						console.log('reconnected to ' + peerId);
						this.reconnecting.delete(peerId);
						peers.update((value) => value);
						this.sendHandshake(conn, peerId, true, this.peer.id);
					});
					this.wireData(conn);
				}
			}
			this.scheduleReconnect(peerId, attempt + 1);
		}, delay);
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
		const conn = this.connections[peerId];
		if (conn) {
			delete this.connections[peerId];
			try { conn.close(); } catch (e) { /* already dead */ }
		}
		this.openedPeers.delete(peerId);
		handleDisconnected(peerId);
		clearPeerPreview(peerId); // 16-P5
		dropPeerPlayMode(peerId); // 21-F3
		dropPeerEnvPresets(peerId);
		dropPeerHandModel(peerId);
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
		this.reconnecting.clear(); // pending retry timers see a cleared map and no-op
		this.gracefulLeft.clear();
		this.wantsStateFrom.clear();
		for (const peerId of Object.keys(this.connections)) {
			const conn = this.connections[peerId];
			delete this.connections[peerId];
			try { conn.close(); } catch {}
			if (this.openedPeers.has(peerId)) {
				this.openedPeers.delete(peerId);
				handleDisconnected(peerId);
				clearPeerPreview(peerId); // 16-P5
				dropPeerPlayMode(peerId); // 21-F3
				dropPeerEnvPresets(peerId);
				dropPeerHandModel(peerId);
			}
		}
		// roster -> self only (entry [0] is SELF); both approval queues cleared
		userdata.set(get(userdata).filter(u => u[0] === this.peer.id));
		waitingForApproval.set([]);
		pendingApprovals.set([]);
		resetSession();
		checkLocks();
		peers.update((value) => value);
	}

	// Broadcast to every OPEN outgoing connection. Guards conn.open (peerjs
	// silently drops pre-open sends) and isolates each send so one dead/half-open
	// conn can't throw mid-loop and starve the rest of the mesh (172).
	/** @param {any} payload */
	broadcast(payload) {
		Object.keys(this.connections).forEach(peerId => {
			const conn = this.connections[peerId];
			if (!conn || !conn.open) return;
			try {
				conn.send(payload);
			} catch (err) {
				console.log('send to ' + peerId + ' failed', err);
			}
		});
	}

	/** @param {string} message @param {string} [type] */
	sendMessage(message, type) {
		if(message.startsWith('/')) {
			sceneCommand(message);
		} else {
			if(type === undefined) type = 'sent';
			addMessage({message: message, type: type, sender: this.peer.id});
			this.broadcast({message: message, type: type, sender: this.peer.id});
		}
	}

	/** @param {any} data */
	send(data) {
		// viewer perms: a viewer's object CREATIONS never leave this machine — mark
		// them local-only + warn, and skip the broadcast (peers drop them anyway).
		if (gateCreationBroadcast(data)) return;
		if(data.type == 'create')
		this.sendMessage('created a ' + data.command.split(' ')[1], 'info');
		this.broadcast(data);
	}
}

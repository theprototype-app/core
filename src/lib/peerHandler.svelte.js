import Peer from 'peerjs';
import { backoffDelay } from '$lib/netBackoff';
import { sceneCommand, lockRestore, checkLocks, createObject, sendObjects, deleteObject, colorObject, createLoader, userData, handleDisconnected, specator, cameraSettings, objectParameters, applyClearScene } from './commandsHandler.svelte';
import { createGeometry, createLight, createGroup, changeName, moveGeometry, lockGeometry, moveCamera } from '$lib/geometries.svelte';
import { sendNodes, applyNodesSnapshot, applyNodeSync, createFlowNode, moveFlowNode, updateFlowNodeData, deleteFlowNodes, createFlowEdge, deleteFlowEdges, applyFlowCursor } from '$lib/nodesHandler';
import { applyGraphCreate, applyGraphDelete } from '$lib/flowGraphs';
import { applyNodeTrigger } from '$lib/flowRuntime';
import { applyNodeDef, applyNodeDefDelete, applyNodeDefsSnapshot, sendNodeDefs } from '$lib/customNodes';
import { applyRemoteDuplicate } from '$lib/objectActions';
import { applyVerts } from '$lib/meshEdit';
import { applyMeshGeo } from '$lib/faceEdit';
import { initVoiceChat, attachVoiceToPeer, voicePeerConnected } from '$lib/voiceChat';
import { resolvePeerOptions, describePeerServer, peerServerStatus } from '$lib/peerServer';
import { applyAnnotation, applyAnnotationsSnapshot, sendAnnotations } from '$lib/annotationsHandler';
import { applyPing } from '$lib/ping';
import { applyAssetFile, answerAssetRequest } from '$lib/assetShare';
import { applyModuleMessage, moduleVersions, checkModuleVersions, sendModuleStates, applyModuleStates } from '$lib/moduleSDK';
import { applyLockRequest, applyUnlock, applyLockDenied } from '$lib/lockControl';
import { applyDrawLive, applyDrawEnd } from '$lib/drawMode';
import { applySimulate, physicsExternalMove } from '$lib/physics';
import { applyJointCreate, applyJointDelete, applyJointsSnapshot, sendJoints } from '$lib/joints';
import { applyHandModel, handModelState, dropPeerHandModel } from '$lib/handModels';
import { applyRemoteEnvironment, environmentState, envPresetsState, applyRemoteEnvPresets, dropPeerEnvPresets } from '$lib/environment';
import { applyRemoteMusic, musicState } from '$lib/sceneMusic';
import { applySessionProposal, applySessionAnswer, deferUntilShareChoice, localSceneCount } from '$lib/sessions';
import { applyRemoteGeometry } from '$lib/geometryEdit';
import { applyLightTarget } from '$lib/lightParams';
import { applyObjectFile } from '$lib/animatedImports';
import { lockedObjects, selectedObject, peerHands } from '../stores/sceneStore';
import { addMessage, peers, userdata, pendingApprovals, waitingForApproval, showToast } from '../stores/appStore';
import { get } from 'svelte/store';

export function createPeer() {
	return 'xxxxx'.replace(/[xy]/g, function (c) {
		var r = (Math.random() * 16) | 0,
			v = c == 'x' ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

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

		/** @type {Record<string, any>} outgoing DataConnections, keyed by peer id */
		this.connections = {};
		/** @type {Set<string>} peers whose conn actually opened — so a conn that
		 * closes without ever opening (a failed connect) doesn't fire a spurious
		 * 'disconnected' teardown; the error handler already messaged the user */
		this.openedPeers = new Set();

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

					// Show approved toast message
					showToast(element[0] + ' has approved your connection request.');
					// waitingForApproval.set(waiting);
					// waitingForApproval.update((value) => value);
				}
			})
			//Trigger reactivity to hide connnection request toast
			waitingForApproval.update((value) => value);

			// This block prevents unauthorized peers from accessing data
			const users = get(userdata);
			let found = users.some(element => element[0] === conn.peer);

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
				peers.update((value) => value);
				this.sendHandshake(conn, conn.peer, true, this.peer.id);
			});

			this.wireData(conn);
		}

		/** @this {any} @param {any} conn */
		function handleData(conn) {
			conn.on('data', (data) => {
				// console.log(data);
				if(data.type == 'hosts') {
					console.log('Connecting to received hosts');
					data.hosts.forEach( id =>
					{
						this.connectToPeer(id);
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
					moveGeometry(data.uuid, data.pos, data.rot, data.scale);
					// P-A: mid-sim, a peer's move stream on a dynamic body becomes a
					// kinematic hold (drops back to dynamic after 250ms of silence)
					physicsExternalMove(data.uuid);
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
				} else if(data.type == 'handmodel') {
					applyHandModel(data);
				} else if(data.type == 'environment') {
					applyRemoteEnvironment(data);
				} else if(data.type == 'music') {
					applyRemoteMusic(data);
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
					handleDisconnected(data.peerId);
					dropPeerEnvPresets(data.peerId);
					dropPeerHandModel(data.peerId);
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
				} else if(data.type == 'getmodulestate') {
					sendModuleStates(data.sender);
				} else if(data.type == 'modulestate') {
					applyModuleStates(data.states);
				} else if(data.type == 'annotation') {
					applyAnnotation(data);
				} else if(data.type == 'annotations') {
					applyAnnotationsSnapshot(data.annotations);
				} else if(data.type == 'getannotations') {
					sendAnnotations(data.sender);
				} else if(data.type == 'verts') {
					applyVerts(data.uuid, data.indices, data.position);
				} else if(data.type == 'meshgeo') {
					applyMeshGeo(data.uuid, data.positions);
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
		conn.send({type: 'modules', versions: moduleVersions()})
		conn.send(environmentState())
		conn.send(musicState())
		conn.send(handModelState())
		conn.send(envPresetsState())
		if (getobjects) conn.send({type: 'getobjects', sender: this.peer.id, count: localSceneCount()})
		if (getobjects) conn.send({type: 'getnodes', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getannotations', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getjoints', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getmodulestate', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getnodedefs', sender: this.peer.id})
		// join them into the voice mesh if our mic is live
		voicePeerConnected(peerId);
	}

	connectToPeer(peerId, getobjects = true, id = this.peer.id) {
		if (!this.connections[peerId]) {
			console.log("Connecting to " + peerId);
            const conn = this.peer.connect(peerId);
            this.connections[peerId] = conn;

			conn.on('close', () => this.onConnClose(peerId, conn));

            conn.on('open', () => {
				console.log('Connection to ' + peerId + ' established');
				this.openedPeers.add(peerId);
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
					this.restoreConnection(peerId, getobjects, id, 0);
				}

			}

		}
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
		console.log('Restoring connection: ' + peerId + (attempt ? ' (attempt ' + (attempt + 1) + ')' : ''));
		// drop the stale never-opened conn FIRST — left in peerjs's per-peer
		// bookkeeping it can wedge the fresh negotiation (offer never starts)
		const stale = this.connections[peerId];
		if (stale && !stale.open) {
			try { stale.close(); } catch {}
			delete this.connections[peerId];
		}
		const conn = this.peer.connect(peerId);
		this.connections[peerId] = conn;
		conn.on('close', () => this.onConnClose(peerId, conn));
		conn.on('open', () => {
			console.log('Connection to ' + peerId + ' restored');
			this.openedPeers.add(peerId);
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

	// A peer's outgoing connection dropped. Self-heal locally: drop the dead conn
	// and run the FULL per-peer teardown right here, instead of relying on a
	// relayed 'disconnected' — that relay never reaches the last peer in a 2-peer
	// session, so their voice nodes / VR hands / flow cursor / env presets used to
	// leak. handleDisconnected is idempotent and prunes userdata before checkLocks'
	// 500ms relay fires, so no duplicate toast/relay. checkLocks still releases the
	// peer's object locks. (172)
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
		this.openedPeers.delete(peerId);
		handleDisconnected(peerId);
		dropPeerEnvPresets(peerId);
		dropPeerHandModel(peerId);
		checkLocks();
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
		if(data.type == 'create')
		this.sendMessage('created a ' + data.command.split(' ')[1], 'info');
		this.broadcast(data);
	}
}

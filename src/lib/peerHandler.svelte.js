import Peer from 'peerjs';
import { sceneCommand, lockRestore, checkLocks, createObject, sendObjects, deleteObject, colorObject, createLoader, userData, handleDisconnected, specator, cameraSettings, objectParameters } from './commandsHandler.svelte';
import { createGeometry, createLight, createGroup, changeName, moveGeometry, lockGeometry, moveCamera } from '$lib/geometries.svelte';
import { sendNodes, applyNodesSnapshot, applyNodeSync, createFlowNode, moveFlowNode, updateFlowNodeData, deleteFlowNodes, createFlowEdge, deleteFlowEdges, applyFlowCursor } from '$lib/nodesHandler';
import { applyNodeDef, applyNodeDefDelete, applyNodeDefsSnapshot, sendNodeDefs } from '$lib/customNodes';
import { applyRemoteDuplicate } from '$lib/objectActions';
import { applyVerts } from '$lib/meshEdit';
import { initVoiceChat, voicePeerConnected } from '$lib/voiceChat';
import { applyAnnotation, applyAnnotationsSnapshot, sendAnnotations } from '$lib/annotationsHandler';
import { applyPing } from '$lib/ping';
import { applyModuleMessage, moduleVersions, checkModuleVersions, sendModuleStates, applyModuleStates } from '$lib/moduleSDK';
import { applyLockRequest, applyUnlock, applyLockDenied } from '$lib/lockControl';
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

		this.connections = {};

		const regex = /(\.io|\.app)$/i;
		if (!regex.test(location.hostname)) {
		this.peer = new Peer(id, {
			secure: true,
			host: 'localhost',
			port: 9001
		});} else {
			this.peer = new Peer(id)
		}

		initVoiceChat(this);

		this.peer.on('open', (id) => {
			console.log(id);
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

		// Surface signaling-server problems to the user
		this.reconnectAttempts = 0;
		this.peer.on('disconnected', () => {
			console.log('server disconnected');
			if (this.peer.destroyed) return;
			if (this.reconnectAttempts < 3) {
				this.reconnectAttempts++;
				showToast('Lost connection to the peer server, reconnecting... (' + this.reconnectAttempts + '/3)');
				this.peer.reconnect();
			} else {
				showToast('Could not reach the peer server. Please reload the page.');
			}
		});
		this.peer.on('error', (err) => {
			console.log('peer error: ' + err.type, err);
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
				} else if(data.type == 'lockrequest') {
					applyLockRequest(data);
				} else if(data.type == 'unlock') {
					applyUnlock(data);
				} else if(data.type == 'lockdenied') {
					applyLockDenied(data);
				} else if(data.type == 'lock') {
					lockGeometry(data.uuid, data.peerId);
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
					sendObjects(data.sender)
				} else if(data.type == 'object') {
					createObject(data, data.uuids, data.override, data.groupuuid, data.pos, data.rot, data.scale);
				} else if(data.type == 'objectParameters') {
					objectParameters(data);
				} else if(data.type == 'duplicate') {
					applyRemoteDuplicate(data.sourceUuid, data.uuids, data.name, data.pos);
				} else if(data.type == 'delete') {
					deleteObject(data.uuid);
				} else if(data.type == 'color') {
					colorObject(data.uuid, data.color, data.near, data.far);
				} else if(data.type == 'loading') {
					createLoader(data.count, data.uuids);
				} else if(data.type == 'disconnected') {
					handleDisconnected(data.peerId);
				} else if(data.type == 'getnodes') {
					sendNodes(data.sender);
				} else if(data.type == 'nodes') {
					applyNodesSnapshot(data.nodes, data.edges);
				} else if(data.type == 'nodesync') {
					applyNodeSync(data);
				} else if(data.type == 'nodedef') {
					applyNodeDef(data.def);
				} else if(data.type == 'nodedefdelete') {
					applyNodeDefDelete(data.id);
				} else if(data.type == 'nodedefs') {
					applyNodeDefsSnapshot(data.defs);
				} else if(data.type == 'getnodedefs') {
					sendNodeDefs(data.sender);
				} else if(data.type == 'nodecreate') {
					createFlowNode(data.node);
				} else if(data.type == 'nodemove') {
					moveFlowNode(data.id, data.position);
				} else if(data.type == 'nodedata') {
					updateFlowNodeData(data.id, data.data);
				} else if(data.type == 'nodedelete') {
					deleteFlowNodes(data.ids);
				} else if(data.type == 'edgecreate') {
					createFlowEdge(data.edge);
				} else if(data.type == 'edgedelete') {
					deleteFlowEdges(data.ids);
				} else if(data.type == 'flowcursor') {
					applyFlowCursor(data);
				} else if(data.type == 'ping') {
					applyPing(data);
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
		if (getobjects) conn.send({type: 'getobjects', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getnodes', sender: this.peer.id})
		if (getobjects) conn.send({type: 'getannotations', sender: this.peer.id})
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

			conn.on('close', () => {
				console.log("close");
				// console.log(data);

				checkLocks()
			});
			conn.on('disconnected', () => {
				console.log("disconnected");
				// console.log(data);
				checkLocks()
			});

            conn.on('open', () => {
				console.log('Connection to ' + peerId + ' established');
				//Trigger reactivity for UI list of objects
				peers.update((value) => value);
				this.sendHandshake(conn, peerId, getobjects, id);
			});
        } else {
			if (this.connections[peerId].peer == peerId) {
				console.log(`Peer ${peerId} is already connected or has a pending request. Connection status: ${this.connections[peerId].open}`)
				if(!this.connections[peerId].open) {
					console.log('Restoring connection: ' + peerId);
					const conn = this.peer.connect(peerId);
           	 		this.connections[peerId] = conn;
            		conn.on('open', () => {
						console.log('Connection to ' + peerId + ' restored');
						peers.update((value) => value);
						this.sendHandshake(conn, peerId, getobjects, id);
					});
				}

			}

		}
    }

	sendMessage(message, type) {
		if(message.startsWith('/')) {
			sceneCommand(message);
		} else {
			if(type === undefined) type = 'sent';
			addMessage({message: message, type: type, sender: this.peer.id});
			Object.keys(this.connections).forEach(element => {
				this.connections[element].send({message: message, type: type, sender: this.peer.id});
			});
		}
	}

	send(data) {
		if(data.type == 'create')
		this.sendMessage('created a ' + data.command.split(' ')[1], 'info');
		Object.keys(this.connections).forEach(element => {
			this.connections[element].send(data);
		});
	}
}

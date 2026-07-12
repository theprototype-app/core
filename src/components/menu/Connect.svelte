<script lang="ts">
	import { peers, userdata, waitingForApproval, pendingApprovals } from '../../stores/appStore'
	import { Navbar, NavHamburger, Input, Button } from 'flowbite-svelte';
	import { onMount } from 'svelte';
	import { createPeer, PeerConnection } from '$lib/peerHandler.svelte';

	let peerIdToConnect;
	let displayid = $state('Generating...');
	let myidcap = $state();

	$effect(() => {
		myidcap = displayid === 'Generating...' ? displayid : displayid.toUpperCase();
	});

	function updateDisplayId(id) {
		displayid = id;
	}

	onMount(async () => {
		const id = createPeer();

		$peers = new PeerConnection(id, updateDisplayId);
	});

	// Use the instance method to connect
const connectToPeer = (peerIdToConnect) => {
    if ($peers && peerIdToConnect) {

	// Check if peer is already present in whitelist
	if(!$userdata.some((peer) => peer[0] === peerIdToConnect.toLowerCase()))
	{
		// Whitelist connection by adding to userdata
		let data = [peerIdToConnect.toLowerCase(), '', '']
		$userdata.push(data);
		// Notify existing peers of updated whitelist
		$peers.send({type: 'userdata', userdata: $userdata})
		// Initiate connection request to peer and await approval
        $peers.connectToPeer(peerIdToConnect.toLowerCase(), true);

		// Add peer to pending approvals
		if(!$waitingForApproval.some((peer) => peer[0] === peerIdToConnect.toLowerCase()))
		$waitingForApproval.push([peerIdToConnect.toLowerCase(), 'pending']);
		$waitingForApproval = $waitingForApproval
	}
	else 
	{
		// already connected
		$pendingApprovals.push({peerId: peerIdToConnect.toLowerCase(), status: 'retry'});
		$pendingApprovals = $pendingApprovals;
	}

    }
};

	const copy = () => {
		if (!navigator.clipboard) {
			// use old commandExec() way
		} else {
			navigator.clipboard
				.writeText(window.location.origin+'#'+myidcap)
				.then(function () {
					// alert("yeah!"); // success
				})
				.catch(function () {
					// alert("err"); // error
				});
		}
	};
</script>

<!-- 152: the p-8 padding is transparent but was capturing clicks/drags over
	 neighbouring windows at z-index 300. pointer-events:none lets the padding
	 pass events through; the Navbar re-enables them on its own (visible) area. -->
<div
	class="p-8"
	style="position: absolute; top: 35px; left: 50%; transform: translate(-50%, -50%); z-index: 300; pointer-events: none;"
>
	<div style="pointer-events: auto; display: inline-block;">
		<Navbar rounded color="form">
		<div class="inline-flex rounded-md shadow-sm" role="group">
			<Input
				type="text"
				placeholder="Enter peer ID to connect"
				class="nob rounded-r-none border-0 "
				bind:value="{peerIdToConnect}"
			/>
			<Button
				color="primary"
				class="nob rounded-l-none rounded-r-lg bg-blue-500 text-white dark:bg-blue-700 dark:text-gray-200"
				on:click="{() => {connectToPeer(peerIdToConnect)}}"
				>Connect</Button
			>
			<Button
				color="primary"
				class="nob white bg-gray-400	text-white dark:bg-gray-600 dark:text-gray-200 ring-0"
				on:click={copy}
				style="margin-left: 15px;"><p style="white-space: nowrap;">&#x1f4cb; {myidcap}</p></Button
			>
		</div>

	</Navbar>
	</div>
</div>

<script lang="ts">
	import { peers, userdata, waitingForApproval, pendingApprovals, showToast, settingsOpen, settingsSection } from '../../stores/appStore'
	import { Input, Button } from 'flowbite-svelte';
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

		// A7: nudge users running a local/self-hosted build (not on the official
		// domain) to configure a peer server on first run — the public PeerJS cloud
		// is fine for a quick try but not recommended for real use. Shown once.
		try {
			const isLocalVersion = !/(\.io|\.app)$/i.test(location.hostname);
			const firstRun = !localStorage.getItem('peerServerConfig');
			const seen = localStorage.getItem('localPeerNoticeSeen');
			if (isLocalVersion && firstRun && !seen) {
				localStorage.setItem('localPeerNoticeSeen', '1');
				showToast(
					'It looks like you are running a local build of theprototype. Configure a peer signaling server in Settings for reliable connections — the public PeerJS cloud is not recommended for real use.',
					[
						{
							label: 'Open Settings',
							action: () => {
								settingsSection.set('connection');
								settingsOpen.set(true);
							}
						}
					]
				);
			}
		} catch {
			/* localStorage unavailable — skip the notice */
		}
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

<!-- Top-centre connect bar. pointer-events:none on the wrapper lets its
	 transparent margin pass clicks to windows underneath (z-index 300); the pill
	 re-enables them. Narrow screens drop the bar to its own row BELOW the logo
	 (left) and the peers/profile chrome (right) instead of squeezing between them. -->
<div class="connect-wrap">
	<div class="connect-pill" role="group">
		<!-- your invite id (click to copy the share link) -->
		<Button
			color="primary"
			class="nob shrink-0 rounded-lg bg-gray-400 text-white ring-0 dark:bg-gray-600 dark:text-gray-200"
			on:click={copy}
			title="Copy your invite link"><span style="white-space: nowrap;">&#x1f4cb; {myidcap}</span></Button
		>
		<span class="connect-divider"></span>
		<!-- connect to a peer — the input shrinks (down to cx-input min-width) so the
			 Connect button stays visible when the row is tight; the button never shrinks -->
		<div class="cx-connect inline-flex rounded-md shadow-sm">
			<Input
				type="text"
				placeholder="Enter peer ID to connect"
				class="nob cx-input rounded-r-none border-0"
				bind:value="{peerIdToConnect}"
			/>
			<Button
				color="primary"
				class="nob shrink-0 rounded-l-none rounded-r-lg bg-blue-500 text-white dark:bg-blue-700 dark:text-gray-200"
				on:click="{() => {connectToPeer(peerIdToConnect)}}"
				>Connect</Button
			>
		</div>
	</div>
</div>

<style>
	.connect-wrap {
		position: fixed;
		top: 8px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 300;
		pointer-events: none;
		max-width: 100vw;
	}
	.cx-connect {
		min-width: 0; /* allow the group to shrink so its input can shrink */
	}
	/* the input is comfortable by default but shrinks when the row is tight (so the
	   Connect button is never pushed off-screen); the button itself keeps its size */
	:global(.cx-input) {
		width: 12rem;
		min-width: 2.5rem;
	}
	.connect-pill {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		gap: 10px;
		/* moderate rounding (matches the buttons inside) — not a full pill */
		border-radius: 14px;
		border: 1px solid rgb(55 65 81 / 0.6);
		background: var(--color-form, rgb(31 41 55 / 0.9));
		padding: 6px 8px;
		box-shadow: 0 4px 14px rgb(0 0 0 / 0.25);
		backdrop-filter: blur(6px);
		white-space: nowrap;
		/* reserve room for the logo (left) + peers/profile (right) so the centred pill
		   shrinks its input instead of sliding under that chrome */
		max-width: calc(100vw - 280px);
	}
	.connect-divider {
		width: 1px;
		align-self: stretch;
		margin: 2px 0;
		background: rgb(255 255 255 / 0.12);
	}
	/* Connect stays on the top row; the logo + peers/profile chrome drops to a second
	   row on narrow screens (Sidebar/Users media queries). When space is too tight for
	   the fixed pill (its button would run off-screen), Connect becomes a full-width
	   bar stuck to the top edge — the input flexes to fill, the buttons stay visible. */
	@media (max-width: 640px) {
		.connect-wrap {
			top: 0;
			left: 0;
			right: 0;
			transform: none;
			max-width: none;
		}
		.connect-pill {
			width: 100%;
			max-width: none; /* the reserve-room cap is for the wide pill, not the full bar */
			border-radius: 0 0 14px 14px;
			white-space: normal;
		}
		.cx-connect {
			flex: 1 1 auto;
		}
		/* :global — the class lands on the flowbite Input's inner <input> */
		:global(.cx-input) {
			width: auto;
			flex: 1 1 auto;
			min-width: 0;
		}
	}
</style>

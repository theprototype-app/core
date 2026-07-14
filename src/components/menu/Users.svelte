<script lang="ts">
	import * as THREE from 'three';
	import {
		Avatar,
		Modal,
		Input,
		Dropdown,
		DropdownHeader,
		DropdownItem,
		DropdownDivider
	} from 'flowbite-svelte';
	import {
		chatHidden,
		specatorMode,
		username,
		userdata,
		peers,
		hidePanels,
		characterModalOpen
	} from '../../stores/appStore.js';
	import { globalScene, globalCamera, camSave, peerHands } from '../../stores/sceneStore.js';
	import { mutedPeers, toggleMutePeer } from '$lib/voiceChat';
	import { peerQuality } from '$lib/networkQuality';
	import ContextMenu from '../ContextMenu.svelte';

	// N3: latency-band dot color for a peer's network-quality indicator
	const qColor = (level: string) =>
		level === 'good' ? '#4ade80' : level === 'ok' ? '#fbbf24' : level === 'bad' ? '#f87171' : '#9ca3af';

    let openDropdown = $state(false);
  	let profileSettingsModal = $state(false);
	let muteMenu = $state(null);
	// 130: the peers overflow is a proper popover listing EVERY peer (none
	// hidden by stacking) with a labeled Watch affordance
	let peersOpen = $state(false);
	/** @param {string} id */
	function shortId(id) {
		return String(id ?? '').slice(0, 6);
	}

	function openMuteMenu(event, peerId) {
		event.preventDefault();
		muteMenu = { x: event.clientX, y: event.clientY, peerId };
	}

	// $effect(() => {
	// 	Object.keys($peers.connections).forEach((element) => {
	// 		// if(element != peerId)
	// 		console.log(element);
	// 	});
	// });

	let classProfileSettings = 'z-10 z-10 inline-flex w-40 flex-shrink-0 flex-shrink-0 items-center rounded-s-lg border\
	 border-gray-300 bg-gray-100 px-4 py-2.5 text-center text-sm font-medium text-gray-500 hover:bg-gray-200 focus:outline-none\
	 focus:ring-4 focus:ring-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600\
	 dark:focus:ring-gray-700';

	 let avatarImage = $state('');
	 function avatar_load(event) {
		let avatarFile = event.target.files[0];
		if (event.target.files && avatarFile) {
			const reader = new FileReader();
			reader.onload = function(fileLoadedEvent) {			
			avatarImage = fileLoadedEvent.target.result;
			localStorage.setItem('avatar', avatarImage);

			//find and update, same for image
			$userdata.forEach(element => {
				// console.log("for "  + element[0])
				if (element[0] === $peers.peer.id)
					element[2] = avatarImage
			})

			$peers.send({type: 'userdata', userdata: $userdata})
			
			};
			reader.readAsDataURL(avatarFile);
		}
	 }

	 function specate(user) {
		// $peers.send({ type: 'specator', peerId: $peers.peer.id });
		// console.log($peers.connections);
		// const conn = $peers.connections[user];
		// conn.send({ type: 'specator', peerId: $peers.peer.id });
		// console.log('clicked ' + user);
		if($specatorMode)
			return;
		$specatorMode = user;
		// hide the editing panels while spectating, chat and flow stay available
		hidePanels(['chat', 'flow']);
		$camSave = new THREE.PerspectiveCamera();
		$camSave.position.copy($globalCamera.position)
		$camSave.rotation.copy($globalCamera.rotation)
		$camSave.zoom = $globalCamera.zoom
		$camSave.fov = $globalCamera.fov
		let playerToSpecate = $globalScene.getObjectByName(user)

		if (playerToSpecate) {
			$globalScene.getObjectByName(user).visible = false
			$globalCamera.position.set(playerToSpecate.position.x, playerToSpecate.position.y, playerToSpecate.position.z);
			$globalCamera.rotation.set(playerToSpecate.rotation.x, playerToSpecate.rotation.y, playerToSpecate.rotation.z);

			playerToSpecate.attach($globalCamera);
			if ($userdata) {
				$userdata.forEach(element => {
					if (element[0] === user)
					if (element[4]) $globalCamera.fov = element[4]
				})
			}
			
			$globalCamera.updateProjectionMatrix()
			//send to peers that you are spectating
			$peers.send({ type: 'specator', peerId: $peers.peer.id, watching: user });

		}
	 }
</script>

<div style="position: fixed; right: 0px; z-index: 997;">
	<div class="flex" style=" position: absolute; top: 15px; right: 100px; z-index: 997;">
{#if $userdata && $userdata.length > 1}
	<div class="relative">
		<!-- compact trigger: a few stacked avatars + the peer count -->
		<button
			id="peers-trigger"
			class="flex items-center gap-2 rounded-full border border-gray-700/60 bg-gray-800/85 px-2 py-1 backdrop-blur hover:bg-gray-700/85"
			title="Connected peers"
			onclick={() => (peersOpen = !peersOpen)}
		>
			<div class="flex -space-x-2">
				{#each $userdata.slice(1, 4) as user (user[0])}
					<Avatar stacked src={user[2]} class="h-7 w-7 border-2 border-gray-800" />
				{/each}
			</div>
			<span class="pr-1 text-xs font-semibold text-gray-200">{$userdata.length - 1}</span>
		</button>

		{#if peersOpen}
			<div class="fixed inset-0" style="z-index: 996;" role="presentation" onclick={() => (peersOpen = false)}></div>
			<div id="peers-popover" class="ui-panel absolute right-0 top-11 w-72 p-2" style="z-index: 998;">
				<p class="ui-section-label">Connected ({$userdata.length - 1})</p>
				{#each $userdata as user, i (user[0])}
					<div
						class="peers-row flex items-center gap-2 rounded px-1.5 py-1 {$specatorMode === user[0]
							? 'bg-primary-800/60'
							: 'hover:bg-gray-700/60'}"
					>
						<Avatar src={user[2]} class="h-8 w-8 shrink-0" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1 truncate text-sm text-gray-100">
								<span class="truncate">{user[1] || 'Peer'}</span>
								{#if i === 0}<span class="text-[10px] text-primary-300">(you)</span>{/if}
							</div>
							<div class="flex items-center gap-1.5 text-[10px] text-gray-400">
								<span class="truncate">{shortId(user[0])}</span>
								{#if $mutedPeers.includes(user[0])}<span title="Muted">🔇</span>{/if}
								{#if $peerHands[user[0]]?.active}<span title="In VR">🥽</span>{/if}
								{#if user[3]}<span class="text-amber-300">▸ {shortId(user[3])}</span>{/if}
								{#if i > 0 && $peerQuality[user[0]]}
									{@const q = $peerQuality[user[0]]}
									<span
										title={q.rtt != null ? `${Math.round(q.rtt)} ms round-trip` : 'measuring…'}
										style="color: {qColor(q.level)}">●{q.rtt != null ? ` ${Math.round(q.rtt)}ms` : ''}</span
									>
									{#if q.relayed}<span class="text-orange-300" title="Relayed through a TURN server">relayed</span>{/if}
								{/if}
							</div>
						</div>
						{#if i > 0}
							<button
								class="peer-watch shrink-0 rounded px-2 py-0.5 text-xs {$specatorMode === user[0]
									? 'bg-primary-600 text-white'
									: 'bg-gray-600 text-gray-100 hover:bg-gray-500'}"
								title={$specatorMode === user[0] ? 'Watching (exit from the banner)' : 'Watch this peer'}
								onclick={() => { specate(user[0]); peersOpen = false; }}
								oncontextmenu={(e) => openMuteMenu(e, user[0])}
							>
								{$specatorMode === user[0] ? '👁 Watching' : '👁 Watch'}
							</button>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
	</div>
	<div id="avatar-menu" class="mr-5 flex w-52 items-center md:order-2; z-index: 999;">
		<div class="flex items-center space-x-3" style="z-index: 999;">
			{#if avatarImage != ''}
			<Avatar
				href="/"
				src={avatarImage}
				style="position: absolute; top: 8px; right: 20px;"
				class="h-12 w-12 rounded-full border-2 border-gray-600 dark:border-gray-600;"
			/>
			{:else if typeof localStorage !== 'undefined' && localStorage.getItem('avatar')}
			<Avatar
				href="/"
				src={localStorage.getItem('avatar')}
				style="position: absolute; top: 8px; right: 20px;"
				class="h-12 w-12 rounded-full border-2 border-gray-600 dark:border-gray-600;"
			/>
			{:else}
			<Avatar
				href="/"
				style="position: absolute; top: 8px; right: 20px;"
				class="h-12 w-12 rounded-full border-2 border-gray-600 dark:border-gray-600;"
			/>
			{/if}
			
		</div>
	</div>
	<Dropdown
    placement="bottom"
    bind:open={openDropdown}
    triggeredBy="#avatar-menu"
    class="w-52"
    style="border-top-right-radius: 1.5rem; padding-right: 0px; z-index: 998;"
	>
	<DropdownHeader>
		<span class="block text-lg">{localStorage.getItem('username') ? localStorage.getItem('username') : 'Anonymous'}</span>
		<DropdownDivider />
	</DropdownHeader>
	<DropdownItem
		onclick={() => {
			characterModalOpen.set(true);
			openDropdown = false;
		}}>Customize Character</DropdownItem
	>
	<DropdownItem
		onclick={() => {
			profileSettingsModal = true;
			openDropdown = false;
		}}>Profile Settings</DropdownItem>
	</Dropdown>
</div>



{#if muteMenu}
	<ContextMenu
		x={muteMenu.x}
		y={muteMenu.y}
		items={[
			{
				label: $mutedPeers.includes(muteMenu.peerId) ? 'Unmute voice' : 'Mute voice',
				action: () => toggleMutePeer(muteMenu.peerId)
			}
		]}
		on:close={() => (muteMenu = null)}
	/>
{/if}

<Modal title="" bind:open={profileSettingsModal} outsideclose>

	<center><b>Profile Settings</b></center>

	<div class="modal-content max-h-[90vh] overflow-y-auto p-4">
		<div class="flex px-10">
			<p
				class={classProfileSettings}
			>
				Avatar
			</p>
			<input type="file" id="avatar-file" style="display: none" onchange={e => avatar_load(e)}/>
			{#if avatarImage != ''}
			<img id="avatar-preview" src={avatarImage} class="h-14 w-14 dark:border-gray-800"
			onclick={() => document.getElementById('avatar-file').click()}
			/>
			{:else if localStorage.getItem('avatar') != null}
			<img id="avatar-preview" src={localStorage.getItem('avatar')} class="h-14 w-14 dark:border-gray-800"
			onclick={() => document.getElementById('avatar-file').click()}
			/>
			{:else}
			<svg onclick={() => document.getElementById('avatar-file').click()}
			fill="currentColor"
			viewBox="0 0 16 16"
			xmlns="http://www.w3.org/2000/svg"
			class="h-14 w-14 border-2 dark:border-gray-400"
			><path
				fill-rule="evenodd"
				d="M8 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
				clip-rule="evenodd"
			></path></svg>
			{/if}
		</div>
		<br />
		<div class="flex px-10">
			<p
				class={classProfileSettings + " rounded-bl-none"}
			>
				Peer ID
			</p>
			<Input
				id="peer-id"
				class="!rounded-s-none rounded-br-none"
				placeholder="&#xf2c3; {$peers.peer.id}"
				style="font-family:Arial, FontAwesome"
				disabled
			/>
		</div>

		<div class="flex px-10">
			<p
				class={classProfileSettings + " rounded-tl-none"}
			>
				Username
			</p>
			<Input
				id="update-username"
				class="!rounded-s-none rounded-tr-none"
				placeholder="&#xf007; Username"
				style="font-family:Arial, FontAwesome"
				bind:value={$username}
				onchange={() => { localStorage.setItem('username', $username);

					//find and update, same for image
					$userdata.forEach(element => {
						// console.log("for "  + element[0])
						if (element[0] === $peers.peer.id)
							element[1] = $username
					})
					$peers.send({type: 'userdata', userdata: $userdata})
				 }}
			/>
		</div>
	</div>
	<br />
</Modal>
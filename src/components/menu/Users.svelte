<script lang="ts">
	import * as THREE from 'three';
	import {
		Avatar,
		Tooltip,
		Popover,
		Button,
		Modal,
		Input,
		Dropdown,
		DropdownHeader,
		DropdownItem,
		DropdownDivider
	} from 'flowbite-svelte';
	import {
		chatHidden,
		propertiesClose,
		lightPropertiesClose,
		scenePropertiesClose,
		specatorMode,
		username,
		userdata,
		peers,
		hidePanels,
		characterModalOpen
	} from '../../stores/appStore.js';
	import { globalScene, globalCamera, camSave } from '../../stores/sceneStore.js';
	import { mutedPeers, toggleMutePeer } from '$lib/voiceChat';
	import ContextMenu from '../ContextMenu.svelte';

    let openDropdown = $state(false);
  	let profileSettingsModal = $state(false);
	let muteMenu = $state(null);

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
{#if $userdata}
<!-- {console.log($userdata)} -->
{#if $userdata.length < 4}
<div style=" position: absolute; right: 0px;">
	<div class="flex items-center space-x-3">
{#each $userdata as user, i}
{#if i > 0}
		<Avatar href="/" stacked src={user[2]}
			onclick={() => { if (!user[3]) specate(user[0]); } }
			oncontextmenu={(e) => openMuteMenu(e, user[0])}
		/>
		<Tooltip placement="top" arrow={false}>
			<div style="display: flex; align-items: center;">
			Peer: {user[0]}
			</div>
			<div style="display: flex; overflow: hidden;">
				<p style="">User:&nbsp;</p>
				<p style="">{user[1]}</p>
			</div>
			{#if (user[3])}
			<div style="display: flex; overflow: hidden;">
				<p style="">Watching:&nbsp;</p>
				<p style="">{user[3]}</p>
			</div>
			{/if}
		</Tooltip>

		{/if}
		{/each}
	</div>
</div>
{:else}

		<Avatar href="/" stacked src={$userdata[1][2]}
			onclick={() => { if (!$userdata[1][3]) specate($userdata[1][0]); } }
		/>
		<Tooltip placement="top" arrow={false}>
			<div style="display: flex; align-items: center;">
			Peer: {$userdata[1][0]}
			</div>
			<div style="display: flex; overflow: hidden;">
				<p style="">User:&nbsp;</p>
				<p style="">{$userdata[1][1]}</p>
			</div>
			{#if ($userdata[1][3])}
			<div style="display: flex; overflow: hidden;">
				<p style="">Watching:&nbsp;</p>
				<p style="">{$userdata[1][3]}</p>
			</div>
			{/if}
		</Tooltip>

		<Avatar href="/" stacked src={$userdata[2][2]}
			onclick={() => { if (!$userdata[2][3]) specate($userdata[2][0]); } }
		/>
		<Tooltip placement="top" arrow={false}>
			<div style="display: flex; align-items: center;">
			Peer: {$userdata[2][0]}
			</div>
			<div style="display: flex; overflow: hidden;">
				<p style="">User:&nbsp;</p>
				<p style="">{$userdata[2][1]}</p>
			</div>
			{#if ($userdata[2][3])}
			<div style="display: flex; overflow: hidden;">
				<p style="">Watching:&nbsp;</p>
				<p style="">{$userdata[2][3]}</p>
			</div>
			{/if}
		</Tooltip>


		<Avatar
			id="b2"
			stacked
			class="bg-gray-700 text-sm text-white hover:bg-gray-600"
			onclick={() => console.log($peers.connections)}
			><button>+{$userdata.length - 3}</button></Avatar
		>

				<Popover
					triggeredBy="#b2"
					class="w-64 bg-white text-sm font-light text-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400"
				>
					<div class="p-3">
						{#each $userdata as user, i}
							{#if i > 2}


							<ul class="w-full items-center divide-gray-200 text-sm font-medium dark:divide-gray-600 dark:border-gray-600 dark:bg-gray-800 sm:flex">
								<li class="w-1/3 p-4">
									<Avatar href="/" stacked src={user[2]}
										onclick={() => { if (!user[3]) specate(user[0]); } }
									/>
								</li>
								<li class="w-2/3">
									
									<span class="flex">Peer: {user[0]}
									</span>
									
									<div style="display: flex; overflow: hidden;">
									<p style="">User:&nbsp;</p>
									<p style="">{user[1]}</p>
									</div>
									{#if (user[3])}
									<div style="display: flex; overflow: hidden;">
										<p style="">Watching:&nbsp;</p>
										<p style="">{user[3]}</p>
									</div>
									{/if}
								</li>
							</ul>


							{/if}
						{/each}
					</div>
				</Popover>
				{/if}

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
			<input type="file" id="avatar-file" style="display: none" on:change={e => avatar_load(e)}/>
			{#if avatarImage != ''}
			<img id="avatar-preview" src={avatarImage} class="h-14 w-14 dark:border-gray-800" 
			on:click={() => document.getElementById('avatar-file').click()}
			/>
			{:else if localStorage.getItem('avatar') != null}
			<img id="avatar-preview" src={localStorage.getItem('avatar')} class="h-14 w-14 dark:border-gray-800" 
			on:click={() => document.getElementById('avatar-file').click()}
			/>
			{:else}
			<svg on:click={() => document.getElementById('avatar-file').click()}
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
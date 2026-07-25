<script lang="ts">
	import * as THREE from 'three';
	import { onMount, untrack } from 'svelte';
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
		characterModalOpen,
		notesDrawerOpen,
		cloudIdentity
	} from '../../stores/appStore.js';
	import { globalScene, globalCamera, camSave, peerHands } from '../../stores/sceneStore.js';
	import { mutedPeers, toggleMutePeer } from '$lib/voiceChat';
	import { peerQuality } from '$lib/networkQuality';
	import ContextMenu from '../ContextMenu.svelte';
	import NotificationCenter from './NotificationCenter.svelte';
	import CloudSlot from '../CloudSlot.svelte';
	import { usersSlot, profileSlot, rolesInfo } from '$lib/cloudHooks';

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
			// an uploaded image is a CUSTOM avatar
			try { localStorage.removeItem('avatarReset'); } catch {}
		}
	 }

	// --- identity (roadmap #14 profile-fixes) ---------------------------------
	// The collaborative username/avatar default to the signed-in cloud account
	// (pushed by the plugin via cloudApi.setAccountIdentity -> $cloudIdentity) UNLESS
	// the user set a custom one. "Custom username" = the usernameCustom flag; "custom
	// avatar" = an uploaded image in localStorage.avatar.
	const ls = (k: string) => (typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null);
	const usernameIsCustom = () => ls('usernameCustom') === '1';
	const cid = $derived($cloudIdentity);
	/** what the header/button/peers show */
	const effName = $derived($username || cid?.username || 'Anonymous');
	/** avatar src: session upload > stored custom > cloud account > default */
	const effAvatar = $derived(avatarImage || ls('avatar') || cid?.avatar || '');
	/** cloud roles bridge (null without the cloud plugin) */
	const ri = $derived($rolesInfo);
	function cycleRole(id: string) {
		const order = ri?.order || ['viewer', 'editor', 'admin'];
		const next = order[(order.indexOf(ri?.roleOf?.(id)) + 1) % order.length];
		ri?.setRole?.(id, next);
	}

	function broadcastUserdata() {
		if (!$peers?.peer) return;
		($userdata as any[]).forEach((el: any) => {
			if (el[0] === $peers.peer.id) { el[1] = $username || ''; el[2] = ls('avatar') || avatarImage || cid?.avatar || ''; }
		});
		$peers.send({ type: 'userdata', userdata: $userdata });
	}

	onMount(() => {
		// seed the live username from a previously-set custom value
		if (usernameIsCustom() && ls('username')) untrack(() => username.set((ls('username') || '') as any));
	});

	// adopt the cloud identity as the default when nothing custom is set
	$effect(() => {
		const id = $cloudIdentity; // track
		untrack(() => {
			let changed = false;
			if (!usernameIsCustom() && id?.username && $username !== id.username) {
				username.set(id.username as any);
				changed = true;
			}
			// avatar: only adopt when there's no custom upload stored
			if (!ls('avatar') && id?.avatar && avatarImage !== id.avatar) {
				// keep avatarImage empty (custom marker); effAvatar falls back to cloud
				changed = true;
			}
			if (changed) broadcastUserdata();
		});
	});

	function onUsernameEdited() {
		try {
			localStorage.setItem('username', $username || '');
			localStorage.setItem('usernameCustom', ($username || '').trim() ? '1' : '0');
		} catch {}
		broadcastUserdata();
	}

	function resetAvatarToDefault() {
		avatarImage = '';
		try { localStorage.removeItem('avatar'); } catch {}
		broadcastUserdata(); // falls back to the cloud-account avatar (or default)
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

<div class="top-right-chrome" style="position: fixed; right: 0px; z-index: 997;">
	<div class="flex items-center gap-2" style=" position: absolute; top: 15px; right: 100px; z-index: 997;">
	<!-- E2: scene-notes drawer toggle -->
	<button
		id="notes-toggle"
		class="flex h-8 w-8 items-center justify-center rounded-full border border-gray-700/60 bg-gray-800/85 text-gray-200 backdrop-blur hover:bg-gray-700/85 {$notesDrawerOpen ? 'ring-2 ring-primary-500/60' : ''}"
		title="Scene notes"
		aria-label="Scene notes"
		onclick={() => notesDrawerOpen.update((v) => !v)}
	>
		<i class="fas fa-note-sticky text-xs"></i>
	</button>
	<!-- E1: notifications bell + history panel -->
	<NotificationCenter />
<!-- CN: gate on LIVE connections (openedPeers), not the roster — userdata is
	 populated optimistically at dial time, which showed a phantom peer while an
	 outbound request was still pending. -->
{#if $userdata && $userdata.length > 1 && $peers && $peers.openedPeers?.size > 0}
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
					<Avatar stacked src={user[2]} class="h-7 w-7 rounded-full border-2 border-gray-800" />
				{/each}
			</div>
			<span class="pr-1 text-xs font-semibold text-gray-200">{$userdata.length - 1}</span>
		</button>

		{#if peersOpen}
			<div class="fixed inset-0" style="z-index: 996;" role="presentation" onclick={() => (peersOpen = false)}></div>
			<div id="peers-popover" class="ui-panel absolute right-0 top-11 w-72 p-2" style="z-index: 998;">
				<p class="ui-section-label">Connected ({$userdata.length - 1})</p>
				<div class="peers-scroll">
				{#each $userdata as user, i (user[0])}
					<div
						class="peers-row flex items-center gap-2 rounded px-1.5 py-1 {$specatorMode === user[0]
							? 'bg-primary-800/60'
							: 'hover:bg-gray-700/60'}"
					>
						<Avatar src={user[2]} class="h-8 w-8 shrink-0 rounded-full" />
						<div class="min-w-0 flex-1">
							<div class="flex items-center gap-1 truncate text-sm text-gray-100">
								<span class="truncate" title={user[1] || 'Peer'}>{user[1] || 'Peer'}</span>
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
						{#if ri}
							{#if i === 0}
								<span class="role-badge" data-role={ri.myRole} title="Your role">{ri.myRole}</span>
							{:else if ri.amAdmin}
								<button type="button" class="role-badge role-btn" data-role={ri.roleOf(user[0])} title={'Role: ' + ri.roleOf(user[0]) + ' (click to change)'} onclick={() => cycleRole(user[0])}>{ri.roleOf(user[0])}</button>
							{:else}
								<span class="role-badge" data-role={ri.roleOf(user[0])}>{ri.roleOf(user[0])}</span>
							{/if}
						{/if}
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
				<!-- open-core (M1d): cloud plugin roles section. Empty in the OSS
					 build; the cloud plugin fills it via cloudApi.mountUsersSection(). -->
				{#if $usersSlot}
					<div class="mt-1 border-t border-gray-700/60 pt-1">
						<CloudSlot mount={$usersSlot} />
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
	</div>
	<!-- main profile button: a single clean Avatar (no href -> no navigation bug; no
		 3-branch) that picks the effective avatar (custom upload > stored > cloud
		 account > default). This is the dropdown trigger. -->
	<div id="avatar-menu" class="mr-5 flex w-52 items-center md:order-2; z-index: 999;">
		<div class="flex items-center space-x-3" style="z-index: 999;">
			<Avatar
				src={effAvatar || undefined}
				style="position: absolute; top: 8px; right: 20px; cursor: pointer;"
				class="h-12 w-12 rounded-full border-2 border-gray-600 dark:border-gray-600"
			/>
		</div>
	</div>
	<Dropdown
    placement="bottom-end"
    bind:open={openDropdown}
    triggeredBy="#avatar-menu"
    class="w-56"
    style="border-top-right-radius: 1.5rem; padding-right: 0px; z-index: 998;"
	>
	<!-- PM (roadmap #14): identity header — name, then the cloud email on a new line
		 when signed in. No avatar here (it's already the profile button). The rounded
		 top-right corner is KEPT — it echoes the profile circle. -->
	<DropdownHeader>
		<div class="min-w-0">
			<span class="block truncate text-base font-semibold">{effName}</span>
			{#if cid?.email}
				<span class="block truncate text-xs text-gray-400">{cid.email}</span>
			{/if}
		</div>
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
	<!-- open-core (PM): cloud account section — the plugin mounts Sign in/out +
		 preferences here (moved out of the Connect pill). Plain block: the plugin
		 owns its own clicks, so it is NOT a DropdownItem. -->
	{#if $profileSlot}
		<DropdownDivider />
		<div class="cloud-profile px-3 py-2">
			<CloudSlot mount={$profileSlot} />
		</div>
	{/if}
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
			<div class="flex items-center gap-3">
				{#if effAvatar}
				<img id="avatar-preview" src={effAvatar} alt="avatar" class="h-14 w-14 rounded-full border-2 dark:border-gray-800 cursor-pointer object-cover"
				onclick={() => document.getElementById('avatar-file').click()}
				/>
				{:else}
				<svg onclick={() => document.getElementById('avatar-file').click()}
				fill="currentColor"
				viewBox="0 0 16 16"
				xmlns="http://www.w3.org/2000/svg"
				class="h-14 w-14 rounded-full border-2 dark:border-gray-400 cursor-pointer"
				><path
					fill-rule="evenodd"
					d="M8 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
					clip-rule="evenodd"
				></path></svg>
				{/if}
				<!-- reset to the signed-in account's picture (or the default) -->
				{#if avatarImage || (typeof localStorage !== 'undefined' && localStorage.getItem('avatar'))}
				<button id="avatar-reset" class="rounded border border-gray-500 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
					onclick={resetAvatarToDefault}>Reset to {cid?.avatar ? 'account picture' : 'default'}</button>
				{/if}
			</div>
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
				placeholder={cid?.username ? ' ' + cid.username : ' Username'}
				style="font-family:Arial, FontAwesome"
				bind:value={$username}
				onchange={onUsernameEdited}
			/>
		</div>
	</div>
	<br />
</Modal>

<style>
	/* narrow: the connect bar owns the top row, so the peers/profile chrome drops
	   to a second row below it (shifting the fixed wrapper moves its children) */
	@media (max-width: 640px) {
		.top-right-chrome {
			top: 58px;
		}
		/* pin the peers list to the viewport so it can't spill off the left edge
		   when the trigger sits near a narrow screen's right edge */
		.peers-scroll { max-height: 264px; overflow-y: auto; }
	.role-badge { flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 8px; color: #fff; background: rgb(107 114 128); text-transform: capitalize; }
	.role-btn { border: 0; cursor: pointer; }
	.role-btn:hover { filter: brightness(1.15); }
	.role-badge[data-role='editor'] { background: #2563eb; }
	.role-badge[data-role='admin'] { background: #7c3aed; }
	#peers-popover {
			position: fixed;
			top: 122px;
			right: 8px;
			left: auto;
			max-width: calc(100vw - 16px);
		}
	}
</style>
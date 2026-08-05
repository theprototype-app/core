<script lang="ts">
	import { cameraPreviews, joinPeerPreview, previewLabel } from '$lib/cameraPreview';
	import { Check, ChevronDown, Eye, Glasses, StickyNote, VolumeX, Camera } from '@lucide/svelte';
	import * as THREE from 'three';
	import { onMount, untrack } from 'svelte';
	import {
		Avatar,
		Modal,
		Input,
		Dropdown,
		DropdownGroup,
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
		profileSettingsOpen,
		notesDrawerOpen,
		cloudIdentity,
		connectDocked,
		connectBarHeight
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

	let classProfileSettings = 'z-10 z-10 inline-flex w-40 shrink-0 shrink-0 items-center rounded-s-lg border\
	 border-gray-300 bg-gray-100 px-4 py-2.5 text-center text-sm font-medium text-gray-500 hover:bg-gray-200 focus:outline-hidden\
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
	/** peerId whose role dropdown is open (null = none) */
	let roleMenuFor: string | null = $state(null);
	/** fixed-position anchor for the (portaled) role dropdown */
	let roleMenuPos: { top: number; right: number } = $state({ top: 0, right: 0 });
	/** open/toggle the role dropdown for a peer, anchored under its pill button. The
	 * menu is PORTALED to <body> so it escapes the peers-list overflow clip (an
	 * absolute child of an overflow:auto ancestor is clipped — it rendered invisibly). */
	function toggleRoleMenu(e: MouseEvent, peerId: string) {
		e.stopPropagation();
		if (roleMenuFor === peerId) {
			roleMenuFor = null;
			return;
		}
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		roleMenuPos = { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) };
		roleMenuFor = peerId;
	}
	/** portal a node to <body> so no overflow/stacking ancestor can clip it */
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return { destroy() { node.remove(); } };
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

<!-- when Connect docks to a full-width top bar, drop this corner chrome below it (plus
	 its tab strip when pinned) so nothing overlaps — connectBarHeight is the bar's height -->
<div class="top-right-chrome" style="position: fixed; right: 0px; z-index: 997; top: {$connectDocked ? $connectBarHeight + 'px' : '0px'};">
	<div class="flex items-center gap-2" style=" position: absolute; top: 15px; right: 100px; z-index: 997;">
	<!-- E2: scene-notes drawer toggle -->
	<button
		id="notes-toggle"
		class="flex h-8 w-8 items-center justify-center rounded-full border border-gray-700/60 bg-gray-800/85 text-gray-200 backdrop-blur-sm hover:bg-gray-700/85 {$notesDrawerOpen ? 'ring-2 ring-primary-500/60' : ''}"
		title="Scene notes"
		aria-label="Scene notes"
		onclick={() => notesDrawerOpen.update((v) => !v)}
	>
		<StickyNote size={16} class="text-xs" aria-hidden="true" />
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
			class="flex items-center gap-2 rounded-full border border-gray-700/60 bg-gray-800/85 px-2 py-1 backdrop-blur-sm hover:bg-gray-700/85"
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
			<div class="fixed inset-0" style="z-index: 996;" role="presentation" onclick={() => { peersOpen = false; roleMenuFor = null; }}></div>
			<div id="peers-popover" class="ui-panel absolute right-0 top-11 w-72 p-2" style="z-index: 998; {$connectDocked ? `position: fixed; top: ${$connectBarHeight + 44}px; right: 8px; left: auto; max-width: calc(100vw - 16px);` : ''}">
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
								{#if $mutedPeers.includes(user[0])}<span title="Muted"><VolumeX size={16} aria-hidden="true" /></span>{/if}
								{#if $peerHands[user[0]]?.active}<span title="In VR"><Glasses size={16} aria-hidden="true" /></span>{/if}
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
								<button type="button" class="role-badge role-btn" data-role={ri.roleOf(user[0])} aria-haspopup="listbox" aria-expanded={roleMenuFor === user[0]} title="Change role" onclick={(e) => toggleRoleMenu(e, user[0])}>{ri.roleOf(user[0])}<ChevronDown size={10} class="role-caret" aria-hidden="true" /></button>
							{:else}
								<span class="role-badge" data-role={ri.roleOf(user[0])}>{ri.roleOf(user[0])}</span>
							{/if}
						{/if}
						{#if i > 0 && $cameraPreviews[user[0]]}
							<!-- 16-P5: this peer is looking through a scene camera — you can join -->
							<button
								class="peer-watch peer-preview shrink-0 rounded px-2 py-0.5 text-xs bg-gray-600 text-gray-100 hover:bg-gray-500"
								title={`Previewing ${previewLabel($cameraPreviews[user[0]])} — click to look through it too`}
								onclick={() => { joinPeerPreview(user[0]); peersOpen = false; }}
							>
								<Camera size={14} class="mr-1" aria-hidden="true" />{previewLabel($cameraPreviews[user[0]])}
							</button>
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
								<Eye size={16} class="mr-1" aria-hidden="true" />{$specatorMode === user[0] ? 'Watching' : 'Watch'}
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
			<!-- role dropdown — PORTALED to <body> (fixed position) so it isn't clipped by
				 the peers list's overflow container -->
			{#if roleMenuFor && ri && ri.amAdmin}
				{@const pid = roleMenuFor}
				<div use:portal class="role-menu role-menu-portal" role="listbox" style="top:{roleMenuPos.top}px; right:{roleMenuPos.right}px;">
					{#each ri.order as r}
						<button type="button" class="role-menu-item" class:sel={ri.roleOf(pid) === r} role="option" aria-selected={ri.roleOf(pid) === r} onclick={(e) => { e.stopPropagation(); ri.setRole(pid, r); roleMenuFor = null; }}><span class="role-badge" data-role={r} style="pointer-events:none">{r}</span>{#if ri.roleOf(pid) === r}<Check size={16} class="role-check" aria-hidden="true" />{/if}</button>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
{/if}
	</div>
	<!-- main profile button: a single clean Avatar (no href -> no navigation bug; no
		 3-branch) that picks the effective avatar (custom upload > stored > cloud
		 account > default). This is the dropdown trigger. -->
	<!-- The panel anchors to THIS wrapper, not to #avatar-menu: that is an invisible
	     208px-wide flex box whose right edge merely COINCIDES with the circle (both are
	     inset 20px), so any width or zoom that broke the coincidence slid the menu
	     sideways — reported as "on mobile the menu shifts to the right edge". Anchored to
	     the circle, the panel's right edge IS the circle's right edge by construction.
	     It also stops that invisible box from catching clicks across the whole
	     top-right corner. -->
	<div id="avatar-menu" class="mr-5 flex w-52 items-center md:order-2">
		<div class="flex items-center space-x-3">
			<div
				id="avatar-trigger"
				style="position: absolute; top: 8px; right: 20px; cursor: pointer; z-index: 999; line-height: 0;"
			>
				<Avatar
					src={effAvatar || undefined}
					class="h-12 w-12 rounded-full border-2 border-gray-600 dark:border-gray-600"
				/>
			</div>
		</div>
	</div>
	<!-- NO z-index will put the profile circle over this panel: flowbite 1.x renders a
	     Dropdown as a TOP-LAYER popover (`popover="manual"`, `:popover-open`), and the
	     top layer paints above the entire page whatever the z-index — measured, the panel
	     at 996 covered an avatar at 2000. Same family as the modal/top-layer trap in
	     CLAUDE.md. So the circle is drawn INSIDE the panel instead (below), where it
	     rides the same layer; the z-index here only orders it against ordinary chrome. -->
	<Dropdown
    id="avatar-dropdown"
    placement="bottom-end"
    bind:isOpen={openDropdown}
    triggeredBy="#avatar-trigger"
    class="w-56"
    style="border-top-right-radius: 1.5rem; padding-right: 0px; z-index: 996; margin-top: -50px;"
	>
	<!-- the profile circle, seated in the 1.5rem notch this panel's top-right corner
	     exists for (24px radius = half of a 48px avatar, so it is exactly inscribed and
	     the panel's own overflow-hidden does not bite it). Clicking it closes the menu,
	     the same as clicking the trigger again. -->
	<button
		type="button"
		class="absolute right-0 top-0 z-10 cursor-pointer rounded-full leading-none"
		aria-label="Close profile menu"
		onclick={() => (openDropdown = false)}
	>
		<Avatar
			src={effAvatar || undefined}
			class="h-12 w-12 rounded-full border-2 border-gray-600 dark:border-gray-600"
		/>
	</button>
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
	<DropdownGroup>
	<DropdownItem
		onclick={() => {
			characterModalOpen.set(true);
			openDropdown = false;
		}}>Customize Character</DropdownItem
	>
	<DropdownItem
		onclick={() => {
			profileSettingsOpen.set(true);
			openDropdown = false;
		}}>Profile Settings</DropdownItem>
	</DropdownGroup>
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

<Modal title="" bind:open={$profileSettingsOpen} outsideclose modal={false} onkeydown={(e) => { if (e.key === 'Escape') profileSettingsOpen.set(false); }} class="tp-modal-frame">

	<center><b>Profile Settings</b></center>

	<div class="modal-content max-h-[90vh] overflow-y-auto p-4">
		<div class="flex px-10 pf-row">
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
				<button id="avatar-reset" class="rounded-sm border border-gray-500 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700"
					onclick={resetAvatarToDefault}>Reset to {cid?.avatar ? 'account picture' : 'default'}</button>
				{/if}
			</div>
		</div>
		<br />
		<div class="flex px-10 pf-row">
			<p
				class={classProfileSettings + " rounded-bl-none"}
			>
				Peer ID
			</p>
			<Input
				id="peer-id"
				class="rounded-s-none! rounded-br-none"
				placeholder={$peers.peer.id}
				disabled
			/>
		</div>

		<div class="flex px-10 pf-row">
			<p
				class={classProfileSettings + " rounded-tl-none"}
			>
				Username
			</p>
			<Input
				id="update-username"
				class="rounded-s-none! rounded-tr-none"
				placeholder={cid?.username ? '' + cid.username : 'Username'}
				bind:value={$username}
				onchange={onUsernameEdited}
			/>
		</div>
	</div>
	<br />
</Modal>

<style>
	/* Role pill + change-role dropdown (cloud-roles bridge). These MUST live outside
	   any media query — they previously sat inside @media(max-width:640px) so on a
	   normal-width screen the "change role" control rendered as an unstyled native
	   button/list (the bug in the screenshot). */
	.role-badge { flex: 0 0 auto; font-size: 10px; font-weight: 600; letter-spacing: 0.02em; padding: 2px 9px; border-radius: 9999px; color: #fff; background: #64748b; text-transform: capitalize; line-height: 1.4; }
	.role-btn { display: inline-flex; align-items: center; gap: 5px; border: 0; cursor: pointer; box-shadow: 0 1px 2px rgb(0 0 0 / 0.35); }
	.role-btn:hover { filter: brightness(1.12); }
	/* the caret is a lucide svg from a child component — needs :global to match */
	.role-btn :global(.role-caret) { opacity: 0.85; }
	/* portaled to <body> — fixed position, anchored via inline top/right */
	.role-menu { position: fixed; z-index: 1000; min-width: 116px; padding: 4px; border-radius: 10px; background: #1f2937; border: 1px solid rgb(255 255 255 / 0.12); box-shadow: 0 12px 28px rgb(0 0 0 / 0.5); display: flex; flex-direction: column; gap: 2px; }
	.role-menu-item { display: flex; align-items: center; gap: 7px; padding: 5px 8px; border: 0; border-radius: 7px; background: transparent; color: #e5e7eb; font-size: 11px; cursor: pointer; text-transform: capitalize; text-align: left; }
	.role-menu-item:hover { background: rgb(255 255 255 / 0.09); }
	.role-menu-item.sel { background: rgb(255 255 255 / 0.05); }
	.role-check { font-size: 9px; color: #86efac; }
	.role-badge[data-role='editor'] { background: #2563eb; }
	.role-badge[data-role='admin'] { background: #7c3aed; }
	/* keep the peers list scrollable so it never spills off a short/narrow screen */
	.peers-scroll { max-height: 264px; overflow-y: auto; }
	/* PROFILE PANEL, horizontal edge only. floating-ui places this from the trigger, and
	   under a MOBILE viewport (page scale != 1) its math drifts right by exactly the
	   trigger's inset: on a phone the panel landed flush with the window edge while the
	   circle stayed 20px in, clipping the circle. Reproduced with Playwright's isMobile
	   emulation — a coarse pointer alone does NOT do it, which is why touch-emulated runs
	   looked fine. This edge is fixed chrome geometry (the avatar is right: 20px inside a
	   right: 0 chrome), so pin it and let floating-ui keep only the vertical placement.
	   !important beats floating-ui's non-important inline `left`; :global because the
	   panel is rendered by a child component (no scope class). */
	:global(#avatar-dropdown) {
		left: auto !important;
		right: 20px !important;
	}
	/* Profile Settings modal: on a narrow screen stack each label above its control
	   (the fixed w-40 label beside the input is too cramped) — matches app Settings. */
	@media (max-width: 640px) {
		.pf-row {
			flex-direction: column;
			align-items: stretch;
			gap: 6px;
			margin-bottom: 6px;
			padding-left: 1rem;
			padding-right: 1rem;
		}
		/* each label + its control becomes its own cleanly-rounded box — the desktop
		   layout's half-rounded seams (rounded-s-none / rounded-*-none) look broken when
		   stacked, so force full rounding on both */
		.pf-row > :global(p),
		.pf-row :global(input) {
			width: 100%;
			border-radius: 8px !important;
		}
	}
</style>
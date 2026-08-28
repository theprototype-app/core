<script lang="ts">
	import { cameraPreviews, joinPeerPreview, previewLabel } from '$lib/cameraPreview';
	import { ArrowRight, Check, ChevronDown, Eye, Glasses, StickyNote, VolumeX, Camera } from '@lucide/svelte';
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
		connectBarHeight,
		showToast
	} from '../../stores/appStore.js';
	import { globalScene, globalCamera, camSave, peerHands, isLocked } from '../../stores/sceneStore.js';
	// 21-F3: who is in play mode, and who may end the round
	import { peerPlayModes, resetAllowed, requestResetGame } from '$lib/gamePresence';
	// P2b: WHICH SCENE each peer is standing in. Reported as "if a peer opens another
	// scene, peers would not see where he is" — the roster said present and nothing
	// said where. Our own row reads `currentLevel` directly; peers read the map.
	// R22 round 30 B2: `roomsOfSession` is the DERIVED grouping the Rooms view renders —
	// a session is the mesh, a scene is the tag, a room is who is standing in one.
	import { peerScenes, elsewhereThan, roomsOfSession } from '$lib/peerScenes';
	// travel, for "Go to": by HASH when the row carries one (the exact world they are
	// looking at), by NAME as the fallback.
	import { currentLevel, travelToLevel, travelToScene } from '$lib/levels';
	// …behind the same unsaved-changes guard the Explorer's own open goes through. One
	// copy, two callers — a guard with two copies is a guard with one bug.
	import { guardSceneReplace } from '$lib/sceneOpenGuard';

	/**
	 * WHY WATCH IS GATED. Watching a peer attaches your camera to theirs — in THIS
	 * world. A peer standing in another scene is looking at a world you do not have
	 * loaded, so following them shows you nothing and leaves you somewhere you cannot
	 * get back from. 21-G5 already made exactly this call for peers in other rooms via
	 * the cloud bridge (disabled, WITH the reason, never hidden — a dead button with no
	 * explanation is how it gets filed as a bug); now that peers in ONE mesh can be in
	 * different scenes, the same rule has to hold inside the session.
	 *
	 * ONLY ON EVIDENCE. An absent row means "we have not been told", which is not the
	 * same as "somewhere else" — a peer on an older build never sends one. And if WE
	 * are not in a named scene there is nothing to compare against. Both unknowns
	 * leave Watch enabled: refusing on a guess would break a working feature for
	 * anybody whose scene simply has no name yet.
	 * @returns {string} their scene when they are demonstrably elsewhere, else empty
	 */
	const watchBlockedBy = elsewhereThan;

	/**
	 * WHAT THE CHIP SAYS. A peer with a row and no scene name is in the session's
	 * UNNAMED world — the ordinary state before anybody saves anything, and the state a
	 * joiner is in when the host has never named a scene. Saying so beats an empty gap
	 * that reads as "we lost them". No row at all still renders nothing: that is a peer
	 * on an older build, and inventing a location for them would be a guess.
	 */
	const UNNAMED = 'Untitled scene';
	function chipFor(map: any, mine: any, peerId: string, self: boolean): string {
		if (self) return mine?.name || UNNAMED;
		const row = map?.[peerId];
		return row ? row.scene || UNNAMED : '';
	}
	import { gameState } from '$lib/gameState';
	import { sessionHost } from '$lib/connectionState';
	import { mutedPeers, toggleMutePeer } from '$lib/voiceChat';
	import { peerQuality } from '$lib/networkQuality';
	import ContextMenu from '../ContextMenu.svelte';
	import NotificationCenter from './NotificationCenter.svelte';
	import CloudSlot from '../CloudSlot.svelte';
	import { usersSlot, profileSlot, rolesInfo, scenePresence } from '$lib/cloudHooks';

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
	// 21-G5 (F7): the project's OTHER rooms — mine is excluded, and a room with no
	// members to show is skipped rather than rendering an empty header
	const crossRooms = $derived(
		(($scenePresence?.rooms as any[]) ?? []).filter(
			(room) => room && room.id !== $scenePresence?.myRoomId && (room.members?.length ?? 0) > 0
		)
	);

	// --- R22 round 30 B2: ALL or ROOMS -------------------------------------------
	/**
	 * WHICH VIEW. LOCAL and remembered: how you read the peer list is a fact about this
	 * screen, so it never replicates and never saves — and a view you have to re-pick
	 * every time the popover opens is a view you stop using. Flat by default: grouping
	 * says nothing at all until a session actually holds more than one scene.
	 */
	let peersView = $state(ls('peers:view') === 'rooms' ? 'rooms' : 'flat');
	/** @param {string} v */
	function setPeersView(v: string) {
		peersView = v;
		try { localStorage.setItem('peers:view', v); } catch {}
	}
	/** WHO AM I in the roster. The flat list has always taken index 0 as self (userdata
	 * is built that way), so the fallback is not a guess — it is the same rule, reached
	 * for only while the peer id has not settled. */
	const selfId = $derived($peers?.peer?.id || ($userdata as any[])?.[0]?.[0] || '');
	/**
	 * THE ROOMS. `roomsOfSession` does the grouping and is REMOTE-ONLY — peerScenes never
	 * holds us — so our own roster row is prepended to our own room by hand. Two buckets
	 * it cannot produce sit beside it, and both exist because "we have not been told" and
	 * "they are in the unnamed world" are different facts:
	 *
	 *   · UNTITLED — a row that says scene '' is a real room: the session's unnamed world,
	 *     which is where everybody starts and where a joiner stands until somebody saves.
	 *   · SCENE UNKNOWN — a roster peer with NO row at all is on an older build. It goes
	 *     LAST because it describes our ignorance rather than their place, and Watch stays
	 *     ENABLED inside it: only-on-evidence, the same rule the chip and the gate follow.
	 *
	 * Rows are looked up in `$userdata` and an id the roster does not carry is skipped —
	 * the peer list may only draw peers the roster knows about.
	 */
	const peerGroups = $derived.by(() => {
		const map: any = $peerScenes ?? {};
		const roster: any[] = ($userdata as any[]) ?? [];
		const rowOf = (id: string) => roster.find((u) => u[0] === id);
		const mineScene = $currentLevel?.name ?? '';
		const seen = new Set<string>();
		const take = (id: string) => {
			const r = rowOf(id);
			if (r) seen.add(id);
			return r;
		};
		const mine = () => {
			const me = rowOf(selfId);
			if (me) seen.add(selfId);
			return me ? [me] : [];
		};
		const body: any[] = [];
		for (const room of roomsOfSession(map, mineScene ? { scene: mineScene } : null)) {
			const users = [...(room.mine ? mine() : []), ...room.peerIds.map(take).filter(Boolean)];
			if (!users.length) continue;
			body.push({
				key: 'scene:' + room.scene,
				label: room.scene,
				mine: room.mine,
				title: 'Standing in ' + room.scene,
				users
			});
		}
		const untitled = [
			...(mineScene ? [] : mine()),
			...Object.keys(map).filter((id) => !map[id]?.scene).map(take).filter(Boolean)
		];
		if (untitled.length)
			body.push({
				key: 'untitled',
				label: UNNAMED,
				mine: !mineScene,
				title: 'The session\u2019s unnamed world — nobody has saved a scene yet',
				users: untitled
			});
		// mine first: "which room am I in" is the first thing the list has to answer.
		// Array.sort is stable, so everything else keeps roomsOfSession’s own order.
		body.sort((a, b) => (a.mine === b.mine ? 0 : a.mine ? -1 : 1));
		const unknown = roster.filter((u) => !seen.has(u[0]));
		if (unknown.length)
			body.push({
				key: 'unknown',
				label: 'Scene unknown',
				mine: false,
				title: 'They have not said which scene they are in — an older build',
				users: unknown
			});
		return body;
	});
	/**
	 * GO TO: open the scene this peer is standing in — the thing Watch cannot do.
	 *
	 * HASH FIRST, name as the fallback. The row carries the exact hash they loaded, which
	 * is the world in front of them; `travelToScene` resolves the NAME through the
	 * manifest pointer, which can be NEWER than the version they are looking at (and
	 * toasts "no scene called…" for a loose scene the project has never heard of).
	 * Arriving in a different version of the right name is not arriving where they are.
	 *
	 * The guard runs BEFORE the popover closes: cancelling has to leave the list exactly
	 * where it was, and the confirm dialog is top-layer, so it paints above the popover
	 * either way.
	 *
	 * THE TIMEOUT WRAPS THE CALL SITE, never `resolveLevelItem`. Travel WATCHES for the
	 * bytes by design (the LUT rule) and must keep watching — a peer may be standing in a
	 * scene whose file has not reached us yet. This only stops the UI pretending nothing
	 * happened while that fetch runs, and says as much.
	 * @param {string} peerId
	 */
	async function goToScene(peerId: string) {
		const row: any = ($peerScenes as any)?.[peerId];
		const scene = row?.scene ?? '';
		if (!scene) return;
		if (!(await guardSceneReplace(scene))) return;
		peersOpen = false;
		const travel = row?.hash ? travelToLevel(row.hash, scene) : travelToScene(scene);
		const landed = await Promise.race([
			travel,
			new Promise((r) => setTimeout(() => r(null), 15000))
		]);
		if (landed === null)
			showToast(
				'Could not fetch "' + scene + '" from your peers yet — it will still open if the bytes arrive.'
			);
	}

	// --- 21-F3: play-mode presence + the admin reset -------------------------------
	/** A chip only appears when it SAYS something: a peer who is PLAYING, or — while a
	 * round is actually running — a peer who is not, which is the moment "who is still
	 * in the editor" becomes worth knowing. In a scene with no game every row would
	 * otherwise carry a permanent "editor" badge that means nothing at all. */
	const roundRunning = $derived($gameState.state === 'playing' || $gameState.state === 'paused');
	/** the stores come in as ARGUMENTS so the read is tracked where the template calls
	 * it — a helper reaching a store through `get()` registers no dependency, and the
	 * `($store, expr)` workaround fails svelte-check */
	const modeOf = (modes: Record<string, string>, locked: any, id: string, self: boolean) =>
		self ? (locked === true ? 'playing' : 'editor') : modes[id] === 'playing' ? 'playing' : 'editor';
	/** Is there a game to reset at all? A pristine shell has nothing to say. */
	const gameInUse = $derived($gameState.round > 0 || $gameState.state !== 'menu');
	/** INERT without a cloud plugin: falls back to the session host (see canResetGame) */
	const canReset = $derived(resetAllowed(ri, $sessionHost, $peers));
	function doResetGame() {
		const result = requestResetGame();
		if (!result.ok && result.reason) showToast(result.reason);
		peersOpen = false;
	}
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

<!--
	ONE ROW, TWO VIEWS. The flat list and the Rooms grouping draw the same peer — the
	avatar, the id, the mode/scene chips, the role control, Watch or Go to — so the row
	is a snippet rather than a second copy that drifts on the next thing added to either.

	`self` replaces the old `i === 0`: index 0 IS us in the flat roster, but a grouped
	row sits wherever its room is, so the caller has to say. `showScene` is off in the
	Rooms view for the same reason a filename is not repeated inside its own folder —
	the header already names the scene.
-->
{#snippet peerRow(user: any, self: boolean, showScene: boolean)}
	<div
		class="peers-row flex items-center gap-2 rounded px-1.5 py-1 {$specatorMode === user[0]
			? 'bg-primary-800/60'
			: 'hover:bg-gray-700/60'}"
	>
		<Avatar src={user[2]} class="h-8 w-8 shrink-0 rounded-full" />
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-1 truncate text-sm text-gray-100">
				<span class="truncate" title={user[1] || 'Peer'}>{user[1] || 'Peer'}</span>
				{#if self}<span class="text-[10px] text-primary-300">(you)</span>{/if}
			</div>
			<div class="flex items-center gap-1.5 text-[10px] text-gray-400">
				<span class="truncate">{shortId(user[0])}</span>
				{#if $mutedPeers.includes(user[0])}<span title="Muted"><VolumeX size={16} aria-hidden="true" /></span>{/if}
				{#if $peerHands[user[0]]?.active}<span title="In VR"><Glasses size={16} aria-hidden="true" /></span>{/if}
				<!-- 21-F3: play-mode presence. `{@const}` may only be the IMMEDIATE
					 child of a block, so the mode is resolved in the `{#if}` and
					 named inside it. -->
				{#if modeOf($peerPlayModes, $isLocked, user[0], self) === 'playing' || roundRunning}
					{@const pmode = modeOf($peerPlayModes, $isLocked, user[0], self)}
					<span
						class="mode-chip"
						data-mode={pmode}
						title={pmode === 'playing' ? 'In play mode' : 'In the editor, not playing'}>{pmode}</span
					>
				{/if}
				<!-- P2b: where this peer is. Absent means we have not been told — which is
				     not the same as "nowhere", so it renders nothing rather than guessing.
				     `{@const}` may only be the IMMEDIATE child of a block, so the expression is
				     repeated in the `{#if}` and named inside it — the mode chip above does the
				     same, for the same reason. -->
				{#if showScene && chipFor($peerScenes, $currentLevel, user[0], self)}
					{@const sceneName = chipFor($peerScenes, $currentLevel, user[0], self)}
					<span
						class="scene-chip"
						class:scene-chip-here={sceneName === ($currentLevel?.name ?? null)}
						title={self ? 'The scene you have open' : 'In ' + sceneName}>{sceneName}</span
					>
				{/if}
				{#if user[3]}<span class="text-amber-300">▸ {shortId(user[3])}</span>{/if}
				{#if !self && $peerQuality[user[0]]}
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
			{#if self}
				<span class="role-badge" data-role={ri.myRole} title="Your role">{ri.myRole}</span>
			{:else if ri.amAdmin}
				<button type="button" class="role-badge role-btn" data-role={ri.roleOf(user[0])} aria-haspopup="listbox" aria-expanded={roleMenuFor === user[0]} title="Change role" onclick={(e) => toggleRoleMenu(e, user[0])}>{ri.roleOf(user[0])}<ChevronDown size={10} class="role-caret" aria-hidden="true" /></button>
			{:else}
				<span class="role-badge" data-role={ri.roleOf(user[0])}>{ri.roleOf(user[0])}</span>
			{/if}
		{/if}
		{#if !self && $cameraPreviews[user[0]] && !watchBlockedBy($peerScenes, $currentLevel?.name ?? '', user[0])}
			<!-- 16-P5: this peer is looking through a scene camera — you can join.
			     P2b: not across scenes — the camera MARKER lives in their scene, so
			     there would be nothing here to look through. -->
			<button
				class="peer-watch peer-preview shrink-0 rounded px-2 py-0.5 text-xs bg-gray-600 text-gray-100 hover:bg-gray-500"
				title={`Previewing ${previewLabel($cameraPreviews[user[0]])} — click to look through it too`}
				onclick={() => { joinPeerPreview(user[0]); peersOpen = false; }}
			>
				<Camera size={14} class="mr-1" aria-hidden="true" />{previewLabel($cameraPreviews[user[0]])}
			</button>
		{/if}
		{#if !self}
			{@const away = watchBlockedBy($peerScenes, $currentLevel?.name ?? '', user[0])}
			{#if away}
				<!-- R22 round 30 B2: they are demonstrably in ANOTHER SCENE, so Watch cannot
					 reach them — it would attach your camera to a world you do not have
					 loaded. The disabled button said so and left you to find that scene
					 yourself; this offers the one thing that DOES work, which is to go there. -->
				<button
					class="peer-goto shrink-0 rounded bg-gray-600 px-2 py-0.5 text-xs text-gray-100 hover:bg-gray-500"
					title={'In ' + away + ' — travel to their scene'}
					onclick={() => goToScene(user[0])}
				>
					<ArrowRight size={14} class="mr-1" aria-hidden="true" />Go to
				</button>
			{:else}
				<button
					class="peer-watch shrink-0 rounded px-2 py-0.5 text-xs {away
						? 'bg-gray-700 text-gray-500'
						: $specatorMode === user[0]
							? 'bg-primary-600 text-white'
							: 'bg-gray-600 text-gray-100 hover:bg-gray-500'}"
					disabled={!!away}
					title={away
						? 'In ' + away + ' — open that scene to watch them'
						: $specatorMode === user[0]
							? 'Watching (exit from the banner)'
							: 'Watch this peer'}
					onclick={() => { specate(user[0]); peersOpen = false; }}
					oncontextmenu={(e) => openMuteMenu(e, user[0])}
				>
					<Eye size={16} class="mr-1" aria-hidden="true" />{$specatorMode === user[0] ? 'Watching' : 'Watch'}
				</button>
			{/if}
		{/if}
	</div>
{/snippet}

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
	 outbound request was still pending.
	 21-G5: OR on cross-scene presence — being alone in YOUR scene is exactly when
	 "where is everyone" matters, and a popover that only exists once somebody is
	 already in your mesh could never show you the people who are not. -->
{#if ($userdata && $userdata.length > 1 && $peers && $peers.openedPeers?.size > 0) || crossRooms.length > 0}
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
			<span class="pr-1 text-xs font-semibold text-gray-200">{$userdata.length}</span>
		</button>

		{#if peersOpen}
			<div class="fixed inset-0" style="z-index: 996;" role="presentation" onclick={() => { peersOpen = false; roleMenuFor = null; }}></div>
			<div id="peers-popover" class="ui-panel absolute right-0 top-11 w-72 p-2" style="z-index: 998; {$connectDocked ? `position: fixed; top: ${$connectBarHeight + 44}px; right: 8px; left: auto; max-width: calc(100vw - 16px);` : ''}">
				<div class="mb-1 flex items-center justify-between gap-2">
					<!-- SELF-INCLUSIVE, in both places. The trigger badge and this line count the
						 same thing and disagreed by one: the badge said 4 while the list drew 5
						 rows. "Connected" is the people in the session, and you are one of them. -->
					<p class="ui-section-label">Connected ({$userdata.length})</p>
					<!-- R22 round 30 B2: ALL or ROOMS. One mesh can hold several scenes now, so
						 "who is here" and "who is WHERE" became two questions; this answers the
						 second. The armed half is `aria-pressed`, so the styling and the
						 accessibility tree cannot disagree (the tp-seg contract). -->
					<div class="tp-seg" role="group" aria-label="Peers view">
						<button
							id="peers-view-flat"
							class="tp-seg-btn"
							aria-pressed={peersView === 'flat'}
							title="Every peer in one list"
							onclick={() => setPeersView('flat')}>All</button
						>
						<button
							id="peers-view-rooms"
							class="tp-seg-btn"
							aria-pressed={peersView === 'rooms'}
							title="Grouped by the scene each peer is standing in"
							onclick={() => setPeersView('rooms')}>Rooms</button
						>
					</div>
				</div>
				<div class="peers-scroll">
				{#if peersView === 'rooms'}
					{#each peerGroups as group (group.key)}
						<!-- an inert header, not a folder: a room is where somebody is standing and
							 there is nothing to walk into — the flat list is one press away. -->
						<div class="peers-room-head" data-mine={group.mine ? 'true' : null} title={group.title}>
							<span class="truncate">{group.label}</span>
							<span class="peers-room-count">({group.users.length})</span>
							{#if group.mine}<span class="peers-room-mine">— your room</span>{/if}
						</div>
						{#each group.users as user (user[0])}
							{@render peerRow(user, user[0] === selfId, false)}
						{/each}
					{/each}
				{:else}
					{#each $userdata as user, i (user[0])}
						{@render peerRow(user, i === 0, true)}
					{/each}
				{/if}
				</div>
				<!-- 21-F3: the ADMIN half of "the game resets only when everyone has left
					 play, or an admin resets it". Offered only when there is a game to
					 reset, and DISABLED (with the reason in its tooltip) for anyone who is
					 not entitled — an admin where a roles plugin says so, the session host
					 otherwise. The flow node behind "Reset the game" is deliberately NOT
					 gated: a node in a replicated graph is the author's intent, not an
					 administrative act. -->
				{#if gameInUse}
					<div class="mt-1 border-t border-gray-700/60 pt-1">
						<button
							id="reset-game"
							type="button"
							class="reset-game-btn"
							disabled={!canReset}
							title={canReset
								? 'Send everyone back to the game menu'
								: ri
									? 'Only an admin can reset the game'
									: 'Only the session host can reset the game'}
							onclick={doResetGame}>Reset game</button
						>
					</div>
				{/if}
				<!-- 21-G5 (F7): CROSS-SCENE PRESENCE — who is in the project's OTHER
					 rooms/scenes, published by the rooms plugin (null in OSS = nothing
					 renders). Watch is DISABLED with the reason, not hidden: it cannot
					 reach a peer outside this mesh, and a dead button with no explanation
					 is how that gets filed as a bug. Invite's transport belongs to the
					 plugin; the button renders only when it provides one. -->
				{#if crossRooms.length}
					<div class="mt-1 border-t border-gray-700/60 pt-1" id="cross-scene-presence">
						{#each crossRooms as room (room.id)}
							<div class="px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">
								in {room.scene || room.name || 'another scene'}
							</div>
							{#each room.members ?? [] as m (m.peerId)}
								<div class="peers-row flex items-center gap-2 rounded px-1.5 py-1">
									<span class="min-w-0 flex-1 truncate text-sm" title={m.name || m.peerId}
										>{m.name || String(m.peerId ?? '').slice(0, 6)}</span
									>
									<span class="mode-chip" data-mode={m.mode === 'playing' ? 'playing' : 'editor'}
										>{m.mode === 'playing' ? 'playing' : 'editor'}</span
									>
									<button
										class="rounded px-1.5 py-0.5 text-xs text-gray-500"
										disabled
										title="In another scene — Watch cannot reach a peer outside your session. Join their room to watch."
										>Watch</button
									>
									{#if typeof $scenePresence?.invite === 'function'}
										<button
											class="cross-scene-invite rounded bg-primary-600/80 px-1.5 py-0.5 text-xs text-white hover:bg-primary-500"
											title="Ask them to join your scene — they get a toast; accepting connects them to your session"
											onclick={() => $scenePresence.invite(m.peerId, room)}>Invite</button
										>
									{/if}
								</div>
							{/each}
						{/each}
					</div>
				{/if}
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
	/* 21-F3 play-mode chip. Deliberately quieter than the role badge beside it: a role
	   is an authority and a mode is a passing fact. */
	.mode-chip { flex: 0 0 auto; font-size: 9px; font-weight: 600; letter-spacing: 0.02em; padding: 0 6px; border-radius: 9999px; text-transform: capitalize; line-height: 1.5; border: 1px solid transparent; }
	.mode-chip[data-mode='playing'] { color: #86efac; background: rgb(34 197 94 / 0.16); border-color: rgb(34 197 94 / 0.35); }
	.mode-chip[data-mode='editor'] { color: #cbd5e1; background: rgb(148 163 184 / 0.14); border-color: rgb(148 163 184 / 0.3); }
	/* P2b: which SCENE a peer is in. Deliberately quieter than the mode chip — a room
	   is where somebody is, not a state they are in — and highlighted only when it is
	   the scene YOU have open, which is the one comparison the list is read for. */
	.scene-chip { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; padding: 0 6px; border-radius: 9999px; line-height: 1.5; color: #cbd5e1; background: rgb(148 163 184 / 0.14); border: 1px solid rgb(148 163 184 / 0.3); }
	.scene-chip-here { color: #93c5fd; background: rgb(59 130 246 / 0.16); border-color: rgb(59 130 246 / 0.35); }
	/* R22 round 30 B2: the Rooms view’s group headers. Inert on purpose — a room is
	   where somebody is standing, not a place you walk into, so there is nothing to
	   click; the flat list is one press away. */
	.peers-room-head { display: flex; align-items: baseline; gap: 5px; padding: 7px 6px 2px; font-size: 9px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #9ca3af; }
	.peers-room-head[data-mine] { color: #93c5fd; }
	.peers-room-count, .peers-room-mine { flex: 0 0 auto; color: #6b7280; font-weight: 500; letter-spacing: 0; text-transform: none; }
	.reset-game-btn { width: 100%; padding: 5px 8px; border-radius: 7px; border: 1px solid rgb(255 255 255 / 0.12); background: transparent; color: #e5e7eb; font-size: 11px; text-align: left; cursor: pointer; }
	.reset-game-btn:hover:not(:disabled) { background: rgb(255 255 255 / 0.09); }
	.reset-game-btn:disabled { opacity: 0.45; cursor: not-allowed; }
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
<script>
	// 36-avatars (plan 76.5, decision: "a Settings-style side panel — opening it moves the viewport
	// camera to YOUR character, every change previews live on it, Apply closes the panel and returns
	// the camera"). Replaces the 17/129 Customize Character modal.
	//
	// The panel edits a DRAFT. The draft is drawn on a LOCAL preview of your character (avatarPreview
	// -> Player renders it through the same AvatarRig every peer uses for you), standing where your
	// head is and facing where you look — exactly what peers see. Nothing replicates until Apply,
	// which writes userdata slot 5 (+ the ping prefs) the way the old modal did; Cancel / Esc / the
	// close button drop the draft. Either way the camera flies back to where it was.
	import { get } from 'svelte/store';
	import { characterModalOpen, avatarConfig, userdata, peers } from '../../stores/appStore.js';
	import { globalCamera, orbitControls, isVRMode } from '../../stores/sceneStore.js';
	import { resolveAvatar } from '$lib/avatarModel';
	import { characterChoices, HEAD_OPTIONS, feetBelowHead, resolveCharacter } from '$lib/avatars/catalog';
	import { avatarPreview } from '$lib/avatars/avatarState';
	import { pingColor, pingSound, previewPing } from '$lib/ping';
	import { PING_SOUNDS, playPing } from '$lib/pingAudio';
	import { safeStorage } from '$lib/safeStorage';
	import { flyTo } from '$lib/objectActions';
	import { X, ChevronLeft, ChevronRight, Play } from '@lucide/svelte';

	const HATS = [
		{ value: 'none', name: 'None' },
		{ value: 'cap', name: 'Cap' },
		{ value: 'tophat', name: 'Top hat' },
		{ value: 'crown', name: 'Crown' }
	];
	const CLASSIC_SHAPES = HEAD_OPTIONS.filter((o) => o.value !== 'character');
	const choices = characterChoices();

	/** @type {any} */
	let draft = $state(resolveAvatar(null));
	let draftPingColor = $state('');
	let draftPingSound = $state('ding');
	let open = $state(false);
	/** @type {{position: number[], target: number[]} | null} */
	let savedView = null;
	/** @type {{position: number[], yaw: number} | null} */
	let stand = null;

	const myId = () => /** @type {any} */ (get(peers))?.peer?.id ?? '';
	const myPhoto = () => safeStorage.getItem('avatar') || '';
	const hasPhoto = $derived(open && !!myPhoto());
	const rigged = $derived(!!resolveCharacter(draft.character, myId()));
	const shownName = $derived(
		draft.character === 'auto'
			? `Surprise me — ${resolveCharacter('auto', myId())?.name ?? ''}`
			: (choices.find((c) => c.value === draft.character)?.name ?? draft.character)
	);

	// open/close follow the store (the profile menu's "Customize Character" sets it)
	$effect(() => {
		const want = $characterModalOpen;
		if (want && !open) begin();
		else if (!want && open) end(false);
	});

	function begin() {
		open = true;
		draft = { ...resolveAvatar(get(avatarConfig)) };
		draftPingColor = get(pingColor) || '';
		draftPingSound = get(pingSound) || 'ding';
		/** @type {any} */
		const cam = get(globalCamera);
		/** @type {any} */
		const controls = get(orbitControls);
		if (!cam) return;
		// YOUR character stands where your head is, facing where you look — what peers see
		const fwd = cam.getWorldDirection(new cam.position.constructor());
		const yaw = Math.atan2(-fwd.x, -fwd.z);
		const head = cam.position.toArray();
		stand = { position: head, yaw };
		savedView = { position: head, target: controls ? controls.target.toArray() : [head[0] + fwd.x, head[1] + fwd.y, head[2] + fwd.z] };
		pushPreview();
		if (get(isVRMode)) return;
		// fly to a 3/4 front view that fits the whole body (head to feet, ~2.2 m) at the camera's fov,
		// framed left of the panel
		const fx = -Math.sin(yaw);
		const fz = -Math.cos(yaw);
		const midY = head[1] - feetBelowHead() * 0.42;
		const fov = ((cam.fov || 40) * Math.PI) / 180;
		const dist = Math.max(4, 1.8 / Math.tan(fov / 2));
		const camPos = [head[0] + fx * dist - fz * dist * 0.3, midY + 0.25, head[2] + fz * dist + fx * dist * 0.3];
		// the camera's right (looking back at the body) is the body's left: shift the target that way so
		// the body sits in the free part of the viewport, not under the panel
		const side = window.innerWidth > 640 ? dist * 0.16 : 0;
		const target = [head[0] - fz * side, midY, head[2] + fx * side];
		flyTo(camPos, target, 500);
	}

	function end(/** @type {boolean} */ apply) {
		if (!open) return;
		if (apply) commit();
		open = false;
		avatarPreview.set(null);
		if (savedView && !get(isVRMode)) flyTo(savedView.position, savedView.target, 450);
		savedView = null;
		stand = null;
		if (get(characterModalOpen)) characterModalOpen.set(false);
	}

	function pushPreview() {
		if (!stand) return;
		avatarPreview.set({ config: { ...draft }, photo: myPhoto(), position: stand.position, yaw: stand.yaw, walk: false });
	}

	/** @param {Record<string, any>} patch */
	function edit(patch) {
		draft = { ...draft, ...patch };
		pushPreview();
	}

	function commit() {
		const next = { ...draft };
		avatarConfig.set(next);
		safeStorage.setItem('avatarConfig', JSON.stringify(next));
		pingColor.set(draftPingColor);
		pingSound.set(draftPingSound);
		/** @type {any} */
		const p = get(peers);
		const id = p?.peer?.id;
		const rows = /** @type {any[]} */ (get(userdata));
		rows.forEach((/** @type {any[]} */ row) => {
			if (row[0] === id) row[5] = next;
		});
		userdata.set(/** @type {any} */ (rows));
		p?.send?.({ type: 'userdata', userdata: rows });
	}

	/** @param {number} dir */
	function cycle(dir) {
		const ids = choices.map((c) => c.value);
		const i = Math.max(0, ids.indexOf(draft.character));
		edit({ character: ids[(i + dir + ids.length) % ids.length] });
	}

	function pingHere() {
		if (!stand) return;
		const p = stand.position;
		const fx = -Math.sin(stand.yaw);
		const fz = -Math.cos(stand.yaw);
		// beside the character (its right hand side), so the beam does not stand in front of it
		previewPing([p[0] - fz * 1.3, p[1] - feetBelowHead() + 0.05, p[2] + fx * 1.3], draftPingColor, draftPingSound);
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (!open || e.key !== 'Escape') return;
		e.stopPropagation();
		end(false);
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<aside id="character-panel" class="cp" aria-label="Customize character" data-tour="character-panel">
		<header class="cp-head">
			<b>Customize character</b>
			<button id="character-close" class="cp-icon" aria-label="Close without applying" title="Close (Esc)" onclick={() => end(false)}>
				<X size={18} aria-hidden="true" />
			</button>
		</header>

		<div class="cp-body">
			<section>
				<div class="cp-label">Character</div>
				<div class="cp-cycle">
					<button class="cp-icon" aria-label="Previous character" onclick={() => cycle(-1)}><ChevronLeft size={18} aria-hidden="true" /></button>
					<span id="character-current" class="cp-current">{shownName}</span>
					<button class="cp-icon" aria-label="Next character" onclick={() => cycle(1)}><ChevronRight size={18} aria-hidden="true" /></button>
				</div>
				<div class="cp-chips" role="radiogroup" aria-label="Character">
					{#each choices as c (c.value)}
						<button
							class="cp-chip"
							role="radio"
							aria-checked={draft.character === c.value}
							data-character={c.value}
							onclick={() => edit({ character: c.value })}>{c.value === 'auto' ? 'Surprise me' : c.value === 'classic' ? 'Classic head' : c.name}</button
						>
					{/each}
				</div>
			</section>

			<section>
				<div class="cp-label">Head</div>
				<div class="cp-chips" role="radiogroup" aria-label="Head">
					{#if rigged}
						<button class="cp-chip" role="radio" aria-checked={draft.face !== 'image' && draft.head === 'character'} data-head="character" onclick={() => edit({ head: 'character', face: 'label' })}
							>Character's own</button
						>
					{/if}
					{#each CLASSIC_SHAPES as o (o.value)}
						<button
							class="cp-chip"
							role="radio"
							aria-checked={draft.face !== 'image' && (rigged ? draft.head === o.value : draft.shape === o.value)}
							data-head={o.value}
							onclick={() => edit(rigged ? { head: o.value, face: 'label' } : { shape: o.value, face: 'label' })}>{o.name}</button
						>
					{/each}
					<button
						class="cp-chip"
						role="radio"
						aria-checked={draft.face === 'image'}
						data-head="photo"
						disabled={!hasPhoto}
						title={hasPhoto ? 'Your profile photo on a card' : 'Add a profile photo in Profile Settings first'}
						onclick={() => edit({ face: 'image' })}>My photo</button
					>
				</div>
			</section>

			<section>
				<div class="cp-label">Hat</div>
				<div class="cp-chips" role="radiogroup" aria-label="Hat">
					{#each HATS as o (o.value)}
						<button class="cp-chip" role="radio" aria-checked={draft.hat === o.value} data-hat={o.value} onclick={() => edit({ hat: o.value })}>{o.name}</button>
					{/each}
				</div>
			</section>

			<section>
				<div class="cp-label">Colours</div>
				{#if rigged}
					<div class="cp-row">
						<span>Outfit</span>
						<input
							id="character-outfit"
							type="color"
							value={draft.outfit || '#4f83cc'}
							oninput={(e) => edit({ outfit: e.currentTarget.value })}
							aria-label="Outfit colour"
						/>
						<button class="cp-chip" aria-pressed={!draft.outfit} disabled={!draft.outfit} onclick={() => edit({ outfit: '' })}>Original</button>
					</div>
				{/if}
				<div class="cp-row">
					<span>{rigged ? 'Head' : 'Body'}</span>
					<input id="character-body" type="color" value={draft.body} oninput={(e) => edit({ body: e.currentTarget.value })} aria-label="Head and body colour" />
				</div>
				<label class="cp-row cp-check">
					<input type="checkbox" class="tp-check" checked={draft.showLabel} onchange={(e) => edit({ showLabel: e.currentTarget.checked })} />
					<span>Show my name above me</span>
				</label>
			</section>

			<section>
				<div class="cp-label">Ping</div>
				<div class="cp-row">
					<span>Colour</span>
					<input id="character-ping-color" type="color" value={draftPingColor || '#4f83cc'} oninput={(e) => (draftPingColor = e.currentTarget.value)} aria-label="Ping colour" />
					<button class="cp-chip" aria-pressed={!draftPingColor} disabled={!draftPingColor} onclick={() => (draftPingColor = '')}>My peer colour</button>
				</div>
				<div class="cp-row">
					<span>Sound</span>
					<select id="character-ping-sound" class="cp-select" value={draftPingSound} onchange={(e) => { draftPingSound = e.currentTarget.value; playPing(draftPingSound); }}>
						{#each PING_SOUNDS as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
					</select>
					<button id="character-ping-preview" class="cp-chip" title="Ping beside your character (only you see and hear it)" onclick={pingHere}>
						<Play size={13} aria-hidden="true" /> Preview
					</button>
				</div>
				<p class="cp-note">Peers see and hear YOUR pings this way.</p>
			</section>
		</div>

		<footer class="cp-foot">
			<button id="character-cancel" class="cp-btn" onclick={() => end(false)}>Cancel</button>
			<button id="character-apply" class="cp-btn cp-primary" onclick={() => end(true)}>Apply</button>
		</footer>
	</aside>
{/if}

<style>
	.cp {
		position: fixed;
		right: 0;
		top: 64px;
		bottom: calc(var(--bottom-inset, 0px) + var(--controls-inset, 0px));
		width: min(340px, 92vw);
		z-index: calc(var(--z-bottom, 35) - 1);
		display: flex;
		flex-direction: column;
		background: var(--surface, #1f2937);
		color: var(--text, #e5e7eb);
		border: 1px solid var(--border, #374151);
		border-right: none;
		border-radius: 0.5rem 0 0 0.5rem;
		box-shadow: 0 8px 28px rgb(0 0 0 / 0.35);
	}
	@media (min-width: 641px) {
		:global(:root.connect-docked) .cp {
			top: calc(var(--connect-bottom, 0px) + 4px);
			z-index: 1000;
		}
	}
	/* narrow: a bottom sheet, so the character stays visible above it */
	@media (max-width: 640px) {
		.cp {
			top: auto;
			left: 0;
			width: 100vw;
			height: min(52vh, 460px);
			bottom: var(--controls-inset, 0px);
			border-radius: 0.75rem 0.75rem 0 0;
			border-right: 1px solid var(--border, #374151);
		}
	}
	.cp-head,
	.cp-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.6rem 0.75rem;
		border-bottom: 1px solid var(--border, #374151);
	}
	.cp-foot {
		border-bottom: none;
		border-top: 1px solid var(--border, #374151);
		justify-content: flex-end;
	}
	.cp-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.25rem 0.75rem 0.75rem;
	}
	section {
		padding: 0.6rem 0 0.4rem;
		border-bottom: 1px solid var(--border, #374151);
	}
	section:last-child {
		border-bottom: none;
	}
	.cp-label {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted, #9ca3af);
		margin-bottom: 0.4rem;
	}
	.cp-cycle {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.45rem;
	}
	.cp-current {
		flex: 1;
		text-align: center;
		font-weight: 600;
	}
	.cp-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
	}
	.cp-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.22rem 0.55rem;
		border-radius: 9999px;
		border: 1px solid var(--border, #374151);
		background: var(--surface-2, #374151);
		color: var(--text, #e5e7eb);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.cp-chip:hover:not(:disabled) {
		border-color: var(--accent, #3b82f6);
	}
	.cp-chip[aria-checked='true'] {
		background: var(--accent, #3b82f6);
		border-color: var(--accent, #3b82f6);
		color: var(--on-accent, #fff);
	}
	.cp-chip:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.cp-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.35rem 0;
		font-size: 0.85rem;
	}
	.cp-row > span:first-child {
		width: 3.6rem;
		color: var(--muted, #9ca3af);
	}
	.cp-check > span {
		width: auto !important;
		color: var(--text, #e5e7eb) !important;
	}
	.cp-row input[type='color'] {
		width: 2.6rem;
		height: 1.8rem;
		padding: 0 2px;
		border: 1px solid var(--border, #374151);
		border-radius: 0.3rem;
		background: var(--field, var(--surface-2, #374151));
		cursor: pointer;
	}
	.cp-select {
		flex: 1;
		min-width: 0;
		padding: 0.2rem 0.4rem;
		border-radius: 0.3rem;
		border: 1px solid var(--border, #374151);
		background: var(--field, var(--surface-2, #374151));
		color: var(--text, #e5e7eb);
		font-size: 0.85rem;
	}
	.cp-note {
		font-size: 0.75rem;
		color: var(--muted, #9ca3af);
		margin: 0.2rem 0 0;
	}
	.cp-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.9rem;
		height: 1.9rem;
		border-radius: 0.4rem;
		color: var(--text, #e5e7eb);
		background: transparent;
		border: 1px solid transparent;
		cursor: pointer;
	}
	.cp-icon:hover {
		background: var(--hover, var(--surface-2, #374151));
	}
	.cp-btn {
		padding: 0.35rem 0.9rem;
		border-radius: 0.4rem;
		border: 1px solid var(--border, #374151);
		background: var(--surface-2, #374151);
		color: var(--text, #e5e7eb);
		cursor: pointer;
		font-size: 0.85rem;
	}
	.cp-primary {
		background: var(--accent, #3b82f6);
		border-color: var(--accent, #3b82f6);
		color: var(--on-accent, #fff);
		font-weight: 600;
	}
</style>

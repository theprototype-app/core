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
	import { resolveAvatar, AVATAR_DEFAULTS } from '$lib/avatarModel';
	import { characterChoices, HEAD_OPTIONS, feetBelowHead, resolveCharacter } from '$lib/avatars/catalog';
	import { avatarPreview } from '$lib/avatars/avatarState';
	import { pingColor, pingSound, previewPing } from '$lib/ping';
	import { PING_SOUNDS, playPing } from '$lib/pingAudio';
	import { safeStorage } from '$lib/safeStorage';
	import { flyTo } from '$lib/objectActions';
	import Icon from '../ui/Icon.svelte';
	// 38 R7 + NOTES-38 #2: a resizable DRAWER on the redesign kit — WindowChrome size="modal" header,
	// chips with the accent selection (role=radio + the data-* hooks kept), a Toggle for the name
	// label, Cancel / Apply (the one primary) in the footer, the minimal scrollbar on the body.
	import WindowChrome from '../ui/WindowChrome.svelte';
	import Button from '../ui/Button.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

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
	// the view the camera is flying back to, and when that flight ends: a reopen DURING it must take
	// this as home, not the mid-flight camera (or the next Apply returns you somewhere in between)
	/** @type {{position: number[], target: number[], until: number} | null} */
	let returning = null;

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
		const yawNow = Math.atan2(-fwd.x, -fwd.z);
		const flying = returning && performance.now() < returning.until ? returning : null;
		const head = flying ? flying.position : cam.position.toArray();
		const homeTarget = flying ? flying.target : controls ? controls.target.toArray() : [head[0] + fwd.x, head[1] + fwd.y, head[2] + fwd.z];
		const yaw = flying ? Math.atan2(-(homeTarget[0] - head[0]), -(homeTarget[2] - head[2])) : yawNow;
		returning = null;
		stand = { position: head, yaw };
		savedView = { position: head, target: homeTarget };
		pushPreview();
		if (get(isVRMode)) return;
		aim(500);
	}

	// NOTES-38 #2: the drawer is resizable (its inner edge — the left edge beside the viewport, the
	// top edge of the phone sheet) and the camera frames your character in the part of the viewport
	// the drawer leaves free, re-aimed when a resize ends. The size is a LOCAL view pref.
	const SIZE_KEY = 'characterDrawer:size';
	/** @returns {{w: number, h: number}} */
	function readSize() {
		try {
			const v = JSON.parse(safeStorage.getItem(SIZE_KEY) || 'null');
			return { w: Number(v?.w) || 340, h: Number(v?.h) || 0 };
		} catch {
			return { w: 340, h: 0 };
		}
	}
	const initial = readSize();
	let drawerW = $state(initial.w);
	let drawerH = $state(initial.h);
	let narrow = $state(typeof window !== 'undefined' && window.innerWidth <= 640);
	let resizing = $state(false);
	const MIN_W = 300;
	const MIN_H = 220;
	const maxW = () => Math.max(MIN_W, Math.round(window.innerWidth * 0.6));
	const maxH = () => Math.max(MIN_H, Math.round(window.innerHeight * 0.8));
	const sheetH = () => (drawerH > 0 ? Math.min(Math.max(drawerH, MIN_H), maxH()) : Math.min(window.innerHeight * 0.52, 460));
	const panelW = () => Math.min(Math.max(drawerW, MIN_W), maxW());

	/** fly to a 3/4 front view that fits the whole body (head to feet, ~2.2 m) in the FREE part of
	 * the viewport: left of the drawer on desktop, above the sheet on a phone. @param {number} ms */
	function aim(ms) {
		/** @type {any} */
		const cam = get(globalCamera);
		if (!cam || !stand || get(isVRMode)) return;
		const head = stand.position;
		const yaw = stand.yaw;
		const fx = -Math.sin(yaw);
		const fz = -Math.cos(yaw);
		const midY = head[1] - feetBelowHead() * 0.42;
		const fov = ((cam.fov || 40) * Math.PI) / 180;
		const H = window.innerHeight || 1;
		const freeH = narrow ? Math.max(0.3, (H - sheetH()) / H) : 1;
		const dist = Math.max(4, 1.8 / Math.tan(fov / 2) / freeH);
		const camPos = [head[0] + fx * dist - fz * dist * 0.3, midY + 0.25, head[2] + fz * dist + fx * dist * 0.3];
		// world metres per screen pixel at the body's distance
		const perPx = (2 * dist * Math.tan(fov / 2)) / H;
		// the camera's right (looking back at the body) is the body's left: shift the target that way
		// by half the drawer so the body sits centred in the free part, not under the drawer
		const side = narrow ? 0 : Math.min(dist * 0.6, (panelW() / 2) * perPx);
		const drop = narrow ? (sheetH() / 2) * perPx : 0;
		const target = [head[0] - fz * side, midY - drop, head[2] + fx * side];
		flyTo(camPos, target, ms);
	}

	/** @param {PointerEvent} e */
	function startResize(e) {
		if (e.button !== 0) return;
		e.preventDefault();
		resizing = true;
		const x0 = e.clientX;
		const y0 = e.clientY;
		const w0 = panelW();
		const h0 = sheetH();
		/** @param {PointerEvent} ev */
		const move = (ev) => {
			if (narrow) drawerH = Math.min(Math.max(h0 - (ev.clientY - y0), MIN_H), maxH());
			else drawerW = Math.min(Math.max(w0 - (ev.clientX - x0), MIN_W), maxW());
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			resizing = false;
			safeStorage.setItem(SIZE_KEY, JSON.stringify({ w: drawerW, h: drawerH }));
			aim(300);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	}
	/** keyboard resize on the grip: arrows step 16 px (Shift 64), the separator pattern */
	function keyResize(/** @type {KeyboardEvent} */ e) {
		const step = e.shiftKey ? 64 : 16;
		const grow = narrow ? e.key === 'ArrowUp' : e.key === 'ArrowLeft';
		const shrink = narrow ? e.key === 'ArrowDown' : e.key === 'ArrowRight';
		if (!grow && !shrink) return;
		e.preventDefault();
		if (narrow) drawerH = Math.min(Math.max(sheetH() + (grow ? step : -step), MIN_H), maxH());
		else drawerW = Math.min(Math.max(panelW() + (grow ? step : -step), MIN_W), maxW());
		safeStorage.setItem(SIZE_KEY, JSON.stringify({ w: drawerW, h: drawerH }));
		aim(200);
	}
	function onWindowResize() {
		narrow = window.innerWidth <= 640;
	}

	/** NOTES-38 #2: Apply AND Cancel put the viewport back EXACTLY where it was. The tween lands on
	 * the saved pose; OrbitControls' damping can still carry a sliver of orbit momentum past it, so
	 * once the flight is over the pose is written once more with damping briefly off (which also
	 * zeroes the momentum) — unless something else has taken the camera meanwhile.
	 * @param {{position: number[], target: number[]}} view @param {number} ms */
	function returnHome(view, ms) {
		flyTo(view.position, view.target, ms);
		setTimeout(() => {
			/** @type {any} */
			const cam = get(globalCamera);
			/** @type {any} */
			const controls = get(orbitControls);
			if (!cam || !controls || open) return;
			const p = cam.position;
			const off = Math.hypot(p.x - view.position[0], p.y - view.position[1], p.z - view.position[2]);
			if (off > 0.25) return; // a new flight or the user's own hands own the camera now
			const damping = controls.enableDamping;
			controls.enableDamping = false;
			controls.update();
			cam.position.fromArray(view.position);
			controls.target.fromArray(view.target);
			controls.update();
			controls.enableDamping = damping;
		}, ms + 80);
	}

	function end(/** @type {boolean} */ apply) {
		if (!open) return;
		if (apply) commit();
		open = false;
		avatarPreview.set(null);
		if (savedView && !get(isVRMode)) {
			returnHome(savedView, 450);
			returning = { ...savedView, until: performance.now() + 500 };
		}
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

<svelte:window onkeydown={onKey} onresize={onWindowResize} />

{#if open}
	<aside
		id="character-panel"
		class="tp-ui cp"
		class:cp-resizing={resizing}
		aria-label="Customize character"
		data-tour="character-panel"
		style:--cp-w={narrow ? null : panelW() + 'px'}
		style:--cp-h={narrow ? sheetH() + 'px' : null}
	>
		<!-- the inner edge: drag (or arrow keys) to resize; the camera re-frames on release. A
		     focusable role=separator IS a widget (WAI-ARIA window splitter); svelte's a11y table
		     does not know it. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			id="character-resize"
			class="cp-grip"
			role="separator"
			aria-orientation={narrow ? 'horizontal' : 'vertical'}
			aria-label="Resize the character drawer"
			aria-valuenow={narrow ? Math.round(sheetH()) : Math.round(panelW())}
			tabindex="0"
			onpointerdown={startResize}
			onkeydown={keyResize}
		></div>
		<WindowChrome size="modal" body={false} title="Customize character">
			{#snippet actions()}
				<Button id="character-close" variant="icon" icon="x" label="Close without applying" title="Close (Esc)" onclick={() => end(false)} />
			{/snippet}
		</WindowChrome>

		<div class="cp-body" use:minimalScroll>
			<section>
				<h3 class="cp-label">Character</h3>
				<div class="cp-cycle">
					<Button variant="icon" size="sm" icon="chevron-left" label="Previous character" onclick={() => cycle(-1)} />
					<span id="character-current" class="cp-current">{shownName}</span>
					<Button variant="icon" size="sm" icon="chevron-right" label="Next character" onclick={() => cycle(1)} />
				</div>
				<div class="cp-chips" role="radiogroup" aria-label="Character">
					{#each choices as c (c.value)}
						<button
							type="button"
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
				<h3 class="cp-label">Head</h3>
				<div class="cp-chips" role="radiogroup" aria-label="Head">
					{#if rigged}
						<button type="button" class="cp-chip" role="radio" aria-checked={draft.face !== 'image' && draft.head === 'character'} data-head="character" onclick={() => edit({ head: 'character', face: 'label' })}
							>Character's own</button
						>
					{/if}
					{#each CLASSIC_SHAPES as o (o.value)}
						<button
							type="button"
							class="cp-chip"
							role="radio"
							aria-checked={draft.face !== 'image' && (rigged ? draft.head === o.value : draft.shape === o.value)}
							data-head={o.value}
							onclick={() => edit(rigged ? { head: o.value, face: 'label' } : { shape: o.value, face: 'label' })}>{o.name}</button
						>
					{/each}
					<button
						type="button"
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
				<h3 class="cp-label">Hat</h3>
				<div class="cp-chips" role="radiogroup" aria-label="Hat">
					{#each HATS as o (o.value)}
						<button type="button" class="cp-chip" role="radio" aria-checked={draft.hat === o.value} data-hat={o.value} onclick={() => edit({ hat: o.value })}>{o.name}</button>
					{/each}
				</div>
			</section>

			<section>
				<h3 class="cp-label">Colours</h3>
				<div class="cp-card">
					{#if rigged}
						<div class="cp-row">
							<span class="cp-row-label">Outfit</span>
							<input
								id="character-outfit"
								type="color"
								value={draft.outfit || AVATAR_DEFAULTS.body}
								oninput={(e) => edit({ outfit: e.currentTarget.value })}
								aria-label="Outfit colour"
							/>
							<button type="button" class="cp-chip" aria-pressed={!draft.outfit} disabled={!draft.outfit} onclick={() => edit({ outfit: '' })}>Original</button>
						</div>
					{/if}
					<div class="cp-row">
						<span class="cp-row-label">{rigged ? 'Head' : 'Body'}</span>
						<input id="character-body" type="color" value={draft.body} oninput={(e) => edit({ body: e.currentTarget.value })} aria-label="Head and body colour" />
					</div>
					<div class="cp-row">
						<span id="character-label-text" class="cp-row-label cp-row-wide">Show my name above me</span>
						<Toggle
							id="character-show-label"
							labelledby="character-label-text"
							checked={!!draft.showLabel}
							onchange={(/** @type {boolean} */ on) => edit({ showLabel: on })}
						/>
					</div>
				</div>
			</section>

			<section>
				<h3 class="cp-label">Ping</h3>
				<div class="cp-card">
					<div class="cp-row">
						<span class="cp-row-label">Colour</span>
						<input id="character-ping-color" type="color" value={draftPingColor || AVATAR_DEFAULTS.body} oninput={(e) => (draftPingColor = e.currentTarget.value)} aria-label="Ping colour" />
						<button type="button" class="cp-chip" aria-pressed={!draftPingColor} disabled={!draftPingColor} onclick={() => (draftPingColor = '')}>My peer colour</button>
					</div>
					<div class="cp-row">
						<span class="cp-row-label">Sound</span>
						<select id="character-ping-sound" class="cp-select" value={draftPingSound} onchange={(e) => { draftPingSound = e.currentTarget.value; playPing(draftPingSound); }}>
							{#each PING_SOUNDS as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
						</select>
						<Button id="character-ping-preview" variant="outline" size="sm" icon="play" title="Ping beside your character (only you see and hear it)" onclick={pingHere}>Preview</Button>
					</div>
				</div>
				<p class="cp-note">Peers see and hear your pings this way.</p>
			</section>
		</div>

		<footer class="cp-foot">
			<Button id="character-cancel" variant="outline" onclick={() => end(false)}>Cancel</Button>
			<Button id="character-apply" variant="primary" onclick={() => end(true)}>Apply</Button>
		</footer>
	</aside>
{/if}

<style>
	.cp {
		position: fixed;
		right: 0;
		top: 64px;
		bottom: calc(var(--bottom-inset, 0px) + var(--controls-inset, 0px));
		width: min(var(--cp-w, 340px), 92vw);
		z-index: calc(var(--z-bottom, 35) - 1);
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		background: var(--surface-1);
		color: var(--text);
		border: 1px solid var(--border);
		border-right: none;
		border-radius: var(--radius-modal) 0 0 var(--radius-modal);
		box-shadow: var(--shadow-window);
		font-family: var(--font-ui);
		font-size: var(--fs-body);
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
			height: var(--cp-h, min(52vh, 460px));
			bottom: var(--controls-inset, 0px);
			border-radius: var(--radius-modal) var(--radius-modal) 0 0;
			border-right: 1px solid var(--border);
		}
	}
	.cp > :global(.wc) {
		flex-shrink: 0;
		background: transparent;
		border: 0;
		border-radius: 0;
	}
	/* the drag edge: the drawer's inner (left) edge, the sheet's top edge on a phone */
	.cp-grip {
		position: absolute;
		left: -4px;
		top: 0;
		bottom: 0;
		width: 8px;
		z-index: 2;
		cursor: ew-resize;
		touch-action: none;
	}
	.cp-grip::after {
		content: '';
		position: absolute;
		left: 3px;
		top: 50%;
		width: 2px;
		height: 40px;
		margin-top: -20px;
		border-radius: var(--radius-pill);
		background: var(--border-strong);
		opacity: 0;
		transition: opacity 0.15s ease;
	}
	.cp-grip:hover::after,
	.cp-grip:focus-visible::after,
	.cp-resizing .cp-grip::after {
		opacity: 1;
		background: var(--accent);
	}
	@media (max-width: 640px) {
		.cp-grip {
			left: 0;
			right: 0;
			top: -4px;
			bottom: auto;
			width: auto;
			height: 20px;
			cursor: ns-resize;
		}
		/* the sheet's grab handle, always shown */
		.cp-grip::after {
			left: 50%;
			top: 10px;
			width: 40px;
			height: 4px;
			margin: 0 0 0 -20px;
			opacity: 1;
		}
	}
	.cp-resizing {
		user-select: none;
	}
	.cp-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-1) var(--space-5) var(--space-4);
	}
	section {
		padding: var(--space-3) 0;
	}
	section + section {
		border-top: 1px solid var(--border);
	}
	.cp-label {
		margin: 0 0 var(--space-2);
		font-size: var(--fs-section);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.cp-cycle {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}
	.cp-current {
		flex: 1;
		text-align: center;
		font-weight: 600;
	}
	.cp-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	/* SPEC Chips: pill, border-strong; selected = accent-soft fill + accent border */
	.cp-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		height: var(--control-h-sm);
		padding: 0 12px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border-strong);
		background: transparent;
		color: var(--text-2);
		font: inherit;
		font-size: var(--fs-desc);
		cursor: pointer;
	}
	.cp-chip:hover:not(:disabled) {
		background: var(--surface-hover);
	}
	.cp-chip[aria-checked='true'],
	.cp-chip[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.cp-chip:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.cp-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-2);
	}
	.cp-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: var(--row-h);
		padding: var(--space-1) var(--space-3);
	}
	.cp-row + .cp-row {
		border-top: 1px solid var(--border);
	}
	.cp-row-label {
		width: 3.6rem;
		color: var(--text-2);
		font-size: var(--fs-desc);
	}
	.cp-row-wide {
		flex: 1;
		width: auto;
		color: var(--text);
		font-size: var(--fs-body);
	}
	.cp-row input[type='color'] {
		width: 2.6rem;
		height: 1.9rem;
		padding: 0 2px;
		border: 1px solid var(--border-input);
		border-radius: var(--radius-input);
		background: var(--surface-inset);
		cursor: pointer;
	}
	.cp-select {
		flex: 1;
		min-width: 0;
		height: var(--control-h-sm);
		padding: 0 8px;
		border-radius: var(--radius-input);
		border: 1px solid var(--border-input);
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-input);
	}
	.cp-note {
		font-size: var(--fs-desc);
		color: var(--text-muted);
		margin: var(--space-2) 0 0;
	}
	.cp-foot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		flex-shrink: 0;
		padding: var(--space-3) var(--space-5);
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 85%, var(--bg-app));
	}
</style>

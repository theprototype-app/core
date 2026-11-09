<script lang="ts">
	// uir-people — Peers B "Person card" (owner 2026-11-09, review artifact 1PEaFpTgu9uFJQrCuCFQWh ▸ Peers B).
	// A press on a People row flips the popover to that person; a back arrow returns to the list. ONE card per
	// person: who (avatar, name, role, status, device, how long they have been here), what they are doing now
	// (the object they hold, or the scene they stand in), the connection over the last minute, and EVERY action
	// the peer menu holds today as buttons.
	//
	// THE ACTIONS ARE THE MENU'S OWN LIST (`items`, built by Users.svelte's peerMenuRows -> lib/peerMenu.js):
	// the card renders those rows, so the card and the right-click / long-press menu cannot drift — a row added
	// to the menu shows here with no second edit. "View profile" is the card itself, so it is not repeated.
	//
	// THE AVATAR: the photo, else their colour (the lock / cursor colour, peerColor) with the initial — what the
	// Connect chip already draws. uir-people → int: swap for PL33's one avatar component when 1.64 lands.
	import Icon from '../ui/Icon.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import { userdata } from '../../stores/appStore.js';
	import { peerHands, lockedObjects, objectsGroup } from '../../stores/sceneStore.js';
	import { peerColor } from '$lib/lockControl';
	import { speakingPeers } from '$lib/voiceChat';
	import { peerQuality } from '$lib/networkQuality';
	import { peerFacts, agoText } from '$lib/peerFacts';
	import { peerJoinedAt, sessionHost } from '$lib/connectionState';
	import { rolesInfo } from '$lib/cloudHooks';
	import { kindOfRow } from '$lib/inviteStore';
	import {
		presenceOf,
		presenceEnabled,
		myPresence,
		setMyPresence,
		PRESENCE,
		PRESENCE_LABEL,
		PRESENCE_ICON,
		pingHistory,
		sparkPoints
	} from '$lib/peoplePresence';

	let {
		peerId,
		self = false,
		items = [],
		where = '',
		onback,
		onshowediting,
		onopensettings
	}: {
		peerId: string;
		self?: boolean;
		/** the peer menu's rows (ContextMenu items: `{section}` heads + `{testid,label,icon,action,disabled,tooltip,danger,checked}`) */
		items?: any[];
		/** the scene chip text the roster row shows ('' = not told) */
		where?: string;
		onback: () => void;
		onshowediting?: () => void;
		onopensettings?: () => void;
	} = $props();

	const row = $derived(($userdata as any[]).find((u) => u[0] === peerId) ?? null);
	const isAgent = $derived(kindOfRow(row) === 'agent');
	const name = $derived(row?.[1] || (isAgent ? 'AI agent' : String(peerId).slice(0, 6).toUpperCase()));
	const initial = $derived(String(name).trim().charAt(0).toUpperCase() || '?');
	const colour = $derived(peerColor(peerId));
	const speaking = $derived($speakingPeers.includes(peerId));
	const status = $derived(self ? ($presenceEnabled ? $myPresence : '') : presenceOf(row));
	const role = $derived($rolesInfo ? (self ? $rolesInfo.myRole : $rolesInfo.roleOf(peerId)) : '');
	const facts = $derived(($peerFacts as any)[peerId] ?? {});
	const device = $derived(
		$peerHands[peerId]?.active || facts.device === 'vr' ? 'VR headset' : facts.device === 'phone' ? 'Phone or tablet' : facts.device === 'desktop' ? 'Desktop' : ''
	);
	// a slow clock for "joined 12 min ago"
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 15000);
		return () => clearInterval(t);
	});
	const joinedAt = $derived(($peerJoinedAt as any)[peerId] as number | undefined);
	const sub = $derived(
		[device, self ? 'you' : $sessionHost === peerId ? 'hosts this session' : joinedAt ? 'joined ' + agoText(joinedAt, now) : ''].filter(Boolean).join(' · ')
	);
	// what they are doing now: the object they hold a lock on, else where they stand
	const editingName = $derived.by(() => {
		const lock = ($lockedObjects as any[]).find((l) => l[0] === peerId);
		if (!lock) return '';
		const obj = ($objectsGroup as any)?.getObjectByProperty?.('uuid', lock[1]);
		return obj ? obj.name || obj.type || 'an object' : 'an object';
	});
	const q = $derived(self ? null : ($peerQuality as any)[peerId]);
	const qWords = $derived(
		q
			? (q.level === 'good' ? 'Good' : q.level === 'ok' ? 'Fair' : q.level === 'bad' ? 'Poor' : 'Measuring') +
					(q.rtt != null ? ' · ' + Math.round(q.rtt) + ' ms' : '') +
					(q.relayed ? ' · relayed' : '')
			: ''
	);
	// the graph re-reads the log whenever a new sample lands (the store ticks with it)
	const spark = $derived.by(() => {
		void q;
		return sparkPoints(pingHistory(peerId), 280, 26);
	});

	/** the menu rows grouped by their section heads, the card's own entry left out */
	const groups = $derived.by(() => {
		const out: { title: string; rows: any[] }[] = [];
		for (const it of items) {
			if (it.section) {
				out.push({ title: it.section, rows: [] });
				continue;
			}
			if (it.testid === 'peer-menu-profile') continue;
			if (!out.length) out.push({ title: '', rows: [] });
			out[out.length - 1].rows.push(it);
		}
		return out.filter((g) => g.rows.length);
	});
	const short = (t: string) => String(t || '').replace(/^peer-menu-/, '');
	const PRESENCE_OPTIONS = PRESENCE.map((p) => ({ value: p, label: PRESENCE_LABEL[p], icon: PRESENCE_ICON[p] }));

	let backEl: HTMLButtonElement | null = $state(null);
	$effect(() => {
		// keyboard users land on the way back (53 A3); a pointer press does not mind
		queueMicrotask(() => backEl?.focus({ preventScroll: true }));
	});
	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' || (e.key === 'Backspace' && !(e.target as HTMLElement)?.closest?.('input, textarea'))) {
			e.preventDefault();
			e.stopPropagation();
			onback();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section id="person-card" class="pc" data-peer-id={peerId} data-self={self ? 'true' : null} aria-label={name + (self ? ' (you)' : '')} onkeydown={onKey}>
	<div class="pc-top">
		<button bind:this={backEl} type="button" id="person-card-back" class="pc-back" title="Back to everyone (Esc)" aria-label="Back to the people list" onclick={onback}>
			<Icon name="arrow-left" size={16} aria-hidden="true" />People
		</button>
	</div>
	<div class="pc-hero">
		<span class="pc-av" class:speaking style:--pc-ring={colour} style:background={row?.[2] ? 'var(--surface-2)' : colour} aria-hidden="true">
			{#if row?.[2]}<img src={row[2]} alt="" />{:else if isAgent}<Icon name="bot" size={24} />{:else}{initial}{/if}
			{#if status}<span class="pc-av-status" data-presence={status}><Icon name={PRESENCE_ICON[status]} size={16} /></span>{/if}
		</span>
		<div class="pc-who">
			<div class="pc-name">
				<span class="truncate" title={name}>{name}</span>
				{#if self}<span class="pc-you">(you)</span>{/if}
				{#if isAgent}<span class="pc-chip pc-chip-ai"><Icon name="bot" size={16} aria-hidden="true" />AI</span>{/if}
			</div>
			{#if sub}<div class="pc-sub" id="person-card-sub">{sub}</div>{/if}
			<div class="pc-chips">
				{#if role}<span class="pc-chip pc-role" data-role={role}>{role}</span>{/if}
				{#if status}<span class="pc-chip pc-presence" id="person-card-presence" data-presence={status}><Icon name={PRESENCE_ICON[status]} size={16} aria-hidden="true" />{PRESENCE_LABEL[status]}</span>{/if}
				{#if speaking}<span class="pc-chip pc-speaking"><Icon name="mic" size={16} aria-hidden="true" />speaking</span>{/if}
			</div>
		</div>
	</div>

	{#if self}
		<div class="pc-block">
			<div class="pc-k">Your status</div>
			{#if $presenceEnabled}
				<Segmented id="person-presence" label="Your status" full options={PRESENCE_OPTIONS} value={$myPresence} onchange={(v: string) => setMyPresence(v as any)} />
			{:else}
				<p class="pc-hint">
					Off. <button type="button" class="pc-link" id="person-presence-settings" onclick={() => onopensettings?.()}>Show my status</button> lets everyone here see Available, Busy or Away.
				</p>
			{/if}
		</div>
	{/if}

	{#if editingName || where}
		<div class="pc-block pc-now" id="person-card-now">
			<div class="pc-k">Now</div>
			{#if editingName}
				<span>Editing <b>{editingName}</b></span>
				{#if !self && onshowediting}<button type="button" class="pc-link" onclick={onshowediting}>Show</button>{/if}
			{:else}
				<span>In <b>{where}</b></span>
			{/if}
		</div>
	{/if}

	{#if !self && qWords}
		<div class="pc-block" id="person-card-connection">
			<div class="pc-k">Connection · {qWords}</div>
			{#if spark}
				<svg class="pc-spark" viewBox="0 0 280 26" preserveAspectRatio="none" role="img" aria-label="Round-trip time over the last minute">
					<polyline points={spark} />
				</svg>
			{/if}
		</div>
	{/if}

	{#each groups as g (g.title)}
		<div class="pc-block" data-group={g.title}>
			{#if g.title}<div class="pc-k">{g.title}</div>{/if}
			<div class="pc-actions">
				{#each g.rows as it (it.testid)}
					<button
						type="button"
						class="pc-act"
						class:danger={it.danger}
						class:on={it.checked}
						data-testid={'person-' + short(it.testid)}
						disabled={it.disabled}
						title={it.tooltip || it.label}
						aria-pressed={it.checked === undefined ? undefined : !!it.checked}
						onclick={() => it.action?.()}
					>
						{#if it.icon}<Icon name={it.icon} size={16} aria-hidden="true" />{/if}<span class="truncate">{it.label}</span>
					</button>
				{/each}
			</div>
		</div>
	{/each}
</section>

<style>
	.pc {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 6px 10px 12px;
		min-width: 0;
	}
	.pc-top {
		display: flex;
		align-items: center;
	}
	.pc-back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: var(--control-h-sm);
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-button);
		background: transparent;
		color: var(--text-2);
		font-size: var(--fs-desc);
		cursor: pointer;
	}
	.pc-back:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.pc-hero {
		display: flex;
		gap: 12px;
		align-items: center;
		min-width: 0;
	}
	.pc-av {
		position: relative;
		flex: none;
		display: grid;
		place-items: center;
		width: 56px;
		height: 56px;
		border-radius: 50%;
		color: var(--bg-app);
		font: 700 22px var(--font-ui);
		/* the ring is THEIR colour: the lock and cursor colour (O2) */
		box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px var(--pc-ring);
	}
	.pc-av img {
		width: 100%;
		height: 100%;
		border-radius: 50%;
		object-fit: cover;
	}
	.pc-av.speaking {
		box-shadow: 0 0 0 2px var(--surface-1), 0 0 0 4px var(--speaking);
	}
	.pc-av-status {
		position: absolute;
		right: -2px;
		bottom: -2px;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--surface-1);
		border: 1px solid var(--border-strong);
	}
	[data-presence='available'] {
		color: var(--ink-good);
	}
	[data-presence='busy'] {
		color: var(--ink-bad);
	}
	[data-presence='away'] {
		color: var(--ink-warn);
	}
	.pc-who {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.pc-name {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-size: var(--fs-title, 15px);
		font-weight: 600;
		color: var(--text);
	}
	.pc-you {
		color: var(--text-faint);
		font-weight: 400;
		font-size: var(--fs-desc);
	}
	.pc-sub {
		color: var(--text-muted);
		font-size: var(--fs-desc);
	}
	.pc-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 2px;
	}
	.pc-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 7px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--border-strong);
		font-size: var(--fs-badge);
		color: var(--text-muted);
		white-space: nowrap;
	}
	.pc-role {
		text-transform: capitalize;
		background: var(--accent-soft);
		color: var(--text);
		border-color: transparent;
	}
	.pc-speaking {
		color: var(--speaking);
	}
	.pc-block {
		display: flex;
		flex-direction: column;
		gap: 5px;
		min-width: 0;
	}
	.pc-now {
		flex-direction: row;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 8px;
		padding: 7px 9px;
		border: 1px solid var(--border);
		border-radius: var(--radius-button);
		background: var(--surface-1);
		font-size: var(--fs-desc);
		color: var(--text-2);
	}
	.pc-now .pc-k {
		width: 100%;
	}
	.pc-k {
		font-size: var(--fs-badge);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		font-weight: 600;
	}
	.pc-hint {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-desc);
	}
	.pc-link {
		border: 0;
		padding: 0;
		background: none;
		color: var(--accent-text);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	.pc-spark {
		width: 100%;
		height: 26px;
	}
	.pc-spark polyline {
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.5;
		vector-effect: non-scaling-stroke;
	}
	.pc-actions {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
		gap: 6px;
	}
	.pc-act {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		min-height: var(--control-h-sm);
		padding: 0 8px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-button);
		background: var(--surface-1);
		color: var(--text);
		font-size: var(--fs-desc);
		text-align: left;
		cursor: pointer;
	}
	.pc-act:hover:not(:disabled) {
		background: var(--surface-hover);
	}
	.pc-act:disabled {
		color: var(--text-faint);
		cursor: default;
	}
	.pc-act.on {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.pc-act.danger {
		color: var(--ink-bad);
	}
	.pc-act:focus-visible,
	.pc-back:focus-visible,
	.pc-link:focus-visible {
		outline: var(--focus-ring-width, 2px) solid var(--focus-ring, var(--accent));
		outline-offset: var(--focus-ring-offset, 1px);
	}
	@media (pointer: coarse) {
		.pc-act,
		.pc-back {
			min-height: 44px;
		}
	}
</style>

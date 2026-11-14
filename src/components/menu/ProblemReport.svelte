<script>
	import { backClose } from '$lib/backStack.js'; // phone-polish: Android Back closes it
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import Icon from '../ui/Icon.svelte';
	// uir-polish D1 (owner 2026-11-11) — "REPORT A BUG", THE ONE REPORT VIEW. "Report a problem…" (37 R20) and "Report
	// this moment" (34 R1) were two views of one act; this is it, laid out like the moment card (better on a phone),
	// top to bottom: the picture taken at the press (drag boxes on it) · "Include the last 30 s" with the live numbers ·
	// What happened (a tall note scrolls the card) · "Send as <name>; staff may reply" · Cancel / Save on this device /
	// Send. Send ALWAYS goes to the developers (owner: the "send it to developers" box went): as the signed-in account
	// through the cloud plugin when that box is ticked, else the anonymous performance report. Boxes are fractions.
	import { onDestroy } from 'svelte';
	import { autofocusOk } from '$lib/inputDevice';
	import { problemDraft, closeProblemReport, reporterAccount, normalizeMark, MAX_MARKS } from '$lib/problemReport';
	import { problemReporter } from '$lib/cloudHooks';
	import { perfReportsAvailable } from '$lib/perf/beacon';
	import { summarize } from '$lib/perf/tpprof';

	let note = $state('');
	let includePerf = $state(true);
	/** send as the signed-in account (the cloud reporter) instead of the anonymous report */
	let asUser = $state(false);
	let busy = $state(false);
	/** @type {{x: number, y: number, w: number, h: number}[]} */
	let marks = $state([]);
	/** the box being drawn, in fractions @type {{x0: number, y0: number, x: number, y: number} | null} */
	let drawing = $state(null);
	/** @type {HTMLElement | null} */
	let wrap = $state(null);
	let account = $state(/** @type {{signedIn: boolean, name?: string} | null} */ (null));
	let seen = /** @type {any} */ (null);
	/** @type {any} */
	let poll = null;

	$effect(() => {
		const draft = $problemDraft;
		if (draft && draft !== seen) {
			seen = draft;
			note = '';
			marks = [];
			drawing = null;
			includePerf = !!draft.perf;
			busy = false;
			account = reporterAccount();
			asUser = !!account?.signedIn;
			// signing in happens in the plugin's own menu: re-read while the card is open
			clearInterval(poll);
			poll = setInterval(() => (account = reporterAccount()), 1500);
		}
		if (!draft) clearInterval(poll);
	});
	onDestroy(() => clearInterval(poll));
	// a reporter installed while the card is open
	$effect(() => {
		void $problemReporter;
		if ($problemDraft) account = reporterAccount();
	});

	const canSend = $derived(!!$problemReporter && !!account?.signedIn);
	// signing in while the card is open ticks "send as" once (the account is what lets staff reply)
	let wasSignedIn = false;
	$effect(() => {
		const now = canSend;
		if (now && !wasSignedIn) asUser = true;
		wasSignedIn = now;
	});
	/** the anonymous channel: the build's performance-report endpoint, carrying the frame data */
	const canAnon = $derived($perfReportsAvailable && !!$problemDraft?.perf);
	const viaUser = $derived(asUser && canSend);
	const sendable = $derived(viaUser || (canAnon && includePerf));
	const stats = $derived($problemDraft?.perf ? summarize($problemDraft.perf) : null);
	const sendTitle = $derived(
		viaUser
			? `Send to the developers as ${account?.name ?? 'your account'}`
			: sendable
				? 'Send to the developers without your account: the frame data, the picture and your note'
				: canAnon
					? 'Sending without an account needs the frame data: tick "Include the last 30 s", or sign in'
					: 'Sending needs the theprototype.app account features: sign in from the profile menu, or save it on this device'
	);

	/** @param {PointerEvent} e */
	function frac(e) {
		const r = /** @type {HTMLElement} */ (wrap).getBoundingClientRect();
		return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
	}
	/** @param {PointerEvent} e */
	function down(e) {
		if (e.button !== 0 || !wrap || marks.length >= MAX_MARKS) return;
		if (/** @type {HTMLElement} */ (e.target).closest('button')) return;
		e.preventDefault();
		wrap.setPointerCapture?.(e.pointerId);
		const p = frac(e);
		drawing = { x0: p.x, y0: p.y, x: p.x, y: p.y };
	}
	/** @param {PointerEvent} e */
	function move(e) {
		if (!drawing) return;
		const p = frac(e);
		drawing = { ...drawing, x: p.x, y: p.y };
	}
	function up() {
		if (!drawing) return;
		const m = normalizeMark(boxOf(drawing));
		drawing = null;
		if (m) marks = [...marks, m];
	}
	/** @param {{x0: number, y0: number, x: number, y: number}} d */
	function boxOf(d) {
		return { x: Math.min(d.x0, d.x), y: Math.min(d.y0, d.y), w: Math.abs(d.x - d.x0), h: Math.abs(d.y - d.y0) };
	}
	/** @param {{x: number, y: number, w: number, h: number}} m */
	const boxStyle = (m) => `left:${m.x * 100}%;top:${m.y * 100}%;width:${m.w * 100}%;height:${m.h * 100}%`;

	/** @param {'send' | 'save' | null} how */
	async function answer(how) {
		if (busy) return;
		busy = true;
		try {
			await closeProblemReport(how ? { note, marks: [...marks], perf: includePerf, send: how === 'send' && sendable, asUser: viaUser } : null);
		} finally {
			busy = false;
		}
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			e.preventDefault();
			if (drawing) drawing = null;
			else void answer(null);
		}
	}
	// Escape must close the card wherever focus went (a disabled Send button drops focus to
	// <body> while it sends): a window CAPTURE listener while the card is open
	$effect(() => {
		if (!$problemDraft) return;
		const key = (/** @type {KeyboardEvent} */ e) => onKey(e);
		window.addEventListener('keydown', key, true);
		return () => window.removeEventListener('keydown', key, true);
	});
</script>

{#if $problemDraft}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div id="problem-report" class="problem ui-panel" use:minimalScroll use:backClose={() => (drawing ? (drawing = null) : void answer(null))} role="dialog" aria-label="Report a bug" tabindex="-1">
		<p class="title">Report a bug</p>
		{#if $problemDraft.shotUrl}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div id="problem-shot-wrap" class="shot-wrap" bind:this={wrap} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => (drawing = null)}>
				<img id="problem-shot" class="shot" src={$problemDraft.shotUrl} alt="What the viewport showed" draggable="false" />
				{#each marks as m, i (i)}
					<span class="problem-mark" style={boxStyle(m)}>
						<button class="mark-x" aria-label="Remove this box" onclick={() => (marks = marks.filter((_, j) => j !== i))}><Icon name="x" size={16} strokeWidth={3} aria-hidden="true" /></button>
					</span>
				{/each}
				{#if drawing}
					<span class="problem-mark drawing" style={boxStyle(boxOf(drawing))}></span>
				{/if}
			</div>
			<p class="muted hint">
				Drag on the picture to box what is wrong{marks.length ? ` (${marks.length})` : ''}.
				{#if marks.length}<button id="problem-clear-marks" class="link" onclick={() => (marks = [])}>Clear the boxes</button>{/if}
			</p>
		{:else}
			<p class="muted">No picture (nothing to render)</p>
		{/if}
		{#if $problemDraft.perf}
			<label class="check">
				<input id="problem-perf" type="checkbox" class="tp-check" bind:checked={includePerf} />
				<span id="problem-stats"
					>Include the last {Math.round((stats?.durationMs ?? 30000) / 1000)} s — {stats?.frames ?? 0} frames, {stats?.fpsP50 ?? '—'} fps, {stats?.stalls ?? 0}
					stall{stats?.stalls === 1 ? '' : 's'}</span
				>
			</label>
		{/if}
		<label class="field">
			<span>What happened?</span>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea id="problem-note" rows="3" maxlength="2000" bind:value={note} autofocus={autofocusOk()} placeholder="What did you expect, and what happened instead?"></textarea>
		</label>
		{#if $problemReporter}
			<label class="check" class:off={!canSend}>
				<input id="problem-as-user" type="checkbox" class="tp-check" bind:checked={asUser} disabled={!canSend} />
				<span>
					{#if canSend}Send as {account?.name ?? 'your account'}; staff may reply{:else}Send as yourself (staff may reply): <strong>Sign in from the profile menu (top right)</strong>{/if}
				</span>
			</label>
		{/if}
		{#if !$problemReporter && !canAnon}
			<p id="problem-local-only" class="muted">Sending needs the theprototype.app account features. The report is kept on this device (Profiler ▸ recordings).</p>
		{/if}
		<div class="actions">
			<button id="problem-cancel" class="btn" onclick={() => answer(null)} disabled={busy}>Cancel</button>
			<button id="problem-save" class="btn" onclick={() => answer('save')} disabled={busy}>Save on this device</button>
			{#if $problemReporter || canAnon}
				<button id="problem-send" class="btn primary" title={sendTitle} onclick={() => answer('send')} disabled={busy || !sendable}>{busy ? 'Sending…' : 'Send'}</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* the moment card's layout (D1: better on a phone): a centred column; a note made taller than the screen scrolls
	   the CARD (max-height + overflow), so the buttons are always reachable */
	.problem {
		position: fixed;
		top: calc(var(--connect-bottom, 0px) + 56px);
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-modal, 1100);
		width: min(460px, calc(100vw - 32px));
		max-height: calc(100vh - var(--connect-bottom, 0px) - 72px);
		max-height: calc(100dvh - var(--connect-bottom, 0px) - 72px);
		overflow-y: auto;
		overscroll-behavior: contain;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px;
		background: var(--surface-1);
		color: var(--text);
		font-size: var(--fs-desc);
	}
	/* phone-polish item 2: with the on-screen keyboard up, sit in what is left above it (Send and
	   Cancel stayed under it on the HONOR) — the card scrolls inside that */
	:global(:root.kb-open) .problem,
	:global(:root.phone-shell.kb-open) .problem {
		top: calc(var(--kb-top, 0px) + 8px);
		max-height: calc(100dvh - var(--kb-inset, 0px) - var(--kb-top, 0px) - 16px);
	}
	/* a phone: the card takes the width, under the top bar */
	:global(:root.phone-shell) .problem {
		top: calc(var(--connect-bottom, 0px) + 12px);
		width: calc(100vw - 16px);
		max-height: calc(100dvh - var(--connect-bottom, 0px) - var(--ps-bar-h, 0px) - 24px);
	}
	.hint {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
	}
	.title {
		font-weight: 700;
		font-size: 15px;
	}
	.shot-wrap {
		position: relative;
		line-height: 0;
		cursor: crosshair;
		touch-action: none;
		user-select: none;
		border-radius: 6px;
		overflow: hidden;
		background: var(--surface-deep);
	}
	.shot {
		width: 100%;
		max-height: 260px;
		object-fit: contain;
		pointer-events: none;
	}
	.problem-mark {
		position: absolute;
		border: 2px solid var(--ink-warn);
		border-radius: 3px;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.6); /* tokens-ok: dark halo so the box reads over any captured screenshot */
		background: color-mix(in srgb, var(--ink-warn) 8%, transparent);
	}
	.problem-mark.drawing {
		border-style: dashed;
	}
	.mark-x {
		position: absolute;
		top: -10px;
		right: -10px;
		width: 20px;
		height: 20px;
		border-radius: 10px;
		display: grid;
		place-items: center;
		background: var(--ink-warn);
		color: var(--bg-app);
		cursor: pointer;
	}
	.link {
		align-self: flex-start;
		font-size: 12px;
		color: var(--accent);
		text-decoration: underline;
		background: none;
	}
	.muted {
		color: var(--text-muted);
		font-size: 12px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.field textarea {
		width: 100%;
		min-height: 4.5em;
		resize: vertical;
		border-radius: 6px;
		background: var(--surface-inset);
		color: inherit;
		border: 1px solid var(--border);
		padding: 6px;
	}
	.check {
		display: flex;
		gap: 8px;
		align-items: flex-start;
	}
	.check.off {
		opacity: 0.75;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		flex-wrap: wrap;
	}
	.btn {
		padding: 5px 12px;
		border-radius: 6px;
		background: var(--surface-hover);
		color: var(--text);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn.primary {
		background: var(--accent-fill, var(--accent));
		color: var(--on-accent);
	}
</style>

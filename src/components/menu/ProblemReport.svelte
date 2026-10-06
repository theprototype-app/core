<script>
	// 37 R20 — "Report a problem" (desktop and the Quest browser). The picture was taken when
	// the menu row was pressed (problemReport.js captureProblem). Here the person drags boxes
	// over what is wrong, says what happened, and chooses: Send (only with the consent box
	// ticked, and only when the cloud plugin is there and they are signed in) or keep it on
	// this device. Boxes are stored as fractions of the picture.
	import { onDestroy } from 'svelte';
	import { problemDraft, closeProblemReport, reporterAccount, normalizeMark, MAX_MARKS } from '$lib/problemReport';
	import { problemReporter } from '$lib/cloudHooks';

	let note = $state('');
	let includePerf = $state(true);
	let consent = $state(false);
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
			consent = false;
			busy = false;
			account = reporterAccount();
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
			await closeProblemReport(how ? { note, marks: [...marks], perf: includePerf, send: how === 'send' && consent && canSend } : null);
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
	<div id="problem-report" class="problem ui-panel" role="dialog" aria-label="Report a problem" tabindex="-1">
		<p class="title">Report a problem</p>
		{#if $problemDraft.shotUrl}
			<p class="muted">Drag on the picture to box what is wrong{marks.length ? ` (${marks.length})` : ''}.</p>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div id="problem-shot-wrap" class="shot-wrap" bind:this={wrap} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => (drawing = null)}>
				<img id="problem-shot" class="shot" src={$problemDraft.shotUrl} alt="What the viewport showed" draggable="false" />
				{#each marks as m, i (i)}
					<span class="problem-mark" style={boxStyle(m)}>
						<button class="mark-x" aria-label="Remove this box" onclick={() => (marks = marks.filter((_, j) => j !== i))}>×</button>
					</span>
				{/each}
				{#if drawing}
					<span class="problem-mark drawing" style={boxStyle(boxOf(drawing))}></span>
				{/if}
			</div>
			{#if marks.length}
				<button id="problem-clear-marks" class="link" onclick={() => (marks = [])}>Clear the boxes</button>
			{/if}
		{:else}
			<p class="muted">No picture (nothing to render)</p>
		{/if}
		<label class="field">
			<span>What happened?</span>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea id="problem-note" rows="3" maxlength="2000" bind:value={note} autofocus placeholder="What did you expect, and what happened instead?"></textarea>
		</label>
		{#if $problemDraft.perf}
			<label class="check">
				<input id="problem-perf" type="checkbox" class="tp-check" bind:checked={includePerf} />
				<span>Include the last 30 s of frame data</span>
			</label>
		{/if}
		{#if $problemReporter}
			<label class="check" class:off={!canSend}>
				<input id="problem-consent" type="checkbox" class="tp-check" bind:checked={consent} disabled={!canSend} />
				<span>
					Send this to the theprototype team: the picture, your note and boxes, the app version and your device{includePerf && $problemDraft.perf ? ', and the frame data' : ''}.
					{#if canSend}Sent as {account?.name ?? 'your account'}; staff may reply.{:else}<strong>Sign in from the profile menu (top right) to send.</strong>{/if}
				</span>
			</label>
		{:else}
			<p id="problem-local-only" class="muted">Sending needs the theprototype.app account features. The report is kept on this device (Profiler ▸ recordings).</p>
		{/if}
		<div class="actions">
			<button id="problem-cancel" class="btn" onclick={() => answer(null)} disabled={busy}>Cancel</button>
			<button id="problem-save" class="btn" onclick={() => answer('save')} disabled={busy}>Save on this device</button>
			{#if $problemReporter}
				<button id="problem-send" class="btn primary" onclick={() => answer('send')} disabled={busy || !consent || !canSend}>{busy ? 'Sending…' : 'Send'}</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.problem {
		position: fixed;
		top: calc(var(--connect-bottom, 0px) + 56px);
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-modal, 1100);
		width: min(560px, calc(100vw - 32px));
		max-height: calc(100vh - var(--connect-bottom, 0px) - 72px);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px;
		background: var(--surface, #1f2937);
		color: var(--text, #e5e7eb);
		font-size: 13px;
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
		background: var(--surface-deep, #000);
	}
	.shot {
		width: 100%;
		max-height: 300px;
		object-fit: contain;
		pointer-events: none;
	}
	.problem-mark {
		position: absolute;
		border: 2px solid var(--ink-warn, #fbbf24);
		border-radius: 3px;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 0.6);
		background: rgb(251 191 36 / 0.08);
	}
	.problem-mark.drawing {
		border-style: dashed;
	}
	.mark-x {
		position: absolute;
		top: -9px;
		right: -9px;
		width: 18px;
		height: 18px;
		border-radius: 9px;
		background: var(--ink-warn, #fbbf24);
		color: #111;
		font: 700 12px/18px system-ui, sans-serif;
		cursor: pointer;
	}
	.link {
		align-self: flex-start;
		font-size: 12px;
		color: var(--accent-text, #93c5fd);
		text-decoration: underline;
		background: none;
	}
	.muted {
		color: var(--muted, #9ca3af);
		font-size: 12px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.field textarea {
		width: 100%;
		resize: vertical;
		border-radius: 6px;
		background: var(--field, rgba(0, 0, 0, 0.3));
		color: inherit;
		border: 1px solid var(--border, #4b5563);
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
		background: var(--surface-3, #374151);
		color: var(--text, #e5e7eb);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn.primary {
		background: var(--accent-fill, var(--accent, #2563eb));
		color: var(--on-accent, #fff);
	}
</style>

<script>
	// 71 AS4 — THE COLLAPSED ROW for invite dials whose proof did not check out. They used to be
	// approval cards, and the card queue is capped at 12 with the oldest dropped first, so a flood
	// of junk invite dials pushed a real joiner's card out of sight. Now they are ONE row that
	// counts them, says when invite joins are paused, and keeps the last few for Review: someone
	// holding an expired or used-up link is still let in from here, as the card used to allow.
	// Lazy (Toasts and the Connect drawer load it only while the row has something to say).
	import Icon from '../ui/Icon.svelte';
	import { failedInviteJoins, dismissFailedInviteJoins, resumeInviteJoins, forgetFailedInviteJoin } from '$lib/inviteStore';
	import { failedRowText } from '$lib/inviteLimits';
	import { approvePeer } from '$lib/peerApproval';
	import { APPROVAL_WINDOW_MS } from '$lib/connectionState';

	/** @type {{ inDrawer?: boolean }} */
	let { inDrawer = false } = $props();

	let open = $state(false);
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});

	const sum = $derived($failedInviteJoins);
	const pauseLeft = $derived(Math.max(0, Math.ceil((sum.pausedUntil - now) / 1000)));
	// a joiner gives up after the approval window: older rows can no longer be let in
	const rows = $derived(sum.rows.filter((r) => now - r.at <= APPROVAL_WINDOW_MS).slice().reverse());

	/** @param {string} reason */
	const why = (reason) =>
		reason === 'expired' ? 'expired link'
		: reason === 'revoked' ? 'revoked link'
		: reason === 'used' ? 'link already used'
		: 'link this device cannot confirm';

	/** @param {string} peerId */
	function letIn(peerId) {
		forgetFailedInviteJoin(peerId);
		approvePeer(peerId);
	}
</script>

{#if sum.count > 0 || pauseLeft > 0}
	<div id={inDrawer ? 'failed-invite-joins-drawer' : 'failed-invite-joins'} class={inDrawer ? 'fij-drawer' : 'my-1 fij'} data-count={sum.count} data-paused={pauseLeft > 0 ? 'yes' : 'no'} role="status">
		<div class="tp-toast-body">
			{#if !inDrawer}<Icon name="triangle-alert" size={16} class="tp-toast-icon" aria-hidden="true" />{/if}
			<div class="tp-toast-main">
				<div class="tp-toast-text fij-count">{failedRowText(sum.count)}</div>
				<div class="cxreq-label">Invite links that did not check out. They never take a request slot.</div>
				{#if pauseLeft > 0}<div class="cxreq-age expired fij-paused">Invite joins paused for {pauseLeft} s. Approval cards still work.</div>{/if}
				<div class="tp-toast-actions">
					{#if rows.length}
						<button class="cxreq-btn fij-review" aria-expanded={open} onclick={() => (open = !open)}>{open ? 'Hide' : 'Review'}</button>
					{/if}
					{#if pauseLeft > 0}<button class="cxreq-btn fij-resume" onclick={resumeInviteJoins}>Resume now</button>{/if}
					<button class="cxreq-btn cxreq-reject fij-dismiss" onclick={() => { open = false; dismissFailedInviteJoins(); }}>Dismiss</button>
				</div>
				{#if open && rows.length}
					<ul class="fij-list">
						{#each rows as r (r.peerId)}
							<li class="fij-row" data-peer={r.peerId}>
								<span class="cxreq-id">{r.kind === 'agent' ? 'AI agent ' : ''}{r.peerId.slice(0, 6).toUpperCase()}</span>
								<span class="fij-why">{why(r.reason)}</span>
								<button class="cxreq-btn fij-letin" onclick={() => letIn(r.peerId)} title="Let them in as an approval would">Let in</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	/* the approval card's look (Toasts.svelte), restated: svelte scopes those rules to their own file */
	.fij {
		pointer-events: auto;
		position: relative;
		width: min(400px, 94vw);
		margin: 0 auto;
		box-sizing: border-box;
		background: var(--surface-1);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-card);
		padding: 10px 12px;
		box-shadow: var(--shadow-window);
		color: var(--text-2);
		font-family: var(--font-ui);
	}
	.fij-drawer {
		list-style: none;
	}
	.tp-toast-body {
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}
	.tp-toast-body :global(.tp-toast-icon) {
		color: var(--ink-warn);
		margin-top: 1px;
		flex: 0 0 auto;
	}
	.tp-toast-main {
		min-width: 0;
		flex: 1 1 auto;
	}
	.tp-toast-text {
		font-size: var(--fs-desc);
		color: var(--text-2);
		line-height: 1.45;
	}
	.cxreq-label {
		margin-top: 2px;
		font-size: 12px;
		overflow-wrap: anywhere;
	}
	.cxreq-age {
		margin-top: 2px;
		font-size: 11px;
		color: var(--warn-text);
	}
	.cxreq-id {
		font-size: var(--fs-badge);
		color: var(--text-muted);
		font-family: var(--font-ui-mono);
	}
	.tp-toast-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}
	.cxreq-btn {
		height: var(--control-h-sm);
		padding: 0 var(--space-3);
		border-radius: var(--radius-button);
		border: 1px solid var(--border-strong);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: var(--fs-desc);
		font-weight: 500;
		cursor: pointer;
		white-space: nowrap;
	}
	.cxreq-btn:hover {
		background: var(--surface-hover);
	}
	.cxreq-reject {
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
		color: var(--ink-bad, var(--danger));
	}
	@media (pointer: coarse) {
		.cxreq-btn {
			height: 44px;
		}
	}
	.fij-list {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.fij-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: var(--fs-badge);
	}
	.fij-why {
		flex: 1;
		color: var(--text-muted);
	}
</style>

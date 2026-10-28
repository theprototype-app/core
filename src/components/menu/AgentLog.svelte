<script>
	// 55 A8 — THE AGENT ACTION LOG in the AI assistant window, on every peer. One line per agent
	// tool call, grouped per agent; a click selects what the line touched (the ones still in the
	// scene); Undo (editors only) asks the agent — whose page holds the history entry — to undo
	// that one call. The lines come from agentLog.js (the agent's own summaries + the late
	// joiner's handshake share); the edits themselves came over the ordinary replicated ops.
	import { get } from 'svelte/store';
	import Icon from '../ui/Icon.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { agentLog, requestAgentUndo } from '$lib/agentLog';
	import { groupEntries } from '$lib/agentLogCore';
	import { peers, showToast } from '../../stores/appStore';
	import { objectsGroup } from '../../stores/sceneStore';
	import { applySelectionSet } from '$lib/objectActions';
	import { isViewer } from '$lib/objectPermissions';
	import { rolesInfo } from '$lib/cloudHooks';

	let open = $state(true);
	const groups = $derived(groupEntries($agentLog));
	// re-read on a roles change (the unused argument is the dependency): a viewer sees the
	// lines, never an Undo
	const editorNow = (/** @type {any} */ _roles) => !isViewer();
	const canUndo = $derived(editorNow($rolesInfo));
	const online = $derived(new Set(/** @type {any} */ ($peers)?.openedPeers ?? []));

	/** @param {any} e */
	function select(e) {
		/** @type {any} */
		const group = get(objectsGroup);
		const here = (e.uuids ?? []).filter((/** @type {string} */ u) => !!group?.getObjectByProperty?.('uuid', u));
		if (!here.length) {
			showToast(e.uuids?.length ? 'Those objects are no longer in the scene.' : 'Nothing to select for this step.');
			return;
		}
		applySelectionSet(here);
	}

	/** @param {any} e */
	function undo(e) {
		if (!requestAgentUndo(e)) showToast('The AI agent has left — nobody holds that step any more.');
	}

	/** @param {number} at */
	const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

{#if $agentLog.length}
	<section id="agent-log" class="alog" data-count={$agentLog.length}>
		<button type="button" class="alog-head" aria-expanded={open} onclick={() => (open = !open)}>
			<Icon name="bot" size={16} aria-hidden="true" />
			<span class="alog-title">Agent activity</span>
			<span class="alog-count">{$agentLog.length}</span>
			<Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} aria-hidden="true" />
		</button>
		{#if open}
			<div class="alog-body" use:minimalScroll>
				{#each groups as g, gi (g.peer + ':' + gi)}
					<div class="alog-group" data-peer={g.peer}>
						<div class="alog-who">{g.name || 'AI agent'} <span class="alog-id">{g.peer.slice(0, 5).toUpperCase()}</span></div>
						<ul class="alog-lines">
							{#each g.entries as e (e.id)}
								<li class="alog-line" class:undone={e.undone} class:failed={!e.ok} data-entry={e.id}>
									<button type="button" class="alog-text" title={e.uuids?.length ? 'Select what this step touched' : e.text} onclick={() => select(e)}>
										<span class="alog-time">{clock(e.at)}</span>
										<span class="alog-words">{e.text}</span>
									</button>
									{#if e.undone}
										<span class="alog-state">undone</span>
									{:else if canUndo && e.undoable}
										<button
											type="button"
											class="alog-undo"
											disabled={!online.has(e.peer)}
											title={online.has(e.peer) ? 'Undo this step (the agent undoes it for everyone)' : 'The agent has left — this step can no longer be undone from here'}
											onclick={() => undo(e)}>Undo</button
										>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/each}
			</div>
		{/if}
	</section>
{/if}

<style>
	.alog {
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}
	.alog-head {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 10px;
		color: var(--text-2);
		font-size: var(--fs-desc);
	}
	.alog-title {
		flex: 1;
		text-align: left;
		font-weight: 600;
	}
	.alog-count {
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	.alog-body {
		max-height: 160px;
		overflow-y: auto;
		padding: 0 6px 6px;
	}
	.alog-who {
		font-size: var(--fs-badge);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-faint);
		padding: 4px 4px 2px;
	}
	.alog-id {
		font-family: var(--font-ui-mono);
	}
	.alog-lines {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.alog-line {
		display: flex;
		align-items: center;
		gap: 6px;
		border-radius: 6px;
	}
	.alog-line:hover {
		background: var(--surface-hover);
	}
	.alog-text {
		flex: 1;
		min-width: 0;
		display: flex;
		gap: 6px;
		padding: 3px 4px;
		text-align: left;
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.alog-words {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.alog-time {
		flex-shrink: 0;
		color: var(--text-faint);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		line-height: 1.6;
	}
	.alog-line.undone .alog-words {
		text-decoration: line-through;
		color: var(--text-muted);
	}
	.alog-line.failed .alog-words {
		color: var(--warn-text);
	}
	.alog-undo,
	.alog-state {
		flex-shrink: 0;
		padding: 1px 6px;
		font-size: var(--fs-badge);
		color: var(--accent-text);
		border-radius: 6px;
	}
	.alog-undo:disabled {
		color: var(--text-faint);
	}
	.alog-state {
		color: var(--text-faint);
	}
</style>

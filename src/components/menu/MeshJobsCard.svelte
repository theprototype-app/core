<script lang="ts">
	// Mesh-generation progress cards (roadmap #11, G2). Renders the meshJobs store as
	// a small stack near the top-right — one card per active/finished job with a
	// progress bar, cancel (while running) and dismiss (when finished).
	import { meshJobs, cancelMeshJob, dismissMeshJob } from '$lib/ai/meshJobs';

	const RUNNING = new Set(['submitting', 'running', 'importing']);
	function label(status: string) {
		if (status === 'submitting') return 'Submitting…';
		if (status === 'running') return 'Generating…';
		if (status === 'importing') return 'Importing…';
		if (status === 'done') return 'Done';
		if (status === 'error') return 'Failed';
		if (status === 'cancelled') return 'Cancelled';
		return status;
	}
</script>

{#if $meshJobs.length}
	<div class="mesh-jobs">
		{#each $meshJobs as job (job.id)}
			<div class="ui-panel mesh-job bg-gray-900/90 backdrop-blur-sm">
				<div class="flex items-center gap-2">
					<span class="text-sm">✨</span>
					<span class="min-w-0 flex-1 truncate text-xs text-gray-200" title={job.prompt}>{job.prompt}</span>
					{#if RUNNING.has(job.status)}
						<button class="ui-button-quiet text-[11px]" onclick={() => cancelMeshJob(job.id)}>Cancel</button>
					{:else}
						<button class="ui-button-quiet text-[11px]" onclick={() => dismissMeshJob(job.id)}>✕</button>
					{/if}
				</div>
				<div class="mt-1 flex items-center gap-2">
					<span
						class="text-[11px] {job.status === 'error' ? 'text-red-300' : job.status === 'done' ? 'text-emerald-300' : 'text-gray-400'}"
						>{label(job.status)}</span
					>
					{#if job.status === 'error' && job.error}
						<span class="min-w-0 flex-1 truncate text-[11px] text-red-300/80" title={job.error}>{job.error}</span>
					{/if}
				</div>
				{#if RUNNING.has(job.status)}
					<div class="mt-1 h-1 w-full overflow-hidden rounded-sm bg-gray-700">
						{#if job.progress != null}
							<div class="h-full bg-primary-500" style={`width:${Math.round(job.progress * 100)}%`}></div>
						{:else}
							<div class="mesh-indeterminate h-full bg-primary-500"></div>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.mesh-jobs {
		position: fixed;
		top: 64px;
		right: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		z-index: var(--z-toast);
		max-width: min(320px, 90vw);
		pointer-events: none;
	}
	.mesh-job {
		padding: 8px 10px;
		pointer-events: auto;
	}
	.mesh-indeterminate {
		width: 35%;
		animation: mesh-slide 1.2s ease-in-out infinite;
	}
	@keyframes mesh-slide {
		0% {
			margin-left: 0;
		}
		50% {
			margin-left: 65%;
		}
		100% {
			margin-left: 0;
		}
	}
</style>

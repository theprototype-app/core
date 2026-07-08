<script lang="ts">
	import { remoteStreams, mutedPeers, micActive, pttActive, toggleMic } from '$lib/voiceChat';

	// hidden audio sinks for remote voices + the mic toggle button.
	// muted is set as a property in the action — the Svelte attribute binding
	// on media elements only applies at load time.
	function attach(node: HTMLAudioElement, params: { stream: MediaStream; muted: boolean }) {
		node.srcObject = params.stream;
		node.muted = params.muted;
		return {
			update(next: { stream: MediaStream; muted: boolean }) {
				if (node.srcObject !== next.stream) node.srcObject = next.stream;
				node.muted = next.muted;
			}
		};
	}
</script>

{#each Object.entries($remoteStreams) as [peerId, stream] (peerId)}
	<audio autoplay use:attach={{ stream, muted: $mutedPeers.includes(peerId) }}></audio>
{/each}

<button
	class="fixed bottom-16 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full shadow-lg transition-colors
		{$micActive || $pttActive ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-700 hover:bg-gray-600'}"
	title={$micActive ? 'Microphone on — click to mute' : 'Microphone off — click to talk, or hold V for push-to-talk'}
	on:click={toggleMic}
>
	<i class="fas {$micActive || $pttActive ? 'fa-microphone' : 'fa-microphone-slash'} text-white"></i>
</button>

<script lang="ts">
	import { remoteStreams, mutedPeers, micActive, pttActive, toggleMic, spatialVoice } from '$lib/voiceChat';

	// hidden audio sinks for remote voices + the mic toggle button.
	// muted/volume are set as properties in the action — the Svelte attribute
	// binding on media elements only applies at load time. In spatial mode the
	// element stays attached at volume 0 (Chrome only pumps WebRTC audio into
	// WebAudio while a media element consumes the stream).
	function attach(node: HTMLAudioElement, params: { stream: MediaStream; muted: boolean; spatial: boolean }) {
		const apply = (p: { stream: MediaStream; muted: boolean; spatial: boolean }) => {
			if (node.srcObject !== p.stream) node.srcObject = p.stream;
			node.muted = p.muted;
			node.volume = p.spatial ? 0 : 1;
		};
		apply(params);
		return { update: apply };
	}
</script>

{#each Object.entries($remoteStreams) as [peerId, stream] (peerId)}
	<audio autoplay use:attach={{ stream, muted: $mutedPeers.includes(peerId), spatial: $spatialVoice }}></audio>
{/each}

<button
	class="fixed bottom-16 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full shadow-lg transition-colors
		{$micActive || $pttActive ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-700 hover:bg-gray-600'}"
	title={$micActive ? 'Microphone on — click to mute' : 'Microphone off — click to talk, or hold V for push-to-talk'}
	on:click={toggleMic}
>
	<i class="fas {$micActive || $pttActive ? 'fa-microphone' : 'fa-microphone-slash'} text-white"></i>
</button>

<script lang="ts">
	import Chat from './menu/Chat.svelte';
	import Toasts from './menu/Toasts.svelte';
	import Connect from './menu/Connect.svelte';
	import Controls from './menu/Controls.svelte';
	import Properties from './menu/Properties.svelte';
	import PropertiesScene from './menu/PropertiesScene.svelte';
	import PropertiesLight from './menu/PropertiesLight.svelte';
	import MenuSidebar from './menu/Sidebar.svelte';
	import MenuSettings from './menu/Settings.svelte';
	import CharacterModal from './menu/CharacterModal.svelte';
	import ViewportMenu from './menu/ViewportMenu.svelte';
	import VoiceChat from './menu/VoiceChat.svelte';
	import Library from './menu/Library.svelte';
	import { DarkMode } from 'flowbite-svelte';
	import Users from './menu/Users.svelte';
	import News from './menu/News.svelte';

	import { isLocked } from '../stores/sceneStore'
</script>

<Chat />

<div class={$isLocked ? 'hidden' : ''}>
<News />
<Connect />
<Controls />
<Properties />
<MenuSidebar />
<PropertiesScene />
<PropertiesLight />
<MenuSettings />
<CharacterModal />
<ViewportMenu />
<VoiceChat />
<Library />
<Toasts />
<Users />
</div>

<div class="dark-mode hidden"><DarkMode /></div>

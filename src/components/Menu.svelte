<script lang="ts">
	import Chat from './menu/Chat.svelte';
	import AiAssistant from './menu/AiAssistant.svelte';
	import MeshGenModal from './menu/MeshGenModal.svelte';
	import MeshJobsCard from './menu/MeshJobsCard.svelte';
	import Toasts from './menu/Toasts.svelte';
	import SessionPrompts from './menu/SessionPrompts.svelte';
	import FramingGuide from './menu/FramingGuide.svelte';
	import CameraPipWindow from './menu/CameraPipWindow.svelte';
	import Connect from './menu/Connect.svelte';
	import Controls from './menu/Controls.svelte';
	import BudgetChip from './menu/BudgetChip.svelte'; // 46 B1
	import Inspector from './menu/Inspector.svelte';
	import SidebarStrips from './menu/SidebarStrips.svelte'; // 42 I2/I3
	import MenuSidebar from './menu/Sidebar.svelte';
	import TouchTools from './menu/TouchTools.svelte';
	import MenuSettings from './menu/Settings.svelte';
	import SessionsManager from './menu/SessionsManager.svelte';
	import CheckpointTimeline from './menu/checkpoints/CheckpointTimeline.svelte'; // 36 B14
	import TemplatesModal from './menu/TemplatesModal.svelte';
	import CharacterPanel from './menu/CharacterPanel.svelte'; // 36-avatars: the customise side panel
	import ViewportMenu from './menu/ViewportMenu.svelte';
	import MeshEditPopup from './menu/MeshEditPopup.svelte';
	import MarqueeOverlay from './menu/MarqueeOverlay.svelte';
	import AddMenu from './menu/AddMenu.svelte';
	import ObjectSearch from './menu/ObjectSearch.svelte';
	import TabStrips from './menu/TabStrips.svelte';
	import WindowMenu from './menu/WindowMenu.svelte';
	import VoiceChat from './menu/VoiceChat.svelte';
	import AnnotationPopover from './menu/AnnotationPopover.svelte';
	import AnnotationMarkers from './menu/AnnotationMarkers.svelte';
	import MeasureLabels from './menu/MeasureLabels.svelte'; // 47 M1
	import KnifeOverlay from './menu/KnifeOverlay.svelte';
	import NotesDrawer from './menu/NotesDrawer.svelte';
	import LayoutsMenu from './menu/LayoutsMenu.svelte'; // 37 R14
	// 21-H2: Library.svelte is GONE. It was a SECOND home for prefabs, and it was
	// unreachable — `libraryClose` is writable(true) and nothing in the app ever set it
	// false, so no menu entry, button or store write could open it. The Explorer owns
	// prefabs now, carrying the CRUD that drawer had.
	import Users from './menu/Users.svelte';
	// RW: replaced the gutted News.svelte stub (empty body, inverted hasSeenModal flag)
	import Welcome from './menu/Welcome.svelte';
	import WhatsNew from './menu/WhatsNew.svelte';
	// 36 U3b/I5: the first-run tours' screen card (and the tours' install)
	import TourCard from './tours/TourCard.svelte';
	import FunnelConsentCard from './tours/FunnelConsentCard.svelte';

	import { isLocked } from '../stores/sceneStore'
	// 29-E: `?embed=1` (playMode.embedMode) hides the editor chrome for the page's life
	import { embedMode } from '../lib/playMode'
	// 38 R9: below 640px the decluttered phone shell (top bar, context strip, bottom bar,
	// sheets) is drawn over the same components — see PhoneShell.svelte
	import PhoneShell from './phone/PhoneShell.svelte'
	import PhoneDockHost from './phone/PhoneDockHost.svelte'
	import FocusModeExit from './menu/FocusModeExit.svelte'
	import ViewportPip from './menu/ViewportPip.svelte' // 43 K5
	import { phoneShell } from '$lib/ui/phoneShell.js'
	import { panelAway } from '$lib/windows/panelPlaces.js'
</script>

<Chat />
<AiAssistant />
<!-- 42 I14: focus mode's exit pill + wiring (outside #editor-chrome, which focus mode hides) -->
<FocusModeExit />
<!-- 43 K5: the 3D view as a picture-in-picture while a docked window fills the whole window -->
<ViewportPip />
<MeshGenModal />
<MeshJobsCard />

<!-- the editor chrome: hidden while playing, and for good in an embed (29-E) -->
<div id="editor-chrome" class={$isLocked || $embedMode ? 'hidden' : ''}>
<Welcome />
<WhatsNew />
<TourCard />
<FunnelConsentCard />
<!-- 53 A3: DOCUMENT ORDER IS TAB ORDER — the top bar reads left to right (logo menu, touch tools,
     Connect, the top-right group + profile) before the toolbar and the panels; every one of these
     is position:fixed on an explicit z tier, so the order moves no pixel -->
<MenuSidebar />
<TouchTools />
<Connect />
<Users />
<Controls />
<!-- 46 B1: the budget chip, placed beside the toolbar pill (hidden in Play with the rest of the chrome) -->
<BudgetChip />
<!-- 70 W2: in a pop-out window the Inspector is unmounted here (one panel, one place) -->
{#if !$panelAway.inspector}<Inspector />{/if}
<SidebarStrips />
<MenuSettings />
<SessionsManager />
<CheckpointTimeline />
<TemplatesModal />
<CharacterPanel />
<ViewportMenu />
<MeshEditPopup />
<MarqueeOverlay />
<AddMenu />
<ObjectSearch />
<TabStrips />
<WindowMenu />
<VoiceChat />
<!-- screen-space note markers (badge + leader line); VR uses the in-scene pins -->
<AnnotationMarkers />
<!-- 47 M1: measure dimension labels (screen-space, local) -->
<MeasureLabels />
<KnifeOverlay />
<AnnotationPopover />
<NotesDrawer />
<LayoutsMenu />
<!-- 41b H1: on a phone the content panels are dock tabs; the frame they sit in (+ the posture memory) -->
<PhoneDockHost />
<Toasts />
<SessionPrompts />
<!-- 16-P5: letterbox bars while previewing a camera at a fixed aspect -->
<FramingGuide />
<!-- 16-Q4: live preview window for the selected camera (chrome only — the image
     is an inset viewport drawn by the render loop) -->
<CameraPipWindow />
</div>
{#if $phoneShell && !$isLocked && !$embedMode}
	<PhoneShell />
{/if}


<script lang="ts">
	import Icon from '../ui/Icon.svelte';
    import { cameraPreview, stopCameraPreview, toggleCameraControl, previewLabel } from '$lib/cameraPreview'
    // R22 round 2: the connect-time library offer (see the effect below)
    import { pullAllShared, bulkCounts, pendingShareAsk } from '$lib/sharedLibrary'
    // R22 round 7: the offer is for a peer who JOINED somebody — the host's library
    // already is the session's, so there is nothing of anybody else's to adopt
    import { sessionHost } from '$lib/connectionState'
    import { autoDownload } from '$lib/sharedLibrary'
    import { explorerItems } from '$lib/explorer'
    import { projectManifest } from '$lib/projectManifest'
    // R22 round 9: the offer has to know whether the OPEN SCENE is worth saving before it
    // talks about files. `recomputeSceneDirty` is the SYNCHRONOUS verdict — `$sceneDirty`
    // is throttled by design (recomputing costs a whole-scene serialization), which is
    // right for a title bar and wrong for a prompt that is deciding what to say.
    import { sceneDirty, recomputeSceneDirty } from '$lib/sceneIdentity'
    // open the Explorer BEFORE arming: the save card is drawn by the Explorer's own effect,
    // so arming a panel that is not mounted arms nothing
    import { armExplorerSceneSave, explorerClose } from '../../stores/appStore'
    import { peers, loading, loadingcount, pendingApprovals, waitingForApproval, userdata, toastStore, fixLight, showSidebar, specatorMode, restorePanels, appNotice, connectDrawerOpen, connectDrawerTab, toastsInDrawerOnly, showInfoToast, dismissToastById } from '../../stores/appStore'
    // P2: the watch banner says when the watched peer's look CANNOT be adopted (the
    // P1 rule: a scoped feature must say on its own surface when it takes no effect)
    import { peerLooks, watchLookNote } from '$lib/lookPresence'
    import { cancelOutboundRequest, denyPeer } from '$lib/peerApproval'
    // 27-B: the ONE sticky card for an uncaught error. This file already mirrors
    // state stores into sticky toasts (restoreAvailable below); diagnostics.js stays a
    // leaf by publishing a store instead of importing the toast pipeline itself.
    import { lastUncaught, copyDiagnostics } from '$lib/diagnostics'
    // 27-E: the card ages against the SAME clock the joiner's pill counts down from, and
    // the caps decide whether approving is even offered.
    import { approvalStartedAt, APPROVAL_WINDOW_MS, softPeerCap, HARD_PEER_CAP, sessionSize, roomIsFull } from '$lib/connectionState'
    import { rolesInfo } from '$lib/cloudHooks'
    import { sceneCommand } from '$lib/commandsHandler.svelte';
	import { objectsGroup, camSave, globalCamera, globalScene } from '../../stores/sceneStore.js';
	// the "no light" card's ✕ hides this appearance; the next time the scene loses its
	// light the card shows again (what flowbite's self-dismissing Toast did on remount)
	let fixLightClosed = $state(false);
	// "Receiving objects" progress (was flowbite's Progressbar)
	const loadPct = $derived($loadingcount ? (100 * ($loadingcount - $loading.length)) / $loadingcount : 0);
	$effect(() => {
		if (!$fixLight) fixLightClosed = false;
	});
	import SceneLoadBar from './SceneLoadBar.svelte';
	import StartViewHint from './StartViewHint.svelte';
    import { fly } from 'svelte/transition';
    import { untrack } from 'svelte';
    // P2b: watching follows a peer's camera IN THIS WORLD, so it cannot survive them
    // opening another scene. Users.svelte gates STARTING one; this is the other half.
    import { peerScenes, elsewhereThan, PRIVATE_SCENE } from '$lib/peerScenes';
    import { currentLevel } from '$lib/levels';
    import { showToast } from '../../stores/appStore';
    import { safeStorage } from '$lib/safeStorage';

    /**
     * Stop watching and give the camera back. EXTRACTED from the banner button so the
     * automatic stop below cannot drift from the manual one — there is one teardown.
     * The avatar lookup is GUARDED now: by the time this runs the peer may have
     * travelled or left, and the inline version dereferenced it unconditionally.
     */
    // `watchLookNote` reads the map with get(); `$peerLooks` is the dependency (the
    // get()-registers-nothing rule) — passed as the unused argument the codebase uses
    // for exactly this so svelte-check does not flag a comma expression
    const lookNote = $derived(typeof $specatorMode === 'string' ? noteFor($specatorMode, $peerLooks) : '');
    function noteFor(peerId: string, _dep: unknown) { return watchLookNote(peerId); }

    function exitSpectate() {
        if (!$specatorMode) return;
        const dolly = $globalScene?.getObjectByName('dolly');
        if (dolly) dolly.attach($globalCamera);
        const avatar = $globalScene?.getObjectByName($specatorMode);
        if (avatar) avatar.visible = true;
        $specatorMode = false;
        // the saved pose is written by `specate`, so the BUTTON always has one. The
        // automatic stop below can fire in states the button cannot reach (a watch that
        // began before a reload, a store poked from outside), and restoring a camera we
        // never saved must be skipped rather than throw inside an $effect.
        if ($camSave) {
            $globalCamera.position.copy($camSave.position)
            $globalCamera.rotation.copy($camSave.rotation)
            $globalCamera.fov = $camSave.fov
            $globalCamera.updateProjectionMatrix()
        }
        //specating has ended send camera position once to appear for peers
        $peers.send({ type: 'camera', peerId: $peers.peer.id, position: $globalCamera.position.toArray(), rotation: $globalCamera.rotation.toArray() });
        $peers.send({ type: 'specator', peerId: $peers.peer.id, watching: 'false' });
        // bring back the panels hidden when spectating started
        restorePanels();
    }

    // …and stop by itself when the peer we are watching opens another scene. ONLY ON
    // EVIDENCE, the same rule the button uses: an absent row means "we have not been
    // told", and no name on our side means there is nothing to compare against.
    //
    // R22 ROUND 36 (rooms): the test is `elsewhereThan` itself now, with the HOST passed,
    // rather than a hand-written "both named and different". It was the same only-on-
    // evidence rule spelled out a third time, and it inherited the same hole: a peer
    // walking out of the session's world into a scene of their own left us watching a
    // camera in a world we do not have. The one unknown that still allows is an ABSENT
    // row — an older build — which the predicate keeps.
    $effect(() => {
        const map = $peerScenes;
        // `specatorMode` is declared writable(false) but holds a peer-id STRING when it
        // holds anything — coerce rather than index a boolean
        const watching = typeof $specatorMode === 'string' ? $specatorMode : '';
        const ours = $currentLevel?.name ?? '';
        if (!watching) return;
        // R22 round 36 (review): WE went private while watching. The pure predicate cannot
        // see our own privacy (a private HOST even resolves an unnamed peer INTO our private
        // scene), so the caller states it: there is no world of theirs we stand in any more.
        const away = $currentLevel?.private ? PRIVATE_SCENE : elsewhereThan(map, ours, watching, $sessionHost);
        if (!away) return;
        // the sentinels are places, not names: a private peer and the session's own world
        // both read as somewhere we cannot follow, and neither has a scene to name.
        const theirs = map?.[watching]?.scene ?? '';
        untrack(() => {
            exitSpectate();
            showToast(theirs ? 'Stopped watching — they opened "' + theirs + '"' : 'Stopped watching — they left this scene');
        });
    });


// CN toast routing. The viewport containers are HIDDEN (display:none, not removed —
// so each toast's expiry timer keeps running) and the live toasts instead render in
// the drawer's Toasts tab:
//  - approval requests hide from the viewport when the drawer body is OPEN (they show
//    in the Toasts tab; a "new request" cue appears in the drawer header). When the
//    drawer is closed they always pop in the viewport so they're never missed.
//  - informational toasts hide when the drawer is open OR when the user opted into
//    "toasts in the drawer only".
const hideCritical = $derived($connectDrawerOpen || $toastsInDrawerOnly);
const hideRegular = $derived($connectDrawerOpen || $toastsInDrawerOnly);

// U-3: cap how many generic toasts stack at once (older ones collapse into a
// "+N more" line) so bursts can't fill the screen. 38 R8: 3, SPEC §5.
const MAX_TOASTS = 3;
// 15-P: a rush of joiners folds the same way — the drawer's Toasts tab lists
// every pending request, so the viewport never fills with approval cards
const MAX_REQUESTS = 3;

// 15-P: STICKY prompts (restore a session, the first-run notice) must never be
// evicted by a burst of ordinary toasts — only the transient ones are capped,
// and the "+N more" count reflects just those. Sticky cards render LAST so they
// hold a stable spot while transients come and go above them.
// 27-E: one 1s tick, and only while a request is actually pending.
let approvalTick = $state(Date.now());
$effect(() => {
    if (!$pendingApprovals.length) return;
    const t = setInterval(() => (approvalTick = Date.now()), 1000);
    return () => clearInterval(t);
});
function approvalAge(peerId: string) {
    void approvalTick;
    const started = $approvalStartedAt[peerId];
    return started ? Date.now() - started : 0;
}
// A pending row comes from a store declared `writable([])`, which TypeScript infers as
// `never[]` — so reading `.peerId` off the row is an error at every use. Narrow ONCE
// here rather than casting at each read in the card.
const rowAge = (approval: any) => approvalAge(approval?.peerId);
const roomFull = $derived(roomIsFull($peers));

const stickyToasts = $derived($toastStore.filter((t: any) => t?.sticky));
// 37 R25: an Undo offer sits in the CRITICAL tier (above modals): the action it takes back
// often came FROM a dialog still open (Settings ▸ Reset settings), and an Undo under that
// dialog is an Undo nobody can press. It is not folded into "+N more" either.
const undoToasts = $derived($toastStore.filter((t: any) => t?.kind === 'undo'));
const transientToasts = $derived($toastStore.filter((t: any) => !t?.sticky && t?.kind !== 'undo'));
const hiddenCount = $derived(Math.max(0, transientToasts.length - MAX_TOASTS));
const visibleToasts = $derived([...transientToasts.slice(-MAX_TOASTS), ...stickyToasts]);

// 26-B (audit M6): ONE traversal, then set lookups. This ran
// `getObjectByProperty` — a full tree walk — TWICE per outstanding uuid, on every
// scene poke: with 1,000 objects still to arrive over a 1,000-object scene that is
// two million node visits per poke, and the receive path poked once per object. It
// was the single most expensive consumer of the poke and a large part of the
// reported freeze. Same verdict, O(objects + outstanding) instead of O(both).
$effect(() => {
    const group = $objectsGroup;
    const outstanding = $loading;
    if (!group || !outstanding.length) return;
    /** @type {Set<string>} */
    const present = new Set();
    group.traverse((/** @type {any} */ o) => present.add(o.uuid));
    const left = outstanding.filter((/** @type {string} */ uuid) => !present.has(uuid));
    if (left.length !== outstanding.length) loading.set(left);
});

// 15-P2: "Receiving objects" visibility. The old machinery (showToast +
// toastStatus + a re-arming trigger()) fired its "done" branch on EVERY effect
// run once $loading emptied — and $objectsGroup pokes on every scene mutation,
// so the completed toast kept re-showing forever. One state, one rule: visible
// while a transfer runs, then a short grace so the user sees "N/N", then gone
// until the next transfer starts.
let progressVisible = $state(false);
let progressHideTimer: any;
$effect(() => {
    if ($loading.length > 0) {
        clearTimeout(progressHideTimer);
        progressVisible = true;
    } else if (progressVisible) {
        clearTimeout(progressHideTimer);
        progressHideTimer = setTimeout(() => (progressVisible = false), 2500);
    }
});

// Approve an incoming connection request. `role` (cloud roles) optionally grants the
// joiner a role right away — "Approve + edit" makes them an editor instead of the
// default viewer. A 'retry' request just re-establishes an existing whitelisted conn.
function approvePeer(approval, role) {
    // 27-E: the mesh is FULL — every peer holds N-1 connections and every mutation fans
    // out N-1 times — so past the hard cap approving degrades the session for everyone,
    // not just for the person joining. The button is disabled with the reason; this is
    // the backstop for any other path in. Counted off the OPEN
    // connections: userdata is the whitelist, written at DIAL time, so it counts every
    // person ever invited — including those who never arrived and those who have left.
    if (roomIsFull($peers)) {
        showToast('This session is full (' + HARD_PEER_CAP + ' people). Ask someone to leave first.');
        return;
    }
    if (sessionSize($peers) >= $softPeerCap)
        showToast('That is ' + (sessionSize($peers) + 1) + ' people — voice and live gestures may lag on slower devices.');
    $pendingApprovals = $pendingApprovals.filter((p) => p.peerId !== approval.peerId);
    if (approval.status === 'retry') {
        try { $peers.connections[approval.peerId]?.close(); } catch {}
    } else {
        $userdata.push([approval.peerId, '', '']);
    }
    $peers.send({ type: 'userdata', userdata: $userdata });
    // 25-F: an approval dial-back says it is one (a retry is a re-dial, not an approval)
    if (approval.status !== 'retry' && typeof $peers.approveDialBack === 'function') $peers.approveDialBack(approval.peerId);
    else $peers.connectToPeer(approval.peerId, true);
    if (role && $rolesInfo?.setRole) $rolesInfo.setRole(approval.peerId, role);
}
// 25-F: through the shared deny, so the joiner HEARS it (and VR and the card agree)
const hearsNo = (approval: any) => !!approval?.hearsNo;
function rejectPeer(approval, result: 'denied' | 'full' = 'denied') {
    denyPeer(approval.peerId, result);
}

// professional toast card: manual close (✕) + auto-dismiss timer (kept from before)
function dismiss(toast: any) {
    // 15-L: sticky info toasts carry the side effect their old bespoke close
    // button had (persist "seen", drop the restore snapshot)
    try { toast?.onDismiss?.(); } catch {}
    $toastStore = $toastStore.filter((t) => t !== toast);
}
function autoDismiss(node: any, toast: any) {
    if (toast?.sticky) return {}; // 15-L: info prompts wait for the user
    if (toast?.kind === 'undo') return {}; // 37 R25: undoToast.js owns this one's lifetime
    const id = setTimeout(() => dismiss(toast), typeof toast === 'string' ? 5000 : 15000);
    return { destroy() { clearTimeout(id); } };
}

// 15-L: the restore prompt and the first-run notice used to be hand-rolled
// <Toast> blocks — which is why they looked nothing like the other cards and
// never appeared in the drawer's Toasts tab. They are STATE-DRIVEN, so mirror
// each source store into a sticky INFO entry and pull it when the source clears.
// once answered, do not ask again this session: the prompt is a nudge, and one that
// came back every time a file landed would be an interruption instead
let libraryPromptDone = false;
/** R22 round 30 C2: the share/stash half of this card moved into the Explorer strip,
 * so the arm-then-confirm state went with it. What stays here is only what the
 * Explorer cannot say: the scene on screen is unsaved, and files nobody is fetching. */
/** the ask announced by `explorer-share-ask`, so one batch cannot toast twice */
let announcedAsk = '';

$effect(() => {
    const err = $lastUncaught;
    if (err)
        showInfoToast(
            'diagnostics-error',
            `Something went wrong: ${err.message}`,
            [
                {
                    label: 'Copy diagnostics',
                    keepOpen: true,
                    action: async () => {
                        const ok = await copyDiagnostics();
                        showToast(ok ? 'Diagnostics copied to the clipboard' : 'Could not copy the diagnostics');
                    }
                }
            ],
            () => lastUncaught.set(null)
        );
    else dismissToastById('diagnostics-error');
});

// 41-modals G16: the restore-session and ingest-gate prompts are kit MODALS now
// (SessionPrompts.svelte) — blocking questions, not passive outcomes.
// R22 round 2 (user): WHAT ABOUT THE FILES ALREADY IN MY EXPLORER? Connecting to a
// session with a library full of local files used to say nothing at all — they simply
// stayed invisible to everyone, which is correct behaviour and a terrible first
// impression. So the moment a session exists and there is something to offer, ask.
//
// R22 round 30 C2 — HALF OF IT LEFT. "There is no logic in having share/stash options"
// here was the report, and the reason is placement: this card floats over the 3D view
// and expires, while the thing it is asking about is a list of files in a panel. The
// share question is the Explorer's strip now (`pendingShareAsk`). What remains is what
// the Explorer genuinely cannot say — the SCENE on screen has unsaved work, and there
// are shared files nothing is fetching because auto-download is off. With neither true
// there is no card at all, which is the "do not prompt" half of the same report.
$effect(() => {
    // a SET, not an array (peerHandler) — `.length` here meant the prompt never showed
    // a SET, not an array (peerHandler) — `.length` here meant the prompt never showed
    // ...and only for a JOINER: `sessionHost` is null when we are the host, and a host
    // has nothing to adopt because the project is already theirs
    const connected = ($peers?.openedPeers?.size ?? 0) > 0 && !!$sessionHost;
    // read the stores so the effect re-runs as the library and the index change
    void $explorerItems;
    void $projectManifest;
    const counts = connected ? bulkCounts() : { local: 0, missing: 0 };
    // R22 round 9 (reported): the offer said "1 file" for a scene the user had not saved,
    // which is true and useless — the one file was a `.tpscene` from an earlier save, and
    // sharing it would hand peers a STALE version of what is on screen. Two questions,
    // asked in the right order: is there work here that is not written down, and only then
    // are there files to share.
    //
    // `worldEmpty` is what stops this from nagging: with nothing in the scene and nothing
    // in the library there is no offer to make at all, which is the other half of the
    // report ("do not prompt").
    void $currentLevel;
    const worldEmpty = !(($objectsGroup?.children?.length ?? 0) > 0);
    // `libraryPromptDone` FIRST, and `$sceneDirty` before the recompute: the synchronous
    // verdict costs a whole-scene serialization, and this effect re-runs on every manifest
    // change — which during active sharing is often. Once the user has answered the card
    // there is nothing to decide, and while the throttled store already says dirty there is
    // nothing to find out.
    const unsavedScene =
        connected &&
        !worldEmpty &&
        !libraryPromptDone &&
        (!$currentLevel?.name || $sceneDirty || recomputeSceneDirty());
    const parts = [];
    if (unsavedScene)
        parts.push($currentLevel?.name
            ? `“${$currentLevel.name}” has unsaved changes`
            : 'this scene has never been saved');
    // R22 round 8: only worth mentioning when the app is NOT already fetching them.
    // With auto-download on (the default) this line describes a job in progress, and a
    // button for it would be a button for something already happening.
    if (counts.missing && !$autoDownload)
        parts.push(`${counts.missing} shared file${counts.missing === 1 ? '' : 's'} not downloaded`);
    // R22 round 7 (locked answer): NO SECOND DIALOG. Each button does one thing and says
    // what it costs; the destructive one confirms IN PLACE (its label becomes the
    // question) rather than opening a modal that asks it again. Only "Not now" dismisses
    // the toast — picking an action dismisses it because the action happened, which is
    // the timing bug in the modal version: Cancel closed the toast it came from.
    if (connected && parts.length && !libraryPromptDone)
        showInfoToast(
            'shared-library-offer',
            parts.join(' \u00b7 ') + '.',
            [
                // R22 round 9: the SAVE comes first when there is unsaved work — sharing a stale
                // file is the failure this was reported as. It arms the Explorer's own inline
                // save card (the no-prompt rename convention) rather than inventing a name.
                ...(unsavedScene
                    ? [{ label: 'Save the scene…', action: () => { libraryPromptDone = true; explorerClose.set(false); armExplorerSceneSave(null); dismissToastById('shared-library-offer'); } }]
                    : []),
                ...(counts.missing && !$autoDownload
                    ? [{ label: 'Download theirs', action: () => { libraryPromptDone = true; const n = pullAllShared(); showToast(`Fetching ${n} file${n === 1 ? '' : 's'} from peers`); dismissToastById('shared-library-offer'); } }]
                    : []),
                // "Not now" belongs to any card that asked for something — an offer to save
                // the scene is as declinable as an offer to download somebody else's files
                ...(unsavedScene || (counts.missing && !$autoDownload)
                    ? [{ label: 'Not now', action: () => { libraryPromptDone = true; dismissToastById('shared-library-offer'); } }]
                    : [])
            ],
            () => { libraryPromptDone = true; }
        );
    else dismissToastById('shared-library-offer');
});

// R22 round 30 C2 — THE ASK WHEN THE EXPLORER IS SHUT.
//
// The question itself is a strip inside the Explorer, which is the right place for it and
// is also NOT MOUNTED half the time. So this is the pointer, not the question: one toast
// per batch saying what happened and offering the way to the panel that can answer it.
// `pendingShareAsk` STAYS ARMED — nothing is decided here — so opening the Explorer later,
// by this button or by any other route, still shows the strip.
$effect(() => {
    const ask = $pendingShareAsk;
    if (!ask) {
        announcedAsk = '';
        return;
    }
    // only while the panel that draws the strip is closed; opening it is the answer to
    // this toast, and the strip takes over from there
    if (!$explorerClose) return;
    const sig = ask.items.map((i) => i.id).join('|');
    if (sig === announcedAsk) return;
    announcedAsk = sig;
    const n = ask.items.length;
    untrack(() =>
        showToast(
            `${n} file${n === 1 ? '' : 's'} added — open the Explorer to share ${n === 1 ? 'it' : 'them'} with the session`,
            [{ label: 'Open Explorer', action: () => explorerClose.set(false) }]
        )
    );
});

$effect(() => {
    const notice = $appNotice;
    const seen = typeof localStorage !== 'undefined' && !!safeStorage.getItem('hasSeenDisclaimer');
    const markSeen = () => {
        try { safeStorage.setItem('hasSeenDisclaimer', 'true'); } catch {}
    };
    if (notice && !seen)
        showInfoToast(
            'app-notice',
            notice.text,
            notice.ctaUrl
                ? [{ label: notice.ctaLabel || 'Learn more', action: () => { markSeen(); window.open(notice.ctaUrl, '_blank'); } }]
                : [],
            markSeen
        );
    else dismissToastById('app-notice');
});

</script>
<!-- 15-P: ONE positioning wrapper so the two z-tiers STACK instead of overlapping.
     Both containers used to be `absolute; top:65px; left:50%`, i.e. pinned to the
     same spot — approval cards physically covered the info toasts. The wrapper
     must NOT use transform (that would create a stacking context and trap the
     children's z-index, breaking "approvals above modals"), so it centres with
     auto margins. -->
<div class="toasts-stack tp-ui">
<!-- 33 L1: a scene load's progress — the stack's first slot, like the mode banners below -->
<SceneLoadBar />
<StartViewHint /><!-- 36 L2: "camera is held" / "Back to start view" -->

<!-- 15-P: SPECTATOR banner — a MODE indicator, not a toast. Modes belong in a
     stable, always-visible strip (the recording/impersonation-banner pattern):
     it never queues behind toasts, never shifts when one arrives, and never
     auto-expires. Keeps its red framing + prominent Exit. -->
{#if $specatorMode}
<div class="spectator-banner" transition:fly={{ y: -8, duration: 180 }}>
    <div class="spectator-inner">
        <span class="spectator-dot" aria-hidden="true"></span>
        <div class="inline-flex items-center">
            <p class="spectator-text">
                Watching <strong>{$specatorMode}</strong>{#if lookNote}<span class="spectator-note" title="What you see is rendered with their look settings while you watch"> · {lookNote}</span>{/if}
            </p>
            <button
            class="spectator-exit"
            title="Stop watching and return to your own camera"
            onclick={exitSpectate}
            >Exit</button
        >
        </div>
    </div>
</div>
{/if}

<!-- 16-P5: previewing a camera OBJECT is a MODE, so it gets the same always-
     visible strip as "Watching <peer>" (never queues behind toasts, never
     auto-expires). Control hands the camera to the normal viewport navigation
     (WASD + mouse) and writes the pose back onto the marker. -->
{#if $cameraPreview}
<div class="spectator-banner preview-banner" transition:fly={{ y: -8, duration: 180 }}>
    <div class="spectator-inner">
        <span class="spectator-dot" aria-hidden="true"></span>
        <div class="inline-flex items-center">
            <p class="spectator-text">
                Previewing <strong>{previewLabel($cameraPreview.uuid)}</strong>
            </p>
            <button
                class="preview-control"
                class:on={$cameraPreview.controlling}
                title={$cameraPreview.controlling
                    ? 'Stop flying the camera (its new pose is kept, as one undo step)'
                    : 'Fly this camera with WASD + mouse, like the viewport camera'}
                onclick={() => toggleCameraControl()}
                >{$cameraPreview.controlling ? 'Stop control' : 'Control'}</button
            >
            <button
                class="spectator-exit"
                title="Leave the preview and return to your own view"
                onclick={() => stopCameraPreview()}>Exit</button
            >
        </div>
    </div>
</div>
{/if}
<!-- E1: CRITICAL container — connection requests + pending outbound requests stay
     ABOVE modals (--z-toast beats the NON-MODAL dialogs at --z-modal) so an
     approval is never missed while a modal is open. -->
<div class="my-4 toasts-container toasts-critical"
class:cxd-hidden={hideCritical}
style="z-index: var(--z-toast); pointer-events: none;"
>
{#each $pendingApprovals.slice(0, MAX_REQUESTS) as approval}
<div class="my-1 tp-toast tp-toast--req" transition:fly={{ y: -8, duration: 180 }}>
    <div class="tp-toast-body">
        <Icon name="user-plus" size={16} class="tp-toast-icon" aria-hidden="true" />
        <div class="tp-toast-main">
            <div class="tp-toast-text">
                Connection request <span class="cxreq-id">{String(approval.peerId).slice(0, 6).toUpperCase()}</span>
            </div>
            <!-- 29: a cloud plugin's label for the knock ("Ada wants to join Amber Mesa") -->
            {#if approval.label}<div class="cxreq-label">{approval.label}</div>{/if}
            <!-- 27-E: how long they have been waiting. An EXPIRED card stays approvable —
                 a missed request is worse than a stale card, and approving still just
                 dials back; if they gave up, that dial answers with peer-unavailable,
                 which their side already turns into a clean cancel. -->
            <div class="cxreq-age" class:expired={rowAge(approval) > APPROVAL_WINDOW_MS}>
                {#if rowAge(approval) > APPROVAL_WINDOW_MS}
                    asked {Math.round(rowAge(approval) / 1000)}s ago — they may have given up
                {:else}
                    asked {Math.max(1, Math.round(rowAge(approval) / 1000))}s ago
                {/if}
                {#if roomFull}· this session is full ({HARD_PEER_CAP}){/if}
            </div>
            <div class="tp-toast-actions">
                {#if $rolesInfo}
                    <button class="cxreq-btn cxreq-view" disabled={roomFull} onclick={() => approvePeer(approval, null)} title={roomFull ? 'This session is full (' + HARD_PEER_CAP + ')' : 'Approve as a view-only viewer'}>View only</button>
                    {#if approval.status !== 'retry'}
                        <button class="cxreq-btn cxreq-editor" disabled={roomFull} onclick={() => approvePeer(approval, 'editor')} title={roomFull ? 'This session is full (' + HARD_PEER_CAP + ')' : 'Approve and grant edit access'}>Editor access</button>
                    {/if}
                {:else}
                    <button class="cxreq-btn cxreq-editor" disabled={roomFull} onclick={() => approvePeer(approval, null)} title={roomFull ? 'This session is full (' + HARD_PEER_CAP + ')' : 'Approve this request'}>Approve</button>
                {/if}
                <!-- 25-F: at the cap, say so. Only offered to a joiner that can hear it —
                     an older build would take ANY dial from us as an approval. -->
                {#if roomFull && hearsNo(approval)}
                    <button class="cxreq-btn cxreq-full" onclick={() => rejectPeer(approval, 'full')} title={'Tell them this session is full (' + HARD_PEER_CAP + ')'}>Tell them it's full</button>
                {/if}
                <button class="cxreq-btn cxreq-reject" onclick={() => rejectPeer(approval)} title={hearsNo(approval) ? 'Decline — they are told' : 'Decline'}>Reject</button>
            </div>
        </div>
    </div>
</div>
{/each}
<!-- 15-P: a rush of joiners folds like any other burst — the drawer lists them all -->
{#if $pendingApprovals.length > MAX_REQUESTS}
<div class="my-1 text-center">
    <button
        id="request-overflow-more"
        class="tp-toast-more"
        title="Show all connection requests in the Connect drawer"
        onclick={() => { connectDrawerTab.set('toasts'); connectDrawerOpen.set(true); }}
        >+{$pendingApprovals.length - MAX_REQUESTS} more request{$pendingApprovals.length - MAX_REQUESTS === 1 ? '' : 's'}…</button
    >
</div>
{/if}

<!-- 37 R25: Undo offers (above modals — see undoToasts) -->
{#each undoToasts as toast (toast)}
{@render toastCard(toast)}
{/each}
<!-- CN: the OUTBOUND "Connection request to peer / pending" toast was removed — the
     Connect pill already shows the "Waiting for approval…" state + a Cancel button, so
     the toast was redundant chrome. Incoming approval requests (above) still toast. -->
</div>

<!-- pointer-events: none lets clicks pass through the (invisible) container area;
     each toast re-enables them for itself. REGULAR container: info/decision toasts
     sit BELOW modals (--z-toast-low) so Settings/Modules/Sessions cover them. -->
<div class="my-4 toasts-container toasts-regular"
class:cxd-hidden={hideRegular}
style="z-index: var(--z-toast-low); pointer-events: none;"
>
{#if progressVisible && $loadingcount > 0}
<!-- 15-P: transfer progress wears the shared card too (it is a notification);
     15-P2: progressVisible hides it 2.5s after the transfer completes -->
<div class="my-1 tp-toast tp-toast--progress" transition:fly={{ y: -8, duration: 180 }}>
	<div class="tp-toast-body">
		<Icon name="download" size={16} class="tp-toast-icon" aria-hidden="true" />
		<div class="tp-toast-main">
			<div class="tp-toast-text">Receiving objects: {($loadingcount-$loading.length)}/{$loadingcount}</div>
			<div class="tp-toast-progress" role="progressbar" aria-label="Receiving objects" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(loadPct)}>
				<div class="tp-toast-progress-fill" style:width="{loadPct}%"></div>
			</div>
		</div>
	</div>
</div>
{/if}


<!-- 15-L: the restore prompt + the first-run notice now ride the normal toast
     pipeline as STICKY INFO cards (mirrored into toastStore by the $effects above),
     so they share the card chrome and appear in the Connect drawer Toasts tab. -->


{#if $fixLight && !fixLightClosed}
<!-- 38 R8: the "no light" prompt on the shared card (was a red-bordered flowbite Toast). ✕
     behaves as before: it records the disclaimer as seen and hides THIS appearance only. -->
<div class="my-1 tp-toast" id="fix-light-toast" transition:fly={{ y: -8, duration: 180 }}>
    <button class="tp-toast-x" title="Dismiss" aria-label="Dismiss" onclick={() => { safeStorage.setItem('hasSeenDisclaimer', 'true'); fixLightClosed = true; }}>✕</button>
    <div class="tp-toast-body">
        <Icon name="info" size={16} class="tp-toast-icon" aria-hidden="true" />
        <div class="tp-toast-main">
            <div class="tp-toast-text">There is no light in the scene. Click Fix to add a hemisphere light.</div>
            <div class="tp-toast-actions">
                <button
                    class="tp-toast-action"
                    onclick={() => {
                        showSidebar('lightProperties');
                        sceneCommand('/light hemisphere');
                        $fixLight = false;
                    }}>Fix</button
                >
            </div>
        </div>
    </div>
</div>
{/if}

<!-- keyed by the entry (dedupe keeps plain strings unique; action toasts are
     distinct objects): an UNKEYED each reuses rows here, so a neighbour's expiry
     migrated text across nodes and svelte 5.5x left a stuck duplicate behind -->
{#each visibleToasts as toast (toast)}
{@render toastCard(toast)}
{/each}
{#if hiddenCount > 0}
<!-- 38 R8: BELOW the stack (SPEC §5 "max 3, then +N more"). 15-L: the overflow line is a BUTTON — the hidden toasts all live in the
     drawer's Toasts tab, so send the user straight there -->
<div class="my-1 text-center">
    <button
        id="toast-overflow-more"
        class="tp-toast-more"
        title="Show all toasts in the Connect drawer"
        onclick={() => { connectDrawerTab.set('toasts'); connectDrawerOpen.set(true); }}
        >+{hiddenCount} more…</button
    >
</div>
{/if}

</div>
</div><!-- /toasts-stack -->

{#snippet toastCard(toast: any)}
<div class="my-1 tp-toast" class:tp-toast--info={toast?.kind === 'info'} class:tp-toast--undo={toast?.kind === 'undo'} transition:fly={{ y: -8, duration: 180 }} use:autoDismiss={toast}>
    {#if toast?.kind === 'undo'}
        <!-- 37 R25: how long the Undo stays on offer, draining (CSS only; the timer lives in undoToast.js) -->
        <span class="tp-toast-ttl" style:animation-duration={`${toast.ttl}ms`} aria-hidden="true"></span>
    {/if}
    {#if !toast?.noClose}
        <button class="tp-toast-x" title="Dismiss" aria-label="Dismiss" onclick={() => dismiss(toast)}>✕</button>
    {/if}
    <div class="tp-toast-body">
        <Icon name="info" size={16} class="tp-toast-icon" aria-hidden="true" />
        <div class="tp-toast-main">
            <div class="tp-toast-text">{typeof toast === 'string' ? toast : toast.text}</div>
            {#if typeof toast !== 'string' && toast.actions?.length}
                <div class="tp-toast-actions">
                    {#each toast.actions as entry}
						<!-- R22 round 7: `keepOpen` is what makes an INLINE CONFIRM possible. Every
						     action used to dismiss the toast, so a button that arms a second press
						     closed the very card it was arming — which is the timing complaint the
						     modal version had, one layer down. -->
						<button
							class="tp-toast-action"
							onclick={() => {
								entry.action();
								if (!entry.keepOpen) dismiss(toast);
							}}>{entry.label}</button
						>
                    {/each}
                </div>
            {/if}
        </div>
    </div>
</div>
{/snippet}

<style>
    /* toasts stay clickable while the empty container area passes clicks through */
    :global(.toasts-container > div) {
        pointer-events: auto;
    }
    /* 15-P: the two z-tiers live in ONE wrapper so they STACK (critical first,
       then regular) instead of being pinned to the same coordinates and
       overlapping. Centred with auto margins — a transform here would create a
       stacking context and trap the children's z-index, which is what keeps
       approvals above modals and regular toasts below them. */
    .toasts-stack {
        position: absolute;
        top: 65px;
        left: 0;
        right: 0;
        margin-inline: auto;
        width: min(500px, 94vw);
        pointer-events: none;
    }
    .toasts-container {
        position: relative;
        width: 100%;
    }
    /* the stack owns the top offset now; the containers just flow inside it */
    .toasts-critical:empty,
    .toasts-regular:empty {
        display: none;
    }
    .cxd-hidden {
        display: none !important;
    }
    /* connection-request card — 15-P: the card CHROME is now .tp-toast--req (shared
       with every other toast); only the role-coloured buttons + the peer-id chip
       remain bespoke (viewer=gray, editor=blue, reject=outlined red). */
    .cxreq-id { font-size: var(--fs-badge); color: var(--text-muted); font-family: var(--font-ui-mono); }
    .cxreq-age {
    margin-top: 2px;
    font-size: 11px;
    opacity: 0.65;
}
.cxreq-label {
    margin-top: 2px;
    font-size: 12px;
    overflow-wrap: anywhere;
}
.cxreq-age.expired {
    opacity: 0.9;
    color: var(--warn-text);
}
.cxreq-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
/* 38 R8: the request card's buttons on the kit Button look — the grant is the filled
   primary, view-only and "it's full" are secondary, Reject is the outlined danger */
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
    .cxreq-btn:hover:not(:disabled) { background: var(--surface-hover); }
    .cxreq-editor { background: var(--accent-fill); border-color: transparent; color: var(--on-accent); }
    .cxreq-editor:hover:not(:disabled) { background: var(--accent-fill); filter: brightness(1.08); }
    .cxreq-reject { border-color: color-mix(in srgb, var(--danger) 45%, transparent); color: var(--ink-bad, var(--danger)); }
    .cxreq-reject:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .cxreq-full { color: var(--warn-text); }
    @media (pointer: coarse) { .cxreq-btn { height: 44px; } }
    /* 38 R8: the toast card = the kit's Toast look (SPEC §5): window surface, one border,
       the icon carries the kind's ink — no coloured stripe. Tokens only. */
    .tp-toast {
        pointer-events: auto;
        position: relative;
        width: min(400px, 94vw);
        margin: 0 auto;
        box-sizing: border-box;
        background: var(--surface-1);
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-card);
        padding: 10px 34px 10px 12px;
        box-shadow: var(--shadow-window);
        color: var(--text-2);
        font-family: var(--font-ui);
    }
    .tp-toast-body { display: flex; align-items: flex-start; gap: 10px; }
    /* the icon is a lucide component's svg (outside this component's scope hash) */
    .tp-toast-body :global(.tp-toast-icon) { color: var(--accent-text); margin-top: 1px; flex: 0 0 auto; }
    .tp-toast-main { min-width: 0; flex: 1 1 auto; }
    .tp-toast-text { font-size: var(--fs-desc); color: var(--text-2); line-height: 1.45; }
    .tp-toast-progress { margin-top: 6px; height: 6px; border-radius: var(--radius-pill); background: var(--surface-inset); overflow: hidden; }
    .tp-toast-progress-fill { height: 100%; border-radius: inherit; background: var(--ink-good); transition: width 0.2s ease; }
    .tp-toast-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; }
    .tp-toast-action { font-size: var(--fs-desc); font-weight: 500; color: var(--accent-text); background: transparent; border: 0; cursor: pointer; padding: 0; }
    .tp-toast-action:hover { text-decoration: underline; }
    .tp-toast-action:focus-visible, .tp-toast-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
    .tp-toast-x {
        position: absolute; top: 7px; right: 7px; width: 22px; height: 22px;
        border: 0; background: transparent; color: var(--text-faint); cursor: pointer;
        font-size: 11px; line-height: 1; border-radius: var(--radius-input);
    }
    .tp-toast-x:hover { color: var(--text); background: var(--surface-hover); }
    /* 37 R25: an Undo offer drains a thin bar along the card's bottom edge for the time it
       stays on offer — the timer lives in undoToast.js, the bar is only the picture of it */
    .tp-toast--undo { overflow: hidden; }
    .tp-toast-ttl {
        position: absolute; left: 0; bottom: 0; height: 2px; width: 100%;
        background: var(--accent); transform-origin: left center;
        animation-name: tp-toast-drain; animation-timing-function: linear; animation-fill-mode: forwards;
    }
    @keyframes tp-toast-drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }
    /* the kinds differ by the icon's ink only: a decision (approval) = warn, transfer =
       good, a standing system prompt = the accent like any notification */
    .tp-toast--req :global(.tp-toast-icon) { color: var(--ink-warn); }
    .tp-toast--req .tp-toast-actions { gap: 8px; margin-top: 8px; }
    .tp-toast--progress :global(.tp-toast-icon) { color: var(--ink-good); }
    .tp-toast--info { background: var(--surface-1); }
    /* 15-P: SPECTATOR mode banner. A mode is not a notification: it gets its own
       fixed strip so it can never be queued behind toasts or shifted when one
       arrives (the user's complaint), never expires, and stays exactly centred.
       Red framing + a live dot + a prominent Exit, the recording-banner pattern. */
    .spectator-banner {
        /* FIRST child of the stack, so it owns a fixed spot: toasts flow BELOW
           it and can never displace it (the old version was a toast in the
           queue, so every new toast shoved it). Not `fixed` — top-centre is the
           Connect pill's, and the banner would collide with it. */
        position: relative;
        z-index: var(--z-toast);
        display: flex;
        justify-content: center;
        margin-bottom: 6px;
        pointer-events: none;
    }
    .spectator-inner {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 6px 8px 6px 12px;
        border-radius: 999px;
        /* 38 R8: the PlayBanner's glass look — a MODE you are in, not an alarm */
        background: var(--hud-glass, var(--surface-1));
        border: 1px solid var(--border);
        box-shadow: var(--hud-shadow, var(--shadow-window));
        backdrop-filter: blur(12px);
        color: var(--text);
        font-family: var(--font-ui);
    }
    .spectator-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
        animation: spectator-pulse 1.8s ease-in-out infinite;
    }
    @keyframes spectator-pulse {
        50% { opacity: 0.35; }
    }
    .spectator-note {
        font-weight: 400;
        opacity: 0.8;
    }

    .spectator-text {
        font-size: var(--fs-desc);
        color: var(--text-2);
        margin: 0;
        white-space: nowrap;
    }
    .spectator-text strong { color: var(--text); font-weight: 600; }
    .spectator-exit {
        margin-left: 10px;
        font-size: 11.5px;
        font-weight: 600;
        padding: 5px 14px;
        border-radius: 999px;
        border: 0;
        cursor: pointer;
        background: var(--accent-fill);
        color: var(--on-accent);
    }
    .spectator-exit:hover { filter: brightness(1.08); }
    /* 16-P5: preview banner reuses the strip, in a calmer blue */
    .preview-banner .spectator-inner {
        border-color: var(--accent-muted);
    }
    .preview-banner .spectator-dot { background: var(--accent-muted); }
    .preview-control {
        margin-left: 10px;
        border-radius: 6px;
        padding: 2px 10px;
        font-size: 11px;
        font-weight: 600;
        color: var(--text);
        background: var(--surface-2);
        border: 1px solid var(--border);
    }
    .preview-control:hover { background: var(--surface-hover); }
    .preview-control.on {
        color: var(--accent-soft-text);
        background: var(--accent-soft);
    }
    @media (prefers-reduced-motion: reduce) {
        .spectator-dot { animation: none; }
    }
    /* the "+N more" overflow line is a button into the drawer's Toasts tab */
    .tp-toast-more {
        pointer-events: auto;
        border: 1px solid var(--border-strong); cursor: pointer;
        background: color-mix(in srgb, var(--surface-1) 88%, transparent);
        font-size: var(--fs-badge); color: var(--text-muted); padding: 3px 10px; border-radius: var(--radius-pill);
    }
    .tp-toast-more:hover { color: var(--text); }
    /* narrow: full-width connect bar (row 1) + logo/profile (row 2) sit above; keep
       toasts below both */
    @media (max-width: 640px) {
        .toasts-stack {
            top: 124px;
        }
    }
</style>
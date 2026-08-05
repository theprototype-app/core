<script lang="ts">
    import { Grid } from '@threlte/extras'
    import { T, useThrelte, useTask } from '@threlte/core'
    import { orbitControls } from '../stores/sceneStore'
    import { gridSettings, effectiveCell } from '../lib/gridSettings'
    import { snapSettings } from '../lib/snapping'
    let { showGrid } = $props()

    // B1 (roadmap #13): the infinite grid fades out beyond `fadeDistance` world
    // units from the camera. A fixed 100 made the grid vanish on far dolly-out
    // (cameraClip grows the far plane with the scene, but the grid didn't follow),
    // so we scale the fade with the camera's zoom.
    //
    // I4 (roadmap #13): the earlier version EASED `fade` toward the target at
    // 0.2/frame. That lag made the circular fade boundary trail the camera and
    // sweep across the grid for ~0.6s after every move — a "flashing ring". Fix:
    //   - derive the zoom proxy from the orbit distance-to-TARGET (constant during a
    //     pure orbit, so orbiting no longer wobbles the ring), not origin distance;
    //   - SNAP fadeDistance to the target each frame (no lerp). During a smooth
    //     dolly the target changes smoothly, so snapping tracks the camera with no
    //     lag and no pop; a discrete camera jump just resizes the ring instantly.
    //
    // 16-P3: all of the appearance now comes from the LOCAL `gridSettings` prefs
    // (Configure Scene ▸ Grid); 'fixed' fade mode skips the auto math entirely.
    //
    // 15-H13: the follow centre snaps by the SECTION period (see below) — the
    // earlier per-CELL snap made every thick line hop one cell per step.
    //
    // 16-Q2: FOLLOW is ours, not threlte's `followCamera` — that one tracked your
    // POSITION, which is not what "follow the camera" wants to mean when you are
    // looking somewhere else. 'lookat' centres the grid under the orbit target,
    // 'camera' keeps the old behaviour, and both stay HORIZONTAL (y = 0: it is the
    // ground plane, not a flying sheet). The centre snaps to whole cells so the
    // lines keep lining up with world coordinates instead of sliding.
    const { camera } = useThrelte()
    let fade = $state(100)
    let centerX = $state(0)
    let centerZ = $state(0)
    useTask(() => {
      const cam = camera.current
      if (!cam) return
      const oc = $orbitControls
      if ($gridSettings.fadeMode === 'auto') {
        const dist = oc?.target ? cam.position.distanceTo(oc.target) : cam.position.length()
        fade = Math.min(Math.max(100, dist * 1.6), 5000)
      }
      const follow = $gridSettings.follow
      if (follow === 'off') {
        centerX = 0
        centerZ = 0
        return
      }
      const anchor = follow === 'lookat' && oc?.target ? oc.target : cam.position
      // The centre must snap by the SECTION period, not by one cell: the line
      // pattern only maps onto itself when you translate it a whole section
      // (cell x sectionEvery). Snapping per cell kept the thin lines world-locked
      // but hopped every THICK line by one cell on each step — the "grid snaps
      // while panning" report. A section-step snap is invisible: every line lands
      // exactly where a line already was.
      // (The fade circle is deliberately NOT tied to this anchor — threlte's Grid
      // defaults its fadeOrigin to the camera position projected onto the grid
      // plane, which already glides continuously. Feeding it a snapped point is
      // what re-introduces a jumping fade ring, cf. I4's "flashing circle" fix.)
      const step = Math.max(0.001, section)
      centerX = Math.round(anchor.x / step) * step
      centerZ = Math.round(anchor.z / step) * step
    })

    const cell = $derived(effectiveCell($gridSettings, $snapSettings.translate))
    const section = $derived(cell * Math.max(1, $gridSettings.sectionEvery))
    const fadeDistance = $derived($gridSettings.fadeMode === 'auto' ? fade : $gridSettings.fadeDistance)
  </script>

   {#if showGrid}
    <Grid
      infiniteGrid={$gridSettings.infinite}
      gridSize={$gridSettings.infinite ? undefined : [$gridSettings.size, $gridSettings.size]}
      renderOrder={9999}
      position={[centerX, 0, centerZ + 0.03]}
      cellSize={cell}
      sectionSize={section}
      cellColor={$gridSettings.cellColor}
      sectionColor={$gridSettings.sectionColor}
      sectionThickness={1.2}
      {fadeDistance}
      fadeStrength={$gridSettings.fadeStrength}
      />
  {/if}
  {#if $gridSettings.showAxes}
    <!-- local origin marker; lives at the SCENE root so it never enters GLTF sync -->
    <T.AxesHelper args={[Math.max(2, section)]} />
  {/if}

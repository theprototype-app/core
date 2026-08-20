<script lang="ts">
    import { onDestroy, untrack } from 'svelte'
    import { Euler, Camera } from 'three'
    import { useThrelte, useParent, useTask } from '@threlte/core'
    import { isLocked, playPointerFree, playerCam, editorCam, globalScene } from '../../stores/sceneStore'
    import { userdata, peers } from '../../stores/appStore'
    import { dungeonData, slideMove, spawnPointFor } from '$lib/dungeonPlay'
    import { resolvePlaySettings } from '$lib/playSettings'
    import { inputClaims } from '$lib/inputRuntime'

    const { renderer, camera, invalidate } = useThrelte()
  
    const domElement = renderer.domElement
    const cameraParent = useParent()

    let { minPolarAngle, maxPolarAngle, pointerSpeed, moveSpeed } = $props()
    minPolarAngle = 0 // radians
    maxPolarAngle = Math.PI // radians
    pointerSpeed = 1.0    
    moveSpeed = .1
    
    let moveState = { forward: 0, backward: 0, left: 0, right: 0, up: 0, down: 0 };

    const _euler = new Euler(0, 0, 0, 'YXZ')
    const _PI_2 = Math.PI / 2
  
    if (!renderer) {
      throw new Error('Threlte Context missing: Is <PointerLockControls> a child of <Canvas>?')
    }
  
    const isCamera = (p: any): p is Camera => {
      return p.isCamera
    }
  
    if (!isCamera($cameraParent)) {
      throw new Error('Parent missing: <PointerLockControls> need to be a child of a <Camera>')
    }
  
    const onChange = () => {
      invalidate()
    }
  
    // 21-E3: THE MENU SUBSTATE. Edge-triggered on purpose (a `wasFree` local), so the
    // play-entry effect below stays exactly as it was. Rising edge: zero the movement
    // state (or the W held when the menu opened resumes the instant it closes) and
    // release the lock PROGRAMMATICALLY - a programmatic exit carries no browser
    // cooldown, unlike Esc. Falling edge while still playing: re-lock. The keydown that
    // closed the menu is a real user gesture inside the transient-activation window;
    // where an engine still refuses (Firefox without a fresh gesture), the pointerdown
    // fallback below recaptures on the next canvas click.
    let wasFree = false
    $effect(() => {
      const free = $playPointerFree
      untrack(() => {
        if (free && !wasFree) {
          wasFree = true
          moveState = { forward: 0, backward: 0, left: 0, right: 0, up: 0, down: 0 }
          if (document.pointerLockElement === domElement) document.exitPointerLock()
        } else if (!free && wasFree) {
          wasFree = false
          if ($isLocked === true && document.pointerLockElement !== domElement) {
            const again: any = domElement.requestPointerLock({ unadjustedMovement: true })
            again?.catch?.(() => {})
          }
        }
      })
    })

        $effect(() => {
      if ($isLocked) {
        // returns a promise in newer Chrome; rejection (headless, unsupported
        // unadjustedMovement) already surfaces via the pointerlockerror event
        const request: any = domElement.requestPointerLock({
          unadjustedMovement: true
        })
        request?.catch?.(() => {})
        // 21-E3: entering play with a menu ALREADY visible (a late joiner whose
        // showWhile-bound menu came with the state) - take the lock and let the menu
        // effect release it; the brief flicker is the honest order of events.
        // dungeon spawn (58.2): entering play with a dungeon present drops you
        // in your seed-deterministic room (peers take consecutive rooms).
        // untracked: the effect must only depend on $isLocked.
        untrack(() => {
          const data = dungeonData($globalScene)
          // resolve the rig ONCE and mutate the object: `$cameraParent.position.x = v`
          // compiles to store_mutate -> cameraParent.set(), and useParent() is a
          // READ-ONLY store (no .set) — it threw "store.set is not a function"
          // and aborted the spawn, dropping everyone in the same room.
          const rig: any = $cameraParent
          if (data && rig) {
            const my = ($peers as any)?.peer?.id ?? 'me'
            const spawn = spawnPointFor(data, ($userdata ?? []).map((u: any) => u[0]), my)
            if (spawn) {
              rig.position.x = spawn.x
              rig.position.y = 0.8
              rig.position.z = spawn.z
            }
          }
        })
      }
    })

    useTask(
    (delta) => {

      // K-C: a module claimed the keys (possession) — WASD drives IT, not the camera
      if ($inputClaims.includes('keys')) return
      // 21-E3: the menu pause does NOT ride the claim - a text-only PAUSED screen has
      // no focusables, so nothing claims, and the pause must hold anyway.
      if ($playPointerFree) return

      const beforeX = $cameraParent?.position.x ?? 0
      const beforeZ = $cameraParent?.position.z ?? 0

      if (moveState.forward === 1) {
        $cameraParent.translateZ(-moveSpeed);
      }

      if (moveState.backward === 1) {
        $cameraParent.translateZ(moveSpeed);
      }

      if (moveState.left === 1) {
        $cameraParent.translateX(-moveSpeed);
      }

      if (moveState.right === 1) {
        $cameraParent.translateX(moveSpeed);
      }

      // 21-B B3 (DEVX #14): a GROUNDED scene has no Q/E flight and pins the rig
      // to eye height, so a module no longer has to swallow those keys itself.
      const play = resolvePlaySettings($globalScene)

      if (!play.grounded && moveState.up === 1) {
        $cameraParent.translateY(-moveSpeed);
      }

      if (!play.grounded && moveState.down === 1) {
        $cameraParent.translateY(moveSpeed);
      }

      if (play.grounded && $isLocked && $cameraParent) {
        const grounded: any = $cameraParent
        grounded.position.y = play.eyeHeight
      }

      // dungeon collision (58.1): slide the XZ step along the raster walls
      const rig: any = $cameraParent
      if ($isLocked && rig) {
        const data = dungeonData($globalScene)
        if (data) {
          // same store_mutate trap as the spawn above — mutate the resolved rig
          const c = slideMove(data, beforeX, beforeZ, rig.position.x - beforeX, rig.position.z - beforeZ, 0.3)
          rig.position.x = c.x
          rig.position.z = c.z
        }
      }

    },
    {
      autoInvalidate: false
    }
  )

    export const unlock = () => document.exitPointerLock()
  
    domElement.addEventListener('pointermove', onMouseMove)
    domElement.addEventListener('pointerdown', onCanvasPointerDown)
    domElement.ownerDocument.addEventListener('pointerlockchange', onPointerlockChange)
    domElement.ownerDocument.addEventListener('pointerlockerror', onPointerlockError)
    domElement.ownerDocument.addEventListener( 'keydown', onKeyDown );
    domElement.ownerDocument.addEventListener( 'keyup', onKeyUp );
    window.addEventListener('wheel', onScroll)

    onDestroy(() => {
      domElement.removeEventListener('pointermove', onMouseMove)
      domElement.removeEventListener('pointerdown', onCanvasPointerDown)
      domElement.ownerDocument.removeEventListener('pointerlockchange', onPointerlockChange)
      domElement.ownerDocument.removeEventListener('pointerlockerror', onPointerlockError)
      domElement.ownerDocument.removeEventListener( 'keydown', onKeyDown );
      domElement.ownerDocument.removeEventListener( 'keyup', onKeyUp );
      window.removeEventListener('wheel', onScroll)
    })

    function onScroll( event ) {
      if (!$isLocked) return
      if ($playPointerFree) return // 21-E3: scrolling a menu is not a speed change
      if (!$cameraParent) return
      // 21-B B3: playInteract claims the wheel in CAPTURE phase while carrying
      // something, and says so on the event — never through a one-shot store
      // flag (the twin-Escape lesson)
      if (event.defaultPrevented) return
      moveSpeed = Math.min(1, Math.max(0.01, moveSpeed + (event.deltaY > 0 ? -0.01 : 0.01)))
    }

    function onKeyDown( event ) {
      // 21-E3: keys pressed OVER the menu must not arm movement (the claim gates the
      // task, not this listener, so a held W would resume the instant the menu closed).
      // Escape stays exempt - it is the guaranteed way out, and it EXITS PLAY even with
      // a menu open: Esc is not an activation-triggering event, so an Esc-driven re-lock
      // can be refused by the browser, and "close" is not even expressible for a
      // showWhile-bound screen. Games author a Resume button.
      if ($playPointerFree && event.code !== 'Escape') return
      switch ( event.code ) {
        case 'KeyW': moveState.forward = 1; break;
        case 'KeyS': moveState.backward = 1; break;
        case 'KeyA': moveState.left = 1; break;
        case 'KeyD': moveState.right = 1; break;
        case 'KeyQ': moveState.up = 1; break;
        case 'KeyE': moveState.down = 1; break;
        case 'Escape':
          // native pointer-lock Esc handles the normal case; this also rescues
          // the stuck state where play mode engaged but the lock never did
          if ($isLocked) {
            if (document.pointerLockElement) document.exitPointerLock()
            // 21-E3: with the pointer FREE (menu mode) there is no lock to exit, so this
            // branch is the whole exit path - no pointerlockchange will fire; the camera
            // swap is the camera-follows-isLocked effect, not this handler.
            else $isLocked = false
          }
          break;
      }
    }

    function onKeyUp( event ) {
      switch ( event.code ) {
        case 'KeyW': moveState.forward = 0; break;
        case 'KeyS': moveState.backward = 0; break;
        case 'KeyA': moveState.left = 0; break;
        case 'KeyD': moveState.right = 0; break;
        case 'KeyQ': moveState.up = 0; break;
        case 'KeyE': moveState.down = 0; break;
      }
    }
  
    function onMouseMove(event: MouseEvent) {
      if (!$isLocked) return
      // 21-E3: THE OWNERSHIP GATE this handler always needed. It was gated on $isLocked
      // alone, and movementX/Y are nonzero for ordinary unlocked moves - so with the
      // menu open (pointer free, still playing) mousing over a button would have SPUN
      // THE CAMERA under the menu. Also the correct fence against a lock somebody else
      // owns (module possess locks document.body).
      if (document.pointerLockElement !== domElement) return
      if (!$cameraParent) return
  
      const { movementX, movementY } = event
  
      _euler.setFromQuaternion($cameraParent.quaternion)
  
      _euler.y -= movementX * 0.002 * pointerSpeed
      _euler.x -= movementY * 0.002 * pointerSpeed
  
      _euler.x = Math.max(_PI_2 - maxPolarAngle, Math.min(_PI_2 - minPolarAngle, _euler.x))
  
      $cameraParent.quaternion.setFromEuler(_euler)
  
      onChange()
    }
  
    // threlte's context camera is a runeToCurrentWritable: `current` is a
    // GETTER ONLY, so `camera.current = x` throws "Cannot set property current
    // ... which has only a getter" and the swap never happened (play mode kept
    // rendering the editor camera). Write through .set().
    // `held` also makes this document-level listener ignore locks it does NOT
    // own — anything else that requests pointer lock (module possess with
    // mouseLook) used to yank $isLocked and the camera with it.
    let held = false

    // 21-E3: THE CAMERA FOLLOWS THE STATE, not the lock event. The two camera.set()
    // calls lived inside onPointerlockChange, which is exactly the path that does NOT
    // fire when play exits from the menu substate (Esc with no lock held, or an external
    // stop) - the editor camera never came back. One effect, every exit path covered.
    $effect(() => {
      camera.set($isLocked === true ? $playerCam : $editorCam)
    })

    function onPointerlockChange() {
      if (document.pointerLockElement === domElement) {
        held = true
        $isLocked = true
        // a menu was already up when the lock landed (entering play with a visible
        // menu): hand the release to the menu effect by keeping the substate the boss
        if ($playPointerFree) document.exitPointerLock()
      } else if (held) {
        held = false
        // 21-E3: a lock loss is only an EXIT when the menu substate does not own it.
        // The weld between "lost the lock" and "left play mode" is the single line
        // this branch used to be.
        if ($playPointerFree) return
        $isLocked = false
      }
    }

    // 21-E3: the Firefox fallback - a re-lock without a fresh gesture can be refused,
    // leaving play mode with a visible cursor and no menu. The next click on the canvas
    // IS a gesture, so recapture there. (Chromium allows the gesture-free re-lock after
    // a programmatic exit, so this stays idle.)
    function onCanvasPointerDown() {
      if ($isLocked === true && !$playPointerFree && document.pointerLockElement !== domElement) {
        const again: any = domElement.requestPointerLock({ unadjustedMovement: true })
        again?.catch?.(() => {})
      }
    }
  
    function onPointerlockError() {
      console.error('PointerLockControls: Unable to use Pointer Lock API')
    }
  </script>
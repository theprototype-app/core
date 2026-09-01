<script lang="ts">
    import { onDestroy, untrack } from 'svelte'
    import { get } from 'svelte/store'
    import { Euler, Camera } from 'three'
    import { useThrelte, useParent, useTask } from '@threlte/core'
    import { isLocked, playPointerFree, playerCam, editorCam, globalScene } from '../../stores/sceneStore'
    import { userdata, peers } from '../../stores/appStore'
    import { dungeonData, slideMove, spawnPointFor } from '$lib/dungeonPlay'
    import { resolvePlaySettings } from '$lib/playSettings'
    import { inputClaims, getGamepadAxes } from '$lib/inputRuntime'
    import { gamepadPrefs } from '$lib/gamepadPrefs'
    import { coarsePointer } from '$lib/inputDevice'
    // W4: the touch play controls. A phone had no input path here at all — no pointer
    // lock, no keyboard, no Escape — so the overlay publishes a virtual stick and a look
    // drag, and this component consumes them at the two places it already consumes the
    // pad and the mouse. No second movement pipeline: walk mode, the grounded pin, the
    // dungeon slide and both gates at the top of the task apply to a thumb for free.
    import {
      TOUCH_LOOK_RADIANS_PER_PX,
      touchMove,
      touchLookSpeed,
      drainTouchLook
    } from '$lib/touchControls'
    // 21-E6: the character controller as nodes. A NULL charControl means no
    // charcontroller node exists in any graph, and every branch below then falls
    // through to the code that was always here — that is the parity contract, which is
    // why these reads are guards rather than a rewrite of the movement code.
    import {
      charControl,
      playMoveSpeed,
      setPlayMoveSpeed,
      setJumpRequested,
      tickWalker,
      walkStep
    } from '$lib/charController'

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
    // 21-E5: pad look, radians PER SECOND at sensitivity 1. A stick is a RATE (unlike a
    // mouse delta, which is already a displacement), so it is delta-scaled below.
    const PAD_LOOK_RATE = 2.5
  
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

    // W4: a touch-first device HAS NO POINTER TO LOCK. Chromium on Android answers
    // `requestPointerLock` with a refusal, which the W3 retry then re-asks nine times
    // over its 2.5s window before giving up with a console error — nine requests for a
    // capability the device does not have. The touch overlay is the input path there,
    // so every lock request stands down. Read ONCE: a device does not grow a mouse
    // mid-session, and matchMedia is unavailable during the SSR prerender.
    const noPointerLock = coarsePointer()

    // W4: ONE place the yaw/pitch write lives. It was three near-identical copies (the
    // mouse, the pad in walk mode, the pad while flying) with the same clamp spelled
    // out each time; the touch look is the fourth consumer and the reason to fold them.
    // Callers own the RATE — a stick is radians per second, a drag is radians per pixel.
    const applyLook = (rig: any, dYaw: number, dPitch: number) => {
      _euler.setFromQuaternion(rig.quaternion)
      _euler.y -= dYaw
      _euler.x -= dPitch
      _euler.x = Math.max(_PI_2 - maxPolarAngle, Math.min(_PI_2 - minPolarAngle, _euler.x))
      rig.quaternion.setFromEuler(_euler)
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
          if (!noPointerLock && $isLocked === true && document.pointerLockElement !== domElement) {
            const again: any = domElement.requestPointerLock({ unadjustedMovement: true })
            again?.catch?.(() => {})
          }
        }
      })
    })

    // W3: THE LOCK RETRY. Chromium refuses `requestPointerLock` for roughly a second
    // after a USER-INITIATED Esc exit ("The user has exited the lock before this
    // request was completed"), so a play press made straight after Esc used to enter
    // play mode with no lock and no second attempt. playMode.js paid for that with a
    // flat 2s wall on the BUTTON, which charged every other exit path for a rule only
    // Esc is subject to; the refusal lives here, so the answer does too. Attempt
    // immediately, and on a refusal keep asking on a short beat until the engine
    // relents — a press right after Esc lands in ~1s worst case and instantly
    // otherwise.
    const LOCK_RETRY_STEP = 275
    const LOCK_RETRY_WINDOW = 2500
    let lockRetryTimer: any = null
    // The instant the CURRENT retry window closes, 0 when none is open. This is also
    // the OWNERSHIP FENCE for `onPointerlockError`, mirroring the `held` flag below:
    // an error is not addressed to anybody, so we only ever act on one that arrives
    // inside a window OUR OWN request opened — a module locking document.body and
    // being refused can never make this component ask for the canvas.
    let lockRetryUntil = 0

    function cancelLockRetry() {
      if (lockRetryTimer) clearTimeout(lockRetryTimer)
      lockRetryTimer = null
      lockRetryUntil = 0
    }

    function scheduleLockRetry() {
      if (lockRetryTimer || Date.now() >= lockRetryUntil) return
      lockRetryTimer = setTimeout(() => {
        lockRetryTimer = null
        requestLock(false)
      }, LOCK_RETRY_STEP)
    }

    /**
     * `first` OPENS the retry window; a retry rides the one already open. Store reads
     * go through `get` on purpose — this is called from the $isLocked effect, and an
     * auto-subscription to `$playPointerFree` in here would re-run that effect on every
     * menu toggle and re-request the lock the menu had just released.
     */
    function requestLock(first: boolean) {
      if (noPointerLock) return cancelLockRetry()   // W4: nothing to lock on a touch device
      if (get(isLocked) !== true) return cancelLockRetry()
      if (get(playPointerFree)) return cancelLockRetry()   // 21-E3: the menu owns the pointer
      if (document.pointerLockElement === domElement) return cancelLockRetry()
      // a hidden tab cannot be granted a lock and asking is not free; the next press
      // opens a fresh window
      if (document.visibilityState === 'hidden') return cancelLockRetry()
      if (first) lockRetryUntil = Date.now() + LOCK_RETRY_WINDOW
      // BOTH failure signals, because both exist in the wild: modern Chromium returns a
      // PROMISE that rejects, the older signature returns undefined and only fires
      // `pointerlockerror` on the document. Handling one alone leaves half the engines
      // with the bug this fixes.
      const request: any = domElement.requestPointerLock({ unadjustedMovement: true })
      if (request?.catch) request.catch(() => scheduleLockRetry())
    }

    $effect(() => {
      if ($isLocked) {
        requestLock(true)
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
      } else {
        // left play (or the transient on the way out) — nothing to keep asking for
        cancelLockRetry()
      }
    })

    useTask(
    (delta) => {

      // K-C: a module claimed the keys (possession) — WASD drives IT, not the camera
      if ($inputClaims.includes('keys')) return
      // 21-E3: the menu pause does NOT ride the claim - a text-only PAUSED screen has
      // no focusables, so nothing claims, and the pause must hold anyway.
      if ($playPointerFree) return

      // W4: THE TOUCH LOOK, applied here and not in the overlay so every camera write in
      // play mode stays in this component (and inherits its pitch clamp). A drag is a
      // DISPLACEMENT like a mouse move — radians per PIXEL, never delta-scaled the way a
      // stick is — and it is DRAINED rather than sampled, or the last swipe would keep
      // turning forever. Above the walk return, so it applies in both modes; the rig is
      // the same object either way.
      const lookRig: any = $cameraParent
      if (lookRig && $isLocked === true) {
        const look = drainTouchLook()
        if (look.dx || look.dy) {
          const rate = TOUCH_LOOK_RADIANS_PER_PX * pointerSpeed * $touchLookSpeed
          applyLook(lookRig, look.dx * rate, look.dy * rate)
          onChange()
        }
      }

      // 21-E6: what the graph declared, and the speed actually in force. With no
      // controller node `ctrl` is null and `speed` is this component's own moveSpeed,
      // so the whole block below is byte-for-byte the old behaviour.
      const ctrl = $charControl
      const speed = $playMoveSpeed ?? ctrl?.speed ?? moveSpeed

      // WALK: the node owns Y (gravity, jump, eye height) and resolves the horizontal
      // step against whatever ground tier can answer — including the dungeon raster,
      // so the slide below is its job too and this path returns early.
      //
      // MERGE NOTE (E5 x E6): the walk return sits ABOVE the stick mapping below, so
      // walk mode consumes the pad itself — the MOVE stick folds into the walkStep
      // input and the LOOK stick applies here, or a controller player could not walk
      // or look in the very mode built for them.
      if (ctrl?.mode === 'walk') {
        const walker: any = $cameraParent
        if (walker && $isLocked) {
          const prefs = $gamepadPrefs
          const pad = prefs.enabled ? getGamepadAxes() : { lx: 0, ly: 0, rx: 0, ry: 0 }
          // W4: the touch stick is a SECOND virtual pad — same -1..1 rate, same signs —
          // so it folds into the same two numbers rather than growing a third walk input.
          const touch = $touchMove
          const mX = (prefs.swapSticks ? pad.rx : pad.lx) || touch.x
          const mY = (prefs.swapSticks ? pad.ry : pad.ly) || touch.y
          const padWalkInput = {
            forward: moveState.forward || (mY < -0.01 ? 1 : 0),
            backward: moveState.backward || (mY > 0.01 ? 1 : 0),
            left: moveState.left || (mX < -0.01 ? 1 : 0),
            right: moveState.right || (mX > 0.01 ? 1 : 0)
          }
          tickWalker(walker, ctrl, delta, walkStep(walker, padWalkInput, speed, delta))
          const lX = prefs.swapSticks ? pad.lx : pad.rx
          const lY = prefs.swapSticks ? pad.ly : pad.ry
          if (lX || lY) {
            const rate = PAD_LOOK_RATE * pointerSpeed * prefs.lookSensitivity * delta
            applyLook(walker, lX * rate, (prefs.invertY ? -lY : lY) * rate)
            onChange()
          }
        }
        return
      }

      const beforeX = $cameraParent?.position.x ?? 0
      const beforeZ = $cameraParent?.position.z ?? 0

      if (moveState.forward === 1) {
        $cameraParent.translateZ(-speed);
      }

      if (moveState.backward === 1) {
        $cameraParent.translateZ(speed);
      }

      if (moveState.left === 1) {
        $cameraParent.translateX(-speed);
      }

      if (moveState.right === 1) {
        $cameraParent.translateX(speed);
      }

      // 21-E5: THE DEFAULT PAD MAPPING - left stick moves, right stick looks. On with NO
      // nodes at all, which is the whole point: a pad should work in a scene nobody
      // authored for a pad. E6's controller nodes are what override this per game.
      //
      // The two gates it needs are already at the top of this task, and both are right:
      // the 'keys' claim (a module driving movement owns the sticks too - same role, and
      // a possessed vehicle must not also walk the camera) and playPointerFree (a menu
      // open means the sticks are DEAD, so a player cannot stroll out of their own menu).
      // What it deliberately does NOT require is document.pointerLockElement: a pad has
      // no pointer to lock, and a controller player may be holding no lock at all.
      // Placed BEFORE the grounded pin and the dungeon slide below, so stick movement
      // inherits eye height and wall collision without a second implementation.
      const padPrefs = $gamepadPrefs
      // W4: the pad's master switch gates THE PAD, never the touch stick — which is why
      // the enabled test moved off this `if` and onto the snapshot below. A phone has no
      // gamepad prefs to go and find, and switching the pad off in Settings must not
      // take the only movement control on the device with it.
      if ($isLocked === true && $cameraParent) {
        // the deadzone is already applied in the snapshot - that one is the DEVICE's dead
        // centre (Settings > Input), not a game threshold
        const pad = padPrefs.enabled ? getGamepadAxes() : { lx: 0, ly: 0, rx: 0, ry: 0 }
        const touch = $touchMove
        const moveX = (padPrefs.swapSticks ? pad.rx : pad.lx) || touch.x
        const moveY = (padPrefs.swapSticks ? pad.ry : pad.ly) || touch.y
        const lookX = padPrefs.swapSticks ? pad.lx : pad.rx
        const lookY = padPrefs.swapSticks ? pad.ly : pad.ry
        if (moveX || moveY) {
          // stick forward reads NEGATIVE on the standard mapping and forward is -Z, so the
          // vertical axis feeds translateZ directly. Scaled by moveSpeed PER FRAME exactly
          // like the WASD steps above: delta-scaling the stick but not the keys would make
          // the same scene move at two different speeds depending on the device.
          $cameraParent.translateX(moveX * moveSpeed)
          $cameraParent.translateZ(moveY * moveSpeed)
        }
        if (lookX || lookY) {
          const rate = PAD_LOOK_RATE * pointerSpeed * padPrefs.lookSensitivity * delta
          // push the stick UP (negative) to look UP, the console default; invertY flips it
          applyLook($cameraParent, lookX * rate, (padPrefs.invertY ? -lookY : lookY) * rate)
        }
        if (moveX || moveY || lookX || lookY) onChange()
      }

      // 21-B B3 (DEVX #14): a GROUNDED scene has no Q/E flight and pins the rig
      // to eye height, so a module no longer has to swallow those keys itself.
      const play = resolvePlaySettings($globalScene)

      if (!play.grounded && moveState.up === 1) {
        $cameraParent.translateY(-speed);
      }

      if (!play.grounded && moveState.down === 1) {
        $cameraParent.translateY(speed);
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
      cancelLockRetry()
    })

    function onScroll( event ) {
      if (!$isLocked) return
      if ($playPointerFree) return // 21-E3: scrolling a menu is not a speed change
      if (!$cameraParent) return
      // 21-B B3: playInteract claims the wheel in CAPTURE phase while carrying
      // something, and says so on the event — never through a one-shot store
      // flag (the twin-Escape lesson)
      if (event.defaultPrevented) return
      const step = event.deltaY > 0 ? -0.01 : 0.01
      // 21-E6: while a controller is declared the wheel writes THROUGH the store, so
      // scroll still adjusts speed AND the graph can read it (a Move Speed node) or
      // overwrite it (a keypress -> Move Speed(set)). With no controller it stays this
      // component's own local number, exactly as before — the parity contract.
      if ($charControl) {
        const current = $playMoveSpeed ?? $charControl.speed ?? moveSpeed
        setPlayMoveSpeed(Math.min(1, Math.max(0.01, current + step)))
        return
      }
      moveSpeed = Math.min(1, Math.max(0.01, moveSpeed + step))
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
        case 'Space':
          // 21-E6: jump. The EDGE is taken inside charController (a browser repeats
          // keydown while a key is held, so a held Space must still be one jump).
          //
          // Deliberately NOT preventDefault'd, and the collision is already arbitrated:
          // a HUD screen claims keys through its own play-only window-CAPTURE handler,
          // which stopImmediatePropagation()s while a screen is up — so a menu wins over
          // a jump, which is the right precedence. Nothing here consumes Escape either.
          if ($charControl?.mode === 'walk') setJumpRequested(true)
          break;
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
        // released UNCONDITIONALLY, whatever the mode is now — the push-to-talk lesson:
        // a mode switch or a modifier mid-hold must never strand the flag down
        case 'Space': setJumpRequested(false); break;
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

      applyLook($cameraParent, movementX * 0.002 * pointerSpeed, movementY * 0.002 * pointerSpeed)

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
        cancelLockRetry()   // W3: it landed
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
      if (noPointerLock) return   // W4: a touch tap is the look/interact gesture, not a re-lock
      if ($isLocked === true && !$playPointerFree && document.pointerLockElement !== domElement) {
        const again: any = domElement.requestPointerLock({ unadjustedMovement: true })
        again?.catch?.(() => {})
      }
    }
  
    function onPointerlockError() {
      // W3: the OLD-SIGNATURE failure signal (no promise to reject). Not addressed to
      // anybody, so `lockRetryUntil` decides whether it was ours — see requestLock.
      // A refusal inside our own window is the expected post-Esc case and not worth a
      // console error; anything else still is.
      if (Date.now() < lockRetryUntil) {
        scheduleLockRetry()
        return
      }
      console.error('PointerLockControls: Unable to use Pointer Lock API')
    }
  </script>
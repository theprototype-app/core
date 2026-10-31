# Pixling fixture (roadmap 66 S4b, lane 66-import)

Rendered for real on the Deck with Pixling 0.3.1 (MIT, https://github.com/trinity-works/pixling), the
recipe in docs "Generate pixel art with Pixling and Claude Code":

    uv tool install pixling==0.3.1
    pixling new hero knight                       # specs/knight.json, from Pixling's own MIT example spec
    pixling build specs/knight.json --clips walk --dirs S,E,N,W

- `knight_walk.png` — `out/knight/knight_walk.png`: 1024×192, 16 frames × 4 directions of 64×48 px (rows S, E, N, W)
- `knight.pixling.json` — the input spec (`specs/knight.json`), what `import_file` stores beside the sheet
- `knight_walk.sheet.json` — Pixling's frame data for the sheet (`out/knight/knight.json`)

Re-running the build gives a byte-identical PNG (asserted in the lane evidence, pixling-determinism.txt).

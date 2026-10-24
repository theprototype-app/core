# Attribution — "files from the wild" import fixtures

The models the `import-wild` e2e suite loads are NOT in this repository. `manifest.json` here names each one
(its path in the dataset, its sha256, its Hugging Face URL and why it is in the set), and
`node scripts/fetch-wild-assets.cjs` puts them in a local cache (`~/.cache/tp-wild/assets` or `$WILD_ASSETS_DIR`).

They come from the **Scenario 3D Collection** — https://huggingface.co/datasets/scenario-labs/3d-collection —
by **Scenario**, licensed **CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/). The models are AI-generated
outputs of several third-party generators (Meshy, Rodin, TRELLIS, Tripo, Hitem / Sparc3D, Direct3D-S2, PartCrafter,
SAM 3D, Pixal3D, YVO3D, ReconViaGen, GPT / Claude scene builders); the manifest names the generator of each.

They are test inputs only: never ship them in packs, templates, the Asset Browser or any export, and never
commit them. No file was modified; the suite imports each one as it is.

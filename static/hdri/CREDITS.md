# Bundled HDRIs

All five are **CC0** (public domain) from [Poly Haven](https://polyhaven.com/hdris), at their 1k size
(1024×512 Radiance RGBE), unmodified. The `.png` cards here are tone-mapped previews baked by
`scripts/hdri-bake.cjs`.

Since roadmap 59 (T3) the `.hdr` files themselves are NOT in the app: they live in the packs repo's
[`hdri/`](https://github.com/theprototype-app/packs/tree/main/hdri) folder and download the first time a
sky is picked (the ref-pinned jsDelivr mirror, kept in the browser's Cache Storage). An exported game
still carries the one sky its scene uses.

| preset | file | Poly Haven asset | author(s) |
|---|---|---|---|
| Clear sky | `kloofendal_48d_partly_cloudy_puresky_1k.hdr` | [Kloofendal 48d Partly Cloudy (Pure Sky)](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | Greg Zaal, Jarod Guest |
| Meadow | `meadow_2_1k.hdr` | [Meadow 2](https://polyhaven.com/a/meadow_2) | Sergej Majboroda |
| Sunrise | `spruit_sunrise_1k.hdr` | [Spruit Sunrise](https://polyhaven.com/a/spruit_sunrise) | Greg Zaal |
| Starlight | `dikhololo_night_1k.hdr` | [Dikhololo Night](https://polyhaven.com/a/dikhololo_night) | Greg Zaal |
| Photo studio | `studio_small_09_1k.hdr` | [Studio Small 09](https://polyhaven.com/a/studio_small_09) | Sergej Majboroda |

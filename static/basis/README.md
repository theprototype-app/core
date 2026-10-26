# Basis Universal GPU Texture Compression

Basis Universal is a "[supercompressed](http://gamma.cs.unc.edu/GST/gst.pdf)"
GPU texture and texture video compression system that outputs a highly
compressed intermediate file format (.basis) that can be quickly transcoded to
a wide variety of GPU texture compression formats.

[GitHub](https://github.com/BinomialLLC/basis_universal)

## Transcoders

Basis Universal texture data may be used in two different file formats:
`.basis` and `.ktx2`, where `ktx2` is a standardized wrapper around basis texture data.

For further documentation about the Basis compressor and transcoder, refer to
the [Basis GitHub repository](https://github.com/BinomialLLC/basis_universal).

The folder contains two files required for transcoding `.basis` or `.ktx2` textures:

* `basis_transcoder.js` — JavaScript wrapper for the WebAssembly transcoder.
* `basis_transcoder.wasm` — WebAssembly transcoder.

Both are dependencies of `KTX2Loader`:

```js
const ktx2Loader = new KTX2Loader();
ktx2Loader.detectSupport( renderer );
ktx2Loader.load( 'diffuse.ktx2', function ( texture ) {

	const material = new THREE.MeshStandardMaterial( { map: texture } );

}, function () {

	console.log( 'onProgress' );

}, function ( e ) {

	console.error( e );

} );
```

## This copy: rebuilt without `eval` (theprototype.app)

**Do not replace these two files with three.js's `examples/jsm/libs/basis` copy.** three ships
basis_universal's prebuilt transcoder as-is, and its embind glue builds functions from strings
(`newFunc(Function, args)` in `craftInvokerFunction`, the emval method caller, and
`Function("return this")`). The app's Content-Security-Policy has no `'unsafe-eval'`
(`csp.config.js`), and KTX2Loader runs the transcoder in a `blob:` worker, which inherits that
policy — so with three's copy every KTX2 texture fails with an `EvalError` and never transcodes.

These files are the same source with the same flags, plus `-s DYNAMIC_EXECUTION=0 -s EMBIND_AOT=1`
(the opt-in `NO_DYNAMIC_EXECUTION` build basis_universal added in commit
[b15211474d](https://github.com/BinomialLLC/basis_universal/commit/b15211474d), issue
[#464](https://github.com/BinomialLLC/basis_universal/issues/464); its prebuilt files stay the
eval build, and three closed [mrdoob/three.js#34389](https://github.com/mrdoob/three.js/issues/34389)
as "we ship the upstream build as-is").

|                         | three's copy (three 0.186.1)                                                                                                        | this copy                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| source                  | [basis_universal `v1_50_0`](https://github.com/BinomialLLC/basis_universal/tree/v1_50_0) `051ad6d8a64bb95a79e8601c317055fd1782ad3e` | same                                                                                              |
| toolchain               | Emscripten 3.1.64                                                                                                                   | same (pinned)                                                                                     |
| `basis_transcoder.js`   | 57,529 B (15,060 gzip), sha256 `8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1`                                   | 66,534 B (15,501 gzip), sha256 `431732faf3cc08296104029ca41f4c3ebbe849edd1fbe9b0a36389f8ad82f0ac` |
| `basis_transcoder.wasm` | 527,333 B, sha256 `6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a`                                                | byte-identical                                                                                    |

The API is unchanged (same C++ bindings, same wasm); only the JS glue differs, and `EMBIND_AOT`
generates the invokers at build time, so calls are as fast as before.

**Rebuild:** `bash scripts/build-basis-transcoder.sh` (needs git + python3; installs Emscripten
into `~/.local/emsdk` when it is missing — no cmake/make, the script runs the commands CMake
generates). `--reference` builds the stock flags instead and reproduces three's two files byte for
byte (both sha256s above), which is the check that the toolchain is right. ~1 s for the toolchain
once installed (a first install downloads ~1.3 GB and takes 2-4 min), ~10 s to compile and link.

**When three.js updates its transcoder** (a new basis_universal version): set `BASISU_TAG`,
`BASISU_COMMIT` and `EMSCRIPTEN_VERSION` in the script to what three used, run `--reference` until it
matches three's files, then run it without the flag and update this table. Newer basis_universal
versions have `-DNO_DYNAMIC_EXECUTION=ON` in their own CMakeLists. `tests/unit/basisNoEval.test.js`
fails if any script under `static/` names `eval` or the `Function` constructor, so a plain copy of
three's files cannot slip back in.

## License

[Apache License 2.0](https://github.com/BinomialLLC/basis_universal/blob/master/LICENSE)

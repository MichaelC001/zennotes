/**
 * The one module that imports D2 (d2lang.com), reached only through the
 * `import()` in `d2-render`.
 *
 * It exists so the renderer's async chunk carries a name of ours,
 * `d2-runtime-*.js`: the browser build of `@terrastruct/d2` is one file of
 * about 8 MB with the compiler's WebAssembly inside it, and the perf harness
 * and the packaged-web browser test assert that this chunk is not fetched
 * before a note needs a D2 diagram.
 */
export { D2 } from '@terrastruct/d2'

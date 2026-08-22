import opencv from '@techstark/opencv-js'

/**
 * OpenCV.js loads a WebAssembly module, so `cv` is not usable the instant the
 * import resolves. Everything that touches it waits here, once per context.
 *
 * The build signals readiness in an easily-missed way: its exports object is
 * itself a **thenable** that resolves to the initialised namespace. It has no
 * usable `Mat` before then, and `onRuntimeInitialized` never fires — so the way
 * to wait is to await the module object itself. That thenable is also why the
 * module must be default-imported rather than imported as a namespace: a module
 * namespace carrying a `then` export makes the loader treat the module as a
 * promise and fail with "Promise.prototype.then called on incompatible
 * receiver".
 */
export type OpenCv = typeof opencv

let ready: Promise<OpenCv> | null = null

export function openCvReady(): Promise<OpenCv> {
  // The typings describe the resolved namespace, not the thenable wrapper.
  ready ??= Promise.resolve(opencv as unknown as PromiseLike<OpenCv>)
  return ready
}

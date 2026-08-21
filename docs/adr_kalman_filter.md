# ADR: Kalman filtering for disc flight tracking

- **Status:** accepted, partially implemented
- **Scope:** the tracking stage that turns per-frame colour detections into a flight path
- **Supersedes:** nothing
- **Related:** the ego-motion decision is deliberately deferred; see [PR 2](#pr-2-ego-motion-compensation)

## Context

The colour picker gives us a `DiscColorModel` — a handful of weighted colour modes describing one
disc. Thresholding a frame against it produces candidate blobs, and the largest plausible blob's
centroid is a position measurement. Those raw measurements are not a flight path:

- **Frames go missing.** The disc passes behind a tree, or motion blur smears it until no pixel
  matches the model closely enough. A path drawn straight from measurements has holes.
- **Measurements jitter.** A blob's centroid moves a pixel or two frame to frame from compression
  noise and partial blur, so a raw polyline looks frayed rather than like a thrown object.
- **Wrong blobs appear.** A bright shirt, a patch of sky, or a second disc on the ground can all
  produce a larger blob than the disc in flight.

A disc in flight is a strongly constrained object — it does not teleport, and between two frames
33 ms apart it barely deviates from a straight line. A Kalman filter is the standard way to
exploit that: hold a belief about position *and velocity*, predict forward with a motion model,
and weigh each new measurement against the prediction according to how much each is trusted.

## Decision

Use a **4-state linear Kalman filter with a constant-velocity-plus-drag motion model**,
hand-written rather than `cv.KalmanFilter`, operating in the pixel coordinates of the downscaled
analysis frame.

### State and matrices

State is position and velocity in the image plane:

```
x = [ px  py  vx  vy ]ᵀ
```

Transition. Position advances by velocity; velocity decays by the drag factor `k`:

```
        ⎡ 1  0  dt  0 ⎤
F   =   ⎢ 0  1  0  dt ⎥
        ⎢ 0  0  k   0 ⎥
        ⎣ 0  0  0   k ⎦
```

Measurement. The detector sees position only — velocity is inferred, never observed:

```
H   =   ⎡ 1  0  0  0 ⎤
        ⎣ 0  1  0  0 ⎦
```

Noise covariances are diagonal: `Q = diag(q_p, q_p, q_v, q_v)` for the motion model and
`R = diag(r, r)` for the measurement. The usual recursion applies — predict
`x ← Fx`, `P ← FPFᵀ + Q`; update with innovation `y = z − Hx`, `S = HPHᵀ + R`,
`K = PHᵀS⁻¹`, `x ← x + Ky`, `P ← (I − KH)P`.

`S` is 2×2, so its inverse is closed-form. No matrix library is needed and none is added.

### Why not `cv.KalmanFilter`

OpenCV.js is a dependency of this project, so this is not about avoiding it. It is about fit:
`cv.KalmanFilter` is Mat-based with no typed accessors, and the two customisations below —
rewriting `F` for drag and inflating `P` mid-update on a gate trip — mean reaching into matrix
internals every frame. Hand-written 4×4 algebra is about a hundred lines, is exactly typed, and
unit-tests in microseconds without a WASM runtime. **OpenCV does the image processing; the state
estimator, which we are modifying, stays native.**

## Assumptions

These are the claims the filter's correctness rests on. They are listed so they can be argued
with, and several are known to be wrong in ways that are currently acceptable.

1. **Motion is locally linear.** Over one frame period the disc's path is approximated by a
   straight line. At 29.97 fps that is 33 ms, over which a disc travelling 20 m/s moves ~0.7 m —
   curvature across that span is small.
2. **Drag is linear per frame.** Velocity is multiplied by `k` each step. Real aerodynamic drag
   scales with roughly the square of velocity, so this under-brakes a fast disc and over-brakes a
   slow one. It is a one-coefficient approximation chosen because it keeps the filter linear.
3. **There is no acceleration term at all — gravity is not modelled.** This is the largest
   modelling gap. The filter has no notion that a disc arcs downward, so all curvature in the
   output comes from measurements pulling the estimate around. On a clean throw with good
   detection this is fine; through a long occlusion the coast will run straight when the real disc
   was falling. Fixing this properly means either a constant-acceleration control input or a
   6-state filter, and is deliberately out of scope.
4. **`dt` is uniform**, taken from the clip's frame rate. For the committed fixtures that is
   `1001/30000 ≈ 0.033367 s` — **not** 1/60. A batch pass over decoded frames genuinely has
   uniform spacing, so this assumption is exact here in a way it would not be for live capture
   with dropped frames.
5. **One disc.** No multi-target data association. A second disc in frame is a distractor to be
   rejected, not a second track.
6. **Coordinates are screen space.** The model describes motion *as seen by the camera*. A static
   camera makes this equivalent to world motion up to projection; **a panning camera breaks it
   outright**, which is the whole subject of PR 2.
7. **Measurement error is zero-mean and roughly isotropic.** Motion blur violates this — a blurred
   disc's centroid is biased along the direction of travel — but the bias is small relative to the
   blob and is not modelled.
8. **Units are isotropic.** The filter works in pixels of the analysis frame, and normalises by
   frame *width* on both axes only at the protocol boundary. Normalising each axis by its own
   extent would make a pixel of vertical motion a different quantity from a pixel of horizontal
   motion, quietly distorting the velocity model on any non-square frame.

## Strategy

Per frame, in order:

1. **Predict.** Advance the state before looking at the image, giving a prior position to
   associate against.
2. **Measure.** Threshold to a mask, open it to drop speckle, find contours, discard those below a
   minimum area, take each survivor's centroid.
3. **Associate.** Choose the candidate **nearest the prediction** once a track exists; fall back to
   the largest above the area floor when it does not. Taking the largest blob unconditionally is
   what lets a bright shirt or a sky patch steal the track mid-flight.
4. **Gate.** Compute the Mahalanobis distance `d² = yᵀS⁻¹y` of the chosen measurement. Below the
   threshold it is a normal update. Above it, the measurement is wildly inconsistent with the
   physics — which is what a tree strike looks like — so inflate `P` for that frame, raising the
   gain and letting the state snap toward the measurement instead of gliding past it.
5. **Correct, or coast.** With an accepted measurement, run the update. With none, keep the
   prediction and let `P` grow, which widens the association gate on subsequent frames and makes
   re-acquisition easier. After a run of consecutive misses, declare the track lost rather than
   extrapolating indefinitely.

### An honest note on the gate

Inflating process noise on a suspected tree hit **does not make the filter trust the measurement
100%**. It drives the Kalman gain *toward* 1, so the state moves most of the way to the
measurement while retaining some inertia. That is usually the desired behaviour — a single spurious
blob should not fully capture the track. If a genuine hard reset is wanted, that is a different
mechanism: reinitialise the state at the measurement with a large covariance. We are not doing
that yet, and this ADR should be revisited if bounce recovery proves too sluggish.

## Tuning parameters

Values below are **starting points to be tuned against the fixtures**, not derived constants. Each
row names the symptom that means it needs changing.

| Parameter | Default | Reasoning | Symptom it is wrong |
|---|---|---|---|
| `r` (measurement variance) | 4 px² (σ≈2 px) | A colour blob's centroid is good to a pixel or two at 640-wide | Too low: path chases jitter. Too high: path lags the disc |
| `q_p` (position process noise) | 0.25 px² | Position is well described by the model; most uncertainty belongs to velocity | Rarely needs changing |
| `q_v` (velocity process noise) | 25 (px/s)² | Absorbs the unmodelled acceleration from assumption 3 | Too low: filter refuses to follow real curvature |
| `k` (drag) | 0.995 per frame | ≈14% velocity loss per second at 29.97 fps | Coast during occlusion overshoots or stalls |
| gate threshold | 9.21 | χ² at 99% for 2 degrees of freedom | Too low: normal blur trips it. Too high: tree hits are ignored |
| `P` inflation on gate trip | ×100 | Large enough to push the gain near 1 | Bounce recovery sluggish, or track too twitchy |
| max consecutive misses | 15 frames (~0.5 s) | Long enough to cross a tree, short enough to abandon a lost disc | Track dies mid-flight, or ghosts on after the disc has landed |
| min contour area | 12 px at 640 width | Below this a blob is compression noise | Disc missed when distant, or noise tracked |

## Two OpenCV pitfalls, recorded so they are not rediscovered

1. **OpenCV's HSV scale is not ours.** For 8-bit images OpenCV uses **H ∈ 0..179, S,V ∈ 0..255**,
   while `src/video/hsv.ts` produces H ∈ 0..360 and S,V ∈ 0..1. Bounds must be converted (`h/2`,
   `s*255`, `v*255`). Getting it wrong yields a silently empty or absurdly permissive mask rather
   than an error.
2. **A hue band crossing 0/179 needs two ranges OR'd together.** Orange sits near the wrap point
   — the fixture disc is at hue 27° (13.5 in OpenCV units) — so a tolerance band around a red-orange
   disc will straddle it. `modeToHsvBounds` therefore returns one *or two* ranges.

## Known divergence: the picker and the detector disagree

The picker's preview is computed with `hsvDistance`, which uses saturation-gated hue and a
chroma-adaptive lightness weight. The detector uses axis-aligned `inRange` boxes, which cannot
express either. **The cutout a user sees when picking is therefore not exactly the mask detection
will use** — the box is a coarser, more permissive approximation.

This is a deliberate trade for OpenCV-native throughput, and it is a difference to explain in the
UI rather than to treat as a bug. The mask is the interface boundary, so if selection quality
regresses noticeably the fallback is a one-function swap: build the mask with `hsvDistance` and
hand it to OpenCV for morphology and contours.

## PR 2: ego-motion compensation

Screen-space tracking (assumption 6) fails on a panning camera. In `throw-03-flight-pan.mp4` the
operator follows the disc, so the disc is nearly *stationary* in frame while the world slides past
— a constant-velocity model there describes the camera, not the disc, and the drawn path is a
squiggle rather than an arc.

The intended fix is to estimate background motion between frames and apply the inverse transform
**to the filter state**, not to the image. Warping a megapixel per frame to keep the state still is
backwards; transforming four numbers costs nothing.

**Open decision, to be settled with measurements rather than in advance:**

- **Full 4-DOF partial affine** (pan, rotation, uniform scale) via `goodFeaturesToTrack` +
  `calcOpticalFlowPyrLK` + `estimateAffinePartial2D`. Most capable; OpenCV.js already present, and
  pyramidal Lucas-Kanade with a robust affine fit is emphatically not something to hand-roll.
- **Translation only**, via integral projections or phase correlation on a downscaled grayscale
  frame. Roughly 60 lines and no new machinery. Rotation and zoom are the expensive degrees of
  freedom to recover, and for a handheld follow-pan they may simply not be needed.

Performance guidance to carry forward, should the first option win: keep the flow **sparse, never
dense** — Farneback computes every pixel and is not viable here; **downscale hard** first (240p is
ample for global camera motion); **reuse tracked points** across frames and only re-run corner
detection when survivors fall below a floor; and **trim `winSize` and `maxLevel`** downward, since
smaller windows and shallower pyramids trade large-motion robustness for speed. Note also that the
current design is a *batch* pass, not realtime playback, so the binding constraint is total
wall-clock rather than a per-frame budget — which makes the expensive option more affordable here
than it would be live.

## Alternatives considered

- **`cv.KalmanFilter`** — rejected above on fit, not size.
- **No filter, raw detections only** — rejected: leaves holes at every occluded frame and a frayed
  path, which is most of what makes a trace look wrong.
- **Particle filter** — handles multi-modal belief and non-linear dynamics, but a single rigid
  target with a decent colour model does not need it, and it is far harder to reason about.
- **6-state constant-acceleration filter** — the natural answer to assumption 3, and the most
  likely successor to this decision once gravity or lift matters.

## When to revisit

- Bounce recovery is too slow → reconsider hard state reset instead of `P` inflation.
- Coasted segments visibly run straight where the disc fell → add gravity, or move to 6 states.
- The path is right on static shots and wrong on pans → that is PR 2, as expected.
- Selection quality regresses against the picker's preview → swap the mask source, as above.

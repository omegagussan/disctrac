# Fixture attribution and licensing

The clips in `fixtures/video/` are **not** covered by this repository's code licence.
They are derivative works of a Creative Commons video and carry their own terms, set
out below. Read this before adding, replacing, or redistributing any fixture.

## Source

| | |
|---|---|
| Title | *Eric Wu and Scott Schiller playing disc golf at DeLaveaga* |
| Author | Scott Schiller |
| Original | https://flickr.com/photos/schill/4807664532/ |
| Via | https://commons.wikimedia.org/wiki/File:Eric_Wu_and_Scott_Schiller_playing_disc_golf_at_DeLaveaga.webm |
| Licence | Creative Commons Attribution-ShareAlike 2.0 Generic (CC BY-SA 2.0) |
| Licence text | https://creativecommons.org/licenses/by-sa/2.0/ |

## Changes made

CC BY-SA requires that modifications be indicated. All three clips were derived from
the single 82-second source above by:

- trimming to a 11–12 second window (see the table below for each clip's window),
- transcoding VP9/WebM to H.264/MP4 (`-crf 23`, `yuv420p`, High profile, `+faststart`),
- discarding the audio track (`-an`).

No frames were altered, retimed, or composited.

## Licence of these clips

Because the source is ShareAlike, **these trimmed clips are themselves licensed
CC BY-SA 2.0**, and anyone redistributing them must carry this attribution forward.
This obligation attaches to the video files only — it does not extend to the
application source code, which is a separate work that merely reads them.

## Clips

| File | Source window | What it shows | Why it's useful |
|---|---|---|---|
| `throw-01-wooded-tee.mp4` | 2s–14s | Wooded tee, white disc handled at close range, throw motion around 7–8s | Hardest lighting case: heavy dappled shade and a low-contrast disc against dirt |
| `throw-02-field-release.mp4` | 32s–43s | Open grass field, clear release of an orange disc at ~36s | Cleanest case: saturated disc against uniform dry grass |
| `throw-03-flight-pan.mp4` | 43s–55s | Wide fairway throw, camera pans to follow the disc against sky | Tests tracking through fast camera motion, with the disc small and airborne |

All three are 1280x720 at 30000/1001 fps.

## Reproducing the clips

The source is not committed. To regenerate from scratch:

```sh
curl -L -o source.webm \
  https://upload.wikimedia.org/wikipedia/commons/d/d9/Eric_Wu_and_Scott_Schiller_playing_disc_golf_at_DeLaveaga.webm

for spec in "2 12 throw-01-wooded-tee" "32 11 throw-02-field-release" "43 12 throw-03-flight-pan"; do
  set -- $spec
  ffmpeg -ss "$1" -t "$2" -i source.webm \
    -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -profile:v high -level 4.0 \
    -movflags +faststart -an "fixtures/video/$3.mp4"
done
```

## Extracted frames

`fixtures/frames/throw-02/` holds single frames pulled from `throw-02-field-release.mp4` and
scaled to 640x360, committed so the detection tests can run against real pixels without needing
ffmpeg at test time. They are **further derivatives of the same CC BY-SA 2.0 source** and carry
exactly the same obligations as the clips above.

`fixtures/truth/throw-02-field-release.json` records where the disc actually is in those frames,
annotated by hand. The annotation is our own work and describes the footage rather than
reproducing it; the frames it points at remain CC BY-SA 2.0.

## Adding new fixtures

Only add footage that is yours or is licensed for redistribution — this repository is
public, so committing a file publishes it. Record the source, author, licence, and the
changes you made in the table above.

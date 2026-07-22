# ascii-tv

Turn any `<video>` into **realtime colored ASCII** on a canvas, warped like a
CRT tube. Framework-free, zero deps — one WebGL pass does the whole thing.

The video is decoded live to a GL texture every frame. The ASCII mapping runs
in the fragment shader: each screen cell samples the video's luminance, picks a
glyph from a baked monospace atlas, and tints it by the source pixel color. The
same pass adds the tube look — fisheye barrel, a mouse-warp trail, chromatic
aberration, glyph glow, scanlines, vignette, a power-on flash — and scroll zoom.

No precompute step, no baked asset, any-length clip, interactive.

## Run the example

```sh
./serve.sh                 # sample.mp4 on http://localhost:8000
./serve.sh myclip.mp4      # a different clip (must be in this folder)
./serve.sh myclip.mp4 9000 # custom port
```

Serves the folder and opens the browser at `index.html?v=<video>`. http:// is
required — ES modules and the `<video>` texture upload both refuse `file://`.
The demo: move the mouse over the tube to warp it, scroll to zoom.

## Integrate into a site

```html
<canvas id="tv"></canvas>
<script type="module">
  import { mountAsciiPlayer } from "./ascii-player.js";
  mountAsciiPlayer(document.getElementById("tv"), "clip.mp4");
</script>
```

Copy `ascii-player.js` and point it at any same-origin (or CORS-enabled) video.
`mountAsciiPlayer(canvas, videoSrc, opts)` returns `{ video }`.

### Options

Every key is an `opts` field with the default shown — physical CRT knobs, tune
to taste.

| Key | Default | What |
|---|---|---|
| `internalW` | `1024` | internal render width in px; height follows video aspect |
| `cell` | `6` | glyph cell size in px (smaller = denser ASCII) |
| `contrast` | `1.15` | luminance contrast before glyph pick |
| `brightness` | `0.0` | additive luminance, `-1..1` |
| `fisheye` | `0.18` | barrel bulge strength |
| `mouseRadius` | `120` | px falloff of the mouse warp |
| `mouseStrength` | `34` | px displacement at the cursor |
| `trailDecay` | `0.9` | per-frame decay of the warp trail |
| `chroma` | `2.0` | px RGB split (chromatic aberration) |
| `glow` | `0.5` | additive glyph glow |
| `scanline` | `0.14` | scanline depth |
| `vignette` | `0.35` | corner darkening |
| `zoomPerScroll` | `0.25` | extra zoom at full page scroll |
| `glyphChars` | `@#W$9876543210?!abc;:+=-,._` | dense→sparse ramp (index 0 = darkest pixel) |
| `background` | `#000000` | clear color behind the tube |

## Notes

- **CORS**: cross-origin video needs `Access-Control-Allow-Origin` or the
  texture upload taints and fails. Same-origin is simplest.
- **Autoplay**: muted + `playsInline` so browsers allow it; a user gesture may
  still be required on some mobile setups.
- **Glow** is a cheap same-cell additive, not multi-pass bloom. Swap in a blur
  framebuffer if you want a real halo.

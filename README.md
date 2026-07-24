# ascii-tv

Turn any `<video>` into **realtime colored ASCII** on a canvas, warped like a
CRT tube. Framework-free, zero deps — one WebGL pass does the whole thing.

**[Live demo →](https://jjsnack.github.io/ascii-tv/)**

The video is decoded live to a GL texture every frame. The ASCII mapping runs
in the fragment shader: each screen cell samples the video's luminance, picks a
glyph from a baked monospace atlas, and tints it by the source pixel color. The
same pass adds the tube look — fisheye barrel, a mouse-warp trail, chromatic
aberration, glyph glow, scanlines, vignette, a power-on flash.

Scroll grows the canvas from a small centered tube to a near-full-viewport
rectangle (the glyph grid gains cells — it doesn't magnify), and the video fits
contained at the top, cover-cropped by the bottom. As it grows the fisheye and a
soft edge fade both ramp out, so the end frame is a flat, padded rectangle. Press
**P** for raw pixel blocks.

No precompute step, no baked asset, any-length clip, interactive.

## Run the example

```sh
./serve.sh                 # sample.mp4 on http://localhost:8000
./serve.sh myclip.mp4      # a different clip (must be in this folder)
./serve.sh myclip.mp4 9000 # custom port
```

Serves the folder and opens the browser at `index.html?v=<video>`. http:// is
required — ES modules and the `<video>` texture upload both refuse `file://`.
The demo: move the mouse to warp the tube, scroll to grow it, press **P** for
pixels.

## Integrate into a site

Copy `ascii-player.js`, point it at any same-origin (or CORS-enabled) video:

```html
<canvas id="tv"></canvas>
<script type="module">
  import { mountAsciiPlayer } from "./ascii-player.js";
  mountAsciiPlayer(document.getElementById("tv"), "clip.mp4");
</script>
```

`mountAsciiPlayer(canvas, videoSrc, opts)` returns `{ video }`. The scroll-grow
effect needs a bit of page setup (fixed canvas + a tall scroll region) —
see **[INTEGRATION.md](INTEGRATION.md)** for the full copy-paste.

### Options

Every key is an `opts` field with the default shown — tune to taste.

| Key | Default | What |
|---|---|---|
| `cell` | `12` | glyph cell size in internal px (bigger = chunkier, fewer cells) |
| `glyphFill` | `1.15` | glyph size vs cell (higher = less black between glyphs) |
| `glyphChars` | `@#W$9876543210?!abc;:+=-,._` | dense→sparse ramp (index 0 = darkest pixel) |
| `contrast` | `1.15` | luminance contrast before glyph pick |
| `brightness` | `0.12` | additive luminance, `-1..1` |
| `fisheye` | `0.25` | horizontal barrel bulge |
| `fisheyeY` | `0.55` | vertical bulge (top/bottom edges) |
| `mouseRadius` | `110` | px falloff of the mouse warp (scales with box size) |
| `mouseStrength` | `15` | px displacement at the cursor (scales with box size) |
| `chroma` | `2.0` | px RGB split (chromatic aberration) |
| `glow` | `0.7` | additive glyph glow |
| `scanline` | `0.14` | scanline depth |
| `vignette` | `0.35` | corner darkening |
| `edgeFade` | `0.18` | width of the top/bottom fade-into-background border (viewport fraction); fades out as it zooms in |
| `edgeFadeX` | `0.07` | width of the left/right fade (viewport fraction); smaller = less blur on the sides |
| `growStart` | `0.42` | viewport fraction the tube fills before scrolling |
| `growEnd` | `0.9` | viewport fraction it grows to when fully scrolled (< 1 leaves side padding) |
| `dprCap` | `2` | devicePixelRatio clamp (caps render cost on retina) |
| `background` | `#000000` | clear color behind the tube |

## Notes

- **CORS**: cross-origin video needs `Access-Control-Allow-Origin` or the
  texture upload taints and fails. Same-origin is simplest.
- **Autoplay**: muted + `playsInline` so browsers allow it; a user gesture may
  still be required on some mobile setups.
- **Glow** is a cheap same-cell additive, not multi-pass bloom. Swap in a blur
  framebuffer if you want a real halo.

## Credits

- [Revelatio Studio](https://revelatio.studio)

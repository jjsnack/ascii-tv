# Embedding the ASCII TV in a static site

One file (`ascii-player.js`), one `<canvas>`, a few lines of CSS. No build step,
no dependencies. Works on any static host (GitHub Pages, Netlify, S3, a plain
folder served over http).

## 1. Drop in the files

Copy `ascii-player.js` next to your page, and put a video somewhere same-origin
(or on a host that sends `Access-Control-Allow-Origin`).

## 2. Full scroll-grow hero (matches the demo)

The player is built as a full-viewport hero: it sizes the canvas to a fraction
of the viewport and grows it on scroll (it does not read the canvas's CSS box).
The signature effect — a small centered tube that grows to fill the viewport as
you scroll — needs three things:

1. the canvas fixed and centered,
2. a **tall empty scroll region** so the page has room to scroll (that scroll
   distance is what drives the growth),
3. nothing else competing for the scroll.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { margin: 0; background: #000; }
    canvas {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      display: block;
    }
    .scroll-region { height: 260vh; } /* scroll length that drives the growth */
  </style>
</head>
<body>
  <canvas id="tv"></canvas>
  <div class="scroll-region"></div>

  <script type="module">
    import { mountAsciiPlayer } from "./ascii-player.js";
    mountAsciiPlayer(document.getElementById("tv"), "clip.mp4");
  </script>
</body>
</html>
```

- **Longer/shorter grow**: change `.scroll-region { height }`. `260vh` means the
  tube reaches full size after ~1.6 screens of scroll.
- **Start bigger/smaller**: pass `{ growStart: 0.6 }` (fraction of the viewport
  the tube fills before you scroll).
- Put your real page content *after* `.scroll-region` and it scrolls up over the
  full-size tube once the growth finishes.

## 3. Options & interaction

Pass a third `opts` object to override any knob (see the table in the README).

```js
mountAsciiPlayer(canvas, "clip.mp4", {
  cell: 16,        // chunkier glyphs
  growStart: 0.5,  // starts half-viewport
  onError: () => { /* video failed to load */ },
});
```

Built-in interaction:
- **mouse move** over the canvas warps the tube under the cursor,
- **scroll** grows it,
- **P** toggles raw pixel blocks (solid color per cell, no glyphs).

## Into a Hugo theme (no fork)

Sites built on a Hugo theme (e.g. [Bridget](https://github.com/jjsnack/bridget))
can mount the player on a single page **without forking or editing the theme** —
if the theme renders Markdown with Goldmark `unsafe = true` (raw HTML pass
through) and sets no CSP. Everything below lives in *your* site, not the theme.

1. **Assets** → drop the files in your site's `static/`:
   - `static/ascii-player.js`
   - `static/clip.mp4`

   These serve at `/ascii-player.js` and `/clip.mp4`.

2. **Page** → paste straight into the page's Markdown (e.g.
   `content/info.md`). With `unsafe = true` the `<script>` survives verbatim:

   ```html
   <canvas id="tv"></canvas>
   <script type="module">
     import { mountAsciiPlayer } from "/ascii-player.js";
     mountAsciiPlayer(document.getElementById("tv"), "/clip.mp4");
   </script>
   ```

   `type="module"` is required — the file uses `export`. Use root-absolute
   paths (`/ascii-player.js`), not `./`, so it resolves from any page URL.

### Reusable shortcode (optional)

For several pages or cleaner content, add a **project-level** shortcode —
`layouts/shortcodes/asciitv.html` in your site. Hugo layers it over the
theme's shortcodes without touching them:

```html
<canvas id="asciitv-{{ .Ordinal }}"></canvas>
<script type="module">
  import { mountAsciiPlayer } from "{{ .Get "src" | default "/ascii-player.js" }}";
  mountAsciiPlayer(document.getElementById("asciitv-{{ .Ordinal }}"),
                   "{{ .Get "video" }}");
</script>
```

Then in content: `{{</* asciitv video="/clip.mp4" */>}}`.

Note: the player self-sizes to the viewport and grabs global scroll/resize/
keydown — it's a page centerpiece, not a small inline widget. On a text page
with theme chrome it will dominate; wrap the canvas if you need it contained.
Verify with `hugo server`, open the page, check the console for the
`ascii-tv: video failed to load` line if the src path is off.

## Gotchas

- **Serve over http, not `file://`.** ES modules and the `<video>` GPU upload
  both refuse `file://`.
- **CORS**: a cross-origin video without `Access-Control-Allow-Origin` taints
  the texture and the upload fails. Same-origin is simplest.
- **Autoplay**: the player mutes the video and sets `playsInline`, which lets
  most browsers autoplay; a few mobile setups still need one tap anywhere on the
  page (the player listens for the first `pointerdown`).
- **One canvas per call.** Mounting drives its own `requestAnimationFrame` loop
  and attaches scroll/resize listeners; call `mountAsciiPlayer` once per canvas.

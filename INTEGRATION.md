# Embedding the ASCII TV in a static site

You need one file (`ascii-player.js`), one `<canvas>`, and a few lines of CSS.
There is no build step and no dependencies. It works on any static host: GitHub
Pages, Netlify, S3, or a plain folder served over HTTP.

## 1. Drop in the files

Copy `ascii-player.js` next to your page. Put a video on the same origin, or on
a host that sends `Access-Control-Allow-Origin`.

## 2. Full scroll-grow hero (matches the demo)

The player works as a full-viewport hero. It sizes the canvas to a fraction of
the viewport and grows it on scroll. It does not read the CSS box of the canvas.
The main effect is a small centered tube that grows to fill the viewport as you
scroll. This effect needs three things:

1. the canvas fixed and centered,
2. a **tall empty scroll region** so the page has room to scroll. That scroll
   distance drives the growth.
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

- **Longer or shorter grow**: change `.scroll-region { height }`. `260vh` makes
  the tube reach full size after about 1.6 screens of scroll.
- **Start bigger or smaller**: pass `{ growStart: 0.6 }`. This is the fraction of
  the viewport the tube fills before you scroll.
- Put your real page content after `.scroll-region`. It then scrolls up over the
  full-size tube after the growth finishes.

## 3. Options and interaction

Pass a third `opts` object to override any option. See the table in the README.

```js
mountAsciiPlayer(canvas, "clip.mp4", {
  cell: 16,        // chunkier glyphs
  growStart: 0.5,  // starts half-viewport
  onError: () => { /* video failed to load */ },
});
```

Built-in interaction:
- **Mouse move** over the canvas warps the tube under the cursor.
- **Scroll** grows the tube.
- The **P** key toggles raw pixel blocks (solid color per cell, no glyphs).

## Into a Hugo theme (no fork)

A site built on a Hugo theme (for example,
[Bridget](https://github.com/jjsnack/bridget)) can mount the player on a single
page without a fork and without an edit to the theme. This works when the theme
renders Markdown with Goldmark `unsafe = true` (raw HTML passes through) and sets
no CSP. Everything below lives in your site, not the theme.

1. **Assets**: drop the files in your site's `static/` folder:
   - `static/ascii-player.js`
   - `static/clip.mp4`

   These serve at `/ascii-player.js` and `/clip.mp4`.

2. **Page**: paste straight into the page's Markdown (for example,
   `content/info.md`). With `unsafe = true` the `<script>` survives verbatim:

   ```html
   <canvas id="tv"></canvas>
   <script type="module">
     import { mountAsciiPlayer } from "/ascii-player.js";
     mountAsciiPlayer(document.getElementById("tv"), "/clip.mp4");
   </script>
   ```

   You must use `type="module"` because the file uses `export`. Use
   root-absolute paths (`/ascii-player.js`), not `./`, so the path resolves from
   any page URL.

### Reusable shortcode (optional)

For several pages, or for cleaner content, add a **project-level** shortcode. Put
`layouts/shortcodes/asciitv.html` in your site. Hugo layers it over the theme's
shortcodes and does not touch them:

```html
<canvas id="asciitv-{{ .Ordinal }}"></canvas>
<script type="module">
  import { mountAsciiPlayer } from "{{ .Get "src" | default "/ascii-player.js" }}";
  mountAsciiPlayer(document.getElementById("asciitv-{{ .Ordinal }}"),
                   "{{ .Get "video" }}");
</script>
```

Then in content: `{{</* asciitv video="/clip.mp4" */>}}`.

Note: the player self-sizes to the viewport and takes the global scroll, resize,
and keydown events. It is a page centerpiece, not a small inline widget. On a
text page with theme chrome it dominates the layout. Wrap the canvas if you need
to contain it. To verify, run `hugo server` and open the page. If the source path
is wrong, check the console for the `ascii-tv: video failed to load` line.

## Gotchas

- **Serve over HTTP, not `file://`.** ES modules and the `<video>` GPU upload
  both refuse `file://`.
- **CORS**: a cross-origin video without `Access-Control-Allow-Origin` taints the
  texture, and the upload fails. Same-origin is simplest.
- **Autoplay**: the player mutes the video and sets `playsInline`, which lets
  most browsers autoplay. A few mobile setups still need one tap anywhere on the
  page. The player listens for the first `pointerdown`.
- **One canvas per call.** A mount drives its own `requestAnimationFrame` loop
  and attaches scroll and resize listeners. Call `mountAsciiPlayer` once per
  canvas.

# ascii-tv

Convert an `mp4` into a portable **colored-ASCII sequence**, then play it in any
static website on a canvas with a CSS CRT look.

Pipeline is a single ffmpeg pipe + numpy. Player is framework-free (native gzip
decode + canvas, zero deps).

## Pipeline

Needs `ffmpeg`/`ffprobe` on PATH and [`uv`](https://docs.astral.sh/uv/). `numpy`
is declared inline in `convert.py` ([PEP 723](https://peps.python.org/pep-0723/)),
so uv installs it into a cached env automatically — no venv, no `pip install`.

```sh
./convert.sh in.mp4 seq.json.gz --cols 120 --fps 24
./convert.sh --selftest   # sanity check, no ffmpeg needed
```

`convert.sh` is a thin wrapper over `uv run convert.py` (args pass through).

Options: `--cols` (horizontal resolution, default 120), `--fps` (default 24),
`--ramp` (dark→light char set, default `.:-=+*#%@`). `rows` is derived from the
source aspect ratio.

## Play it

```sh
./serve.sh          # http://localhost:8000, then open index.html
./serve.sh 9000     # custom port
```

http:// is required — the player's `DecompressionStream('gzip')` refuses
`file://`. `index.html` is a complete example (CRT shell + player call, with a
white-background toggle).

## Integrate into a site

```html
<canvas id="tv"></canvas>
<script type="module">
  import { mountAsciiPlayer } from "./ascii-player.js";
  mountAsciiPlayer(document.getElementById("tv"), "seq.json.gz");
</script>
```

`mountAsciiPlayer(canvas, seqUrl, opts)` — opts: `cellW`, `cellH`, `font`,
`loop`, `background`. Copy `ascii-player.js` and `seq.json.gz` into your site.

The CRT scanlines / glow / vignette are pure CSS — see `index.html`, none of it
is required for the ASCII itself.

## Sequence format (`seq.json.gz`)

Single gzipped JSON, row-major grids:

```json
{
  "cols": 120,
  "rows": 34,
  "fps": 24,
  "ramp": " .:-=+*#%@",
  "frames": [
    { "c": "<rows*cols chars>", "rgb": "<base64 of rows*cols*3 bytes>" }
  ]
}
```

- `c` — char per cell, from luminance mapped onto `ramp`.
- `rgb` — base64 of raw `Uint8` RGB triples, same cell order.

Both char and rgb are stored so non-browser renderers (terminal/ANSI, print) can
use the glyphs directly.

### Size

Roughly `cols·rows·4` bytes raw per frame before gzip. Fine for short clips (a
few seconds at 120 cols ≈ ~40 KB/s gzipped). For long clips, switch to NDJSON
streaming or delta-encode frames — not built yet.

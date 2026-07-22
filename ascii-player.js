// Framework-free player for a colored-ASCII sequence (seq.json.gz).
// See README for the format. No deps — native gzip decode + canvas.
//
//   import { mountAsciiPlayer } from "./ascii-player.js";
//   mountAsciiPlayer(canvas, "seq.json.gz");

export async function mountAsciiPlayer(canvas, seqUrl, opts = {}) {
  const {
    cellW = 6, // px per cell horizontally
    cellH = 10, // px per cell vertically (also font px)
    font, // override the monospace font shorthand
    loop = true,
    background = "#020402",
  } = opts;

  const seq = await loadSequence(seqUrl);
  const { cols, rows, fps, frames } = seq;
  let bg = background;

  const ctx = canvas.getContext("2d");
  // Backing store at device resolution so glyphs stay crisp on HiDPI / zoom;
  // CSS scales the element back down. Setting canvas.width resets the context,
  // so scale after.
  const dpr = Math.max(1, Math.ceil(window.devicePixelRatio || 1));
  const cssW = cols * cellW;
  const cssH = rows * cellH;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);
  ctx.font = font ?? `700 ${cellH}px "Courier New", monospace`;
  ctx.textBaseline = "top";

  // Pre-decode each frame's rgb base64 once.
  const rgb = frames.map((f) => base64ToBytes(f.rgb));

  const frameDur = 1000 / fps;
  let start = null;
  let last = -1;

  function tick(now) {
    if (start === null) start = now;
    let idx = Math.floor((now - start) / frameDur);
    if (idx >= frames.length) {
      if (!loop) return;
      start = now;
      idx = 0;
    }
    if (idx !== last) {
      draw(idx);
      last = idx;
    }
    requestAnimationFrame(tick);
  }

  function draw(idx) {
    const chars = frames[idx].c;
    const px = rgb[idx];
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssW, cssH);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const ch = chars[i];
        if (ch === " ") continue; // blank cell — skip the draw
        const o = i * 3;
        ctx.fillStyle = `rgb(${px[o]},${px[o + 1]},${px[o + 2]})`;
        ctx.fillText(ch, x * cellW, y * cellH);
      }
    }
  }

  requestAnimationFrame(tick);
  // setBackground repaints the current frame immediately so the swap shows
  // between ticks, not just on the next frame.
  return {
    seq,
    setBackground(color) {
      bg = color;
      if (last >= 0) draw(last);
    },
  };
}

async function loadSequence(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  // A static .gz fetched directly arrives as raw gzip bytes (no
  // Content-Encoding), so inflate with the native stream. If instead you serve
  // it with `Content-Encoding: gzip` the browser inflates it for you — then
  // drop this pipeThrough and read res.text() directly.
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

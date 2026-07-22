// Framework-free player for a colored-ASCII sequence (seq.json.gz).
// The colored-ASCII grid is drawn to an offscreen 2D canvas (one glyph per
// cell, colored by the source pixel — a pixelated image made of characters),
// then a WebGL pass warps it like a CRT tube: barrel bulge, black tube mask,
// scanlines and a soft vignette, all on a black background. No deps.
//
//   import { mountAsciiPlayer } from "./ascii-player.js";
//   mountAsciiPlayer(canvas, "seq.json.gz");

export async function mountAsciiPlayer(canvas, seqUrl, opts = {}) {
  const {
    cellW = 5, // px per cell horizontally (smaller = more pixel-like)
    cellH = 8, // px per cell vertically (also font px)
    font, // override the monospace font shorthand
    loop = true,
    background = "#000000",
    barrel = 0.12, // tube bulge strength
    scanline = 0.16, // scanline darkening depth
    vignette = 0.4, // corner darkening
  } = opts;

  const seq = await loadSequence(seqUrl);
  const { cols, rows, fps, frames } = seq;
  const rgb = frames.map((f) => base64ToBytes(f.rgb));

  const dpr = Math.max(1, Math.ceil(window.devicePixelRatio || 1));
  const w = cols * cellW * dpr;
  const h = rows * cellH * dpr;

  // --- offscreen 2D: the raw colored-ASCII render ------------------------
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.font = font ?? `700 ${cellH}px Menlo, Monaco, "Courier New", monospace`;
  ctx.textBaseline = "top";

  function drawAscii(idx) {
    const chars = frames[idx].c;
    const px = rgb[idx];
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, cols * cellW, rows * cellH);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        const o = i * 3;
        ctx.fillStyle = `rgb(${px[o]},${px[o + 1]},${px[o + 2]})`;
        ctx.fillText(chars[i], x * cellW, y * cellH);
      }
    }
  }

  // --- WebGL tube pass ---------------------------------------------------
  canvas.width = w;
  canvas.height = h;
  const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
  if (gl == null) throw new Error("WebGL unavailable");

  const vsrc = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }`;
  const fsrc = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    uniform float u_barrel, u_scan, u_vig, u_rows;
    void main() {
      vec2 c = v_uv - 0.5;
      float r2 = dot(c, c);
      // barrel bulge: push samples outward with radius^2
      vec2 uv = v_uv + c * u_barrel * r2;
      // tube mask: nothing outside the curved raster -> black
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
      }
      vec3 col = texture2D(u_tex, uv).rgb;
      // scanlines
      col *= 1.0 - u_scan * (0.5 + 0.5 * cos(uv.y * u_rows * 6.28318));
      // vignette
      col *= mix(1.0 - u_vig, 1.0, smoothstep(0.75, 0.15, r2));
      gl_FragColor = vec4(col, 1.0);
    }`;

  const prog = linkProgram(gl, vsrc, fsrc);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // 2D canvas is top-left origin

  gl.uniform1f(gl.getUniformLocation(prog, "u_barrel"), barrel);
  gl.uniform1f(gl.getUniformLocation(prog, "u_scan"), scanline);
  gl.uniform1f(gl.getUniformLocation(prog, "u_vig"), vignette);
  gl.uniform1f(gl.getUniformLocation(prog, "u_rows"), rows);
  gl.viewport(0, 0, w, h);

  function render(idx) {
    drawAscii(idx);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, off);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

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
      render(idx);
      last = idx;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return { seq };
}

function linkProgram(gl, vsrc, fsrc) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("shader: " + gl.getShaderInfoLog(s));
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsrc));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("link: " + gl.getProgramInfoLog(p));
  }
  return p;
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

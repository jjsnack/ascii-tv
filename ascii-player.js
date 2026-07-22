// Framework-free realtime colored-ASCII video player (WebGL, no deps).
//
// A live <video> is decoded straight to a GL texture every frame. The ASCII
// mapping happens IN the fragment shader: each screen cell samples the video's
// luminance, picks a glyph from a baked monospace atlas, and tints it by the
// source pixel color (colored ASCII). The same pass bends everything like a CRT
// tube — fisheye barrel, a soft mouse-warp trail, chromatic aberration, glyph
// glow, scanlines, vignette and a power-on flash — plus scroll-driven zoom.
//
//   import { mountAsciiPlayer } from "./ascii-player.js";
//   mountAsciiPlayer(canvas, "sample.mp4");

const TRAIL_MAX = 12;

export function mountAsciiPlayer(canvas, videoSrc, opts = {}) {
  const p = {
    cell: 16, // glyph cell size in internal px (bigger = chunkier glyphs, fewer cells)
    contrast: 1.15,
    brightness: 0.12, // additive, -1..1
    fisheye: 0.25, // horizontal barrel bulge strength
    fisheyeY: 0.55, // vertical bulge — higher = more curve on top/bottom edges
    mouseRadius: 110, // px falloff of the mouse warp
    mouseStrength: 15, // px displacement at the mouse
    chroma: 2.0, // px RGB split
    glow: 0.7, // additive glyph glow
    scanline: 0.14,
    vignette: 0.35,
    growStart: 0.42, // fraction of the viewport the tube fills before scrolling
    dprCap: 2, // clamp devicePixelRatio so huge/retina viewports don't over-render
    glyphChars: "@#W$9876543210?!abc;:+=-,._  ",
    glyphFill: 1.15, // glyph size vs cell slot (higher = less black between glyphs)
    background: "#000000",
    ...opts,
  };

  const video = document.createElement("video");
  video.muted = true; // property + attribute: some browsers need the attribute for autoplay
  video.setAttribute("muted", "");
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.style.display = "none";
  document.body.appendChild(video);
  video.addEventListener("error", () => {
    const e = video.error;
    console.error(`ascii-tv: video failed to load "${videoSrc}"`, e && e.message);
    if (opts.onError) opts.onError(e);
  });
  video.src = videoSrc;

  const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
  if (gl == null) throw new Error("WebGL unavailable");

  const glyphTex = makeGlyphAtlas(gl, p.glyphChars, p.glyphFill);
  const videoTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, videoTex);
  clampLinear(gl);

  const prog = linkProgram(gl, VSRC, fsrc(TRAIL_MAX));
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = (name) => gl.getUniformLocation(prog, name);
  const U = {
    res: u("u_res"),
    videoRes: u("u_video_res"),
    cell: u("u_cell"),
    contrast: u("u_contrast"),
    brightness: u("u_brightness"),
    fisheye: u("u_fisheye"),
    fisheyeY: u("u_fisheye_y"),
    mouseRadius: u("u_mouse_radius"),
    chroma: u("u_chroma"),
    glow: u("u_glow"),
    scan: u("u_scan"),
    vig: u("u_vig"),
    zoom: u("u_zoom"),
    fit: u("u_fit"),
    pixels: u("u_pixels"),
    bg: u("u_bg"),
    flash: u("u_flash"),
    glyphCount: u("u_glyph_count"),
    trailCount: u("u_trail_count"),
    trail: u("u_trail"), // vec3[]: (uv.x, uv.y, strength)
  };
  gl.uniform1i(u("u_video"), 0);
  gl.uniform1i(u("u_glyph"), 1);
  gl.uniform1f(U.cell, p.cell);
  gl.uniform1f(U.contrast, p.contrast);
  gl.uniform1f(U.brightness, p.brightness);
  gl.uniform1f(U.fisheye, p.fisheye);
  gl.uniform1f(U.fisheyeY, p.fisheyeY);
  gl.uniform1f(U.mouseRadius, p.mouseRadius);
  gl.uniform1f(U.chroma, p.chroma);
  gl.uniform1f(U.glow, p.glow);
  gl.uniform1f(U.scan, p.scanline);
  gl.uniform1f(U.vig, p.vignette);
  gl.uniform1f(U.glyphCount, p.glyphChars.length);

  // --- interaction: mouse warp (exact) + scroll-driven growth ------------
  const mouse = { x: 0, y: 0, on: false }; // single live point under the cursor
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - r.left) / r.width;
    mouse.y = 1 - (e.clientY - r.top) / r.height; // pointer top-down, v_uv bottom-up
    mouse.on = true;
  });
  canvas.addEventListener("pointerleave", () => { mouse.on = false; });
  gl.uniform1f(U.zoom, 1.0); // growth is physical (canvas size), not shader magnify

  // press "p" to toggle raw pixel blocks (solid color per cell, no glyphs)
  let pixels = false;
  gl.uniform1f(U.pixels, 0);
  window.addEventListener("keydown", (e) => {
    if (e.key === "p") { pixels = !pixels; gl.uniform1f(U.pixels, pixels ? 1 : 0); }
  });
  let growScale = p.growStart; // current box size as a fraction of the viewport

  // --- scroll grows the canvas box from growStart*viewport to full viewport,
  // and the internal resolution tracks the box so the glyph grid gains cells
  // as it grows (bigger picture, constant glyph density — not a zoom). ------
  function layout() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const t = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    const scale = p.growStart + t * (1 - p.growStart);
    growScale = scale; // bigger box -> bigger mouse warp radius & strength
    const cssW = Math.round(window.innerWidth * scale);
    const cssH = Math.round(window.innerHeight * scale);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const dpr = Math.min(window.devicePixelRatio || 1, p.dprCap);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.res, canvas.width, canvas.height);
    gl.uniform1f(U.fit, t); // start uncropped (contain), end cropped to fill (cover)
  }
  window.addEventListener("scroll", layout, { passive: true });
  window.addEventListener("resize", layout);
  layout();

  // --- record the video's dimensions once we know them -------------------
  let ready = false;
  let flashStart = 0;
  video.addEventListener("loadedmetadata", () => {
    gl.uniform2f(U.videoRes, video.videoWidth, video.videoHeight);
    ready = true;
    if (video.paused) video.currentTime = 0.05; // force one decoded frame if autoplay is blocked
  });
  const tryPlay = () => video.play().catch(() => {}); // muted autoplay; retry on gesture
  tryPlay();
  video.addEventListener("canplay", tryPlay);
  window.addEventListener("pointerdown", tryPlay, { once: true });

  const setBackground = (hex) => {
    const c = hexToRgb(hex);
    gl.clearColor(c[0], c[1], c[2], 1);
    gl.uniform3f(U.bg, c[0], c[1], c[2]);
  };
  setBackground(p.background);

  function tick(now) {
    if (ready && video.readyState >= 2) {
      if (flashStart === 0) flashStart = now; // ramp on the first real frame, not an event

      // one warp point, pinned exactly under the cursor; radius & strength
      // scale with the box so a small tube warps gently, a full one strongly
      gl.uniform1f(U.mouseRadius, p.mouseRadius * growScale);
      gl.uniform3f(U.trail, mouse.x, mouse.y, p.mouseStrength * growScale);
      gl.uniform1i(U.trailCount, mouse.on ? 1 : 0);

      const flash = flashStart ? Math.min(1, (now - flashStart) / 450) : 0;
      gl.uniform1f(U.flash, flash);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      uploadVideo(gl, video);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, glyphTex);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return { video, setBackground };
}

// Upload the current video frame. Chrome takes the fast element-upload path;
// Safari throws "Failed to Decode Data" on texImage2D(video), so on the first
// failure we fall back to drawing the frame to a 2D canvas and uploading raw
// pixels (a per-frame CPU readback — slower, but universally supported).
let readbackCanvas = null;
function uploadVideo(gl, video) {
  if (!readbackCanvas) {
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      return;
    } catch {
      readbackCanvas = document.createElement("canvas");
    }
  }
  const c = readbackCanvas;
  if (c.width !== video.videoWidth) { c.width = video.videoWidth; c.height = video.videoHeight; }
  const ctx = c.getContext("2d");
  ctx.drawImage(video, 0, 0);
  const px = new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, c.width, c.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
}

// --- glyph atlas: dark->light ramp baked to a 1-row texture --------------
function makeGlyphAtlas(gl, chars, fill = 1.15, glyphSize = 72) {
  const c = document.createElement("canvas");
  c.width = chars.length * glyphSize;
  c.height = glyphSize;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${Math.floor(glyphSize * fill)}px Menlo, Monaco, "Courier New", monospace`;
  const xStretch = 1.4; // ponytail: Menlo advance ~0.6em; widen to fill the square slot
  for (let i = 0; i < chars.length; i++) {
    const cx = i * glyphSize + glyphSize * 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.rect(i * glyphSize, 0, glyphSize, glyphSize); // clip so wide glyphs don't bleed into neighbors
    ctx.clip();
    ctx.translate(cx, glyphSize * 0.54);
    ctx.scale(xStretch, 1);
    ctx.fillText(chars[i], 0, 0);
    ctx.restore();
  }
  // Upload raw pixels, not the canvas element — Safari throws "Failed to Decode
  // Data" on texImage2D from a 2D canvas.
  const px = new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, c.width, c.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  clampLinear(gl);
  return tex;
}

function clampLinear(gl) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

const VSRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }`;

function fsrc(trailMax) {
  return `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_video;
  uniform sampler2D u_glyph;
  uniform vec2 u_res, u_video_res;
  uniform vec3 u_bg;
  uniform float u_cell, u_contrast, u_brightness, u_fisheye, u_fisheye_y;
  uniform float u_mouse_radius, u_chroma, u_glow, u_scan, u_vig, u_zoom, u_flash, u_fit, u_pixels;
  uniform float u_glyph_count;
  uniform int u_trail_count;
  uniform vec3 u_trail[${trailMax}];

  // fit the video into the canvas box, blending contain (u_fit=0, whole video
  // visible, letterboxed) -> cover (u_fit=1, fills the box, crops overflow).
  vec2 coverUV(vec2 uv) {
    float ar = (u_video_res.x / u_video_res.y) / (u_res.x / u_res.y); // video/box aspect
    vec2 s;
    if (ar <= 1.0) s = vec2(mix(1.0 / ar, 1.0, u_fit), mix(1.0, ar, u_fit)); // box wider
    else           s = vec2(mix(1.0, 1.0 / ar, u_fit), mix(ar, 1.0, u_fit)); // box taller
    return (uv - 0.5) * s + 0.5;
  }

  // fisheye barrel + scroll zoom + mouse-warp trail, all in screen space
  vec2 warp(vec2 uv) {
    uv = (uv - 0.5) / u_zoom + 0.5;
    vec2 c = uv - 0.5;
    float r2 = dot(c, c);
    uv.x += c.x * u_fisheye * r2;   // horizontal bulge
    uv.y += c.y * u_fisheye_y * r2; // stronger vertical bulge on top/bottom edges
    for (int i = 0; i < ${trailMax}; i++) {
      if (i >= u_trail_count) break;
      vec2 d = (uv - u_trail[i].xy) * u_res;   // px offset from trail point
      float f = exp(-dot(d, d) / (u_mouse_radius * u_mouse_radius));
      uv += normalize(uv - u_trail[i].xy + 1e-5) * f * u_trail[i].z / u_res;
    }
    return uv;
  }

  vec3 sampleVideo(vec2 sc) {
    vec2 uv = coverUV(sc);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
    return texture2D(u_video, uv).rgb;
  }

  void main() {
    vec2 suv = warp(v_uv);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
      gl_FragColor = vec4(u_bg, 1.0); // background outside the tube
      return;
    }

    vec2 grid = u_res / u_cell;
    vec2 cellId = floor(suv * grid);
    vec2 center = (cellId + 0.5) / grid;   // cell center in screen space
    vec2 local = fract(suv * grid);        // 0..1 within the cell

    // luminance -> glyph (dark maps to the dense '@' end of the ramp)
    vec3 mid = sampleVideo(center);
    float lum = dot(mid, vec3(0.299, 0.587, 0.114));
    lum = clamp((lum - 0.5) * u_contrast + 0.5 + u_brightness, 0.0, 1.0);
    float gi = floor((1.0 - lum) * (u_glyph_count - 1.0) + 0.5);
    vec2 guv = vec2((gi + local.x) / u_glyph_count, 1.0 - local.y); // glyphs upside down
    float mask = texture2D(u_glyph, guv).r;
    mask = mix(mask, 1.0, u_pixels); // pixel mode: solid color block per cell

    // chromatic aberration on the tint color
    vec2 ca = vec2(u_chroma / u_res.x, 0.0);
    vec3 tint = vec3(sampleVideo(center + ca).r, mid.g, sampleVideo(center - ca).b);

    // composite glyphs over the background: coverage = mask, dimmed by
    // scanlines; blends to u_bg so a white bg shows colored glyphs on paper
    // and a black bg keeps the emissive CRT look (identical to bg = black).
    vec3 ink = tint * (1.0 + u_glow);                                  // glyph color + glow
    vec2 cuv = coverUV(center);                                        // letterbox test
    float inFrame = step(0.0, cuv.x) * step(cuv.x, 1.0) * step(0.0, cuv.y) * step(cuv.y, 1.0);
    float a = inFrame * mask * (1.0 - u_scan * (0.5 + 0.5 * cos(suv.y * grid.y * 6.28318))); // scanlines
    vec3 col = mix(u_bg, ink, a);
    float r2 = dot(suv - 0.5, suv - 0.5);
    col = mix(u_bg, col, mix(1.0 - u_vig, 1.0, smoothstep(0.75, 0.15, r2))); // vignette
    col = mix(u_bg, col, u_flash);                                     // power-on ramp

    gl_FragColor = vec4(col, 1.0);
  }`;
}

function linkProgram(gl, vsrc, fsrc) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsrc));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
  return p;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Framework-free realtime colored-ASCII video player (WebGL, no deps).
//
// A live <video> is decoded straight to a GL texture every frame. Pass 0 samples
// it once per glyph cell (luminance + tint) into a small cell texture; pass 1
// picks each cell's glyph from a baked monospace atlas and tints it by the
// source pixel color (colored ASCII). Pass 1 also bends everything like a CRT
// tube — fisheye barrel, a cursor fuzz that scrambles glyphs, glyph glow,
// scanlines, vignette and a power-on flash — and scroll grows the canvas.
//
//   import { mountAsciiPlayer } from "./ascii-player.js";
//   const tv = mountAsciiPlayer(canvas, "sample.mp4");
//   tv.destroy(); // remove listeners, video element and GL resources

export function mountAsciiPlayer(canvas, videoSrc, opts = {}) {
  const p = {
    cell: 12, // glyph cell size in internal px (bigger = chunkier glyphs, fewer cells)
    contrast: 1.15,
    brightness: 0.12, // additive, -1..1
    fisheye: 0.48, // horizontal barrel bulge strength
    fisheyeY: 0.86, // vertical bulge — higher = more curve on top/bottom edges
    mouseRadius: 70, // px falloff of the cursor fuzz (glyph view)
    fuzzAmount: 1.3, // scramble strength at the cursor center (>1 = core fully scrambled, rim flickers)
    pixelCell: 10, // cell size in pixel view (smaller = higher resolution)
    pixelContrast: 1.05, // extra contrast in pixel view (multiplies around mid-gray)
    pixelBrightness: -0.05, // extra brightness in pixel view (negative = darker)
    warpRadius: 85, // px falloff of the cursor glitch/static (pixel view)
    warpStrength: 10, // px block-tear displacement at the cursor (pixel view)
    chroma: 2.0, // px RGB split
    glow: 0.7, // additive glyph glow
    scanline: 0.14,
    vignette: 0.35,
    edgeShade: 0.45, // extra darkening toward the curved top/bottom tube edges (0 = off)
    edgeFade: 0.24, // width of the top/bottom fade-into-background border (viewport fraction); fades out as it zooms in
    edgeFadeX: 0.18, // width of the left/right fade (viewport fraction); smaller = less blur on the sides
    growStart: 0.55, // fraction of the viewport the tube fills before scrolling
    growEnd: 0.9, // fraction it grows to when fully scrolled (< 1 leaves padding around each side)
    dprCap: 2, // clamp devicePixelRatio so huge/retina viewports don't over-render
    glyphChars: "@#W$9876543210?!abc;:+=-,._  ",
    glyphFill: 1.15, // glyph size vs cell slot (higher = less black between glyphs)
    background: "#000000",
    ...opts,
  };

  const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
  if (gl == null) throw new Error("WebGL unavailable");

  // every listener goes through `on` so destroy() can drop them with one abort
  const ac = new AbortController();
  const on = (target, type, fn, o) => target.addEventListener(type, fn, { ...o, signal: ac.signal });

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
  on(video, "error", () => {
    const e = video.error;
    console.error(`ascii-tv: video failed to load "${videoSrc}"`, e && e.message);
    if (opts.onError) opts.onError(e);
  });
  video.src = videoSrc;

  // --- state that outlives a GL context ------------------------------------
  let g; // GL resources, rebuilt by setup() after a context loss
  let U; // uniform locations
  let lost = false;
  let pixels = false; // raw pixel blocks (solid color per cell) instead of glyphs
  let bg = p.background;
  let growScale = p.growStart; // current box size as a fraction of the viewport
  const mouse = { x: 0, y: 0, on: false }; // single live point under the cursor
  const cells = { w: 0, h: 0 }; // size of the cell texture (one texel per glyph cell)
  let cellsDirty = true; // pass 0 must re-run (new video frame, resize, scroll, cell size)
  let fresh = true; // a new video frame is waiting to be uploaded
  let needsLayout = false;
  let ready = false;
  let flashStart = 0;

  function setup() {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // video + glyph textures are uploaded bottom-up

    const prog = linkProgram(gl, VSRC, FSRC);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    g = { prog, buf, fbo: gl.createFramebuffer() };
    gl.activeTexture(gl.TEXTURE0);
    g.videoTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, g.videoTex);
    clampLinear(gl);
    gl.activeTexture(gl.TEXTURE1);
    g.glyphTex = makeGlyphAtlas(gl, p.glyphChars, p.glyphFill);
    gl.activeTexture(gl.TEXTURE2);
    g.cellsTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, g.cellsTex);
    clampLinear(gl, gl.NEAREST); // exact per-cell lookup, no blending between cells

    const u = (name) => gl.getUniformLocation(prog, name);
    U = {
      res: u("u_res"),
      videoRes: u("u_video_res"),
      cell: u("u_cell"),
      cellsN: u("u_cells_n"),
      pass: u("u_pass"),
      contrast: u("u_contrast"),
      brightness: u("u_brightness"),
      fisheye: u("u_fisheye"),
      fisheyeY: u("u_fisheye_y"),
      mouseRadius: u("u_mouse_radius"),
      chroma: u("u_chroma"),
      glow: u("u_glow"),
      scan: u("u_scan"),
      vig: u("u_vig"),
      edgeShade: u("u_edge_shade"),
      edgeFade: u("u_edge_fade"),
      edgeFadeX: u("u_edge_fade_x"),
      fit: u("u_fit"),
      pixels: u("u_pixels"),
      bg: u("u_bg"),
      flash: u("u_flash"),
      glyphCount: u("u_glyph_count"),
      pixelContrast: u("u_pixel_contrast"),
      pixelBrightness: u("u_pixel_brightness"),
      mouse: u("u_mouse"), // vec3: (uv.x, uv.y, fuzz amount); z = 0 when the cursor is away
      time: u("u_time"),
    };
    gl.uniform1i(u("u_video"), 0);
    gl.uniform1i(u("u_glyph"), 1);
    gl.uniform1i(u("u_cells"), 2);
    gl.uniform1f(U.contrast, p.contrast);
    gl.uniform1f(U.brightness, p.brightness);
    gl.uniform1f(U.fisheye, p.fisheye);
    gl.uniform1f(U.fisheyeY, p.fisheyeY);
    gl.uniform1f(U.chroma, p.chroma);
    gl.uniform1f(U.glow, p.glow);
    gl.uniform1f(U.scan, p.scanline);
    gl.uniform1f(U.vig, p.vignette);
    gl.uniform1f(U.edgeShade, p.edgeShade);
    gl.uniform1f(U.edgeFade, p.edgeFade);
    gl.uniform1f(U.edgeFadeX, p.edgeFadeX);
    gl.uniform1f(U.glyphCount, p.glyphChars.length);
    gl.uniform1f(U.pixelContrast, p.pixelContrast);
    gl.uniform1f(U.pixelBrightness, p.pixelBrightness);
    gl.uniform1f(U.pixels, pixels ? 1 : 0);
    if (ready) gl.uniform2f(U.videoRes, video.videoWidth, video.videoHeight);
    setBackground(bg);

    cells.w = cells.h = 0; // new texture has no storage yet
    fresh = true;
    layout();
  }

  // --- interaction: mouse warp (exact) + scroll-driven growth ------------
  let lingerTimer = 0;
  const aim = (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - r.left) / r.width;
    mouse.y = 1 - (e.clientY - r.top) / r.height; // pointer top-down, v_uv bottom-up
    mouse.on = true;
    clearTimeout(lingerTimer);
  };
  const clearMouse = () => { mouse.on = false; };
  on(canvas, "pointermove", aim);
  // a tap has no move, and a drag turns into a page scroll (pointercancel) within
  // a few px, so touch also starts the fuzz on pointerdown and lets it linger
  // after the finger lifts — otherwise it flashes for a frame or never shows.
  on(canvas, "pointerdown", (e) => { if (e.pointerType !== "mouse") aim(e); });
  const lift = (e) => {
    if (e.pointerType === "mouse") return; // a mouse keeps hovering after a click
    clearTimeout(lingerTimer);
    lingerTimer = setTimeout(clearMouse, 500);
  };
  on(canvas, "pointerleave", (e) => { if (e.pointerType === "mouse") clearMouse(); }); // touch leaves on lift: lift() handles it
  on(canvas, "pointercancel", lift);
  // double tap/click: timed here because iOS Safari doesn't reliably fire
  // dblclick on a non-interactive element like a canvas
  let lastTap = { t: 0, x: 0, y: 0 };
  on(canvas, "pointerup", (e) => {
    lift(e);
    const near = Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30;
    if (e.timeStamp - lastTap.t < 350 && near) {
      lastTap.t = 0;
      togglePixels();
    } else {
      lastTap = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    }
  });

  // toggle raw pixel blocks (solid color per cell): "p" key or double-tap/click
  const togglePixels = () => {
    pixels = !pixels;
    gl.uniform1f(U.pixels, pixels ? 1 : 0);
    allocCells(); // finer grid in pixel view
    if (opts.onPixels) opts.onPixels(pixels); // keep any UI label in sync across all triggers
    return pixels;
  };
  on(window, "keydown", (e) => {
    if (e.key.toLowerCase() !== "p" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return; // typing, not toggling
    togglePixels();
  });

  // --- scroll grows the canvas box from growStart*viewport to full viewport,
  // and the internal resolution tracks the box so the glyph grid gains cells
  // as it grows (bigger picture, constant glyph density — not a zoom). ------
  function layout() {
    needsLayout = false;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const t = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    const scale = p.growStart + t * (p.growEnd - p.growStart);
    growScale = scale; // bigger box -> bigger mouse warp radius & strength
    const cssW = Math.round(window.innerWidth * scale);
    const cssH = Math.round(window.innerHeight * scale);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const dpr = Math.min(window.devicePixelRatio || 1, p.dprCap);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    // assigning width/height reallocates the drawing buffer even to the same value
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    gl.uniform2f(U.res, w, h);
    gl.uniform1f(U.fit, t); // start uncropped (contain), end cropped to fill (cover)
    allocCells();
  }
  // scroll/resize can fire many times per frame; lay out once, in the next tick
  const queueLayout = () => { needsLayout = true; };
  on(window, "scroll", queueLayout, { passive: true });
  on(window, "resize", queueLayout);

  // one texel per glyph cell; re-run on a grid-size change (resize, pixel view)
  function allocCells() {
    const cell = pixels ? p.pixelCell : p.cell;
    const nx = Math.ceil(canvas.width / cell);
    const ny = Math.ceil(canvas.height / cell);
    gl.uniform1f(U.cell, cell);
    gl.uniform2f(U.cellsN, nx, ny);
    if (nx !== cells.w || ny !== cells.h) {
      cells.w = nx;
      cells.h = ny;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, g.cellsTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nx, ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g.cellsTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    cellsDirty = true;
  }

  // --- record the video's dimensions once we know them -------------------
  on(video, "loadedmetadata", () => {
    gl.uniform2f(U.videoRes, video.videoWidth, video.videoHeight);
    ready = true;
    cellsDirty = true;
    if (video.paused) video.currentTime = 0.05; // force one decoded frame if autoplay is blocked
  });
  const tryPlay = () => video.play().catch(() => {}); // muted autoplay; retry on gesture
  tryPlay();
  on(video, "canplay", tryPlay);
  on(video, "seeked", () => { fresh = true; }); // paused seek: not every browser fires a frame callback
  on(window, "pointerdown", tryPlay, { once: true });
  on(document, "visibilitychange", () => (document.hidden ? video.pause() : tryPlay())); // hidden tabs keep decoding otherwise

  // upload a texture only when the video produced a new frame; browsers without
  // requestVideoFrameCallback upload every tick
  const hasFrameCb = "requestVideoFrameCallback" in video;
  if (hasFrameCb) {
    const onFrame = () => {
      fresh = true;
      if (!ac.signal.aborted) video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  function setBackground(hex) {
    bg = hex;
    if (lost) return; // setup() re-applies it after the context is restored
    const c = hexToRgb(hex);
    gl.clearColor(c[0], c[1], c[2], 1);
    gl.uniform3f(U.bg, c[0], c[1], c[2]);
  }

  // Upload the current video frame. Chrome takes the fast element-upload path;
  // Safari throws "Failed to Decode Data" on texImage2D(video), so on the first
  // failure we fall back to drawing the frame to a 2D canvas and uploading raw
  // pixels (a per-frame CPU readback — slower, but universally supported).
  let readback = null;
  function uploadVideo() {
    if (!readback) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
        return;
      } catch {
        readback = document.createElement("canvas");
      }
    }
    const w = video.videoWidth, h = video.videoHeight;
    if (readback.width !== w || readback.height !== h) { readback.width = w; readback.height = h; }
    const ctx = readback.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);
    const px = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }

  // pass 0: video -> one texel per glyph cell (tint rgb + luminance alpha)
  function drawCells() {
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null); // can't sample the texture we render into
    gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo);
    gl.viewport(0, 0, cells.w, cells.h);
    gl.uniform1f(U.pass, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, g.cellsTex);
    cellsDirty = false;
  }

  let raf = 0;
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (lost) return;
    if (needsLayout) layout();
    if (ready && video.readyState >= 2) {
      if (flashStart === 0) flashStart = now; // ramp on the first real frame, not an event

      if (fresh) {
        gl.activeTexture(gl.TEXTURE0);
        uploadVideo();
        fresh = !hasFrameCb;
        cellsDirty = true;
      }
      if (cellsDirty) drawCells();

      // one cursor point under the pointer. glyph view fuzzes (scrambles) it;
      // pixel view warps the geometry (the old distortion trail). radius/strength
      // differ per mode, and only one mode is live, so pick by `pixels`.
      const radius = (pixels ? p.warpRadius : p.mouseRadius) * growScale;
      const strength = pixels ? p.warpStrength * growScale : p.fuzzAmount;
      gl.uniform1f(U.mouseRadius, radius);
      gl.uniform3f(U.mouse, mouse.x, mouse.y, mouse.on ? strength : 0);
      gl.uniform1f(U.time, now * 0.001);
      gl.uniform1f(U.flash, Math.min(1, (now - flashStart) / 450));

      // pass 1: cells -> glyphs, tube effects, composite
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1f(U.pass, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // mobile browsers drop GL contexts under memory pressure: stop drawing, then rebuild
  on(canvas, "webglcontextlost", (e) => { e.preventDefault(); lost = true; });
  on(canvas, "webglcontextrestored", () => { lost = false; setup(); });

  function destroy() {
    cancelAnimationFrame(raf);
    clearTimeout(lingerTimer);
    ac.abort();
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    if (!lost) {
      gl.deleteProgram(g.prog);
      gl.deleteBuffer(g.buf);
      gl.deleteFramebuffer(g.fbo);
      gl.deleteTexture(g.videoTex);
      gl.deleteTexture(g.glyphTex);
      gl.deleteTexture(g.cellsTex);
    }
  }

  setup();
  raf = requestAnimationFrame(tick);

  return { video, setBackground, togglePixels, destroy };
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
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, c.width, c.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  clampLinear(gl);
  return tex;
}

function clampLinear(gl, filter = gl.LINEAR) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
}

const VSRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }`;

const FSRC = `
  precision highp float;
  varying vec2 v_uv;
  uniform sampler2D u_video;
  uniform sampler2D u_glyph;
  uniform sampler2D u_cells;
  uniform vec2 u_res, u_video_res, u_cells_n;
  uniform vec3 u_bg;
  uniform float u_pass;
  uniform float u_cell, u_contrast, u_brightness, u_fisheye, u_fisheye_y;
  uniform float u_mouse_radius, u_chroma, u_glow, u_scan, u_vig, u_flash, u_fit, u_pixels, u_edge_fade, u_edge_fade_x, u_edge_shade;
  uniform float u_glyph_count, u_pixel_contrast, u_pixel_brightness;
  uniform vec3 u_mouse;
  uniform float u_time;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  // fit the video into the canvas box, blending contain (u_fit=0, whole video
  // visible, letterboxed) -> cover (u_fit=1, fills the box, crops overflow).
  vec2 coverUV(vec2 uv) {
    float ar = (u_video_res.x / u_video_res.y) / (u_res.x / u_res.y); // video/box aspect
    vec2 s;
    if (ar <= 1.0) s = vec2(mix(1.0 / ar, 1.0, u_fit), mix(1.0, ar, u_fit)); // box wider
    else           s = vec2(mix(1.0, 1.0 / ar, u_fit), mix(ar, 1.0, u_fit)); // box taller
    return (uv - 0.5) * s + 0.5;
  }

  // fisheye barrel in screen space. In pixel view the cursor also warps the
  // geometry (the old distortion trail); glyph view leaves the geometry alone
  // and instead scrambles the glyph in main().
  vec2 warp(vec2 uv) {
    vec2 c = uv - 0.5;
    float r2 = dot(c, c);
    float bulge = 1.0 - u_fit; // fisheye ramps out as it zooms in; ends as a flat rectangle
    uv.x += c.x * u_fisheye * bulge * r2;   // horizontal bulge
    uv.y += c.y * u_fisheye_y * bulge * r2; // stronger vertical bulge on top/bottom edges
    if (u_pixels > 0.5 && u_mouse.z > 0.0) {
      float t = floor(u_time * 18.0);            // glitch re-rolls ~18x/sec
      vec2 d = (uv - u_mouse.xy) * u_res;        // px offset from the cursor
      // per-cell jitter on the falloff so the affected region has a ragged,
      // noisy edge instead of a clean visible circle
      float edge = 0.4 + 1.2 * hash(floor(uv * u_res / u_cell));
      float f = max(0.0, exp(-dot(d, d) / (u_mouse_radius * u_mouse_radius) * edge) - 0.01); // floor kills stray rim cells
      // horizontal tearing: shove whole scanline bands sideways, but only the
      // fraction of rows whose random gate fires this frame (digital tear)
      float row = floor(uv.y * 60.0);
      float sh = (hash(vec2(row, t)) - 0.5) * step(0.55, hash(vec2(row, t + 4.0)));
      uv.x += sh * f * u_mouse.z * 3.0 / u_res.x;
      // blocky displacement: rectangular chunks hop vertically now and then
      vec2 blk = floor(uv * vec2(24.0, 16.0));
      float jv = (hash(blk + t) - 0.5) * step(0.8, hash(blk + t + 9.0));
      uv.y += jv * f * u_mouse.z * 2.0 / u_res.y;
    }
    return uv;
  }

  vec3 sampleVideo(vec2 sc) {
    vec2 uv = coverUV(sc);
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec3(0.0);
    return texture2D(u_video, uv).rgb;
  }

  void main() {
    float glyphMax = max(u_glyph_count - 1.0, 1.0); // highest glyph index
    if (u_pass < 0.5) {
      // pass 0: one fragment per glyph cell. Sample the video here, once per
      // cell, instead of three times for every pixel of the cell in pass 1.
      vec2 center = (floor(gl_FragCoord.xy) + 0.5) / (u_res / u_cell);
      vec3 mid = sampleVideo(center);
      float lum = dot(mid, vec3(0.299, 0.587, 0.114));
      lum = clamp((lum - 0.5) * u_contrast + 0.5 + u_brightness, 0.0, 1.0);
      // luminance -> glyph (dark maps to the dense '@' end of the ramp). Store
      // the glyph index, not lum: 8 bits of lum would flip glyphs at the rounding
      // boundaries. shortcut: 8-bit alpha, so ramps over 256 glyphs collide.
      float gi = floor((1.0 - lum) * glyphMax + 0.5);
      // chromatic aberration on the tint color
      vec2 ca = vec2(u_chroma / u_res.x, 0.0);
      gl_FragColor = vec4(sampleVideo(center + ca).r, mid.g, sampleVideo(center - ca).b, gi / glyphMax);
      return;
    }

    vec2 suv = warp(v_uv);
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
      gl_FragColor = vec4(u_bg, 1.0); // background outside the tube
      return;
    }

    vec2 grid = u_res / u_cell;
    vec2 cellId = floor(suv * grid);
    vec2 center = (cellId + 0.5) / grid;   // cell center in screen space
    vec2 local = fract(suv * grid);        // 0..1 within the cell

    vec4 cd = texture2D(u_cells, (cellId + 0.5) / u_cells_n);
    float gi = floor(cd.a * glyphMax + 0.5);

    // cursor fuzz: scramble glyphs to random characters in a soft radius under
    // the cursor, re-rolled ~30x a second (TV-static shimmer). fuzz>1 at center
    // so the core fully scrambles and only the rim probabilistically flickers.
    float fuzz = 0.0, t = 0.0;
    if (u_mouse.z > 0.0 && u_pixels < 0.5) {
      vec2 d = (center - u_mouse.xy) * u_res; // cell center, not pixel: whole cell shares one fuzz value
      fuzz = exp(-dot(d, d) / (u_mouse_radius * u_mouse_radius)) * u_mouse.z - 0.001;
      t = floor(u_time * 30.0);
      if (hash(cellId + t) < fuzz) gi = floor(hash(cellId * 1.7 + t) * u_glyph_count);
    }

    vec2 guv = vec2((gi + local.x) / u_glyph_count, 1.0 - local.y); // glyphs upside down
    float mask = texture2D(u_glyph, guv).r;
    mask = mix(mask, 1.0, u_pixels); // pixel mode: solid color block per cell

    vec3 tint = cd.rgb;

    // color fuzz: wrap the tint by a random RGB offset in the cursor radius, so
    // scrambled cells flash random hues (fract keeps it bright, not washed out)
    if (fuzz > 0.0 && hash(cellId + t + 5.0) < fuzz)
      tint = fract(tint + vec3(hash(cellId + t), hash(cellId + t + 2.0), hash(cellId + t + 4.0)));

    // pixel view: TV static under the cursor. cells flip to random speckle
    // (mostly grayscale, a little color), gated by a ragged non-circular falloff
    if (u_pixels > 0.5 && u_mouse.z > 0.0) {
      vec2 sd = (center - u_mouse.xy) * u_res; // cell center: whole cell toggles together
      float edge = 0.4 + 1.2 * hash(cellId + 1.0);
      float sf = exp(-dot(sd, sd) / (u_mouse_radius * u_mouse_radius) * edge) - 0.05; // floor kills stray rim cells
      float ts = floor(u_time * 24.0);
      if (hash(cellId + ts) < sf) {
        vec3 sp = vec3(hash(cellId * 1.3 + ts), hash(cellId * 1.3 + ts + 2.0), hash(cellId * 1.3 + ts + 4.0));
        tint = mix(tint, mix(vec3(dot(sp, vec3(0.333))), sp, 0.4), 0.9); // mostly gray speckle
      }
    }

    // composite glyphs over the background: coverage = mask, dimmed by
    // scanlines; blends to u_bg so a white bg shows colored glyphs on paper
    // and a black bg keeps the emissive CRT look (identical to bg = black).
    vec3 ink = tint * (1.0 + u_glow);                                  // glyph color + glow

    // pixel view -> fake a CRT: each cell becomes a lit phosphor triad (R/G/B
    // vertical aperture-grille stripes) with a rounded horizontal scanline gap.
    // Boosted to offset the 2/3 of light the grille masks out.
    if (u_pixels > 0.5) {
      ink = clamp((ink - 0.5) * u_pixel_contrast + 0.5 + u_pixel_brightness, 0.0, 1.0); // darker/contrastier, pixel view only
      vec3 grille = vec3(step(local.x, 0.34), step(0.33, local.x) * step(local.x, 0.67), step(0.66, local.x));
      float bar = smoothstep(0.0, 0.12, local.y) * smoothstep(1.0, 0.72, local.y);
      ink *= mix(vec3(1.0), grille * 2.2, 0.8) * mix(0.45, 1.15, bar);
    }
    vec2 cuv = coverUV(center);                                        // letterbox test
    float inFrame = step(0.0, cuv.x) * step(cuv.x, 1.0) * step(0.0, cuv.y) * step(cuv.y, 1.0);
    float a = inFrame * mask * (1.0 - u_scan * (0.5 + 0.5 * cos(suv.y * grid.y * 6.28318))); // scanlines
    vec3 col = mix(u_bg, ink, a);
    float r2 = dot(suv - 0.5, suv - 0.5);
    col = mix(u_bg, col, mix(1.0 - u_vig, 1.0, smoothstep(0.75, 0.15, r2))); // vignette

    // extra shading toward the curved top/bottom edges (follows the warped tube,
    // so it hugs the fisheye curve; fades with the bulge as it zooms flat)
    float vy = abs(suv.y - 0.5) * 2.0;                       // 0 center -> 1 top/bottom
    col = mix(col, u_bg, u_edge_shade * (1.0 - u_fit) * smoothstep(0.55, 1.0, vy));

    // rectangular edge fade into the background, on the canvas edges (v_uv, not
    // warped). Strong at the start, gone once zoomed to a full-viewport rect.
    // ponytail: a dissolve to bg, not a separable gaussian; add real blur if this reads too crisp.
    float efX = smoothstep(0.0, u_edge_fade_x, min(v_uv.x, 1.0 - v_uv.x)); // narrower on the sides
    float efT = smoothstep(0.0, u_edge_fade, min(v_uv.y, 1.0 - v_uv.y));
    float ef = min(efX, efT);
    col = mix(u_bg, col, mix(1.0, ef, 1.0 - u_fit)); // all fade gone at full zoom (u_fit=1)

    col = mix(u_bg, col, u_flash);                                     // power-on ramp

    gl_FragColor = vec4(col, 1.0);
  }`;

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

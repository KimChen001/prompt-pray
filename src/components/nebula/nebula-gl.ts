// MOONA nebula: one WebGL context, one animation loop. Loaded on demand by Nebula.tsx; the page never
// waits for it (a static CSS orb is painted first and stays if anything here fails).
//
// Orb  – a dark sphere holding a slow violet–blue luminous band (after the "Ether" reference) with soft
//        moonlight-silver filaments (after "Flowing Waves"); one restrained magenta note, no rainbow.
//        Written for MOONA (the reference's Ether shader is CC BY-NC-SA and is not used).
// Dust – an optional field of star-dust particles orbiting the orb in tilted rings. They part around
//        the pointer, follow its wake, burst on a tap and flow into the orb while cards are shuffled.
//        Particles behind the sphere are drawn first so the orb hides them.
// States are eased on the CPU, so a change never restarts or jumps the animation.

export type NebulaMode = "idle" | "gather" | "pulse" | "settle" | "quiet";

export interface NebulaOptions {
  /** Lower detail: fewer noise octaves and particles, lower resolution, ~30 fps. */
  lite: boolean;
  /** Render one still frame and stop (reduced motion). */
  still: boolean;
  /** Canvas half-size in orb box units (1 = the orb box only; 1.9 = room for the particle field). */
  field: number;
  /** Draw the particle field. */
  particles: boolean;
  /** Called when the GPU path is unusable (context lost, too slow): show the static orb. */
  onFail: (reason: string) => void;
}

// Orb units: the orb box spans [-BOX, BOX]; the sphere radius is ~0.86.
export const BOX = 1.08;
const EXTENT = 1.3; // the orb quad covers the sphere and its halo

const ORB_VERT = `attribute vec2 aPos; uniform float uField; varying vec2 vP;
void main(){ vP = aPos * ${EXTENT.toFixed(2)}; gl_Position = vec4(vP / uField, 0.0, 1.0); }`;

// Octave count is a compile-time constant so the loop unrolls on mobile GPUs.
const orbFrag = (octaves: number) => `
precision mediump float;
varying vec2 vP;
uniform float uTime;      // seconds, already scaled by the flow speed
uniform float uEnergy;    // 0..1 overall brightness
uniform float uGather;    // 0..1 contraction / swirl (shuffle)
uniform float uPulse;     // 0..1 soft AI-request pulse
uniform float uBreath;    // -1..1 slow breathing
uniform vec2 uTilt;       // pointer parallax, small
uniform vec3 uPointer;    // xy = pointer in orb units, z = presence 0..1
uniform vec3 uRipple;     // xy = position in orb units, z = age in seconds (<0: none)

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < ${octaves}; i++) { v += a * noise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
  return v;
}

void main(){
  vec2 p = vP;
  float R = 0.86 + 0.012 * uBreath - 0.03 * uGather;
  float r = length(p);
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // soft outer halo (mist violet), gone well before the quad edge
  float halo = exp(-pow(max(r - R, 0.0) * 6.5, 1.6)) * smoothstep(R - 0.05, R + 0.02, r);
  col += vec3(0.42, 0.36, 0.62) * halo * (0.18 + 0.22 * uEnergy + 0.25 * uPulse + 0.12 * uPointer.z);
  alpha += halo * (0.35 + 0.4 * uEnergy);

  if (r < R) {
    float z = sqrt(R * R - r * r) / R;         // sphere depth, 1 at the centre
    vec2 q = (p - uTilt * (1.0 - z)) / (0.55 + 0.45 * z); // bulge: flow wraps around the sphere

    // the pointer gently pulls the flow towards itself
    vec2 toPtr = uPointer.xy - p;
    float near = uPointer.z * exp(-dot(toPtr, toPtr) * 2.2);
    q -= toPtr * near * 0.12;

    // ripple from a tap: a short travelling wave
    if (uRipple.z >= 0.0) {
      float d = length(p - uRipple.xy);
      float w = sin(d * 26.0 - uRipple.z * 9.0) * exp(-uRipple.z * 1.8) * exp(-d * 3.0);
      q += normalize(p - uRipple.xy + 1e-4) * w * 0.05;
    }

    float t = uTime;
    float swirl = 0.35 + 1.6 * uGather;
    float ang = swirl * (1.0 - r);
    q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q;

    // domain-warped flow: low frequencies for a soft, misty nebula (not crackle)
    vec2 w1 = vec2(fbm(q * 0.95 + vec2(0.0, t * 0.06)), fbm(q * 0.95 + vec2(5.2, -t * 0.05)));
    vec2 w2 = vec2(fbm(q * 1.25 + w1 * 1.5 + vec2(1.7, t * 0.04)), fbm(q * 1.25 + w1 * 1.5 + vec2(8.3, t * 0.035)));
    float f = fbm(q * 1.05 + w2 * 1.6);

    // Luminous band around a dark core. Its outline is blobby (seamless noise on the direction);
    // one side is lit more than the other. The lit side drifts slowly, and turns towards the pointer.
    vec2 dir = normalize(q + 1e-4);
    float shape = fbm(dir * 1.4 + vec2(t * 0.03, -t * 0.02)) - 0.5;
    float rr = length(q * vec2(1.0, 0.94)) * 0.6;
    float bandR = 0.47 + 0.1 * (f - 0.5) + 0.22 * shape + 0.03 * uBreath - 0.2 * uGather;
    float bw = 0.13 + 0.05 * uGather + 0.03 * f;
    vec2 drift = vec2(cos(t * 0.045 + 3.9), sin(t * 0.045 + 3.9));
    vec2 light = normalize(mix(drift, normalize(uPointer.xy + 1e-4), 0.75 * uPointer.z));
    float side = smoothstep(-0.75, 0.95, dot(dir, light));
    float lit = mix(0.4, 1.15, side);
    bw *= 1.0 + 0.35 * side;
    float band = exp(-pow((rr - bandR) / bw, 2.0));
    float halo2 = exp(-pow((rr - bandR - 0.15) / 0.2, 2.0)) * 0.3;  // faint outer veil
    float core = smoothstep(bandR - 0.03, bandR - 0.36, rr);

    // Flowing-waves sheen: a few soft silver filaments riding the warp
    float s = sin((q.x * 0.7 + q.y * 1.1) * 3.2 + w2.x * 6.0 - t * 0.22);
    float streak = pow(max(s, 0.0), 12.0) * smoothstep(0.45, 0.8, f) * (band + halo2) * (0.4 + 0.6 * side);

    vec3 ink    = vec3(0.043, 0.037, 0.080);  // inside the sphere
    vec3 violet = vec3(0.55, 0.47, 0.82);     // near the mist token
    vec3 blue   = vec3(0.20, 0.34, 0.86);
    vec3 deep   = vec3(0.12, 0.15, 0.42);
    vec3 silver = vec3(0.90, 0.92, 0.97);
    vec3 accent = vec3(0.80, 0.42, 0.78);     // one magenta note, on the lit side only
    vec3 cyan   = vec3(0.37, 0.90, 0.82);     // AI-request pulse only

    vec3 bandCol = mix(blue, violet, smoothstep(0.3, 0.7, w1.y));
    bandCol = mix(bandCol, accent, 0.6 * side * smoothstep(0.3, 0.7, w2.y));
    bandCol = mix(bandCol, silver, smoothstep(0.62, 1.0, band * side) * 0.75);

    float glow = (band * lit + halo2 * 0.7) * (0.55 + 0.55 * uEnergy) * (0.9 + 0.35 * uPulse);
    vec3 inside = ink;
    inside += deep * 0.45 * smoothstep(0.25, 0.9, f) * (1.0 - core * 0.6);   // mist in the body
    inside += bandCol * glow;
    inside += silver * streak * (0.3 + 0.3 * uEnergy);
    inside += mix(violet, silver, 0.35) * near * 0.22;                  // soft light under the pointer
    inside = mix(inside, inside + cyan * band * 0.45, uPulse * 0.45);
    inside *= 1.0 - 0.6 * core;                                         // the dark eye

    // moonlight rim and a soft specular from the upper left
    float rim = pow(1.0 - z, 2.6);
    inside += mix(violet, silver, 0.5) * rim * (0.16 + 0.14 * uEnergy);
    float spec = pow(max(dot(normalize(vec3(p, z * R)), normalize(vec3(-0.45, 0.55, 0.7))), 0.0), 28.0);
    inside += silver * spec * 0.07;
    inside = inside / (1.0 + 0.3 * inside);                             // soft shoulder, no clipping

    float edge = smoothstep(R, R - 0.012, r);  // anti-aliased sphere edge
    col = mix(col, inside, edge);
    alpha = mix(alpha, 1.0, edge);
  }

  gl_FragColor = vec4(col * alpha, alpha);    // premultiplied
}`;

const DUST_VERT = `attribute vec2 aPos; attribute float aSize; attribute float aAlpha; attribute float aTint;
uniform float uField; uniform float uPx;
varying float vAlpha; varying float vTint;
void main(){ vAlpha = aAlpha; vTint = aTint; gl_Position = vec4(aPos / uField, 0.0, 1.0); gl_PointSize = aSize * uPx; }`;

const DUST_FRAG = `precision mediump float;
varying float vAlpha; varying float vTint;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (smoothstep(1.0, 0.0, d) * 0.5 + smoothstep(0.32, 0.0, d) * 0.9) * vAlpha;
  vec3 silver = vec3(0.90, 0.92, 0.97);
  vec3 mist = vec3(0.64, 0.58, 0.80);
  vec3 blue = vec3(0.45, 0.56, 0.95);
  vec3 c = vTint < 0.5 ? mix(silver, mist, vTint * 2.0) : mix(mist, blue, (vTint - 0.5) * 2.0);
  gl_FragColor = vec4(c * a, a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
  return s;
}
function link(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  return p;
}

const TARGETS: Record<NebulaMode, { energy: number; gather: number; pulse: number; speed: number; orbit: number; dust: number }> = {
  idle: { energy: 0.72, gather: 0, pulse: 0, speed: 1, orbit: 1, dust: 1 },
  gather: { energy: 0.95, gather: 1, pulse: 0, speed: 3.2, orbit: 0.3, dust: 1.15 },
  pulse: { energy: 0.8, gather: 0.12, pulse: 1, speed: 1.4, orbit: 0.92, dust: 1 },
  settle: { energy: 1, gather: 0.35, pulse: 0, speed: 0.8, orbit: 1.12, dust: 1.1 },
  quiet: { energy: 0.42, gather: 0, pulse: 0, speed: 0.45, orbit: 1, dust: 0.45 },
};

// ---- star dust (CPU-simulated, a few hundred floats per frame) ----
interface Mote {
  a: number;      // angle on its ring
  r: number;      // ring radius (orb units)
  w: number;      // angular speed (rad/s)
  cosI: number; sinI: number; // ring inclination
  cosN: number; sinN: number; // ring node (rotation in the screen plane)
  size: number; tint: number; tw: number; ph: number;
  ox: number; oy: number; vx: number; vy: number; // displacement from the ring, spring-damped
}

function rand(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function makeDust(n: number): Mote[] {
  const rnd = rand(20261028);
  return Array.from({ length: n }, (_, i) => {
    const disc = i < n * 0.72; // most motes in one tilted disc, the rest in a loose shell
    const r = disc ? 0.98 + Math.pow(rnd(), 1.6) * 0.95 : 1.0 + rnd() * 0.9;
    const incl = disc ? (1.2 + rnd() * 0.18) : rnd() * Math.PI;
    const node = disc ? -0.32 + (rnd() - 0.5) * 0.1 : rnd() * Math.PI * 2;
    return {
      a: rnd() * Math.PI * 2,
      r,
      w: (0.1 + rnd() * 0.08) * Math.pow(1 / r, 1.5) * (disc ? 1 : rnd() < 0.5 ? -1 : 1),
      cosI: Math.cos(incl), sinI: Math.sin(incl), cosN: Math.cos(node), sinN: Math.sin(node),
      size: 2.2 + Math.pow(rnd(), 2.4) * 5,
      tint: rnd() < 0.55 ? rnd() * 0.35 : 0.35 + rnd() * 0.65,
      tw: 0.6 + rnd() * 1.8, ph: rnd() * Math.PI * 2,
      ox: 0, oy: 0, vx: 0, vy: 0,
    };
  });
}

export interface NebulaHandle {
  setMode(mode: NebulaMode): void;
  setRunning(on: boolean): void;
  setTilt(x: number, y: number): void;
  /** Pointer in orb units, or null when it leaves. */
  setPointer(p: { x: number; y: number } | null): void;
  ripple(x: number, y: number): void;
  resize(): void;
  destroy(): void;
}

/** Throws if WebGL is unavailable or a shader does not compile; the caller keeps the static orb. */
export function createNebula(canvas: HTMLCanvasElement, opts: NebulaOptions): NebulaHandle {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false, powerPreference: "low-power", failIfMajorPerformanceCaveat: true });
  if (!gl) throw new Error("webgl unavailable");
  const fieldUnits = BOX * opts.field;

  let orbProg: WebGLProgram, dustProg: WebGLProgram;
  let quad: WebGLBuffer, dustBuf: WebGLBuffer;
  let uo: Record<string, WebGLUniformLocation | null> = {};
  let ud: Record<string, WebGLUniformLocation | null> = {};
  let ad: Record<string, number> = {};
  let aOrb = 0;
  const dust = opts.particles ? makeDust(opts.lite ? 90 : 220) : [];
  const STRIDE = 5; // x, y, size, alpha, tint
  const dustData = new Float32Array(dust.length * STRIDE);
  const scratch = new Float32Array(dust.length * STRIDE);
  const backIdx: number[] = [];
  const frontIdx: number[] = [];

  const setup = () => {
    orbProg = link(gl, ORB_VERT, orbFrag(opts.lite ? 3 : 4));
    quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    aOrb = gl.getAttribLocation(orbProg, "aPos");
    uo = Object.fromEntries(["uField", "uTime", "uEnergy", "uGather", "uPulse", "uBreath", "uTilt", "uPointer", "uRipple"].map((n) => [n, gl.getUniformLocation(orbProg, n)]));
    if (dust.length) {
      dustProg = link(gl, DUST_VERT, DUST_FRAG);
      dustBuf = gl.createBuffer()!;
      ud = Object.fromEntries(["uField", "uPx"].map((n) => [n, gl.getUniformLocation(dustProg, n)]));
      ad = Object.fromEntries(["aPos", "aSize", "aAlpha", "aTint"].map((n) => [n, gl.getAttribLocation(dustProg, n)]));
    }
    gl.enable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
  };
  setup();

  // Eased state
  let mode: NebulaMode = "idle";
  const cur = { ...TARGETS.idle };
  let flowTime = 7.3; // start mid-flow so the first frame is already interesting
  let clock = 0;
  let breathPhase = 0;
  const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
  const ptr = { x: 0, y: 0, vx: 0, vy: 0, on: 0, target: 0, has: false };
  let ripple: { x: number; y: number; at: number } | null = null;
  let settleUntil = 0;
  let pxScale = 1;

  let raf = 0;
  let running = false;
  let last = 0;
  let lastDraw = 0;
  const frameMs = opts.lite ? 1000 / 30 : 1000 / 60;
  const slow: number[] = [];
  let lost = false;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, opts.lite ? 1 : 1.5);
    const scale = opts.lite ? 0.75 : 1;
    const w = Math.max(1, Math.round(rect.width * dpr * scale));
    const h = Math.max(1, Math.round(rect.height * dpr * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    pxScale = rect.width ? canvas.width / rect.width : 1;
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  /** Advances the motes and fills the vertex buffer, split into behind / in front of the sphere. */
  const stepDust = (dt: number) => {
    backIdx.length = 0;
    frontIdx.length = 0;
    const R = 0.86;
    const pv = Math.hypot(ptr.vx, ptr.vy);
    for (let i = 0; i < dust.length; i++) {
      const d = dust[i];
      d.a += d.w * dt * cur.speed;
      const r = R + (d.r - R) * cur.orbit;
      // ring point in 3D: (r cos a, r sin a cosI, r sin a sinI), then rotated by the node in-plane
      const x0 = r * Math.cos(d.a);
      const y0 = r * Math.sin(d.a) * d.cosI;
      const zDepth = r * Math.sin(d.a) * d.sinI;
      let x = x0 * d.cosN - y0 * d.sinN;
      let y = x0 * d.sinN + y0 * d.cosN;

      // pointer: part around it, follow its wake; then spring back to the ring
      if (ptr.on > 0.01 && dt > 0) {
        const dx = x + d.ox - ptr.x, dy = y + d.oy - ptr.y;
        const dist = Math.hypot(dx, dy);
        const reach = 0.5;
        if (dist < reach) {
          const k = Math.pow(1 - dist / reach, 2) * ptr.on;
          const nx = dx / (dist || 1), ny = dy / (dist || 1);
          d.vx += (nx * 2.4 - ny * 0.9) * k * dt * 3 + ptr.vx * k * 0.06 * Math.min(1, pv);
          d.vy += (ny * 2.4 + nx * 0.9) * k * dt * 3 + ptr.vy * k * 0.06 * Math.min(1, pv);
        }
      }
      if (ripple && dt > 0) {
        const age = (performance.now() - ripple.at) / 1000;
        if (age < 0.08) {
          const dx = x - ripple.x, dy = y - ripple.y;
          const dist = Math.hypot(dx, dy) || 1;
          const k = Math.max(0, 1 - dist / 1.4);
          d.vx += (dx / dist) * k * 0.9;
          d.vy += (dy / dist) * k * 0.9;
        }
      }
      d.vx += -d.ox * 5 * dt;
      d.vy += -d.oy * 5 * dt;
      const damp = Math.exp(-dt * 3.2);
      d.vx *= damp;
      d.vy *= damp;
      d.ox += d.vx * dt;
      d.oy += d.vy * dt;
      x += d.ox;
      y += d.oy;

      const twinkle = 0.55 + 0.45 * Math.sin(clock * d.tw + d.ph);
      // fade out near the sphere when gathering into it; dimmer when far
      const depthFade = 0.75 + 0.25 * Math.max(-1, Math.min(1, zDepth / r));
      const alpha = Math.min(1, 1.25 * twinkle * depthFade * cur.dust * (0.5 + 0.5 * cur.energy) * (1 + 0.5 * cur.pulse * twinkle));
      const o = i * STRIDE;
      dustData[o] = x;
      dustData[o + 1] = y;
      dustData[o + 2] = d.size * (zDepth > 0 ? 1.1 : 0.85);
      dustData[o + 3] = alpha;
      dustData[o + 4] = d.tint;
      (zDepth < 0 ? backIdx : frontIdx).push(i);
    }
  };

  const drawDust = (idx: number[]) => {
    if (!idx.length) return;
    // Gather the subset into a contiguous block (at most a few hundred floats; no per-frame allocation).
    idx.forEach((i, k) => scratch.set(dustData.subarray(i * STRIDE, i * STRIDE + STRIDE), k * STRIDE));
    gl.useProgram(dustProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, dustBuf);
    gl.bufferData(gl.ARRAY_BUFFER, scratch.subarray(0, idx.length * STRIDE), gl.DYNAMIC_DRAW);
    const f = 4;
    gl.enableVertexAttribArray(ad.aPos);
    gl.vertexAttribPointer(ad.aPos, 2, gl.FLOAT, false, STRIDE * f, 0);
    gl.enableVertexAttribArray(ad.aSize);
    gl.vertexAttribPointer(ad.aSize, 1, gl.FLOAT, false, STRIDE * f, 2 * f);
    gl.enableVertexAttribArray(ad.aAlpha);
    gl.vertexAttribPointer(ad.aAlpha, 1, gl.FLOAT, false, STRIDE * f, 3 * f);
    gl.enableVertexAttribArray(ad.aTint);
    gl.vertexAttribPointer(ad.aTint, 1, gl.FLOAT, false, STRIDE * f, 4 * f);
    gl.uniform1f(ud.uField, fieldUnits);
    gl.uniform1f(ud.uPx, pxScale);
    gl.blendFunc(gl.ONE, gl.ONE); // additive light
    gl.drawArrays(gl.POINTS, 0, idx.length);
    gl.disableVertexAttribArray(ad.aSize);
    gl.disableVertexAttribArray(ad.aAlpha);
    gl.disableVertexAttribArray(ad.aTint);
  };

  const drawOrb = (now: number) => {
    gl.useProgram(orbProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aOrb);
    gl.vertexAttribPointer(aOrb, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(uo.uField, fieldUnits);
    gl.uniform1f(uo.uTime, flowTime);
    gl.uniform1f(uo.uEnergy, cur.energy);
    gl.uniform1f(uo.uGather, cur.gather);
    gl.uniform1f(uo.uPulse, cur.pulse * (0.55 + 0.45 * Math.sin((now / 1000) * Math.PI * 1.6)));
    gl.uniform1f(uo.uBreath, Math.sin(breathPhase));
    gl.uniform2f(uo.uTilt, tilt.x, tilt.y);
    gl.uniform3f(uo.uPointer, ptr.x, ptr.y, ptr.on);
    gl.uniform3f(uo.uRipple, ripple?.x ?? 0, ripple?.y ?? 0, ripple ? (now - ripple.at) / 1000 : -1);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied "over": hides dust behind the sphere
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const draw = (now: number, dt: number) => {
    if (lost) return;
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (dust.length) stepDust(dt);
    if (dust.length) drawDust(backIdx);
    drawOrb(now);
    if (dust.length) drawDust(frontIdx);
  };

  const step = (now: number) => {
    raf = requestAnimationFrame(step);
    if (now - lastDraw < frameMs - 2) return;
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0.016);
    last = now;
    lastDraw = now;

    if (mode === "settle" && now > settleUntil) mode = "quiet";
    const target = TARGETS[mode];
    const k = 1 - Math.exp(-dt * (mode === "gather" ? 4 : 1.6));
    for (const key of ["energy", "gather", "pulse", "speed", "orbit", "dust"] as const) cur[key] += (target[key] - cur[key]) * k;
    flowTime += dt * cur.speed;
    clock += dt;
    breathPhase += dt * ((2 * Math.PI) / 9); // one breath every ~9 s
    tilt.x += (tilt.tx - tilt.x) * Math.min(1, dt * 3);
    tilt.y += (tilt.ty - tilt.y) * Math.min(1, dt * 3);
    ptr.on += (ptr.target - ptr.on) * Math.min(1, dt * 4);
    ptr.vx *= Math.exp(-dt * 6);
    ptr.vy *= Math.exp(-dt * 6);
    if (ripple && now - ripple.at > 2500) ripple = null;

    draw(now, dt);
    // Performance guard: if even the lite path can't hold ~20 fps, stop animating (the caller
    // switches to the static orb). Desktop keeps running; it only has a 60 fps cap.
    if (opts.lite) {
      slow.push(dt);
      if (slow.length > 90) slow.shift();
      if (slow.length === 90 && slow.reduce((a, b) => a + b, 0) / 90 > 0.05) {
        stop();
        opts.onFail("slow");
      }
    }
  };

  function start() {
    if (running || lost) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(step);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  const onLost = (e: Event) => {
    e.preventDefault();
    lost = true;
    stop();
    opts.onFail("context-lost");
  };
  canvas.addEventListener("webglcontextlost", onLost);

  resize();
  draw(performance.now(), 0);

  return {
    setMode(next) {
      mode = next;
      if (next === "settle") settleUntil = performance.now() + 1600;
      if (opts.still) {
        Object.assign(cur, TARGETS[next === "settle" ? "quiet" : next]);
        draw(performance.now(), 0);
      }
    },
    setRunning(on) {
      if (opts.still) return draw(performance.now(), 0);
      if (on) start();
      else stop();
    },
    setTilt(x, y) {
      tilt.tx = x;
      tilt.ty = y;
    },
    setPointer(p) {
      if (opts.still) return;
      if (!p) {
        ptr.target = 0;
        ptr.has = false;
        return;
      }
      if (ptr.has) {
        ptr.vx = ptr.vx * 0.5 + (p.x - ptr.x) * 30;
        ptr.vy = ptr.vy * 0.5 + (p.y - ptr.y) * 30;
      }
      ptr.x = p.x;
      ptr.y = p.y;
      ptr.has = true;
      // present while it is over the orb or the dust around it
      ptr.target = Math.hypot(p.x, p.y) < fieldUnits ? 1 : 0;
    },
    ripple(x, y) {
      if (opts.still) return;
      ripple = { x, y, at: performance.now() };
    },
    resize() {
      resize();
      if (!running) draw(performance.now(), 0);
    },
    destroy() {
      stop();
      canvas.removeEventListener("webglcontextlost", onLost);
      try {
        gl.deleteBuffer(quad);
        gl.deleteProgram(orbProg);
        if (dust.length) {
          gl.deleteBuffer(dustBuf);
          gl.deleteProgram(dustProg);
        }
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {
        /* already gone */
      }
    },
  };
}

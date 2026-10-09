"use client";
// WebGL canvas for the home orb, ported from the team's Figma Make prototype
// (github.com/KimChen001/Moona, src/app/components/ShaderCanvas.tsx). Same rendering and uniforms.
// Added for the real site: pauses when off-screen or in a background tab, renders a single still
// frame when motion is reduced, reports failure so the page can show a static orb instead, and takes a
// speed (the small orbs on inner pages run faster while something real is happening).
import { useEffect, useRef, type MouseEvent } from "react";
import { etherShader, vertexShader } from "./shaders";

interface ShaderCanvasProps {
  size?: number;
  /** One still frame instead of an animation (reduced motion). */
  still?: boolean;
  /** Animation speed (1 = the prototype's pace); changes apply smoothly without restarting. */
  speed?: number;
  onFail?: () => void;
}

export const ShaderCanvas = ({ size = 600, still = false, speed = 1, onFail }: ShaderCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mousePositionRef = useRef<[number, number]>([0.5, 0.5]);
  const speedRef = useRef(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl");
    if (!gl) {
      onFail?.();
      return;
    }

    const program = initShaderProgram(gl, vertexShader, etherShader);
    if (!program) {
      onFail?.();
      return;
    }
    const attrib = { position: gl.getAttribLocation(program, "aVertexPosition"), texture: gl.getAttribLocation(program, "aTextureCoord") };
    const uni = {
      iResolution: gl.getUniformLocation(program, "iResolution"),
      iTime: gl.getUniformLocation(program, "iTime"),
      iMouse: gl.getUniformLocation(program, "iMouse"),
      hasActiveReminders: gl.getUniformLocation(program, "hasActiveReminders"),
      hasUpcomingReminders: gl.getUniformLocation(program, "hasUpcomingReminders"),
      disableCenterDimming: gl.getUniformLocation(program, "disableCenterDimming"),
    };
    const buffers = initBuffers(gl);

    canvas.width = size;
    canvas.height = size;
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Start a little into the animation so a still frame already shows the luminous band. Time advances
    // by speed x elapsed, so a speed change never jumps the picture.
    let time = 6;
    let last = performance.now();
    let raf = 0;
    let visible = true;
    let pageVisible = document.visibilityState === "visible";

    const draw = () => {
      const now = performance.now();
      time += (Math.min(now - last, 100) / 1000) * speedRef.current;
      last = now;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform2f(uni.iResolution, canvas.width, canvas.height);
      gl.uniform1f(uni.iTime, time);
      gl.uniform2f(uni.iMouse, mousePositionRef.current[0], mousePositionRef.current[1]);
      gl.uniform1i(uni.hasActiveReminders, 0);
      gl.uniform1i(uni.hasUpcomingReminders, 0);
      gl.uniform1i(uni.disableCenterDimming, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
      gl.vertexAttribPointer(attrib.position, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(attrib.position);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.texture);
      gl.vertexAttribPointer(attrib.texture, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(attrib.texture);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers.indices);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    const sync = () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      if (still) draw();
      else if (visible && pageVisible) raf = requestAnimationFrame(loop);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      sync();
    });
    io.observe(canvas);
    const onVis = () => {
      pageVisible = document.visibilityState === "visible";
      sync();
    };
    document.addEventListener("visibilitychange", onVis);
    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
      onFail?.();
    };
    canvas.addEventListener("webglcontextlost", onLost);
    draw();
    sync();

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("webglcontextlost", onLost);
      gl.deleteProgram(program);
      gl.deleteBuffer(buffers.position);
      gl.deleteBuffer(buffers.texture);
      gl.deleteBuffer(buffers.indices);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onFail is a stable callback from the caller
  }, [size, still]);

  // Track the pointer relative to the canvas without re-rendering.
  const handleMouseMove = (e: MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mousePositionRef.current = [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
  };

  return (
    <canvas
      ref={canvasRef}
      className="rounded-full"
      style={{ width: size, height: size, display: "block" }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => (mousePositionRef.current = [0.5, 0.5])}
      aria-hidden="true"
    />
  );
};

function initShaderProgram(gl: WebGLRenderingContext, vsSource: string, fsSource: string) {
  const vs = loadShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = loadShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  return program;
}

function loadShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function initBuffers(gl: WebGLRenderingContext) {
  const position = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, position);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  const texture = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, texture);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
  const indices = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  return { position, texture, indices };
}

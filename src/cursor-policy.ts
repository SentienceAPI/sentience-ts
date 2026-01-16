export type CursorMode = 'instant' | 'human';

/**
 * Policy for cursor movement.
 *
 * - mode="instant": current behavior (single click without multi-step motion)
 * - mode="human": move with a curved path + optional jitter/overshoot
 */
export interface CursorPolicy {
  mode: CursorMode;
  steps?: number;
  durationMs?: number;
  jitterPx?: number;
  overshootPx?: number;
  pauseBeforeClickMs?: number;
  /** Determinism hook for tests/repro */
  seed?: number;
}

export interface CursorPathPoint {
  x: number;
  y: number;
  t?: number;
}

export interface CursorMovementMetadata {
  mode: CursorMode;
  from: { x: number; y: number };
  to: { x: number; y: number };
  steps: number;
  duration_ms: number;
  pause_before_click_ms: number;
  jitter_px: number;
  overshoot_px: number;
  path: CursorPathPoint[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

function bezier(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number
): [number, number] {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  const x = uuu * p0[0] + 3 * uu * t * p1[0] + 3 * u * tt * p2[0] + ttt * p3[0];
  const y = uuu * p0[1] + 3 * uu * t * p1[1] + 3 * u * tt * p2[1] + ttt * p3[1];
  return [x, y];
}

// Simple seeded RNG for reproducibility (mulberry32)
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randBetween(rng: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export function buildHumanCursorPath(
  start: [number, number],
  target: [number, number],
  policy: CursorPolicy
): CursorMovementMetadata {
  const seed = policy.seed ?? Date.now() & 0xffffffff;
  const rng = mulberry32(seed);

  const [x0, y0] = start;
  const [x1, y1] = target;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist0 = Math.hypot(dx, dy);
  const dist = dist0 < 1e-6 ? 1 : dist0;

  const steps = Math.floor(policy.steps ?? clamp(10 + dist / 25, 12, 40));
  const durationMs = Math.floor(policy.durationMs ?? clamp(120 + dist * 0.9, 120, 700));

  const ux = dx / dist;
  const uy = dy / dist;
  const px = -uy;
  const py = ux;

  let curveMag = clamp(dist / 3.5, 10, 140);
  curveMag *= randBetween(rng, 0.5, 1.2);

  const c1: [number, number] = [x0 + dx * 0.25 + px * curveMag, y0 + dy * 0.25 + py * curveMag];
  const c2: [number, number] = [x0 + dx * 0.75 - px * curveMag, y0 + dy * 0.75 - py * curveMag];

  const overshoot = policy.overshootPx ?? 6.0;
  const overshootPoint: [number, number] =
    overshoot > 0 ? [x1 + ux * overshoot, y1 + uy * overshoot] : [x1, y1];

  const jitterPx = policy.jitterPx ?? 1.0;
  const pts: CursorPathPoint[] = [];

  for (let i = 0; i < steps; i++) {
    const tRaw = steps <= 1 ? 0 : i / (steps - 1);
    const t = easeInOut(tRaw);
    const [bx, by] = bezier([x0, y0], c1, c2, overshootPoint, t);
    const jitterScale = jitterPx * (1 - tRaw) * 0.9;
    const jx = randBetween(rng, -jitterScale, jitterScale);
    const jy = randBetween(rng, -jitterScale, jitterScale);
    pts.push({ x: bx + jx, y: by + jy, t: Math.round(tRaw * 10_000) / 10_000 });
  }

  if (overshoot > 0) {
    pts.push({ x: x1, y: y1, t: 1.0 });
  }

  return {
    mode: 'human',
    from: { x: x0, y: y0 },
    to: { x: x1, y: y1 },
    steps,
    duration_ms: durationMs,
    pause_before_click_ms: policy.pauseBeforeClickMs ?? 20,
    jitter_px: jitterPx,
    overshoot_px: overshoot,
    path: pts.slice(0, 64),
  };
}

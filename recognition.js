// Gesture recognition on MediaPipe hand landmarks.
// Each hand gets a short history; decisions are made on that history, not on
// single frames, so blur and brief tracking losses don't flip the result.

const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Landmarks with y rescaled so x and y share the same unit.
export function toScreen(points, aspect = 1) {
  return points.map(p => ({ x: p.x, y: p.y / aspect }));
}

export const palmSize = p => Math.max(d2(p[0], p[9]), d2(p[5], p[17]));

// A finger counts as extended when its tip is clearly farther from the wrist
// than its middle joint. Works at any hand rotation.
function extendedFingers(p) {
  return [[8, 6], [12, 10], [16, 14], [20, 18]].map(([tip, pip]) => d2(p[0], p[tip]) > d2(p[0], p[pip]) * 1.12);
}

// Per-frame pose: 'FIST' | 'OPEN' | 'V' | 'POINT' | null.
// The trained classifier is trusted first; geometry is the fallback.
export function handPose(p, categories = []) {
  const top = categories[0];
  if (top && top.score >= 0.5) {
    if (top.categoryName === 'Closed_Fist') return 'FIST';
    if (top.categoryName === 'Open_Palm') return 'OPEN';
    if (top.categoryName === 'Victory') return 'V';
    if (top.categoryName === 'Pointing_Up') return 'POINT';
    if (top.categoryName !== 'None') return null; // thumbs up/down, ILoveYou
  }
  const [index, middle, ring, pinky] = extendedFingers(p);
  if (index && middle && ring && pinky) return 'OPEN';
  if (index && middle && !ring && !pinky) return 'V';
  if (index && !middle && !ring && !pinky) return 'POINT';
  if (!index && !middle && !ring && !pinky) return 'FIST';
  return null;
}

// Two hands forming a big heart: index tips touch at the top, thumb tips
// touch at the bottom, wrists apart on either side.
export function isHeart(a, b) {
  if (!a || !b) return false;
  const palm = (palmSize(a) + palmSize(b)) / 2;
  if (palm < 0.02) return false;
  const top = d2(a[8], b[8]), bottom = d2(a[4], b[4]);
  if (top > palm * 0.9 || bottom > palm * 0.9) return false;
  // The heart must have an opening: tips meeting points separated.
  const indexMid = { x: (a[8].x + b[8].x) / 2, y: (a[8].y + b[8].y) / 2 };
  const thumbMid = { x: (a[4].x + b[4].x) / 2, y: (a[4].y + b[4].y) / 2 };
  if (d2(indexMid, thumbMid) < palm * 0.5 || indexMid.y > thumbMid.y) return false;
  // Knuckles and wrists spread apart to form the lobes; praying hands
  // touch tips the same way but keep their palms together.
  return d2(a[5], b[5]) > palm * 0.95 && Math.abs(a[0].x - b[0].x) > palm * 1.5;
}

// Counts back-and-forth swings of a value over time.
function swings(samples, key, minStep) {
  let turns = 0, dir = 0, anchor = samples[0][key];
  for (const s of samples) {
    const delta = s[key] - anchor;
    if (Math.abs(delta) < minStep) continue;
    const next = Math.sign(delta);
    if (dir && next !== dir) turns++;
    dir = next; anchor = s[key];
  }
  return turns;
}

const WINDOW = 1200;

export class HandTrack {
  constructor() { this.samples = []; }
  reset() { this.samples = []; }
  push(p, pose, at) {
    this.samples.push({ at, pose, x: (p[0].x + p[9].x) / 2, y: (p[0].y + p[9].y) / 2, palm: palmSize(p) });
    this.samples = this.samples.filter(s => at - s.at <= WINDOW);
  }
  share(pose, since) {
    const recent = this.samples.filter(s => s.at >= since);
    return recent.length ? recent.filter(s => s.pose === pose).length / recent.length : 0;
  }
  // Movement along `axis` with at least one reversal, mostly in `pose`.
  shaking(pose, axis, at) {
    const s = this.samples;
    if (s.length < 5 || at - s[0].at < 400) return false;
    if (this.share(pose, at - WINDOW) < 0.5) return false;
    const palm = s.reduce((n, v) => n + v.palm, 0) / s.length;
    const other = axis === 'x' ? 'y' : 'x';
    const span = k => Math.max(...s.map(v => v[k])) - Math.min(...s.map(v => v[k]));
    if (span(axis) < palm * 0.35 || span(axis) < span(other) * 1.1) return false;
    return swings(s, axis, palm * 0.15) >= 1;
  }
  // Held still in `pose` for `ms`.
  holding(pose, at, ms) {
    const s = this.samples.filter(v => at - v.at <= ms);
    if (s.length < 3 || at - s[0].at < ms * 0.7) return false;
    return this.share(pose, at - ms) >= 0.7;
  }
}

// Combines both hands into one gesture: TOMATO > PICTURE > HI > RSP (raised index).
export class GestureEngine {
  constructor() { this.tracks = [new HandTrack(), new HandTrack()]; this.heartSince = null; this.heartLast = null; }
  reset() { this.tracks.forEach(t => t.reset()); this.heartSince = null; this.heartLast = null; }
  // Keeps each physical hand on the same track between frames.
  assign(hands) {
    if (hands.length === 2) {
      const order = hands[0].points[0].x <= hands[1].points[0].x ? [0, 1] : [1, 0];
      hands.forEach((h, i) => { h.slot = order[i]; });
    } else if (hands.length === 1) {
      const w = hands[0].points[0];
      const gap = t => t.samples.length ? Math.hypot(t.samples.at(-1).x - w.x, t.samples.at(-1).y - w.y) : Infinity;
      hands[0].slot = gap(this.tracks[1]) < gap(this.tracks[0]) ? 1 : 0;
    }
    return hands;
  }
  update(hands, at) {
    // hands: [{points, categories}] with points in screen units.
    this.assign(hands);
    const seen = new Set(hands.map(h => h.slot));
    this.tracks.forEach((t, i) => { if (!seen.has(i)) t.reset(); });

    const heartNow = hands.length === 2 && isHeart(hands[0].points, hands[1].points);
    if (heartNow) { this.heartSince ??= at; this.heartLast = at; }
    else if (this.heartLast === null || at - this.heartLast > 300) this.heartSince = null;
    // Two hands close together are a heart in progress, not single-hand gestures.
    const twoClose = hands.length === 2 && d2(hands[0].points[0], hands[1].points[0]) < (palmSize(hands[0].points) + palmSize(hands[1].points)) * 1.8;
    if (this.heartSince !== null) {
      this.tracks.forEach(t => t.reset());
      return { gesture: at - this.heartSince >= 400 ? 'TOMATO' : null, poses: ['HEART'] };
    }

    const poses = [];
    for (const h of hands) {
      const pose = twoClose ? null : handPose(h.points, h.categories);
      poses.push(pose);
      this.tracks[h.slot].push(h.points, pose, at);
    }
    if (twoClose) return { gesture: null, poses };
    const any = test => this.tracks.some(test);
    if (any(t => t.holding('V', at, 450))) return { gesture: 'PICTURE', poses };
    if (any(t => t.shaking('OPEN', 'x', at))) return { gesture: 'HI', poses };
    // Index finger raised (a resting fist is too easy to make by accident).
    if (any(t => t.holding('POINT', at, 500))) return { gesture: 'RSP', poses };
    return { gesture: null, poses };
  }
}

// Face roughly toward the camera: nose between the eyes, head level.
export function isAttentive(p) {
  if (!p || p.length < 300) return false;
  const eyeSpan = d2(p[33], p[263]);
  if (eyeSpan < 0.03) return false;
  const centerX = (p[33].x + p[263].x) / 2;
  return Math.abs(p[1].x - centerX) / eyeSpan < 0.35 && Math.abs(p[33].y - p[263].y) / eyeSpan < 0.4;
}

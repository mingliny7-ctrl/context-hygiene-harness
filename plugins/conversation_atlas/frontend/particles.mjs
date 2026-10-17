/**
 * Ambient canvas for the Atlas graph. Positions come from the graph layout;
 * this renderer has no knowledge of categories, conversations, or segments.
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TAU = Math.PI * 2;
const WHITE = [219, 234, 230];
const AMBER = [226, 184, 105];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

function random(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let next = Math.imul(value ^ value >>> 15, 1 | value);
    next ^= next + Math.imul(next ^ next >>> 7, 61 | next);
    return ((next ^ next >>> 14) >>> 0) / 4294967296;
  };
}

function colorChannels(color) {
  if (typeof color !== 'string') return [129, 160, 151];
  const hex = color.replace('#', '');
  if (/^[a-f\d]{3}$/i.test(hex)) return hex.split('').map((part) => parseInt(part + part, 16));
  if (/^[a-f\d]{6}$/i.test(hex)) return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  return [129, 160, 151];
}

function rgba(channels, alpha) {
  return `rgba(${channels[0]},${channels[1]},${channels[2]},${clamp(alpha, 0, 1)})`;
}

/** Fibonacci shells with a little variation preserve a sphere without a solid surface. */
function createSphere(count, seed) {
  const next = random(seed);
  const points = Array.from({ length: count }, (_, index) => {
    const y = 1 - 2 * (index + 0.5) / count;
    const ring = Math.sqrt(1 - y * y);
    const angle = index * GOLDEN_ANGLE;
    const shell = next() > 0.23 ? 0.91 + next() * 0.09 : 0.28 + next() * 0.59;
    const x = Math.cos(angle) * ring * shell;
    const py = y * shell;
    const z = Math.sin(angle) * ring * shell;
    const knots = [[-0.43, -0.42, 0.58], [0.5, 0.12, 0.52], [-0.02, 0.61, 0.49]];
    const knot = Math.max(...knots.map(([kx, ky, kz]) =>
      Math.max(0, 1 - Math.sqrt((x - kx) ** 2 + (py - ky) ** 2 + (z - kz) ** 2) / 0.52)));
    return {
      x,
      y: py,
      z,
      size: 0.34 + next() * 0.68,
      shimmer: next() * TAU,
      warm: next() > 0.84,
      knot,
    };
  });

  // Build bounded local edges once, using spatial buckets. Frames only project
  // and draw this list, so mesh work never becomes an all-pairs animation loop.
  const cellSize = 0.22;
  const buckets = new Map();
  const cell = (point) => [point.x, point.y, point.z].map((axis) => Math.floor(axis / cellSize));
  const key = (x, y, z) => `${x}:${y}:${z}`;
  points.forEach((point, index) => {
    const [x, y, z] = cell(point);
    const bucketKey = key(x, y, z);
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(index);
  });
  const edges = [];
  points.forEach((point, index) => {
    const [cx, cy, cz] = cell(point);
    const candidates = [];
    for (let x = cx - 1; x <= cx + 1; x += 1) {
      for (let y = cy - 1; y <= cy + 1; y += 1) {
        for (let z = cz - 1; z <= cz + 1; z += 1) {
          for (const otherIndex of buckets.get(key(x, y, z)) || []) {
            if (otherIndex <= index) continue;
            const other = points[otherIndex];
            const distance = (point.x - other.x) ** 2 + (point.y - other.y) ** 2 + (point.z - other.z) ** 2;
            if (distance < cellSize ** 2) candidates.push({ index: otherIndex, distance });
          }
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    candidates.slice(0, 2).forEach((candidate) => edges.push([index, candidate.index]));
  });
  return { points, edges, projected: points.map(() => ({ x: 0, y: 0, z: 0, scale: 1 })) };
}

export class ParticleField {
  constructor(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('ParticleField requires a canvas element.');
    }
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    if (!this.context) throw new Error('Atlas could not initialize its particle canvas.');
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.core = null;
    this.satellites = new Map();
    this.paused = false;
    this.destroyed = false;
    this.frame = null;
    this.lastTime = null;
    this.time = 0;
    this.coreSphere = createSphere(610, 31416);
    this.satelliteSphere = createSphere(210, 27182);
    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.motionQuery.matches;
    const next = random(16180);
    this.dust = Array.from({ length: 170 }, () => ({
      x: next(), y: next(), size: 0.3 + next() * 0.65,
      opacity: 0.045 + next() * 0.15, phase: next() * TAU, warm: next() > 0.86,
    }));

    Object.assign(canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', display: 'block',
    });
    canvas.setAttribute('aria-hidden', 'true');
    this.onMotionChange = (event) => {
      this.reducedMotion = event.matches;
      this.syncAnimation();
    };
    this.onVisibilityChange = () => this.syncAnimation();
    this.onWindowResize = () => this.resize();
    this.motionQuery.addEventListener('change', this.onMotionChange);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('resize', this.onWindowResize);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  setCore({ x, y, radius = 78, opacity = 1, homeSky = false }) {
    if (this.destroyed) return;
    const target = {
      x: finite(x, this.width / 2), y: finite(y, this.height / 2),
      radius: Math.max(0, finite(radius, 78)), opacity: clamp(finite(opacity, 1), 0, 1),
    };
    if (!this.core) this.core = { ...target, target };
    else this.core.target = target;
    this.core.homeSky = Boolean(homeSky);
    this.syncAnimation();
  }

  setSatellites(satellites = []) {
    if (this.destroyed) return;
    const activeIds = new Set();
    satellites.forEach((satellite) => {
      if (satellite.id === undefined || satellite.id === null) return;
      activeIds.add(satellite.id);
      const target = {
        x: finite(satellite.x, this.width / 2), y: finite(satellite.y, this.height / 2),
        radius: Math.max(0, finite(satellite.radius, 24)),
        opacity: clamp(finite(satellite.opacity, 1), 0, 1),
      };
      let current = this.satellites.get(satellite.id);
      if (!current) {
        current = { ...target, opacity: 0, target, color: colorChannels(satellite.color), exiting: false };
        this.satellites.set(satellite.id, current);
      } else {
        current.target = target;
        current.color = colorChannels(satellite.color);
        current.exiting = false;
      }
      current.corona = Boolean(satellite.corona);
    });
    this.satellites.forEach((satellite, id) => {
      if (!activeIds.has(id)) {
        satellite.target = { ...satellite.target, opacity: 0 };
        satellite.exiting = true;
      }
    });
    this.syncAnimation();
  }

  setPaused(paused) {
    if (this.destroyed) return;
    this.paused = Boolean(paused);
    this.syncAnimation();
  }

  get canAnimate() {
    return !this.destroyed && !this.paused && !this.reducedMotion && !document.hidden && this.width > 0 && this.height > 0;
  }

  resize() {
    if (this.destroyed) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (width !== this.width || height !== this.height || dpr !== this.dpr) {
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.syncAnimation();
  }

  syncAnimation() {
    if (this.destroyed) return;
    if (!this.canAnimate) {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      this.lastTime = null;
      this.updatePositions(1);
      this.render();
    } else if (this.frame === null) {
      this.render();
      this.frame = requestAnimationFrame((time) => this.tick(time));
    }
  }

  tick(timestamp) {
    this.frame = null;
    if (!this.canAnimate) return;
    const elapsed = this.lastTime === null ? 1 / 60 : clamp((timestamp - this.lastTime) / 1000, 0, 0.05);
    this.lastTime = timestamp;
    this.time += elapsed;
    this.updatePositions(1 - Math.exp(-elapsed / 0.17));
    this.render();
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }

  updatePositions(amount) {
    const update = (node) => {
      for (const property of ['x', 'y', 'radius', 'opacity']) {
        node[property] += (node.target[property] - node[property]) * amount;
        if (Math.abs(node.target[property] - node[property]) < 0.001) node[property] = node.target[property];
      }
    };
    if (this.core) update(this.core);
    this.satellites.forEach((satellite, id) => {
      update(satellite);
      if (satellite.exiting && satellite.opacity < 0.002) this.satellites.delete(id);
    });
  }

  render() {
    const ctx = this.context;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.width || !this.height) return;
    for (const star of this.dust) {
      const opacity = star.opacity * (0.84 + Math.sin(this.time * 0.32 + star.phase) * 0.16);
      ctx.fillStyle = rgba(star.warm ? AMBER : WHITE, opacity);
      ctx.beginPath();
      ctx.arc(star.x * this.width, star.y * this.height, star.size, 0, TAU);
      ctx.fill();
    }
    for (const satellite of this.satellites.values()) {
      this.drawSphere(satellite, this.satelliteSphere, satellite.color, false);
    }
    if (this.core) this.drawSphere(this.core, this.coreSphere, WHITE, true);
  }

  drawSphere(node, sphere, color, isCore) {
    if (node.opacity < 0.002 || node.radius < 0.5) return;
    const ctx = this.context;
    const opacity = node.opacity;
    if (node.homeSky || node.corona) this.drawCorona(node, color, isCore);
    const filamentColor = isCore ? color : color.map((channel, index) => Math.round(channel * 0.3 + WHITE[index] * 0.7));
    const angle = this.time * (isCore ? 0.085 : 0.055) + (isCore ? 0 : node.x * 0.003);
    const tilt = 0.24 + Math.sin(this.time * 0.065) * 0.11;
    const cosY = Math.cos(angle);
    const sinY = Math.sin(angle);
    const cosX = Math.cos(tilt);
    const sinX = Math.sin(tilt);
    sphere.points.forEach((point, index) => {
      const rotatedX = point.x * cosY - point.z * sinY;
      const rotatedZ = point.x * sinY + point.z * cosY;
      const rotatedY = point.y * cosX - rotatedZ * sinX;
      const z = point.y * sinX + rotatedZ * cosX;
      const scale = 1 + z * 0.13;
      const projected = sphere.projected[index];
      projected.x = node.x + rotatedX * node.radius * scale;
      projected.y = node.y + rotatedY * node.radius * scale;
      projected.z = z;
      projected.scale = scale;
    });

    if (isCore) {
      // A transparent aura and sparse central sparks, never an opaque disk.
      const glow = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, node.radius * 1.6);
      glow.addColorStop(0, rgba(AMBER, 0.055 * opacity));
      glow.addColorStop(0.42, rgba(AMBER, 0.045 * opacity));
      glow.addColorStop(0.72, rgba(color, 0.018 * opacity));
      glow.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(node.x - node.radius * 1.6, node.y - node.radius * 1.6, node.radius * 3.2, node.radius * 3.2);
    }

    ctx.lineWidth = isCore ? 0.45 : 0.4;
    for (const [first, second] of sphere.edges) {
      const a = sphere.projected[first];
      const b = sphere.projected[second];
      const depth = (a.z + b.z + 2) / 4;
      ctx.strokeStyle = rgba(filamentColor, (isCore ? (node.homeSky ? 0.10 + depth * 0.25 : 0.065 + depth * 0.19) : 0.12 + depth * 0.29) * opacity);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    if (isCore) {
      // Three coherent amber knots travel with the same 3D sphere. Layering
      // their short existing mesh edges gives a luminous filament, while the
      // gaps between knots keep the core transparent and dimensional.
      for (const [first, second] of sphere.edges) {
        const strength = Math.min(sphere.points[first].knot, sphere.points[second].knot);
        if (strength < 0.18) continue;
        const a = sphere.projected[first];
        const b = sphere.projected[second];
        const depth = clamp((a.z + b.z + 2) / 4, 0.1, 1);
        const light = (0.4 + strength * 0.6) * depth * opacity;
        const trace = () => {
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        };
        ctx.lineWidth = 4;
        ctx.strokeStyle = rgba(AMBER, light * 0.13);
        trace();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = rgba([255, 194, 92], light * 0.92);
        trace();
        ctx.lineWidth = 0.45;
        ctx.strokeStyle = rgba([255, 246, 218], light);
        trace();
      }
    }

    // Draw the rear hemisphere before the front for a subtle depth hierarchy.
    for (let layer = 0; layer < 2; layer += 1) {
      sphere.points.forEach((point, index) => {
        const projected = sphere.projected[index];
        if ((projected.z >= 0 ? 1 : 0) !== layer) return;
        const depth = (projected.z + 1) / 2;
        const shimmer = 0.88 + Math.sin(this.time * 0.65 + point.shimmer) * 0.12;
        const brightness = (isCore ? 0.22 + depth * 0.78 : 0.25 + depth * 0.7) * opacity * shimmer;
        const channels = isCore && (point.warm || point.knot > 0.18) ? AMBER : filamentColor;
        const size = point.size * (isCore ? 1.12 : 0.85) * projected.scale;
        ctx.fillStyle = rgba(channels, brightness);
        ctx.beginPath();
        ctx.arc(projected.x, projected.y, size, 0, TAU);
        ctx.fill();
        if (isCore && point.knot > 0.22 && depth > 0.5) {
          ctx.fillStyle = rgba(AMBER, 0.13 * opacity);
          ctx.beginPath();
          ctx.arc(projected.x, projected.y, size * (3.5 + point.knot * 3), 0, TAU);
          ctx.fill();
          ctx.fillStyle = rgba([255, 246, 218], brightness * 0.95);
          ctx.beginPath();
          ctx.arc(projected.x, projected.y, size * (0.9 + point.knot * 0.5), 0, TAU);
          ctx.fill();
        }
      });
    }
  }

  drawCorona(node, color, isCore) {
    // Bounded, deterministic filaments in the existing RAF, not a new physics simulation.
    const ctx = this.context;
    const count = isCore ? 110 : 24;
    const glow = ctx.createRadialGradient(node.x, node.y, node.radius * .5, node.x, node.y, node.radius * 2.1);
    glow.addColorStop(0, rgba(color, .075 * node.opacity));
    glow.addColorStop(.4, rgba(color, .035 * node.opacity));
    glow.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(node.x - node.radius * 2.1, node.y - node.radius * 2.1, node.radius * 4.2, node.radius * 4.2);
    for (let i = 0; i < count; i += 1) {
      const angle = i * GOLDEN_ANGLE + this.time * .018;
      const spread = 1.07 + (Math.sin(i * 12.73) + 1) * (isCore ? .52 : .28);
      const x = node.x + Math.cos(angle) * node.radius * spread;
      const y = node.y + Math.sin(angle) * node.radius * spread * .78;
      const shimmer = .65 + Math.sin(this.time * .45 + i) * .15;
      ctx.fillStyle = rgba(color, (.16 + (i % 7) * .045) * node.opacity * shimmer);
      ctx.beginPath(); ctx.arc(x, y, i % 9 === 0 ? 1.35 : .65, 0, TAU); ctx.fill();
      if (i % 3 === 0) {
        ctx.strokeStyle = rgba(color, .11 * node.opacity);
        ctx.lineWidth = .45;
        ctx.beginPath();
        ctx.moveTo(node.x + Math.cos(angle - .13) * node.radius * .92, node.y + Math.sin(angle - .13) * node.radius * .92);
        ctx.lineTo(x,y);ctx.stroke();
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.resizeObserver.disconnect();
    this.motionQuery.removeEventListener('change', this.onMotionChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('resize', this.onWindowResize);
    this.satellites.clear();
    this.context.clearRect(0, 0, this.width, this.height);
  }
}

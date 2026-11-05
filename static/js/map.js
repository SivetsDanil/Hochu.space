// Карта на тайлах OpenStreetMap без сторонних библиотек: перетаскивание мышью и пальцем, колесо, щипок,
// двойной клик, кнопки масштаба, метки с группировкой и плавный перелёт.
// Проекция Web Mercator: «мир» — квадрат x, y ∈ [0, 1), на зуме z он занимает 256·2^z пикселей.
import { h, icon } from './ui.js';

const TILE = 256;
const MIN_ZOOM = 2;
const MAX_ZOOM = 19;
const CLUSTER_PX = 58;          // метки ближе этого на экране собираются в кружок с числом
const tileUrl = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = x => x - Math.floor(x);
export const lonToX = lon => (lon + 180) / 360;
export const latToY = lat => {
  const s = Math.sin(clamp(lat, -85.0511, 85.0511) * Math.PI / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export const xToLon = x => wrap(x) * 360 - 180;
export const yToLat = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
const ease = t => 1 - (1 - t) ** 3;

export class MapView {
  /**
   * el — контейнер с размерами; lat, lon, zoom — начальный вид;
   * onMove(view) — после остановки карты; onClick({lat, lon}) — клик по пустому месту;
   * onCluster(items) — клик по кружку, когда приближать дальше некуда (несколько групп в одном доме).
   */
  constructor(el, { lat = 55.751, lon = 37.618, zoom = 10, onMove, onClick, onCluster } = {}) {
    this.el = el;
    this.cx = wrap(lonToX(lon));
    this.cy = latToY(lat);
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.onMove = onMove;
    this.onClick = onClick;
    this.onCluster = onCluster;
    this.tiles = new Map();              // 'z/x/y' → {img, z, x, y, loaded}
    this.items = [];                     // метки: {lat, lon, render(), onClick()}
    this.marks = [];                     // то, что сейчас нарисовано: {x, y, el}
    this.clusterKey = null;
    this.pointers = new Map();
    this.dragged = false;

    this.tilesEl = h('div.map-tiles');
    this.marksEl = h('div.map-marks');
    this.controlsEl = h('div.map-controls',
      h('button.map-btn', { title: 'Приблизить', onclick: () => this.zoomBy(1) }, icon('plus')),
      h('button.map-btn', { title: 'Отдалить', onclick: () => this.zoomBy(-1) }, icon('minus')));
    el.classList.add('map');
    el.append(this.tilesEl, this.marksEl, this.controlsEl,
      h('div.map-attrib', '© ', h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'участники OpenStreetMap')));

    this.onDown = this.onDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onUp = this.onUp.bind(this);
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    el.addEventListener('dblclick', e => {
      if (e.target.closest('.map-controls, .map-mark, .map-attrib')) return;
      const [px, py] = this.local(e);
      this.animateZoom(px, py, Math.round(this.zoom) + (e.shiftKey ? -1 : 1));
    });
    el.addEventListener('click', e => {
      if (this.dragged || e.target.closest('.map-controls, .map-mark, .map-attrib')) return;
      const [px, py] = this.local(e);
      if (this.onClick) this.onClick(this.latLonAt(px, py));
    });
    this.ro = new ResizeObserver(() => this.render(true));
    this.ro.observe(el);
    this.render();
  }

  destroy() {
    this.dead = true;
    this.ro.disconnect();
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.anim);
    clearTimeout(this.moveTimer);
  }

  /* ---------------- координаты ---------------- */

  get w() { return this.el.clientWidth; }
  get h() { return this.el.clientHeight; }
  worldSize() { return TILE * 2 ** this.zoom; }

  local(e) {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Точка мира → пиксели экрана (берём ближайшую «копию» мира по горизонтали). */
  toScreen(x, y) {
    const ws = this.worldSize();
    let dx = x - this.cx;
    dx -= Math.round(dx);
    return [dx * ws + this.w / 2, (y - this.cy) * ws + this.h / 2];
  }

  toWorld(px, py) {
    const ws = this.worldSize();
    return [wrap(this.cx + (px - this.w / 2) / ws), this.cy + (py - this.h / 2) / ws];
  }

  latLonAt(px, py) {
    const [x, y] = this.toWorld(px, py);
    return { lat: yToLat(y), lon: xToLon(x) };
  }

  center() {
    return { lat: yToLat(this.cy), lon: xToLon(this.cx), zoom: this.zoom };
  }

  /** Видимая область для запроса меток (долготы в [-180, 180]; west > east — окно через 180-й меридиан). */
  bounds() {
    const ws = this.worldSize();
    const hw = this.w / 2 / ws, hh = this.h / 2 / ws;
    const full = hw * 2 >= 1;
    return {
      south: yToLat(clamp(this.cy + hh, 0, 1)), north: yToLat(clamp(this.cy - hh, 0, 1)),
      west: full ? -180 : xToLon(this.cx - hw), east: full ? 180 : xToLon(this.cx + hw),
    };
  }

  /* ---------------- управление видом ---------------- */

  setView(lat, lon, zoom = this.zoom) {
    cancelAnimationFrame(this.anim);
    this.cx = wrap(lonToX(lon));
    this.cy = latToY(lat);
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.render(true);
  }

  /** Меняем масштаб так, чтобы точка под (px, py) осталась на месте — как в любых картах. */
  zoomAround(px, py, z) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    if (z === this.zoom) return;
    const [wx, wy] = this.toWorld(px, py);
    this.zoom = z;
    const ws = this.worldSize();
    this.cx = wrap(wx - (px - this.w / 2) / ws);
    this.cy = wy - (py - this.h / 2) / ws;
    this.render(true);
  }

  zoomBy(d) {
    this.animateZoom(this.w / 2, this.h / 2, Math.round(this.zoom) + d);
  }

  animateZoom(px, py, target, ms = 240) {
    cancelAnimationFrame(this.anim);
    const from = this.zoom, to = clamp(target, MIN_ZOOM, MAX_ZOOM), t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / ms);
      this.zoomAround(px, py, from + (to - from) * ease(k));
      if (k < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  /** Плавный перелёт к точке. */
  flyTo(lat, lon, zoom = this.zoom, ms = 650) {
    cancelAnimationFrame(this.anim);
    const x0 = this.cx, y0 = this.cy, z0 = this.zoom;
    let dx = wrap(lonToX(lon)) - x0;
    dx -= Math.round(dx);                        // короткий путь через 180-й меридиан
    const y1 = latToY(lat), z1 = clamp(zoom, MIN_ZOOM, MAX_ZOOM), t0 = performance.now();
    const step = now => {
      const k = ease(Math.min(1, (now - t0) / ms));
      this.cx = wrap(x0 + dx * k);
      this.cy = y0 + (y1 - y0) * k;
      this.zoom = z0 + (z1 - z0) * k;
      this.render(true);
      if (k < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  /** Показать все точки: [{lat, lon}]. */
  fit(points, maxZoom = 15) {
    if (!points.length) return;
    const xs = points.map(p => wrap(lonToX(p.lon))), ys = points.map(p => latToY(p.lat));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = 80;
    const zx = Math.log2((this.w - pad) / TILE / Math.max(x1 - x0, 1e-9));
    const zy = Math.log2((this.h - pad) / TILE / Math.max(y1 - y0, 1e-9));
    this.setView(yToLat((y0 + y1) / 2), xToLon((x0 + x1) / 2), Math.min(maxZoom, Math.floor(Math.min(zx, zy))));
  }

  /* ---------------- жесты ---------------- */

  onDown(e) {
    if (e.button !== 0 || e.target.closest('.map-controls, .map-attrib')) return;
    cancelAnimationFrame(this.anim);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this.dragged = false;
      this.start = { x: e.clientX, y: e.clientY };
    }
    this.pinch = null;
  }

  onPointerMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const prev = [...this.pointers.values()].map(q => ({ ...q }));
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 1) {
      if (!this.dragged && Math.hypot(e.clientX - this.start.x, e.clientY - this.start.y) < 5) return;
      this.dragged = true;
      this.el.classList.add('dragging');
      const ws = this.worldSize();
      this.cx = wrap(this.cx - (e.clientX - prev[0].x) / ws);
      this.cy -= (e.clientY - prev[0].y) / ws;
      this.render(true);
    } else if (this.pointers.size === 2) {
      // щипок: масштаб по расстоянию между пальцами, сдвиг — по их середине
      this.dragged = true;
      const [a, b] = [...this.pointers.values()];
      const [pa, pb] = prev;
      const r = this.el.getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      const pmid = { x: (pa.x + pb.x) / 2 - r.left, y: (pa.y + pb.y) / 2 - r.top };
      const d = Math.hypot(a.x - b.x, a.y - b.y), pd = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (pd > 0) this.zoomAround(pmid.x, pmid.y, this.zoom + Math.log2(d / pd));
      const ws = this.worldSize();
      this.cx = wrap(this.cx - (mid.x - pmid.x) / ws);
      this.cy -= (mid.y - pmid.y) / ws;
      this.render(true);
    }
  }

  onUp(e) {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size) return;
    this.el.classList.remove('dragging');
    // клик после перетаскивания гасим, а следующий — уже нет (setTimeout срабатывает после click)
    setTimeout(() => { if (!this.pointers.size) this.dragged = false; }, 0);
  }

  onWheel(e) {
    e.preventDefault();
    cancelAnimationFrame(this.anim);
    const [px, py] = this.local(e);
    // строки (Firefox), пиксели колеса или щипок на тачпаде (приходит как колесо с Ctrl и мелкими шагами)
    const delta = e.deltaY * (e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.012 : 0.0022);
    this.zoomAround(px, py, this.zoom - clamp(delta, -1, 1));
  }

  /* ---------------- метки ---------------- */

  /** items: [{lat, lon, render() → элемент, onClick()}] */
  setMarkers(items) {
    this.items = items.map(it => ({ ...it, x: wrap(lonToX(it.lon)), y: latToY(it.lat) }));
    this.clusterKey = null;
    this.render();
  }

  /** Своё место — отдельная точка, в кружки не группируется. */
  setLocation(lat, lon) {
    if (!this.me) {
      this.me = { el: h('div.map-me', h('span')) };
      this.marksEl.append(this.me.el);
    }
    this.me.x = wrap(lonToX(lon));
    this.me.y = latToY(lat);
    this.render();
  }

  rebuildMarks(tz) {
    this.marksEl.querySelectorAll('.map-mark').forEach(el => el.remove());
    const size = TILE * 2 ** tz;
    const cells = new Map();
    for (const it of this.items) {
      const key = Math.floor(it.x * size / CLUSTER_PX) + ':' + Math.floor(it.y * size / CLUSTER_PX);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(it);
    }
    this.marks = [];
    for (const group of cells.values()) {
      let el, x, y;
      if (group.length === 1) {
        const it = group[0];
        ({ x, y } = it);
        el = h('div.map-mark', it.render());
        el.addEventListener('click', e => { e.stopPropagation(); if (!this.dragged && it.onClick) it.onClick(); });
      } else {
        x = group.reduce((s, it) => s + it.x, 0) / group.length;
        y = group.reduce((s, it) => s + it.y, 0) / group.length;
        el = h('div.map-mark.cluster', h('span', String(group.length)));
        el.addEventListener('click', e => {
          e.stopPropagation();
          if (this.dragged) return;
          if (this.zoom >= 16 && this.onCluster) this.onCluster(group);
          else this.flyTo(yToLat(y), xToLon(x), Math.min(Math.round(this.zoom) + 2, 18), 450);
        });
      }
      this.marksEl.append(el);
      this.marks.push({ x, y, el });
    }
  }

  /* ---------------- отрисовка ---------------- */

  render(moved) {
    if (moved) this.moved = true;
    if (this.raf || this.dead) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
      if (this.moved) {
        this.moved = false;
        clearTimeout(this.moveTimer);
        this.moveTimer = setTimeout(() => this.onMove && !this.dead && this.onMove(this.center()), 280);
      }
    });
  }

  draw() {
    const w = this.w, hgt = this.h;
    if (!w || !hgt) return;
    // за полюса не уезжаем: край мира не дальше края экрана
    const half = hgt / 2 / this.worldSize();
    this.cy = half >= 0.5 ? 0.5 : clamp(this.cy, half, 1 - half);

    const tz = clamp(Math.round(this.zoom), 0, MAX_ZOOM);
    const n = 2 ** tz;
    const scale = 2 ** (this.zoom - tz);
    const ox = this.cx * n * TILE - w / 2 / scale;          // левый верхний угол экрана в пикселях зума tz
    const oy = this.cy * n * TILE - hgt / 2 / scale;
    const want = new Set();
    let complete = true;
    for (let ty = Math.max(0, Math.floor(oy / TILE)); ty <= Math.min(n - 1, Math.floor((oy + hgt / scale) / TILE)); ty++) {
      for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + w / scale) / TILE); tx++) {
        const key = tz + '/' + tx + '/' + ty;
        want.add(key);
        const t = this.tiles.get(key) || this.addTile(tz, tx, ty, key);
        if (!t.loaded) complete = false;
      }
    }
    // плитки прошлого масштаба лежат под новыми, пока те грузятся, — без серых дыр при зуме
    for (const [key, t] of this.tiles) {
      const s = 2 ** (this.zoom - t.z);
      const left = (t.x * TILE - this.cx * 2 ** t.z * TILE) * s + w / 2;
      const top = (t.y * TILE - this.cy * 2 ** t.z * TILE) * s + hgt / 2;
      const visible = left < w && top < hgt && left + TILE * s > 0 && top + TILE * s > 0;
      if (!want.has(key) && (complete || t.z === tz || !t.loaded || !visible)) {
        t.img.remove();
        this.tiles.delete(key);
        continue;
      }
      t.img.style.transform = `translate(${left}px, ${top}px) scale(${s})`;
      t.img.style.zIndex = t.z === tz ? 2 : 1;
    }

    if (this.clusterKey !== tz) {
      this.clusterKey = tz;
      this.rebuildMarks(tz);
    }
    for (const m of this.marks) {
      const [sx, sy] = this.toScreen(m.x, m.y);
      m.el.style.transform = `translate(${sx}px, ${sy}px)`;
    }
    if (this.me && this.me.x != null) {
      const [sx, sy] = this.toScreen(this.me.x, this.me.y);
      this.me.el.style.transform = `translate(${sx}px, ${sy}px)`;
    }
  }

  addTile(z, x, y, key) {
    const n = 2 ** z;
    const img = new Image();
    img.className = 'map-tile';
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    // страница отдаёт Referrer-Policy: same-origin, а серверам OSM нужен адрес сайта (без пути)
    img.referrerPolicy = 'strict-origin-when-cross-origin';
    const t = { img, z, x, y, loaded: false };
    img.onload = () => { t.loaded = true; img.classList.add('in'); this.render(); };
    img.onerror = () => { t.loaded = true; this.render(); };
    img.src = tileUrl(z, ((x % n) + n) % n, y);
    this.tilesEl.append(img);
    this.tiles.set(key, t);
    return t;
  }
}

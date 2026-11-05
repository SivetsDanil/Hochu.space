// Карта групп: группы, привязанные к адресу, заявки на вступление, выбор места для своей группы.
import { S, on, putUser } from './store.js';
import { h, clear, icon, avatar, toast, openModal, plural, fmtShort, confirmDialog } from './ui.js';
import { MapView } from './map.js';
import { openChat } from './chat.js';

const LS_VIEW = 'tc.mapView';
const DEFAULT_VIEW = { lat: 55.751, lon: 37.618, zoom: 10 };     // Москва — пока карту ни разу не двигали

function savedView() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_VIEW));
    if (v && [v.lat, v.lon, v.zoom].every(Number.isFinite)) return v;
  } catch (e) { /* приватный режим */ }
  return null;
}

function saveView(v) {
  try { localStorage.setItem(LS_VIEW, JSON.stringify({ lat: +v.lat.toFixed(5), lon: +v.lon.toFixed(5), zoom: +v.zoom.toFixed(2) })); } catch (e) { /* ignore */ }
}

const placeAvatar = p => ({ title: p.title, color: p.color, avatar: p.avatar, emoji: p.emoji });
const membersText = n => `${n} ${plural(n, 'участник', 'участника', 'участников')}`;

function pinEl(p) {
  return h('div.map-pin' + (p.member ? '.mine' : ''), { title: p.title }, avatar(placeAvatar(p), { size: 38 }));
}

/* ---------------- поиск: группы на карте и адреса ---------------- */

/** Поиск по нажатию Enter: правила Nominatim запрещают искать на каждую букву. */
function searchBox({ groups, placeholder, onGroup, onPlace }) {
  const input = h('input.field.map-search-input', { type: 'search', placeholder, autocomplete: 'off', enterkeyhint: 'search', spellcheck: false });
  const results = h('div.map-results', { hidden: true });
  let seq = 0;
  const row = (lead, title, sub, onclick) => h('button.map-result', { type: 'button', onclick: () => { results.hidden = true; onclick(); } },
    lead, h('div.map-result-text', h('div.map-result-title', title), sub ? h('div.map-result-sub', sub) : null));

  async function run() {
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    const my = ++seq;
    clear(results, h('div.map-results-note', h('div.spinner.small'), 'Ищем…'));
    results.hidden = false;
    let geoError = null;
    const [found, places] = await Promise.all([
      groups ? S.sock.call('places.find', { q }).catch(() => []) : [],
      S.sock.call('geo.search', { q }).catch(e => { geoError = e.message; return []; }),
    ]);
    if (my !== seq) return;
    const rows = [];
    if (found.length) {
      rows.push(h('div.map-results-head', 'Группы'),
        found.map(p => row(avatar(placeAvatar(p), { size: 34 }), p.title, p.address || membersText(p.members), () => onGroup(p))));
    }
    if (places.length) {
      rows.push(h('div.map-results-head', 'Адреса'), places.map(r => row(icon('pin'), r.label, r.full, () => onPlace(r))));
    }
    clear(results, rows.length ? rows : h('div.map-results-note', geoError || 'Ничего не нашлось'));
  }

  input.addEventListener('keydown', e => { if (e.key === 'Escape') results.hidden = true; });
  const form = h('form.map-search', { onsubmit: e => { e.preventDefault(); run(); } }, icon('search'), input, results);
  return { form, input, hide: () => { results.hidden = true; } };
}

/* ---------------- экран карты ---------------- */

let current = null;

/** focus: {chat, lat, lon} — сразу показать эту группу. */
export function openMapScreen(focus) {
  if (current) { current.focus(focus); return; }
  const mapEl = h('div.map-host');
  const card = h('div.map-card', { hidden: true });
  const locateBtn = h('button.map-btn', { title: 'Где я', onclick: locate }, icon('locate'));
  const search = searchBox({
    groups: true,
    placeholder: 'Группа или адрес',
    onGroup: p => { map.flyTo(p.lat, p.lon, Math.max(map.zoom, 16)); showCard(p); },
    onPlace: r => map.flyTo(r.lat, r.lon, 16),
  });
  const screen = h('div.map-screen',
    h('div.map-top', h('button.icon-btn', { title: 'Закрыть карту', onclick: close }, icon('back')), search.form),
    mapEl, card);
  document.body.append(screen);
  screen.addEventListener('pointerdown', e => { if (!search.form.contains(e.target)) search.hide(); });

  const first = !savedView() && !focus;
  const start = focus || savedView() || DEFAULT_VIEW;
  const map = new MapView(mapEl, {
    lat: start.lat, lon: start.lon, zoom: focus ? 16 : start.zoom,
    onMove: v => { saveView(v); load(); },
    onClick: hideCard,
    onCluster: items => showList(items.map(it => it.place)),
  });
  map.controlsEl.prepend(locateBtn);
  let openId = null;
  let seq = 0;

  async function load() {
    const my = ++seq;
    try {
      const list = await S.sock.call('places.search', map.bounds());
      if (my !== seq || current !== api) return;
      map.setMarkers(list.map(p => ({ lat: p.lat, lon: p.lon, place: p, render: () => pinEl(p), onClick: () => showCard(p) })));
      const open = openId && list.find(p => p.chat === openId);
      if (open && !card.querySelector('textarea')) showCard(open);   // свежие данные, но не сбиваем набранный текст
    } catch (e) { /* нет связи — подгрузим при следующем сдвиге */ }
  }

  function showCard(p) {
    openId = p.chat;
    renderCard(card, p, { onOpen: id => { close(); openChat(id); }, onChange: load, onClose: hideCard });
    card.hidden = false;
  }

  function hideCard() {
    openId = null;
    card.hidden = true;
  }

  function showList(places) {
    openId = null;
    clear(card,
      h('div.map-card-head', h('div.map-card-titles', h('div.map-card-title', 'Группы в этом месте'),
        h('div.map-card-sub', `${places.length} ${plural(places.length, 'группа', 'группы', 'групп')}`)),
        h('button.icon-btn', { title: 'Закрыть', onclick: hideCard }, icon('x'))),
      places.map(p => h('button.map-result', { type: 'button', onclick: () => showCard(p) }, avatar(placeAvatar(p), { size: 38 }),
        h('div.map-result-text', h('div.map-result-title', p.title), h('div.map-result-sub', membersText(p.members))))));
    card.hidden = false;
  }

  function locate() {
    if (!navigator.geolocation) { toast('Браузер не умеет определять местоположение'); return; }
    locateBtn.classList.add('busy');
    navigator.geolocation.getCurrentPosition(pos => {
      locateBtn.classList.remove('busy');
      map.setLocation(pos.coords.latitude, pos.coords.longitude);
      map.flyTo(pos.coords.latitude, pos.coords.longitude, 15);
    }, err => {
      locateBtn.classList.remove('busy');
      toast(err.code === 1 ? 'Разрешите браузеру доступ к местоположению' : 'Не удалось определить местоположение');
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
  }

  const offs = [on('map:refresh', load), on('chat_removed', load)];
  const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.modal')) close(); };
  document.addEventListener('keydown', onKey);

  function close() {
    if (current !== api) return;
    current = null;
    map.destroy();
    offs.forEach(off => off());
    document.removeEventListener('keydown', onKey);
    screen.classList.add('out');
    setTimeout(() => screen.remove(), 160);
  }

  const api = {
    close,
    focus(f) {
      if (!f) return;
      map.flyTo(f.lat, f.lon, Math.max(map.zoom, 16));
      if (f.chat) S.sock.call('places.get', { chat: f.chat }).then(showCard).catch(() => {});
    },
  };
  current = api;
  if (focus && focus.chat) S.sock.call('places.get', { chat: focus.chat }).then(showCard).catch(() => {});
  if (first) {
    // карту открыли впервые — показываем сразу все группы, если они есть
    S.sock.call('places.search', { south: -85, west: -180, north: 85, east: 180 })
      .then(list => { if (list.length && current === api) map.fit(list, 13); }).catch(() => {});
  }
  load();
}

export const closeMapScreen = () => { if (current) current.close(); };

/* ---------------- карточка группы ---------------- */

function renderCard(card, p, opts) {
  const parts = [
    h('div.map-card-head', avatar(placeAvatar(p), { size: 54 }),
      h('div.map-card-titles', h('div.map-card-title', p.title), h('div.map-card-sub', membersText(p.members))),
      h('button.icon-btn', { title: 'Закрыть', onclick: opts.onClose }, icon('x'))),
    p.address ? h('div.map-card-row', icon('pin'), h('span', p.address)) : null,
    p.about ? h('div.map-card-about', p.about) : null,
  ];
  const redraw = () => { renderCard(card, p, opts); opts.onChange(); };
  if (p.member) {
    parts.push(h('button.primary-btn.wide', { onclick: () => opts.onOpen(p.chat) }, 'Открыть чат'));
  } else if (p.request === 'pending') {
    parts.push(h('div.map-card-note', icon('clock'), h('span', 'Заявка отправлена. Администраторы ответят, когда будут в сети — придёт уведомление.')),
      h('button.ghost-btn.wide', { onclick: async () => {
        try { await S.sock.call('join.cancel', { chat: p.chat }); p.request = null; redraw(); } catch (e) { toast(e.message); }
      } }, 'Отменить заявку'));
  } else if (p.request === 'rejected') {
    parts.push(h('div.map-card-note.bad', icon('x'), h('span', 'Заявку отклонили. Новую можно подать позже.')));
  } else {
    const text = h('textarea.field.map-card-text', { placeholder: 'Пара слов о себе для администраторов — необязательно', maxlength: 300, rows: 2 });
    const btn = h('button.primary-btn.wide', { onclick: async () => {
      btn.disabled = true;
      try {
        await S.sock.call('join.request', { chat: p.chat, text: text.value.trim() });
        p.request = 'pending';
        toast('Заявка отправлена');
        redraw();
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
      }
    } }, 'Подать заявку');
    parts.push(text, btn);
  }
  clear(card, parts);
}

/* ---------------- место своей группы ---------------- */

export function placeDialog(c) {
  const mapEl = h('div.map-host');
  const addr = h('input.field', { placeholder: 'Например: «Двор на Ленина, 5» или «Кофейня у парка»', maxlength: 200, value: c.place ? c.place.address : '' });
  let edited = !!(c.place && c.place.address);
  addr.addEventListener('input', () => { edited = !!addr.value.trim(); });
  const search = searchBox({
    groups: false,
    placeholder: 'Найти адрес',
    onPlace: r => {
      if (!edited) { addr.value = r.label; skipReverse = true; }   // подпись из поиска точнее, чем «что в центре»
      map.flyTo(r.lat, r.lon, 17);
    },
  });
  let skipReverse = false;
  const body = h('div.modal-form',
    search.form,
    h('div.picker', mapEl, h('div.picker-pin', icon('pin'))),
    h('div.field-hint', 'Двигайте карту, чтобы метка встала на нужное место.'),
    h('label.field-wrap', h('span.field-label', 'Подпись места'), addr),
    h('p.muted.small-note', 'Группу на карте увидят все пользователи этого сервера: название, описание, аватар, адрес и число участников. ' +
      'Они смогут подать заявку на вступление, а администраторы — принять её или отклонить. Переписка остаётся зашифрованной.'));
  body.addEventListener('pointerdown', e => { if (!search.form.contains(e.target)) search.hide(); });

  const save = async () => {
    const { lat, lon } = map.center();
    try {
      await S.sock.call('places.set', { chat: c.id, lat, lon, address: addr.value.trim() });
      toast(c.place ? 'Место обновлено' : 'Группа появилась на карте');
      m.close();
    } catch (e) { toast(e.message); }
  };
  const remove = async () => {
    if (!await confirmDialog('Убрать группу с карты? Новые заявки перестанут приходить.', { ok: 'Убрать', danger: true })) return;
    try {
      await S.sock.call('places.clear', { chat: c.id });
      toast('Группа убрана с карты');
      m.close();
    } catch (e) { toast(e.message); }
  };
  const m = openModal({
    title: c.place ? 'Место группы на карте' : 'Отметить группу на карте', body, cls: 'wide map-modal',
    onClose: () => map.destroy(),
    actions: [c.place ? { label: 'Убрать с карты', danger: true, onclick: remove } : null,
      { label: 'Сохранить', primary: true, onclick: save }].filter(Boolean),
  });

  let rseq = 0;
  async function reverse() {
    if (skipReverse) { skipReverse = false; return; }
    if (edited) return;
    const my = ++rseq;
    const { lat, lon } = map.center();
    try {
      const r = await S.sock.call('geo.reverse', { lat, lon });
      if (my === rseq && !edited && r) addr.value = r.label;
    } catch (e) { /* без подписи тоже можно сохранить */ }
  }
  const start = c.place || savedView() || DEFAULT_VIEW;
  const map = new MapView(mapEl, { lat: start.lat, lon: start.lon, zoom: c.place ? 17 : Math.max(start.zoom, 12), onMove: reverse });
}

/* ---------------- заявки на вступление (для админов) ---------------- */

export function requestsDialog(c) {
  const list = h('div.req-list', h('div.loading', h('div.spinner.small')));
  const off = on('join_request', d => { if (d.chat === c.id) load(); });
  const m = openModal({
    title: 'Заявки на вступление', body: h('div.modal-form', list), cls: 'wide', onClose: off,
    actions: [{ label: 'Готово', primary: true, onclick: () => m.close() }],
  });

  async function load() {
    let rows;
    try { rows = await S.sock.call('join.list', { chat: c.id }); } catch (e) { clear(list, h('div.req-empty', e.message)); return; }
    rows.forEach(r => { r.user = putUser(r.user); });
    clear(list, rows.length ? rows.map(row) : h('div.req-empty', icon('userPlus'), 'Новых заявок нет'));
  }

  const row = r => h('div.req-row',
    avatar(r.user, { size: 42 }),
    h('div.req-main',
      h('div.req-name', r.user.name, h('span.muted', ' @' + r.user.username)),
      r.text ? h('div.req-text', r.text) : null,
      h('div.req-time', fmtShort(r.ts))),
    h('div.req-actions',
      h('button.ghost-btn', { onclick: () => decide(r, false) }, 'Отклонить'),
      h('button.primary-btn', { onclick: () => decide(r, true) }, 'Принять')));

  async function decide(r, accept) {
    try {
      await S.sock.call('join.decide', { chat: c.id, user: r.user.id, accept });
      toast(accept ? `${r.user.name} теперь в группе` : 'Заявка отклонена');
    } catch (e) { toast(e.message); }
    load();
  }
  load();
}

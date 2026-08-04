'use strict';

/* ══════════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════════ */
const GRANADA_CENTER = [37.1773, -3.5986];
const GRANADA_ZOOM   = 10;
const NOMINATIM      = 'https://nominatim.openstreetmap.org/search';
const OSRM           = 'https://router.project-osrm.org/route/v1/driving';
const GR_VIEWBOX     = '-4.25,37.95,-2.70,36.85';

/* ══════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════ */
const state = {
  user:            null,
  searchMap:       null,
  publishMap:      null,
  searchRoute:     null,
  searchMarkers:   null,
  publishRoute:    null,
  publishMarkers:  null,
  // Search coords (for distance-based filtering)
  s1OriginCoords:  null,
  s1DestCoords:    null,
  // Publish coords
  s2OriginCoords:  null,
  s2DestCoords:    null,
  // Forum
  currentThreadId: null,
};

/* ══════════════════════════════════════════════════════════
   UTILS
══════════════════════════════════════════════════════════ */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
function fmtDate(iso)     { if (!iso) return ''; const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}`; }
function fmtDT(iso)       { if (!iso) return ''; return new Date(iso).toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function show(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id)  { document.getElementById(id)?.classList.add('hidden'); }
function msgShow(id, text, type = 'error') {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `msg msg-${type}`;
  el.textContent = text;
  el.classList.remove('hidden');
  if (type === 'success') setTimeout(() => el.classList.add('hidden'), 4000);
}
function msgHide(id) { document.getElementById(id)?.classList.add('hidden'); }

/* ══════════════════════════════════════════════════════════
   API
══════════════════════════════════════════════════════════ */
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error desconocido');
  return data;
}
const apiGet    = p     => api('GET',    p);
const apiPost   = (p,b) => api('POST',   p, b);
const apiPut    = (p,b) => api('PUT',    p, b);
const apiDelete = p     => api('DELETE', p);

/* ══════════════════════════════════════════════════════════
   GEOCODING
══════════════════════════════════════════════════════════ */
async function geocode(q) {
  try {
    const url = `${NOMINATIM}?q=${encodeURIComponent(q + ', Granada')}&format=json&countrycodes=es&viewbox=${GR_VIEWBOX}&bounded=1&limit=5&accept-language=es`;
    return await (await fetch(url)).json();
  } catch { return []; }
}

/* ══════════════════════════════════════════════════════════
   AUTOCOMPLETE
══════════════════════════════════════════════════════════ */
function setupAutocomplete(inputId, dropdownId, onSelect, clearOnType = false) {
  const inp = document.getElementById(inputId);
  const dd  = document.getElementById(dropdownId);
  if (!inp || !dd) return;

  inp.addEventListener('input', debounce(async () => {
    const q = inp.value.trim();
    if (q.length < 2) { dd.innerHTML = ''; return; }
    if (clearOnType) onSelect(null);
    const results = await geocode(q);
    dd.innerHTML = '';
    results.slice(0, 5).forEach(r => {
      const short = r.display_name.split(',')[0].trim();
      const item  = document.createElement('div');
      item.className   = 'ac-item';
      item.textContent = r.display_name.split(',').slice(0, 2).join(',').trim();
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        inp.value = short;
        dd.innerHTML = '';
        onSelect({ name: short, lat: parseFloat(r.lat), lng: parseFloat(r.lon) });
      });
      dd.appendChild(item);
    });
  }, 380));

  inp.addEventListener('blur', () => setTimeout(() => { dd.innerHTML = ''; }, 200));
}

/* ══════════════════════════════════════════════════════════
   MAP HELPERS
══════════════════════════════════════════════════════════ */
function createMap(id) {
  const map = L.map(id).setView(GRANADA_CENTER, GRANADA_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(map);
  return map;
}

function dotIcon(color = '#2C5F2E') {
  return L.divIcon({
    html: `<div style="width:14px;height:14px;background:${color};border:2.5px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.3)"></div>`,
    className: '', iconSize: [14,14], iconAnchor: [7,7],
  });
}

async function drawRoute(map, lat1, lng1, lat2, lng2, color = '#2C5F2E') {
  try {
    const res  = await fetch(`${OSRM}/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`);
    const data = await res.json();
    if (data.routes?.[0]) return L.geoJSON(data.routes[0].geometry, { style: { color, weight: 5, opacity: .8 } }).addTo(map);
  } catch { /* fallback */ }
  return L.polyline([[lat1,lng1],[lat2,lng2]], { color, weight: 3, opacity: .65, dashArray: '8 6' }).addTo(map);
}

function clearLayer(map, layer) {
  if (layer) { try { map.removeLayer(layer); } catch { /* already gone */ } }
  return null;
}

/* ══════════════════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════════════════ */
async function checkAuth() {
  try   { state.user = await apiGet('/api/me'); showApp(); }
  catch { showLogin(); }
}

function switchAuthTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('login-form')?.classList.toggle('hidden', !isLogin);
  document.getElementById('register-form')?.classList.toggle('hidden', isLogin);
  document.getElementById('tab-login-btn')?.classList.toggle('active', isLogin);
  document.getElementById('tab-register-btn')?.classList.toggle('active', !isLogin);
  msgHide('login-error'); msgHide('reg-error');
}

async function login() {
  msgHide('login-error');
  try {
    state.user = await apiPost('/api/login', {
      username: document.getElementById('login-username').value.trim(),
      password: document.getElementById('login-password').value,
    });
    showApp();
  } catch (e) { msgShow('login-error', e.message); }
}

async function register() {
  msgHide('reg-error');
  const username  = document.getElementById('reg-username').value.trim();
  const alias     = document.getElementById('reg-alias').value.trim();
  const email     = document.getElementById('reg-email').value.trim();
  const password  = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password2').value;
  if (!username || username.length < 3) { msgShow('reg-error', 'El usuario debe tener al menos 3 caracteres.'); return; }
  if (!alias)                           { msgShow('reg-error', 'El alias es obligatorio.'); return; }
  if (!password || password.length < 6) { msgShow('reg-error', 'La contraseña debe tener al menos 6 caracteres.'); return; }
  if (password !== password2)           { msgShow('reg-error', 'Las contraseñas no coinciden.'); return; }
  try {
    state.user = await apiPost('/api/register', { username, alias, email, password });
    showApp();
  } catch (e) { msgShow('reg-error', e.message); }
}

async function logout() {
  await apiPost('/api/logout');
  state.user = null; state.searchMap = null; state.publishMap = null;
  showLogin();
}

function showLogin() {
  show('login-screen'); hide('app');
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  switchAuthTab('login');
}

function showApp() {
  hide('login-screen'); show('app');
  document.getElementById('nav-alias').textContent = state.user.alias;
  showSection('sec1');
}

/* ══════════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════════ */
function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.section === id));
  show(id);
  document.getElementById('navbar-links').classList.remove('open');

  if (id === 'sec1' && !state.searchMap)  { setTimeout(() => { state.searchMap  = createMap('map-search');  setupSearchAutocomplete(); }, 50); }
  if (id === 'sec2' && !state.publishMap) { setTimeout(() => { state.publishMap = createMap('map-publish'); setupPublishAutocomplete(); }, 50); }
  if (id === 'sec3') loadProfile();
  if (id === 'sec4') loadForumThreads();
}

/* ══════════════════════════════════════════════════════════
   PROFILE TABS
══════════════════════════════════════════════════════════ */
function switchProfileTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('hidden', c.id !== tabId));
  if (tabId === 'tab-my-trips')    loadMyTrips();
  if (tabId === 'tab-my-bookings') loadMyBookings();
}

/* ══════════════════════════════════════════════════════════
   SEC1 — SEARCH
══════════════════════════════════════════════════════════ */
function setupSearchAutocomplete() {
  setupAutocomplete('s1-origin', 's1-origin-dd', item => {
    state.s1OriginCoords = item;
    if (!item) return;
    document.getElementById('s1-origin').value = item.name;
  }, true);

  setupAutocomplete('s1-dest', 's1-dest-dd', item => {
    state.s1DestCoords = item;
    if (!item) return;
    document.getElementById('s1-dest').value = item.name;
  }, true);
}

async function searchTrips() {
  const origin = document.getElementById('s1-origin').value.trim();
  const dest   = document.getElementById('s1-dest').value.trim();
  const date   = document.getElementById('s1-date').value;

  const params = new URLSearchParams();
  if (origin)                              params.set('origin',      origin);
  if (state.s1OriginCoords?.lat != null)  { params.set('originLat', state.s1OriginCoords.lat); params.set('originLng', state.s1OriginCoords.lng); }
  if (dest)                                params.set('destination', dest);
  if (state.s1DestCoords?.lat != null)    { params.set('destLat',   state.s1DestCoords.lat);   params.set('destLng',   state.s1DestCoords.lng); }
  if (date)                                params.set('date',        date);

  try {
    const trips = await apiGet('/api/trips?' + params.toString());
    renderSearchResults(trips);
    showTripsOnMap(trips);
  } catch (e) {
    document.getElementById('s1-results').innerHTML = `<p class="no-results">${esc(e.message)}</p>`;
  }
}

function renderSearchResults(trips) {
  const el = document.getElementById('s1-results');
  if (!trips.length) { el.innerHTML = '<p class="no-results">No se encontraron viajes con esos criterios.</p>'; return; }

  el.innerHTML = trips.map(t => {
    const avail = t.availableSeats ?? (t.seats - (t.bookings?.length || 0));
    const isOwn = !!t.isOwn;
    const booked = !!t.myBooking;
    const full   = avail <= 0 && !booked;

    let badges = '';
    if (isOwn)   badges += `<span class="badge badge-own">Tu viaje</span>`;
    if (booked)  badges += `<span class="badge badge-booked">Reservado</span>`;
    if (full)    badges += `<span class="badge badge-full">Completo</span>`;

    let actionBtns = '';
    if (!isOwn && !booked && avail > 0) actionBtns += `<button class="btn btn-primary btn-sm book-btn" data-trip-id="${esc(t.id)}">Reservar plaza</button>`;
    if (!isOwn && booked)               actionBtns += `<button class="btn btn-outline btn-sm cancel-mine-btn" data-trip-id="${esc(t.id)}">Cancelar mi reserva</button>`;

    let reportBtn = '';
    if (!isOwn) reportBtn = `<button class="btn-report-link report-toggle-btn" data-trip-id="${esc(t.id)}" data-user-id="${esc(t.userId)}">Reportar usuario</button>`;

    return `
      <div class="trip-card" data-id="${esc(t.id)}" tabindex="0" role="button">
        <div class="trip-route">${esc(t.origin)}<span class="arrow">&#10132;</span>${esc(t.destination)}</div>
        <div class="trip-meta">
          <span>&#128197; ${esc(fmtDate(t.date))}</span>
          <span>&#128336; ${esc(t.time)}</span>
          <span>&#128100; ${esc(t.userAlias)}</span>
          <span>&#128664; ${esc(String(avail))} plaza${avail !== 1 ? 's' : ''} libre${avail !== 1 ? 's' : ''}</span>
        </div>
        ${t.notes ? `<div class="trip-notes">${esc(t.notes)}</div>` : ''}
        <div class="trip-card-footer">
          <div class="trip-actions">${badges}${actionBtns}</div>
          ${reportBtn}
        </div>
        <div class="report-inline hidden" id="report-inline-${esc(t.id)}">
          <p>Indicar el motivo del reporte (se publicará en el foro de forma pública):</p>
          <textarea rows="3" placeholder="Describe el comportamiento inapropiado..."></textarea>
          <div class="report-inline-actions">
            <button class="btn btn-danger btn-sm submit-report-btn" data-user-id="${esc(t.userId)}" data-trip-id="${esc(t.id)}">Enviar reporte</button>
            <button class="btn btn-outline btn-sm cancel-report-btn" data-trip-id="${esc(t.id)}">Cancelar</button>
          </div>
        </div>
      </div>`;
  }).join('');

  // Map click to select trip
  el.querySelectorAll('.trip-card').forEach((card, i) => {
    card.addEventListener('click', e => {
      if (e.target.closest('.trip-card-footer') || e.target.closest('.report-inline')) return;
      selectTrip(card, trips[i]);
    });
  });

  // Book button
  el.querySelectorAll('.book-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const tripId = btn.dataset.tripId;
      btn.disabled = true;
      try {
        await apiPost(`/api/trips/${tripId}/bookings`, {});
        await searchTrips();
      } catch (err) { alert(err.message); btn.disabled = false; }
    });
  });

  // Cancel own booking
  el.querySelectorAll('.cancel-mine-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('¿Cancelar tu reserva en este viaje?')) return;
      try {
        await apiDelete(`/api/trips/${btn.dataset.tripId}/bookings/mine/cancel`);
        await searchTrips();
      } catch (err) { alert(err.message); }
    });
  });

  // Toggle report form
  el.querySelectorAll('.report-toggle-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const form = document.getElementById(`report-inline-${btn.dataset.tripId}`);
      form?.classList.toggle('hidden');
    });
  });

  // Cancel report form
  el.querySelectorAll('.cancel-report-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.getElementById(`report-inline-${btn.dataset.tripId}`)?.classList.add('hidden');
    });
  });

  // Submit report
  el.querySelectorAll('.submit-report-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const form    = document.getElementById(`report-inline-${btn.dataset.tripId}`);
      const message = form?.querySelector('textarea')?.value?.trim();
      if (!message) { alert('El motivo del reporte no puede estar vacío.'); return; }
      if (!confirm('El reporte se publicará de forma pública en el foro. ¿Continuar?')) return;
      btn.disabled = true;
      try {
        await apiPost('/api/reports', { reportedUserId: btn.dataset.userId, message });
        form?.classList.add('hidden');
        alert('Reporte enviado. Se ha publicado un hilo en el foro.');
      } catch (err) { alert(err.message); btn.disabled = false; }
    });
  });
}

function showTripsOnMap(trips) {
  if (!state.searchMap) return;
  state.searchRoute   = clearLayer(state.searchMap, state.searchRoute);
  state.searchMarkers = clearLayer(state.searchMap, state.searchMarkers);
  if (!trips.length) return;
  const group = L.layerGroup().addTo(state.searchMap);
  trips.forEach(t => {
    L.marker([t.originLat, t.originLng], { icon: dotIcon('#4A8C4E') })
      .bindPopup(`<b>${esc(t.origin)}</b><br>${esc(t.destination)} · ${esc(fmtDate(t.date))}`)
      .addTo(group);
  });
  state.searchMarkers = group;
  state.searchMap.fitBounds(L.latLngBounds(trips.map(t => [t.originLat, t.originLng])).pad(.3));
}

async function selectTrip(cardEl, trip) {
  document.querySelectorAll('.trip-card').forEach(c => c.classList.remove('selected'));
  cardEl.classList.add('selected');
  if (!state.searchMap) return;
  state.searchRoute   = clearLayer(state.searchMap, state.searchRoute);
  state.searchMarkers = clearLayer(state.searchMap, state.searchMarkers);
  const group = L.layerGroup().addTo(state.searchMap);
  L.marker([trip.originLat, trip.originLng],      { icon: dotIcon('#2C5F2E') }).bindPopup(`<b>Origen:</b> ${esc(trip.origin)}`).addTo(group).openPopup();
  L.marker([trip.destinationLat, trip.destinationLng], { icon: dotIcon('#7A5C1E') }).bindPopup(`<b>Destino:</b> ${esc(trip.destination)}`).addTo(group);
  state.searchMarkers = group;
  state.searchRoute   = await drawRoute(state.searchMap, trip.originLat, trip.originLng, trip.destinationLat, trip.destinationLng);
  state.searchMap.fitBounds([[trip.originLat, trip.originLng],[trip.destinationLat, trip.destinationLng]], { padding: [40,40] });
}

/* ══════════════════════════════════════════════════════════
   SEC2 — PUBLISH
══════════════════════════════════════════════════════════ */
function setupPublishAutocomplete() {
  setupAutocomplete('s2-origin', 's2-origin-dd', async item => {
    state.s2OriginCoords = item;
    await updatePublishPreview();
  }, true);
  setupAutocomplete('s2-dest', 's2-dest-dd', async item => {
    state.s2DestCoords = item;
    await updatePublishPreview();
  }, true);
}

async function updatePublishPreview() {
  if (!state.publishMap) return;
  state.publishRoute   = clearLayer(state.publishMap, state.publishRoute);
  state.publishMarkers = clearLayer(state.publishMap, state.publishMarkers);
  const o = state.s2OriginCoords, d = state.s2DestCoords;
  if (!o && !d) return;
  const group = L.layerGroup().addTo(state.publishMap);
  if (o) L.marker([o.lat, o.lng], { icon: dotIcon('#2C5F2E') }).bindPopup(`<b>Origen:</b> ${esc(o.name)}`).addTo(group);
  if (d) L.marker([d.lat, d.lng], { icon: dotIcon('#7A5C1E') }).bindPopup(`<b>Destino:</b> ${esc(d.name)}`).addTo(group);
  state.publishMarkers = group;
  if (o && d) {
    state.publishRoute = await drawRoute(state.publishMap, o.lat, o.lng, d.lat, d.lng, '#4A8C4E');
    state.publishMap.fitBounds([[o.lat,o.lng],[d.lat,d.lng]], { padding:[40,40] });
  } else {
    const c = o || d;
    state.publishMap.setView([c.lat, c.lng], 12);
  }
}

async function publishTrip(e) {
  e.preventDefault();
  msgHide('s2-error'); msgHide('s2-success');
  if (!state.s2OriginCoords) { msgShow('s2-error', 'Selecciona el origen desde el desplegable de sugerencias.'); return; }
  if (!state.s2DestCoords)   { msgShow('s2-error', 'Selecciona el destino desde el desplegable de sugerencias.'); return; }

  const recurrence = document.getElementById('s2-recurrence').value;
  const body = {
    origin: state.s2OriginCoords.name, originLat: state.s2OriginCoords.lat, originLng: state.s2OriginCoords.lng,
    destination: state.s2DestCoords.name, destinationLat: state.s2DestCoords.lat, destinationLng: state.s2DestCoords.lng,
    time: document.getElementById('s2-time').value,
    seats: document.getElementById('s2-seats').value,
    notes: document.getElementById('s2-notes').value,
    recurrence,
  };

  if (recurrence === 'weekly') {
    const from     = document.getElementById('s2-recur-from').value;
    const to       = document.getElementById('s2-recur-to').value;
    const weekdays = Array.from(document.querySelectorAll('[name="weekday"]:checked')).map(c => parseInt(c.value));
    if (!from || !to)     { msgShow('s2-error', 'Selecciona el rango de fechas.'); return; }
    if (from > to)        { msgShow('s2-error', 'La fecha de inicio debe ser anterior a la fecha de fin.'); return; }
    if (!weekdays.length) { msgShow('s2-error', 'Selecciona al menos un día de la semana.'); return; }
    body.recurrenceFrom = from;
    body.recurrenceTo   = to;
    body.weekdays       = weekdays;
  } else {
    const date = document.getElementById('s2-date').value;
    if (!date) { msgShow('s2-error', 'La fecha es obligatoria.'); return; }
    body.date = date;
  }

  try {
    const result = await apiPost('/api/trips', body);
    const msg = result.recurrent
      ? `${result.count} viajes publicados: ${result.label}`
      : 'Viaje publicado correctamente.';
    msgShow('s2-success', msg, 'success');
    document.getElementById('publish-form').reset();
    document.getElementById('s2-recurrence').value = 'single';
    show('s2-date-wrap'); hide('s2-recur-wrap');
    state.s2OriginCoords = null; state.s2DestCoords = null;
    state.publishRoute   = clearLayer(state.publishMap, state.publishRoute);
    state.publishMarkers = clearLayer(state.publishMap, state.publishMarkers);
    if (state.publishMap) state.publishMap.setView(GRANADA_CENTER, GRANADA_ZOOM);
  } catch (err) { msgShow('s2-error', err.message); }
}

/* ══════════════════════════════════════════════════════════
   SEC3 — PROFILE
══════════════════════════════════════════════════════════ */
async function loadProfile() {
  try {
    state.user = await apiGet('/api/me');
    const u = state.user;
    document.getElementById('p-alias').value    = u.alias              || '';
    document.getElementById('p-email').value    = u.email              || '';
    document.getElementById('p-municipio').value = u.municipio         || '';
    document.getElementById('p-cp').value        = u.codigoPostal      || '';
    document.getElementById('p-password').value  = '';
    document.getElementById('p-password2').value = '';
    // Walking distance
    const walkSel = document.getElementById('p-walk');
    if (walkSel) {
      const wkm = String(u.walkingDistanceKm ?? 1);
      const opt  = Array.from(walkSel.options).find(o => o.value === wkm);
      if (opt) walkSel.value = wkm;
    }
    // Report count
    const rcEl = document.getElementById('p-report-count-val');
    if (rcEl) rcEl.textContent = String(u.reportCount || 0);

    msgHide('p-error'); msgHide('p-success');
  } catch { /* ignore */ }
}

async function saveProfile(e) {
  e.preventDefault();
  msgHide('p-error'); msgHide('p-success');
  const alias    = document.getElementById('p-alias').value.trim();
  const email    = document.getElementById('p-email').value.trim();
  const password = document.getElementById('p-password').value;
  const pass2    = document.getElementById('p-password2').value;
  if (!alias) { msgShow('p-error', 'El alias no puede estar vacío.'); return; }
  if (password && password !== pass2) { msgShow('p-error', 'Las contraseñas no coinciden.'); return; }
  const body = {
    alias, email,
    municipio:        document.getElementById('p-municipio').value.trim(),
    codigoPostal:     document.getElementById('p-cp').value.trim(),
    walkingDistanceKm: parseFloat(document.getElementById('p-walk').value),
  };
  if (password) body.password = password;
  try {
    state.user = await apiPut('/api/profile', body);
    document.getElementById('nav-alias').textContent = state.user.alias;
    msgShow('p-success', 'Perfil actualizado correctamente.', 'success');
    document.getElementById('p-password').value  = '';
    document.getElementById('p-password2').value = '';
  } catch (err) { msgShow('p-error', err.message); }
}

async function loadMyTrips() {
  const el = document.getElementById('my-trips-list');
  el.innerHTML = '<p class="no-results">Cargando...</p>';
  try {
    const trips = await apiGet('/api/my-trips');
    if (!trips.length) { el.innerHTML = '<p class="no-results">No has publicado ningún viaje todavía.</p>'; return; }
    el.innerHTML = trips.map(t => {
      const passengers = (t.bookings || []);
      const passengerRows = passengers.length
        ? passengers.map(b => `
            <div class="passenger-row">
              <span class="passenger-name">${esc(b.userAlias)}</span>
              <span style="font-size:.78rem;color:var(--c-text-muted)">${esc(fmtDT(b.bookedAt))}</span>
              <button class="btn btn-danger btn-sm cancel-booking-btn" data-trip-id="${esc(t.id)}" data-booking-id="${esc(b.id)}">Cancelar</button>
            </div>`).join('')
        : '<p class="no-passengers">Sin reservas todavía.</p>';
      const recurBadge = t.recurrenceLabel
        ? `<span class="badge badge-recur" title="Serie recurrente">&#8635; ${esc(t.recurrenceLabel)}</span>`
        : '';
      return `
        <div class="my-trip-card">
          <div class="my-trip-header">
            <div>
              <div class="my-trip-route">${esc(t.origin)}<span class="arrow">&#10132;</span>${esc(t.destination)}</div>
              <div class="my-trip-meta">&#128197; ${esc(fmtDate(t.date))} · &#128336; ${esc(t.time)} · ${esc(String(t.availableSeats ?? t.seats))} plaza(s) libre(s)</div>
              ${recurBadge}
            </div>
          </div>
          <div class="passengers-list">${passengerRows}</div>
        </div>`;
    }).join('');

    el.querySelectorAll('.cancel-booking-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Cancelar esta reserva? Se notificará al pasajero por email.')) return;
        try {
          await apiDelete(`/api/trips/${btn.dataset.tripId}/bookings/${btn.dataset.bookingId}`);
          loadMyTrips();
        } catch (err) { alert(err.message); }
      });
    });
  } catch (err) { el.innerHTML = `<p class="no-results">${esc(err.message)}</p>`; }
}

async function loadMyBookings() {
  const el = document.getElementById('my-bookings-list');
  el.innerHTML = '<p class="no-results">Cargando...</p>';
  try {
    const trips = await apiGet('/api/my-bookings');
    if (!trips.length) { el.innerHTML = '<p class="no-results">No tienes ninguna reserva activa.</p>'; return; }
    el.innerHTML = trips.map(t => `
      <div class="my-trip-card">
        <div class="my-trip-header">
          <div>
            <div class="my-trip-route">${esc(t.origin)}<span class="arrow">&#10132;</span>${esc(t.destination)}</div>
            <div class="my-trip-meta">&#128197; ${esc(fmtDate(t.date))} · &#128336; ${esc(t.time)} · Conductor: ${esc(t.userAlias)}</div>
          </div>
          <button class="btn btn-outline btn-sm cancel-mine-btn2" data-trip-id="${esc(t.id)}">Cancelar reserva</button>
        </div>
      </div>`).join('');

    el.querySelectorAll('.cancel-mine-btn2').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Cancelar tu reserva en este viaje?')) return;
        try {
          await apiDelete(`/api/trips/${btn.dataset.tripId}/bookings/mine/cancel`);
          loadMyBookings();
        } catch (err) { alert(err.message); }
      });
    });
  } catch (err) { el.innerHTML = `<p class="no-results">${esc(err.message)}</p>`; }
}

/* ══════════════════════════════════════════════════════════
   SEC4 — FORUM
══════════════════════════════════════════════════════════ */
function showForumList() {
  show('forum-list-view'); hide('forum-new-thread'); hide('forum-thread-view');
  state.currentThreadId = null;
}

async function loadForumThreads() {
  showForumList();
  try {
    const threads = await apiGet('/api/forum/threads');
    renderThreadList(threads);
  } catch (e) { document.getElementById('forum-threads-list').innerHTML = `<p class="no-results">${esc(e.message)}</p>`; }
}

function renderThreadList(threads) {
  const el = document.getElementById('forum-threads-list');
  if (!threads.length) { el.innerHTML = '<p class="no-results">No hay hilos todavía.</p>'; return; }
  const isAdmin = state.user?.role === 'admin';
  el.innerHTML = threads.map(t => `
    <div class="thread-card${t.isReport ? ' thread-report' : ''}" data-id="${esc(t.id)}" tabindex="0" role="button">
      <div class="thread-card-left">
        <div class="thread-title">${t.isReport ? '<span class="badge badge-report">[REPORTE]</span> ' : ''}${esc(t.title)}</div>
        <div class="thread-preview">${esc((t.content||'').slice(0,120))}${(t.content||'').length > 120 ? '…' : ''}</div>
        <div class="thread-meta">Por <strong>${esc(t.userAlias)}</strong> · ${esc(fmtDT(t.createdAt))}</div>
      </div>
      <div class="thread-card-right">
        <span class="reply-badge">${t.replyCount} respuesta${t.replyCount !== 1 ? 's' : ''}</span>
        ${isAdmin ? `<button class="btn btn-danger btn-sm admin-del-thread" data-id="${esc(t.id)}" style="font-size:.75rem;padding:.25rem .55rem">Borrar</button>` : ''}
      </div>
    </div>`).join('');

  el.querySelectorAll('.thread-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.classList.contains('admin-del-thread')) return;
      loadThread(card.dataset.id);
    });
  });
  el.querySelectorAll('.admin-del-thread').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('¿Borrar este hilo?')) return;
      try { await apiDelete('/api/forum/messages/' + btn.dataset.id); loadForumThreads(); }
      catch (err) { alert(err.message); }
    });
  });
}

async function loadThread(id) {
  state.currentThreadId = id;
  hide('forum-list-view'); hide('forum-new-thread'); show('forum-thread-view');
  try {
    const thread = await apiGet(`/api/forum/threads/${id}`);
    renderThread(thread);
  } catch (e) { document.getElementById('forum-thread-content').innerHTML = `<p class="no-results">${esc(e.message)}</p>`; }
}

function renderThread(thread) {
  const isAdmin = state.user?.role === 'admin';
  const el      = document.getElementById('forum-thread-content');
  const replies  = thread.replies.map(r => `
    <div class="reply-card" style="position:relative">
      ${isAdmin ? `<button class="btn btn-danger admin-delete" data-id="${esc(r.id)}" style="position:absolute;top:.7rem;right:.7rem;font-size:.75rem;padding:.25rem .55rem">Borrar</button>` : ''}
      <div class="post-body">${esc(r.content)}</div>
      <div class="reply-author-line">
        <span class="author">${esc(r.userAlias)}</span>
        <span>${esc(fmtDT(r.createdAt))}</span>
      </div>
    </div>`).join('') || '<p class="no-results" style="margin:0">Sin respuestas aún.</p>';

  el.innerHTML = `
    <div class="thread-detail-header">
      ${isAdmin ? `<button class="btn btn-danger" id="del-thread-btn" data-id="${esc(thread.id)}" style="float:right;margin-left:1rem;font-size:.78rem">Borrar hilo</button>` : ''}
      <div class="thread-detail-title">${thread.isReport ? '<span class="badge badge-report">[REPORTE]</span> ' : ''}${esc(thread.title)}</div>
      <div class="post-body">${esc(thread.content)}</div>
      <div class="post-author-line"><span class="author">${esc(thread.userAlias)}</span><span>${esc(fmtDT(thread.createdAt))}</span></div>
    </div>
    <div class="replies-section">
      <div class="replies-title">Respuestas (${thread.replies.length})</div>
      ${replies}
    </div>
    <div class="reply-form-wrap">
      <h4>Añadir respuesta</h4>
      <form id="reply-form" novalidate>
        <div class="form-group"><textarea id="reply-content" rows="3" placeholder="Escribe tu respuesta..." required></textarea></div>
        <div id="reply-error" class="msg msg-error hidden"></div>
        <button type="submit" class="btn btn-primary">Responder</button>
      </form>
    </div>`;

  document.getElementById('del-thread-btn')?.addEventListener('click', async () => {
    if (!confirm('¿Borrar este hilo?')) return;
    try { await apiDelete('/api/forum/messages/' + thread.id); loadForumThreads(); }
    catch (err) { alert(err.message); }
  });

  el.querySelectorAll('.admin-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('¿Borrar esta respuesta?')) return;
      try { await apiDelete('/api/forum/messages/' + btn.dataset.id); loadThread(thread.id); }
      catch (err) { alert(err.message); }
    });
  });

  document.getElementById('reply-form').addEventListener('submit', async e => {
    e.preventDefault();
    const content = document.getElementById('reply-content').value.trim();
    msgHide('reply-error');
    if (!content) { msgShow('reply-error', 'El mensaje no puede estar vacío.'); return; }
    try { await apiPost(`/api/forum/threads/${thread.id}/replies`, { content }); loadThread(thread.id); }
    catch (err) { msgShow('reply-error', err.message); }
  });
}

async function createThread(e) {
  e.preventDefault();
  msgHide('nf-error');
  const title   = document.getElementById('thread-title').value.trim();
  const content = document.getElementById('thread-content').value.trim();
  if (!title || !content) { msgShow('nf-error', 'Título y mensaje son obligatorios.'); return; }
  try {
    const thread = await apiPost('/api/forum/threads', { title, content });
    document.getElementById('new-thread-form').reset();
    loadThread(thread.id);
  } catch (err) { msgShow('nf-error', err.message); }
}

/* ══════════════════════════════════════════════════════════
   EVENT LISTENERS
══════════════════════════════════════════════════════════ */
function bindEvents() {
  // Auth tabs
  document.getElementById('tab-login-btn')?.addEventListener('click', () => switchAuthTab('login'));
  document.getElementById('tab-register-btn')?.addEventListener('click', () => switchAuthTab('register'));
  document.getElementById('login-form').addEventListener('submit', e => { e.preventDefault(); login(); });
  document.getElementById('register-form').addEventListener('submit', e => { e.preventDefault(); register(); });
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Recurrence toggle
  document.getElementById('s2-recurrence')?.addEventListener('change', () => {
    const weekly = document.getElementById('s2-recurrence').value === 'weekly';
    document.getElementById('s2-date-wrap')?.classList.toggle('hidden', weekly);
    document.getElementById('s2-recur-wrap')?.classList.toggle('hidden', !weekly);
  });

  // Nav
  document.querySelectorAll('.nav-link').forEach(a => a.addEventListener('click', e => { e.preventDefault(); showSection(a.dataset.section); }));
  document.getElementById('nav-toggle').addEventListener('click', () => document.getElementById('navbar-links').classList.toggle('open'));

  // Profile tabs
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchProfileTab(btn.dataset.tab)));

  // SEC1
  document.getElementById('s1-search-btn').addEventListener('click', searchTrips);

  // SEC2
  document.getElementById('publish-form').addEventListener('submit', publishTrip);

  // SEC3
  document.getElementById('profile-form').addEventListener('submit', saveProfile);

  // SEC4
  document.getElementById('new-thread-btn').addEventListener('click', () => { hide('forum-list-view'); show('forum-new-thread'); hide('forum-thread-view'); });
  document.getElementById('cancel-thread-btn').addEventListener('click', loadForumThreads);
  document.getElementById('new-thread-form').addEventListener('submit', createThread);
  document.getElementById('back-to-forum-btn').addEventListener('click', loadForumThreads);
}

/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => { bindEvents(); checkAuth(); });

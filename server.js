'use strict';

const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs       = require('fs');
const path     = require('path');
const { initTransporter, sendEmail } = require('./emailService');

const app    = express();
const PORT   = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'comparte-ruta-granada-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// ── DB helpers ───────────────────────────────────────────────────────────────

function loadDB() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }

// ── Geo helper ───────────────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matchesLocation(tripName, tripLat, tripLng, searchName, searchLat, searchLng, walkKm) {
  if (!searchName && !searchLat) return true;
  // Criterion 1 — same municipality name
  if (searchName && tripName.toLowerCase().includes(searchName.toLowerCase())) return true;
  // Criterion 2 — within walking distance
  if (searchLat && searchLng && tripLat && tripLng && walkKm > 0) {
    if (haversineKm(tripLat, tripLng, parseFloat(searchLat), parseFloat(searchLng)) <= walkKm) return true;
  }
  return false;
}

// ── DB init / migration ──────────────────────────────────────────────────────

async function initDB() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    // Migrate existing data to v1.1 schema
    const db = loadDB();
    let changed = false;
    for (const u of db.users) {
      if (u.email              === undefined) { u.email              = '';  changed = true; }
      if (u.walkingDistanceKm  === undefined) { u.walkingDistanceKm  = 1;   changed = true; }
      if (u.reportCount        === undefined) { u.reportCount        = 0;   changed = true; }
    }
    for (const t of db.trips) {
      if (!t.bookings) { t.bookings = []; changed = true; }
    }
    if (!db.reports) { db.reports = []; changed = true; }
    if (changed) { saveDB(db); console.log('Base de datos migrada a v1.1'); }
    return;
  }

  // Fresh DB
  const h1 = await bcrypt.hash('Password1', 10);
  const h2 = await bcrypt.hash('Password2', 10);
  const uid1 = uuidv4(), uid2 = uuidv4(), uid3 = uuidv4();
  const now  = new Date();
  const fmt  = d => d.toISOString().split('T')[0];
  const d1 = new Date(now); d1.setDate(now.getDate() + 1);
  const d2 = new Date(now); d2.setDate(now.getDate() + 2);
  const d3 = new Date(now); d3.setDate(now.getDate() + 3);

  const db = {
    users: [
      { id: uid1, username: 'user1', password: h1, alias: 'Carlos', role: 'user',  email: 'user1@demo.es',  municipio: 'Monachil',     codigoPostal: '18193', walkingDistanceKm: 1, reportCount: 0 },
      { id: uid2, username: 'user2', password: h1, alias: 'María',  role: 'user',  email: 'user2@demo.es',  municipio: 'Güéjar Sierra', codigoPostal: '18160', walkingDistanceKm: 2, reportCount: 0 },
      { id: uid3, username: 'admin1',password: h2, alias: 'Admin',  role: 'admin', email: 'admin@demo.es',  municipio: 'Granada',       codigoPostal: '18001', walkingDistanceKm: 0, reportCount: 0 }
    ],
    trips: [
      { id: uuidv4(), userId: uid1, origin: 'Monachil',     originLat: 37.1547, originLng: -3.5402, destination: 'Granada', destinationLat: 37.1773, destinationLng: -3.5986, date: fmt(d1), time: '08:00', seats: 3, notes: 'Salgo del centro de Monachil, paso por la calle Real.', createdAt: now.toISOString(), bookings: [] },
      { id: uuidv4(), userId: uid2, origin: 'Güéjar Sierra', originLat: 37.1502, originLng: -3.4698, destination: 'Granada', destinationLat: 37.1773, destinationLng: -3.5986, date: fmt(d1), time: '07:30', seats: 2, notes: '', createdAt: now.toISOString(), bookings: [] },
      { id: uuidv4(), userId: uid1, origin: 'Monachil',     originLat: 37.1547, originLng: -3.5402, destination: 'Granada', destinationLat: 37.1773, destinationLng: -3.5986, date: fmt(d2), time: '08:30', seats: 4, notes: 'Vuelta a las 18:00 si alguien necesita.', createdAt: now.toISOString(), bookings: [] },
      { id: uuidv4(), userId: uid2, origin: 'Loja',          originLat: 37.1679, originLng: -4.1508, destination: 'Granada', destinationLat: 37.1773, destinationLng: -3.5986, date: fmt(d3), time: '09:00', seats: 1, notes: 'Ruta por la A-92.', createdAt: now.toISOString(), bookings: [] }
    ],
    forum: {
      threads: [
        { id: uuidv4(), userId: uid3, title: 'Bienvenidos al foro de Comparte Ruta Granada', content: '¡Hola a todos! Este espacio es para compartir experiencias, hacer preguntas y conectar con otros usuarios del carpooling en Granada.', createdAt: now.toISOString(), replies: [
          { id: uuidv4(), userId: uid1, content: '¡Gracias por la bienvenida! ¿Hay mucha gente de la zona de Monachil?', createdAt: new Date(now.getTime() + 3600000).toISOString() },
          { id: uuidv4(), userId: uid2, content: 'Yo soy de Güéjar Sierra y suelo ir a Granada varias veces a la semana.', createdAt: new Date(now.getTime() + 7200000).toISOString() }
        ]},
        { id: uuidv4(), userId: uid1, title: 'Consejos para compartir viaje por primera vez', content: 'Algunos consejos: sé puntual, avisa si no puedes ir, respeta el vehículo. ¿Tenéis más sugerencias?', createdAt: new Date(now.getTime() - 86400000).toISOString(), replies: [] }
      ]
    },
    reports: []
  };

  saveDB(db);
  console.log('Base de datos v1.1 inicializada.');
}

// ── Auth middleware ──────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}

function requireAdmin(req, res, next) {
  const db   = loadDB();
  const user = db.users.find(u => u.id === req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  next();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeUser(u) { const { password, ...s } = u; return s; }

function enrichTrip(t, db, sessionUserId) {
  const owner = db.users.find(u => u.id === t.userId);
  const bookings = (t.bookings || []).map(b => {
    const bu = db.users.find(u => u.id === b.userId);
    return { ...b, userAlias: bu?.alias || 'Usuario' };
  });
  const myBooking = (t.bookings || []).find(b => b.userId === sessionUserId) || null;
  return {
    ...t,
    userAlias:      owner?.alias || 'Usuario',
    ownerEmail:     undefined, // never expose to client
    bookings,
    myBooking,
    isOwn:          t.userId === sessionUserId,
    availableSeats: t.seats - (t.bookings || []).length
  };
}

// ── Auth routes ──────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });
    const db   = loadDB();
    const user = db.users.find(u => u.username === username);
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    req.session.userId = user.id;
    res.json(safeUser(user));
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', requireAuth, (req, res) => {
  const db   = loadDB();
  const user = db.users.find(u => u.id === req.session.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(safeUser(user));
});

// ── Trips routes ─────────────────────────────────────────────────────────────

app.get('/api/trips', (req, res) => {
  const db = loadDB();
  const { origin, originLat, originLng, destination, destLat, destLng, date } = req.query;

  const uid  = req.session.userId;
  const usr  = uid ? db.users.find(u => u.id === uid) : null;
  const walkKm = usr?.walkingDistanceKm ?? 1;

  let trips = db.trips;
  if (origin || originLat)      trips = trips.filter(t => matchesLocation(t.origin,      t.originLat,      t.originLng,      origin,      originLat, originLng, walkKm));
  if (destination || destLat)   trips = trips.filter(t => matchesLocation(t.destination, t.destinationLat, t.destinationLng, destination, destLat,   destLng,   walkKm));
  if (date)                     trips = trips.filter(t => t.date === date);

  res.json(trips.map(t => enrichTrip(t, db, uid)));
});

app.get('/api/my-trips', requireAuth, (req, res) => {
  const db    = loadDB();
  const trips = db.trips.filter(t => t.userId === req.session.userId);
  res.json(trips.map(t => enrichTrip(t, db, req.session.userId)));
});

app.get('/api/my-bookings', requireAuth, (req, res) => {
  const db    = loadDB();
  const uid   = req.session.userId;
  const trips = db.trips.filter(t => (t.bookings || []).some(b => b.userId === uid));
  res.json(trips.map(t => enrichTrip(t, db, uid)));
});

app.post('/api/trips', requireAuth, (req, res) => {
  const db = loadDB();
  const { origin, originLat, originLng, destination, destinationLat, destinationLng, date, time, seats, notes } = req.body;
  if (!origin || !destination || !date || !time || !seats)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  const trip = {
    id: uuidv4(), userId: req.session.userId,
    origin, originLat: parseFloat(originLat), originLng: parseFloat(originLng),
    destination, destinationLat: parseFloat(destinationLat), destinationLng: parseFloat(destinationLng),
    date, time, seats: parseInt(seats, 10), notes: notes || '',
    createdAt: new Date().toISOString(), bookings: []
  };
  db.trips.push(trip);
  saveDB(db);
  res.json(enrichTrip(trip, db, req.session.userId));
});

app.delete('/api/trips/:id', requireAuth, (req, res) => {
  const db   = loadDB();
  const trip = db.trips.find(t => t.id === req.params.id);
  if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
  const user = db.users.find(u => u.id === req.session.userId);
  if (trip.userId !== req.session.userId && user?.role !== 'admin')
    return res.status(403).json({ error: 'Sin permisos' });
  db.trips = db.trips.filter(t => t.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// ── Booking routes ────────────────────────────────────────────────────────────

app.post('/api/trips/:id/bookings', requireAuth, async (req, res) => {
  const db   = loadDB();
  const trip = db.trips.find(t => t.id === req.params.id);
  if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });

  if (trip.userId === req.session.userId)
    return res.status(400).json({ error: 'No puedes reservar tu propio viaje' });

  const bookings = trip.bookings || [];
  if (bookings.some(b => b.userId === req.session.userId))
    return res.status(400).json({ error: 'Ya tienes una reserva en este viaje' });
  if (bookings.length >= trip.seats)
    return res.status(400).json({ error: 'No quedan plazas disponibles' });

  const booking = { id: uuidv4(), userId: req.session.userId, bookedAt: new Date().toISOString() };
  if (!trip.bookings) trip.bookings = [];
  trip.bookings.push(booking);
  saveDB(db);

  const passenger = db.users.find(u => u.id === req.session.userId);
  const owner     = db.users.find(u => u.id === trip.userId);

  await sendEmail({
    to:      owner?.email,
    subject: `Nueva reserva en tu viaje — Comparte Ruta Granada`,
    text:    `Hola ${owner?.alias},\n\n${passenger?.alias} ha reservado una plaza en tu viaje:\n\n  Origen:  ${trip.origin}\n  Destino: ${trip.destination}\n  Fecha:   ${trip.date} a las ${trip.time}\n\nPlazas restantes: ${trip.seats - trip.bookings.length}\n\n— Comparte Ruta Granada`
  });

  res.json({ ...booking, userAlias: passenger?.alias || 'Usuario' });
});

// Trip owner cancels a passenger booking
app.delete('/api/trips/:id/bookings/:bid', requireAuth, async (req, res) => {
  const db   = loadDB();
  const trip = db.trips.find(t => t.id === req.params.id);
  if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });

  const user = db.users.find(u => u.id === req.session.userId);
  if (trip.userId !== req.session.userId && user?.role !== 'admin')
    return res.status(403).json({ error: 'Solo el propietario del viaje puede cancelar reservas' });

  const bIdx = (trip.bookings || []).findIndex(b => b.id === req.params.bid);
  if (bIdx === -1) return res.status(404).json({ error: 'Reserva no encontrada' });

  const booking   = trip.bookings[bIdx];
  const passenger = db.users.find(u => u.id === booking.userId);
  const owner     = db.users.find(u => u.id === trip.userId);
  trip.bookings.splice(bIdx, 1);
  saveDB(db);

  await sendEmail({
    to:      passenger?.email,
    subject: `Tu reserva ha sido cancelada — Comparte Ruta Granada`,
    text:    `Hola ${passenger?.alias},\n\nEl organizador (${owner?.alias}) ha cancelado tu reserva en el viaje:\n\n  Origen:  ${trip.origin}\n  Destino: ${trip.destination}\n  Fecha:   ${trip.date} a las ${trip.time}\n\nSentimos los inconvenientes. Puedes buscar otros viajes disponibles en la plataforma.\n\n— Comparte Ruta Granada`
  });

  res.json({ ok: true });
});

// Passenger cancels own booking
app.delete('/api/trips/:id/bookings/mine/cancel', requireAuth, async (req, res) => {
  const db  = loadDB();
  const trip = db.trips.find(t => t.id === req.params.id);
  if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });

  const bIdx = (trip.bookings || []).findIndex(b => b.userId === req.session.userId);
  if (bIdx === -1) return res.status(404).json({ error: 'No tienes reserva en este viaje' });

  const passenger = db.users.find(u => u.id === req.session.userId);
  const owner     = db.users.find(u => u.id === trip.userId);
  trip.bookings.splice(bIdx, 1);
  saveDB(db);

  await sendEmail({
    to:      owner?.email,
    subject: `Reserva cancelada en tu viaje — Comparte Ruta Granada`,
    text:    `Hola ${owner?.alias},\n\n${passenger?.alias} ha cancelado su reserva en tu viaje:\n\n  Origen:  ${trip.origin}\n  Destino: ${trip.destination}\n  Fecha:   ${trip.date} a las ${trip.time}\n\nAhora tienes ${trip.seats - trip.bookings.length} plaza(s) disponibles.\n\n— Comparte Ruta Granada`
  });

  res.json({ ok: true });
});

// ── Profile routes ────────────────────────────────────────────────────────────

app.put('/api/profile', requireAuth, async (req, res) => {
  const db  = loadDB();
  const idx = db.users.findIndex(u => u.id === req.session.userId);
  if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });
  const { alias, password, email, municipio, codigoPostal, walkingDistanceKm } = req.body;
  if (alias              !== undefined) db.users[idx].alias              = alias;
  if (email              !== undefined) db.users[idx].email              = email;
  if (municipio          !== undefined) db.users[idx].municipio          = municipio;
  if (codigoPostal       !== undefined) db.users[idx].codigoPostal       = codigoPostal;
  if (walkingDistanceKm  !== undefined) db.users[idx].walkingDistanceKm  = parseFloat(walkingDistanceKm);
  if (password)                         db.users[idx].password           = await bcrypt.hash(password, 10);
  saveDB(db);
  res.json(safeUser(db.users[idx]));
});

// ── Forum routes ──────────────────────────────────────────────────────────────

app.get('/api/forum/threads', (req, res) => {
  const db = loadDB();
  const threads = db.forum.threads
    .map(t => {
      const u = db.users.find(u => u.id === t.userId);
      return { id: t.id, title: t.title, content: t.content, userAlias: u?.alias || 'Usuario', createdAt: t.createdAt, replyCount: t.replies.length, isReport: !!t.isReport };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(threads);
});

app.get('/api/forum/threads/:id', (req, res) => {
  const db     = loadDB();
  const thread = db.forum.threads.find(t => t.id === req.params.id);
  if (!thread) return res.status(404).json({ error: 'Hilo no encontrado' });
  const tu = db.users.find(u => u.id === thread.userId);
  res.json({
    ...thread,
    userAlias: tu?.alias || 'Usuario',
    replies: thread.replies.map(r => {
      const ru = db.users.find(u => u.id === r.userId);
      return { ...r, userAlias: ru?.alias || 'Usuario' };
    })
  });
});

app.post('/api/forum/threads', requireAuth, (req, res) => {
  const db = loadDB();
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Título y mensaje son obligatorios' });
  const thread = { id: uuidv4(), userId: req.session.userId, title, content, createdAt: new Date().toISOString(), replies: [] };
  db.forum.threads.push(thread);
  saveDB(db);
  const u = db.users.find(u => u.id === req.session.userId);
  res.json({ ...thread, userAlias: u?.alias || 'Usuario', replyCount: 0 });
});

app.post('/api/forum/threads/:id/replies', requireAuth, (req, res) => {
  const db      = loadDB();
  const tIdx    = db.forum.threads.findIndex(t => t.id === req.params.id);
  if (tIdx === -1) return res.status(404).json({ error: 'Hilo no encontrado' });
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
  const reply = { id: uuidv4(), userId: req.session.userId, content, createdAt: new Date().toISOString() };
  db.forum.threads[tIdx].replies.push(reply);
  saveDB(db);
  const u = db.users.find(u => u.id === req.session.userId);
  res.json({ ...reply, userAlias: u?.alias || 'Usuario' });
});

app.delete('/api/forum/messages/:id', requireAuth, requireAdmin, (req, res) => {
  const db = loadDB();
  const tIdx = db.forum.threads.findIndex(t => t.id === req.params.id);
  if (tIdx !== -1) { db.forum.threads.splice(tIdx, 1); saveDB(db); return res.json({ ok: true, type: 'thread' }); }
  for (const thread of db.forum.threads) {
    const rIdx = thread.replies.findIndex(r => r.id === req.params.id);
    if (rIdx !== -1) { thread.replies.splice(rIdx, 1); saveDB(db); return res.json({ ok: true, type: 'reply' }); }
  }
  res.status(404).json({ error: 'Mensaje no encontrado' });
});

// ── Reports route ─────────────────────────────────────────────────────────────

app.post('/api/reports', requireAuth, (req, res) => {
  const db = loadDB();
  const { reportedUserId, message } = req.body;
  if (!reportedUserId || !message?.trim())
    return res.status(400).json({ error: 'Faltan datos del reporte' });
  if (reportedUserId === req.session.userId)
    return res.status(400).json({ error: 'No puedes reportarte a ti mismo' });

  const reported = db.users.find(u => u.id === reportedUserId);
  if (!reported) return res.status(404).json({ error: 'Usuario no encontrado' });

  const reporter = db.users.find(u => u.id === req.session.userId);
  reported.reportCount = (reported.reportCount || 0) + 1;

  // Auto-publish public forum thread
  const thread = {
    id:              uuidv4(),
    userId:          req.session.userId,
    title:           `[REPORTE] Reporte contra el usuario "${reported.alias}"`,
    content:         message,
    isReport:        true,
    reportedUserId,
    createdAt:       new Date().toISOString(),
    replies:         []
  };
  db.forum.threads.push(thread);

  if (!db.reports) db.reports = [];
  db.reports.push({
    id:             uuidv4(),
    reporterId:     req.session.userId,
    reporterAlias:  reporter?.alias || 'Usuario',
    reportedUserId,
    reportedAlias:  reported.alias,
    message,
    threadId:       thread.id,
    createdAt:      thread.createdAt
  });

  saveDB(db);
  res.json({ ok: true, reportCount: reported.reportCount, threadId: thread.id });
});

// ── Start ─────────────────────────────────────────────────────────────────────

initDB()
  .then(() => initTransporter())
  .then(() => {
    app.listen(PORT, () => console.log(`Servidor v1.1 en http://localhost:${PORT}`));
  })
  .catch(err => { console.error('Error al arrancar:', err); process.exit(1); });

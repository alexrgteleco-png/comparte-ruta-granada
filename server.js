'use strict';

const express    = require('express');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const bcrypt     = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const { MongoClient } = require('mongodb');
const { initTransporter, sendEmail } = require('./emailService');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MongoDB ───────────────────────────────────────────────────────────────────

let _client = null;
let _mdb    = null;

async function connectDB() {
  if (_mdb) return _mdb;
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI no configurado');
  _client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await _client.connect();
  _mdb = _client.db('carpooling');
  console.log('MongoDB conectado');
  return _mdb;
}

function col(name) {
  if (!_mdb) throw new Error('DB no conectada');
  return _mdb.collection(name);
}

// ── Express setup ─────────────────────────────────────────────────────────────

app.set('trust proxy', 1);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // disabled: app uses external CDNs (Leaflet, OSM, Nominatim)
  crossOriginEmbedderPolicy: false,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' },
});

// ── Per-user action cooldown (trip create / booking) ─────────────────────────
const ACTION_COOLDOWN_MS = 30_000;
const MAX_TRIPS_PER_USER = 10;
const MAX_BOOKINGS_PER_USER = 5;
const userActionCooldown = new Map();

function checkUserCooldown(userId) {
  const last = userActionCooldown.get(userId);
  if (!last) return 0;
  const wait = Math.ceil((ACTION_COOLDOWN_MS - (Date.now() - last)) / 1000);
  return wait > 0 ? wait : 0;
}
function setUserCooldown(userId) {
  userActionCooldown.set(userId, Date.now());
}

app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'comparte-ruta-granada-secret-2024',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    dbName: 'carpooling',
    collectionName: 'sessions',
    ttl: 24 * 60 * 60,
    autoRemove: 'native',
  }),
  cookie: {
    maxAge:   24 * 60 * 60 * 1000,
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
}));

// ── Geo helpers ───────────────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matchesLocation(tripName, tripLat, tripLng, searchName, searchLat, searchLng, walkKm) {
  if (!searchName && !searchLat) return true;
  if (searchName && tripName.toLowerCase().includes(searchName.toLowerCase())) return true;
  if (searchLat && searchLng && tripLat && tripLng && walkKm > 0)
    if (haversineKm(tripLat, tripLng, parseFloat(searchLat), parseFloat(searchLng)) <= walkKm) return true;
  return false;
}

// ── Recurrence helper ─────────────────────────────────────────────────────────

function generateDates(from, to, weekdays) {
  const result = [];
  const end = new Date(to + 'T00:00:00');
  for (let d = new Date(from + 'T00:00:00'); d <= end; d.setDate(d.getDate() + 1))
    if (weekdays.includes(d.getDay())) result.push(d.toISOString().split('T')[0]);
  return result;
}

// ── DB seed ───────────────────────────────────────────────────────────────────

async function initDB() {
  const mdb = await connectDB();
  const count = await mdb.collection('users').countDocuments();
  if (count > 0) { console.log('MongoDB: datos existentes, omitiendo seed.'); return; }

  const h1 = await bcrypt.hash('Password1', 10);
  const h2 = await bcrypt.hash('Password2', 10);
  const uid1 = uuidv4(), uid2 = uuidv4(), uid3 = uuidv4();
  const now  = new Date();
  const fmt  = d => d.toISOString().split('T')[0];
  const d1 = new Date(now); d1.setDate(now.getDate() + 1);
  const d2 = new Date(now); d2.setDate(now.getDate() + 2);
  const d3 = new Date(now); d3.setDate(now.getDate() + 3);

  await mdb.collection('users').insertMany([
    { id: uid1, username: 'user1',  password: h1, alias: 'Carlos', role: 'user',  email: 'user1@demo.es',  municipio: 'Monachil',      codigoPostal: '18193', walkingDistanceKm: 1, reportCount: 0, createdAt: now.toISOString() },
    { id: uid2, username: 'user2',  password: h1, alias: 'María',  role: 'user',  email: 'user2@demo.es',  municipio: 'Güéjar Sierra', codigoPostal: '18160', walkingDistanceKm: 2, reportCount: 0, createdAt: now.toISOString() },
    { id: uid3, username: 'admin1', password: h2, alias: 'Admin',  role: 'admin', email: 'admin@demo.es',  municipio: 'Granada',       codigoPostal: '18001', walkingDistanceKm: 0, reportCount: 0, createdAt: now.toISOString() }
  ]);

  await mdb.collection('trips').insertMany([
    { id: uuidv4(), userId: uid1, origin: 'Monachil',      originLat: 37.1547, originLng: -3.5402, destination: 'Granada', destinationLat: 37.1773, destinationLng: -3.5986, date: fmt(d1), time: '08:00', seats: 3, notes: 'Salgo del centro de Monachil, paso por la calle Real.', createdAt: now.toISOString(), bookings: [], recurrenceGroupId: null, recurrenceLabel: null },
    { id: uuidv4(), userId: uid2, origin: 'Güéjar Sierra', originLat: 37.1502, originLng: -3.4698, destination: 'Granada', destinationLat: 37.1773, destinationLng: -3.5986, date: fmt(d1), time: '07:30', seats: 2, notes: '', createdAt: now.toISOString(), bookings: [], recurrenceGroupId: null, recurrenceLabel: null },
    { id: uuidv4(), userId: uid1, origin: 'Monachil',      originLat: 37.1547, originLng: -3.5402, destination: 'Granada', destinationLat: 37.1773, destinationLng: -3.5986, date: fmt(d2), time: '08:30', seats: 4, notes: 'Vuelta a las 18:00 si alguien necesita.', createdAt: now.toISOString(), bookings: [], recurrenceGroupId: null, recurrenceLabel: null },
    { id: uuidv4(), userId: uid2, origin: 'Loja',           originLat: 37.1679, originLng: -4.1508, destination: 'Granada', destinationLat: 37.1773, destinationLng: -3.5986, date: fmt(d3), time: '09:00', seats: 1, notes: 'Ruta por la A-92.', createdAt: now.toISOString(), bookings: [], recurrenceGroupId: null, recurrenceLabel: null }
  ]);

  await mdb.collection('threads').insertMany([
    { id: uuidv4(), userId: uid3, title: 'Bienvenidos al foro de Comparte Ruta Granada', content: '¡Hola a todos! Este espacio es para compartir experiencias, hacer preguntas y conectar con otros usuarios del carpooling en Granada.', createdAt: now.toISOString(), replies: [
      { id: uuidv4(), userId: uid1, content: '¡Gracias por la bienvenida! ¿Hay mucha gente de la zona de Monachil?', createdAt: new Date(now.getTime() + 3600000).toISOString() },
      { id: uuidv4(), userId: uid2, content: 'Yo soy de Güéjar Sierra y suelo ir a Granada varias veces a la semana.', createdAt: new Date(now.getTime() + 7200000).toISOString() }
    ], isReport: false },
    { id: uuidv4(), userId: uid1, title: 'Consejos para compartir viaje por primera vez', content: 'Algunos consejos: sé puntual, avisa si no puedes ir, respeta el vehículo. ¿Tenéis más sugerencias?', createdAt: new Date(now.getTime() - 86400000).toISOString(), replies: [], isReport: false }
  ]);

  console.log('MongoDB: seed v1.2 completado.');
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'No autenticado' });
  next();
}

async function requireAdmin(req, res, next) {
  try {
    const user = await col('users').findOne({ id: req.session.userId });
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
    next();
  } catch { res.status(500).json({ error: 'Error interno' }); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeUser(u) {
  if (!u) return null;
  const { password, _id, ...s } = u;
  return s;
}

function enrichTrip(t, users, sessionUserId) {
  const owner   = users.find(u => u.id === t.userId);
  const isOwner = t.userId === sessionUserId;
  const myBooking = (t.bookings || []).find(b => b.userId === sessionUserId) || null;
  const isParticipant = isOwner || !!myBooking;
  const bookings = (t.bookings || []).map(b => {
    const bu = users.find(u => u.id === b.userId);
    return {
      ...b,
      userAlias: bu?.alias || 'Usuario',
      userEmail: isOwner ? (bu?.email || '') : '',
    };
  });
  const messages = isParticipant
    ? (t.messages || []).map(m => {
        const mu = users.find(u => u.id === m.userId);
        return { ...m, userAlias: mu?.alias || 'Usuario' };
      })
    : [];
  const { _id, ...tripData } = t;
  return {
    ...tripData,
    userAlias:      owner?.alias || 'Usuario',
    ownerEmail:     sessionUserId ? (owner?.email || '') : '',
    bookings,
    messages,
    myBooking,
    isOwn:          isOwner,
    availableSeats: t.seats - (t.bookings || []).length
  };
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { username, password, alias, email } = req.body;
    if (!username?.trim() || !password?.trim() || !alias?.trim())
      return res.status(400).json({ error: 'Usuario, alias y contraseña son obligatorios' });
    if (username.trim().length < 3)
      return res.status(400).json({ error: 'El nombre de usuario debe tener al menos 3 caracteres' });
    if (password.length < 6)
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    const users = col('users');
    if (await users.findOne({ username: username.toLowerCase().trim() }))
      return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso' });
    if (email?.trim() && await users.findOne({ email: email.trim() }))
      return res.status(400).json({ error: 'Ese email ya está registrado' });

    const user = {
      id:               uuidv4(),
      username:         username.toLowerCase().trim(),
      password:         await bcrypt.hash(password, 10),
      alias:            alias.trim(),
      role:             'user',
      email:            email?.trim() || '',
      municipio:        '',
      codigoPostal:     '',
      walkingDistanceKm: 1,
      reportCount:      0,
      createdAt:        new Date().toISOString()
    };
    await users.insertOne(user);
    req.session.userId = user.id;

    // Welcome email (non-blocking)
    if (user.email) {
      sendEmail({
        to: user.email,
        subject: '¡Bienvenido a Comparte Ruta Granada!',
        text: `Hola ${user.alias},\n\nTu cuenta ha sido creada correctamente.\n\nUsuario: ${user.username}\n\nYa puedes buscar y publicar viajes en la provincia de Granada.\n\n¡Buen viaje!\n\n— Comparte Ruta Granada`,
      }).catch(err => console.error('[EMAIL bienvenida]', err.message));
    }

    res.json(safeUser(user));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan credenciales' });
    const user = await col('users').findOne({ username: username.toLowerCase().trim() });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    req.session.userId = user.id;
    res.json(safeUser(user));
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await col('users').findOne({ id: req.session.userId });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(safeUser(user));
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

// ── Trips routes ──────────────────────────────────────────────────────────────

app.get('/api/trips', async (req, res) => {
  try {
    const { origin, originLat, originLng, destination, destLat, destLng, date } = req.query;
    const uid   = req.session.userId;
    const users = await col('users').find({}).toArray();
    const usr   = uid ? users.find(u => u.id === uid) : null;
    const walkKm = usr?.walkingDistanceKm ?? 1;

    let trips = await col('trips').find({}).toArray();
    if (origin || originLat)    trips = trips.filter(t => matchesLocation(t.origin,      t.originLat,      t.originLng,      origin,      originLat, originLng, walkKm));
    if (destination || destLat) trips = trips.filter(t => matchesLocation(t.destination, t.destinationLat, t.destinationLng, destination, destLat,   destLng,   walkKm));
    if (date)                   trips = trips.filter(t => t.date === date);

    res.json(trips.map(t => enrichTrip(t, users, uid)));
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/my-trips', requireAuth, async (req, res) => {
  try {
    const users = await col('users').find({}).toArray();
    const trips = await col('trips').find({ userId: req.session.userId }).sort({ date: 1, time: 1 }).toArray();
    res.json(trips.map(t => enrichTrip(t, users, req.session.userId)));
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/my-bookings', requireAuth, async (req, res) => {
  try {
    const uid   = req.session.userId;
    const users = await col('users').find({}).toArray();
    const trips = await col('trips').find({ 'bookings.userId': uid }).sort({ date: 1, time: 1 }).toArray();
    res.json(trips.map(t => enrichTrip(t, users, uid)));
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/trips', requireAuth, async (req, res) => {
  try {
    const { origin, originLat, originLng, destination, destinationLat, destinationLng,
            date, time, seats, notes, recurrence, recurrenceFrom, recurrenceTo, weekdays } = req.body;
    if (!origin || !destination || !time || !seats)
      return res.status(400).json({ error: 'Faltan campos obligatorios' });

    const seatsNum = parseInt(seats, 10);
    if (isNaN(seatsNum) || seatsNum < 1 || seatsNum > 6)
      return res.status(400).json({ error: 'Las plazas deben estar entre 1 y 6' });
    if (notes && notes.trim().length > 255)
      return res.status(400).json({ error: 'Las notas no pueden superar los 255 caracteres' });

    const oLat = parseFloat(originLat), oLng = parseFloat(originLng);
    const dLat = parseFloat(destinationLat), dLng = parseFloat(destinationLng);
    if (oLat && oLng && dLat && dLng && haversineKm(oLat, oLng, dLat, dLng) < 1)
      return res.status(400).json({ error: 'La distancia mínima entre origen y destino es de 1 km' });

    const todayStr   = new Date().toISOString().split('T')[0];
    const maxDateStr = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const uid = req.session.userId;

    const cooldownWait = checkUserCooldown(uid);
    if (cooldownWait > 0)
      return res.status(429).json({ error: `Espera ${cooldownWait} segundo${cooldownWait !== 1 ? 's' : ''} antes de publicar otro viaje` });

    const userTripCount = await col('trips').countDocuments({ userId: uid }, { maxTimeMS: 5000 });
    if (userTripCount >= MAX_TRIPS_PER_USER)
      return res.status(400).json({ error: `No puedes tener más de ${MAX_TRIPS_PER_USER} viajes publicados a la vez` });

    const users = await col('users').find({}).toArray();
    const base  = {
      userId: uid,
      origin, originLat: oLat || 0, originLng: oLng || 0,
      destination, destinationLat: dLat || 0, destinationLng: dLng || 0,
      time, seats: seatsNum, notes: notes || '',
      createdAt: new Date().toISOString(), bookings: [],
      recurrenceGroupId: null, recurrenceLabel: null
    };

    if (recurrence === 'weekly' && recurrenceFrom && recurrenceTo && Array.isArray(weekdays) && weekdays.length) {
      if (recurrenceFrom < todayStr) return res.status(400).json({ error: 'La fecha de inicio no puede ser anterior a hoy' });
      if (recurrenceTo   > maxDateStr) return res.status(400).json({ error: 'La fecha de fin no puede superar los próximos 60 días' });
      const days  = weekdays.map(Number);
      const dates = generateDates(recurrenceFrom, recurrenceTo, days);
      if (!dates.length) return res.status(400).json({ error: 'No hay fechas en ese rango con los días seleccionados' });
      if (dates.length > 90) return res.status(400).json({ error: 'Máximo 90 instancias por serie recurrente' });
      if (userTripCount + dates.length > MAX_TRIPS_PER_USER)
        return res.status(400).json({ error: `Esta serie crearía ${dates.length} viajes pero solo puedes añadir ${MAX_TRIPS_PER_USER - userTripCount} más (límite: ${MAX_TRIPS_PER_USER})` });

      const groupId  = uuidv4();
      const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
      const dayLabel  = days.sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b)).map(d => DAY_NAMES[d]).join(', ');
      const label     = `${dayLabel} · ${recurrenceFrom} – ${recurrenceTo}`;
      const trips     = dates.map(d => ({ ...base, id: uuidv4(), date: d, recurrenceGroupId: groupId, recurrenceLabel: label }));

      setUserCooldown(uid);
      await col('trips').insertMany(trips);
      res.json({ recurrent: true, count: trips.length, label, trips: trips.map(t => enrichTrip(t, users, uid)) });
    } else {
      if (!date) return res.status(400).json({ error: 'La fecha es obligatoria' });
      if (date < todayStr || date > maxDateStr)
        return res.status(400).json({ error: 'La fecha debe estar entre hoy y los próximos 60 días' });
      const trip = { ...base, id: uuidv4(), date };
      setUserCooldown(uid);
      await col('trips').insertOne(trip);
      res.json(enrichTrip(trip, users, uid));
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/trips/:id', requireAuth, async (req, res) => {
  try {
    const trip = await col('trips').findOne({ id: req.params.id });
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const user = await col('users').findOne({ id: req.session.userId });
    if (trip.userId !== req.session.userId && user?.role !== 'admin')
      return res.status(403).json({ error: 'Sin permisos' });
    await col('trips').deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

// ── Booking routes ────────────────────────────────────────────────────────────

app.post('/api/trips/:id/bookings', requireAuth, async (req, res) => {
  try {
    const trip = await col('trips').findOne({ id: req.params.id });
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    if (trip.userId === req.session.userId) return res.status(400).json({ error: 'No puedes reservar tu propio viaje' });
    const bookings = trip.bookings || [];
    if (bookings.some(b => b.userId === req.session.userId)) return res.status(400).json({ error: 'Ya tienes una reserva en este viaje' });
    if (bookings.length >= trip.seats) return res.status(400).json({ error: 'No quedan plazas disponibles' });

    const uid = req.session.userId;

    const cooldownWait = checkUserCooldown(uid);
    if (cooldownWait > 0)
      return res.status(429).json({ error: `Espera ${cooldownWait} segundo${cooldownWait !== 1 ? 's' : ''} antes de realizar otra reserva` });

    const activeBookings = await col('trips').countDocuments({ 'bookings.userId': uid }, { maxTimeMS: 5000 });
    if (activeBookings >= MAX_BOOKINGS_PER_USER)
      return res.status(400).json({ error: `No puedes tener más de ${MAX_BOOKINGS_PER_USER} reservas activas a la vez` });

    const { comment } = req.body || {};
    if (comment && comment.trim().length > 255)
      return res.status(400).json({ error: 'El comentario no puede superar los 255 caracteres' });
    const booking = { id: uuidv4(), userId: uid, bookedAt: new Date().toISOString(), comment: comment?.trim() || '' };

    setUserCooldown(uid);
    // Use $set on the full array to avoid any $push atomicity issues on Atlas M0
    const updatedBookings = [...bookings, booking];
    await col('trips').updateOne(
      { id: req.params.id },
      { $set: { bookings: updatedBookings } },
      { maxTimeMS: 10000 }
    );

    const [passenger, owner] = await Promise.all([
      col('users').findOne({ id: req.session.userId }, { maxTimeMS: 8000 }),
      col('users').findOne({ id: trip.userId }, { maxTimeMS: 8000 })
    ]);
    const commentLine = booking.comment ? `\n\nMensaje del pasajero: "${booking.comment}"` : '';
    sendEmail({
      to: owner?.email,
      subject: 'Nueva reserva en tu viaje — Comparte Ruta Granada',
      text: `Hola ${owner?.alias},\n\n${passenger?.alias} ha reservado una plaza en tu viaje:\n\n  Origen:  ${trip.origin}\n  Destino: ${trip.destination}\n  Fecha:   ${trip.date} a las ${trip.time}\n\nPlazas restantes: ${trip.seats - bookings.length - 1}${commentLine}\n\n— Comparte Ruta Granada`
    }).catch(err => console.error('[EMAIL booking]', err.message));
    res.json({ ...booking, userAlias: passenger?.alias || 'Usuario' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/trips/:id/bookings/:bid', requireAuth, async (req, res) => {
  try {
    const trip = await col('trips').findOne({ id: req.params.id });
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const user = await col('users').findOne({ id: req.session.userId });
    if (trip.userId !== req.session.userId && user?.role !== 'admin')
      return res.status(403).json({ error: 'Solo el propietario puede cancelar reservas' });
    const booking = (trip.bookings || []).find(b => b.id === req.params.bid);
    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
    const remaining = (trip.bookings || []).filter(b => b.id !== req.params.bid);
    await col('trips').updateOne({ id: req.params.id }, { $set: { bookings: remaining } }, { maxTimeMS: 10000 });
    const [passenger, owner] = await Promise.all([
      col('users').findOne({ id: booking.userId }, { maxTimeMS: 8000 }),
      col('users').findOne({ id: trip.userId }, { maxTimeMS: 8000 })
    ]);
    sendEmail({
      to: passenger?.email,
      subject: 'Tu reserva ha sido cancelada — Comparte Ruta Granada',
      text: `Hola ${passenger?.alias},\n\nEl organizador (${owner?.alias}) ha cancelado tu reserva en:\n\n  Origen:  ${trip.origin}\n  Destino: ${trip.destination}\n  Fecha:   ${trip.date} a las ${trip.time}\n\n— Comparte Ruta Granada`
    }).catch(err => console.error('[EMAIL cancel-by-owner]', err.message));
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/trips/:id/bookings/mine/cancel', requireAuth, async (req, res) => {
  try {
    const trip = await col('trips').findOne({ id: req.params.id });
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const booking = (trip.bookings || []).find(b => b.userId === req.session.userId);
    if (!booking) return res.status(404).json({ error: 'No tienes reserva en este viaje' });
    const remaining2 = (trip.bookings || []).filter(b => b.userId !== req.session.userId);
    await col('trips').updateOne({ id: req.params.id }, { $set: { bookings: remaining2 } }, { maxTimeMS: 10000 });
    const [passenger, owner] = await Promise.all([
      col('users').findOne({ id: req.session.userId }, { maxTimeMS: 8000 }),
      col('users').findOne({ id: trip.userId }, { maxTimeMS: 8000 })
    ]);
    sendEmail({
      to: owner?.email,
      subject: 'Reserva cancelada en tu viaje — Comparte Ruta Granada',
      text: `Hola ${owner?.alias},\n\n${passenger?.alias} ha cancelado su reserva en:\n\n  Origen:  ${trip.origin}\n  Destino: ${trip.destination}\n  Fecha:   ${trip.date} a las ${trip.time}\n\nAhora tienes ${remaining2.length > trip.seats - 1 ? 0 : trip.seats - remaining2.length} plaza(s) disponibles.\n\n— Comparte Ruta Granada`
    }).catch(err => console.error('[EMAIL cancel-by-passenger]', err.message));
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error interno' }); }
});

// ── Trip messages ─────────────────────────────────────────────────────────────

app.post('/api/trips/:id/messages', requireAuth, async (req, res) => {
  try {
    const trip = await col('trips').findOne({ id: req.params.id });
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const uid = req.session.userId;
    const isOwner     = trip.userId === uid;
    const isPassenger = (trip.bookings || []).some(b => b.userId === uid);
    if (!isOwner && !isPassenger)
      return res.status(403).json({ error: 'Solo el conductor y los pasajeros pueden comentar' });
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    if (text.trim().length > 255) return res.status(400).json({ error: 'El mensaje no puede superar los 255 caracteres' });
    const message = { id: uuidv4(), userId: uid, text: text.trim(), createdAt: new Date().toISOString() };
    const updatedMessages = [...(trip.messages || []), message];
    await col('trips').updateOne({ id: req.params.id }, { $set: { messages: updatedMessages } }, { maxTimeMS: 10000 });
    const user = await col('users').findOne({ id: uid }, { maxTimeMS: 5000 });
    res.json({ ...message, userAlias: user?.alias || 'Usuario' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error interno' }); }
});

// ── Delete account ────────────────────────────────────────────────────────────

app.delete('/api/users/me', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const bookedTrips = await col('trips').find({ 'bookings.userId': uid }).toArray();
    for (const trip of bookedTrips) {
      const remaining = (trip.bookings || []).filter(b => b.userId !== uid);
      await col('trips').updateOne({ id: trip.id }, { $set: { bookings: remaining } }, { maxTimeMS: 8000 });
    }
    await col('trips').deleteMany({ userId: uid });
    await col('users').deleteOne({ id: uid });
    await col('counters').updateOne({ id: 'deletedUsers' }, { $inc: { count: 1 } }, { upsert: true });
    req.session.destroy(() => res.json({ ok: true }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error interno' }); }
});

// ── Profile route ─────────────────────────────────────────────────────────────

app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const { alias, password, email, municipio, codigoPostal, walkingDistanceKm } = req.body;
    const update = {};
    if (alias             !== undefined) update.alias             = alias;
    if (email             !== undefined) update.email             = email;
    if (municipio         !== undefined) update.municipio         = municipio;
    if (codigoPostal      !== undefined) update.codigoPostal      = codigoPostal;
    if (walkingDistanceKm !== undefined) update.walkingDistanceKm = parseFloat(walkingDistanceKm);
    if (password)                        update.password          = await bcrypt.hash(password, 10);
    const result = await col('users').findOneAndUpdate(
      { id: req.session.userId }, { $set: update }, { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(safeUser(result));
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

// ── Forum routes ──────────────────────────────────────────────────────────────

app.get('/api/forum/threads', async (req, res) => {
  try {
    const users   = await col('users').find({}).toArray();
    const threads = await col('threads').find({}).sort({ createdAt: -1 }).toArray();
    res.json(threads.map(t => {
      const u = users.find(u => u.id === t.userId);
      return { id: t.id, title: t.title, content: t.content, userAlias: u?.alias || 'Usuario', createdAt: t.createdAt, replyCount: (t.replies || []).length, isReport: !!t.isReport };
    }));
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

app.get('/api/forum/threads/:id', async (req, res) => {
  try {
    const thread = await col('threads').findOne({ id: req.params.id });
    if (!thread) return res.status(404).json({ error: 'Hilo no encontrado' });
    const users = await col('users').find({}).toArray();
    const tu = users.find(u => u.id === thread.userId);
    const { _id, ...threadData } = thread;
    res.json({
      ...threadData,
      userAlias: tu?.alias || 'Usuario',
      replies: (thread.replies || []).map(r => {
        const ru = users.find(u => u.id === r.userId);
        return { ...r, userAlias: ru?.alias || 'Usuario' };
      })
    });
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/forum/threads', requireAuth, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Título y mensaje son obligatorios' });
    if (content.trim().length > 255) return res.status(400).json({ error: 'El mensaje no puede superar los 255 caracteres' });
    const thread = { id: uuidv4(), userId: req.session.userId, title, content, createdAt: new Date().toISOString(), replies: [], isReport: false };
    await col('threads').insertOne(thread);
    const u = await col('users').findOne({ id: req.session.userId });
    res.json({ ...thread, userAlias: u?.alias || 'Usuario', replyCount: 0 });
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/forum/threads/:id/replies', requireAuth, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'El mensaje no puede estar vacío' });
    if (content.trim().length > 255) return res.status(400).json({ error: 'El mensaje no puede superar los 255 caracteres' });
    const thread = await col('threads').findOne({ id: req.params.id });
    if (!thread) return res.status(404).json({ error: 'Hilo no encontrado' });
    const reply = { id: uuidv4(), userId: req.session.userId, content, createdAt: new Date().toISOString() };
    await col('threads').updateOne({ id: req.params.id }, { $push: { replies: reply } });
    const u = await col('users').findOne({ id: req.session.userId });
    res.json({ ...reply, userAlias: u?.alias || 'Usuario' });
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

app.delete('/api/forum/messages/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const asThread = await col('threads').findOne({ id: req.params.id });
    if (asThread) { await col('threads').deleteOne({ id: req.params.id }); return res.json({ ok: true, type: 'thread' }); }
    const result = await col('threads').updateOne({ 'replies.id': req.params.id }, { $pull: { replies: { id: req.params.id } } });
    if (result.modifiedCount) return res.json({ ok: true, type: 'reply' });
    res.status(404).json({ error: 'Mensaje no encontrado' });
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

// ── Reports route ─────────────────────────────────────────────────────────────

app.post('/api/reports', requireAuth, async (req, res) => {
  try {
    const { reportedUserId, message } = req.body;
    if (!reportedUserId || !message?.trim()) return res.status(400).json({ error: 'Faltan datos del reporte' });
    if (reportedUserId === req.session.userId) return res.status(400).json({ error: 'No puedes reportarte a ti mismo' });
    const [reported, reporter] = await Promise.all([
      col('users').findOne({ id: reportedUserId }),
      col('users').findOne({ id: req.session.userId })
    ]);
    if (!reported) return res.status(404).json({ error: 'Usuario no encontrado' });
    const newCount = (reported.reportCount || 0) + 1;
    await col('users').updateOne({ id: reportedUserId }, { $set: { reportCount: newCount } });
    const thread = { id: uuidv4(), userId: req.session.userId, title: `[REPORTE] Reporte contra el usuario "${reported.alias}"`, content: message, isReport: true, reportedUserId, createdAt: new Date().toISOString(), replies: [] };
    await col('threads').insertOne(thread);
    await col('reports').insertOne({ id: uuidv4(), reporterId: req.session.userId, reporterAlias: reporter?.alias || 'Usuario', reportedUserId, reportedAlias: reported.alias, message, threadId: thread.id, createdAt: thread.createdAt });
    res.json({ ok: true, reportCount: newCount, threadId: thread.id });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error interno' }); }
});

// ── Admin stats ───────────────────────────────────────────────────────────────

app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [totalUsers, newUsersWeek, deletedCounter, allTrips, allThreads] = await Promise.all([
      col('users').countDocuments(),
      col('users').countDocuments({ createdAt: { $gte: weekAgo } }),
      col('counters').findOne({ id: 'deletedUsers' }),
      col('trips').find({}, { projection: { bookings: 1, messages: 1, createdAt: 1 } }).toArray(),
      col('threads').find({}, { projection: { replies: 1, createdAt: 1, isReport: 1 } }).toArray(),
    ]);

    const totalTrips     = allTrips.length;
    const newTripsWeek   = allTrips.filter(t => (t.createdAt || '') >= weekAgo).length;

    const allBookings      = allTrips.flatMap(t => t.bookings || []);
    const totalBookings    = allBookings.length;
    const newBookingsWeek  = allBookings.filter(b => (b.bookedAt || '') >= weekAgo).length;

    const allTripMsgs       = allTrips.flatMap(t => t.messages || []);
    const totalTripMsgs     = allTripMsgs.length;
    const newTripMsgsWeek   = allTripMsgs.filter(m => (m.createdAt || '') >= weekAgo).length;

    const forumThreads      = allThreads.filter(t => !t.isReport);
    const totalThreads      = forumThreads.length;
    const newThreadsWeek    = forumThreads.filter(t => (t.createdAt || '') >= weekAgo).length;
    const allReplies        = forumThreads.flatMap(t => t.replies || []);
    const totalReplies      = allReplies.length;
    const newRepliesWeek    = allReplies.filter(r => (r.createdAt || '') >= weekAgo).length;

    res.json({
      users:         { total: totalUsers, newThisWeek: newUsersWeek, deleted: deletedCounter?.count || 0 },
      trips:         { total: totalTrips, newThisWeek: newTripsWeek },
      bookings:      { total: totalBookings, newThisWeek: newBookingsWeek },
      forum:         { threads: totalThreads, newThreadsThisWeek: newThreadsWeek, replies: totalReplies, newRepliesThisWeek: newRepliesWeek },
      conversations: { totalMessages: totalTripMsgs, newThisWeek: newTripMsgsWeek },
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Error interno' }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────

initDB()
  .then(() => initTransporter())
  .then(() => {
    app.listen(PORT, () => console.log(`Servidor v1.2 arriba en puerto ${PORT}`));
  })
  .catch(err => { console.error('Error al arrancar:', err); process.exit(1); });

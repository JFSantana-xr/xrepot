const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

loadDotEnv();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'xrepot.json');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_TTL = 1000 * 60 * 60 * 12;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil(MAX_IMAGE_BYTES * 1.4) + 16384;
const ADSENSE_CLIENT = /^ca-pub-\d+$/.test(process.env.ADSENSE_CLIENT || '') ? process.env.ADSENSE_CLIENT : '';
const ADSENSE_SLOT = /^\d+$/.test(process.env.ADSENSE_SLOT || '') ? process.env.ADSENSE_SLOT : '';
const sessions = new Map();
let store = readStore();
let publicCache = null;
const publicClients = new Set();
const adminClients = new Set();

function loadDotEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
function defaultStore() { return { maintenance: true, updatedAt: new Date().toISOString(), admins: [], announcements: [] }; }
function readStore() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      ...defaultStore(), ...value, admins: value.admins || [],
      announcements: (value.announcements || []).map((item) => ({ ...item, imageUrl: validImageUrl(item.imageUrl) }))
    };
  }
  catch (error) { if (error.code === 'ENOENT') return defaultStore(); throw new Error(`No se pudo leer la base de datos: ${error.message}`); }
}
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true }); store.updatedAt = new Date().toISOString();
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 }); fs.renameSync(temporary, DATA_FILE); publicCache = null; broadcastChanges();
}
function derivePassword(password, salt = crypto.randomBytes(16).toString('hex')) { return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; }
function verifyPassword(password, value) {
  const [salt, expected] = String(value).split(':'); if (!salt || !expected) return false;
  const received = crypto.scryptSync(password, salt, 64).toString('hex');
  const expectedBuffer = Buffer.from(expected, 'hex'); const receivedBuffer = Buffer.from(received, 'hex');
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
function normalizeEmail(email) { const value = String(email).trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : ''; }
function bootstrapAdmin() {
  if (store.admins.length) return; const email = normalizeEmail(process.env.ADMIN_EMAIL || ''); const password = process.env.ADMIN_PASSWORD || '';
  if (!email || password.length < 12) return console.warn('No hay administrador inicial. Define ADMIN_EMAIL y ADMIN_PASSWORD (mínimo 12 caracteres) en .env.');
  store.admins.push({ id: crypto.randomUUID(), email, passwordHash: derivePassword(password), createdAt: new Date().toISOString() }); persist(); console.log(`Administrador inicial creado: ${email}`);
}
function cookieValue(request, name) {
  const prefix = `${name}=`; const match = (request.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}
function sessionSignature(token) { return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('base64url'); }
function sessionFromRequest(request) {
  const value = cookieValue(request, 'xrepot_session'); if (!value || !SESSION_SECRET) return null; const [token, signature] = value.split('.'); if (!token || !signature) return null;
  const left = Buffer.from(signature); const right = Buffer.from(sessionSignature(token)); if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  const session = sessions.get(token); if (!session || session.expiresAt < Date.now()) { sessions.delete(token); return null; } return session;
}
function setSession(response, adminId) {
  if (!SESSION_SECRET) throw new Error('SESSION_SECRET es obligatorio para iniciar sesión.'); const token = crypto.randomBytes(32).toString('base64url'); sessions.set(token, { adminId, expiresAt: Date.now() + SESSION_TTL });
  response.setHeader('Set-Cookie', `xrepot_session=${encodeURIComponent(`${token}.${sessionSignature(token)}`)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL / 1000}${isProduction ? '; Secure' : ''}`);
}
function clearSession(request, response) { const value = cookieValue(request, 'xrepot_session'); if (value) sessions.delete(value.split('.')[0]); response.setHeader('Set-Cookie', `xrepot_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isProduction ? '; Secure' : ''}`); }
function validImageUrl(value) { return /^\/uploads\/[a-f0-9-]+\.(?:jpg|png|webp|gif)$/.test(String(value || '')) ? String(value) : ''; }
function publicState() {
  return publicCache ||= {
    maintenance: Boolean(store.maintenance),
    announcements: store.announcements.map(({ id, title, body, imageUrl, createdAt }) => ({ id, title, body, imageUrl: validImageUrl(imageUrl), createdAt })),
    advertising: ADSENSE_CLIENT && ADSENSE_SLOT ? { client: ADSENSE_CLIENT, slot: ADSENSE_SLOT } : null,
    updatedAt: store.updatedAt
  };
}
function dashboardState(admin) { return { maintenance: Boolean(store.maintenance), announcements: store.announcements, admins: store.admins.map(({ id, email, createdAt }) => ({ id, email, createdAt })), currentAdminId: admin.id, updatedAt: store.updatedAt }; }
function cleanText(value, length) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, length); }
function json(response, status, body, headers = {}) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers }); response.end(JSON.stringify(body)); }
function noContent(response) { response.writeHead(204); response.end(); }
function readJson(request, maximumBytes = 16384) {
  return new Promise((resolve, reject) => {
    let content = ''; let size = 0; let finished = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes && !finished) { finished = true; reject(new Error('La solicitud es demasiado grande.')); request.destroy(); return; }
      content += chunk;
    });
    request.on('end', () => { if (finished) return; try { resolve(content ? JSON.parse(content) : {}); } catch { reject(new Error('JSON inválido.')); } });
    request.on('error', (error) => { if (!finished) reject(error); });
  });
}
function adminFor(request) { const session = sessionFromRequest(request); return session && store.admins.find((item) => item.id === session.adminId); }
function requireAdmin(request, response) { const admin = adminFor(request); if (!admin) { json(response, 401, { error: 'Tu sesión expiró. Inicia sesión de nuevo.' }); return null; } return admin; }
function serveFile(response, file, cacheControl) {
  if (!fs.existsSync(file)) { response.writeHead(404); return response.end('No encontrado'); }
  const extension = path.extname(file).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
  response.writeHead(200, { 'Content-Type': types[extension] || 'application/octet-stream', 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' }); fs.createReadStream(file).pipe(response);
}
function event(response, name, data) { response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); }
function openEventStream(request, response, clients, initial) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.flushHeaders?.(); event(response, 'state', initial()); clients.add(response);
  const close = () => clients.delete(response); request.on('close', close); response.on('close', close);
}
function broadcastChanges() {
  const state = publicState();
  for (const response of publicClients) event(response, 'state', state);
  for (const response of adminClients) event(response, 'changed', { updatedAt: store.updatedAt });
}
function saveImage(dataUrl) {
  if (!dataUrl) return '';
  const matched = String(dataUrl).match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!matched) throw new Error('La imagen debe ser JPG, PNG, WEBP o GIF.');
  const content = Buffer.from(matched[2], 'base64');
  if (!content.length || content.length > MAX_IMAGE_BYTES) throw new Error('La imagen debe pesar como máximo 2 MB.');
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  fs.mkdirSync(UPLOAD_DIR, { recursive: true }); const filename = `${crypto.randomUUID()}.${extensions[matched[1]]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), content, { mode: 0o644 }); return `/uploads/${filename}`;
}
function removeImage(imageUrl) { const safe = validImageUrl(imageUrl); if (safe) fs.rmSync(path.join(UPLOAD_DIR, path.basename(safe)), { force: true }); }

bootstrapAdmin();
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`); const pathname = url.pathname;
  try {
    if (request.method === 'GET' && pathname === '/') return serveFile(response, path.join(__dirname, 'public', 'index.html'), 'no-cache');
    if (request.method === 'GET' && pathname === '/ad') return serveFile(response, path.join(__dirname, 'public', 'admin.html'), 'no-store');
    if (request.method === 'GET' && pathname === '/ads.txt') return serveFile(response, path.join(__dirname, 'public', 'ads.txt'), 'public, max-age=3600');
    if (request.method === 'GET' && pathname.startsWith('/assets/')) {
      const filename = path.basename(pathname); if (!['style.css', 'public.js', 'admin.js'].includes(filename)) return response.end();
      return serveFile(response, path.join(__dirname, 'public', 'assets', filename), 'public, max-age=86400, immutable');
    }
    if (request.method === 'GET' && pathname.startsWith('/uploads/')) {
      const filename = path.basename(pathname); if (!/^[a-f0-9-]+\.(?:jpg|png|webp|gif)$/.test(filename)) return response.end();
      return serveFile(response, path.join(UPLOAD_DIR, filename), 'public, max-age=31536000, immutable');
    }
    if (request.method === 'GET' && pathname === '/api/public') {
      const etag = `W/"${store.updatedAt}"`; if (request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return response.end(); }
      return json(response, 200, publicState(), { ETag: etag, 'Cache-Control': 'no-cache' });
    }
    if (request.method === 'GET' && pathname === '/api/public/events') return openEventStream(request, response, publicClients, publicState);
    if (request.method === 'POST' && pathname === '/api/ad/login') {
      const body = await readJson(request); const admin = store.admins.find((item) => item.email === normalizeEmail(body.email || ''));
      if (!admin || !verifyPassword(String(body.password || ''), admin.passwordHash)) return json(response, 401, { error: 'Correo o contraseña incorrectos.' });
      setSession(response, admin.id); return json(response, 200, { admin: { email: admin.email } });
    }
    if (request.method === 'POST' && pathname === '/api/ad/logout') { clearSession(request, response); return noContent(response); }
    if (request.method === 'GET' && pathname === '/api/ad/state') { const admin = requireAdmin(request, response); if (!admin) return; return json(response, 200, dashboardState(admin), { 'Cache-Control': 'no-store' }); }
    if (request.method === 'GET' && pathname === '/api/ad/events') { const admin = requireAdmin(request, response); if (!admin) return; return openEventStream(request, response, adminClients, () => ({ updatedAt: store.updatedAt })); }
    if (request.method === 'PATCH' && pathname === '/api/ad/maintenance') { if (!requireAdmin(request, response)) return; const body = await readJson(request); if (typeof body.maintenance !== 'boolean') return json(response, 400, { error: 'El valor de mantenimiento no es válido.' }); store.maintenance = body.maintenance; persist(); return json(response, 200, { maintenance: store.maintenance }); }
    if (request.method === 'POST' && pathname === '/api/ad/announcements') {
      if (!requireAdmin(request, response)) return; const body = await readJson(request, MAX_JSON_BYTES); const title = cleanText(body.title, 100); const message = cleanText(body.body, 500);
      if (!title || !message) return json(response, 400, { error: 'Escribe un título y un mensaje.' }); const imageUrl = saveImage(body.imageData); const item = { id: crypto.randomUUID(), title, body: message, imageUrl, createdAt: new Date().toISOString() }; store.announcements.unshift(item); persist(); return json(response, 201, item);
    }
    if (request.method === 'POST' && pathname === '/api/ad/admins') { if (!requireAdmin(request, response)) return; const body = await readJson(request); const email = normalizeEmail(body.email || ''); const password = String(body.password || ''); if (!email || password.length < 12) return json(response, 400, { error: 'Usa un correo válido y una contraseña de al menos 12 caracteres.' }); if (store.admins.some((item) => item.email === email)) return json(response, 409, { error: 'Ya existe una cuenta con ese correo.' }); const item = { id: crypto.randomUUID(), email, passwordHash: derivePassword(password), createdAt: new Date().toISOString() }; store.admins.push(item); persist(); return json(response, 201, { id: item.id, email: item.email, createdAt: item.createdAt }); }
    const announcementMatch = pathname.match(/^\/api\/ad\/announcements\/([\w-]+)$/); const administratorMatch = pathname.match(/^\/api\/ad\/admins\/([\w-]+)$/);
    if (request.method === 'DELETE' && announcementMatch) { if (!requireAdmin(request, response)) return; const item = store.announcements.find((announcement) => announcement.id === announcementMatch[1]); if (!item) return json(response, 404, { error: 'No existe ese anuncio.' }); store.announcements = store.announcements.filter((announcement) => announcement.id !== item.id); persist(); removeImage(item.imageUrl); return noContent(response); }
    if (request.method === 'DELETE' && administratorMatch) { const current = requireAdmin(request, response); if (!current) return; if (current.id === administratorMatch[1]) return json(response, 400, { error: 'No puedes eliminar tu propia cuenta.' }); if (store.admins.length <= 1) return json(response, 400, { error: 'Debe quedar al menos una cuenta administradora.' }); const count = store.admins.length; store.admins = store.admins.filter((item) => item.id !== administratorMatch[1]); if (count === store.admins.length) return json(response, 404, { error: 'No existe esa cuenta.' }); persist(); return noContent(response); }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('No encontrado');
  } catch (error) { console.error(error); if (!response.headersSent) json(response, 400, { error: error.message || 'Solicitud inválida.' }); else response.end(); }
});
setInterval(() => { const now = Date.now(); for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token); }, 1000 * 60 * 15).unref();
setInterval(() => { for (const response of publicClients) response.write(': keepalive\n\n'); for (const response of adminClients) response.write(': keepalive\n\n'); }, 25000).unref();
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, () => console.log(`Xrepot listo en http://localhost:${PORT}`));

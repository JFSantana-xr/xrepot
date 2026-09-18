const request = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'No se pudo completar la acción.');
  return body;
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
let state;
let realtime;

function error(id, message = '') { document.getElementById(id).textContent = message; }
function render() {
  document.getElementById('maintenance-toggle').checked = state.maintenance;
  document.getElementById('maintenance-label').textContent = state.maintenance ? 'Mantenimiento activo' : 'Sitio abierto';
  document.getElementById('maintenance-description').textContent = state.maintenance ? 'Las personas visitantes ven el aviso de mantenimiento.' : 'El sitio está marcado como disponible.';
  document.getElementById('admin-announcements').innerHTML = state.announcements.length ? state.announcements.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p>${item.imageUrl ? `<img class="admin-announcement-image" src="${escapeHtml(item.imageUrl)}" alt="" />` : ''}</div><button class="danger" data-delete-announcement="${item.id}">Eliminar</button></div>`).join('') : '<p class="empty">Aún no has publicado anuncios.</p>';
  document.getElementById('admin-users').innerHTML = state.admins.map((item) => `<div class="list-row"><div><strong>${escapeHtml(item.email)}</strong>${item.id === state.currentAdminId ? '<span class="you">Tu cuenta</span>' : ''}</div>${item.id === state.currentAdminId ? '' : `<button class="danger" data-delete-admin="${item.id}">Eliminar</button>`}</div>`).join('');
}
async function loadDashboard() {
  try {
    state = await request('/api/ad/state');
    document.getElementById('login-view').hidden = true;
    document.getElementById('dashboard-view').hidden = false;
    const me = state.admins.find((item) => item.id === state.currentAdminId);
    document.getElementById('admin-email').textContent = me?.email || '';
    render();
    if (!realtime) {
      realtime = new EventSource('/api/ad/events');
      realtime.addEventListener('changed', () => { window.clearTimeout(realtime.refreshTimer); realtime.refreshTimer = window.setTimeout(loadDashboard, 120); });
    }
  } catch { document.getElementById('login-view').hidden = false; }
}
document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); error('login-error');
  const formElement = event.currentTarget; const form = new FormData(formElement);
  try { await request('/api/ad/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) }); formElement.reset(); loadDashboard(); } catch (err) { error('login-error', err.message); }
});
document.getElementById('logout-button').addEventListener('click', async () => { realtime?.close(); await request('/api/ad/logout', { method: 'POST' }); location.reload(); });
document.getElementById('maintenance-toggle').addEventListener('change', async (event) => { try { await request('/api/ad/maintenance', { method: 'PATCH', body: JSON.stringify({ maintenance: event.target.checked }) }); state.maintenance = event.target.checked; render(); } catch (err) { event.target.checked = !event.target.checked; alert(err.message); } });
document.getElementById('announcement-form').addEventListener('submit', async (event) => {
  event.preventDefault(); error('announcement-error'); const form = event.currentTarget; const image = form.elements.image.files[0];
  try {
    if (image && image.size > 2 * 1024 * 1024) throw new Error('La imagen debe pesar como máximo 2 MB.');
    const fields = new FormData(form); const payload = { title: fields.get('title'), body: fields.get('body') };
    if (image) payload.imageData = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('No se pudo leer la imagen.')); reader.readAsDataURL(image); });
    const item = await request('/api/ad/announcements', { method: 'POST', body: JSON.stringify(payload) }); state.announcements.unshift(item); form.reset(); render();
  } catch (err) { error('announcement-error', err.message); }
});
document.getElementById('admin-form').addEventListener('submit', async (event) => { const form = event.currentTarget; event.preventDefault(); error('admin-error'); try { const item = await request('/api/ad/admins', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); state.admins.push(item); form.reset(); render(); } catch (err) { error('admin-error', err.message); } });
document.addEventListener('click', async (event) => { const announcement = event.target.dataset.deleteAnnouncement; const admin = event.target.dataset.deleteAdmin; if (!announcement && !admin) return; if (!confirm('¿Confirmas esta eliminación?')) return; try { await request(announcement ? `/api/ad/announcements/${announcement}` : `/api/ad/admins/${admin}`, { method: 'DELETE' }); if (announcement) state.announcements = state.announcements.filter((item) => item.id !== announcement); else state.admins = state.admins.filter((item) => item.id !== admin); render(); } catch (err) { alert(err.message); } });
loadDashboard();

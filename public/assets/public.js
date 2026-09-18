const formatDate = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric' });
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function renderAd(advertising) {
  const banner = document.getElementById('ad-banner');
  if (!advertising) { banner.hidden = true; return; }
  if (!document.getElementById('adsense-script')) {
    const script = document.createElement('script'); script.id = 'adsense-script'; script.async = true; script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(advertising.client)}`; script.crossOrigin = 'anonymous'; document.head.append(script);
  }
  if (!banner.dataset.slot) {
    banner.dataset.slot = advertising.slot;
    banner.innerHTML = `<span class="ad-label">Publicidad</span><ins class="adsbygoogle" style="display:block" data-ad-client="${escapeHtml(advertising.client)}" data-ad-slot="${escapeHtml(advertising.slot)}" data-ad-format="auto" data-full-width-responsive="true"></ins>`;
    window.adsbygoogle = window.adsbygoogle || []; window.adsbygoogle.push({});
  }
  banner.hidden = false;
}
function renderPublicState(state) {
  document.getElementById('status-text').textContent = state.maintenance ? 'Mantenimiento en curso' : 'Servicio disponible';
  document.getElementById('headline').innerHTML = state.maintenance ? 'Estamos mejorando<br /><em>Xrepot.</em>' : 'Xrepot está<br /><em>disponible.</em>';
  document.getElementById('lead-text').textContent = state.maintenance ? 'Realizamos mantenimiento para construir una experiencia más rápida y confiable. Pronto tendremos novedades para ti.' : 'El mantenimiento ha finalizado. Gracias por tu paciencia; volvemos con nuevas mejoras.';
  const section = document.getElementById('announcements-section');
  if (state.announcements.length) {
    document.getElementById('announcements-list').innerHTML = state.announcements.map((item) => `<article class="announcement">${item.imageUrl ? `<img class="announcement-image" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" />` : ''}<time>${formatDate.format(new Date(item.createdAt))}</time><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.body)}</p></article>`).join('');
    section.hidden = false;
  } else section.hidden = true;
  renderAd(state.advertising);
}
async function loadPublicState() {
  try { const response = await fetch('/api/public', { cache: 'no-cache' }); if (!response.ok) throw new Error(); renderPublicState(await response.json()); } catch { /* La página principal sigue siendo útil incluso sin la API. */ }
}

document.getElementById('year').textContent = new Date().getFullYear();
loadPublicState();
const publicEvents = new EventSource('/api/public/events');
publicEvents.addEventListener('state', (event) => { try { renderPublicState(JSON.parse(event.data)); } catch { /* Ignora eventos incompletos. */ } });

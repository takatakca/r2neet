/** Bundle entry. Boot failure surfaces a recovery screen, never a blank page. */
import { boot } from './main.js';

boot().catch((e) => {
  console.error('[r2nette] boot failed', e);
  document.body.dataset.boot = 'FRONTEND_ERROR';
  const veil = document.getElementById('boot');
  if (veil) {
    veil.hidden = false;
    veil.innerHTML = `<div class="boot-in"><div class="boot-mark">R2</div>
      <h2>Booking is temporarily unavailable.</h2>
      <p>Please try again, or call us and we'll book it for you.</p>
      <button class="btn btn-primary" onclick="location.reload()">Try again</button>
      <a class="btn btn-ghost" href="tel:+15148252825">Call (514) 825-2825</a></div>`;
  }
});

// Progressive enhancement: swap in a real photo only once it actually loads.
const photo = document.getElementById('heroPhoto');
if (photo) {
  // Optional: only applied if the owner drops a real photo in. A missing file
// is expected and must not surface as a console error.
  const img = new Image();
  img.onload = () => photo.classList.add('loaded');
  img.onerror = () => { /* no photo yet — the gradient hero stands alone */ };
  img.src = '/assets/hero.jpg';
}

/** Account bundle entry. Boot failure shows a recovery screen, never blank. */
import { bootAccount } from './account.js';

try {
  bootAccount();
} catch (e) {
  console.error('[r2nette account] boot failed', e);
  const up = document.getElementById('upcoming');
  if (up) {
    up.innerHTML = `<div class="empty"><div class="ic">⚠</div>
      <div class="t">This page is temporarily unavailable.</div>
      <div class="s">Please try again, or call us and we'll help.</div>
      <a class="btn btn-primary" href="tel:+15148252825">Call (514) 825-2825</a></div>`;
  }
}

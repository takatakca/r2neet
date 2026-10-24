import { inventoryBatches, CONTACT_STATUSES } from '../../../src/migration/customer-contacts.js';

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Contact = { id: string; email: string; displayName: string | null; status: string;
  sourceCount: number; firstSeenAt: string; lastSeenAt: string };
type Account = { id: string; email: string | null; displayName: string;
  registrationCompleted: boolean; bookingCount: number };
const labels: Record<string, string> = { TO_REVIEW: 'À qualifier', PROSPECT: 'Prospect', CUSTOMER: 'Client', OTHER: 'Autre' };
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const date = (v: string) => new Intl.DateTimeFormat('fr-CA', { timeZone: 'America/Toronto' }).format(new Date(v));

export function mountCustomerContacts(container: HTMLElement, api: Api) {
  const root = document.createElement('section');
  root.lang = 'fr';
  container.replaceChildren(root);
  const state = { q: '', status: '', page: 1, accounts: false };
  let sequence = 0;
  let busy = false;
  let notice = '';
  const base = '/api/v1/admin/customer-contacts';
  const statusOptions = (selected: string) => CONTACT_STATUSES.map((s) =>
    `<option value="${s}" ${s === selected ? 'selected' : ''}>${labels[s]}</option>`).join('');

  async function render() {
    const request = ++sequence;
    root.innerHTML = `<div class="hdr"><div><h1>Clients et contacts</h1>
      <p class="sub">Retrouvez vos contacts et leurs sources, puis classez-les selon votre relation.</p></div></div>
      <p role="status" aria-live="polite">${esc(notice)}</p>
      <div class="panel" style="padding:16px;display:grid;gap:16px">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button type="button" class="btn" data-view="contacts" aria-pressed="${!state.accounts}">Contacts courriel</button>
          <button type="button" class="btn" data-view="accounts" aria-pressed="${state.accounts}">Comptes du site</button>
        </div>
        <form data-search style="display:flex;gap:10px;align-items:end;flex-wrap:wrap">
          <label>Nom ou courriel<br><input name="q" type="search" maxlength="120" value="${esc(state.q)}"></label>
          ${state.accounts ? '' : `<label>Classement<br><select name="status"><option value="">Tous</option>${statusOptions(state.status)}</select></label>`}
          <button class="btn" type="submit">Rechercher</button>
        </form>
        ${state.accounts ? '' : `<form data-import><label>Inventaire courriel (JSON)<br>
          <input type="file" name="inventory" accept=".json,application/json" required></label>
          <button type="submit" class="btn">Importer les contacts</button>
          <p class="sub">Les contacts importés restent à qualifier. Aucun compte de connexion ni abonnement aux infolettres n’est créé.</p>
        </form>`}
      </div><div data-results class="panel" style="overflow-x:auto"><p style="padding:16px" role="status">Chargement…</p></div>
      <div data-detail></div>`;
    try {
      const query = new URLSearchParams({ q: state.q, page: String(state.page) });
      if (state.status && !state.accounts) query.set('status', state.status);
      const data = await api<{ contacts?: Contact[]; accounts?: Account[]; total: number; page: number; pageSize: number }>(
        `${base}${state.accounts ? '/accounts' : ''}?${query}`);
      if (request !== sequence) return;
      const target = root.querySelector<HTMLElement>('[data-results]')!;
      const rows = state.accounts ? (data.accounts || []).map((c) => `<tr><td>${esc(c.displayName || 'Sans nom')}</td>
        <td>${esc(c.email || '—')}</td><td>${c.registrationCompleted ? 'Inscription terminée' : 'Inscription incomplète'}</td>
        <td>${c.bookingCount}</td></tr>`) : (data.contacts || []).map((c) => `<tr>
          <td><label>Nom<br><input data-name="${esc(c.id)}" maxlength="200" value="${esc(c.displayName || '')}" placeholder="Sans nom"></label></td><td>${esc(c.email)}</td>
          <td><label>Classement de ${esc(c.displayName || c.email)}<br><select data-status="${esc(c.id)}">${statusOptions(c.status)}</select></label>
            <button type="button" class="btn" data-save="${esc(c.id)}">Enregistrer</button></td>
          <td>${date(c.lastSeenAt)}</td><td><button type="button" class="btn" data-sources="${esc(c.id)}">${c.sourceCount} source(s)</button></td>
        </tr>`);
      target.innerHTML = `<div class="panel-h"><h2>${data.total} ${state.accounts ? 'compte(s)' : 'contact(s)'}</h2></div>
        ${rows.length ? `<table><thead><tr><th>Nom</th><th>Courriel</th><th>${state.accounts ? 'Inscription' : 'Classement'}</th>
          <th>${state.accounts ? 'Réservations' : 'Dernier échange'}</th>${state.accounts ? '' : '<th>Provenance</th>'}</tr></thead>
          <tbody>${rows.join('')}</tbody></table>` : '<p style="padding:20px">Aucun résultat. Modifiez la recherche ou importez votre inventaire.</p>'}
        <div style="padding:16px;display:flex;gap:12px;align-items:center">
          <button type="button" class="btn" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>Précédent</button>
          <span>Page ${state.page}</span>
          <button type="button" class="btn" data-page="${state.page + 1}" ${state.page * data.pageSize >= data.total ? 'disabled' : ''}>Suivant</button>
        </div>`;
    } catch {
      if (request === sequence) root.querySelector('[data-results]')!.innerHTML =
        '<p role="alert" style="padding:20px">Chargement impossible. Vérifiez votre connexion et votre accès administrateur, puis réessayez.</p>';
    }
  }

  root.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const form = event.target as HTMLFormElement;
    if (form.matches('[data-search]')) {
      const input = new FormData(form);
      state.q = String(input.get('q') || '').trim();
      state.status = String(input.get('status') || ''); state.page = 1;
      await render(); return;
    }
    if (!form.matches('[data-import]')) return;
    const file = (form.elements.namedItem('inventory') as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { notice = 'Le fichier dépasse 8 Mo.'; await render(); return; }
    busy = true;
    const button = form.querySelector('button')!;
    button.disabled = true;
    let completed = 0;
    try {
      const batches = inventoryBatches(JSON.parse(await file.text()));
      for (const batch of batches) {
        button.textContent = `Import ${completed + 1}/${batches.length}…`;
        await api(`${base}/import`, { method: 'POST', body: JSON.stringify(batch) });
        completed++;
      }
      notice = 'Inventaire importé. Les doublons de courriel et de source ont été évités.';
    } catch {
      notice = completed ? `Import interrompu après ${completed} lot(s). Relancez le même fichier pour poursuivre sans doublon.`
        : 'Import impossible. Vérifiez le format de l’inventaire et votre accès, puis réessayez.';
    } finally { busy = false; await render(); }
  });

  root.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || button.disabled || busy) return;
    if (button.dataset.view) { state.accounts = button.dataset.view === 'accounts'; state.status = ''; state.page = 1; await render(); }
    if (button.dataset.page) { state.page = Number(button.dataset.page); await render(); }
    if (button.dataset.save) {
      const select = [...root.querySelectorAll<HTMLSelectElement>('[data-status]')].find((el) => el.dataset.status === button.dataset.save)!;
      const name = [...root.querySelectorAll<HTMLInputElement>('[data-name]')].find((el) => el.dataset.name === button.dataset.save)!;
      button.disabled = true;
      try {
        await api(`${base}/${button.dataset.save}`, { method: 'PATCH', body: JSON.stringify({ status: select.value, displayName: name.value.trim() || null }) });
        notice = 'Classement enregistré.'; await render();
      } catch { notice = 'Le classement n’a pas été enregistré. Réessayez.'; await render(); }
    }
    if (button.dataset.sources) {
      const panel = root.querySelector<HTMLElement>('[data-detail]')!;
      panel.innerHTML = '<p role="status">Chargement des sources…</p>';
      try {
        const detail = await api<{ displayName: string | null; email: string; sourceCount: number;
          hasMoreSources: boolean; sources: { id: string; occurredAt: string; url: string }[] }>(`${base}/${button.dataset.sources}`);
        panel.innerHTML = `<div class="panel" style="padding:20px"><h2>Sources — ${esc(detail.displayName || detail.email)}</h2>
          <ul>${detail.sources.map((s) => `<li><a target="_blank" rel="noopener noreferrer" href="${esc(s.url)}">Courriel du ${date(s.occurredAt)}</a></li>`).join('')}</ul>
          ${detail.hasMoreSources ? `<p>Les 100 sources les plus récentes sont affichées, sur ${detail.sourceCount}.</p>` : ''}</div>`;
      } catch { panel.innerHTML = '<p role="alert">Impossible de charger les sources.</p>'; }
    }
  });
  void render();
}

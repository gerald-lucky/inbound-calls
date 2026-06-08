'use strict';

// ── Tab navigation ────────────────────────────────────────────────────────────

const navLinks = document.querySelectorAll('.nav-links a');
const tabs = document.querySelectorAll('.tab');

function showTab(name) {
  tabs.forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  if (name === 'dashboard') loadDashboard();
  if (name === 'routing')   loadRouting();
  if (name === 'calls')     loadCalls();
  if (name === 'leads')     loadLeads();
  if (name === 'tenants')  loadTenants();
  if (name === 'payments')  loadPayments();
  if (name === 'knowledge') loadKnowledge();
}

navLinks.forEach((a) =>
  a.addEventListener('click', (e) => { e.preventDefault(); showTab(a.dataset.tab); }),
);

// ── Shared helpers ────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  if (opts.raw) return res;
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const stats = await apiFetch('/api/calls/stats');
    document.querySelector('#stat-total .stat-value').textContent  = stats.total_calls ?? '0';
    document.querySelector('#stat-last7 .stat-value').textContent  = stats.calls_last_7_days ?? '0';
    document.querySelector('#stat-unique .stat-value').textContent = stats.unique_callers ?? '0';
    document.querySelector('#stat-duration .stat-value').textContent = fmtDuration(stats.avg_duration_seconds);
  } catch { /* stats are non-critical */ }

  const el = document.getElementById('recent-calls-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  try {
    const calls = await apiFetch('/api/calls?limit=10');
    el.innerHTML = calls.length ? renderCallsTable(calls, true) : '<p class="empty">No calls yet.</p>';
    el.querySelectorAll('.view-transcript').forEach((btn) => {
      btn.addEventListener('click', () => openTranscript(btn.dataset.id));
    });
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

document.getElementById('dash-refresh').addEventListener('click', loadDashboard);

// ── Routing ───────────────────────────────────────────────────────────────────

let _agentConfigs = [];

async function loadRouting() {
  const el = document.getElementById('routing-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  try {
    _agentConfigs = await apiFetch('/api/agent-configs');
    if (!_agentConfigs.length) {
      el.innerHTML = '<p class="empty">No agents configured yet. Click "+ New Agent" to get started.</p>';
      return;
    }
    el.innerHTML = renderRoutingTable(_agentConfigs);
    el.querySelectorAll('.edit-config').forEach((btn) =>
      btn.addEventListener('click', () => openConfigModal(btn.dataset.id)));
    el.querySelectorAll('.delete-config').forEach((btn) =>
      btn.addEventListener('click', () => deleteConfig(btn.dataset.id, btn.dataset.name)));
    el.querySelectorAll('.toggle-config').forEach((btn) =>
      btn.addEventListener('click', () => toggleConfig(btn.dataset.id, btn.dataset.active === 'true')));
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
  populateConfigFilter('calls-filter-config');
  populateConfigFilter('leads-filter-config');
}

function renderRoutingTable(configs) {
  const rows = configs.map((c) => `
    <tr>
      <td><strong>${esc(c.name)}</strong></td>
      <td class="number-cell">${esc(c.quo_number || '—')}<span class="arrow">→</span>${esc(c.twilio_number)}</td>
      <td><span class="badge ${c.is_active ? 'badge-green' : 'badge-gray'}">${c.is_active ? 'Active' : 'Paused'}</span></td>
      <td>${c.total_calls ?? 0}</td>
      <td>${fmtDuration(c.avg_duration_seconds)}</td>
      <td>
        <button class="btn-link edit-config" data-id="${c.id}">Edit</button>
        &nbsp;
        <button class="btn-secondary toggle-config" data-id="${c.id}" data-active="${c.is_active}" style="font-size:.75rem;padding:.2rem .55rem">
          ${c.is_active ? 'Pause' : 'Resume'}
        </button>
        &nbsp;
        <button class="btn-danger delete-config" data-id="${c.id}" data-name="${esc(c.name)}">Delete</button>
      </td>
    </tr>`).join('');
  return `<table>
    <thead><tr>
      <th>Agent</th><th>Quo → Twilio</th><th>Status</th><th>Calls</th><th>Avg Duration</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function populateConfigFilter(selectId) {
  const sel = document.getElementById(selectId);
  const current = sel.value;
  sel.innerHTML = '<option value="">All agents</option>' +
    _agentConfigs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = current;
}

// New agent button
document.getElementById('new-config-btn').addEventListener('click', () => openConfigModal(null));

function openConfigModal(id) {
  const modal = document.getElementById('config-modal-backdrop');
  const form  = document.getElementById('config-form');
  form.reset();
  document.getElementById('config-id').value = '';

  if (id) {
    const cfg = _agentConfigs.find((c) => c.id === id);
    if (!cfg) return;
    document.getElementById('modal-title').textContent = 'Edit Agent';
    document.getElementById('config-id').value   = cfg.id;
    document.getElementById('f-name').value      = cfg.name;
    document.getElementById('f-twilio').value    = cfg.twilio_number;
    document.getElementById('f-quo').value       = cfg.quo_number || '';
    document.getElementById('f-prompt').value    = cfg.system_prompt;
    document.getElementById('f-greeting').value  = cfg.greeting;
    document.getElementById('f-voice').value     = cfg.voice_id;
    document.getElementById('f-active').value    = String(cfg.is_active);
  } else {
    document.getElementById('modal-title').textContent = 'New Agent';
  }

  modal.hidden = false;
}

function closeConfigModal() {
  document.getElementById('config-modal-backdrop').hidden = true;
}

document.getElementById('modal-close').addEventListener('click', closeConfigModal);
document.getElementById('modal-cancel').addEventListener('click', closeConfigModal);
document.getElementById('config-modal-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeConfigModal();
});

document.getElementById('config-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('config-id').value;
  const payload = {
    name:          document.getElementById('f-name').value.trim(),
    twilio_number: document.getElementById('f-twilio').value.trim(),
    quo_number:    document.getElementById('f-quo').value.trim() || null,
    system_prompt: document.getElementById('f-prompt').value.trim(),
    greeting:      document.getElementById('f-greeting').value.trim() || null,
    voice_id:      document.getElementById('f-voice').value.trim() || null,
    is_active:     document.getElementById('f-active').value === 'true',
  };

  const btn = document.getElementById('modal-save');
  btn.disabled = true;
  try {
    if (id) {
      await apiFetch(`/api/agent-configs/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await apiFetch('/api/agent-configs', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeConfigModal();
    loadRouting();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

async function deleteConfig(id, name) {
  if (!confirm(`Delete agent "${name}"? Existing call logs will be kept.`)) return;
  try {
    await apiFetch(`/api/agent-configs/${id}`, { method: 'DELETE', raw: true });
    loadRouting();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

async function toggleConfig(id, currentlyActive) {
  try {
    await apiFetch(`/api/agent-configs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_active: !currentlyActive }),
    });
    loadRouting();
  } catch (err) {
    alert(`Update failed: ${err.message}`);
  }
}

// ── Calls ─────────────────────────────────────────────────────────────────────

async function loadCalls() {
  const el = document.getElementById('calls-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  const configId = document.getElementById('calls-filter-config').value;
  const qs = configId ? `?agentConfigId=${configId}` : '';
  try {
    const calls = await apiFetch(`/api/calls${qs}`);
    el.innerHTML = calls.length ? renderCallsTable(calls) : '<p class="empty">No calls yet.</p>';
    el.querySelectorAll('.view-transcript').forEach((btn) =>
      btn.addEventListener('click', () => openTranscript(btn.dataset.id)));
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

function renderCallsTable(calls, compact = false) {
  const rows = calls.map((c) => `
    <tr>
      ${!compact ? `<td><span class="badge badge-blue">${esc(c.agent_configs?.name || '—')}</span></td>` : ''}
      <td class="number-cell">${esc(c.caller_number)}</td>
      <td>${fmtTime(c.started_at)}</td>
      <td>${fmtDuration(c.duration_seconds)}</td>
      <td>
        ${Array.isArray(c.transcript) && c.transcript.length
          ? `<button class="btn-link view-transcript" data-id="${c.id}">View (${c.transcript.length} msgs)</button>`
          : '<span class="empty">—</span>'}
      </td>
    </tr>`).join('');

  return `<table>
    <thead><tr>
      ${!compact ? '<th>Agent</th>' : ''}
      <th>Caller</th><th>Time</th><th>Duration</th><th>Transcript</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

document.getElementById('calls-refresh').addEventListener('click', loadCalls);
document.getElementById('calls-filter-config').addEventListener('change', loadCalls);

// ── Transcript drawer ─────────────────────────────────────────────────────────

async function openTranscript(callId) {
  const backdrop = document.getElementById('transcript-backdrop');
  const body     = document.getElementById('transcript-body');
  const meta     = document.getElementById('drawer-meta');
  const title    = document.getElementById('drawer-title');

  body.innerHTML = '<p class="loading">Loading…</p>';
  backdrop.hidden = false;

  try {
    const call = await apiFetch(`/api/calls/${callId}`);
    title.textContent = `Transcript — ${esc(call.caller_number)}`;
    meta.textContent  = `${fmtTime(call.started_at)}  ·  ${fmtDuration(call.duration_seconds)}  ·  ${esc(call.agent_configs?.name || 'No agent')}`;

    if (!call.transcript?.length) {
      body.innerHTML = '<p class="empty">No transcript recorded.</p>';
      return;
    }

    body.innerHTML = call.transcript.map((entry) => {
      const cls = entry.role === 'caller' ? 't-caller' : 't-agent';
      const ts  = entry.ts ? `<div class="t-ts">${fmtTime(entry.ts)}</div>` : '';
      return `${ts}<div class="t-bubble ${cls}">${esc(entry.text)}</div>`;
    }).join('');

    // Scroll to bottom
    body.scrollTop = body.scrollHeight;
  } catch (err) {
    body.innerHTML = `<p class="empty">Failed to load: ${esc(err.message)}</p>`;
  }
}

document.getElementById('drawer-close').addEventListener('click', () => {
  document.getElementById('transcript-backdrop').hidden = true;
});

document.getElementById('transcript-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) document.getElementById('transcript-backdrop').hidden = true;
});

// ── Leads ─────────────────────────────────────────────────────────────────────

async function loadLeads() {
  const el = document.getElementById('leads-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  const configId = document.getElementById('leads-filter-config').value;
  const qs = configId ? `?agentConfigId=${configId}` : '';
  try {
    const leads = await apiFetch(`/api/leads${qs}`);
    if (!leads.length) {
      el.innerHTML = '<p class="empty">No leads captured yet. Leads are automatically detected when callers provide contact information.</p>';
      return;
    }
    const rows = leads.map((l) => `
      <tr>
        <td>${esc(l.name || '—')}</td>
        <td class="number-cell">${esc(l.caller_number)}</td>
        <td>${esc(l.email || '—')}</td>
        <td>${esc(l.notes || '—')}</td>
        <td><span class="badge badge-blue">${esc(l.agent_configs?.name || '—')}</span></td>
        <td>${fmtDate(l.created_at)}</td>
        <td><button class="btn-danger delete-lead" data-id="${l.id}">Delete</button></td>
      </tr>`).join('');

    el.innerHTML = `<table>
      <thead><tr>
        <th>Name</th><th>Phone</th><th>Email</th><th>Notes</th><th>Agent</th><th>Date</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

    el.querySelectorAll('.delete-lead').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this lead?')) return;
        try {
          await apiFetch(`/api/leads/${btn.dataset.id}`, { method: 'DELETE', raw: true });
          loadLeads();
        } catch (err) { alert(err.message); }
      }));
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

document.getElementById('leads-refresh').addEventListener('click', loadLeads);
document.getElementById('leads-filter-config').addEventListener('change', loadLeads);

// ── Tenants ───────────────────────────────────────────────────────────────────

let _tenants = [];

async function loadTenants() {
  const el = document.getElementById('tenants-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  try {
    _tenants = await apiFetch('/api/tenants');
    populateTenantFilter();
    if (!_tenants.length) {
      el.innerHTML = '<p class="empty">No tenants yet. Click "+ Add Tenant" to get started.</p>';
      return;
    }
    const rows = _tenants.map((t) => `
      <tr>
        <td>${esc(t.first_name)} ${esc(t.last_name)}</td>
        <td>${esc(t.lot_number)}</td>
        <td class="number-cell">$${Number(t.lot_rent_amount).toFixed(2)}/mo</td>
        <td>${fmtDate(t.move_in_date)}</td>
        <td class="${Number(t.balance_due) > 0 ? 'text-danger' : ''}">$${Number(t.balance_due).toFixed(2)}</td>
        <td class="number-cell">${esc(t.phone_number)}</td>
        <td>${esc(t.email || '—')}</td>
        <td>
          <button class="btn-link edit-tenant" data-id="${t.id}">Edit</button>
          &nbsp;
          <button class="btn-danger delete-tenant" data-id="${t.id}" data-name="${esc(t.first_name + ' ' + t.last_name)}">Delete</button>
        </td>
      </tr>`).join('');
    el.innerHTML = `<table>
      <thead><tr>
        <th>Name</th><th>Lot</th><th>Rent</th><th>Move-in</th><th>Balance</th><th>Phone</th><th>Email</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    el.querySelectorAll('.edit-tenant').forEach((btn) =>
      btn.addEventListener('click', () => openTenantModal(btn.dataset.id)));
    el.querySelectorAll('.delete-tenant').forEach((btn) =>
      btn.addEventListener('click', () => deleteTenant(btn.dataset.id, btn.dataset.name)));
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

function populateTenantFilter() {
  const sel = document.getElementById('payments-filter-tenant');
  const current = sel.value;
  sel.innerHTML = '<option value="">All tenants</option>' +
    _tenants.map((t) => `<option value="${t.id}">${esc(t.first_name + ' ' + t.last_name)} — Lot ${esc(t.lot_number)}</option>`).join('');
  sel.value = current;

  const pf = document.getElementById('pf-tenant');
  const pfCurrent = pf.value;
  pf.innerHTML = '<option value="">Select tenant…</option>' +
    _tenants.map((t) => `<option value="${t.id}">${esc(t.first_name + ' ' + t.last_name)} — Lot ${esc(t.lot_number)}</option>`).join('');
  pf.value = pfCurrent;
}

document.getElementById('new-tenant-btn').addEventListener('click', () => openTenantModal(null));

function openTenantModal(id) {
  const backdrop = document.getElementById('tenant-modal-backdrop');
  document.getElementById('tenant-form').reset();
  document.getElementById('tenant-id').value = '';

  if (id) {
    const t = _tenants.find((x) => x.id === id);
    if (!t) return;
    document.getElementById('tenant-modal-title').textContent = 'Edit Tenant';
    document.getElementById('tenant-id').value   = t.id;
    document.getElementById('tf-first').value    = t.first_name;
    document.getElementById('tf-last').value     = t.last_name;
    document.getElementById('tf-phone').value    = t.phone_number;
    document.getElementById('tf-email').value    = t.email || '';
    document.getElementById('tf-lot').value      = t.lot_number;
    document.getElementById('tf-rent').value     = t.lot_rent_amount;
    document.getElementById('tf-movein').value   = t.move_in_date;
    document.getElementById('tf-balance').value  = t.balance_due;
  } else {
    document.getElementById('tenant-modal-title').textContent = 'Add Tenant';
  }
  backdrop.hidden = false;
}

function closeTenantModal() {
  document.getElementById('tenant-modal-backdrop').hidden = true;
}

document.getElementById('tenant-modal-close').addEventListener('click', closeTenantModal);
document.getElementById('tenant-modal-cancel').addEventListener('click', closeTenantModal);
document.getElementById('tenant-modal-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeTenantModal();
});

document.getElementById('tenant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('tenant-id').value;
  const payload = {
    first_name:       document.getElementById('tf-first').value.trim(),
    last_name:        document.getElementById('tf-last').value.trim(),
    phone_number:     document.getElementById('tf-phone').value.trim(),
    email:            document.getElementById('tf-email').value.trim() || null,
    lot_number:       document.getElementById('tf-lot').value.trim(),
    lot_rent_amount:  parseFloat(document.getElementById('tf-rent').value),
    move_in_date:     document.getElementById('tf-movein').value,
    balance_due:      parseFloat(document.getElementById('tf-balance').value) || 0,
  };

  try {
    if (id) {
      await apiFetch(`/api/tenants/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await apiFetch('/api/tenants', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeTenantModal();
    loadTenants();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
});

async function deleteTenant(id, name) {
  if (!confirm(`Delete tenant "${name}"? Their payment history will also be deleted.`)) return;
  try {
    await apiFetch(`/api/tenants/${id}`, { method: 'DELETE', raw: true });
    loadTenants();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

// ── Payments ──────────────────────────────────────────────────────────────────

async function loadPayments() {
  const el = document.getElementById('payments-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  const tenantId = document.getElementById('payments-filter-tenant').value;
  const qs = tenantId ? `?tenant_id=${tenantId}` : '';
  try {
    const payments = await apiFetch(`/api/payments${qs}`);
    if (!payments.length) {
      el.innerHTML = '<p class="empty">No payments recorded yet.</p>';
      return;
    }
    const statusBadge = { paid: 'badge-green', partial: 'badge-yellow', waived: 'badge-gray' };
    const rows = payments.map((p) => `
      <tr>
        <td>${esc(p.first_name)} ${esc(p.last_name)}</td>
        <td>${esc(p.lot_number)}</td>
        <td>${esc(p.month_year)}</td>
        <td>$${Number(p.amount).toFixed(2)}</td>
        <td><span class="badge ${statusBadge[p.status] || 'badge-gray'}">${esc(p.status)}</span></td>
        <td>${fmtDate(p.payment_date)}</td>
        <td>${esc(p.notes || '—')}</td>
        <td><button class="btn-danger delete-payment" data-id="${p.id}">Delete</button></td>
      </tr>`).join('');
    el.innerHTML = `<table>
      <thead><tr>
        <th>Tenant</th><th>Lot</th><th>Month</th><th>Amount</th><th>Status</th><th>Date</th><th>Notes</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    el.querySelectorAll('.delete-payment').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this payment record?')) return;
        try {
          await apiFetch(`/api/payments/${btn.dataset.id}`, { method: 'DELETE', raw: true });
          loadPayments();
        } catch (err) { alert(err.message); }
      }));
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

document.getElementById('payments-refresh').addEventListener('click', loadPayments);
document.getElementById('payments-filter-tenant').addEventListener('change', loadPayments);

document.getElementById('new-payment-btn').addEventListener('click', () => {
  document.getElementById('payment-form').reset();
  // Default to today's date
  document.getElementById('pf-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('payment-modal-backdrop').hidden = false;
});

function closePaymentModal() {
  document.getElementById('payment-modal-backdrop').hidden = true;
}

document.getElementById('payment-modal-close').addEventListener('click', closePaymentModal);
document.getElementById('payment-modal-cancel').addEventListener('click', closePaymentModal);
document.getElementById('payment-modal-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closePaymentModal();
});

document.getElementById('payment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const monthRaw = document.getElementById('pf-month').value; // "YYYY-MM"
  const payload = {
    tenant_id:    document.getElementById('pf-tenant').value,
    amount:       parseFloat(document.getElementById('pf-amount').value),
    payment_date: document.getElementById('pf-date').value,
    month_year:   monthRaw,
    status:       document.getElementById('pf-status').value,
    notes:        document.getElementById('pf-notes').value.trim() || null,
  };

  if (!payload.tenant_id) { alert('Please select a tenant.'); return; }

  try {
    await apiFetch('/api/payments', { method: 'POST', body: JSON.stringify(payload) });
    closePaymentModal();
    loadPayments();
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

// Load routing data early so filter dropdowns are populated when switching tabs
apiFetch('/api/agent-configs').then((data) => {
  _agentConfigs = data || [];
  populateConfigFilter('calls-filter-config');
  populateConfigFilter('leads-filter-config');
}).catch(() => {});

// Load tenants early so the payment filter and modal dropdown are populated
apiFetch('/api/tenants').then((data) => {
  _tenants = data || [];
  populateTenantFilter();
}).catch(() => {});

showTab('dashboard');

// ── Knowledge Base ────────────────────────────────────────────────────────────

let _kbFile       = null;     // selected File object
let _kbChatHistory = [];      // [{role, content}]
let _kbChatBusy   = false;

function loadKnowledge() {
  loadKbDocs();
  bindKbUpload();
  bindKbChat();
}

// ── Documents list ────────────────────────────────────────────────────────────

async function loadKbDocs() {
  const el = document.getElementById('kb-docs-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  try {
    const docs = await apiFetch('/api/knowledge/documents');
    if (!docs.length) {
      el.innerHTML = '<p class="empty">No documents yet. Upload one to get started.</p>';
      return;
    }
    el.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Document</th>
            <th style="text-align:center">Chunks</th>
            <th>Uploaded</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${docs.map(d => `
            <tr class="kb-doc-row">
              <td style="font-weight:500">${esc(d.filename)}</td>
              <td style="text-align:center" class="kb-doc-chunks">${d.chunk_count ?? '—'}</td>
              <td>${fmtDate(d.created_at)}</td>
              <td><button class="btn-danger" data-doc-id="${esc(d.id)}" data-doc-name="${esc(d.filename)}">Delete</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;

    el.querySelectorAll('[data-doc-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { docId, docName } = btn.dataset;
        if (!confirm(`Delete "${docName}"? This cannot be undone.`)) return;
        btn.disabled = true;
        try {
          await apiFetch(`/api/knowledge/documents/${btn.dataset.docId}`, { method: 'DELETE' });
          loadKbDocs();
        } catch (err) {
          alert(`Delete failed: ${err.message}`);
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    el.innerHTML = `<p class="empty" style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

// ── Upload ────────────────────────────────────────────────────────────────────

function bindKbUpload() {
  const dropZone   = document.getElementById('kb-drop-zone');
  const fileInput  = document.getElementById('kb-file-input');
  const fileNameEl = document.getElementById('kb-file-name');
  const nameInput  = document.getElementById('kb-doc-name');
  const pasteArea  = document.getElementById('kb-paste-content');
  const uploadBtn  = document.getElementById('kb-upload-btn');
  const statusEl   = document.getElementById('kb-upload-status');

  if (dropZone._kbBound) return;
  dropZone._kbBound = true;

  function setFile(file) {
    _kbFile = file;
    fileNameEl.textContent = file.name;
    fileNameEl.style.color = 'var(--text)';
    if (!nameInput.value) nameInput.value = file.name.replace(/\.[^.]+$/, '');
    pasteArea.value = '';
  }

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  pasteArea.addEventListener('input', () => {
    if (pasteArea.value) {
      _kbFile = null;
      fileNameEl.textContent = 'Drop a file here or click to browse';
      fileNameEl.style.color = '';
      fileInput.value = '';
    }
  });

  uploadBtn.addEventListener('click', async () => {
    const docName   = nameInput.value.trim();
    const pasteText = pasteArea.value.trim();

    if (!docName)               { kbStatus(statusEl, 'error', 'Please enter a document name.'); return; }
    if (!_kbFile && !pasteText) { kbStatus(statusEl, 'error', 'Upload a file or paste text.'); return; }

    uploadBtn.disabled = true;
    kbStatus(statusEl, 'info', 'Ingesting… this may take a few seconds.');

    try {
      let result;
      if (_kbFile) {
        const fd = new FormData();
        fd.append('file', _kbFile);
        const resp = await fetch('/api/knowledge/ingest-file', { method: 'POST', body: fd });
        result = await resp.json();
        if (!resp.ok) throw new Error(result.error || 'Upload failed');
      } else {
        result = await apiFetch('/api/knowledge/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: docName, content: pasteText }),
        });
      }

      kbStatus(statusEl, 'success', `✓ "${result.filename}" ingested — ${result.chunks} chunks created.`);
      nameInput.value  = '';
      pasteArea.value  = '';
      fileNameEl.textContent = 'Drop a file here or click to browse';
      fileNameEl.style.color = '';
      _kbFile = null;
      fileInput.value = '';
      loadKbDocs();
    } catch (err) {
      kbStatus(statusEl, 'error', err.message);
    } finally {
      uploadBtn.disabled = false;
    }
  });

  document.getElementById('kb-docs-refresh').addEventListener('click', loadKbDocs);
}

function kbStatus(el, type, msg) {
  el.className = `status-msg ${type}`;
  el.textContent = msg;
}

// ── Chat ──────────────────────────────────────────────────────────────────────

function bindKbChat() {
  const messagesEl = document.getElementById('kb-chat-messages');
  const inputEl    = document.getElementById('kb-chat-input');
  const sendBtn    = document.getElementById('kb-chat-send');
  const clearBtn   = document.getElementById('kb-chat-clear');
  const sourcesBar = document.getElementById('kb-sources-bar');

  if (sendBtn._kbBound) return;
  sendBtn._kbBound = true;

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || _kbChatBusy) return;

    // Remove welcome message on first send
    const welcome = messagesEl.querySelector('.kb-chat-welcome');
    if (welcome) welcome.remove();

    inputEl.value = '';
    sourcesBar.hidden = true;

    appendKbBubble(messagesEl, 'user', text);
    _kbChatHistory.push({ role: 'user', content: text });

    const thinkingEl = appendKbBubble(messagesEl, 'thinking', 'Britney is thinking…');
    _kbChatBusy = true;
    sendBtn.disabled = true;

    try {
      const data = await apiFetch('/api/knowledge/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: _kbChatHistory }),
      });

      thinkingEl.remove();

      const reply = data.response || '(no response)';
      appendKbBubble(messagesEl, 'agent', reply);
      _kbChatHistory.push({ role: 'assistant', content: reply });

      if (data.sources && data.sources.length) {
        sourcesBar.hidden = false;
        sourcesBar.innerHTML = `<strong>Sources used:</strong> ${
          data.sources.map((s, i) =>
            `<span title="${esc(s.content)}">[${i+1}] ${(Number(s.similarity) * 100).toFixed(0)}% match</span>`
          ).join(' · ')
        }`;
      }
    } catch (err) {
      thinkingEl.remove();
      appendKbBubble(messagesEl, 'agent', `Sorry, something went wrong: ${err.message}`);
    } finally {
      _kbChatBusy = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

  clearBtn.addEventListener('click', () => {
    _kbChatHistory = [];
    sourcesBar.hidden = true;
    messagesEl.innerHTML = `
      <div class="kb-chat-welcome">
        <span>👋</span>
        <p>Hi! I'm Britney, the Lucky Communities Property Support Agent. Ask me anything about our policies, rules, or procedures — or test a question a resident might ask.</p>
      </div>`;
  });
}

function appendKbBubble(container, type, text) {
  const el = document.createElement('div');
  el.className = `kb-bubble kb-bubble-${type}`;
  el.textContent = text;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

'use strict';

// ── App config (loaded once from backend) ────────────────────────────────────
let _appConfig = { summaryMinDurationSeconds: 120 };
fetch('/api/config').then((r) => r.json()).then((c) => { _appConfig = c; }).catch(() => {});

// ── Tab navigation ────────────────────────────────────────────────────────────

const navLinks = document.querySelectorAll('.nav-links a');
const tabs = document.querySelectorAll('.tab');

function showTab(name) {
  tabs.forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  navLinks.forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  if (name === 'dashboard')     loadDashboard();
  if (name === 'agents')        loadAgents();
  if (name === 'calls')         loadCalls();
  if (name === 'leads')         loadLeads();
  if (name === 'tenants')       loadTenants();
  if (name === 'payments')      loadPayments();
  if (name === 'knowledge-base') loadKnowledgeBase();
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
    el.querySelectorAll('.view-call').forEach((btn) =>
      btn.addEventListener('click', () => openCallDetail(btn.dataset.id)));
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

document.getElementById('dash-refresh').addEventListener('click', loadDashboard);

// ── Agents ────────────────────────────────────────────────────────────────────

let _agentConfigs = [];

// Close all open action menus when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
});

async function loadAgents() {
  const el = document.getElementById('routing-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  try {
    [_agentConfigs] = await Promise.all([
      apiFetch('/api/agent-configs'),
    ]);

    // Fetch KB doc counts per agent (best-effort)
    let kbCounts = {};
    try {
      const docs = await apiFetch('/api/knowledge-base');
      docs.forEach((d) => {
        if (d.agent_config_id) kbCounts[d.agent_config_id] = (kbCounts[d.agent_config_id] || 0) + 1;
      });
    } catch {}

    if (!_agentConfigs.length) {
      el.innerHTML = '<p class="empty">No agents configured yet. Click "+ New Agent" to get started.</p>';
    } else {
      el.innerHTML = renderAgentsTable(_agentConfigs, kbCounts);

      // Three-dots dropdown toggle
      el.addEventListener('click', (e) => {
        const trigger = e.target.closest('.action-menu-trigger');
        if (!trigger) return;
        e.stopPropagation();
        const menu = trigger.closest('.action-menu');
        const isOpen = menu.classList.contains('open');
        document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
        if (!isOpen) menu.classList.add('open');
      });

      el.querySelectorAll('.edit-config').forEach((btn) =>
        btn.addEventListener('click', () => { closeAllMenus(); openConfigModal(btn.dataset.id); }));
      el.querySelectorAll('.delete-config').forEach((btn) =>
        btn.addEventListener('click', () => { closeAllMenus(); deleteConfig(btn.dataset.id, btn.dataset.name); }));
      el.querySelectorAll('.toggle-config').forEach((btn) =>
        btn.addEventListener('click', () => { closeAllMenus(); toggleConfig(btn.dataset.id, btn.dataset.active === 'true'); }));
    }
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
  populateConfigFilter('calls-filter-config');
  populateConfigFilter('leads-filter-config');
}

function closeAllMenus() {
  document.querySelectorAll('.action-menu.open').forEach((m) => m.classList.remove('open'));
}

function renderAgentsTable(configs, kbCounts = {}) {
  const rows = configs.map((c) => {
    const kbCount = kbCounts[c.id] || 0;
    const kbBadge = kbCount
      ? `<span class="badge badge-blue">${kbCount} doc${kbCount !== 1 ? 's' : ''}</span>`
      : '<span class="badge badge-gray">None</span>';
    const sfBadge = c.speaks_first !== false
      ? '<span class="badge badge-green">Bot first</span>'
      : '<span class="badge badge-gray">Caller first</span>';
    return `
    <tr>
      <td><strong>${esc(c.name)}</strong></td>
      <td class="number-cell">${esc(c.quo_number || '—')}<span class="arrow">→</span>${esc(c.twilio_number)}</td>
      <td><span class="badge ${c.is_active ? 'badge-green' : 'badge-gray'}">${c.is_active ? 'Active' : 'Paused'}</span></td>
      <td>${sfBadge}</td>
      <td>${kbBadge}</td>
      <td>${c.total_calls ?? 0}</td>
      <td>${fmtDuration(c.avg_duration_seconds)}</td>
      <td>
        <div class="action-menu">
          <button class="btn-icon action-menu-trigger" title="Actions">&#8942;</button>
          <div class="action-menu-dropdown">
            <button class="menu-item edit-config" data-id="${c.id}">Edit</button>
            <button class="menu-item toggle-config" data-id="${c.id}" data-active="${c.is_active}">
              ${c.is_active ? 'Pause' : 'Resume'}
            </button>
            <button class="menu-item menu-danger delete-config" data-id="${c.id}" data-name="${esc(c.name)}">Delete</button>
          </div>
        </div>
      </td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr>
      <th>Agent</th><th>Quo → Twilio</th><th>Status</th><th>Opens with</th><th>Knowledge Base</th><th>Calls</th><th>Avg Duration</th><th></th>
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
    document.getElementById('config-id').value          = cfg.id;
    document.getElementById('f-name').value             = cfg.name;
    document.getElementById('f-twilio').value           = cfg.twilio_number;
    document.getElementById('f-quo').value              = cfg.quo_number || '';
    document.getElementById('f-prompt').value           = cfg.system_prompt;
    document.getElementById('f-greeting').value         = cfg.greeting;
    document.getElementById('f-voice').value            = cfg.voice_id;
    document.getElementById('f-speaks-first').value     = String(cfg.speaks_first !== false);
    document.getElementById('f-active').value           = String(cfg.is_active);
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
    speaks_first:  document.getElementById('f-speaks-first').value === 'true',
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
    loadAgents();
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
    loadAgents();
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
    loadAgents();
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
    el.querySelectorAll('.view-call').forEach((btn) =>
      btn.addEventListener('click', () => openCallDetail(btn.dataset.id)));
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

function callStatusBadge(c) {
  if (!c.ended_at)           return '<span class="badge badge-blue">In Progress</span>';
  if (!c.duration_seconds)   return '<span class="badge badge-gray">No Answer</span>';
  return                            '<span class="badge badge-green">Completed</span>';
}

function renderCallsTable(calls, compact = false) {
  if (compact) {
    const rows = calls.map((c) => `
      <tr>
        <td class="number-cell">${esc(c.caller_number)}</td>
        <td><span class="badge badge-blue">${esc(c.agent_configs?.name || '—')}</span></td>
        <td>${fmtTime(c.started_at)}</td>
        <td>${fmtDuration(c.duration_seconds)}</td>
        <td><button class="btn-link view-call" data-id="${c.id}">View</button></td>
      </tr>`).join('');
    return `<table>
      <thead><tr><th>Caller</th><th>Agent</th><th>Time</th><th>Duration</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  const rows = calls.map((c) => {
    const from = c.direction === 'outbound' ? c.twilio_number  : c.caller_number;
    const to   = c.direction === 'outbound' ? c.caller_number  : c.twilio_number;
    const dir  = c.direction === 'outbound'
      ? '<span class="badge badge-purple">Out</span>'
      : '<span class="badge badge-gray">In</span>';
    const shortSid = c.call_sid ? c.call_sid.slice(0, 10) + '…' : c.id.slice(0, 8);
    return `
      <tr>
        <td class="number-cell mono-sm">${esc(shortSid)}</td>
        <td class="number-cell">${esc(from || '—')}</td>
        <td class="number-cell">${esc(to   || '—')}</td>
        <td>${dir}</td>
        <td><span class="badge badge-blue">${esc(c.agent_configs?.name || '—')}</span></td>
        <td>${callStatusBadge(c)}</td>
        <td>${fmtDuration(c.duration_seconds)}</td>
        <td>${fmtTime(c.started_at)}</td>
        <td>${fmtTime(c.ended_at)}</td>
        <td><button class="btn-icon view-call" data-id="${c.id}" title="View details">&#128065;</button></td>
      </tr>`;
  }).join('');

  return `<table class="table-wide">
    <thead><tr>
      <th>Call ID</th><th>From</th><th>To</th><th>Dir</th>
      <th>Agent</th><th>Status</th><th>Duration</th>
      <th>Started</th><th>Ended</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

document.getElementById('calls-refresh').addEventListener('click', loadCalls);
document.getElementById('calls-filter-config').addEventListener('change', loadCalls);

// ── Test Call dialog ──────────────────────────────────────────────────────────

document.getElementById('test-call-btn').addEventListener('click', openTestCallModal);

async function openTestCallModal() {
  const backdrop = document.getElementById('test-call-backdrop');
  const sel      = document.getElementById('tc-agent');
  const status   = document.getElementById('tc-status');

  document.getElementById('tc-phone').value = '';
  status.hidden    = true;
  status.textContent = '';

  try {
    const configs = await apiFetch('/api/agent-configs');
    sel.innerHTML = '<option value="">Select agent…</option>' +
      configs.filter((c) => c.is_active).map((c) =>
        `<option value="${c.id}">${esc(c.name)} — ${esc(c.twilio_number)}</option>`
      ).join('');
  } catch {
    sel.innerHTML = '<option value="">Failed to load agents</option>';
  }

  backdrop.hidden = false;
}

function closeTestCallModal() {
  document.getElementById('test-call-backdrop').hidden = true;
}

document.getElementById('tc-close').addEventListener('click', closeTestCallModal);
document.getElementById('tc-cancel').addEventListener('click', closeTestCallModal);
document.getElementById('test-call-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeTestCallModal();
});

document.getElementById('tc-call').addEventListener('click', async () => {
  const to            = document.getElementById('tc-phone').value.trim();
  const agentConfigId = document.getElementById('tc-agent').value;
  const status        = document.getElementById('tc-status');
  const btn           = document.getElementById('tc-call');

  if (!to || !agentConfigId) {
    alert('Phone number and agent are required.');
    return;
  }

  btn.disabled      = true;
  status.hidden     = false;
  status.className  = 'tc-status';
  status.textContent = 'Initiating call…';

  try {
    const result = await apiFetch('/api/calls/outbound', {
      method: 'POST',
      body: JSON.stringify({ to, agentConfigId }),
    });
    status.textContent = `Call started — SID: ${result.callSid}  (${result.status})`;
    status.classList.add('tc-success');
    setTimeout(() => { closeTestCallModal(); loadCalls(); }, 2500);
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
    status.classList.add('tc-error');
  } finally {
    btn.disabled = false;
  }
});

// ── Call Detail dialog ────────────────────────────────────────────────────────

let _callDetailData = null;

async function openCallDetail(callId) {
  const backdrop = document.getElementById('call-detail-backdrop');
  document.getElementById('cd-body').innerHTML    = '<p class="loading">Loading…</p>';
  document.getElementById('cd-overview').innerHTML = '';
  document.getElementById('cd-call-id').textContent = 'Call Details';
  // Reset tabs; annotate Summary tab with threshold
  const _minS   = _appConfig.summaryMinDurationSeconds ?? 120;
  const _minFmt = _minS >= 60 ? `${Math.floor(_minS / 60)}m` : `${_minS}s`;
  document.querySelectorAll('.cd-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === 'transcript');
    if (t.dataset.tab === 'summary') t.innerHTML = `Summary <span class="cd-tab-hint">&ge; ${_minFmt}</span>`;
  });
  backdrop.hidden = false;

  try {
    const call = await apiFetch(`/api/calls/${callId}`);
    _callDetailData = call;

    const sid = call.call_sid || call.id;
    document.getElementById('cd-call-id').textContent =
      sid.length > 20 ? sid.slice(0, 12) + '…' + sid.slice(-4) : sid;

    const from = call.direction === 'outbound' ? call.twilio_number : call.caller_number;
    const to   = call.direction === 'outbound' ? call.caller_number : call.twilio_number;

    document.getElementById('cd-overview').innerHTML = `
      <div class="cd-overview-grid">
        ${cdKv('Call ID',    `<span class="mono-sm">${esc(call.call_sid || '—')}</span>`)}
        ${cdKv('Direction',  call.direction === 'outbound'
          ? '<span class="badge badge-purple">Outbound</span>'
          : '<span class="badge badge-gray">Inbound</span>')}
        ${cdKv('Status',     callStatusBadge(call))}
        ${cdKv('Agent',      esc(call.agent_configs?.name || '—'))}
        ${cdKv('From',       `<span class="mono-sm">${esc(from || '—')}</span>`)}
        ${cdKv('To',         `<span class="mono-sm">${esc(to   || '—')}</span>`)}
        ${cdKv('Duration',   fmtDuration(call.duration_seconds))}
        ${cdKv('Started',    fmtTime(call.started_at))}
        ${cdKv('Ended',      fmtTime(call.ended_at))}
        ${cdKv('Recording',  call.recording_url
          ? '<span class="badge badge-green">Available</span>'
          : '<span class="badge badge-gray">None</span>')}
      </div>`;

    renderCdTab('transcript', call);
  } catch (err) {
    document.getElementById('cd-body').innerHTML =
      `<p class="empty">Failed to load: ${esc(err.message)}</p>`;
  }
}

function cdKv(label, value) {
  return `<div class="cd-kv">
    <div class="cd-kv-label">${label}</div>
    <div class="cd-kv-value">${value}</div>
  </div>`;
}

function renderCdTab(tab, call) {
  const body = document.getElementById('cd-body');

  if (tab === 'transcript') {
    if (!call.transcript?.length) {
      body.innerHTML = '<p class="empty">No transcript recorded for this call.</p>';
      return;
    }
    body.innerHTML = call.transcript.map((entry) => {
      const isAgent = entry.role === 'agent';
      const ts = entry.ts ? `<span class="t-ts">${fmtTime(entry.ts)}</span>` : '';
      return `
        <div class="t-row ${isAgent ? 't-row-agent' : 't-row-caller'}">
          <div class="t-speaker">${isAgent ? 'Agent' : 'User'}${ts}</div>
          <div class="t-bubble ${isAgent ? 't-agent' : 't-caller'}">${esc(entry.text)}</div>
        </div>`;
    }).join('');
    body.scrollTop = body.scrollHeight;
    return;
  }

  if (tab === 'recording') {
    if (!call.recording_url) {
      body.innerHTML = '<p class="empty">No recording available. Recordings appear a few seconds after the call ends via Twilio callback.</p>';
      return;
    }
    body.innerHTML = `
      <div class="cd-recording">
        <p class="cd-recording-meta">${fmtTime(call.started_at)} &nbsp;·&nbsp; ${fmtDuration(call.duration_seconds)}</p>
        <audio controls src="/api/calls/${call.id}/recording"></audio>
      </div>`;
    return;
  }

  if (tab === 'summary') {
    body.innerHTML = call.summary
      ? `<div class="cd-summary">${esc(call.summary)}</div>`
      : '<p class="empty">No summary available.</p>';
  }
}

document.getElementById('cd-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.cd-tab')?.dataset.tab;
  if (!tab || !_callDetailData) return;
  document.querySelectorAll('.cd-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === tab));
  renderCdTab(tab, _callDetailData);
});

document.getElementById('cd-close').addEventListener('click', () => {
  document.getElementById('call-detail-backdrop').hidden = true;
});

document.getElementById('call-detail-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget)
    document.getElementById('call-detail-backdrop').hidden = true;
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

// ── Knowledge Base ────────────────────────────────────────────────────────────

let _kbPollingTimers = {};

async function loadKnowledgeBase() {
  const el       = document.getElementById('kb-list');
  const configId = document.getElementById('kb-filter-config').value;
  const qs       = configId ? `?agentConfigId=${configId}` : '';

  el.innerHTML = '<p class="loading">Loading…</p>';
  try {
    const docs = await apiFetch(`/api/knowledge-base${qs}`);
    if (!docs.length) {
      el.innerHTML = '<p class="empty">No documents yet. Click "+ Upload Document" to add content to the knowledge base.</p>';
      return;
    }

    const rows = docs.map((d) => {
      const statusBadge = d.status === 'ready'      ? 'badge-green'
                        : d.status === 'processing'  ? 'badge-blue'
                        : 'badge-red';
      const chunkText = d.status === 'ready' ? `${d.chunk_count} chunk${d.chunk_count !== 1 ? 's' : ''}` : '—';
      const typeLabel = (d.file_type || '').includes('pdf') ? 'PDF' : 'TXT';
      return `
        <tr id="kb-row-${d.id}">
          <td><strong>${esc(d.filename)}</strong></td>
          <td><span class="badge badge-gray">${typeLabel}</span></td>
          <td>${chunkText}</td>
          <td><span class="badge ${statusBadge}" id="kb-status-${d.id}">${esc(d.status)}</span></td>
          <td>${fmtDate(d.created_at)}</td>
          <td><button class="btn-danger delete-doc" data-id="${d.id}" data-name="${esc(d.filename)}">Delete</button></td>
        </tr>`;
    }).join('');

    el.innerHTML = `<table>
      <thead><tr>
        <th>Filename</th><th>Type</th><th>Chunks</th><th>Status</th><th>Uploaded</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

    el.querySelectorAll('.delete-doc').forEach((btn) =>
      btn.addEventListener('click', () => deleteDocument(btn.dataset.id, btn.dataset.name)));

    // Start polling for any docs still processing
    docs.filter((d) => d.status === 'processing').forEach((d) => pollDocStatus(d.id));
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

function pollDocStatus(docId) {
  if (_kbPollingTimers[docId]) return; // already polling
  _kbPollingTimers[docId] = setInterval(async () => {
    try {
      const doc = await apiFetch(`/api/knowledge-base/${docId}`);
      if (!doc || doc.status !== 'processing') {
        clearInterval(_kbPollingTimers[docId]);
        delete _kbPollingTimers[docId];
        // Refresh the row in-place
        const badge = document.getElementById(`kb-status-${docId}`);
        if (badge) {
          const cls = doc?.status === 'ready' ? 'badge-green' : 'badge-red';
          badge.className = `badge ${cls}`;
          badge.textContent = doc?.status || 'error';

          // Update chunk count cell too
          const row = document.getElementById(`kb-row-${docId}`);
          if (row && doc?.status === 'ready') {
            row.cells[2].textContent = `${doc.chunk_count} chunk${doc.chunk_count !== 1 ? 's' : ''}`;
          }
        }
      }
    } catch {
      clearInterval(_kbPollingTimers[docId]);
      delete _kbPollingTimers[docId];
    }
  }, 3000);
}

async function deleteDocument(id, name) {
  if (!confirm(`Delete "${name}"? This will remove the file and all its embeddings.`)) return;
  try {
    await apiFetch(`/api/knowledge-base/${id}`, { method: 'DELETE', raw: true });
    clearInterval(_kbPollingTimers[id]);
    delete _kbPollingTimers[id];
    loadKnowledgeBase();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

function populateKbAgentFilter() {
  const sel     = document.getElementById('kb-filter-config');
  const current = sel.value;
  sel.innerHTML = '<option value="">All agents</option>' +
    _agentConfigs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = current;

  const modalSel  = document.getElementById('kb-agent-select');
  const mCurrent  = modalSel.value;
  modalSel.innerHTML = '<option value="">Select agent…</option>' +
    _agentConfigs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  modalSel.value = mCurrent;
}

document.getElementById('kb-refresh').addEventListener('click', loadKnowledgeBase);
document.getElementById('kb-filter-config').addEventListener('change', loadKnowledgeBase);
document.getElementById('new-doc-btn').addEventListener('click', openKbModal);

function openKbModal() {
  populateKbAgentFilter();
  document.getElementById('kb-form').reset();
  document.getElementById('kb-file-name').textContent = '';
  document.getElementById('kb-modal-backdrop').hidden = false;
}

function closeKbModal() {
  document.getElementById('kb-modal-backdrop').hidden = true;
}

document.getElementById('kb-modal-close').addEventListener('click', closeKbModal);
document.getElementById('kb-modal-cancel').addEventListener('click', closeKbModal);
document.getElementById('kb-modal-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeKbModal();
});

// Drag-and-drop + click-to-browse for file input
const dropZone   = document.getElementById('kb-drop-zone');
const fileInput  = document.getElementById('kb-file-input');
const fileNameEl = document.getElementById('kb-file-name');

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    fileNameEl.textContent = e.dataTransfer.files[0].name;
  }
});

fileInput.addEventListener('change', () => {
  fileNameEl.textContent = fileInput.files[0]?.name || '';
});

document.getElementById('kb-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const agentConfigId = document.getElementById('kb-agent-select').value;
  const file          = fileInput.files[0];

  if (!agentConfigId) { alert('Please select an agent.'); return; }
  if (!file)          { alert('Please select a file.'); return; }

  const btn = document.getElementById('kb-upload-btn');
  btn.disabled = true;
  btn.textContent = 'Uploading…';

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('agentConfigId', agentConfigId);

    const res = await fetch('/api/knowledge-base/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    closeKbModal();
    loadKnowledgeBase();
  } catch (err) {
    alert(`Upload failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload';
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

// Load agent configs early so filter dropdowns are populated when switching tabs
apiFetch('/api/agent-configs').then((data) => {
  _agentConfigs = data || [];
  populateConfigFilter('calls-filter-config');
  populateConfigFilter('leads-filter-config');
  populateKbAgentFilter();
}).catch(() => {});

// Load tenants early so the payment filter and modal dropdown are populated
apiFetch('/api/tenants').then((data) => {
  _tenants = data || [];
  populateTenantFilter();
}).catch(() => {});

showTab('dashboard');

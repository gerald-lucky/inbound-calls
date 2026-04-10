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
  if (name === 'knowledge') loadDocs();
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

// ── Knowledge Base ────────────────────────────────────────────────────────────

const fileInput   = document.getElementById('file-input');
const fileNameEl  = document.getElementById('file-name');
const uploadBtn   = document.getElementById('upload-btn');
const uploadForm  = document.getElementById('upload-form');
const statusEl    = document.getElementById('upload-status');
const fileDrop    = document.getElementById('file-drop');

fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  fileNameEl.textContent = f ? f.name : 'Click to choose or drag & drop';
  uploadBtn.disabled = !f;
});

fileDrop.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.classList.add('drag-over'); });
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag-over'));
fileDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) {
    const dt = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change'));
  }
});

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = fileInput.files[0];
  if (!f) return;
  setStatus('info', `Processing "${f.name}"…`);
  uploadBtn.disabled = true;
  const fd = new FormData();
  fd.append('file', f);
  try {
    const res = await fetch('/api/documents', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) { setStatus('error', data.error || 'Upload failed'); return; }
    setStatus('success', `"${data.filename}" uploaded — ${data.chunkCount} chunks indexed.`);
    uploadForm.reset();
    fileNameEl.textContent = 'Click to choose or drag & drop';
    loadDocs();
  } catch (err) {
    setStatus('error', err.message);
  } finally {
    uploadBtn.disabled = !fileInput.files[0];
  }
});

async function loadDocs() {
  const el = document.getElementById('docs-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  try {
    const docs = await apiFetch('/api/documents');
    if (!docs.length) { el.innerHTML = '<p class="empty">No documents yet.</p>'; return; }
    const rows = docs.map((d) => `
      <tr>
        <td>${esc(d.filename)}</td>
        <td><span class="badge badge-blue">${d.chunk_count}</span></td>
        <td>${fmtDate(d.created_at)}</td>
        <td><button class="btn-danger delete-doc" data-id="${d.id}" data-name="${esc(d.filename)}">Delete</button></td>
      </tr>`).join('');

    el.innerHTML = `<table>
      <thead><tr><th>Filename</th><th>Chunks</th><th>Uploaded</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

    el.querySelectorAll('.delete-doc').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete "${btn.dataset.name}"?`)) return;
        try {
          await apiFetch(`/api/documents/${btn.dataset.id}`, { method: 'DELETE', raw: true });
          setStatus('success', `"${btn.dataset.name}" deleted.`);
          loadDocs();
        } catch (err) { setStatus('error', err.message); }
      }));
  } catch (err) {
    el.innerHTML = `<p class="empty">Error: ${esc(err.message)}</p>`;
  }
}

document.getElementById('docs-refresh').addEventListener('click', loadDocs);

function setStatus(type, msg) {
  statusEl.textContent = msg;
  statusEl.className = `status-msg ${type}`;
  statusEl.hidden = false;
  if (type === 'success') setTimeout(() => { statusEl.hidden = true; }, 5000);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

// Load routing data early so filter dropdowns are populated when switching tabs
apiFetch('/api/agent-configs').then((data) => {
  _agentConfigs = data || [];
  populateConfigFilter('calls-filter-config');
  populateConfigFilter('leads-filter-config');
}).catch(() => {});

showTab('dashboard');

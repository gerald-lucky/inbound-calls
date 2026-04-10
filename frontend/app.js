'use strict';

const API = '/api/documents';

// ── DOM refs ──────────────────────────────────────────────────────────────

const uploadForm   = document.getElementById('upload-form');
const fileInput    = document.getElementById('file-input');
const fileNameEl   = document.getElementById('file-name');
const uploadBtn    = document.getElementById('upload-btn');
const statusEl     = document.getElementById('upload-status');
const docsListEl   = document.getElementById('docs-list');
const refreshBtn   = document.getElementById('refresh-btn');
const fileDrop     = document.getElementById('file-drop');

// ── File selection ─────────────────────────────────────────────────────────

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) {
    fileNameEl.textContent = file.name;
    uploadBtn.disabled = false;
  } else {
    fileNameEl.textContent = 'Click to choose a file or drag & drop';
    uploadBtn.disabled = true;
  }
});

// Drag-and-drop support
fileDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileDrop.classList.add('drag-over');
});
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('drag-over'));
fileDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) {
    // Create a DataTransfer to assign to the input
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change'));
  }
});

// ── Upload ─────────────────────────────────────────────────────────────────

uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;

  setStatus('info', `Uploading and processing "${file.name}"…`);
  uploadBtn.disabled = true;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(API, { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      setStatus('error', data.error || 'Upload failed');
    } else {
      setStatus(
        'success',
        `"${data.filename}" uploaded — ${data.chunkCount} chunks indexed.`,
      );
      // Reset form
      uploadForm.reset();
      fileNameEl.textContent = 'Click to choose a file or drag & drop';
      // Refresh document list
      await loadDocuments();
    }
  } catch (err) {
    setStatus('error', `Network error: ${err.message}`);
  } finally {
    uploadBtn.disabled = !fileInput.files[0];
  }
});

// ── Document list ──────────────────────────────────────────────────────────

async function loadDocuments() {
  docsListEl.innerHTML = '<p class="loading">Loading…</p>';
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const docs = await res.json();
    renderDocs(docs);
  } catch (err) {
    docsListEl.innerHTML = `<p class="loading">Failed to load: ${err.message}</p>`;
  }
}

function renderDocs(docs) {
  if (!docs || docs.length === 0) {
    docsListEl.innerHTML = '<p class="empty">No documents uploaded yet.</p>';
    return;
  }

  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>Filename</th>
        <th>Chunks</th>
        <th>Uploaded</th>
        <th></th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector('tbody');
  for (const doc of docs) {
    const tr = document.createElement('tr');
    const date = new Date(doc.created_at).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    tr.innerHTML = `
      <td class="filename">${escapeHtml(doc.filename)}</td>
      <td><span class="badge">${doc.chunk_count}</span></td>
      <td>${date}</td>
      <td>
        <button class="delete-btn" data-id="${doc.id}" data-name="${escapeHtml(doc.filename)}">
          Delete
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('.delete-btn');
    if (!btn) return;
    const { id, name } = btn.dataset;
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    await deleteDocument(id, name);
  });

  docsListEl.innerHTML = '';
  docsListEl.appendChild(table);
}

async function deleteDocument(id, name) {
  try {
    const res = await fetch(`${API}/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 204) {
      setStatus('success', `"${name}" deleted.`);
      await loadDocuments();
    } else {
      const data = await res.json().catch(() => ({}));
      setStatus('error', data.error || 'Delete failed');
    }
  } catch (err) {
    setStatus('error', `Network error: ${err.message}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function setStatus(type, message) {
  statusEl.textContent = message;
  statusEl.className = `status-msg ${type}`;
  statusEl.hidden = false;
  // Auto-hide success messages after 5 s
  if (type === 'success') {
    setTimeout(() => { statusEl.hidden = true; }, 5000);
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

refreshBtn.addEventListener('click', loadDocuments);

// Initial load
loadDocuments();

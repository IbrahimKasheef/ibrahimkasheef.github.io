// ===================== STATE =====================
let data = null;              // { profile, fs } — same shape as content.json
let selection = null;         // {kind:'profile'} | {kind:'dir', path} | {kind:'item', dirPath, index}
let dirHandle = null;         // File System Access API directory handle, once connected
let fileContents = {};        // src path -> edited text, for md/txt file bodies (not stored in content.json)
let cachedIndexHtml = null;   // best-effort copy of index.html, used by the "add web section" helper

// ===================== UTILITIES =====================
function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}
function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'item';
}
function titleCase(s) {
  return String(s).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function topFolderSlug(path) {
  const parts = path.replace('~/', '').split('/').filter(Boolean);
  return parts[0] || 'misc';
}
function uniqueName(dir, base) {
  if (!dir.items.some(it => it.name === base)) return base;
  const m = base.match(/^(.*?)(\.[a-zA-Z0-9]+)?$/);
  const stem = m[1], ext = m[2] || '';
  let i = 2, name;
  do { name = `${stem}-copy${i > 2 ? i : ''}${ext}`; i++; } while (dir.items.some(it => it.name === name));
  return name;
}
function getDirEntryInParent(path) {
  if (path === '~') return null;
  const parentPath = path.split('/').slice(0, -1).join('/') || '~';
  const parentDir = data.fs[parentPath];
  return parentDir ? (parentDir.items.find(i => i.path === path) || null) : null;
}
function nearestSectionAncestor(path) {
  let p = path;
  while (true) {
    const d = data.fs[p];
    if (d && d.sectionId) return d;
    if (p === '~') return null;
    p = p.split('/').slice(0, -1).join('/') || '~';
  }
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function toast(msg, ms = 3400) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), ms);
}
function setStatus(text, kind) {
  const el = document.getElementById('statusBadge');
  el.textContent = text;
  el.className = 'admin-status' + (kind ? ' ' + kind : '');
}

// ===================== SELECTION HELPERS =====================
function selIsProfile() { return !!selection && selection.kind === 'profile'; }
function selIsAbout() { return !!selection && selection.kind === 'about'; }
function selIsDir(path) { return !!selection && selection.kind === 'dir' && selection.path === path; }
function selIsItem(dirPath, idx) { return !!selection && selection.kind === 'item' && selection.dirPath === dirPath && selection.index === idx; }

function selectProfile() { selection = { kind: 'profile' }; renderTree(); renderDetail(); }
function selectAbout() { selection = { kind: 'about' }; renderTree(); renderDetail(); }
function selectDir(path) { selection = { kind: 'dir', path }; renderTree(); renderDetail(); }
function selectItem(dirPath, index) { selection = { kind: 'item', dirPath, index }; renderTree(); renderDetail(); }

// ===================== TREE RENDERING =====================
function renderTree() {
  const el = document.getElementById('tree');
  let html = `
    <div class="tree-toolbar">
      <button class="admin-btn admin-btn-sm" style="flex:1" data-action="add-subfolder" data-path="~">＋ New category</button>
    </div>
    <div class="tree-node tree-special ${selIsProfile() ? 'active' : ''}" data-action="select-profile">
      <span class="tree-icon">⚙️</span><span class="tree-label">Profile &amp; Contact</span>
    </div>
    <div class="tree-node tree-special ${selIsAbout() ? 'active' : ''}" data-action="select-about">
      <span class="tree-icon">👤</span><span class="tree-label">About Me</span>
    </div>
    <div class="tree-section-label">Filesystem</div>
  `;
  html += renderDirNode('~', 0);
  el.innerHTML = html;
}

function renderDirNode(path, depth) {
  const dir = data.fs[path];
  if (!dir) return '';
  const isRoot = path === '~';
  const entry = getDirEntryInParent(path);
  const label = isRoot ? '~ (Home)' : (entry ? entry.name : path.split('/').pop());
  const isActive = selIsDir(path);
  let html = `
    <div class="tree-row" style="padding-left:${depth * 14}px">
      <div class="tree-node ${isActive ? 'active' : ''}" data-action="select-dir" data-path="${escAttr(path)}">
        <span class="tree-icon">📁</span><span class="tree-label">${escHtml(label)}</span>
      </div>
      <div class="tree-row-actions">
        <button title="Add subfolder" data-action="add-subfolder" data-path="${escAttr(path)}">＋📁</button>
        <button title="Add file" data-action="add-file" data-path="${escAttr(path)}">＋📄</button>
        <button title="Add link" data-action="add-link" data-path="${escAttr(path)}">＋🔗</button>
        ${!isRoot ? `<button title="Delete folder" class="danger" data-action="delete-dir" data-path="${escAttr(path)}">🗑</button>` : ''}
      </div>
    </div>
  `;
  if (!dir.items || dir.items.length === 0) {
    html += `<div class="tree-empty-hint" style="padding-left:${(depth + 1) * 14 + 10}px">Empty — add something with the ➕ buttons above.</div>`;
  } else {
    dir.items.forEach((item, idx) => {
      if (item.type === 'dir' && item.path) {
        html += renderDirNode(item.path, depth + 1);
      } else {
        html += renderItemRow(path, idx, item, depth + 1);
      }
    });
  }
  return html;
}

function renderItemRow(dirPath, idx, item, depth) {
  const isActive = selIsItem(dirPath, idx);
  const icon = item.type === 'link' ? '🔗' : item.type === 'exec' ? '⚙️' : '📄';
  return `
    <div class="tree-row" style="padding-left:${depth * 14}px">
      <div class="tree-node ${isActive ? 'active' : ''}" data-action="select-item" data-dir="${escAttr(dirPath)}" data-idx="${idx}">
        <span class="tree-icon">${icon}</span><span class="tree-label">${escHtml(item.title || item.name)}</span>
      </div>
      <div class="tree-row-actions">
        <button title="Move up" data-action="move-item" data-dir="${escAttr(dirPath)}" data-idx="${idx}" data-delta="-1">↑</button>
        <button title="Move down" data-action="move-item" data-dir="${escAttr(dirPath)}" data-idx="${idx}" data-delta="1">↓</button>
        <button title="Delete" class="danger" data-action="delete-item" data-dir="${escAttr(dirPath)}" data-idx="${idx}">🗑</button>
      </div>
    </div>
  `;
}

// ===================== ACTION DISPATCH =====================
// Used both by the tree's delegated click listener and by buttons rendered
// inside the detail panel, so every "add/delete/move" control behaves the
// same no matter where it's clicked from.
function performAction(action, ds) {
  const path = ds.path;
  const dirPath = ds.dir;
  const idx = ds.idx !== undefined ? parseInt(ds.idx, 10) : undefined;
  const delta = ds.delta !== undefined ? parseInt(ds.delta, 10) : undefined;
  switch (action) {
    case 'select-profile': selectProfile(); break;
    case 'select-about': selectAbout(); break;
    case 'select-dir': selectDir(path); break;
    case 'select-item': selectItem(dirPath, idx); break;
    case 'add-subfolder': addSubfolder(path); break;
    case 'add-file': addFile(path); break;
    case 'add-link': addLink(path); break;
    case 'delete-dir': deleteDir(path); break;
    case 'delete-item': deleteItem(dirPath, idx); break;
    case 'move-item': moveItem(dirPath, idx, delta); break;
    case 'duplicate-item': duplicateItem(dirPath, idx); break;
  }
}

// ===================== STRUCTURAL OPERATIONS =====================
function addSubfolder(parentPath) {
  const name = (prompt('Subfolder name:', '') || '').trim();
  if (!name) return;
  const parentDir = data.fs[parentPath];
  if (parentDir.items.some(i => i.name === name)) { toast(`"${name}" already exists in this folder.`); return; }
  const slug = slugify(name);
  const base = parentPath === '~' ? '~/' : parentPath + '/';
  let newPath = base + slug, n = 2;
  while (data.fs[newPath]) { newPath = base + slug + '-' + n; n++; }
  parentDir.items.push({ name, type: 'dir', path: newPath });
  data.fs[newPath] = { type: 'dir', items: [] };
  renderTree();
  selectDir(newPath);
  toast(`Created "${name}".`);
}

function addFile(parentPath) {
  const name = (prompt('File name (e.g. my-new-post.md):', '') || '').trim();
  if (!name) return;
  const dir = data.fs[parentPath];
  if (dir.items.some(i => i.name === name)) { toast(`"${name}" already exists in this folder.`); return; }
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : 'md';
  const format = ext === 'pdf' ? 'pdf' : ext === 'txt' ? 'txt' : 'md';
  const stem = name.replace(/\.[a-zA-Z0-9]+$/, '');
  const slug = slugify(stem);
  const src = `content/${topFolderSlug(parentPath)}/${slug}.${format}`;
  const item = { name, type: 'file', format, src, title: titleCase(stem), date: new Date().toISOString().slice(0, 10) };
  dir.items.push(item);
  renderTree();
  selectItem(parentPath, dir.items.length - 1);
  toast(`Added "${name}" — fill in the details on the right.`);
}

function addLink(parentPath) {
  const name = (prompt('Link name (e.g. my-cool-repo):', '') || '').trim();
  if (!name) return;
  const dir = data.fs[parentPath];
  if (dir.items.some(i => i.name === name)) { toast(`"${name}" already exists in this folder.`); return; }
  const item = { name, type: 'link', url: 'https://', desc: '', icon: '🔗', color: 'accent', tags: [] };
  dir.items.push(item);
  renderTree();
  selectItem(parentPath, dir.items.length - 1);
  toast(`Added "${name}" — fill in the URL on the right.`);
}

function deleteDir(path) {
  if (path === '~') return;
  const entry = getDirEntryInParent(path);
  const label = entry ? entry.name : path;
  if (!confirm(`Delete "${label}" and everything inside it?\n\nThis removes it from content.json for this session. If you already saved a backup, you can undo by re-importing it.`)) return;
  const parentPath = path.split('/').slice(0, -1).join('/') || '~';
  const parentDir = data.fs[parentPath];
  if (parentDir) parentDir.items = parentDir.items.filter(i => i.path !== path);
  const stack = [path];
  while (stack.length) {
    const p = stack.pop();
    const d = data.fs[p];
    if (d && d.items) for (const it of d.items) if (it.type === 'dir' && it.path) stack.push(it.path);
    delete data.fs[p];
  }
  if (selection && (
    (selection.kind === 'dir' && (selection.path === path || selection.path.startsWith(path + '/'))) ||
    (selection.kind === 'item' && (selection.dirPath === path || selection.dirPath.startsWith(path + '/')))
  )) selection = null;
  renderTree();
  renderDetail();
  toast(`Deleted "${label}".`);
}

function deleteItem(dirPath, idx) {
  const dir = data.fs[dirPath];
  if (!dir) return;
  const item = dir.items[idx];
  if (!item) return;
  if (!confirm(`Delete "${item.title || item.name}"?`)) return;
  dir.items.splice(idx, 1);
  if (selection && selection.kind === 'item' && selection.dirPath === dirPath) selection = null;
  renderTree();
  renderDetail();
  toast(`Deleted "${item.title || item.name}".`);
}

function moveItem(dirPath, idx, delta) {
  const dir = data.fs[dirPath];
  if (!dir) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= dir.items.length) return;
  [dir.items[idx], dir.items[newIdx]] = [dir.items[newIdx], dir.items[idx]];
  if (selIsItem(dirPath, idx)) selection.index = newIdx;
  renderTree();
  renderDetail();
}

function duplicateItem(dirPath, idx) {
  const dir = data.fs[dirPath];
  if (!dir) return;
  const original = dir.items[idx];
  const copy = JSON.parse(JSON.stringify(original));
  copy.name = uniqueName(dir, copy.name);
  if (copy.title) copy.title += ' (copy)';
  dir.items.splice(idx + 1, 0, copy);
  renderTree();
  selectItem(dirPath, idx + 1);
  toast(`Duplicated as "${copy.name}".`);
}

function makeSection(path) {
  const dir = data.fs[path];
  const entry = getDirEntryInParent(path);
  const name = entry ? entry.name : path.split('/').pop();
  const slug = slugify(name);
  dir.sectionId = slug;
  dir.mountId = slug + 'Grid';
  dir.cardStyle = 'grid';
  dir.cardFooter = 'tags';
  dir.sectionTag = `$ ls ./${name}`;
  dir.sectionHeading = titleCase(name);
  dir.sectionDesc = '';
  renderTree();
  renderDetail();
  toast('This folder is now a web section — fill in the heading & description, then grab the updated index.html.');
}

// ===================== DETAIL PANEL =====================
function renderDetail() {
  const el = document.getElementById('detail');
  if (!selection) {
    el.innerHTML = `<div class="admin-empty">Select a category, subfolder, or item on the left — or use the ➕ buttons to add something new.</div>`;
    return;
  }
  if (selection.kind === 'profile') return renderProfileForm(el);
  if (selection.kind === 'about') return renderAboutForm(el);
  if (selection.kind === 'dir') return renderDirForm(el, selection.path);
  if (selection.kind === 'item') return renderItemForm(el, selection.dirPath, selection.index);
}

function renderProfileForm(el) {
  const p = data.profile;
  el.innerHTML = `
    <div class="detail-header"><div class="detail-title">⚙️ Profile &amp; Contact</div></div>
    <div class="detail-path">Used across the site — the hero section, contact links, and the terminal's <code>get-in-touch.sh</code>.</div>

    <div class="field-fieldset">
      <div class="field-fieldset-title">Identity</div>
      <div class="field-group">
        <label class="field-label">Hero badge</label>
        <input type="text" value="${escAttr(p.badge || '')}" data-field="badge">
      </div>
      <div class="field-group">
        <label class="field-label">Hero subtext</label>
        <textarea rows="3" data-field="heroSub">${escHtml(p.heroSub || '')}</textarea>
      </div>
    </div>

    <div class="field-fieldset">
      <div class="field-fieldset-title">Contact links</div>
      <div class="field-group">
        <label class="field-label">GitHub URL</label>
        <input type="text" value="${escAttr(p.github || '')}" data-field="github">
      </div>
      <div class="field-group">
        <label class="field-label">Mastodon URL</label>
        <input type="text" value="${escAttr(p.mastodon || '')}" data-field="mastodon" placeholder="https://mastodon.social/@you">
      </div>
      <div class="field-group">
        <label class="field-label">Discord invite URL</label>
        <input type="text" value="${escAttr(p.discord || '')}" data-field="discord" placeholder="https://discord.gg/yourinvite">
      </div>
      <div class="field-group">
        <label class="field-label">Email</label>
        <input type="text" value="${escAttr(p.email || '')}" data-field="email">
      </div>
      <div class="field-group">
        <label class="field-label">Location</label>
        <input type="text" value="${escAttr(p.location || '')}" data-field="location">
      </div>
    </div>

    <div class="field-fieldset">
      <div class="field-fieldset-title">Contact form</div>
      <div class="field-group">
        <label class="field-label">Discord webhook URL</label>
        <input type="text" value="${escAttr(p.discordWebhookUrl || '')}" data-field="discordWebhookUrl" placeholder="https://discord.com/api/webhooks/...">
        <div class="field-hint">Server Settings → Integrations → Webhooks in Discord. Messages sent through the "Send a message" form land there. <strong>Heads up:</strong> this URL ships in your page's source, so anyone who looks can find it and post to your channel — that's an inherent tradeoff of a backend-less contact form, not a bug. If it gets spammed, delete the webhook and create a new one.</div>
      </div>
    </div>
  `;
  el.querySelectorAll('[data-field]').forEach(input => {
    input.addEventListener('input', () => { data.profile[input.dataset.field] = input.value; });
  });
}

function renderAboutForm(el) {
  if (!data.about) data.about = { whoami: '', interests: '', skills: [], currentFocus: '' };
  const a = data.about;
  el.innerHTML = `
    <div class="detail-header"><div class="detail-title">👤 About Me</div></div>
    <div class="detail-path">Powers the "About Me" card on the web page <em>and</em> the terminal's <code>whoami</code> command — one edit updates both.</div>

    <div class="field-group">
      <label class="field-label">Whoami <span style="text-transform:none">(short bio)</span></label>
      <textarea rows="3" data-field="whoami">${escHtml(a.whoami || '')}</textarea>
    </div>
    <div class="field-group">
      <label class="field-label">Interests</label>
      <textarea rows="3" data-field="interests">${escHtml(a.interests || '')}</textarea>
    </div>
    <div class="field-group">
      <label class="field-label">Skills <span style="text-transform:none">(comma-separated)</span></label>
      <input type="text" value="${escAttr((a.skills || []).join(', '))}" data-field="skills">
      <div class="tag-chip-row">${(a.skills || []).map(s => `<span class="tag-chip">${escHtml(s)}</span>`).join('')}</div>
    </div>
    <div class="field-group">
      <label class="field-label">Current focus</label>
      <textarea rows="2" data-field="currentFocus">${escHtml(a.currentFocus || '')}</textarea>
    </div>
  `;
  el.querySelectorAll('[data-field]').forEach(input => {
    input.addEventListener('input', () => {
      const field = input.dataset.field;
      if (field === 'skills') {
        data.about.skills = input.value.split(',').map(s => s.trim()).filter(Boolean);
        return;
      }
      data.about[field] = input.value;
    });
  });
}

function renderDirForm(el, path) {
  const dir = data.fs[path];
  if (!dir) { el.innerHTML = `<div class="admin-empty">This folder no longer exists.</div>`; return; }
  const isRoot = path === '~';
  const entry = getDirEntryInParent(path);
  const displayName = isRoot ? '~ (Home)' : (entry ? entry.name : path.split('/').pop());
  const isTopLevel = !isRoot && path.replace('~/', '').split('/').filter(Boolean).length === 1;

  let html = `
    <div class="detail-header">
      <div class="detail-title">📁 ${escHtml(displayName)}</div>
      <span class="detail-kind-badge">folder</span>
    </div>
    <div class="detail-path">${escHtml(path)}</div>
  `;

  if (!isRoot) {
    html += `
      <div class="field-group">
        <label class="field-label">Folder name</label>
        <input type="text" value="${escAttr(entry.name)}" data-dir-field="name">
      </div>
    `;
  } else {
    html += `<div class="help-box">This is the filesystem root — what visitors see with <code>ls -la</code> in the terminal. Use <strong>＋ New category</strong> above to add a top-level category.</div>`;
  }

  if (dir.sectionId) {
    html += `
      <div class="field-fieldset">
        <div class="field-fieldset-title">Web page section</div>
        <div class="field-group">
          <label class="field-label">Terminal-style tag line</label>
          <input type="text" value="${escAttr(dir.sectionTag || '')}" data-dir-field="sectionTag" placeholder="$ ls ./whatever">
        </div>
        <div class="field-group">
          <label class="field-label">Section heading</label>
          <input type="text" value="${escAttr(dir.sectionHeading || '')}" data-dir-field="sectionHeading">
        </div>
        <div class="field-group">
          <label class="field-label">Section description</label>
          <textarea rows="2" data-dir-field="sectionDesc">${escHtml(dir.sectionDesc || '')}</textarea>
        </div>
        <div class="field-hint">Mount point in index.html: <code>#${escHtml(dir.mountId || '—')}</code>${!hasMatchingMount(dir) ? ' — <span style="color:var(--amber)">not found yet, see below</span>' : ''}</div>
      </div>
    `;
  } else if (isTopLevel) {
    html += `
      <div class="help-box">This category only exists in the terminal right now.</div>
      <button class="admin-btn admin-btn-primary" id="btnMakeSection">✨ Make this a web page section</button>
    `;
  }

  html += `
    <div class="detail-actions">
      <button class="admin-btn" data-action="add-subfolder" data-path="${escAttr(path)}">＋ Subfolder</button>
      <button class="admin-btn" data-action="add-file" data-path="${escAttr(path)}">＋ File</button>
      <button class="admin-btn" data-action="add-link" data-path="${escAttr(path)}">＋ Link</button>
      ${!isRoot ? `<button class="admin-btn admin-btn-danger" data-action="delete-dir" data-path="${escAttr(path)}">🗑 Delete folder</button>` : ''}
    </div>
  `;

  if (needsIndexHtmlPatch()) {
    html += `<div style="margin-top:16px;"><button class="admin-btn" id="btnPatchHtml">⬇ Download index.html with new section(s) wired in</button></div>`;
  }

  el.innerHTML = html;

  el.querySelectorAll('[data-dir-field]').forEach(input => {
    input.addEventListener('input', () => {
      const field = input.dataset.dirField;
      if (field === 'name') { entry.name = input.value; renderTree(); }
      else dir[field] = input.value;
    });
  });
  el.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => performAction(btn.dataset.action, btn.dataset)));
  const btnMakeSection = document.getElementById('btnMakeSection');
  if (btnMakeSection) btnMakeSection.addEventListener('click', () => makeSection(path));
  const btnPatchHtml = document.getElementById('btnPatchHtml');
  if (btnPatchHtml) btnPatchHtml.addEventListener('click', downloadPatchedIndexHtml);
}

function renderItemForm(el, dirPath, idx) {
  const dir = data.fs[dirPath];
  const item = dir && dir.items[idx];
  if (!item) { el.innerHTML = `<div class="admin-empty">This item no longer exists.</div>`; selection = null; return; }

  const isLink = item.type === 'link';
  const isExec = item.type === 'exec';
  const isFile = item.type === 'file';
  const section = nearestSectionAncestor(dirPath);
  const wantsProgress = section && section.cardFooter === 'progress';

  let html = `
    <div class="detail-header">
      <div class="detail-title">${isLink ? '🔗' : isExec ? '⚙️' : '📄'} ${escHtml(item.title || item.name)}</div>
      <span class="detail-kind-badge">${escHtml(item.type)}</span>
    </div>
    <div class="detail-path">${escHtml(dirPath)}/${escHtml(item.name)}</div>

    <div class="field-group">
      <label class="field-label">Internal name</label>
      <input type="text" value="${escAttr(item.name)}" data-item-field="name">
    </div>
    <div class="field-group">
      <label class="field-label">Display title <span style="text-transform:none">(optional — falls back to name)</span></label>
      <input type="text" value="${escAttr(item.title || '')}" data-item-field="title">
    </div>
  `;

  if (isLink) {
    html += `
      <div class="field-group">
        <label class="field-label">URL</label>
        <input type="text" value="${escAttr(item.url || '')}" data-item-field="url">
      </div>
    `;
  }

  if (isFile) {
    html += `
      <div class="field-row">
        <div class="field-group">
          <label class="field-label">Format</label>
          <select data-item-field="format">
            <option value="md" ${item.format === 'md' ? 'selected' : ''}>Markdown (.md)</option>
            <option value="txt" ${item.format === 'txt' ? 'selected' : ''}>Plain text (.txt)</option>
            <option value="pdf" ${item.format === 'pdf' ? 'selected' : ''}>PDF</option>
          </select>
        </div>
        <div class="field-group">
          <label class="field-label">Source path</label>
          <input type="text" value="${escAttr(item.src || '')}" data-item-field="src">
          <div class="field-hint">Local path (<code>content/poc/name.md</code>) or a full URL, e.g. a GitHub raw link — either works.</div>
        </div>
      </div>
      <div class="field-group">
        <label class="field-label">Source repo <span style="text-transform:none">(optional)</span></label>
        <input type="text" value="${escAttr(item.repoUrl || '')}" data-item-field="repoUrl" placeholder="https://github.com/you/repo">
        <div class="field-hint">Adds an "↗ View on GitHub" link when reading this item. Handy if <strong>Source path</strong> above points at that repo's raw README — images with relative paths in it resolve automatically.</div>
      </div>
    `;
  }

  if (!isExec) {
    html += `
      <div class="field-group">
        <label class="field-label">Short description <span style="text-transform:none">(shown on its card)</span></label>
        <textarea rows="2" data-item-field="desc">${escHtml(item.desc || '')}</textarea>
      </div>
      <div class="field-row">
        <div class="field-group">
          <label class="field-label">Icon (emoji)</label>
          <input type="text" value="${escAttr(item.icon || '')}" data-item-field="icon" maxlength="4" placeholder="🔓">
        </div>
        <div class="field-group">
          <label class="field-label">Date</label>
          <input type="text" value="${escAttr(item.date || '')}" data-item-field="date" ${wantsProgress ? 'disabled placeholder="n/a for progress items"' : 'placeholder="2026-08-09"'}>
        </div>
      </div>
      <div class="field-group">
        <label class="field-label">Card accent color</label>
        <div class="color-swatch-row">
          ${['accent', 'amber', 'green', 'red', 'magenta'].map(c => `<div class="color-swatch c-${c} ${item.color === c ? 'selected' : ''}" data-color="${c}" title="${c}">●</div>`).join('')}
        </div>
      </div>
    `;
  }

  if (wantsProgress) {
    const showProgress = item.showProgress !== false;
    html += `
      <div class="field-group">
        <label class="field-label">Progress</label>
        <input type="text" value="${escAttr(item.meta || '')}" data-item-field="meta" placeholder="65%">
      </div>
      <div class="field-group">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; text-transform:none; font-size:13px; color:var(--text);">
          <input type="checkbox" data-item-field="showProgress" ${showProgress ? 'checked' : ''} style="width:auto;">
          Show progress bar on this card
        </label>
      </div>
    `;
  } else if (isLink) {
    html += `
      <div class="field-group">
        <label class="field-label">Badge label <span style="text-transform:none">(optional, e.g. Python)</span></label>
        <input type="text" value="${escAttr(item.meta || '')}" data-item-field="meta">
      </div>
    `;
  }

  if (!isExec) {
    html += `
      <div class="field-group">
        <label class="field-label">Tags <span style="text-transform:none">(comma-separated)</span></label>
        <input type="text" value="${escAttr((item.tags || []).join(', '))}" data-item-field="tags">
        <div class="tag-chip-row">${(item.tags || []).map(t => `<span class="tag-chip">${escHtml(t)}</span>`).join('')}</div>
      </div>
    `;
  }

  if (isExec) {
    html += `
      <div class="field-group">
        <label class="field-label">Special render mode</label>
        <select data-item-field="render">
          <option value="contact" ${item.render === 'contact' ? 'selected' : ''}>Contact form</option>
          <option value="" ${!item.render ? 'selected' : ''}>None</option>
        </select>
      </div>
    `;
  }

  if (isFile && item.format !== 'pdf') {
    html += `
      <div class="field-fieldset">
        <div class="field-fieldset-title">File content</div>
        <div class="content-status" id="contentStatus">Loading…</div>
        <textarea class="content-textarea" id="contentTextarea" spellcheck="false" placeholder="${item.format === 'md' ? '# ' + escAttr(item.title || item.name) + '\n\nStart writing…' : 'Start writing…'}"></textarea>
        <div class="field-hint">The actual article/note body, saved as <code>${escHtml(item.src || '(set a source path above)')}</code> when you save to your folder or download it below.</div>
      </div>
    `;
  }

  html += `
    <div class="detail-actions">
      ${isFile && item.format !== 'pdf' ? `<button class="admin-btn admin-btn-primary" id="btnDownloadContent">⬇ Download this file</button>` : ''}
      <button class="admin-btn" data-action="duplicate-item" data-dir="${escAttr(dirPath)}" data-idx="${idx}">⧉ Duplicate</button>
      <button class="admin-btn" data-action="move-item" data-dir="${escAttr(dirPath)}" data-idx="${idx}" data-delta="-1">↑ Move up</button>
      <button class="admin-btn" data-action="move-item" data-dir="${escAttr(dirPath)}" data-idx="${idx}" data-delta="1">↓ Move down</button>
      <button class="admin-btn admin-btn-danger" data-action="delete-item" data-dir="${escAttr(dirPath)}" data-idx="${idx}">🗑 Delete</button>
    </div>
  `;

  el.innerHTML = html;

  el.querySelectorAll('[data-item-field]').forEach(input => {
    const eventName = input.type === 'checkbox' ? 'change' : 'input';
    input.addEventListener(eventName, () => {
      const field = input.dataset.itemField;
      if (field === 'showProgress') { item.showProgress = input.checked; return; }
      const val = input.value;
      if (field === 'tags') { item.tags = val.split(',').map(t => t.trim()).filter(Boolean); return; }
      if (field === 'src') {
        const oldSrc = item.src;
        item.src = val;
        if (oldSrc && fileContents.hasOwnProperty(oldSrc) && oldSrc !== val) {
          fileContents[val] = fileContents[oldSrc];
          delete fileContents[oldSrc];
        }
        return;
      }
      item[field] = val;
      if (field === 'name' || field === 'title') renderTree();
    });
  });

  el.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      item.color = sw.dataset.color;
      el.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      sw.classList.add('selected');
    });
  });

  el.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => performAction(btn.dataset.action, btn.dataset)));

  if (isFile && item.format !== 'pdf') {
    const ta = document.getElementById('contentTextarea');
    const statusEl = document.getElementById('contentStatus');
    loadItemContent(item, ta, statusEl);
    ta.addEventListener('input', () => { if (item.src) fileContents[item.src] = ta.value; });
    const btnDl = document.getElementById('btnDownloadContent');
    if (btnDl) btnDl.addEventListener('click', () => downloadFileContent(item, ta.value));
  }
}

async function loadItemContent(item, ta, statusEl) {
  const src = item.src;
  const isExternal = /^https?:\/\//i.test(src || '');
  if (!src) { statusEl.textContent = 'No source path set yet — add one above.'; statusEl.className = 'content-status warn'; return; }
  if (fileContents.hasOwnProperty(src)) {
    ta.value = fileContents[src];
    statusEl.textContent = isExternal
      ? 'Live preview from ' + src + ' — edits here are local only and won\'t be written back to that repo.'
      : 'Edited this session — not yet saved to disk.';
    statusEl.className = isExternal ? 'content-status' : 'content-status warn';
    return;
  }
  statusEl.textContent = 'Loading ' + src + '…';
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    ta.value = text;
    fileContents[src] = text;
    statusEl.textContent = isExternal ? 'Live preview from ' + src : 'Loaded from ' + src;
    statusEl.className = 'content-status ok';
  } catch (e) {
    ta.value = '';
    statusEl.textContent = isExternal
      ? `Couldn't load ${src} — check the URL, or that repo/branch is public.`
      : `Nothing found at ${src} yet — write your content below, then save or download it.`;
    statusEl.className = 'content-status warn';
  }
}

function downloadFileContent(item, text) {
  if (!item.src) { toast('Set a source path first.'); return; }
  const filename = item.src.split('/').pop();
  triggerDownload(new Blob([text], { type: 'text/plain' }), filename);
  toast(`Downloaded ${filename} — place it at ${item.src} in your project.`);
}

// ===================== NEW-SECTION → index.html HELPER =====================
function discoverSectionsFromData() {
  const home = data.fs['~'];
  if (!home || !home.items) return [];
  return home.items.filter(i => i.type === 'dir' && i.path).map(i => data.fs[i.path]).filter(d => d && d.sectionId && d.mountId);
}
function hasMatchingMount(dir) {
  if (!cachedIndexHtml) return true; // unknown yet — don't nag
  return cachedIndexHtml.includes(`id="${dir.mountId}"`);
}
function needsIndexHtmlPatch() {
  if (!cachedIndexHtml) return false;
  return discoverSectionsFromData().some(d => !hasMatchingMount(d));
}
function discoverMissingSections(html) {
  return discoverSectionsFromData().filter(d => !html.includes(`id="${d.mountId}"`));
}
function buildSectionBlock(dir) {
  const gridClass = dir.cardStyle === 'reportsList' ? 'report-list' : dir.cardStyle === 'notesGrid' ? 'notes-grid' : 'grid';
  return `<section id="${dir.sectionId}">
  <div class="section-header fade-in">
    <span class="section-tag" id="${dir.sectionId}SectionTag">${escHtml(dir.sectionTag || '')}</span>
    <h2 id="${dir.sectionId}SectionHeading">${escHtml(dir.sectionHeading || dir.sectionId)}</h2>
    <p class="section-desc" id="${dir.sectionId}SectionDesc">${escHtml(dir.sectionDesc || '')}</p>
  </div>
  <!-- Populated by renderWebSections() in app.js from content.json. -->
  <div class="${gridClass}" id="${dir.mountId}"></div>
</section>

`;
}
async function downloadPatchedIndexHtml() {
  let html = cachedIndexHtml;
  if (!html) {
    try { const res = await fetch('index.html'); if (res.ok) html = await res.text(); } catch (e) { /* ignore */ }
  }
  if (!html) { toast('Could not load index.html — make sure admin.html is served alongside your site files.'); return; }

  const missing = discoverMissingSections(html);
  if (missing.length === 0) { toast('index.html already has a section for every category.'); return; }

  const navAnchor = /(<li><a href="#contact" class="nav-link">Contact<\/a><\/li>)/;
  const sectionAnchor = /(<section id="contact">)/;
  if (!sectionAnchor.test(html)) { toast("Couldn't find a safe spot to insert the new section — index.html may have been customized. Add it manually; see the content guide."); return; }

  let patched = html;
  if (navAnchor.test(patched)) {
    const navInsert = missing.map(d => `      <li><a href="#${d.sectionId}" class="nav-link">${escHtml(d.sectionHeading || d.sectionId)}</a></li>\n`).join('');
    patched = patched.replace(navAnchor, navInsert + '$1');
  }
  const sectionInsert = missing.map(buildSectionBlock).join('');
  patched = patched.replace(sectionAnchor, sectionInsert + '$1');

  triggerDownload(new Blob([patched], { type: 'text/html' }), 'index.html');
  toast(`Downloaded index.html with ${missing.length} new section${missing.length > 1 ? 's' : ''} wired in — replace your existing file with this one.`);
}

// ===================== TOOLBAR =====================
function downloadJson() {
  triggerDownload(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'content.json');
  toast('Downloaded content.json — replace the one in your project.');
}

async function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed.fs || !parsed.fs['~']) throw new Error('Missing fs.~ — is this the right content.json?');
    if (!parsed.profile) parsed.profile = {};
    if (!parsed.about) parsed.about = {};
    data = parsed;
    fileContents = {};
    selection = null;
    renderTree();
    renderDetail();
    setStatus('Imported ' + file.name, 'ok');
    toast('Imported ' + file.name);
  } catch (err) {
    toast('Could not import: ' + err.message);
  }
  e.target.value = '';
}

function openJsonModal() {
  document.getElementById('jsonRawText').value = JSON.stringify(data, null, 2);
  document.getElementById('jsonModalStatus').textContent = '';
  document.getElementById('jsonModalStatus').className = 'admin-status';
  document.getElementById('jsonModalBackdrop').classList.add('open');
}
function closeJsonModal() {
  document.getElementById('jsonModalBackdrop').classList.remove('open');
}
function applyRawJson() {
  const text = document.getElementById('jsonRawText').value;
  const statusEl = document.getElementById('jsonModalStatus');
  try {
    const parsed = JSON.parse(text);
    if (!parsed.fs || !parsed.fs['~']) throw new Error('Missing fs.~ root');
    if (!parsed.profile) parsed.profile = {};
    if (!parsed.about) parsed.about = {};
    data = parsed;
    fileContents = {};
    selection = null;
    renderTree();
    renderDetail();
    statusEl.textContent = 'Applied.';
    statusEl.className = 'admin-status ok';
    toast('Applied JSON changes.');
    setTimeout(closeJsonModal, 600);
  } catch (e) {
    statusEl.textContent = 'Invalid JSON: ' + e.message;
    statusEl.className = 'admin-status warn';
  }
}

async function connectFolder() {
  if (!window.showDirectoryPicker) {
    toast("Your browser doesn't support saving directly to a folder — that's Chrome/Edge only. Use Download instead, it works everywhere.");
    return;
  }
  try {
    dirHandle = await window.showDirectoryPicker();
    document.getElementById('btnSaveFolder').disabled = false;
    setStatus('Connected: ' + dirHandle.name, 'ok');
    toast(`Connected to "${dirHandle.name}". Click "Save to folder" any time to write your changes there.`);
  } catch (e) { /* user cancelled the picker */ }
}

async function writeFileToHandle(rootHandle, relPath, text) {
  const parts = relPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  let dir = rootHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function saveAllToFolder() {
  if (!dirHandle) return;
  try {
    await writeFileToHandle(dirHandle, 'content.json', JSON.stringify(data, null, 2));
    // Only write locally-sourced content — a src that's a full URL (e.g. a
    // GitHub raw link) lives in that external repo, not in this project.
    const entries = Object.entries(fileContents).filter(([src]) => src && !/^https?:\/\//i.test(src));
    for (const [src, text] of entries) await writeFileToHandle(dirHandle, src, text);
    toast(`Saved content.json${entries.length ? ` and ${entries.length} content file(s)` : ''} to your folder.`);
  } catch (e) {
    toast('Save failed: ' + e.message);
  }
}

// ===================== INIT =====================
async function init() {
  document.getElementById('btnDownloadJson').addEventListener('click', downloadJson);
  document.getElementById('btnImportJson').addEventListener('click', () => document.getElementById('fileImport').click());
  document.getElementById('fileImport').addEventListener('change', handleImportFile);
  document.getElementById('btnRawJson').addEventListener('click', openJsonModal);
  document.getElementById('btnCloseJsonModal').addEventListener('click', closeJsonModal);
  document.getElementById('btnApplyRawJson').addEventListener('click', applyRawJson);
  document.getElementById('jsonModalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'jsonModalBackdrop') closeJsonModal(); });
  document.getElementById('btnConnectFolder').addEventListener('click', connectFolder);
  document.getElementById('btnSaveFolder').addEventListener('click', saveAllToFolder);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeJsonModal(); });

  document.getElementById('tree').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    performAction(btn.dataset.action, btn.dataset);
  });

  if (!window.showDirectoryPicker) {
    const b = document.getElementById('btnConnectFolder');
    b.disabled = true;
    b.title = 'Not supported in this browser (Chrome/Edge only) — use Download instead.';
  }

  try {
    const res = await fetch('content.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const parsed = await res.json();
    if (!parsed.fs || !parsed.fs['~']) throw new Error('content.json is missing fs.~');
    data = parsed;
    if (!data.profile) data.profile = {};
    if (!data.about) data.about = {};
    setStatus('Loaded content.json', 'ok');
  } catch (e) {
    data = { profile: {}, fs: { '~': { type: 'dir', items: [] } } };
    setStatus('Could not auto-load content.json', 'warn');
    toast("Couldn't load content.json automatically — this happens if you opened this file directly instead of through a local server. Try Import, or serve the folder (e.g. `python3 -m http.server`).");
  }

  fetch('index.html').then(r => r.ok ? r.text() : null).then(t => {
    cachedIndexHtml = t;
    if (selection && selection.kind === 'dir') renderDetail();
  }).catch(() => {});

  renderTree();
  selectProfile();
}

init();

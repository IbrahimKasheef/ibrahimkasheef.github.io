// ===================== STATE =====================
let contentData = null;
let openTabs = [];
let activeTab = null;
let isTyping = false;
let tabCounter = 0;
const commandHistory = {};
const historyIndex = {};

// Real Android/iOS devices only — deliberately NOT viewport-width-based,
// so a resized desktop browser window keeps the normal desktop UI and
// only an actual phone/tablet gets the mobile nav (hamburger menu, quick
// icons, fullscreen recon overlay, defaulting to the web view). Applied
// immediately (not inside DOMContentLoaded) so the relevant CSS is
// already active before first paint.
function isMobileOS() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
if (isMobileOS()) document.documentElement.classList.add('mobile-os');

// ===================== UTILITIES =====================
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Produces a value safe to splice into onclick="fn(VALUE)" that the browser
// hands to the JS parser as the exact string `str` — including names with
// spaces, quotes, or other special characters (e.g. a report title used as
// a filename). JSON.stringify gives a correctly-escaped JS string literal;
// the extra replace calls make that literal safe to sit inside a
// double-quoted HTML attribute.
function jsAttrStr(str) {
  return JSON.stringify(String(str))
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Wraps a string in double quotes (shell-style) if it contains whitespace
// or quote characters, escaping any internal " or \ — so a constructed
// command string like `cat <this>` stays a single argument even when the
// underlying name has spaces in it.
function shellQuote(str) {
  str = String(str);
  if (!/[\s"'\\]/.test(str)) return str;
  return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Tokenizes a typed/constructed command line the way a shell would:
// "double quoted" and 'single quoted' segments are kept as one argument
// each (with \" and \\ un-escaped inside double quotes), everything else
// splits on whitespace. Replaces a naive rawCmd.split(/\s+/), which broke
// on any file/folder name containing a space.
function tokenizeCommand(str) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m[1] !== undefined) tokens.push(m[1].replace(/\\(["\\])/g, '$1'));
    else if (m[2] !== undefined) tokens.push(m[2]);
    else tokens.push(m[3]);
  }
  return tokens;
}

function getPrompt(path) {
  return `<span class="prompt"><span class="prompt-user">user</span>@<span class="prompt-host">portfolio</span>:<span class="prompt-path">${path}</span><span class="prompt-dollar">$</span></span>`;
}

// Single source of truth for tag -> style mapping. Previously duplicated
// in both catCommand() and renderFileContent(); now shared by both plus
// the web-view card renderers below.
function tagClass(tag) {
  if (tag === 'Critical') return 'critical';
  if (tag === 'Disclosed' || tag === 'Fixed') return 'fixed';
  if (tag === 'Authentication' || tag === 'Data Exposure') return 'info';
  return '';
}

// Web-view "card-icon" / tag tint. Content authors pick a color name
// (accent/amber/green/red/magenta) and it maps to a CSS class defined in
// style.css. This replaces the old inline `style="color: var(--accent)"`
// approach, where --accent was never actually defined anywhere in the
// stylesheet (icons silently rendered in the default text color instead
// of their intended tint) — see .tint-* rules in style.css.
const VALID_TINTS = ['accent', 'amber', 'green', 'red', 'magenta'];
function tintClass(color) {
  return VALID_TINTS.includes(color) ? 'tint-' + color : 'tint-accent';
}

// Progress-bar fill color by completion percentage — used by both the
// web-view card grid and the terminal's WIP listing, so a project's
// completion state reads the same way in both places instead of an
// arbitrary gradient. web=true uses the web theme's variable names.
function progressColor(pct, web) {
  if (pct < 25) return web ? 'var(--web-accent)' : 'var(--cyan)';
  if (pct < 50) return web ? 'var(--web-blue)' : 'var(--blue)';
  if (pct < 75) return web ? 'var(--web-light-green)' : 'var(--light-green)';
  return web ? 'var(--web-green)' : 'var(--green)';
}

// Status-style tags (Critical/Disclosed/Fixed) get a matching color on
// web-view cards, same idea as tagClass() above but using the tag-red /
// tag-amber / tag-green modifier classes the web card markup expects.
// A tag that matches the item's own "meta" (its category badge, e.g. a
// repo's language) is tinted with that item's own color instead.
const STATUS_TAG_TINTS = { Critical: 'red', Disclosed: 'amber', Fixed: 'green' };
function tagWebClass(tag, item) {
  if (item && item.meta && tag === item.meta && item.color) return 'tag-' + item.color;
  if (STATUS_TAG_TINTS[tag]) return 'tag-' + STATUS_TAG_TINTS[tag];
  return '';
}
// ===================== MARKDOWN IMAGE PATH FIXER =====================
function fixMarkdownImagePaths(mdText, srcPath) {
  // srcPath is like "content/poc/auth-bypass.md" or a full URL to a raw
  // GitHub file — either way, get the directory part to resolve relative
  // images against ("content/poc", or ".../repo/main/docs" for a URL).
  const lastSlash = srcPath.lastIndexOf('/');
  const baseDir = lastSlash === -1 ? '' : srcPath.slice(0, lastSlash);
  const resolve = (path) => {
    if (/^(https?:)?\/\//i.test(path) || path.startsWith('/')) return path; // already absolute
    return baseDir ? baseDir + '/' + path : path;
  };

  // Markdown image syntax: ![alt](path)
  let fixed = mdText.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (match, alt, path) => `![${alt}](${resolve(path)})`
  );

  // Raw HTML <img src="..."> — common in GitHub READMEs that use HTML for
  // sizing/centering (badges, screenshots wrapped in <p align="center">).
  fixed = fixed.replace(
    /(<img\s[^>]*?src=["'])([^"']+)(["'])/gi,
    (match, pre, path, post) => pre + resolve(path) + post
  );

  return fixed;
}

// Wraps marked.parse() so a rendering failure — marked.js blocked by an
// ad-blocker/firewall, a CDN hiccup, whatever — degrades to plain escaped
// text instead of throwing. That matters because the caller combines this
// with a header (tags/date/repo link); if marked.parse() threw directly,
// that header was built but never reached the DOM, since the whole
// concatenated string failed to construct.
function safeMarkdownParse(fixedText) {
  try {
    if (typeof marked === 'undefined' || !marked.parse) throw new Error('marked.js not loaded');
    return marked.parse(fixedText).replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  } catch (e) {
    console.error('Markdown rendering failed, showing raw text instead:', e);
    return '<pre class="txt-content">' + escapeHtml(fixedText) + '</pre>';
  }
}



function resolvePath(current, target) {
  if (!target || target === '~') return '~';
  if (target.startsWith('~/')) return target;
  if (target === '/') return '~';
  if (target.startsWith('/')) return '~' + target;
  let base = current === '~' ? [] : current.replace('~/', '').split('/').filter(Boolean);
  const segs = target.split('/').filter(Boolean);
  for (const seg of segs) {
    if (seg === '..') base.pop();
    else if (seg !== '.') base.push(seg);
  }
  return base.length === 0 ? '~' : '~/' + base.join('/');
}

function getDirData(path) {
  return contentData?.fs?.[path] || null;
}

function findItem(path) {
  const parts = path.replace('~/', '').split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const fileName = parts.pop();
  const dirPath = parts.length === 0 ? '~' : '~/' + parts.join('/');
  const dir = getDirData(dirPath);
  if (!dir || dir.type !== 'dir') return null;
  return dir.items.find(i => i.name === fileName || i.path === path) || null;
}

function getParentDir(path) {
  if (path === '~') return '~';
  const parts = path.replace('~/', '').split('/').filter(Boolean);
  parts.pop();
  return parts.length === 0 ? '~' : '~/' + parts.join('/');
}

// Auto-focusing the command input is nice on desktop (start typing right
// away) but actively harmful on touch devices — it pops the virtual
// keyboard on page load and the browser's native "scroll input into view"
// behavior drags the whole page down to the input, which sits at the
// bottom of the pane, burying the actual directory listing above it.
function isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

function paneIdToPath(paneId) {
  const tab = openTabs.find(t => t.id === paneId);
  return tab ? tab.path : '~';
}

// ===================== DOM HELPERS =====================
function appendLog(paneId, html, isError) {
  const log = document.getElementById('session-' + paneId);
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'log-output' + (isError ? ' error' : '');
  div.innerHTML = html;
  log.appendChild(div);
  scrollCommandToTop(paneId);
}

// Scrolls the terminal so the most recently run command sits at the top of
// the visible area, with its output flowing downward — rather than jumping
// straight to the bottom of a long output, which would bury the command
// itself (and anything useful above it) off-screen above the fold.
function scrollCommandToTop(paneId) {
  const log = document.getElementById('session-' + paneId);
  const body = document.getElementById('terminalBody');
  if (!log || !body) return;
  const cmdLines = log.querySelectorAll('.log-cmd');
  const lastCmd = cmdLines[cmdLines.length - 1];
  if (!lastCmd) { body.scrollTop = body.scrollHeight; return; }
  const bodyRect = body.getBoundingClientRect();
  const cmdRect = lastCmd.getBoundingClientRect();
  body.scrollTop += (cmdRect.top - bodyRect.top);
}

function appendCmd(paneId, cmd, path) {
  const log = document.getElementById('session-' + paneId);
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'log-cmd';
  div.innerHTML = `${getPrompt(path)} <span style="color:var(--text)">${escapeHtml(cmd)}</span>`;
  log.appendChild(div);
}

function setVal(id, val, colorClass) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = val;
    if (colorClass) el.className = 'recon-value ' + colorClass;
  }
}

// ===================== TAB MANAGEMENT =====================
function renderTabs() {
  const tabbar = document.getElementById('tabbar');
  let html = '';
  openTabs.forEach(tab => {
    const isActive = tab.id === activeTab ? 'active' : '';
    html += `<div class="tab ${isActive}" data-tab="${tab.id}" onclick="switchTab('${tab.id}')">`;
    html += `<span>${tab.icon}</span> ${escapeHtml(tab.label)}`;
    if (tab.id !== 'home') {
      html += `<span class="tab-close" onclick="event.stopPropagation(); closeTab('${tab.id}')">×</span>`;
    }
    html += `</div>`;
  });
  html += `<div class="tab-new" onclick="goHome()" title="New tab">+</div>`;
  tabbar.innerHTML = html;
}

function switchTab(tabId) {
  if (isTyping) return;
  activeTab = tabId;
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  const pane = document.getElementById('pane-' + tabId);
  if (pane) pane.classList.add('active');
  renderTabs();
  document.getElementById('terminalBody').scrollTop = 0;
  if (!isTouchDevice()) {
    setTimeout(() => {
      const input = document.querySelector(`#pane-${tabId} .cmd-input`);
      if (input) input.focus();
    }, 50);
  }
}

function closeTab(tabId) {
  if (tabId === 'home') return;
  const idx = openTabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;
  const pane = document.getElementById('pane-' + tabId);
  if (pane) pane.remove();
  openTabs.splice(idx, 1);
  if (activeTab === tabId) activeTab = openTabs[Math.max(0, idx - 1)].id;
  switchTab(activeTab);
}

function goHome() {
  const homeTab = openTabs.find(t => t.id === 'home');
  if (!homeTab) {
    createHomePane();
    openTabs.unshift({ id: 'home', path: '~', label: '~', icon: '🏠' });
  }
  switchTab('home');
}

function createTabForPath(path, label, icon) {
  tabCounter++;
  const tabId = 'tab-' + tabCounter;
  openTabs.push({ id: tabId, path, label, icon });
  return tabId;
}

// ===================== PANE CREATION =====================
function createPane(tabId, path, staticHtml) {
  const existing = document.getElementById('pane-' + tabId);
  if (existing) return existing;
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.id = 'pane-' + tabId;
  pane.innerHTML = `
    <div class="pane-static-content" id="static-${tabId}">${staticHtml}</div>
    <div class="session-log" id="session-${tabId}"></div>
    <div class="prompt-line">
      ${getPrompt(path)}
      <input type="text" class="cmd-input" data-pane="${tabId}" data-path="${path}" autocomplete="off" spellcheck="false" placeholder="Type a command...">
    </div>
  `;
  document.getElementById('terminalBody').appendChild(pane);
  return pane;
}

function createHomePane() {
  const staticHtml = `
    <div class="prompt-line">
      <span class="prompt"><span class="prompt-user">user</span>@<span class="prompt-host">portfolio</span>:<span class="prompt-path">~</span><span class="prompt-dollar">$</span></span>
      <span class="cmd">ls -la</span>
    </div>
    <div class="cmd-output">
      <div style="color: var(--text-dim); font-size: 12px; margin-bottom: 8px;">
        total 48<br>drwxr-xr-x  8 user user 4096 Aug  1 23:35 .<br>drwxr-xr-x  3 user user 4096 ..<br>-rw-r--r--  1 user user 2.1K about-me.txt<br>drwxr-xr-x  2 user user 4.0K proof-of-concepts<br>drwxr-xr-x  2 user user 4.0K repositories<br>drwxr-xr-x  2 user user 4.0K reports<br>drwxr-xr-x  2 user user 4.0K notes<br>drwxr-xr-x  2 user user 4.0K work-in-progress<br>-rwxr-xr-x  1 user user  512 get-in-touch.sh
      </div>
      ${renderDirectory('~', true)}
    </div>
    <div class="prompt-line">
      <span class="prompt"><span class="prompt-user">user</span>@<span class="prompt-host">portfolio</span>:<span class="prompt-path">~</span><span class="prompt-dollar">$</span></span>
      <span class="cmd">echo "Welcome to my portfolio. Click any file or folder to explore, or type a command."</span>
    </div>
    <div class="cmd-output" style="color: var(--text-dim);">Welcome to my portfolio. Click any file or folder to explore, or type a command.</div>
    <div class="prompt-line">
      <span class="prompt"><span class="prompt-user">user</span>@<span class="prompt-host">portfolio</span>:<span class="prompt-path">~</span><span class="prompt-dollar">$</span></span>
      <span class="cmd">whoami</span>
    </div>
    <div class="cmd-output">Security researcher & developer. I find vulnerabilities, build tools, and write about it.</div>
  `;
  createPane('home', '~', staticHtml);
}

// ===================== DIRECTORY RENDERING =====================
function renderDirectory(path) {
  const dir = getDirData(path);
  if (!dir || dir.type !== 'dir') return '<div style="color:var(--red)">Directory not found</div>';
  let html = '<div class="ls-grid">';
  if (path !== '~') {
    const parentPath = getParentDir(path);
    html += `<div class="ls-item dir" onclick="openFolder(${jsAttrStr(parentPath)})" title="Go to parent directory">`;
    html += `<span class="icon">📁</span><span class="name">..</span><span class="meta"></span></div>`;
  }
  for (const item of dir.items) {
    const typeClass = item.type === 'dir' ? 'dir' : item.type === 'exec' ? 'exec' : item.type === 'link' ? 'link' : 'file';
    const icon = item.type === 'dir' ? '📁' : item.type === 'exec' ? '📧' : item.type === 'link' ? '📦' : '📄';
    const meta = item.meta || item.size || '';
    const clickAction = item.type === 'dir'
      ? `openFolder(${jsAttrStr(item.path || (path + '/' + item.name))})`
      : item.type === 'link'
        ? `openLinkInTerminal(${jsAttrStr(item.url)})`
        : `catFileInTerminal(${jsAttrStr(item.path || (path + '/' + item.name))})`;
    html += `<div class="ls-item ${typeClass}" onclick="${clickAction}" title="${escapeHtml(item.name).replace(/"/g, '&quot;')}">`;
    html += `<span class="icon">${icon}</span><span class="name">${escapeHtml(item.name)}</span><span class="meta">${escapeHtml(meta)}</span></div>`;
  }
  html += '</div>';
  return html;
}

// ===================== FILE RENDERING =====================
async function renderFileContent(item, containerId, paneId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (item.render === 'contact') {
    container.innerHTML = renderContactHtml();
    return;
  }
  if (item.render === 'wip') {
    container.innerHTML = renderWipHtml();
    return;
  }
  const format = item.format || 'txt';
  const src = item.src;
  if (format === 'pdf') {
    container.innerHTML = `
      <span class="back-link" onclick="navigateBack('${getParentDir(item.path || '')}')">&larr; cd ${getParentDir(item.path || '')}</span>
      <embed src="${src}" type="application/pdf" class="pdf-content">
      <div class="pdf-fallback"><p>PDF not loading? <a href="${src}" target="_blank">Open directly</a></p></div>
    `;
    return;
  }
  if (!src) {
    container.innerHTML = `<div style="color:var(--red)">No source file configured for this item.</div>`;
    return;
  }
  container.innerHTML = '<div class="loading-text">Loading ' + item.name + '...</div>';
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    let header = '';
    if (item.date || (item.tags && item.tags.length) || item.repoUrl) {
      header = '<div style="margin-bottom:16px;">';
      if (item.tags && item.tags.length) {
        header += '<div class="tags">' + item.tags.map(t =>
          `<span class="tag ${tagClass(t)}">${escapeHtml(t)}</span>`
        ).join('') + '</div>';
      }
      if (item.date) header += `<p style="color:var(--text-dim);margin-top:8px;">${escapeHtml(item.date)}</p>`;
      if (item.repoUrl) header += `<p style="margin-top:8px;"><a href="${escapeHtml(item.repoUrl)}" target="_blank" style="color:var(--cyan);">↗ View on GitHub</a></p>`;
      header += '</div>';
    }
    const backPath = getParentDir(item.path || paneIdToPath(paneId) || '~');
    const backLink = `<span class="back-link" onclick="navigateBack('${backPath}')">&larr; cd ${backPath}</span>`;
    if (format === 'md') {
      const fixedText = fixMarkdownImagePaths(text, src);
      const mdHtml = safeMarkdownParse(fixedText);
      container.innerHTML = backLink + header + '<div class="article-content">' + mdHtml + '</div>';
    } else {
      container.innerHTML = backLink + '<pre class="txt-content">' + escapeHtml(text) + '</pre>';
    }
  } catch (e) {
    container.innerHTML = `<div style="color:var(--red)">Error loading ${item.name}: ${escapeHtml(e.message)}</div>`;
  }
}

function renderContactHtml() {
  const p = contentData?.profile || {};
  const github = p.github || 'https://github.com/yourusername';
  const mastodon = p.mastodon || 'https://mastodon.social/@yourusername';
  const discord = p.discord || 'https://discord.gg/yourinvite';
  const email = p.email || 'you@example.com';
  const githubLabel = github.replace(/^https?:\/\//, '');
  const mastodonLabel = mastodon.replace(/^https?:\/\//, '');
  return `
    <p style="color: var(--text-dim); margin-bottom: 16px;"># Get in Touch</p>
    <p style="margin-bottom: 16px;">Open to collaborations, bug bounty invites, security research opportunities, or just a good conversation.</p>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 30px;">
      <div>
        <p style="color: var(--text-dim); margin-bottom: 12px;"># Links</p>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <a href="${github}" target="_blank" style="color: var(--cyan); text-decoration: none; font-size: 13px;">&rarr; ${escapeHtml(githubLabel)}</a>
          <a href="${mastodon}" target="_blank" style="color: var(--cyan); text-decoration: none; font-size: 13px;">&rarr; ${escapeHtml(mastodonLabel)}</a>
          <a href="${discord}" target="_blank" style="color: var(--cyan); text-decoration: none; font-size: 13px;">&rarr; Discord</a>
          <a href="mailto:${email}" style="color: var(--cyan); text-decoration: none; font-size: 13px;">&rarr; ${escapeHtml(email)}</a>
        </div>
      </div>
      <div>
        <p style="color: var(--text-dim); margin-bottom: 12px;"># Send a message</p>
        <form class="term-form" onsubmit="submitContactForm(event)">
          <div class="field"><label>name</label><input type="text" name="name" placeholder="Your name" required></div>
          <div class="field"><label>email</label><input type="email" name="email" placeholder="you@example.com" required></div>
          <div class="field"><label>message</label><textarea name="message" placeholder="What's on your mind?" required></textarea></div>
          <button type="submit" class="term-btn">Send Message</button>
        </form>
        <p class="form-status" style="font-size: 12px; margin-top: 8px;"></p>
      </div>
    </div>
  `;
}

function renderWipHtml() {
  const dir = getDirData('~/work-in-progress');
  let html = '<div class="ls-grid" style="grid-template-columns: 1fr;">';
  if (dir && dir.items) {
    for (const item of dir.items) {
      const pct = parseInt(item.meta) || 0;
      const showProgress = item.showProgress !== false;
      const bar = showProgress ? `
        <div style="padding: 0 12px; margin-bottom: 12px;">
          <div style="height: 4px; background: var(--bg-light); border-radius: 2px; border: 1px solid var(--border);">
            <div style="width: ${pct}%; height: 100%; background: ${progressColor(pct, false)}; border-radius: 2px;"></div>
          </div>
          <p style="color: var(--text-dim); font-size: 11px; margin-top: 4px;">${item.desc || ''}</p>
        </div>
      ` : `
        <div style="padding: 0 12px 12px;">
          <p style="color: var(--text-dim); font-size: 11px;">${item.desc || ''}</p>
        </div>
      `;
      html += `
        <div class="ls-item file" title="${escapeHtml(item.name).replace(/"/g, '&quot;')}"><span class="icon">&#128679;</span><span class="name">${escapeHtml(item.name)}</span><span class="meta">${escapeHtml(item.meta || '')}</span></div>
        ${bar}
      `;
    }
  }
  html += '</div>';
  return html;
}

// ===================== WEB VIEW: DATA-DRIVEN SECTIONS =====================
// Everything below renders the portfolio (web) view straight from
// content.json, the same source the terminal's `ls`/`cat` commands read.
// Add, edit, or remove a proof-of-concept/repo/report/note/WIP item in
// content.json (or via admin.html) and both views update automatically —
// nothing needs to be hand-edited in index.html anymore.

// Recursively flattens a directory's items, including anything inside
// nested subfolders (subcategories). The terminal browses folders one
// level at a time (as a real filesystem would), but the web-view section
// grids show everything in the category regardless of how deep it's
// organized — so creating a subfolder to group related PoCs/notes/etc.
// doesn't hide them from the portfolio page.
function collectItems(dir, seen = new Set()) {
  if (!dir || !dir.items) return [];
  let out = [];
  for (const item of dir.items) {
    if (item.type === 'dir') {
      const subPath = item.path;
      if (!subPath || seen.has(subPath)) continue; // guard against cycles
      seen.add(subPath);
      const subDir = getDirData(subPath);
      if (subDir) out = out.concat(collectItems(subDir, seen));
    } else {
      out.push(item);
    }
  }
  return out;
}

function viewerAttrs(item) {
  const src = item.src || '';
  const format = item.format || 'txt';
  const title = item.title || item.name;
  const date = item.date || '';
  const repoUrl = item.repoUrl || '';
  return `data-content="${src}" data-format="${format}" data-title="${escapeHtml(title)}" data-date="${escapeHtml(date)}" data-repo="${escapeHtml(repoUrl)}" onclick="openContentViewer(this); return false;"`;
}

function renderCardGrid(dir) {
  const footerMode = dir.cardFooter || 'tags'; // 'tags' | 'progress'
  return collectItems(dir).map((item, i) => {
    const isLink = item.type === 'link';
    const extraAttrs = isLink ? 'target="_blank"' : viewerAttrs(item);
    const repoBadge = (!isLink && item.repoUrl) ? `<span class="card-date" title="Full writeup lives on GitHub">↗ GitHub</span>` : '';
    const dateBadge = repoBadge || ((item.date && footerMode !== 'progress') ? `<span class="card-date">${escapeHtml(item.date)}</span>` : '');
    let footer;
    if (footerMode === 'progress' && item.showProgress !== false) {
      const pct = parseInt(item.meta) || 0;
      const color = progressColor(pct, true);
      footer = `<div class="wip-bar"><div class="wip-fill" style="width: ${pct}%; background: ${color};"></div></div><div class="wip-meta"><span>Progress</span><span>${pct}%</span></div>`;
    } else if (footerMode === 'progress') {
      footer = '';
    } else {
      footer = `<div class="card-tags">${(item.tags || []).map(t => `<span class="tag ${tagWebClass(t, item)}">${escapeHtml(t)}</span>`).join('')}</div>`;
    }
    return `
    <a href="${isLink ? item.url : '#'}" ${extraAttrs} class="card fade-in" style="animation-delay: ${(i * 0.05).toFixed(2)}s">
      <div class="card-header">
        <div class="card-icon ${tintClass(item.color)}">${item.icon || (isLink ? '📦' : '📄')}</div>
        ${dateBadge}
      </div>
      <h3>${escapeHtml(item.title || item.name)}</h3>
      <p>${escapeHtml(item.desc || '')}</p>
      ${footer}
    </a>`;
  }).join('');
}

function renderReportsList(dir) {
  return collectItems(dir).map((item, i) => `
    <a href="#" ${viewerAttrs(item)} class="report-item fade-in" style="animation-delay: ${(i * 0.05).toFixed(2)}s">
      <span class="report-date">${escapeHtml(item.date || '')}</span>
      <span class="report-title">${escapeHtml(item.title || item.name)}</span>
      <span class="report-arrow">→</span>
    </a>
  `).join('');
}

function renderNotesGrid(dir) {
  return collectItems(dir).map((item, i) => `
    <a href="#" ${viewerAttrs(item)} class="note-card fade-in" style="animation-delay: ${(i * 0.05).toFixed(2)}s">
      <div class="note-date">${escapeHtml(item.date || '')}</div>
      <div class="note-text">${escapeHtml(item.desc || '')}</div>
      <div class="note-tags">${(item.tags || []).map(t => `<span class="tag ${tagWebClass(t, item)}">${escapeHtml(t)}</span>`).join('')}</div>
    </a>
  `).join('');
}

const CARD_STYLE_RENDERERS = {
  grid: renderCardGrid,
  reportsList: renderReportsList,
  notesGrid: renderNotesGrid
};

// Any direct child of ~ that is a folder with a "sectionId" is treated as a
// web-page section — this list isn't hardcoded, so a brand-new category
// added through admin.html (or by hand) is picked up automatically. It
// only needs a matching mount element (see "mountId") somewhere in
// index.html to actually appear on the page; until then it still works
// fine in the terminal, it just has no web-view home yet.
function discoverSections() {
  const home = getDirData('~');
  if (!home || !home.items) return [];
  return home.items
    .filter(i => i.type === 'dir' && i.path)
    .map(i => getDirData(i.path))
    .filter(dir => dir && dir.sectionId && dir.mountId);
}

function renderWebSections() {
  if (!contentData) return;
  for (const dir of discoverSections()) {
    const mountEl = document.getElementById(dir.mountId);
    if (!mountEl) continue;
    const renderFn = CARD_STYLE_RENDERERS[dir.cardStyle] || renderCardGrid;
    try {
      mountEl.innerHTML = renderFn(dir);
    } catch (e) {
      console.error('Failed to render section', dir.sectionId, e);
      mountEl.innerHTML = `<p style="color:var(--web-red)">Couldn't render this section, check content.json.</p>`;
    }
    const setText = (idSuffix, val) => {
      const el = document.getElementById(dir.sectionId + idSuffix);
      if (el && val) el.textContent = val;
    };
    setText('SectionTag', dir.sectionTag);
    setText('SectionHeading', dir.sectionHeading);
    setText('SectionDesc', dir.sectionDesc);
  }
  bindProfile();
  renderAboutSection();
}

function setFormStatus(el, msg, kind) {
  if (!el) return;
  el.textContent = msg;
  el.className = 'form-status' + (kind ? ' ' + kind : '');
}

// Discord webhooks expect a JSON POST, not a native form submission, so
// the form's default action is intercepted here rather than posted
// directly. Shared by both the web-view contact form and the terminal's
// embedded copy of it.
async function submitContactForm(e) {
  e.preventDefault();
  const form = e.target;
  const webhookUrl = contentData?.profile?.discordWebhookUrl;
  const statusEl = form.parentElement.querySelector('.form-status');
  const name = (form.querySelector('[name="name"]')?.value || '').trim();
  const email = (form.querySelector('[name="email"]')?.value || '').trim();
  const message = (form.querySelector('[name="message"]')?.value || '').trim();
  const submitBtn = form.querySelector('button[type="submit"]');

  if (!webhookUrl) {
    setFormStatus(statusEl, "This form isn't connected yet, add a Discord webhook URL in the content manager.", 'error');
    return;
  }

  const originalLabel = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending...'; }
  setFormStatus(statusEl, '', '');

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: 'New portfolio contact message',
          color: 0x4d94ff,
          fields: [
            { name: 'Name', value: name || '(not provided)', inline: true },
            { name: 'Email', value: email || '(not provided)', inline: true },
            { name: 'Message', value: (message || '(empty)').slice(0, 1024) }
          ],
          timestamp: new Date().toISOString()
        }]
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    form.reset();
    setFormStatus(statusEl, "Message sent, thanks for reaching out! I'll get back to you soon.", 'success');
  } catch (err) {
    setFormStatus(statusEl, "Couldn't send that, please try emailing directly instead.", 'error');
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
  }
}

// About card (whoami / interests / skills / current focus) — same data
// source as the terminal's `whoami` command, so editing it in one place
// (via admin.html) keeps both views in sync instead of hand-editing two
// separate hardcoded copies.
function renderAboutSection() {
  const a = contentData?.about;
  if (!a) return;
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('aboutWhoami', el => { if (a.whoami) el.textContent = a.whoami; });
  set('aboutInterests', el => { if (a.interests) el.textContent = a.interests; });
  set('aboutFocus', el => { if (a.currentFocus) el.textContent = a.currentFocus; });
  set('aboutSkills', el => {
    if (!Array.isArray(a.skills)) return;
    el.innerHTML = a.skills.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join('');
  });
}

function bindProfile() {
  const p = contentData?.profile;
  if (!p) return;
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('heroBadge', el => { if (p.badge) el.textContent = p.badge; });
  set('heroSub', el => { if (p.heroSub) el.textContent = p.heroSub; });
  set('heroGithubLink', el => { if (p.github) el.href = p.github; });
  set('contactGithubLink', el => { if (p.github) { el.href = p.github; const t = el.querySelector('.link-label'); if (t) t.textContent = p.github.replace(/^https?:\/\//, ''); } });
  set('contactMastodonLink', el => { if (p.mastodon) { el.href = p.mastodon; const t = el.querySelector('.link-label'); if (t) t.textContent = p.mastodon.replace(/^https?:\/\//, ''); } });
  set('contactDiscordLink', el => { if (p.discord) { el.href = p.discord; const t = el.querySelector('.link-label'); if (t) t.textContent = 'Discord'; } });
  set('contactEmailLink', el => { if (p.email) { el.href = 'mailto:' + p.email; const t = el.querySelector('.link-label'); if (t) t.textContent = p.email; } });
  set('contactLocationLabel', el => { if (p.location) el.textContent = p.location; });
  set('contactForm', el => { el.onsubmit = submitContactForm; });
}

// ===================== NAVIGATION =====================
function openFolder(path) {
  if (isTyping) return;
  const target = resolvePath('~', path);
  const dir = getDirData(target);
  if (!dir || dir.type !== 'dir') return;
  const existing = openTabs.find(t => t.path === target);
  if (existing) { switchTab(existing.id); return; }
  const dirName = target.split('/').pop() || '~';
  const icon = target === '~' ? '🏠' : '📁';
  const label = target === '~' ? '~' : dirName;
  const tabId = createTabForPath(target, label, icon);
  let staticHtml = dir.render === 'wip' ? renderWipHtml() : renderDirectory(target);
  createPane(tabId, target, staticHtml);
  switchTab(tabId);
}

function navigateBack(path) {
  openFolder(path);
}

// ===================== TYPEWRITER =====================
function typeCommand(cmd, path, paneId, onDone) {
  if (isTyping) return;
  isTyping = true;
  const log = document.getElementById('session-' + paneId);
  if (!log) { isTyping = false; if (onDone) onDone(); return; }
  const line = document.createElement('div');
  line.className = 'log-cmd';
  const uid = 'type-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  line.innerHTML = `${getPrompt(path)} <span id="${uid}"></span><span class="type-cursor"></span>`;
  log.appendChild(line);
  const textEl = document.getElementById(uid);
  let i = 0;
  const speed = 25 + Math.random() * 35;
  function typeChar() {
    if (i < cmd.length) {
      textEl.textContent += cmd.charAt(i);
      i++;
      const body = document.getElementById('terminalBody');
      if (body) body.scrollTop = body.scrollHeight;
      setTimeout(typeChar, speed);
    } else {
      setTimeout(() => {
        line.querySelector('.type-cursor')?.remove();
        isTyping = false;
        if (onDone) onDone();
      }, 250);
    }
  }
  typeChar();
}

// ===================== COMMANDS =====================
const FORTUNES = [
  "The only way to do great work is to love what you do. — Steve Jobs",
  "Stay hungry, stay foolish. — Stewart Brand",
  "With great power comes great responsibility. — Uncle Ben",
  "It's not a bug, it's a feature.",
  "There are 10 types of people: those who understand binary and those who don't.",
  "RTFM",
  "Have you tried turning it off and on again?",
  "Hack the planet!",
  "Trust but verify.",
  "The best time to plant a tree was 20 years ago. The second best time is now."
];

function showHelp(paneId) {
  const helpText = `Available commands:
  <span style="color:var(--cyan)">ls</span> [path]       List directory contents
  <span style="color:var(--cyan)">cd</span> &lt;path&gt;       Change directory (opens new tab)
  <span style="color:var(--cyan)">cat</span> &lt;file&gt;      View file contents
  <span style="color:var(--cyan)">curl</span> [-L] &lt;url&gt; Fetch / open URL in new tab
  <span style="color:var(--cyan)">pwd</span>             Print working directory
  <span style="color:var(--cyan)">clear</span>           Clear terminal output
  <span style="color:var(--cyan)">whoami</span>          About the owner
  <span style="color:var(--cyan)">echo</span> &lt;text&gt;     Print text
  <span style="color:var(--cyan)">date</span>            Show current date and time
  <span style="color:var(--cyan)">exit</span>            Close current tab
  <span style="color:var(--cyan)">help</span>            Show this help message

Tip: Click any file or folder to run the corresponding command.
`;
  appendLog(paneId, `<pre style="background:none;border:none;padding:0;margin:0;">${helpText}</pre>`);
}

// After a long file's contents, repeat the current directory's listing so
// scrolling down leads back to something navigable, instead of the user
// having to scroll all the way back up to the static listing at the top.
// Only makes sense for files — cd (folders) and links navigate away
// instead of dumping long content inline, so they don't need this.
function renderDirFooter(path) {
  const dir = getDirData(path);
  if (!dir || dir.type !== 'dir') return '';
  return `
    <div style="margin-top:28px; padding-top:18px; border-top:1px solid var(--border);">
      <p style="color:var(--text-dim); font-size:12px; margin-bottom:10px;">${getPrompt(path)} <span style="color:var(--text)">ls</span></p>
      ${renderDirectory(path)}
    </div>
  `;
}

function lsCommand(args, currentPath, paneId) {
  let target = currentPath;
  let showAll = false;
  let longFormat = false;
  for (const arg of args) {
    if (arg.startsWith('-')) {
      if (arg.includes('a')) showAll = true;
      if (arg.includes('l')) longFormat = true;
    } else {
      target = resolvePath(currentPath, arg);
    }
  }
  const dir = getDirData(target);
  if (!dir || dir.type !== 'dir') {
    appendLog(paneId, `ls: cannot access '${args[0] || target}': No such file or directory`, true);
    return;
  }
  if (longFormat) {
    const items = showAll ? [{ name: '.', type: 'dir', size: '4.0K' }, { name: '..', type: 'dir', size: '4.0K' }, ...dir.items] : dir.items;
    const total = items.length * 4 + 8;
    let html = `<div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">total ${total}</div>`;
    html += `<div style="color:var(--text-dim);font-size:12px;line-height:1.8;">`;
    for (const item of items) {
      const perms = item.type === 'dir' ? 'drwxr-xr-x' : item.type === 'exec' ? '-rwxr-xr-x' : '-rw-r--r--';
      const size = item.size || '4.0K';
      const color = item.type === 'dir' ? 'var(--cyan)' : item.type === 'exec' ? 'var(--green)' : 'var(--text)';
      html += `${perms}  1 user user ${size} <span style="color:var(--text-dim)">Aug  1 23:35</span> <span style="color:${color}">${item.name}</span><br>`;
    }
    html += `</div>`;
    appendLog(paneId, html);
  } else {
    let html = `<div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">total ${(dir.items.length * 4 + 8)}</div>`;
    html += renderDirectory(target);
    appendLog(paneId, html);
  }
}

function cdCommand(args, currentPath, paneId) {
  const target = args[0] ? resolvePath(currentPath, args[0]) : '~';
  const dir = getDirData(target);
  if (!dir || dir.type !== 'dir') {
    appendLog(paneId, `bash: cd: ${args[0] || target}: No such file or directory`, true);
    return;
  }
  openFolder(target);
}

async function catCommand(args, currentPath, paneId) {
  if (!args[0]) {
    appendLog(paneId, 'cat: missing file operand', true);
    return;
  }
  const target = resolvePath(currentPath, args[0]);
  const item = findItem(target);
  if (!item) {
    appendLog(paneId, `cat: ${args[0]}: No such file or directory`, true);
    return;
  }
  if (item.type === 'dir') {
    appendLog(paneId, `cat: ${args[0]}: Is a directory`, true);
    return;
  }
  if (item.type === 'link' && item.url) {
    appendLog(paneId, `Opening <span style="color:var(--cyan)">${escapeHtml(item.url)}</span> in a new tab...`);
    setTimeout(() => window.open(item.url, '_blank'), 300);
    return;
  }
  if (item.render === 'contact') {
    appendLog(paneId, renderContactHtml());
    return;
  }
  if (item.render === 'wip') {
    appendLog(paneId, renderWipHtml());
    return;
  }
  const format = item.format || 'txt';
  const src = item.src;
  if (format === 'pdf') {
    appendLog(paneId, `<embed src="${src}" type="application/pdf" class="pdf-content">` + renderDirFooter(currentPath));
    return;
  }
  if (!src) {
    appendLog(paneId, `cat: ${args[0]}: No content source configured`, true);
    return;
  }
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    let header = '';
    if (item.date || (item.tags && item.tags.length) || item.repoUrl) {
      if (item.tags && item.tags.length) {
        header += '<div class="tags">' + item.tags.map(t =>
          `<span class="tag ${tagClass(t)}">${escapeHtml(t)}</span>`
        ).join('') + '</div>';
      }
      if (item.date) header += `<p style="color:var(--text-dim);margin-top:8px;">${escapeHtml(item.date)}</p>`;
      if (item.repoUrl) header += `<p style="margin-top:8px;"><a href="${escapeHtml(item.repoUrl)}" target="_blank" style="color:var(--cyan);">↗ View on GitHub</a></p>`;
      header = '<div style="margin-bottom:16px;">' + header + '</div>';
    }
    if (format === 'md') {
      const fixedText = fixMarkdownImagePaths(text, src);
      const mdHtml = safeMarkdownParse(fixedText);
      appendLog(paneId, header + '<div class="article-content">' + mdHtml + '</div>' + renderDirFooter(currentPath));
    } else {
      appendLog(paneId, '<pre class="txt-content">' + escapeHtml(text) + '</pre>' + renderDirFooter(currentPath));
    }
  } catch (e) {
    appendLog(paneId, `<span style="color:var(--red)">Error loading ${args[0]}: ${escapeHtml(e.message)}</span>`, true);
  }
}
function curlCommand(args, paneId) {
  let url = '';
  if (args[0] === '-L') url = args[1];
  else url = args[0];
  if (!url) {
    appendLog(paneId, 'curl: missing URL', true);
    return;
  }
  appendLog(paneId, `Opening <span style="color:var(--cyan)">${escapeHtml(url)}</span> in a new tab...`);
  setTimeout(() => window.open(url, '_blank'), 300);
}


function pwdCommand(currentPath, paneId) {
  appendLog(paneId, currentPath);
}

function clearCommand(paneId) {
  const log = document.getElementById('session-' + paneId);
  if (log) log.innerHTML = '';
}

function whoamiCommand(paneId) {
  const a = contentData?.about;
  if (!a) {
    appendLog(paneId, 'Security researcher & developer. I find vulnerabilities, build tools, and write about it.');
    return;
  }
  const skills = Array.isArray(a.skills) ? a.skills.join(', ') : '';
  const html = `
    <p>${escapeHtml(a.whoami || '')}</p>
    ${a.interests ? `<p style="margin-top:10px;"><span style="color:var(--text-dim);">interests:</span> ${escapeHtml(a.interests)}</p>` : ''}
    ${skills ? `<p style="margin-top:10px;"><span style="color:var(--text-dim);">skills:</span> ${escapeHtml(skills)}</p>` : ''}
    ${a.currentFocus ? `<p style="margin-top:10px;"><span style="color:var(--text-dim);">currently:</span> ${escapeHtml(a.currentFocus)}</p>` : ''}
  `;
  appendLog(paneId, html);
}

function echoCommand(args, paneId) {
  appendLog(paneId, escapeHtml(args.join(' ')));
}

function dateCommand(paneId) {
  appendLog(paneId, new Date().toString());
}

// ===================== EASTER EGGS =====================
function sudoCommand(args, paneId) {
  const responses = [
    "sudo: permission denied (this is a browser, not a real system)",
    "Nice try. But you're not root here.",
    "sudo: user is not in the sudoers file. This incident will be reported.",
    "You don't have permission to do that. Try asking nicely.",
    "🚫 Access denied. Go touch grass."
  ];
  appendLog(paneId, responses[Math.floor(Math.random() * responses.length)], true);
}

function rmCommand(args, paneId) {
  const target = args.join(' ');
  if (target.includes('-rf /') || target.includes('-rf /*')) {
    appendLog(paneId, `<span style="color:var(--red)">rm: cannot remove '/': Operation not permitted</span><br><span style="color:var(--amber)">...Just kidding, I wouldn't let you do that anyway. This portfolio is read-only.</span>`, true);
  } else if (target.includes('~') || target.includes('-rf')) {
    appendLog(paneId, `<span style="color:var(--red)">rm: cannot remove '${escapeHtml(target)}': This portfolio is read-only</span><br><span style="color:var(--amber)">Nice try though. Your files are safe with me.</span>`, true);
  } else {
    appendLog(paneId, `rm: cannot remove '${escapeHtml(target || '')}': Permission denied`, true);
  }
}

function hackCommand(paneId) {
  appendLog(paneId, `<span style="color:var(--green)">Initializing mainframe bypass...</span><br>[<span style="color:var(--cyan)">==========</span>] 100%<br><span style="color:var(--red)">Access denied.</span> This is a portfolio, not a CTF.<br><span style="color:var(--text-dim)">Try <code>help</code> for actual commands.</span>`);
}

function coffeeCommand(paneId) {
  appendLog(paneId, `☕ <span style="color:var(--amber)">Brewing a fresh cup of coffee...</span><br><span style="color:var(--green)">Done.</span> Caffeine levels optimal. Ready to hack.`);
}

function neofetchCommand(paneId) {
  const ascii = `
       <span style="color:var(--cyan)">\\</span>   <span style="color:var(--cyan)">,-.</span>
        <span style="color:var(--cyan)">\\</span> <span style="color:var(--cyan)">_/</span>  <span style="color:var(--cyan)">)</span>
       <span style="color:var(--cyan)">/</span>  <span style="color:var(--cyan)">&#96;</span>  <span style="color:var(--cyan)">)</span>
      <span style="color:var(--cyan)">(</span>  <span style="color:var(--cyan)">_/-.</span><span style="color:var(--cyan)">.</span>
       <span style="color:var(--cyan)">\\</span>,<span style="color:var(--cyan)">\\</span> <span style="color:var(--cyan)">(</span>
        <span style="color:var(--cyan)">//</span> <span style="color:var(--cyan)">\\</span>
       <span style="color:var(--cyan)">((</span>  <span style="color:var(--cyan)">\\</span>
        <span style="color:var(--cyan)">\\</span>  <span style="color:var(--cyan)">\\</span>
         <span style="color:var(--cyan)">\\</span>  <span style="color:var(--cyan)">\\</span>
          <span style="color:var(--cyan)">\\</span>  <span style="color:var(--cyan)">\\</span>
           <span style="color:var(--cyan)">\\</span>  <span style="color:var(--cyan)">\\</span>
            <span style="color:var(--cyan)">\\</span>  <span style="color:var(--cyan)">\\</span>
             <span style="color:var(--cyan)">\\</span>  <span style="color:var(--cyan)">\\</span>
              <span style="color:var(--cyan)">\\</span>  <span style="color:var(--cyan)">\\</span>`;
  const info = `
<span style="color:var(--cyan)">user@portfolio</span>
<span style="color:var(--text-dim)">----------------</span>
<span style="color:var(--cyan)">OS:</span> PortfolioOS 1.0.0-terminal
<span style="color:var(--cyan)">Host:</span> Browser Engine (V8)
<span style="color:var(--cyan)">Kernel:</span> HTML5 + CSS3 + ES2024
<span style="color:var(--cyan)">Uptime:</span> Since you opened this tab
<span style="color:var(--cyan)">Shell:</span> bash-portfolio
<span style="color:var(--cyan)">Resolution:</span> ${window.innerWidth}x${window.innerHeight}
<span style="color:var(--cyan)">DE:</span> Terminal
<span style="color:var(--cyan)">WM:</span> CSS Flexbox
<span style="color:var(--cyan)">Theme:</span> Dark [Custom]
<span style="color:var(--cyan)">Icons:</span> Emoji
<span style="color:var(--cyan)">Terminal:</span> portfolio-term
<span style="color:var(--cyan)">CPU:</span> Your brain
<span style="color:var(--cyan)">GPU:</span> GPU accelerated compositing
<span style="color:var(--cyan)">Memory:</span> Enough
<span style="color:var(--cyan)">Coffee:</span> 99%`;
  appendLog(paneId, `<div style="display:flex;gap:20px;flex-wrap:wrap;"><div class="ascii-art">${ascii}</div><div style="line-height:1.6;font-size:12px;">${info}</div></div>`);
}

function matrixCommand(paneId) {
  appendLog(paneId, `<span style="color:var(--green)">Wake up, Neo...</span><br><span style="color:var(--green)">The Matrix has you...</span><br><span style="color:var(--green)">Follow the white rabbit.</span><br><br><span style="font-size:20px">🐇</span>`);
}

function helloCommand(paneId) {
  appendLog(paneId, `<span style="color:var(--text-dim)">Hello, friend. Hello, friend? That's lame.</span><br>Maybe I should give you a name...<br>But that's a slippery slope.<br>You're only in my head. We have to remember that.`);
}

function fortyTwoCommand(paneId) {
  appendLog(paneId, `<span style="color:var(--cyan);font-size:16px;font-weight:bold;">42</span><br><span style="color:var(--text-dim)">The answer to life, the universe, and everything.</span>`);
}

function slCommand(paneId) {
  const train = `
      <span style="color:var(--cyan)">___</span>
     <span style="color:var(--cyan)">/ _ \\</span>_________<span style="color:var(--cyan)">_______</span>
    <span style="color:var(--cyan)">/ /_\\</span> <span style="color:var(--cyan)">__</span>  <span style="color:var(--cyan)">__</span>  <span style="color:var(--cyan)">__</span>  <span style="color:var(--cyan)">__</span>
   <span style="color:var(--cyan)">/ ___/</span>  <span style="color:var(--cyan)">\\</span>  <span style="color:var(--cyan)">\\</span>  <span style="color:var(--cyan)">\\</span>  <span style="color:var(--cyan)">\\</span>
  <span style="color:var(--cyan)">/_/___</span>  <span style="color:var(--cyan)">/__/</span>  <span style="color:var(--cyan)">/__/</span>  <span style="color:var(--cyan)">/__/</span>  <span style="color:var(--cyan)">/__/</span>
  <span style="color:var(--cyan)">(____/|____/|____/|____/|____/</span>
   <span style="color:var(--amber)">o o o o o o o o o o o o o o o</span>
    <span style="color:var(--amber)">o o o o o o o o o o o o o</span>`;
  appendLog(paneId, `<div class="ascii-art">${train}</div><div style="color:var(--text-dim);margin-top:8px;">Choo choo! You found the steam locomotive.</div>`);
}

function cowsayCommand(args, paneId) {
  const text = args.join(' ') || 'Moo!';
  const len = Math.max(text.length, 3);
  const top = ' ' + '_'.repeat(len + 2);
  const bottom = ' ' + '-'.repeat(len + 2);
  const line = `< ${text} >`;
  const cow = `
${top}
${line}
${bottom}
        \\   ^__^
         \\  (oo)\\_______
            (__)\\       )\\/\\
                ||----w |
                ||     ||`;
  appendLog(paneId, `<pre style="background:none;border:none;padding:0;margin:0;color:var(--text);font-size:12px;">${escapeHtml(cow)}</pre>`);
}

function fortuneCommand(paneId) {
  appendLog(paneId, `<span style="color:var(--text-dim)">🥠 ${FORTUNES[Math.floor(Math.random() * FORTUNES.length)]}</span>`);
}

function unameCommand(args, paneId) {
  appendLog(paneId, `PortfolioOS 1.0.0-terminal #1 SMP PREEMPT_DYNAMIC<br>Built with HTML, CSS, and a lot of caffeine`);
}

function rebootCommand(paneId) {
  appendLog(paneId, `<span style="color:var(--red)">System reboot not available in browser environment.</span><br><span style="color:var(--text-dim)">Try refreshing the page if you're feeling adventurous.</span>`);
}

function unknownCommand(cmd, paneId) {
  appendLog(paneId, `bash: ${escapeHtml(cmd)}: command not found`, true);
}

// ===================== COMMAND ROUTER =====================
function runCmd(commandStr) {
  const tab = openTabs.find(t => t.id === activeTab);
  const paneId = tab?.id || activeTab;
  const path = tab?.path || '~';
  if (!isTyping) {
    typeCommand(commandStr, path, paneId, () => {
      executeCommand(commandStr, paneId, path, true);
    });
  } else {
    executeCommand(commandStr, paneId, path);
  }
}

// Entry points used by ls-item clicks (see renderDirectory) — they build
// the command string here, in plain JS, where shellQuote can safely wrap
// a name containing spaces/quotes without any HTML-attribute escaping to
// worry about. This is what actually fixes names like a GitHub-sourced
// report title ("OWASP University Auth Bypass Report") that would
// otherwise get split into multiple arguments and fail to resolve.
function catFileInTerminal(path) { runCmd('cat ' + shellQuote(path)); }
function openLinkInTerminal(url) { runCmd('curl -L ' + shellQuote(url)); }

function executeCommand(rawCmd, paneId, path, wasTyped) {
  const parts = tokenizeCommand(rawCmd.trim());
  const cmd = parts[0];
  const args = parts.slice(1);
  if (!wasTyped) appendCmd(paneId, rawCmd, path);
  switch(cmd) {
    case 'help': showHelp(paneId); break;
    case 'ls': lsCommand(args, path, paneId); break;
    case 'cd': cdCommand(args, path, paneId); break;
    case 'cat': catCommand(args, path, paneId); break;
    case 'pwd': pwdCommand(path, paneId); break;
    case 'clear': clearCommand(paneId); break;
    case 'whoami': whoamiCommand(paneId); break;
    case 'echo': echoCommand(args, paneId); break;
    case 'date': dateCommand(paneId); break;
    case 'exit': closeTab(activeTab); break;
    case 'sudo': sudoCommand(args, paneId); break;
    case 'rm': rmCommand(args, paneId); break;
    case 'hack': hackCommand(paneId); break;
    case 'coffee': coffeeCommand(paneId); break;
    case 'neofetch': neofetchCommand(paneId); break;
    case 'matrix': matrixCommand(paneId); break;
    case 'hello': helloCommand(paneId); break;
    case '42': fortyTwoCommand(paneId); break;
    case 'sl': slCommand(paneId); break;
    case 'cowsay': cowsayCommand(args, paneId); break;
    case 'fortune': fortuneCommand(paneId); break;
    case 'uname': unameCommand(args, paneId); break;
    case 'reboot': rebootCommand(paneId); break;
    case 'curl': curlCommand(args, paneId); break;
    default: unknownCommand(cmd, paneId);
  }
}

// ===================== INPUT HANDLING =====================
function setupInputDelegation() {
  document.getElementById('terminalBody').addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('cmd-input')) return;
    const paneId = e.target.dataset.pane;
    const path = e.target.dataset.path;
    if (e.key === 'Enter') {
      const cmd = e.target.value.trim();
      if (!cmd) return;
      e.target.value = '';
      executeCommand(cmd, paneId, path);
      addToHistory(paneId, cmd);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateHistory(paneId, 'up', e.target);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateHistory(paneId, 'down', e.target);
    }
  });
}

// ===================== COMMAND HISTORY =====================
function addToHistory(paneId, cmd) {
  if (!commandHistory[paneId]) commandHistory[paneId] = [];
  const last = commandHistory[paneId][commandHistory[paneId].length - 1];
  if (last !== cmd) commandHistory[paneId].push(cmd);
  historyIndex[paneId] = commandHistory[paneId].length;
}

function navigateHistory(paneId, direction, input) {
  const hist = commandHistory[paneId];
  if (!hist || hist.length === 0) return;
  if (historyIndex[paneId] === undefined) historyIndex[paneId] = hist.length;
  if (direction === 'up') {
    if (historyIndex[paneId] > 0) {
      historyIndex[paneId]--;
      input.value = hist[historyIndex[paneId]];
    }
  } else {
    historyIndex[paneId]++;
    if (historyIndex[paneId] >= hist.length) {
      historyIndex[paneId] = hist.length;
      input.value = '';
    } else {
      input.value = hist[historyIndex[paneId]];
    }
  }
}

// ===================== RESIZER =====================
function setupResizer() {
  let isResizing = false;
  const resizer = document.getElementById('resizer');
  const splitContainer = document.querySelector('.split-container');
  if (!resizer || !splitContainer) return;
  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const rect = splitContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = (x / rect.width) * 100;
    if (isWebMode) {
      const terminalWidth = 100 - percent;
      if (terminalWidth < 12) {
        splitContainer.classList.remove('terminal-visible');
        splitContainer.style.gridTemplateColumns = '100% 0px';
        resizer.style.left = 'calc(100% - 4px)';
      } else {
        const clampedTerminal = Math.max(25, Math.min(50, terminalWidth));
        const webWidth = 100 - clampedTerminal;
        splitContainer.classList.add('terminal-visible');
        splitContainer.style.gridTemplateColumns = webWidth + '% 1fr';
        resizer.style.left = webWidth + '%';
      }
    } else {
      if (percent > 75) {
        splitContainer.classList.add('right-collapsed');
        splitContainer.style.gridTemplateColumns = '';
        resizer.style.left = '';
      } else {
        splitContainer.classList.remove('right-collapsed');
        const clamped = Math.max(50, Math.min(75, percent));
        splitContainer.style.gridTemplateColumns = clamped + '% 1fr';
        resizer.style.left = clamped + '%';
      }
    }
  });
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
}

// ===================== BROWSER DETECTION =====================
function getBrowserName() {
  const ua = navigator.userAgent;
  if (ua.indexOf('Firefox') !== -1) return 'Firefox';
  if (ua.indexOf('Safari') !== -1 && ua.indexOf('Chrome') === -1) return 'Safari';
  if (ua.indexOf('Edg') !== -1) return 'Edge';
  if (ua.indexOf('OPR') !== -1 || ua.indexOf('Opera') !== -1) return 'Opera';
  if (ua.indexOf('Chrome') !== -1) return 'Chrome';
  return 'your browser';
}

function isChromium() {
  const ua = navigator.userAgent;
  return (/Chrome|Chromium|Edg|OPR/.test(ua) && ua.indexOf('Firefox') === -1);
}

function showBrowserShield() {
  if (isChromium()) return;
  const name = getBrowserName();
  const shield = document.getElementById('browser-shield');
  const nameEl = document.getElementById('browser-name');
  const metricsShield = document.getElementById('metrics-shield');
  const metricsNameEl = document.getElementById('metrics-browser-name');
  if (shield) {
    shield.style.display = '';
    if (nameEl) nameEl.textContent = name;
  }
  if (metricsShield) {
    metricsShield.style.display = '';
    if (metricsNameEl) metricsNameEl.textContent = name;
  }
  reconLog('Browser shield active: ' + name + ' detected (non-Chromium)', 'green');
  metricsLog('Browser shield active: ' + name + ' detected (non-Chromium)', 'green');
}

// ===================== RECON / FINGERPRINTING =====================
function getOS() {
  const ua = navigator.userAgent;
  if (ua.indexOf('Win') !== -1) return 'Windows';
  if (ua.indexOf('Mac') !== -1) return 'macOS';
  if (ua.indexOf('Linux') !== -1) return 'Linux';
  if (ua.indexOf('Android') !== -1) return 'Android';
  if (ua.indexOf('like Mac') !== -1) return 'iOS';
  return 'Unknown';
}

function getBrowser() {
  const ua = navigator.userAgent;
  if (ua.indexOf('Firefox') !== -1) return 'Firefox';
  if (ua.indexOf('SamsungBrowser') !== -1) return 'Samsung';
  if (ua.indexOf('Opera') !== -1 || ua.indexOf('OPR') !== -1) return 'Opera';
  if (ua.indexOf('Trident') !== -1) return 'IE';
  if (ua.indexOf('Edge') !== -1) return 'Edge';
  if (ua.indexOf('Chrome') !== -1) return 'Chrome';
  if (ua.indexOf('Safari') !== -1) return 'Safari';
  return 'Unknown';
}

function getCanvasFingerprint() {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 200, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('Fingerprint: ' + navigator.userAgent, 2, 2);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('Canvas @ ' + new Date().toISOString(), 4, 14);
    return canvas.toDataURL().slice(-32);
  } catch (e) {
    return 'blocked';
  }
}

function getWebGLInfo() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return { vendor: 'Not available', renderer: 'Not available' };
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      return {
        vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
      };
    }
    return { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER) };
  } catch (e) {
    return { vendor: 'blocked', renderer: 'blocked' };
  }
}

function getLocalIPs(callback) {
  try {
    const RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
    if (!RTCPeerConnection) { callback('Not available'); return; }
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('');
    pc.createOffer().then(o => pc.setLocalDescription(o));
    pc.onicecandidate = (ice) => {
      if (!ice || !ice.candidate || !ice.candidate.candidate) {
        callback('Not available');
        return;
      }
      const ipMatch = /([0-9]{1,3}\.){3}[0-9]{1,3}/.exec(ice.candidate.candidate);
      callback(ipMatch ? ipMatch[0] : 'Not available');
      pc.onicecandidate = null;
    };
    setTimeout(() => callback('Timeout'), 3000);
  } catch (e) {
    callback('Error');
  }
}

async function getPublicIP() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    return data.ip;
  } catch (e) {
    return 'Unavailable';
  }
}

function getPlugins() {
  try {
    const plugins = navigator.plugins;
    if (!plugins || plugins.length === 0) return 'None detected';
    return Array.from(plugins).slice(0, 5).map(p => p.name).join(', ') + (plugins.length > 5 ? ` +${plugins.length - 5} more` : '');
  } catch (e) { return 'Blocked'; }
}

function getMIMETypes() {
  try {
    const types = navigator.mimeTypes;
    if (!types || types.length === 0) return 'None';
    const common = [];
    for (let i = 0; i < Math.min(types.length, 8); i++) {
      common.push(types[i].type);
    }
    return common.join(', ') + (types.length > 8 ? ` +${types.length - 8}` : '');
  } catch (e) { return 'Blocked'; }
}

function checkFeature(name) {
  try {
    switch(name) {
      case 'bluetooth': return 'bluetooth' in navigator ? 'Available' : 'No';
      case 'usb': return 'usb' in navigator ? 'Available' : 'No';
      case 'webrtc': return !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection) ? 'Yes' : 'No';
      case 'wasm': return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function' ? 'Yes' : 'No';
      case 'sw': return 'serviceWorker' in navigator ? 'Yes' : 'No';
      case 'notifications': return 'Notification' in window ? Notification.permission : 'No';
      case 'clipboard': return 'clipboard' in navigator ? 'Yes' : 'No';
      case 'gamepad': return 'getGamepads' in navigator ? 'Yes' : 'No';
      case 'vr': return 'getVRDisplays' in navigator || 'xr' in navigator ? 'Yes' : 'No';
      case 'pdf': return navigator.pdfViewerEnabled !== undefined ? (navigator.pdfViewerEnabled ? 'Built-in' : 'Plugin') : 'Unknown';
      case 'java': return navigator.javaEnabled ? (navigator.javaEnabled() ? 'Yes' : 'No') : 'No';
      case 'localStorage': try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return 'Yes'; } catch(e) { return 'Blocked'; }
      case 'sessionStorage': try { sessionStorage.setItem('__t', '1'); sessionStorage.removeItem('__t'); return 'Yes'; } catch(e) { return 'Blocked'; }
      case 'indexedDB': return 'indexedDB' in window ? 'Yes' : 'No';
      default: return 'Unknown';
    }
  } catch (e) { return 'Error'; }
}

async function getStorageEstimate() {
  try {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const est = await navigator.storage.estimate();
      const used = est.usage ? (est.usage / 1024 / 1024).toFixed(1) + ' MB' : 'Unknown';
      const quota = est.quota ? (est.quota / 1024 / 1024 / 1024).toFixed(1) + ' GB' : 'Unknown';
      return `${used} / ${quota}`;
    }
    return 'Not available';
  } catch (e) { return 'Blocked'; }
}

function reconLog(text, colorClass) {
  const out = document.getElementById('reconOutput');
  if (!out) return;
  const line = document.createElement('div');
  line.className = 'serial-line ' + (colorClass || '');
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}.${now.getMilliseconds().toString().padStart(3,'0')}`;
  line.textContent = `[${ts}] ${text}`;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
  while (out.children.length > 50) out.removeChild(out.firstChild);
}

function metricsLog(text, colorClass) {
  const out = document.getElementById('metricsOutput');
  if (!out) return;
  const line = document.createElement('div');
  line.className = 'serial-line ' + (colorClass || '');
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
  line.textContent = `[${ts}] ${text}`;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
  while (out.children.length > 50) out.removeChild(out.firstChild);
}

async function runRecon() {
  reconLog('Initializing passive reconnaissance...', 'dim');

  setTimeout(() => { setVal('fp-os', getOS()); reconLog(`OS detected: ${getOS()}`, 'cyan'); }, 200);
  setTimeout(() => { setVal('fp-browser', getBrowser()); reconLog(`Browser: ${getBrowser()}`, 'cyan'); }, 300);
  setTimeout(() => { setVal('fp-platform', navigator.platform || 'Unknown'); reconLog(`Platform: ${navigator.platform || 'Unknown'}`, 'cyan'); }, 400);
  setTimeout(() => { setVal('fp-cores', navigator.hardwareConcurrency || 'Unknown'); reconLog(`CPU cores: ${navigator.hardwareConcurrency || 'Unknown'}`, 'cyan'); }, 500);
  setTimeout(() => {
    const ram = navigator.deviceMemory || 'Unknown';
    setVal('fp-ram', ram);
    if (ram === 'Unknown' && !isChromium()) {
      reconLog('RAM estimate blocked by ' + getBrowserName() + ': privacy win', 'green');
    } else {
      reconLog(`RAM estimate: ${ram} GB`, 'cyan');
    }
  }, 600);
  setTimeout(() => { setVal('fp-arch', navigator.userAgent.includes('x64') || navigator.userAgent.includes('x86_64') ? 'x64' : (navigator.userAgent.includes('arm') ? 'ARM' : 'x86')); }, 650);
  setTimeout(() => { setVal('fp-screen', `${screen.width}x${screen.height}`); reconLog(`Screen: ${screen.width}x${screen.height}`, 'cyan'); }, 700);
  setTimeout(() => { setVal('fp-viewport', `${window.innerWidth}x${window.innerHeight}`); }, 750);
  setTimeout(() => { setVal('fp-color', screen.colorDepth + '-bit'); reconLog(`Color depth: ${screen.colorDepth}-bit`, 'dim'); }, 800);
  setTimeout(() => { setVal('fp-dpr', window.devicePixelRatio + 'x'); }, 850);
  setTimeout(() => { setVal('fp-lang', navigator.language + (navigator.languages ? ' [' + navigator.languages.slice(0,3).join(', ') + ']' : '')); reconLog(`Languages: ${navigator.language}`, 'dim'); }, 900);
  setTimeout(() => { setVal('fp-tz', Intl.DateTimeFormat().resolvedOptions().timeZone); reconLog(`Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`, 'dim'); }, 1000);

  setTimeout(() => {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const connInfo = conn ? `${conn.effectiveType} (downlink ${conn.downlink} Mbps)` : 'Unknown';
    setVal('fp-conn', connInfo);
    setVal('fp-rtt', conn ? conn.rtt + ' ms' : 'Unknown');
    setVal('fp-savedata', conn && conn.saveData ? 'On' : 'Off');
    reconLog(`Connection: ${connInfo}`, conn ? 'amber' : 'dim');
  }, 1100);

  setTimeout(() => {
    const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    setVal('fp-touch', touch ? `Yes (${navigator.maxTouchPoints} pts)` : 'No');
    reconLog(`Touch support: ${touch ? 'Yes' : 'No'}`, 'dim');
  }, 1200);

  setTimeout(() => {
    setVal('fp-cookies', navigator.cookieEnabled ? 'Enabled' : 'Disabled');
    reconLog(`Cookies: ${navigator.cookieEnabled ? 'Enabled' : 'Disabled'}`, navigator.cookieEnabled ? 'red' : 'green');
  }, 1300);

  setTimeout(() => {
    const dnt = navigator.doNotTrack;
    setVal('fp-dnt', dnt === '1' ? 'Enabled' : (dnt === '0' ? 'Disabled' : 'Not set'));
    reconLog(`Do Not Track: ${dnt === '1' ? 'Enabled' : (dnt === '0' ? 'Disabled' : 'Not set')}`, 'dim');
  }, 1400);

  setTimeout(() => { setVal('fp-online', navigator.onLine ? 'Yes' : 'Offline'); }, 1450);
  setTimeout(() => { setVal('fp-pdf', checkFeature('pdf')); }, 1500);
  setTimeout(() => { setVal('fp-java', checkFeature('java')); }, 1550);
  setTimeout(() => { setVal('fp-dark', window.matchMedia('(prefers-color-scheme: dark)').matches ? 'Yes' : 'No'); }, 1600);
  setTimeout(() => { setVal('fp-motion', window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'Yes' : 'No'); }, 1650);
  setTimeout(() => { setVal('fp-orient', screen.orientation ? screen.orientation.type : 'Unknown'); }, 1700);

  setTimeout(() => { setVal('fp-ua', navigator.userAgent); reconLog('User-Agent captured', 'magenta'); }, 1800);
  setTimeout(() => { const fp = getCanvasFingerprint(); setVal('fp-canvas', fp); reconLog('Canvas fingerprint hashed', 'magenta'); }, 1900);

  setTimeout(() => {
    const webgl = getWebGLInfo();
    setVal('fp-webgl', webgl.vendor);
    setVal('fp-webgl-render', webgl.renderer);
    reconLog('WebGL vendor/renderer extracted', 'magenta');
  }, 2000);

  setTimeout(() => { setVal('fp-plugins', getPlugins()); reconLog('Plugins enumerated', 'magenta'); }, 2100);
  setTimeout(() => { setVal('fp-mime', getMIMETypes()); reconLog('MIME types checked', 'dim'); }, 2200);

  setTimeout(() => {
    setVal('fp-battery', 'Checking...');
    if ('getBattery' in navigator) {
      navigator.getBattery().then(b => {
        setVal('fp-battery', (b.level * 100).toFixed(0) + '%');
        setVal('fp-charging', b.charging ? 'Yes' : 'No');
        reconLog(`Battery: ${(b.level * 100).toFixed(0)}% ${b.charging ? '(charging)' : ''}`, 'amber');
      });
    } else {
      setVal('fp-battery', 'Blocked');
      setVal('fp-charging', 'Blocked');
      if (!isChromium()) reconLog('Battery API blocked by ' + getBrowserName() + ': privacy win', 'green');
      else reconLog('Battery API unavailable', 'dim');
    }
  }, 2300);

  setTimeout(() => {
    setVal('fp-bt', checkFeature('bluetooth'));
    setVal('fp-usb', checkFeature('usb'));
    setVal('fp-webrtc', checkFeature('webrtc'));
    setVal('fp-wasm', checkFeature('wasm'));
    setVal('fp-sw', checkFeature('sw'));
    setVal('fp-notify', checkFeature('notifications'));
    setVal('fp-clipboard', checkFeature('clipboard'));
    setVal('fp-media', 'mediaDevices' in navigator ? 'Available' : 'No');
    setVal('fp-gamepad', checkFeature('gamepad'));
    setVal('fp-vr', checkFeature('vr'));
    if (!isChromium()) {
      reconLog('Bluetooth/USB APIs blocked by ' + getBrowserName() + ': privacy win', 'green');
    } else {
      reconLog('Hardware capabilities enumerated', 'dim');
    }
  }, 2400);

  setTimeout(() => {
    setVal('fp-referrer', document.referrer || 'Direct / None');
    setVal('fp-protocol', window.location.protocol);
    reconLog(`Referrer: ${document.referrer || 'Direct / None'}`, 'dim');
  }, 2500);

  setTimeout(() => {
    getLocalIPs(ip => {
      setVal('fp-localip', ip);
      reconLog(`Local IP leaked via WebRTC: ${ip}`, 'red');
    });
  }, 2600);

  setTimeout(async () => {
    const pubIP = await getPublicIP();
    setVal('fp-publicip', pubIP);
    reconLog(`Public IP resolved: ${pubIP}`, 'red');
  }, 3000);

  setTimeout(() => {
    setVal('fp-ls', checkFeature('localStorage'));
    setVal('fp-ss', checkFeature('sessionStorage'));
    setVal('fp-idb', checkFeature('indexedDB'));
    reconLog('Storage APIs checked', 'dim');
  }, 3200);

  setTimeout(async () => {
    const quota = await getStorageEstimate();
    setVal('fp-quota', quota);
    reconLog(`Storage quota: ${quota}`, 'dim');
    reconLog('------------------------------', 'dim');
    reconLog('RECON COMPLETE. No permission dialogs shown.', 'green');
    reconLog('All data collected passively via browser APIs.', 'green');
  }, 3500);
}

// ===================== LIVE METRICS =====================
let metricsState = {
  clicks: 0, keys: 0, scrolls: 0,
  mouseX: 0, mouseY: 0,
  startTime: performance.now(),
  frameCount: 0, lastFrameTime: performance.now(), fps: 0
};

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatTime(ms) {
  if (ms < 1000) return ms.toFixed(0) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  return (ms / 60000).toFixed(1) + ' m';
}

function updateMetrics() {
  const now = performance.now();
  metricsState.frameCount++;
  if (now - metricsState.lastFrameTime >= 1000) {
    metricsState.fps = metricsState.frameCount;
    metricsState.frameCount = 0;
    metricsState.lastFrameTime = now;
  }

  const mem = performance.memory;
  if (!mem && !metricsState.memoryWarned) {
    metricsState.memoryWarned = true;
    metricsLog('Memory API unavailable in ' + getBrowserName() + '. Privacy win.', 'green');
  }
  if (mem) {
    const used = mem.usedJSHeapSize;
    const total = mem.totalJSHeapSize;
    const limit = mem.jsHeapSizeLimit;
    const usedPct = (used / limit * 100).toFixed(1);
    const totalPct = (total / limit * 100).toFixed(1);
    const limitMB = (limit / 1024 / 1024).toFixed(0);

    const usedEl = document.getElementById('metric-heap-used');
    const totalEl = document.getElementById('metric-heap-total');
    const limitEl = document.getElementById('metric-heap-limit');

    if (usedEl) {
      usedEl.style.width = usedPct + '%';
      usedEl.className = 'metric-bar-fill' + (parseFloat(usedPct) > 80 ? ' red' : parseFloat(usedPct) > 50 ? ' amber' : '');
    }
    if (document.getElementById('metric-heap-used-text')) {
      document.getElementById('metric-heap-used-text').textContent = (used / 1024 / 1024).toFixed(1) + ' MB';
    }
    if (totalEl) {
      totalEl.style.width = totalPct + '%';
    }
    if (document.getElementById('metric-heap-total-text')) {
      document.getElementById('metric-heap-total-text').textContent = (total / 1024 / 1024).toFixed(1) + ' MB';
    }
    if (limitEl) {
      limitEl.style.width = '100%';
    }
    if (document.getElementById('metric-heap-limit-text')) {
      document.getElementById('metric-heap-limit-text').textContent = limitMB + ' MB';
    }
  }

  setVal('metric-fps', metricsState.fps + ' fps');
  setVal('metric-dom', document.getElementsByTagName('*').length);
  setVal('metric-events', 'N/A (DevTools)');

  const nav = performance.getEntriesByType('navigation')[0];
  if (nav) {
    setVal('metric-load', formatTime(nav.loadEventEnd - nav.startTime));
    setVal('metric-domready', formatTime(nav.domContentLoadedEventEnd - nav.startTime));
    setVal('metric-ttfb', formatTime(nav.responseStart - nav.startTime));
  }

  const paints = performance.getEntriesByType('paint');
  paints.forEach(p => {
    if (p.name === 'first-paint') setVal('metric-fp', formatTime(p.startTime));
    if (p.name === 'first-contentful-paint') setVal('metric-fcp', formatTime(p.startTime));
  });

  const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
  if (lcpEntries.length > 0) {
    const last = lcpEntries[lcpEntries.length - 1];
    setVal('metric-lcp', formatTime(last.startTime));
  }

  const resources = performance.getEntriesByType('resource');
  let transfer = 0, decoded = 0, images = 0, scripts = 0, css = 0;
  resources.forEach(r => {
    if (r.transferSize) transfer += r.transferSize;
    if (r.decodedBodySize) decoded += r.decodedBodySize;
    if (r.initiatorType === 'img') images++;
    if (r.initiatorType === 'script') scripts++;
    if (r.initiatorType === 'link' || r.initiatorType === 'css') css++;
  });
  setVal('metric-resources', resources.length);
  setVal('metric-transfer', formatBytes(transfer));
  setVal('metric-decoded', formatBytes(decoded));
  setVal('metric-images', images);
  setVal('metric-scripts', scripts);
  setVal('metric-css', css);

  if (nav && nav.toJSON) {
    const json = nav.toJSON();
    setVal('metric-layout', json.layoutCount || 'N/A');
    setVal('metric-styles', json.styleCount || 'N/A');
    setVal('metric-recalc', json.recalcCount || 'N/A');
  }

  if ('getBattery' in navigator) {
    navigator.getBattery().then(b => {
      const level = b.level * 100;
      const barEl = document.getElementById('metric-battery-bar');
      const textEl = document.getElementById('metric-battery-text');
      if (barEl) {
        barEl.style.width = level + '%';
        barEl.className = 'metric-bar-fill' + (level < 20 ? ' red' : level < 50 ? ' amber' : '');
      }
      if (textEl) textEl.textContent = level.toFixed(0) + '%';
      setVal('metric-charging', b.charging ? 'Yes' : 'No');
      setVal('metric-chargetime', b.chargingTime === Infinity ? '∞' : (b.chargingTime / 60).toFixed(0) + ' min');
      setVal('metric-dischargetime', b.dischargingTime === Infinity ? '∞' : (b.dischargingTime / 60).toFixed(0) + ' min');
      setVal('metric-source', b.charging ? 'AC Adapter' : 'Battery');
    });
  }

  setVal('metric-uptime', formatTime(now - metricsState.startTime));
  setVal('metric-clicks', metricsState.clicks);
  setVal('metric-keys', metricsState.keys);
  setVal('metric-scrolls', metricsState.scrolls);
  setVal('metric-mousex', metricsState.mouseX);
  setVal('metric-mousey', metricsState.mouseY);
  setVal('metric-req-count', resources.length);
  setVal('metric-data-in', formatBytes(transfer));
  setVal('metric-data-out', '0 B');
  setVal('metric-latency', nav ? (nav.responseEnd - nav.requestStart).toFixed(0) + ' ms' : ':');

  requestAnimationFrame(updateMetrics);
}

function setupMetricsTracking() {
  document.addEventListener('click', () => { metricsState.clicks++; });
  document.addEventListener('keydown', () => { metricsState.keys++; });
  document.addEventListener('scroll', () => { metricsState.scrolls++; }, { passive: true });
  document.addEventListener('mousemove', (e) => {
    metricsState.mouseX = e.clientX;
    metricsState.mouseY = e.clientY;
  });
  metricsLog('Metrics collection started', 'green');
  metricsLog('Tracking: memory, FPS, DOM, events, battery, network', 'dim');
  requestAnimationFrame(updateMetrics);
  setInterval(() => {
    const mem = performance.memory;
    if (mem) {
      const usedMB = (mem.usedJSHeapSize / 1024 / 1024).toFixed(1);
      metricsLog(`Heap: ${usedMB} MB | FPS: ${metricsState.fps} | DOM: ${document.getElementsByTagName('*').length}`, 'cyan');
    }
  }, 5000);
}

// ===================== RIGHT PANEL TAB SWITCHING =====================
// ===================== MOBILE OVERLAYS =====================
// The recon/metrics panel is reused as-is for the fullscreen mobile
// overlay — no separate markup, just a class that (on .mobile-os only)
// pulls it out of the grid and pins it over the whole viewport. Triggered
// from either the web view's 🔍 icon or the terminal titlebar's 🔍 icon.
function openReconOverlay() {
  const panel = document.querySelector('.right-panel');
  if (panel) panel.classList.add('mobile-recon-open');
  document.body.style.overflow = 'hidden';
}
function closeReconOverlay() {
  const panel = document.querySelector('.right-panel');
  if (panel) panel.classList.remove('mobile-recon-open');
  document.body.style.overflow = '';
}

function openMobileNav() {
  const overlay = document.getElementById('mobileNavOverlay');
  if (overlay) overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeMobileNav() {
  const overlay = document.getElementById('mobileNavOverlay');
  if (overlay) overlay.classList.remove('open');
  document.body.style.overflow = '';
}

function switchRightTab(tab) {
  document.querySelectorAll('.right-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.right-tab-pane').forEach(p => p.classList.remove('active'));
  const tabEls = document.querySelectorAll('.right-tab');
  if (tab === 'recon' && tabEls[0]) tabEls[0].classList.add('active');
  if (tab === 'metrics' && tabEls[1]) tabEls[1].classList.add('active');
  const pane = document.getElementById('right-' + tab);
  if (pane) pane.classList.add('active');
  if (tab === 'metrics') {
    metricsLog('Switched to Live Metrics tab', 'dim');
  } else {
    reconLog('Switched to Recon tab', 'dim');
  }
}


// ===================== THEME TOGGLE =====================
let isWebMode = false;

function toggleTheme() {
  if (isWebMode) switchToTerminal();
  else switchToWeb();
}

function switchToWeb() {
  isWebMode = true;
  const splitContainer = document.querySelector('.split-container');
  const webView = document.getElementById('webView');
  const terminalWrap = document.getElementById('terminalWrap');
  const toggleBtn = document.getElementById('themeToggle');
  const resizer = document.getElementById('resizer');
  if (toggleBtn) { toggleBtn.textContent = '💻 Terminal'; toggleBtn.title = 'Switch to Terminal View'; }
  if (webView) webView.style.display = 'block';
  if (terminalWrap) terminalWrap.style.display = 'none';
  if (splitContainer) {
    splitContainer.classList.add('web-mode');
    splitContainer.classList.remove('right-collapsed');
    splitContainer.style.gridTemplateColumns = '100% 0px';
  }
  if (resizer) resizer.style.left = 'calc(100% - 4px)';
  setupWebNavSpy();
}

function switchToTerminal() {
  isWebMode = false;
  const splitContainer = document.querySelector('.split-container');
  const webView = document.getElementById('webView');
  const terminalWrap = document.getElementById('terminalWrap');
  const toggleBtn = document.getElementById('themeToggle');
  const resizer = document.getElementById('resizer');
  if (toggleBtn) { toggleBtn.textContent = '🌐 Web'; toggleBtn.title = 'Switch to Web View'; }
  if (webView) webView.style.display = 'none';
  if (terminalWrap) terminalWrap.style.display = 'flex';
  if (splitContainer) {
    splitContainer.classList.remove('web-mode');
    splitContainer.classList.remove('terminal-visible');
    splitContainer.style.gridTemplateColumns = '';
  }
  if (resizer) resizer.style.left = '65%';
  if (!isTouchDevice()) {
    setTimeout(() => {
      const input = document.querySelector(`#pane-${activeTab} .cmd-input`);
      if (input) input.focus();
    }, 50);
  }
}

// ===================== CONTENT VIEWER =====================
let _cvViewer, _cvTitle, _cvDate, _cvBody;
function _getCvEls() {
  if (!_cvViewer) {
    _cvViewer = document.getElementById('contentViewer');
    _cvTitle = document.getElementById('cvTitle');
    _cvDate = document.getElementById('cvDate');
    _cvBody = document.getElementById('cvBody');
  }
  return { viewer: _cvViewer, title: _cvTitle, date: _cvDate, body: _cvBody };
}

async function openContentViewer(el) {
  const src = el.dataset.content;
  const format = el.dataset.format || 'txt';
  const title = el.dataset.title || 'Untitled';
  const date = el.dataset.date || '';
  const repoUrl = el.dataset.repo || '';
  const { viewer, title: titleEl, date: dateEl, body } = _getCvEls();
  if (!viewer || !body) return;
  if (titleEl) titleEl.textContent = title;
  if (dateEl) dateEl.textContent = date;
  const repoLink = document.getElementById('cvRepoLink');
  if (repoLink) {
    if (repoUrl) { repoLink.href = repoUrl; repoLink.style.display = ''; }
    else repoLink.style.display = 'none';
  }
  body.innerHTML = '<p style="color:var(--web-text-secondary); padding:20px 0;">Loading...</p>';
  viewer.classList.add('open');
  viewer.scrollTop = 0;
  try {
    if (format === 'pdf') {
      body.innerHTML = '<embed src="' + src + '" type="application/pdf" style="width:100%; height:70vh; border-radius:8px; border:1px solid var(--web-border);">';
      return;
    }
    const res = await fetch(src);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (format === 'md') {
      const fixedText = fixMarkdownImagePaths(text, src);
      body.innerHTML = safeMarkdownParse(fixedText);
    } else {
      body.innerHTML = '<pre style="background:var(--web-bg); border:1px solid var(--web-border); border-radius:8px; padding:16px; font-family:var(--web-mono); font-size:13px; line-height:1.8; color:var(--web-text); white-space:pre-wrap; word-wrap:break-word; margin:0;">' + escapeHtml(text) + '</pre>';
    }
  } catch (e) {
    body.innerHTML = '<p style="color:var(--web-red); padding:20px 0;">Error loading content: ' + escapeHtml(e.message) + '</p>';
  }
}

function closeContentViewer() {
  const viewer = document.getElementById('contentViewer');
  const body = document.getElementById('cvBody');
  if (viewer) {
    viewer.classList.remove('open');
    // Clear content after transition to free memory
    setTimeout(() => { if (body && !viewer.classList.contains('open')) body.innerHTML = ''; }, 300);
  }
}

// Clicking the dark backdrop area (not the article itself) or pressing
// Escape closes the viewer, matching how most reading overlays behave.
function setupContentViewerDismiss() {
  const viewer = document.getElementById('contentViewer');
  if (viewer) {
    viewer.addEventListener('click', (e) => {
      if (e.target === viewer || e.target.id === 'cvContentWrap') closeContentViewer();
    });
  }
  const mobileNav = document.getElementById('mobileNavOverlay');
  if (mobileNav) {
    mobileNav.addEventListener('click', (e) => {
      if (e.target === mobileNav) closeMobileNav();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (viewer && viewer.classList.contains('open')) closeContentViewer();
    if (mobileNav && mobileNav.classList.contains('open')) closeMobileNav();
    const panel = document.querySelector('.right-panel');
    if (panel && panel.classList.contains('mobile-recon-open')) closeReconOverlay();
  });
}

// ===================== WEB NAV SCROLL SPY =====================
function setupWebNavSpy() {
  const webView = document.getElementById('webView');
  if (!webView) return;
  const navLinks = Array.from(webView.querySelectorAll('.nav-link'));
  if (webView._scrollHandler) webView.removeEventListener('scroll', webView._scrollHandler);

  // Cache section offsets for performance
  let sectionOffsets = [];
  function cacheOffsets() {
    sectionOffsets = Array.from(webView.querySelectorAll('section[id]')).map(s => ({
      id: s.getAttribute('id'),
      top: s.offsetTop - 100
    }));
  }
  cacheOffsets();
  window.addEventListener('resize', cacheOffsets, { passive: true });

  let ticking = false;
  webView._scrollHandler = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const scrollTop = webView.scrollTop;
      let current = '';
      for (let i = sectionOffsets.length - 1; i >= 0; i--) {
        if (scrollTop >= sectionOffsets[i].top) {
          current = sectionOffsets[i].id;
          break;
        }
      }
      for (const link of navLinks) {
        link.classList.toggle('active', link.getAttribute('href') === '#' + current);
      }
      ticking = false;
    });
  };
  webView.addEventListener('scroll', webView._scrollHandler, { passive: true });

  for (const link of navLinks) {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (href && href.length > 1 && href.startsWith('#')) {
        const target = webView.querySelector(href);
        if (target) {
          e.preventDefault();
          webView.scrollTo({ top: target.offsetTop - 60, behavior: 'smooth' });
        }
      }
    });
  }
}

// ===================== INIT =====================
document.addEventListener('DOMContentLoaded', async () => {
  // Load content data first (needed for directory listings)
  try {
    const res = await fetch('content.json');
    if (res.ok) contentData = await res.json();
  } catch (e) {
    console.error('Failed to load content.json:', e);
  }

  // Populate the web (portfolio) view from the same data the terminal uses
  renderWebSections();

  // Create home tab and terminal
  goHome();

  // On an actual phone, open straight into the normal web page — the
  // terminal is a fun default for desktop but not a great first
  // impression to land a mobile visitor on. Still fully reachable via
  // the 💻 icon.
  if (isMobileOS()) switchToWeb();

  // Setup command input handling
  setupInputDelegation();

  // Close the content viewer on outside click / Escape
  setupContentViewerDismiss();

  // Setup panel resizer
  setupResizer();

  // Start visitor recon
  showBrowserShield();
  runRecon();

  // Start live metrics
  setupMetricsTracking();
});

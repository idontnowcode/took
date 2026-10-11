// Took: 입력 전용 PWA. 툭 적어 두면, 정리는 밤사이에.
// - 글 상자 하나에 적고 저장. 판단하지 않는다. 오프라인이면 기기에 대기했다가 연결되면 보낸다.
// - Drive에는 앱이 만든 전용 폴더(Took)에만 쓴다(drive.file 권한). PC 분류 루틴이 그 폴더를 읽는다.
// - 저장 후 5분 안에는 수정·취소할 수 있다. 취소는 지우지 않고 'status: canceled'로 표시한다(원본 삭제 금지).
(() => {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const MOCK = !CFG.clientId;
  const EDIT_MS = 5 * 60 * 1000;
  const $ = s => document.querySelector(s);

  // ---------- 기기 저장소(IndexedDB) ----------
  let dbp;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('took', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('queue', { keyPath: 'qid', autoIncrement: true });
        d.createObjectStore('recent', { keyPath: 'id' });
        d.createObjectStore('kv');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  const put = (store, v, key) => tx(store, 'readwrite', s => (key === undefined ? s.put(v) : s.put(v, key)));
  const del = (store, k) => tx(store, 'readwrite', s => s.delete(k));
  const all = store => tx(store, 'readonly', s => s.getAll());
  const get = (store, k) => tx(store, 'readonly', s => s.get(k));

  // ---------- 메모 파일 만들기 ----------
  const pad = n => String(n).padStart(2, '0');
  const localIso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  function newId() {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }
  function safeName(s) {
    return (s || '').replace(/^\s*!+/, '').replace(/[\\/:*?"<>|#\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20).trim() || '메모';
  }
  function fileName(d, summary, id, sensitive) {
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    return `${ts}-${sensitive ? '민감' : safeName(summary)}-${id.slice(0, 4)}.md`;   // 민감 메모는 이름에 내용을 넣지 않는다(#74)
  }
  const one = v => String(v || '').replace(/[\r\n]+/g, ' ').trim();
  function buildNote(f) {
    const L = ['---', `id: ${f.id}`, `captured: ${f.captured}`, 'source: app', `type: ${f.type}`];
    if (f.type === 'link') {
      L.push(`url: ${one(f.url)}`);
      if (f.title) L.push(`title: ${one(f.title)}`);
      L.push(`note: ${one(f.note)}`);
    }
    if (f.thread) L.push(`thread: ${f.thread}`);
    if ((f.body || '').trim().startsWith('!')) L.push('priority: high');
    if (f.sensitive) L.push('sensitive: true');
    if (f.status) L.push(`status: ${f.status}`);
    L.push('---', '', (f.body || '').trim(), '');
    return L.join('\n');
  }

  // ---------- 저장소: 모의 / Drive ----------
  const SAMPLE_BRIEF = '# 복귀 요약 — 모의 모드\n\n> PC 분류 루틴이 만든 요약이 여기에 보입니다.\n\n## 오늘 할 3가지\n1. 예시 할 일 — 예시 아이디어의 다음 행동\n\n## 상태\n- 승인 대기 제안: 0건\n';
  const SAMPLE_LIST = '- example-idea | 예시 아이디어 | 다듬는 중\n';
  const SAMPLE_PROPOSALS = '# 제안 목록\n\n- [ ] [일정] 2026-10-14 예시 약속 (원본: 00_Inbox/예시.md) <!--ex1-->\n' +
    '- [ ] [이동] 00_Inbox/예시2.md → 02_Learning (확신도 0.72) · 예시 메모 <!--ex2-->\n- [x] [이동] 이미 승인된 예시 <!--ex3-->\n';
  const Mock = {
    label: '모의 모드 — 이 기기에만 저장',
    store() { try { return JSON.parse(localStorage.getItem('took-mock') || '{}'); } catch (e) { return {}; } },
    save(s) { localStorage.setItem('took-mock', JSON.stringify(s)); },
    check() { if ($('#forceOffline').checked || !navigator.onLine) throw new Error('오프라인'); },
    async create(name, content) {
      this.check();
      const s = this.store();
      const id = 'm' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
      s[id] = { name, content };
      this.save(s);
      return id;
    },
    async update(id, content) {
      this.check();
      const s = this.store();
      if (!s[id]) throw new Error('파일 없음');
      s[id].content = content;
      this.save(s);
    },
    async readText(name) {
      this.check();
      if (name === '승인.md') return localStorage.getItem('took-mock-approvals') || '';
      return name === '목록.md' ? SAMPLE_LIST : name === '제안.md' ? SAMPLE_PROPOSALS : SAMPLE_BRIEF;
    },
    async writeText(name, content) {
      this.check();
      if (name === '승인.md') localStorage.setItem('took-mock-approvals', content);
    }
  };

  const Drive = {
    label: 'Google Drive',
    token: null, exp: 0, folderId: null,
    async loadGis() {
      if (window.google && google.accounts && google.accounts.oauth2) return;
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = res;
        s.onerror = () => rej(new Error('Google 로그인 스크립트를 불러오지 못함'));
        document.head.appendChild(s);
      });
    },
    // interactive=false면 창을 띄우지 않고 조용히 시도만 한다(#83: 매번 로그인이 뜨는지 검증할 지점).
    async auth(interactive) {
      if (this.token && Date.now() < this.exp - 60000) return this.token;
      if (!navigator.onLine) throw new Error('오프라인');
      // 로그인 창은 사용자가 누른 동작(저장·탭 열기·대기 보내기)에서만 띄운다. 자동으로 띄우면 팝업 차단에 걸린다.
      if (!interactive) throw new Error('로그인 필요');
      await this.loadGis();
      return new Promise((res, rej) => {
        const c = google.accounts.oauth2.initTokenClient({
          client_id: CFG.clientId,
          scope: 'https://www.googleapis.com/auth/drive.file',
          prompt: interactive ? '' : 'none',
          callback: r => {
            if (r.error) return rej(new Error('로그인 필요'));
            this.token = r.access_token;
            this.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
            res(this.token);
          },
          error_callback: e => rej(new Error('로그인 창이 닫혔거나 막힘' + (e && e.type ? ` (${e.type})` : '')))
        });
        c.requestAccessToken();
      });
    },
    async api(path, opts, interactive) {
      const t = await this.auth(interactive);
      const r = await fetch('https://www.googleapis.com' + path,
        Object.assign({}, opts, { headers: Object.assign({}, (opts && opts.headers) || {}, { Authorization: 'Bearer ' + t }) }));
      if (r.status === 401) { this.token = null; throw new Error('로그인 만료'); }
      if (!r.ok) throw new Error('Drive 오류 ' + r.status);
      return r;
    },
    async upload(meta, content, interactive) {
      const b = 'qm' + Date.now();
      const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n--${b}--`;
      const r = await this.api('/upload/drive/v3/files?uploadType=multipart&fields=id',
        { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body }, interactive);
      return (await r.json()).id;
    },
    async findOrCreateFolder(name, parent, interactive) {
      const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : '');
      const r = await (await this.api(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`, {}, interactive)).json();
      if (r.files && r.files.length) return r.files[0].id;
      const c = await (await this.api('/drive/v3/files?fields=id', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ name, mimeType: 'application/vnd.google-apps.folder' }, parent ? { parents: [parent] } : {}))
      }, interactive)).json();
      return c.id;
    },
    async folder(interactive) {
      if (!this.folderId) this.folderId = (await get('kv', 'folderId')) || null;
      if (!this.folderId) {
        this.folderId = await this.findOrCreateFolder(CFG.folderName || 'Took', null, interactive);
        await put('kv', this.folderId, 'folderId');
      }
      return this.folderId;
    },
    async create(name, content, interactive) {
      const fid = await this.folder(interactive);
      return this.upload({ name, parents: [fid], mimeType: 'text/markdown' }, content, interactive);
    },
    async update(id, content, interactive) {
      await this.api(`/upload/drive/v3/files/${id}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': 'text/markdown; charset=UTF-8' }, body: content }, interactive);
    },
    // 요약·목록은 앱이 먼저 빈 파일을 만들어 둔다. PC가 같은 파일을 덮어쓰면 앱이 계속 읽을 수 있다(#85).
    async appFile(name, interactive) {
      const key = 'file:' + name;
      let id = await get('kv', key);
      if (id) return id;
      const fid = await this.folder(interactive);
      const sub = await this.findOrCreateFolder(CFG.appSubfolder || '_앱', fid, interactive);
      const q = `name='${name}' and '${sub}' in parents and trashed=false`;
      const r = await (await this.api(`/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, {}, interactive)).json();
      id = r.files && r.files.length ? r.files[0].id
        : await this.upload({ name, parents: [sub], mimeType: 'text/markdown' }, '(아직 PC에서 만들지 않았습니다)\n', interactive);
      await put('kv', id, key);
      return id;
    },
    async readText(name, interactive) {
      const id = await this.appFile(name, interactive);
      return (await this.api(`/drive/v3/files/${id}?alt=media`, {}, interactive)).text();
    },
    async writeText(name, content, interactive) {
      const id = await this.appFile(name, interactive);
      await this.update(id, content, interactive);
    }
  };
  const B = MOCK ? Mock : Drive;

  // ---------- 대기열 보내기 ----------
  let flushing = false;
  async function flush(interactive) {
    if (flushing) return;
    flushing = true;
    let err = null;
    try {
      const q = (await all('queue')).sort((a, b) => a.qid - b.qid);
      for (const it of q) {
        const rec = await get('recent', it.id);
        if (it.op === 'create') {
          const fileId = await B.create(it.name, it.content, interactive);
          await del('queue', it.qid);
          if (rec) await put('recent', Object.assign(rec, { fileId, status: rec.canceled ? 'canceled' : 'saved', content: it.content }));
        } else if (it.op === 'update') {
          if (!rec || !rec.fileId) continue;
          await B.update(rec.fileId, it.content, interactive);
          await del('queue', it.qid);
          await put('recent', Object.assign(rec, { status: rec.canceled ? 'canceled' : 'saved', content: it.content }));
        }
      }
    } catch (e) {
      err = e;
    } finally {
      flushing = false;
      await render();
    }
    if (err) msg('대기 중 — ' + err.message + ' (연결되면 다시 보냅니다)', true);
  }

  // ---------- 입력·수정·취소 ----------
  let editingId = null;
  async function onSave(e) {
    e.preventDefault();
    const body = $('#body').value;
    const isLink = !$('#linkBox').hidden;
    if (!body.trim() && !isLink) return msg('내용이 비어 있습니다', true);
    if (isLink && !$('#note').value.trim()) { $('#note').focus(); return msg('링크는 "왜 저장하나" 한 줄이 필요합니다', true); }
    if (editingId) return saveEdit(body);
    const now = new Date();
    const id = newId();
    const sensitive = $('#sensitive').checked;
    const f = { id, captured: localIso(now), type: isLink ? 'link' : 'text', url: $('#url').value, title: $('#title').value,
      note: $('#note').value, thread: $('#thread').value, sensitive, body: body || $('#title').value || '' };
    const summary = isLink ? ($('#title').value || $('#url').value) : body;
    const name = fileName(now, summary, id, sensitive);
    const content = buildNote(f);
    await put('recent', { id, name, f, content, createdAt: now.getTime(), status: 'queued', sensitive,
      summary: sensitive ? '민감 메모' : one(summary).slice(0, 80) });
    await put('queue', { op: 'create', id, name, content });
    resetForm();
    msg('저장했습니다');
    await flush(true);
    if (!ideasLoaded) loadIdeas(true);         // 첫 로그인 뒤 이어쓰기 목록을 새로 받는다
  }

  async function saveEdit(body) {
    const rec = await get('recent', editingId);
    if (!rec || Date.now() - rec.createdAt > EDIT_MS) { resetForm(); return msg('5분이 지나 수정할 수 없습니다. Drive에서 직접 고치세요.', true); }
    const f = Object.assign({}, rec.f, { body, sensitive: $('#sensitive').checked, thread: $('#thread').value, note: $('#note').value || rec.f.note });
    const content = buildNote(f);
    await enqueueChange(rec, content, { f, summary: f.sensitive ? '민감 메모' : one(body).slice(0, 80) });
    resetForm();
    msg('수정했습니다');
    await flush(true);
  }

  async function enqueueChange(rec, content, patch) {
    const q = await all('queue');
    const pendingCreate = q.find(x => x.op === 'create' && x.id === rec.id);
    if (pendingCreate) {                       // 아직 안 보냈으면 대기 중인 내용만 바꾼다
      pendingCreate.content = content;
      await put('queue', pendingCreate);
    } else {
      await put('queue', { op: 'update', id: rec.id, content });
    }
    await put('recent', Object.assign(rec, patch, { content, status: 'queued' }));
  }

  async function cancelNote(id) {
    const rec = await get('recent', id);
    if (!rec || Date.now() - rec.createdAt > EDIT_MS) return msg('5분이 지나 취소할 수 없습니다', true);
    if (!confirm('이 입력을 취소할까요? (지우지 않고 "취소됨"으로 표시해 폐기후보로 보냅니다)')) return;
    const f = Object.assign({}, rec.f, { status: 'canceled' });
    await enqueueChange(rec, buildNote(f), { f, canceled: true });
    msg('취소로 표시했습니다');
    await flush(true);
  }

  async function startEdit(id) {
    const rec = await get('recent', id);
    if (!rec || Date.now() - rec.createdAt > EDIT_MS) return msg('5분이 지나 수정할 수 없습니다', true);
    editingId = id;
    $('#body').value = rec.f.body || '';
    $('#sensitive').checked = !!rec.f.sensitive;
    $('#thread').value = rec.f.thread || '';
    if (rec.f.type === 'link') { showLink(rec.f.url, rec.f.title); $('#note').value = rec.f.note || ''; }
    $('#save').textContent = '수정 저장';
    $('#cancelEdit').hidden = false;
    $('#body').focus();
  }

  function resetForm() {
    editingId = null;
    $('#form').reset();
    $('#linkBox').hidden = true;
    $('#save').textContent = '저장';
    $('#cancelEdit').hidden = true;
    $('#body').focus();
  }
  function showLink(url, title) {
    $('#linkBox').hidden = false;
    $('#url').value = url || '';
    $('#title').value = title || '';
  }
  function msg(text, isErr) {
    const m = $('#msg');
    m.textContent = text;
    m.className = 'msg' + (isErr ? ' err' : '');
  }

  // ---------- 화면 ----------
  async function render() {
    const q = await all('queue');
    const qb = $('#queue');
    qb.hidden = q.length === 0;
    qb.textContent = `대기 ${q.length}건 · 보내기`;
    const recent = (await all('recent')).sort((a, b) => b.createdAt - a.createdAt);
    const ul = $('#recent');
    ul.textContent = '';
    for (const r of recent.slice(0, 10)) {
      const li = document.createElement('li');
      const meta = document.createElement('div');
      meta.className = 'meta';
      const t = new Date(r.createdAt);
      const badge = document.createElement('span');
      badge.className = 'badge' + (r.status === 'queued' ? ' wait' : r.status === 'canceled' ? ' cancel' : '');
      badge.textContent = r.status === 'queued' ? '대기' : r.status === 'canceled' ? '취소됨' : '저장됨';
      meta.append(`${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`, badge);
      if (r.f && r.f.thread) meta.append(`이어쓰기: ${r.f.thread}`);
      const p = document.createElement('p');
      p.className = 'text';
      p.textContent = r.summary;
      const loc = document.createElement('div');
      loc.className = 'meta';
      loc.textContent = `위치: ${CFG.folderName || 'Took'}/${r.name} (PC 분류 후 이동될 수 있음)`;
      li.append(meta, p, loc);
      if (!r.canceled && Date.now() - r.createdAt <= EDIT_MS) {
        const acts = document.createElement('div');
        acts.className = 'acts';
        const e = document.createElement('button');
        e.type = 'button'; e.textContent = '수정'; e.onclick = () => startEdit(r.id);
        const c = document.createElement('button');
        c.type = 'button'; c.textContent = '취소'; c.onclick = () => cancelNote(r.id);
        acts.append(e, c);
        li.append(acts);
      }
      ul.append(li);
    }
    // 오래된 기록은 기기에서 정리(최근 50개만)
    for (const r of recent.slice(50)) if (r.status !== 'queued') await del('recent', r.id);
  }

  function esc(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  }
  function renderMd(md) {
    const out = [];
    let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of md.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
      else if ((m = line.match(/^>\s?(.*)$/))) { close(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
      else if ((m = line.match(/^\s*-\s+\[( |x)\]\s+(.*)$/i))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${m[1] === ' ' ? '☐' : '☑'} ${inline(m[2])}</li>`); }
      else if ((m = line.match(/^\s*-\s+(.*)$/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^\d+\.\s+(.*)$/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if (!line.trim()) { close(); }
      else { close(); out.push(`<p>${inline(line)}</p>`); }
    }
    close();
    return out.join('\n');
  }

  async function loadBrief(interactive) {
    const box = $('#brief');
    try {
      const text = await B.readText('복귀요약.md', interactive);
      await put('kv', text, 'brief');
      box.innerHTML = renderMd(text);
    } catch (e) {
      const cached = await get('kv', 'brief');
      box.innerHTML = (cached ? renderMd(cached) : '') + `<p class="msg err">새로 불러오지 못함: ${esc(e.message)}${cached ? ' — 마지막으로 받은 내용' : ''}</p>`;
    }
  }

  // ---------- 승인 탭: 제안 사본을 읽고, 체크한 항목의 key를 승인.md에 쓴다(PC가 다음 실행에 반영) ----------
  function parseProposals(md) {
    const out = [];
    for (const line of md.split(/\r?\n/)) {
      const m = line.match(/^\s*-\s*\[ \]\s*(.*?)\s*<!--(\S+?)-->\s*$/);
      if (!m) continue;
      const k = m[1].match(/^\[([^\]]+)\]\s*(.*)$/);
      out.push({ key: m[2], kind: k ? k[1] : '', text: k ? k[2] : m[1] });
    }
    return out;
  }
  function parseApprovals(md) {
    return (md || '').split(/\r?\n/).map(l => l.match(/^\s*-\s*(\S+)/)).filter(Boolean).map(m => m[1]);
  }

  async function loadApprovals(interactive) {
    const ul = $('#proposals');
    const am = $('#approveMsg');
    am.textContent = '';
    try {
      const [prop, appr] = await Promise.all([B.readText('제안.md', interactive), B.readText('승인.md', interactive)]);
      const pending = new Set(parseApprovals(appr));
      const items = parseProposals(prop).slice(0, 10);            // 한 번에 10개까지(Rule 14장)
      ul.textContent = '';
      if (!items.length) { ul.innerHTML = '<li>승인할 제안이 없습니다.</li>'; return; }
      for (const it of items) {
        const li = document.createElement('li');
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = it.key;
        cb.checked = pending.has(it.key);
        const span = document.createElement('span');
        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.textContent = it.kind;
        span.append(kind, it.text);
        label.append(cb, span);
        li.append(label);
        ul.append(li);
      }
    } catch (e) {
      ul.textContent = '';
      am.className = 'msg err';
      am.textContent = '불러오지 못함: ' + e.message;
    }
  }

  async function sendApprovals() {
    const am = $('#approveMsg');
    const keys = [...document.querySelectorAll('#proposals input:checked')].map(c => c.value);
    const stamp = localIso(new Date());
    try {
      await B.writeText('승인.md', keys.map(k => `- ${k} | ${stamp}`).join('\n') + (keys.length ? '\n' : ''), true);
      am.className = 'msg';
      am.textContent = keys.length ? `${keys.length}건 보냄 — 다음 PC 실행 때 반영됩니다` : '보낼 승인이 없어 대기 목록을 비웠습니다';
    } catch (e) {
      am.className = 'msg err';
      am.textContent = '보내지 못함: ' + e.message;
    }
  }

  let ideasLoaded = false;
  async function loadIdeas(interactive) {
    let text = null;
    try { text = await B.readText('목록.md', !!interactive); await put('kv', text, 'ideas'); ideasLoaded = true; }
    catch (e) { text = await get('kv', 'ideas'); }
    const sel = $('#thread');
    const keep = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    for (const line of (text || '').split(/\r?\n/)) {
      const m = line.match(/^\s*-\s*([^|]+?)\s*\|\s*([^|]+?)\s*(\|\s*(.+))?$/);
      if (!m) continue;
      const o = document.createElement('option');
      o.value = m[1];
      o.textContent = `이어쓰기: ${m[2]}`;
      sel.append(o);
    }
    sel.value = keep;
  }

  function readShare() {
    const p = new URLSearchParams(location.search);
    const title = p.get('title') || '', text = p.get('text') || '';
    let url = p.get('url') || '';
    if (!title && !text && !url) return;
    if (!url) { const m = text.match(/https?:\/\/\S+/); if (m) url = m[0]; }
    if (url) {
      showLink(url, title);
      $('#body').value = text.replace(url, '').trim().slice(0, 2000);   // 붙어 온 본문은 2,000자까지(#92)
      setTimeout(() => $('#note').focus(), 0);
    } else {
      $('#body').value = [title, text].filter(Boolean).join('\n').slice(0, 2000);
    }
    history.replaceState(null, '', location.pathname);
  }

  // ---------- 시작 ----------
  function tabs() {
    document.querySelectorAll('nav [role=tab]').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('nav [role=tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      $('#tab-write').hidden = b.dataset.tab !== 'write';
      $('#tab-brief').hidden = b.dataset.tab !== 'brief';
      $('#tab-approve').hidden = b.dataset.tab !== 'approve';
      if (b.dataset.tab === 'brief') loadBrief(true);
      if (b.dataset.tab === 'approve') loadApprovals(true);
    }));
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('#mode').textContent = B.label;
    $('#dev').hidden = !MOCK;
    $('#form').addEventListener('submit', onSave);
    $('#cancelEdit').addEventListener('click', resetForm);
    $('#reloadBrief').addEventListener('click', () => loadBrief(true));
    $('#sendApprovals').addEventListener('click', sendApprovals);
    $('#queue').addEventListener('click', () => flush(true));
    $('#reloadApprovals').addEventListener('click', () => loadApprovals(true));
    $('#resetMock').addEventListener('click', async () => {
      localStorage.removeItem('took-mock');
      for (const r of await all('recent')) await del('recent', r.id);
      for (const q of await all('queue')) await del('queue', q.qid);
      render();
      msg('모의 저장소를 비웠습니다');
    });
    $('#forceOffline').addEventListener('change', () => { if (!$('#forceOffline').checked) flush(false); });
    window.addEventListener('online', () => flush(false));
    tabs();
    readShare();
    $('#body').focus();
    await render();
    loadIdeas();
    flush(false);
    setInterval(render, 30000);              // 5분 지난 항목의 수정·취소 버튼을 숨긴다
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  });

  window.__qm = { buildNote, fileName, renderMd, flush, all };   // 시험용
})();

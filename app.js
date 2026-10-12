// Took: 입력 전용 PWA. 툭 적어 두면, 정리는 밤사이에.
// - 글 상자 하나에 적고 저장. 판단하지 않는다. 오프라인이면 기기에 대기했다가 연결되면 보낸다.
// - Drive에는 앱이 만든 전용 폴더(Took)에만 쓴다(drive.file 권한). PC 분류 루틴이 그 폴더를 읽는다.
// - 저장 후 5분 안에는 수정·취소할 수 있다. 취소는 지우지 않고 'status: canceled'로 표시한다(원본 삭제 금지).
(() => {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  // 클라이언트 ID가 없거나, 이 PC의 미리보기(127.0.0.1)에서 ?mock 으로 열면 모의 모드(로그인 없이 화면 시험용)
  const MOCK = !CFG.clientId || (location.hostname === '127.0.0.1' && new URLSearchParams(location.search).has('mock'));
  const EDIT_MS = 5 * 60 * 1000;
  const APP_VERSION = 'v12';                     // sw.js의 CACHE 이름과 같이 올린다
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
  const showTime = d => `${String(d.getFullYear()).slice(2)}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} (${pad(d.getHours())}:${pad(d.getMinutes())})`;   // 화면 표기: 26/10/11 (23:26)
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

  // ---------- 일정 ----------
  // 제안 문구: "2026-10-12 09:30 제목 (원본: …)" 또는 "2026-10-12 제목 (원본: …)"
  function parseEvent(item) {
    const m = (item.text || '').match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?\s+(.+?)(?:\s+\(원본:.*)?(?:\s*·\s*캘린더 등록됨)?$/);
    return m ? { key: item.key, date: m[1], time: m[2] || '', title: m[3].trim() } : null;
  }
  function eventBody(ev) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
    const body = { summary: ev.title, description: 'Took에서 승인한 일정', extendedProperties: { private: { tookKey: ev.key } } };
    if (ev.time) {
      const s = new Date(`${ev.date}T${ev.time}:00`);
      const e = new Date(s.getTime() + 60 * 60 * 1000);
      const f = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
      body.start = { dateTime: f(s), timeZone: tz };
      body.end = { dateTime: f(e), timeZone: tz };
    } else {
      const d = new Date(`${ev.date}T00:00:00`);
      const n = new Date(d.getTime() + 24 * 60 * 60 * 1000);
      body.start = { date: ev.date };
      body.end = { date: `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}` };
    }
    return body;
  }

  // ---------- 저장소: 모의 / Drive ----------
  const SAMPLE_BRIEF = '# 복귀 요약 — 모의 모드\n\n> PC 분류 루틴이 만든 요약이 여기에 보입니다.\n\n## 오늘 할 3가지\n1. 예시 할 일 — 예시 아이디어의 다음 행동\n\n## 상태\n- 승인 대기 제안: 0건\n';
  const SAMPLE_LIST = '- example-idea | 예시 아이디어 | 다듬는 중\n';
  const SAMPLE_PROPOSALS = '# 제안 목록\n\n- [ ] [일정] 2026-10-14 예시 약속 (원본: 00_Inbox/예시.md) <!--ex1-->\n' +
    '- [ ] [이동] 00_Inbox/예시2.md → 02_Learning (확신도 0.72) · 예시 메모 <!--ex2-->\n- [x] [이동] 이미 승인된 예시 <!--ex3-->\n';
  const SAMPLE_JUDG = '# 자동 판정 확인\n\n- jx1 | 할 일 | 01_Daily | 0.9 | 세탁소에 코트 맡기기\n- jx2 | 이동 | 02_Learning/01_Concept | 0.92 | CAN 종단 저항 이유 정리\n';
  const SAMPLE_HOLDS = '# 보류\n\n- hx1 | 판단 보류 | 그거 내일 다시 확인\n- hx2 | 안전 검사 | 안전 검사에 걸린 메모 — 내용은 PC에서 확인\n';
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
      if (name === '판정.md') return localStorage.getItem('took-mock-file-판정.md') || SAMPLE_JUDG;
      if (name === '보류.md') return localStorage.getItem('took-mock-file-보류.md') || SAMPLE_HOLDS;
      return name === '목록.md' ? SAMPLE_LIST : name === '제안.md' ? SAMPLE_PROPOSALS : SAMPLE_BRIEF;
    },
    async writeText(name, content) {
      this.check();
      if (name === '승인.md') localStorage.setItem('took-mock-approvals', content);
      else localStorage.setItem('took-mock-file-' + name, content);
    },
    async addEvent(ev) {
      this.check();
      const all = JSON.parse(localStorage.getItem('took-mock-events') || '{}');
      if (!all[ev.key]) all[ev.key] = eventBody(ev);
      localStorage.setItem('took-mock-events', JSON.stringify(all));
      return 'mock-' + ev.key;
    }
  };

  const Drive = {
    label: 'Google Drive',
    tokens: {}, authing: {}, folderId: null,
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
    // 토큰은 이 기기 안(IndexedDB)에 유효시간(약 1시간)까지 보관해 앱을 껐다 켜도 다시 로그인하지 않는다.
    // 로그인 창은 사용자가 누른 동작(저장·다시 불러오기·보내기)에서만 띄운다. 자동으로 띄우면 팝업 차단에 걸린다.
    async auth(interactive, kind) {
      kind = kind || 'drive';
      if (this.authing[kind]) return this.authing[kind];
      this.authing[kind] = this.authInner(interactive, kind).finally(() => { this.authing[kind] = null; });
      return this.authing[kind];
    },
    async authInner(interactive, kind) {
      const SCOPE = { drive: 'https://www.googleapis.com/auth/drive.file', cal: 'https://www.googleapis.com/auth/calendar.events' }[kind];
      const key = kind === 'drive' ? 'token' : 'token-' + kind;
      const tk = this.tokens[kind] || (await get('kv', key));
      if (tk && tk.t && Date.now() < tk.exp - 60000) { this.tokens[kind] = tk; return tk.t; }
      if (!navigator.onLine) throw new Error('오프라인');
      if (!interactive) throw new Error('로그인 필요');
      await this.loadGis();
      const hint = await get('kv', 'hint');                 // 계정 힌트가 있으면 계정 선택 없이 창이 바로 닫힌다
      return new Promise((res, rej) => {
        const c = google.accounts.oauth2.initTokenClient(Object.assign({
          client_id: CFG.clientId,
          scope: SCOPE,
          include_granted_scopes: true,
          prompt: '',
          callback: async r => {
            if (r.error) return rej(new Error('로그인 필요'));
            const v = { t: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
            this.tokens[kind] = v;
            await put('kv', v, key);
            if (!hint) this.rememberHint(v.t);
            res(v.t);
          },
          error_callback: e => rej(new Error('로그인 창이 닫혔거나 막힘' + (e && e.type ? ` (${e.type})` : '')))
        }, hint ? { hint } : {}));
        c.requestAccessToken();
      });
    },
    async rememberHint(token) {
      try {
        const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
          { headers: { Authorization: 'Bearer ' + token } });
        const j = await r.json();
        if (j.user && j.user.emailAddress) await put('kv', j.user.emailAddress, 'hint');   // 이 기기 안에만 둔다
      } catch (e) { /* 힌트가 없어도 동작한다 */ }
    },
    async api(path, opts, interactive) {
      const t = await this.auth(interactive);
      const r = await fetch('https://www.googleapis.com' + path,
        Object.assign({}, opts, { headers: Object.assign({}, (opts && opts.headers) || {}, { Authorization: 'Bearer ' + t }) }));
      if (r.status === 401) { this.tokens.drive = null; await del('kv', 'token'); throw new Error('로그인 만료'); }
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
    },
    async addEvent(ev) {
      const tk = await this.auth(true, 'cal');
      const H = { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' };
      const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
      const found = await fetch(`${base}?privateExtendedProperty=${encodeURIComponent('tookKey=' + ev.key)}&maxResults=1`, { headers: H });
      if (found.status === 401 || found.status === 403) {
        this.tokens.cal = null; await del('kv', 'token-cal');
        throw new Error(found.status === 403 ? '캘린더 권한·API가 꺼져 있음' : '캘린더 로그인 만료');
      }
      const fj = await found.json();
      if (fj.items && fj.items.length) return fj.items[0].id;              // 이미 넣었음
      const r = await fetch(base, { method: 'POST', headers: H, body: JSON.stringify(eventBody(ev)) });
      if (!r.ok) throw new Error('캘린더 등록 실패 ' + r.status);
      return (await r.json()).id;
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
      meta.append(showTime(t), badge);
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

  // 탭을 열 때는 로그인 없이 마지막으로 받은 요약을 먼저 보여 주고, 토큰이 살아 있으면 조용히 새로 받는다.
  // 토큰이 없으면 "다시 불러오기"를 눌렀을 때만 로그인한다.
  async function loadBrief(interactive) {
    const box = $('#brief');
    const cached = await get('kv', 'brief');
    if (cached && !interactive) box.innerHTML = renderMd(cached);
    try {
      const text = await B.readText('복귀요약.md', interactive);
      await put('kv', text, 'brief');
      box.innerHTML = renderMd(text);
    } catch (e) {
      const note = e.message === '로그인 필요'
        ? '최신 요약을 받으려면 아래 "다시 불러오기"를 누르세요'
        : `새로 불러오지 못함: ${esc(e.message)}`;
      box.innerHTML = (cached ? renderMd(cached) : '') + `<p class="msg${cached ? '' : ' err'}">${note}${cached ? ' — 지금 보이는 것은 마지막으로 받은 내용' : ''}</p>`;
    }
  }

  // ---------- 승인 탭: 제안(승인·거절) · 자동 판정 확인(채점) · 보류(결정) ----------
  // 모두 승인.md 한 파일에 "- <key> | <action> | 시각"으로 보내고, PC가 다음 실행에 반영한다.
  //   제안: approve | approve-cal | reject     채점: O | X:<폴더> | S     보류: keep | discard | to:<폴더>
  const FOLDERS = [['01_Daily', '일일 기록·할 일'], ['02_Learning', '학습'], ['02_Learning/01_Concept', '학습 · 개념'],
    ['02_Learning/02_Practice', '학습 · 실습'], ['02_Learning/03_Project_Knowledge', '학습 · 프로젝트 지식'], ['03_Project', '프로젝트'],
    ['03_Project/_아이디어/_씨앗', '아이디어 씨앗'], ['04_Career', '커리어'], ['99_Archive/_폐기후보', '폐기']];
  const folderLabel = f => (FOLDERS.find(x => x[0] === f) || [f, f])[1];
  function parseProposals(md) {
    const out = [];
    for (const line of (md || '').split(/\r?\n/)) {
      const m = line.match(/^\s*-\s*\[([ xX-])\]\s*(.*?)\s*<!--(\S+?)-->\s*$/);
      if (!m) continue;
      const k = m[2].match(/^\[([^\]]+)\]\s*(.*)$/);
      const st = m[1] === ' ' ? 'open' : m[1] === '-' ? 'rejected' : 'approved';
      out.push({ key: m[3], state: st, kind: k ? k[1] : '', text: k ? k[2] : m[2] });
    }
    return out;
  }
  function parseList(md) {                      // 판정.md·보류.md: "- key | 칸 | 칸 …"
    return (md || '').split(/\r?\n/).filter(l => /^\s*-\s+\S+\s*\|/.test(l))
      .map(l => l.replace(/^\s*-\s+/, '').split(/\s*\|\s*/));
  }
  function parseApprovals(md) {
    const map = new Map();
    for (const l of (md || '').split(/\r?\n/)) {
      const m = l.match(/^\s*-\s*(\S+)\s*(?:\|\s*([^|\s]+))?/);
      if (m) map.set(m[1], m[2] && !/^\d{4}-/.test(m[2]) ? m[2] : 'approve');
    }
    return map;
  }
  const ACT = { approve: '승인', 'approve-cal': '승인 · 캘린더에 등록됨', reject: '거절', O: '맞음', S: '민감(AI에 보내면 안 됐음)', keep: '그대로 두기', discard: '버리기' };
  function actLabel(a) {
    if (a.startsWith('X:')) return '틀림 → ' + folderLabel(a.slice(2));
    if (a.startsWith('to:')) return '분류 → ' + folderLabel(a.slice(3));
    return ACT[a] || a;
  }
  const complete = a => !(a === 'X:' || a === 'to:');

  let view = { items: [], judg: [], holds: [], pending: new Map() };
  const choices = new Map();                    // 아직 보내지 않은 선택: key → action

  function sectionHead(ul, title, note) {
    const h = document.createElement('li');
    h.className = 'section-head';
    h.textContent = title;
    if (note) { const s = document.createElement('div'); s.className = 'hint'; s.textContent = note; h.append(s); }
    ul.append(h);
  }
  function card(ul, key, kind, text, buttons, pick) {
    const li = document.createElement('li');
    const body = document.createElement('div');
    if (kind) { const k = document.createElement('span'); k.className = 'kind'; k.textContent = kind; body.append(k); }
    body.append(text);
    li.append(body);
    const acts = document.createElement('div');
    acts.className = 'acts';
    const sent = view.pending.get(key);
    if (sent) {
      li.classList.add('sent');
      const s = document.createElement('div');
      s.className = 'state ' + (sent === 'reject' || sent === 'discard' || sent.startsWith('X') || sent === 'S' ? 'reject' : 'approve');
      s.textContent = (sent === 'approve-cal' ? '' : '보냄: ') + actLabel(sent) + (sent === 'approve-cal' ? '' : ' · 다음 PC 실행 때 반영');
      li.append(s);
      if (sent !== 'approve-cal') {             // 캘린더에 이미 넣은 일정은 되돌리지 않는다(지우려면 캘린더에서 직접)
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.textContent = '되돌리기';
        undo.onclick = () => { view.pending.delete(key); choices.delete(key); renderApprovals(); markDirty(); };
        acts.append(undo);
      }
    } else {
      const cur = choices.get(key) || '';
      for (const [act, label, cls] of buttons) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        const on = act.endsWith(':') ? cur.startsWith(act) : cur === act;
        b.className = 'choice ' + cls + (on ? ' on' : '');
        b.setAttribute('aria-pressed', String(on));
        b.onclick = () => { on ? choices.delete(key) : choices.set(key, act); renderApprovals(); markDirty(); };
        acts.append(b);
      }
      if (pick && cur.startsWith(pick)) {        // 틀림·분류: 맞는 폴더 고르기
        const sel = document.createElement('select');
        sel.innerHTML = '<option value="">어디가 맞나요?</option>' + FOLDERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
        sel.value = cur.slice(pick.length);
        sel.onchange = () => { choices.set(key, pick + sel.value); markDirty(); };
        li.append(acts, sel);
        ul.append(li);
        return;
      }
    }
    li.append(acts);
    ul.append(li);
  }

  function renderApprovals() {
    const ul = $('#proposals');
    ul.textContent = '';
    const open = view.items.filter(i => i.state === 'open').slice(0, 10);   // 한 번에 10개까지(Rule 14장)
    const closed = view.items.filter(i => i.state !== 'open').slice(-3);
    if (!open.length && !view.judg.length && !view.holds.length && !closed.length) {
      ul.innerHTML = '<li>확인할 것이 없습니다.</li>';
      return;
    }
    if (open.length) {
      sectionHead(ul, `제안 ${open.length}건`, 'AI가 확신하지 못한 것. 승인하면 반영, 거절하면 닫힙니다. 일정은 승인 즉시 캘린더에 들어갑니다.');
      for (const it of open) card(ul, it.key, it.kind, it.text, [['approve', '승인', 'approve'], ['reject', '거절', 'reject']]);
    }
    if (view.judg.length) {
      sectionHead(ul, `자동 판정 확인 ${view.judg.length}건`, 'AI가 확신해서 자동으로 처리하려던 것. 맞는지 눌러 주세요(시험 채점, 50건이 모이면 자동 정리를 켤지 판단).');
      for (const [key, verdict, folder, conf, ex] of view.judg) {
        card(ul, key, verdict, `${ex || ''}  → ${folderLabel(folder || '')}${conf ? ` (확신도 ${conf})` : ''}`,
          [['O', '맞음', 'approve'], ['X:', '틀림', 'reject'], ['S', '민감', 'reject']], 'X:');
      }
    }
    if (view.holds.length) {
      sectionHead(ul, `보류 ${view.holds.length}건`, '판단을 미룬 메모. 그대로 두면 30일 뒤 다시 묻습니다.');
      for (const [key, why, ex] of view.holds) {
        card(ul, key, why, ex || '', [['keep', '그대로', ''], ['discard', '버리기', 'reject'], ['to:', '분류', 'approve']], 'to:');
      }
    }
    if (closed.length) {
      const h = document.createElement('li');
      h.className = 'closed-head';
      h.textContent = '최근 처리된 제안';
      ul.append(h);
      for (const it of closed) {
        const li = document.createElement('li');
        li.className = 'closed';
        const s = document.createElement('div');
        s.className = 'state ' + (it.state === 'approved' ? 'approve' : 'reject');
        s.textContent = it.state === 'approved' ? '처리됨 · 승인' : '처리됨 · 거절';
        const b = document.createElement('div');
        b.textContent = `${it.kind ? '[' + it.kind + '] ' : ''}${it.text}`;
        li.append(s, b);
        ul.append(li);
      }
    }
  }
  let dirty = false;
  function markDirty() {
    const n = [...choices.values()].filter(complete).length;
    dirty = n > 0 || dirty;
    $('#sendApprovals').textContent = n ? `보내기 (${n})` : (dirty ? '변경 보내기' : '보내기');
  }

  async function loadApprovals(interactive) {
    const am = $('#approveMsg');
    am.textContent = '';
    const cached = await get('kv', 'approvals-view');
    if (cached && !interactive && cached.judg) {
      view = { items: cached.items, judg: cached.judg, holds: cached.holds, pending: new Map(cached.pending) };
      renderApprovals();
    }
    try {
      // 순서대로 읽는다(동시에 읽으면 로그인 창이 여러 번 뜬다)
      const prop = await B.readText('제안.md', interactive);
      const judg = await B.readText('판정.md', interactive);
      const holds = await B.readText('보류.md', interactive);
      const appr = await B.readText('승인.md', interactive);
      view = { items: parseProposals(prop), judg: parseList(judg), holds: parseList(holds), pending: parseApprovals(appr) };
      const live = new Set([...view.items.filter(i => i.state === 'open').map(i => i.key), ...view.judg.map(r => r[0]), ...view.holds.map(r => r[0])]);
      for (const [k] of view.pending) if (!live.has(k)) view.pending.delete(k);      // PC가 이미 반영한 것
      await put('kv', { items: view.items, judg: view.judg, holds: view.holds, pending: [...view.pending] }, 'approvals-view');
      choices.clear(); dirty = false; markDirty();
      renderApprovals();
    } catch (e) {
      if (!cached) $('#proposals').textContent = '';
      am.className = 'msg' + (e.message === '로그인 필요' ? '' : ' err');
      am.textContent = e.message === '로그인 필요' ? '최신 목록을 받으려면 "다시 불러오기"를 누르세요' : '불러오지 못함: ' + e.message;
    }
  }

  async function sendApprovals() {
    const am = $('#approveMsg');
    const merged = new Map(view.pending);
    const calErrors = [];
    let calOk = 0, skipped = 0;
    for (const [k, v] of choices) {
      if (!complete(v)) { skipped++; continue; }                     // 틀림·분류인데 폴더를 안 고름
      merged.set(k, v);
      const it = view.items.find(i => i.key === k);
      if (v !== 'approve' || !it || it.kind !== '일정') continue;
      const ev = parseEvent(it);
      if (!ev) { calErrors.push('날짜를 못 읽음'); continue; }
      try { await B.addEvent(ev); merged.set(k, 'approve-cal'); calOk++; }
      catch (e) { calErrors.push(e.message); }                 // 실패하면 그냥 승인으로 보내고, PC 요약에 캘린더 추가 링크가 생긴다
    }
    const stamp = localIso(new Date());
    try {
      await B.writeText('승인.md', [...merged].map(([k, v]) => `- ${k} | ${v} | ${stamp}`).join('\n') + (merged.size ? '\n' : ''), true);
      view.pending = merged;
      for (const k of [...choices.keys()]) if (complete(choices.get(k))) choices.delete(k);
      dirty = false; markDirty();
      await put('kv', { items: view.items, judg: view.judg, holds: view.holds, pending: [...merged] }, 'approvals-view');
      renderApprovals();
      am.className = 'msg';
      am.textContent = (merged.size ? `보냄 ${merged.size}건 — 다음 PC 실행 때 반영됩니다` : '보낸 것을 모두 되돌렸습니다')
        + (calOk ? ` · 캘린더에 ${calOk}건 등록` : '') + (calErrors.length ? ` · 캘린더 등록 못 함(${calErrors[0]}) — 요약의 링크로 추가하세요` : '')
        + (skipped ? ` · 폴더를 안 고른 ${skipped}건은 보내지 않음` : '');
    } catch (e) {
      am.className = 'msg err';
      am.textContent = '보내지 못함: ' + e.message;
    }
  }

  // PC에 "지금 분류" 요청: 앱 폴더의 분류요청.md에 한 줄을 쓰면, 켜져 있는 PC가 5분 안에 보고 분류한다
  async function requestRun() {
    const msgs = document.querySelectorAll('.requestMsg');
    const show = (t, err) => msgs.forEach(m => { m.className = 'msg requestMsg' + (err ? ' err' : ''); m.textContent = t; });
    try {
      await B.writeText('분류요청.md', `- ${localIso(new Date())}\n`, true);
      show('요청함 — PC가 켜져 있으면 5분 안에 분류합니다. 잠시 뒤 "다시 불러오기"를 누르세요');
    } catch (e) {
      show('요청하지 못함: ' + e.message, true);
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

  // ---------- 눌렀다는 표시: 버튼은 "…중"으로 바꾸고, 끝나면 화면 아래 알림으로 결과를 보인다 ----------
  let toastTimer = null;
  function toast(text, kind, ms) {
    const t = $('#toast');
    t.textContent = text;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    if (ms !== 0) toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }
  function wire(btn, busyText, fn, msgSel, doneText) {
    if (!btn) return;
    const handler = async e => {
      if (e && e.preventDefault && e.type === 'submit') e.preventDefault();
      if (btn.disabled) return;
      const label = btn.textContent;
      btn.disabled = true;
      btn.classList.add('busy');
      btn.textContent = busyText;
      toast(busyText, '', 0);
      try {
        await fn(e);
      } finally {
        btn.disabled = false;
        btn.classList.remove('busy');
        btn.textContent = label;
        if (btn.id === 'sendApprovals') markDirty();
        if (btn.id === 'save') btn.textContent = editingId ? '수정 저장' : '저장';
        const m = msgSel ? [...document.querySelectorAll(msgSel)].find(x => !x.closest('[hidden]') && x.textContent) : null;
        const err = m && m.classList.contains('err');
        toast((m && m.textContent) || doneText || '완료', err ? 'err' : 'ok');
      }
    };
    btn.addEventListener('click', handler);
  }

  // ---------- 시작 ----------
  function showTab(name) {
    const b = document.querySelector(`nav [data-tab="${name}"]`) || document.querySelector('nav [data-tab="write"]');
    document.querySelectorAll('nav [role=tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    $('#tab-write').hidden = b.dataset.tab !== 'write';
    $('#tab-brief').hidden = b.dataset.tab !== 'brief';
    $('#tab-approve').hidden = b.dataset.tab !== 'approve';
    try { sessionStorage.setItem('tab', b.dataset.tab); } catch (e) { /* 기억 못 해도 동작한다 */ }
    if (b.dataset.tab === 'brief') loadBrief(false);
    if (b.dataset.tab === 'approve') loadApprovals(false);
  }
  function tabs() {
    document.querySelectorAll('nav [role=tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    let last = null;
    try { last = sessionStorage.getItem('tab'); } catch (e) { /* 없음 */ }
    // 공유로 열렸으면 입력 탭, 아니면 이 세션에서 마지막으로 보던 탭으로 돌아간다(새로고침돼도 유지)
    if (last && last !== 'write' && !new URLSearchParams(location.search).toString()) showTab(last);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('#mode').textContent = `${B.label} · ${APP_VERSION}`;
    $('#dev').hidden = !MOCK;
    wire($('#save'), '저장 중…', onSave, '#msg');
    $('#form').addEventListener('submit', e => { e.preventDefault(); $('#save').click(); });   // 입력 칸에서 Enter를 눌러도 같은 경로로
    $('#cancelEdit').addEventListener('click', resetForm);
    wire($('#reloadBrief'), '불러오는 중…', () => loadBrief(true), '#tab-brief .brief .msg', '요약을 새로 불러왔습니다');
    wire($('#sendApprovals'), '보내는 중…', sendApprovals, '#approveMsg');
    wire($('#queue'), '보내는 중…', () => flush(true), '#msg', '대기 중이던 메모를 보냈습니다');
    wire($('#reloadApprovals'), '불러오는 중…', () => loadApprovals(true), '#approveMsg', '제안을 새로 불러왔습니다');
    document.querySelectorAll('.requestRun').forEach(b => wire(b, '요청 중…', requestRun, '.requestMsg'));
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
      // 새 버전이 설치되면 화면을 한 번 새로고침해 바로 적용한다(첫 설치 때는 새로고침하지 않음)
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController && !reloaded) { reloaded = true; location.reload(); }
      });
      navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => {});
    }
  });

  window.__qm = { buildNote, fileName, renderMd, flush, all };   // 시험용
})();

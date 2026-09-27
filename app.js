// KORA 현장 시험 (0단계) — 아이폰 홈 화면 웹앱이 오프라인에서 기록을 안 잃는지 재는 앱
// 원칙: 저장은 두 곳(IndexedDB + localStorage), 전송은 연결되는 순간 자동, 실패는 숨기지 않고 🔴로 보인다.
'use strict';

const VERSION = 'kft-v3 (2026-09-27 · 사진 앨범 선택·큰 칸)';
const HOOK = 'https://hook.us2.make.com/7u7nlm787subvjwkmemfekpu7n293hag'; // 시험 끝나면 삭제하는 받는 곳
const LS_KEY = 'kft_records';
const LS_META = 'kft_meta';

let idb = null;          // IndexedDB 연결 (실패하면 null)
let idbOk = false;
let lsOk = false;
let records = [];        // 화면에 보이는 기록 (사진 제외)
let syncing = false;
let lastSyncErr = '';
let lastSyncAt = '';

// ---------- 기본 정보 ----------
function meta() {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(LS_META) || '{}'); } catch (e) {}
  if (!m.deviceId) m.deviceId = 'dev-' + Math.random().toString(36).slice(2, 8);
  if (!m.seq) m.seq = 0;
  return m;
}
function saveMeta(m) { try { localStorage.setItem(LS_META, JSON.stringify(m)); } catch (e) {} }
const M = meta(); saveMeta(M);

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}
function uid() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
function nowIso() { return new Date().toISOString(); }

// ---------- 저장소 1: IndexedDB ----------
function openIdb() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (db) => { if (!done) { done = true; resolve(db); } };
    try {
      const req = indexedDB.open('kft', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => { idbOk = false; idb = null; render(); };   // iOS 17.4류 「연결 끊김」 감지
        finish(db);
      };
      req.onerror = () => finish(null);
      req.onblocked = () => finish(null);
      setTimeout(() => finish(null), 4000);                         // iOS 14.6류 「첫 열기 멈춤」 감지
    } catch (e) { finish(null); }
  });
}
function idbTx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    if (!idb) return reject(new Error('no idb'));
    try {
      const tx = idb.transaction(store, mode);
      const st = tx.objectStore(store);
      let out;
      const r = fn(st);
      if (r) r.onsuccess = () => { out = r.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    } catch (e) { reject(e); }
  });
}
async function idbPutRecord(rec) { await idbTx('records', 'readwrite', (s) => s.put(rec)); }
async function idbAllRecords() { return (await idbTx('records', 'readonly', (s) => s.getAll())) || []; }
async function idbPutPhoto(id, data) { await idbTx('photos', 'readwrite', (s) => s.put({ id, data })); }
async function idbGetPhoto(id) { const r = await idbTx('photos', 'readonly', (s) => s.get(id)); return r ? r.data : null; }
async function idbDelPhoto(id) { await idbTx('photos', 'readwrite', (s) => s.delete(id)); }

// ---------- 저장소 2: localStorage ----------
function lsAll() {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); lsOk = true; return v; }
  catch (e) { lsOk = false; return []; }
}
function lsWriteAll(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); lsOk = true; }
  catch (e) { lsOk = false; }
}

// 두 저장소를 합친다 — 같은 id면 「보냄」이 이긴다
function merge(a, b) {
  const map = new Map();
  for (const r of [...a, ...b]) {
    const old = map.get(r.id);
    if (!old || (r.status === 'sent' && old.status !== 'sent')) map.set(r.id, r);
  }
  return [...map.values()].sort((x, y) => x.seq - y.seq);
}

async function persistRecord(rec) {
  let wrote = 0;
  if (idb) { try { await idbPutRecord(rec); wrote++; idbOk = true; } catch (e) { idbOk = false; } }
  const list = merge(lsAll().filter((r) => r.id !== rec.id), [rec]);
  lsWriteAll(list);
  if (lsOk) wrote++;
  return wrote; // 0이면 🔴
}

// ---------- 사진 줄이기 (최대 800px · JPEG) ----------
function shrinkPhoto(file) {
  return new Promise((resolve) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 800;
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.6));
      };
      img.onerror = () => resolve(null);
      img.src = reader.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// ---------- 전송 ----------
async function diagSnapshot() {
  let persisted = null, quota = null, usage = null;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) {}
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); quota = e.quota; usage = e.usage; } } catch (e) {}
  return { version: VERSION, ua: navigator.userAgent, standalone: isStandalone(), persisted, quota, usage,
           idbOk, lsOk, online: navigator.onLine, notif: (window.Notification ? Notification.permission : 'none') };
}

// 1순위: 응답을 읽는 보통 전송(서버가 받았는지 확인됨)
// 2순위: 응답을 못 읽으면(CORS) no-cors로 한 번 더 — 전송은 되지만 확인은 못 함 → 「보냄(미확인)」
// 같은 기록이 두 번 갈 수 있다 → 받는 쪽에서 id로 중복 제거
async function postOne(body) {
  try {
    const res = await fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
    let txt = '';
    try { txt = (await res.text()).slice(0, 60); } catch (e) {}
    return { ok: res.ok, verified: true, info: res.status + ' ' + txt };
  } catch (e) {
    if (!navigator.onLine) throw e;
    await fetch(HOOK, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body });
    return { ok: true, verified: false, info: '응답 못 읽음(CORS)' };
  }
}

async function syncNow() {
  if (syncing) return;
  syncing = true;
  try {
    const pending = records.filter((r) => r.status !== 'sent');
    if (!pending.length) { lastSyncErr = ''; return; }
    if (!navigator.onLine) { lastSyncErr = '오프라인'; return; }
    const diag = await diagSnapshot();
    for (const r of pending) {
      let photo = null;
      if (r.hasPhoto && idb) { try { photo = await idbGetPhoto(r.id); } catch (e) {} }
      const payload = { kind: 'kora-field-test', diag, ...r, sentAt: nowIso(), photo };
      try {
        const res = await postOne(JSON.stringify(payload));
        r.attempts = (r.attempts || 0) + 1;
        r.sendInfo = res.info;
        if (!res.ok) {                                   // 서버가 거절 → 폰에 그대로 두고 다음에 다시
          await persistRecord(r);
          lastSyncErr = '서버 거절: ' + res.info;
          break;
        }
        r.status = 'sent'; r.verified = res.verified; r.sentAt = payload.sentAt;
        await persistRecord(r);
        if (r.hasPhoto && idb && res.verified) { try { await idbDelPhoto(r.id); } catch (e) {} }   // 도착이 확인된 사진만 지운다
        lastSyncErr = '';
      } catch (e) {
        r.attempts = (r.attempts || 0) + 1;
        await persistRecord(r);
        lastSyncErr = '전송 실패: ' + (e && e.message ? e.message : e);
        break;
      }
    }
    lastSyncAt = new Date().toLocaleTimeString();
  } finally {
    syncing = false;
    render();
  }
}

// ---------- 화면 ----------
const $ = (s) => document.querySelector(s);
let who = '';
let pp = '';

function segment(sel, onPick) {
  const box = $(sel);
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.dataset.v);
  });
  return box;
}

function render() {
  const storageDead = !idbOk && !lsOk;
  $('#banner').style.display = storageDead ? 'block' : 'none';
  const pending = records.filter((r) => r.status !== 'sent').length;
  const dot = $('#bigdot'), txt = $('#bigtext');
  if (storageDead) { dot.className = 'dot r'; txt.textContent = '🔴 폰에 저장 안 됨 → 종이에 적기'; }
  else if (pending) { dot.className = 'dot y'; txt.textContent = `🟡 폰에 ${pending}건 저장됨 · 연결되면 자동 전송`; }
  else {
    const unver = records.filter((r) => r.status === 'sent' && !r.verified).length;
    dot.className = 'dot g';
    txt.textContent = !records.length ? '🟢 대기 없음'
      : unver ? `🟢 전부 보냄 (${unver}건은 도착 미확인 — Claude가 서버에서 셈)` : '🟢 전부 서버 도착 확인';
  }

  $('#counts').textContent = `${records.length}건 (대기 ${pending})`;
  const list = $('#list'); list.innerHTML = '';
  [...records].reverse().slice(0, 30).forEach((r) => {
    const el = document.createElement('div'); el.className = 'list-item';
    const d = r.status === 'sent' ? 'g' : 'y';
    el.innerHTML = `<span class="dot ${d}"></span><div><div>#${r.seq} ${escapeHtml(r.cust || '(이름 없음)')} · PP ${r.pp || '-'} · TDS ${r.tds || '-'} · ${r.flow || '-'} L/min${r.hasPhoto ? ' · 📷' : ''}</div>
      <div class="meta">${new Date(r.createdAt).toLocaleString()} · ${r.status === 'sent' ? (r.verified ? '도착 확인' : '보냄(미확인)') : '대기'}${r.attempts ? ' · 시도 ' + r.attempts : ''}${r.sendInfo ? ' · ' + escapeHtml(r.sendInfo) : ''}</div></div>`;
    list.appendChild(el);
  });
  renderDiag();
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function renderDiag() {
  const d = await diagSnapshot();
  const mb = (x) => (x == null ? '?' : (x / 1048576).toFixed(1) + 'MB');
  $('#diag').textContent =
    `버전 ${d.version}\n기기 ${M.deviceId} · 사용자 ${who || '(선택 안 함)'}\n홈 화면 앱으로 열림: ${d.standalone ? '예' : '아니오 ← Safari 탭이면 홈 화면에 추가해서 열어줘'}\n` +
    `저장소 보호(persist): ${d.persisted === null ? '지원 안 함' : d.persisted ? '켜짐' : '꺼짐'} · 알림: ${d.notif}\n` +
    `IndexedDB: ${d.idbOk ? '정상' : '실패'} · localStorage: ${d.lsOk ? '정상' : '실패'}\n` +
    `사용량 ${mb(d.usage)} / 한도 ${mb(d.quota)} · 인터넷 ${d.online ? '연결' : '끊김'}\n` +
    `마지막 전송 ${lastSyncAt || '-'} ${lastSyncErr ? '· ' + lastSyncErr : ''}`;
}

async function load() {
  idb = await openIdb();
  idbOk = !!idb;
  let fromIdb = [];
  if (idb) { try { fromIdb = await idbAllRecords(); } catch (e) { idbOk = false; } }
  const fromLs = lsAll();
  records = merge(fromIdb, fromLs);
  // 한쪽에만 있던 기록은 양쪽에 다시 써서 맞춘다
  for (const r of records) { await persistRecord(r); }
  const w = (() => { try { return localStorage.getItem('kft_who') || ''; } catch (e) { return ''; } })();
  if (w) { who = w; document.querySelectorAll('#who button').forEach((b) => b.classList.toggle('on', b.dataset.v === w)); }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  render();
  syncNow();
}

// ---------- 이벤트 ----------
// ---------- 사진: 찍기 / 앨범·파일에서 고르기 ----------
let pickedFile = null;
let previewUrl = null;
function showPhoto(file) {
  pickedFile = file || null;
  if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch (e) {} previewUrl = null; }
  if (pickedFile) {
    previewUrl = URL.createObjectURL(pickedFile);
    $('#previewImg').src = previewUrl;
    $('#preview').style.display = 'block';
  } else {
    $('#previewImg').removeAttribute('src');
    $('#preview').style.display = 'none';
  }
}
function clearPhoto() { $('#photoCam').value = ''; $('#photoGal').value = ''; showPhoto(null); }
$('#camBtn').addEventListener('click', () => $('#photoCam').click());
$('#galBtn').addEventListener('click', () => $('#photoGal').click());
$('#photoCam').addEventListener('change', (e) => showPhoto(e.target.files[0]));
$('#photoGal').addEventListener('change', (e) => showPhoto(e.target.files[0]));
$('#photoClear').addEventListener('click', clearPhoto);

segment('#who', (v) => { who = v; try { localStorage.setItem('kft_who', v); } catch (e) {} renderDiag(); });
segment('#pp', (v) => { pp = v; });

$('#notifBtn').addEventListener('click', async () => {
  try { if (window.Notification && Notification.requestPermission) await Notification.requestPermission(); } catch (e) {}
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  renderDiag();
});

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  M.seq += 1; saveMeta(M);
  const photoData = await shrinkPhoto(pickedFile);
  const rec = {
    id: uid(), seq: M.seq, device: M.deviceId, who, createdAt: nowIso(),
    cust: $('#cust').value.trim(), pp, tds: $('#tds').value, flow: $('#flow').value, memo: $('#memo').value.trim(),
    hasPhoto: !!photoData, status: 'pending', attempts: 0,
  };
  if (photoData && idb) { try { await idbPutPhoto(rec.id, photoData); } catch (e) { rec.hasPhoto = false; } }
  else if (photoData && !idb) { rec.hasPhoto = false; }
  const wrote = await persistRecord(rec);
  records = merge(records, [rec]);
  if (!wrote) { idbOk = false; lsOk = false; }
  $('#f').reset(); pp = ''; document.querySelectorAll('#pp button').forEach((b) => b.classList.remove('on'));
  clearPhoto();
  render();
  syncNow();
});

$('#syncBtn').addEventListener('click', () => syncNow());
// 시험용: 이미 보낸 기록까지 전부 다시 보내기(받는 쪽이 처음에 거절했던 경우 대비)
$('#resendBtn').addEventListener('click', async () => {
  for (const r of records) { r.status = 'pending'; await persistRecord(r); }
  render(); syncNow();
});
window.addEventListener('online', () => syncNow());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 20000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then((reg) => { try { reg.update(); } catch (e) {} }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
}
load();

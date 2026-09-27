// KORA 현장 시험 (0단계) — 아이폰 홈 화면 웹앱이 오프라인에서 기록을 안 잃는지 재는 앱
// 원칙: 저장은 두 곳(IndexedDB + localStorage), 전송은 연결되는 순간 자동, 실패는 숨기지 않고 🔴로 보인다.
'use strict';

const VERSION = 'kft-v1 (2026-09-27)';
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
        // no-cors: 받는 쪽 CORS 설정과 무관하게 전송된다(응답은 못 읽음). 네트워크가 끊기면 여기서 실패한다.
        await fetch(HOOK, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) });
        r.status = 'sent'; r.sentAt = payload.sentAt; r.attempts = (r.attempts || 0) + 1;
        await persistRecord(r);
        if (r.hasPhoto && idb) { try { await idbDelPhoto(r.id); } catch (e) {} }   // 올라간 사진은 폰에서 지운다
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
  else { dot.className = 'dot g'; txt.textContent = records.length ? '🟢 전부 서버에 올라감' : '🟢 대기 없음'; }

  $('#counts').textContent = `${records.length}건 (대기 ${pending})`;
  const list = $('#list'); list.innerHTML = '';
  [...records].reverse().slice(0, 30).forEach((r) => {
    const el = document.createElement('div'); el.className = 'list-item';
    const d = r.status === 'sent' ? 'g' : 'y';
    el.innerHTML = `<span class="dot ${d}"></span><div><div>#${r.seq} ${escapeHtml(r.cust || '(이름 없음)')} · PP ${r.pp || '-'} · TDS ${r.tds || '-'} · ${r.flow || '-'} L/min${r.hasPhoto ? ' · 📷' : ''}</div>
      <div class="meta">${new Date(r.createdAt).toLocaleString()} · ${r.status === 'sent' ? '보냄' : '대기'}${r.attempts ? ' · 시도 ' + r.attempts : ''}</div></div>`;
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
  const photoData = await shrinkPhoto($('#photo').files[0]);
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
  render();
  syncNow();
});

$('#syncBtn').addEventListener('click', () => syncNow());
window.addEventListener('online', () => syncNow());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 20000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
load();

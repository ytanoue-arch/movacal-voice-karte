'use strict';

const $ = (id) => document.getElementById(id);
const el = {
  who: $('who'),
  authCard: $('authCard'), gsiButton: $('gsiButton'), tokenAuth: $('tokenAuth'),
  appToken: $('appToken'), tokenSignin: $('tokenSignin'), authNote: $('authNote'),
  appBody: $('appBody'),
  orcaId: $('orcaId'), idHint: $('idHint'),
  clinic: $('clinic'), clinicField: $('clinicField'),
  recordBtn: $('recordBtn'), recLabel: document.querySelector('.record-label'),
  timer: $('timer'), recStatus: $('recStatus'),
  modal: $('modal'), modalClose: $('modalClose'), modalPatient: $('modalPatient'),
  note: $('note'), charCount: $('charCount'),
  copyBtn: $('copyBtn'), execBtn: $('execBtn'), msg: $('msg'),
};

const MAX_MS = 10 * 60 * 1000;

let authMode = 'open';
let googleClientId = '';
let authToken = '';        // Google ID トークン または 共有トークン（メモリ保持）
let currentUser = '';
let target = 'karte';
let clinicSelectorOn = false; // CLINIC_SELECTOR=1 のときだけ診療所セレクタを表示

let urlClinicId = '';
let urlClinicCode = '';
let urlClinicName = '';   // MOVACALヘッダーの診療所名（自動判別用）
let pendingOrcaId = '';   // ブックマークレットから引き継いだ患者ID（ログイン後に再反映）

let mediaRecorder = null, mediaStream = null, chunks = [], recMime = '';
let startedAt = 0, timerInt = null, autoStopTimer = null, busy = false;

// ---------- 起動 ----------
init();
async function init() {
  // ブックマークレットから渡された患者ID等
  const q = new URLSearchParams(location.search);
  const id = q.get('orcaId') || q.get('orca_id') || '';
  if (id) {
    pendingOrcaId = id.replace(/[^0-9A-Za-z_-]/g, '');
    el.orcaId.value = pendingOrcaId;
    el.idHint.textContent = 'カルテ画面から取得しました';
    el.idHint.className = 'id-hint ok';
  } else {
    el.idHint.textContent = 'カルテ画面のブックマークレットから開くと自動入力されます';
  }
  urlClinicId = q.get('clinicId') || '';
  urlClinicCode = q.get('clinicCode') || '';
  urlClinicName = q.get('clinicName') || '';

  try {
    const cfg = await (await fetch('/api/config')).json();
    authMode = cfg.auth; googleClientId = cfg.googleClientId || '';
    clinicSelectorOn = !!cfg.clinicSelector;
  } catch { authMode = 'open'; }

  if (authMode === 'google') { if (!restoreGoogleSession()) setupGoogle(); }
  else if (authMode === 'token') { if (!restoreTokenSession()) setupToken(); }
  else showApp(); // open（ローカル開発）
}

// ---------- 認証: Google Workspace ----------
let pendingGoogle = false;
window.onGoogleLibraryLoad = function () { if (pendingGoogle) renderGoogle(); };
function gsiLoaded() { return !!(window.google && google.accounts && google.accounts.id); }

function setupGoogle() {
  el.authCard.hidden = false;
  el.appBody.hidden = true;
  el.tokenAuth.hidden = true;
  el.gsiButton.hidden = false;
  el.gsiButton.innerHTML = '';
  el.authNote.textContent = '職場の Google Workspace アカウントでサインインしてください。許可されたドメインのみ利用できます。';
  if (gsiLoaded()) { renderGoogle(); return; }
  // ライブラリ未ロード：公式フック + 保険のポーリング（順序の取りこぼし防止）
  pendingGoogle = true;
  let n = 0;
  const t = setInterval(() => {
    if (gsiLoaded()) { clearInterval(t); renderGoogle(); }
    else if (++n > 50) { clearInterval(t); el.authNote.textContent = 'サインインの読み込みに失敗しました。画面を再読み込みしてください。'; }
  }, 200);
}

function renderGoogle() {
  pendingGoogle = false;
  if (!gsiLoaded()) return;
  google.accounts.id.initialize({ client_id: googleClientId, callback: onGoogleCredential, auto_select: true, itp_support: true });
  const draw = () => {
    el.gsiButton.innerHTML = '';
    google.accounts.id.renderButton(el.gsiButton, { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ja' });
  };
  draw();
  try { google.accounts.id.prompt(); } catch (e) { /* noop */ }
  // 0幅・空描画の保険：未描画なら再描画する
  requestAnimationFrame(() => { if (!el.gsiButton.firstChild) draw(); });
  setTimeout(() => { if (!el.gsiButton.firstChild) draw(); }, 700);
}
function onGoogleCredential(resp) {
  authToken = resp.credential;
  saveSession('mvk_gtoken', resp.credential);
  try { currentUser = JSON.parse(atob(resp.credential.split('.')[1])).email || ''; } catch { /* */ }
  el.who.textContent = currentUser;
  showApp();
}
function reauth() {
  if (authMode === 'google') {
    clearSession('mvk_gtoken'); authToken = ''; setupGoogle();
  } else if (authMode === 'token') {
    authToken = ''; showAuth();
  }
}

// ---------- セッション保持（再ログインを減らす） ----------
function jwtExpMs(jwt) { try { return (JSON.parse(atob(jwt.split('.')[1])).exp || 0) * 1000; } catch { return 0; } }
function saveSession(k, v) { try { localStorage.setItem(k, v); } catch { /* */ } }
function readSession(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function clearSession(k) { try { localStorage.removeItem(k); } catch { /* */ } }

function restoreGoogleSession() {
  const tok = readSession('mvk_gtoken');
  if (!tok) return false;
  if (jwtExpMs(tok) < Date.now() + 60000) { clearSession('mvk_gtoken'); return false; } // 期限切れ間近は無効
  authToken = tok;
  try { currentUser = JSON.parse(atob(tok.split('.')[1])).email || ''; } catch { /* */ }
  el.who.textContent = currentUser;
  showApp();
  return true;
}
function restoreTokenSession() {
  const t = readSession('mvk_token') || sessionStorage.getItem('mvk_token') || '';
  if (!t) return false;
  authToken = t; el.who.textContent = 'サインイン中';
  showApp();
  return true;
}

// ---------- 認証: 共有トークン ----------
function setupToken() {
  el.authCard.hidden = false;
  el.gsiButton.hidden = true;
  el.tokenAuth.hidden = false;
  el.authNote.textContent = 'APP_TOKEN を入力してサインインしてください。';
  const saved = sessionStorage.getItem('mvk_token');
  if (saved) el.appToken.value = saved;
}
el.tokenSignin.addEventListener('click', () => {
  const t = el.appToken.value.trim();
  if (!t) return;
  authToken = t; sessionStorage.setItem('mvk_token', t); saveSession('mvk_token', t);
  el.who.textContent = 'サインイン中';
  showApp();
});

function showAuth() { el.authCard.hidden = false; el.appBody.hidden = true; }
function showApp() {
  el.authCard.hidden = true; el.appBody.hidden = false;
  if (pendingOrcaId) {
    el.orcaId.value = pendingOrcaId;
    el.idHint.textContent = 'カルテ画面から取得しました';
    el.idHint.className = 'id-hint ok';
  }
  refreshRecordEnabled(); loadClinics();
}

async function loadClinics() {
  if (!clinicSelectorOn) { el.clinicField.hidden = true; return; }
  try {
    const r = await fetch('/api/clinics', { headers: authHeaders() });
    if (!r.ok) return;
    const d = await r.json();
    if (!d.clinics || !d.clinics.length) { el.clinicField.hidden = true; return; }
    el.clinicField.hidden = false;
    el.clinic.innerHTML = '';
    d.clinics.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      el.clinic.appendChild(o);
    });
    // MOVACALヘッダーの診療所名から自動判別（例:「やまと在宅診療所あゆみ仙台」→ あゆみ仙台）
    let matchedClinicId = '';
    if (urlClinicName) {
      const hit = d.clinics.find((c) => c.name && urlClinicName.indexOf(c.name) >= 0);
      if (hit) matchedClinicId = hit.id;
    }
    const pre = urlClinicId || matchedClinicId || readSession('mvk_clinic') || d.default || '';
    if (pre) el.clinic.value = pre;
    el.clinic.onchange = () => saveSession('mvk_clinic', el.clinic.value);
  } catch { /* 単一院運用（レジストリ無し）はそのまま */ }
}

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (authToken) h['Authorization'] = 'Bearer ' + authToken;
  return h;
}

// ---------- 録音可否 ----------
function refreshRecordEnabled() {
  if (isRecording()) return;
  el.recordBtn.disabled = busy;
  el.recStatus.textContent = '録音できます';
}
function isRecording() { return mediaRecorder && mediaRecorder.state === 'recording'; }

// ---------- iOS 録音形式 ----------
function pickMime() {
  const prefs = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
  if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === 'function') {
    for (const m of prefs) if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

// ---------- 録音 ----------
el.recordBtn.addEventListener('click', async () => { if (isRecording()) stopRecording(); else await startRecording(); });

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setRecStatus('この端末/ブラウザは録音に未対応です（HTTPSで開いていますか？）', true); return;
  }
  try { mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { setRecStatus('マイクが許可されませんでした。設定アプリとSafariの許可を確認してください。', true); return; }

  recMime = pickMime();
  try { mediaRecorder = recMime ? new MediaRecorder(mediaStream, { mimeType: recMime }) : new MediaRecorder(mediaStream); }
  catch { mediaRecorder = new MediaRecorder(mediaStream); }
  chunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = handleStop;
  mediaRecorder.start();

  el.recordBtn.classList.add('recording');
  el.recordBtn.setAttribute('aria-pressed', 'true');
  el.recLabel.textContent = '停止';
  el.recStatus.textContent = '録音中…';
  startedAt = Date.now(); tick();
  timerInt = setInterval(tick, 250);
  autoStopTimer = setTimeout(() => { if (isRecording()) { setRecStatus('10分で自動停止しました', false); stopRecording(); } }, MAX_MS);
}
function tick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  el.timer.textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  clearInterval(timerInt); timerInt = null;
  clearTimeout(autoStopTimer); autoStopTimer = null;
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  el.recordBtn.classList.remove('recording');
  el.recordBtn.setAttribute('aria-pressed', 'false');
  el.recLabel.textContent = '録音開始';
}
async function handleStop() {
  const type = (mediaRecorder && mediaRecorder.mimeType) || recMime || (chunks[0] && chunks[0].type) || 'audio/mp4';
  const blob = new Blob(chunks, { type });
  chunks = [];
  if (blob.size < 1000) { setRecStatus('録音データがありません。もう一度お試しください。', true); return; }
  await sendForDictation(blob, type.split(';')[0]);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('読み込み失敗'));
    r.readAsDataURL(blob);
  });
}

async function sendForDictation(blob, mimeType) {
  setBusy(true);
  setRecStatus('整形中…', false);
  try {
    const audio = await blobToBase64(blob);
    const res = await fetch('/api/dictate', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ audio, mimeType }) });
    if (res.status === 401) {
      const d = await res.json().catch(() => ({}));
      alert('認証エラー（この文言を共有してください）:\n' + (d.detail || d.error || '不明'));
      setRecStatus('認証エラー（再ログイン）', true);
      reauth();
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `エラー ${res.status}`);

    const note = (data.note || '').trim();
    openModal(note); // 別画面(ポップアップ)で編集
    el.timer.textContent = '00:00';
    setRecStatus('完了', false);
  } catch (e) {
    setRecStatus('整形に失敗: ' + (e.message || e), true);
  } finally {
    setBusy(false);
  }
}
function setBusy(b) { busy = b; el.recordBtn.disabled = b; }
function setRecStatus(t, isErr) { el.recStatus.textContent = t; el.recStatus.style.color = isErr ? 'var(--rec)' : ''; }

// ---------- 結果ポップアップ ----------
function openModal(note) {
  // 分割録音は追記
  if (!el.modal.hidden && el.note.value.trim()) {
    el.note.value = el.note.value.replace(/\s+$/, '') + '\n' + note;
  } else {
    el.note.value = note;
  }
  el.modalPatient.textContent = 'ORCA ID: ' + (el.orcaId.value || '—');
  updateCharCount();
  el.modal.hidden = false;
  setMsg('整形しました。確認・修正してください。', 'ok');
}
function closeModal(clear) {
  if (clear) el.note.value = ''; // 実行後/破棄で削除
  el.modal.hidden = true;
  setMsg('', '');
  if (clear) { refreshRecordEnabled(); }
}
el.note.addEventListener('input', updateCharCount);
function updateCharCount() { el.charCount.textContent = `${el.note.value.length} 文字`; }

el.modalClose.addEventListener('click', () => {
  if (el.note.value.trim() && !confirm('下書きを破棄します。よろしいですか？')) return;
  closeModal(true);
});

// 書き込み先セグメント
document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-checked', 'false'); });
    btn.classList.add('active'); btn.setAttribute('aria-checked', 'true');
    target = btn.dataset.target;
  });
});

// コピー（モーダルは開いたまま）
el.copyBtn.addEventListener('click', async () => {
  const text = el.note.value;
  if (!text.trim()) { setMsg('コピーする内容がありません。', 'err'); return; }
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else { el.note.focus(); el.note.select(); document.execCommand('copy'); window.getSelection().removeAllRanges(); }
    setMsg('コピーしました。MOVACALに貼り付けてください。（閉じると下書きは削除されます）', 'ok');
  } catch { setMsg('コピーに失敗しました。テキストを長押ししてコピーしてください。', 'err'); }
});

// 登録して実行
el.execBtn.addEventListener('click', async () => {
  const content = el.note.value.trim();
  const orcaId = el.orcaId.value.trim();
  if (!content) { setMsg('登録する本文がありません。', 'err'); return; }
  if (!orcaId) { setMsg('ORCA ID を入力してください。', 'err'); return; }
  const where = target === 'memo' ? 'メモ' : (target === 'oncall' ? 'オンコール' : 'カルテ本文');
  const verb = target === 'karte' ? '本日のカルテのA/P欄に追記' : '登録';
  if (!confirm(`ORCA ID ${orcaId} の【${where}】に${verb}します。よろしいですか？`)) return;

  const orig = el.execBtn.textContent;
  el.execBtn.disabled = true; el.copyBtn.disabled = true;
  el.execBtn.innerHTML = '<span class="spin"></span>登録中';
  setMsg(`${where}に登録しています…`, 'info');

  const now = new Date();
  const actDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  try {
    const res = await fetch('/api/register', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        target, orcaId, content,
        actDate, startTime: time, endTime: time,
        clinicId: clinicSelectorOn ? (el.clinic.value || undefined) : (urlClinicId || undefined),
      }),
    });
    if (res.status === 401) { setMsg('再ログインが必要です。', 'err'); reauth(); return; }
    if (res.status === 403) { setMsg('このアカウントは許可されていません。', 'err'); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.detail || data.error || `エラー ${res.status}`);

    const kid = data.result && (data.result.insert_id || data.result.insertId || data.result.org_karte_id);
    if (clinicSelectorOn && el.clinic.value) saveSession('mvk_clinic', el.clinic.value); // 実行した診療所を記憶
    const okMsg = target === 'karte'
      ? `本日のカルテのA/P欄に追記しました${kid ? `（カルテID: ${kid}）` : ''}。MOVACALで確認してください。`
      : `${where}に登録しました${kid ? `（カルテID: ${kid}）` : ''}。MOVACALで確認してください。`;
    alert(okMsg);
    closeModal(true); // 実行後は削除
  } catch (e) {
    setMsg('登録に失敗しました: ' + (e.message || e), 'err');
  } finally {
    el.execBtn.textContent = orig;
    el.execBtn.disabled = false; el.copyBtn.disabled = false;
  }
});

function setMsg(t, kind) { el.msg.textContent = t || ''; el.msg.className = 'msg' + (kind ? ' ' + kind : ''); }
function pad(n) { return String(n).padStart(2, '0'); }

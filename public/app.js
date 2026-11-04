'use strict';

const $ = (id) => document.getElementById(id);
const el = {
  who: $('who'),
  authCard: $('authCard'), gsiButton: $('gsiButton'), authNote: $('authNote'),
  requestBox: $('requestBox'), requestLink: $('requestLink'),
  appBody: $('appBody'),
  orcaId: $('orcaId'), idHint: $('idHint'),
  clinic: $('clinic'), clinicField: $('clinicField'),
  recordBtn: $('recordBtn'), recLabel: document.querySelector('.record-label'),
  timer: $('timer'), recStatus: $('recStatus'),
  modal: $('modal'), modalClose: $('modalClose'),
  mClinic: $('mClinic'), mOrca: $('mOrca'), ptCheck: $('ptCheck'),
  ptConflict: $('ptConflict'), useScreen: $('useScreen'), useSpoken: $('useSpoken'),
  note: $('note'), charCount: $('charCount'),
  copyBtn: $('copyBtn'), execBtn: $('execBtn'), msg: $('msg'),
};

const MAX_MS = 10 * 60 * 1000;

let authMode = 'open';
let googleClientId = '';
let accessRequestUrl = '';  // 利用申請フォーム（設定があるときだけ案内を出す）
let authToken = '';        // Google ID トークン または 共有トークン（メモリ保持）
let currentUser = '';
let target = 'karte';
let clinicSelectorOn = false; // CLINIC_SELECTOR=1 のときだけ診療所セレクタを表示

let urlClinicId = '';
let urlClinicCode = '';
let urlClinicName = '';   // MOVACALヘッダーの診療所名（自動判別用）
let pendingOrcaId = '';   // ブックマークレットから引き継いだ患者ID（ログイン後に再反映）
let clinicExplicit = false; // 診療所がブックマーク or 手動選択で明示されたか（音声との食い違い判定に使う）

// 患者の本人確認（取り違え防止）
let pt = { key: '', ok: false, pending: false, notFound: false, error: '', info: null };
let ptSeq = 0, ptTimer = null;
let conflict = null;        // { screen:{clinicId,orcaId}, spoken:{clinicId,orcaId} }
let registering = false;

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
    accessRequestUrl = cfg.accessRequestUrl || '';
    clinicSelectorOn = !!cfg.clinicSelector;
  } catch { authMode = 'error'; }

  if (authMode === 'google') { if (!restoreGoogleSession()) setupGoogle(); }
  else if (authMode === 'open') showApp(); // 開発時のみ（MOCK / ALLOW_OPEN）
  else showStopped(authMode === 'disabled'
    ? 'サーバーの認証設定が見つからないため、安全のため停止しています。管理者（DXチーム）に連絡してください。'
    : 'サーバーに接続できませんでした。通信状況を確認して、再読み込みしてください。');
}

// ---------- 認証: Google Workspace ----------
let pendingGoogle = false;
window.onGoogleLibraryLoad = function () { if (pendingGoogle) renderGoogle(); };
function gsiLoaded() { return !!(window.google && google.accounts && google.accounts.id); }

function setupGoogle() {
  el.authCard.hidden = false;
  el.appBody.hidden = true;
  el.gsiButton.hidden = false;
  el.gsiButton.innerHTML = '';
  el.authNote.className = 'auth-note';
  el.authNote.textContent = '職場の Google Workspace アカウントでサインインしてください。許可された利用者のみ使えます。';
  showRequestBox();
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
  if (authMode === 'google') { clearSession('mvk_gtoken'); authToken = ''; setupGoogle(); }
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
  if (!clinicSelectorOn) { el.clinicField.hidden = true; el.mClinic.hidden = true; verifyPatient(); return; }
  try {
    const r = await fetch('/api/clinics', { headers: authHeaders() });
    if (r.status === 403) { showDenied(); return; }
    if (!r.ok) { verifyPatient(); return; }
    const d = await r.json();
    if (!d.clinics || !d.clinics.length) { el.clinicField.hidden = true; el.mClinic.hidden = true; verifyPatient(); return; }
    el.clinicField.hidden = false;
    el.clinic.innerHTML = ''; el.mClinic.innerHTML = '';
    d.clinics.forEach((c) => {
      for (const sel of [el.clinic, el.mClinic]) {
        const o = document.createElement('option');
        o.value = c.id; o.textContent = c.name;
        sel.appendChild(o);
      }
    });
    // MOVACALヘッダーの診療所名から自動判別（例:「やまと在宅診療所あゆみ仙台」→ あゆみ仙台）
    let matchedClinicId = '';
    if (urlClinicName) {
      const hit = d.clinics.find((c) => c.name && urlClinicName.indexOf(c.name) >= 0);
      if (hit) matchedClinicId = hit.id;
    }
    const pre = urlClinicId || matchedClinicId || readSession('mvk_clinic') || d.default || '';
    if (pre) el.clinic.value = pre;
    if (urlClinicId || matchedClinicId) clinicExplicit = true;
    el.mClinic.value = el.clinic.value;
    el.clinic.onchange = () => { clinicExplicit = true; saveSession('mvk_clinic', el.clinic.value); el.mClinic.value = el.clinic.value; scheduleVerify(0); };
  } catch { /* 単一院運用（レジストリ無し）はそのまま */ }
  verifyPatient();
}

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (authToken) h['X-App-Auth'] = 'Bearer ' + authToken; // Authorization は IAP が使うため避ける
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
    if (res.status === 403) { showDenied(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `エラー ${res.status}`);

    const note = (data.note || '').trim();
    const spokenMsg = applySpoken(data.spoken);
    openModal(note); // 別画面(ポップアップ)で編集
    if (spokenMsg) setMsg(spokenMsg.text, spokenMsg.kind);
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
  el.mOrca.value = el.orcaId.value;
  if (clinicSelectorOn) el.mClinic.value = el.clinic.value;
  updateCharCount();
  el.modal.hidden = false;
  setMsg('整形しました。患者と内容を確認してください。', 'ok');
  renderConflict();
  verifyPatient();
}
function closeModal(clear) {
  if (clear) { el.note.value = ''; conflict = null; renderConflict(); } // 実行後/破棄で削除
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
  const orcaId = normId(el.orcaId.value);
  if (!content) { setMsg('登録する本文がありません。', 'err'); return; }
  if (!orcaId) { setMsg('患者IDを入力してください。', 'err'); return; }
  if (conflict) { setMsg('画面と音声で患者が異なります。どちらに記載するか選んでください。', 'err'); return; }
  if (!pt.ok || pt.key !== ptKey()) { setMsg('患者の確認が取れていないため登録できません。', 'err'); return; }
  const where = target === 'memo' ? 'メモ' : (target === 'oncall' ? 'オンコール' : 'カルテ本文');
  const verb = target === 'karte' ? '本日のカルテのA/P欄に追記' : '登録';
  const who = `${clinicLabel(el.clinic.value)} ID ${orcaId}\n${pt.info.name} 様${pt.info.age != null ? `（${pt.info.age}歳）` : ''}`;
  if (!confirm(`${who}\n\nこの患者の【${where}】に${verb}します。よろしいですか？`)) return;

  const orig = el.execBtn.textContent;
  registering = true;
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
    if (res.status === 403) { showDenied(); return; }
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
    registering = false;
    el.copyBtn.disabled = false;
    updateExecEnabled();
  }
});

function setMsg(t, kind) { el.msg.textContent = t || ''; el.msg.className = 'msg' + (kind ? ' ' + kind : ''); }
function pad(n) { return String(n).padStart(2, '0'); }

// ---------- 患者の特定と本人確認（取り違え防止） ----------
function normId(v) {
  return String(v || '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　\-ー－‐]/g, '')
    .replace(/[^0-9A-Za-z_]/g, '');
}
function ptKey() { return `${clinicSelectorOn ? el.clinic.value : ''}|${normId(el.orcaId.value)}`; }
function clinicLabel(id) {
  if (!clinicSelectorOn) return '';
  const o = Array.from(el.clinic.options).find((x) => x.value === String(id));
  return o ? o.textContent : '';
}

function setPatientFields(clinicId, orcaId) {
  if (clinicSelectorOn && clinicId && Array.from(el.clinic.options).some((o) => o.value === String(clinicId))) {
    el.clinic.value = String(clinicId); el.mClinic.value = String(clinicId);
  }
  el.orcaId.value = orcaId || ''; el.mOrca.value = orcaId || '';
  verifyPatient();
}

// 音声で読み取った診療所・IDを反映。画面の値と食い違えば上書きせず選ばせる。
function applySpoken(sp) {
  if (!sp) return null;
  const screen = { clinicId: clinicSelectorOn ? el.clinic.value : '', orcaId: normId(el.orcaId.value) };
  const next = { clinicId: screen.clinicId, orcaId: screen.orcaId };
  if (clinicSelectorOn && sp.clinicId) next.clinicId = sp.clinicId;
  if (sp.orcaId) next.orcaId = sp.orcaId;

  const idDiff = !!(screen.orcaId && sp.orcaId && screen.orcaId !== sp.orcaId);
  const clinicDiff = !!(clinicSelectorOn && clinicExplicit && sp.clinicId && screen.clinicId && screen.clinicId !== sp.clinicId);
  let unknownClinic = '';
  if (sp.clinicText && !sp.clinicId) unknownClinic = `「${sp.clinicText}」に該当する診療所が分かりませんでした。診療所を選択してください。`;

  if (idDiff || clinicDiff) {
    conflict = { screen, spoken: next };
    return { text: '画面と音声で患者が異なります。上でどちらに記載するか選んでください。', kind: 'err' };
  }
  conflict = null;
  setPatientFields(next.clinicId, next.orcaId);
  if (unknownClinic) return { text: unknownClinic, kind: 'err' };
  return { text: '音声から患者を読み取りました。氏名が正しいか確認してください。', kind: 'ok' };
}

function renderConflict() {
  if (!conflict) { el.ptConflict.hidden = true; updateExecEnabled(); return; }
  const lab = (x) => `${clinicLabel(x.clinicId) ? clinicLabel(x.clinicId) + ' ' : ''}ID ${x.orcaId || '—'}`;
  el.useScreen.textContent = '画面の患者：' + lab(conflict.screen);
  el.useSpoken.textContent = '音声の患者：' + lab(conflict.spoken);
  el.ptConflict.hidden = false;
  updateExecEnabled();
}
el.useScreen.addEventListener('click', () => { const c = conflict; conflict = null; renderConflict(); setPatientFields(c.screen.clinicId, c.screen.orcaId); setMsg('画面の患者に記載します。氏名を確認してください。', 'ok'); });
el.useSpoken.addEventListener('click', () => { const c = conflict; conflict = null; renderConflict(); setPatientFields(c.spoken.clinicId, c.spoken.orcaId); setMsg('音声の患者に記載します。氏名を確認してください。', 'ok'); });

// 入力欄の同期（メイン画面 ⇄ ポップアップ）
el.orcaId.addEventListener('input', () => { el.mOrca.value = el.orcaId.value; scheduleVerify(600); });
el.mOrca.addEventListener('input', () => { el.orcaId.value = el.mOrca.value; scheduleVerify(600); });
el.mClinic.addEventListener('change', () => {
  el.clinic.value = el.mClinic.value; clinicExplicit = true;
  saveSession('mvk_clinic', el.clinic.value); scheduleVerify(0);
});

function scheduleVerify(ms) { clearTimeout(ptTimer); pt.ok = false; updateExecEnabled(); ptTimer = setTimeout(verifyPatient, ms); }

async function verifyPatient() {
  clearTimeout(ptTimer);
  const orcaId = normId(el.orcaId.value);
  const key = ptKey();
  if (!orcaId) { pt = { key, ok: false }; renderPatient(); return; }
  if (pt.key === key && !pt.pending && (pt.ok || pt.notFound)) { renderPatient(); return; } // 確認済み
  const seq = ++ptSeq;
  pt = { key, ok: false, pending: true };
  renderPatient();
  try {
    const clinicId = clinicSelectorOn ? (el.clinic.value || undefined) : undefined;
    const r = await fetch('/api/patient', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ orcaId, clinicId }) });
    if (seq !== ptSeq) return;
    if (r.status === 401) { pt = { key, ok: false, error: '再ログインが必要です' }; renderPatient(); reauth(); return; }
    if (r.status === 403) { showDenied(); return; }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) pt = { key, ok: false, error: d.error || `確認エラー ${r.status}` };
    else if (d.found) pt = { key, ok: true, info: d };
    else pt = { key, ok: false, notFound: true };
  } catch {
    if (seq !== ptSeq) return;
    pt = { key, ok: false, error: '通信エラーで確認できませんでした' };
  }
  renderPatient();
}

function renderPatient() {
  const id = normId(el.orcaId.value);
  const cl = clinicLabel(el.clinic.value);
  const where = `${cl ? cl + ' ' : ''}ID ${id}`;
  let text = '', cls = 'pt-check', hint = '', hintCls = 'id-hint';
  if (!id) { text = '患者IDを入力してください'; hint = '冒頭で診療所名とIDを話すか、カルテ画面のブックマークから開いてください'; }
  else if (pt.pending) { text = `${where} を確認中…`; hint = text; }
  else if (pt.ok && pt.info) {
    const i = pt.info;
    const attrs = [i.age != null ? `${i.age}歳` : '', i.gender].filter(Boolean).join('・');
    const st = i.status && i.status !== 'ACTIVE' ? `（ステータス: ${i.status}）` : '';
    text = `✓ ${i.name} 様${attrs ? `（${attrs}）` : ''}`;
    cls += ' ok';
    hint = `${where}　${i.name} 様${attrs ? `（${attrs}）` : ''}${st}`; hintCls += ' ok';
    el.ptCheck.innerHTML = '';
    el.ptCheck.className = cls;
    el.ptCheck.append(document.createTextNode(text));
    const sub = document.createElement('span'); sub.className = 'pt-sub';
    sub.textContent = `${where}${i.kana ? '　' + i.kana : ''}${st}`;
    el.ptCheck.append(sub);
    el.idHint.textContent = hint; el.idHint.className = hintCls;
    updateExecEnabled();
    return;
  }
  else if (pt.notFound) { text = `✗ ${where} の患者は見つかりません。診療所とIDを確認してください。`; cls += ' err'; hint = text; hintCls += ' err'; }
  else if (pt.error) { text = `✗ ${pt.error}（登録できません）`; cls += ' err'; hint = text; hintCls += ' err'; }
  el.ptCheck.textContent = text; el.ptCheck.className = cls;
  el.idHint.textContent = hint; el.idHint.className = hintCls;
  updateExecEnabled();
}

function updateExecEnabled() {
  const ready = pt.ok && pt.key === ptKey() && !conflict && !registering;
  el.execBtn.disabled = !ready;
}

// 認証設定が無い・接続できないときは、アプリを開かずに停止表示
function showStopped(text) {
  el.authCard.hidden = false; el.appBody.hidden = true;
  el.gsiButton.hidden = true; el.requestBox.hidden = true;
  el.authNote.className = 'auth-note';
  el.authNote.textContent = text;
}

// 利用申請フォームの案内（URLが設定されているときだけ表示）
function showRequestBox() {
  if (!accessRequestUrl) { el.requestBox.hidden = true; return; }
  el.requestLink.href = accessRequestUrl;
  el.requestBox.hidden = false;
}

// サインインはできたが利用権限がない（グループ未登録など）
function showDenied() {
  clearSession('mvk_gtoken'); authToken = '';
  el.appBody.hidden = true; el.modal.hidden = true;
  el.authCard.hidden = false; el.gsiButton.hidden = true;
  el.authNote.className = 'auth-note err';
  el.authNote.textContent = `${currentUser ? currentUser + ' ' : ''}このアカウントには音声カルテの利用権限がありません。` +
    (accessRequestUrl ? '利用には申請が必要です。' : 'DXチームに連絡してください。');
  showRequestBox();
}

'use strict';

/**
 * MOVACAL WebAPI クライアント
 *
 * 認証（既存の動作コード prescription_ocr_system_fixed.py に準拠）:
 *   random    = base64(MOVACAL_PASSWORD)
 *   signature = base64( hex( HMAC-SHA256(key=MOVACAL_PRIVATE_KEY, msg=MOVACAL_PASSWORD) ) )
 *   POST credential.php { provider, random, signature } -> { credential }
 *
 * 書き込み先:
 *   - カルテ本文(主訴) : postDiagObjective.php   objective 最大32768文字
 *   - メモ            : postMemo.php           memo_info.{orca_id, user_name(必須), memo, reg_date, reg_time}
 */

const crypto = require('crypto');

const MOVACAL_BASE = process.env.MOVACAL_BASE_URL || 'https://link.movacal.net';

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} が未設定です`);
  return v;
}

function createSignature() {
  const password = need('MOVACAL_PASSWORD');
  const privateKey = need('MOVACAL_PRIVATE_KEY');
  const random = Buffer.from(password, 'utf8').toString('base64');
  const hex = crypto.createHmac('sha256', privateKey).update(password, 'utf8').digest('hex');
  const signature = Buffer.from(hex, 'utf8').toString('base64');
  return { random, signature };
}

function basicAuthPair() {
  // 接続事業者(provider)単位の Basic 認証（全院共通）
  // 形式1: MOVACAL_BASIC_AUTH="user:pass"
  // 形式2: MOVACAL_BASIC_AUTH_USER / MOVACAL_BASIC_AUTH_PASS
  if (process.env.MOVACAL_BASIC_AUTH) return process.env.MOVACAL_BASIC_AUTH;
  const u = process.env.MOVACAL_BASIC_AUTH_USER;
  const p = process.env.MOVACAL_BASIC_AUTH_PASS;
  if (u && p) return `${u}:${p}`;
  return null;
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json;charset=utf-8' };
  const pair = basicAuthPair();
  if (pair) {
    headers['Authorization'] = 'Basic ' + Buffer.from(pair, 'utf8').toString('base64');
  }
  return headers;
}

async function getCredential() {
  const provider = need('MOVACAL_PROVIDER');
  const { random, signature } = createSignature();
  const res = await fetch(`${MOVACAL_BASE}/service/api/v1/credential.php`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ provider, random, signature }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`credential.php ${res.status}: ${text}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`credential.php 応答が不正: ${text}`); }
  if (!json.credential) throw new Error(`credential 取得失敗: ${text}`);
  return json.credential;
}

function clinicInfo(clinicId, clinicCode) {
  return {
    clinic_id: String(clinicId || need('MOVACAL_CLINIC_ID')),
    clinic_code: String(clinicCode || need('MOVACAL_CLINIC_CODE')),
  };
}

// 院ごとの有効な user_id を自動解決（メモ登録に必要。院ごとに異なる）
const _userIdCache = new Map(); // clinic_id -> user_id

async function getUserData(credential, clinicId, clinicCode) {
  const body = {
    credential,
    clinic_info: clinicInfo(clinicId, clinicCode),
    user_info: { active: 1 }, // アクティブなユーザーのみ
  };
  const res = await fetch(`${MOVACAL_BASE}/service/api/v1/getUserData.php`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`getUserData.php ${res.status}: ${text}`);
  let json; try { json = JSON.parse(text); } catch { throw new Error(`getUserData.php 応答が不正: ${text}`); }
  const arr = Array.isArray(json) ? json : (json.user_info || json.users || json.user_data || []);
  return Array.isArray(arr) ? arr : [];
}

/** その院で有効な user_id を1つ返す（医師を優先、無ければ最初のアクティブ）。院ごとにキャッシュ。 */
async function getValidUserId(credential, clinicId, clinicCode) {
  const key = String(clinicId || 'default');
  if (_userIdCache.has(key)) return _userIdCache.get(key);
  const users = await getUserData(credential, clinicId, clinicCode);
  const active = users.filter((u) => u && u.user_id && String(u.is_active) === '1');
  const pick = active.find((u) => u.user_type === 'DOCTOR') || active[0] || users.find((u) => u && u.user_id);
  const uid = pick && pick.user_id ? String(pick.user_id) : '';
  if (uid) _userIdCache.set(key, uid);
  return uid;
}

/** カルテ本文(主訴)を新規登録 -> { insert_id, orca_id } */
async function registerObjective(p) {
  if (!p.orcaId) throw new Error('orcaId は必須です');
  if (!p.objective) throw new Error('objective は必須です');
  const credential = await getCredential();
  const body = {
    credential,
    clinic_info: clinicInfo(p.clinicId, p.clinicCode),
    diag_objective_info: {
      orca_id: String(p.orcaId),
      act_date: p.actDate,
      start_time: p.startTime,
      end_time: p.endTime,
      objective: p.objective,
      diag_type: Number(p.diagType),
      diag_dept: process.env.MOVACAL_DIAG_DEPT || '01',
    },
  };
  const res = await fetch(`${MOVACAL_BASE}/service/api/v1/postDiagObjective.php`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  if (!res.ok || (json && json.error_code)) {
    throw new Error(`postDiagObjective.php ${res.status}: ${text}`);
  }
  return json || { ok: true };
}

/** メモを登録（成功時は 204 No Content） -> { ok:true } */
async function registerMemo(p) {
  if (!p.orcaId) throw new Error('orcaId は必須です');
  if (!p.memo) throw new Error('memo は必須です');
  const credential = await getCredential();

  // user_id は院ごとに異なる。①明示指定 → ②getUserDataで自動解決 → ③env最終手段
  let userId = p.userId || '';
  if (!userId) {
    try { userId = await getValidUserId(credential, p.clinicId, p.clinicCode); } catch (e) { /* 自動解決失敗時は下へ */ }
  }
  if (!userId) userId = process.env.MOVACAL_USER_ID || '';
  if (!userId) throw new Error('この診療所の有効な user_id を取得できませんでした（getUserData.php / clinics.json memo_user_id を確認してください）');

  const body = {
    credential,
    clinic_info: clinicInfo(p.clinicId, p.clinicCode),
    memo_info: {
      orca_id: String(p.orcaId),
      patient_name: p.patientName || undefined,
      user_id: userId,
      user_name: p.userName || process.env.MOVACAL_USER_NAME || 'AI音声カルテ',
      title: p.title || '音声カルテ',
      memo: p.memo,
      reg_date: p.regDate,
      reg_time: p.regTime,
    },
  };
  const res = await fetch(`${MOVACAL_BASE}/service/api/v1/postMemo.php`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
  });
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  if (!res.ok || (json && json.error_code)) {
    throw new Error(`postMemo.php ${res.status}: ${text}`);
  }
  return json || { ok: true };
}

/** 診療データ取得（get_type=1：患者ID＋日付指定） */
async function getDiagData(credential, p) {
  const body = {
    credential,
    clinic_info: clinicInfo(p.clinicId, p.clinicCode),
    diagdata_get_info: {
      get_type: 1,
      patient_info: {
        act_date_start: p.actDate,
        act_date_end: p.actDate,
        orca_id: String(p.orcaId),
      },
    },
  };
  const res = await fetch(`${MOVACAL_BASE}/service/api/v1/getDiagdata.php`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
  });
  if (res.status === 204) return [];
  const text = await res.text();
  if (!res.ok) throw new Error(`getDiagdata.php ${res.status}: ${text}`);
  let json; try { json = JSON.parse(text); } catch { throw new Error(`getDiagdata.php 応答が不正: ${text}`); }
  const d = json.diag_info || json.diag_data || json;
  return Array.isArray(d) ? d : (d ? [d] : []);
}

/** 主訴編集（既存カルテ本文の上書き）。中断/準備のカルテのみ編集可。 */
async function editObjective(credential, p) {
  const body = {
    credential,
    clinic_info: clinicInfo(p.clinicId, p.clinicCode),
    diag_objective_info: {
      orca_id: String(p.orcaId),
      org_karte_id: Number(p.orgKarteId),
      objective: p.objective,
    },
  };
  const res = await fetch(`${MOVACAL_BASE}/service/api/v1/editDiagObjective.php`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify(body),
  });
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  if (!res.ok) throw new Error(`editDiagObjective.php ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return { ok: true, raw: text }; }
}

/** 「A/P)」の記載の後ろにAI作成内容を差し込む。A/P) が無ければ本文末尾に追記。 */
function insertAfterAP(objective, addition) {
  const base = String(objective == null ? '' : objective);
  const add = String(addition || '').trim();
  if (!add) return base;
  if (!base.trim()) return add;

  // A/P) A/P） Ａ／Ｐ） AP: A / P ) などの表記ゆれに対応（全角英字も含む）
  const re = /[AＡ][\s\u3000]*[\/／]?[\s\u3000]*[PＰ][\s\u3000]*[)）:：]?/i;
  const m = re.exec(base);
  if (!m) return base.replace(/\s*$/, '') + '\n' + add; // 見つからなければ末尾

  // A/P) 以降のブロック末尾（次の空行 or 文末）の直後に挿入
  const after = m.index + m[0].length;
  const rest = base.slice(after);
  const brk = rest.search(/\n[ \t\u3000]*\r?\n/);
  const cut = brk >= 0 ? after + brk : base.length;
  const head = base.slice(0, cut).replace(/\s*$/, '');
  const tail = base.slice(cut);
  return head + '\n' + add + (tail ? '\n' + tail.replace(/^[\s\r\n]*/, '') : '');
}

/**
 * その日の既存カルテのA/P欄にAI内容を追記。
 * 編集可能（0=準備 / 2=中断）のうち「一番古い」カルテが対象。
 * 編集可能なカルテが無ければ appended:false（転記しない）。
 */
async function appendToKarte(p) {
  if (!p.orcaId) throw new Error('orcaId は必須です');
  if (!p.content) throw new Error('content は必須です');
  const credential = await getCredential();
  const list = await getDiagData(credential, {
    orcaId: p.orcaId, actDate: p.actDate, clinicId: p.clinicId, clinicCode: p.clinicCode,
  });

  const editable = list.filter((d) => d && ['0', '2'].includes(String(d.status)));
  if (!editable.length) return { appended: false, reason: list.length ? 'completed' : 'not_found' };

  editable.sort((a, b) => {
    const ta = String(a.start_time || ''), tb = String(b.start_time || '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return Number(a.org_karte_id || 0) - Number(b.org_karte_id || 0);
  });
  const target = editable[0];
  const merged = insertAfterAP(target.objective, p.content);
  await editObjective(credential, {
    orcaId: p.orcaId, orgKarteId: target.org_karte_id, objective: merged,
    clinicId: p.clinicId, clinicCode: p.clinicCode,
  });
  return { appended: true, org_karte_id: target.org_karte_id };
}

module.exports = { getCredential, registerObjective, registerMemo, getUserData, getValidUserId, getDiagData, appendToKarte, insertAfterAP };

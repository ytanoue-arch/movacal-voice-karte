'use strict';

// .env を自動読込（ローカル開発用）。Cloud Run では実環境変数が優先され、
// dotenv は既存の環境変数を上書きしないため本番に影響しません。
try { require('dotenv').config(); } catch (_) { /* dotenv 未導入でも動作 */ }

const fs = require('fs');
const path = require('path');
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { OAuth2Client } = require('google-auth-library');
const movacal = require('./movacal');

// ---- 診療所レジストリ（code はサーバー側のみ保持） ----
let CLINICS = [];
function loadClinics() {
  try {
    const raw = process.env.CLINICS_JSON || fs.readFileSync(path.join(__dirname, 'clinics.json'), 'utf8');
    CLINICS = (JSON.parse(raw).clinics || []).filter((c) => c && c.id && c.code);
  } catch (e) {
    console.warn('clinics.json 読み込み失敗:', e.message);
    CLINICS = [];
  }
  console.log(`clinics loaded: ${CLINICS.length} 院`);
}
function clinicById(id) { return CLINICS.find((c) => String(c.id) === String(id)); }
function clinicChoices() { return CLINICS.map((c) => ({ id: String(c.id), name: c.name })); }
loadClinics();

// ---- ユーザー（Googleメール）ごとの既定診療所 ----
let USER_CLINICS = {};
function loadUserClinics() {
  try {
    const raw = process.env.USER_CLINICS_JSON || fs.readFileSync(path.join(__dirname, 'user-clinics.json'), 'utf8');
    const obj = JSON.parse(raw);
    USER_CLINICS = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!k.startsWith('_')) USER_CLINICS[k.toLowerCase()] = String(v);
    }
  } catch (e) {
    USER_CLINICS = {};
  }
  console.log(`user-clinics loaded: ${Object.keys(USER_CLINICS).length} 名`);
}
loadUserClinics();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30mb' }));

const PORT = process.env.PORT || 8080;

// ---- 認証設定 ----
const APP_TOKEN = process.env.APP_TOKEN; // 共有トークン（既定では無効）
// 共有トークンによるログイン回避は既定で無効。緊急時のみ APP_TOKEN_ENABLED=1 で有効化する。
const APP_TOKEN_ENABLED = process.env.APP_TOKEN_ENABLED === '1' && !!APP_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID; // Google Workspace サインイン用
const ALLOWED_HD = (process.env.ALLOWED_HD || '')
  .split(',').map((s) => s.trim()).filter(Boolean); // 許可する Workspace ドメイン（hd）
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); // 任意のメール許可リスト
const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ---- Gemini ----
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

if (!GEMINI_API_KEY) console.warn('⚠️  GEMINI_API_KEY 未設定（/api/dictate は失敗します）');
if (!oauthClient && !APP_TOKEN_ENABLED) console.warn('⚠️  認証が無効です（GOOGLE_CLIENT_ID を設定してください）');
if (APP_TOKEN_ENABLED) console.warn('⚠️  共有トークン(APP_TOKEN)が有効です。本番では無効化推奨。');

// ---- 整形プロンプト（プロブレムリスト形式） ----
const FORMAT_PROMPT = `あなたは在宅・外来診療の診療録作成を支援するアシスタントです。
これは医師が診察内容を口述した音声です。文字起こしし、問題志向（プロブレムリスト）形式の診療録の下書きに整形してください。

【構成】
- 診察で扱った問題（プロブレム）ごとに、行頭を「#」で始めて問題名を書く（例：# 高血圧、# 誤嚥性肺炎の経過、# 褥瘡）。
- 各プロブレムの直下に「内容：」と「方針：」の見出しを置き、それぞれにまとめる。
  内容：その問題に関する訴え・自覚症状・身体所見・バイタル・検査値など、診察で分かった事実。
  方針：その問題に対する評価・注意点・次回以降の指示・処方/処置の変更・フォロー方針。
- 問題が複数あれば「#」見出しを複数並べる。1つなら1つでよい。

【厳守事項】
- 話された内容のみを使用し、推測・創作・補完はしない。情報が無い項目は無理に埋めない。
- 聞き取れない/不確実な箇所は [要確認] と記す。
- 検査値・バイタル・所見・薬剤名・用量はそのまま正確に残す。数値や単位を変えない。
- 行頭の「#」はプロブレム見出しにのみ使う。それ以外の装飾記号（*, ■, 【】 など）は使わない。
- 前置き・要約・あいさつは付けない。診療録本文だけを出力する。
- 口語のフィラーや言い直しは整理し、診療録として自然な書き言葉にする。意味は変えない。
- 医師がレビュー・修正する前提の下書きである。

出力は「# プロブレム名 / 内容： / 方針：」の本文のみ。`;

// ---- セキュリティヘッダ ----
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  res.set('Permissions-Policy', 'microphone=(self)');
  // Google Identity Services を許可しつつ最小限に
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' https://accounts.google.com/gsi/client",
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
      "connect-src 'self' https://accounts.google.com/gsi/",
      "frame-src https://accounts.google.com/gsi/",
      "img-src 'self' data: https://*.googleusercontent.com",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; ')
  );
  next();
});

// ---- 認証ミドルウェア ----
async function authenticate(req, res, next) {
  const header = req.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';

  // 1) Google ID トークン（JWT形式なら優先的に検証）
  if (oauthClient && bearer && bearer.split('.').length === 3) {
    try {
      const ticket = await oauthClient.verifyIdToken({ idToken: bearer, audience: GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      const hdOk = ALLOWED_HD.length === 0 || (p.hd && ALLOWED_HD.includes(p.hd));
      const emailOk = ALLOWED_EMAILS.length === 0 || ALLOWED_EMAILS.includes((p.email || '').toLowerCase());
      if (!p.email_verified || !hdOk || !emailOk) {
        return res.status(403).json({ error: 'このアカウントは許可されていません' });
      }
      req.user = { email: p.email, name: p.name || p.email, hd: p.hd };
      return next();
    } catch (e) {
      console.error('google auth error:', e && (e.message || e));
      return res.status(401).json({ error: 'Google認証に失敗しました', detail: String((e && e.message) || e) });
    }
  }

  // 2) 共有トークン（既定で無効。緊急時に APP_TOKEN_ENABLED=1 の時のみ有効）
  if (APP_TOKEN_ENABLED) {
    const token = bearer || req.get('X-App-Token') || '';
    if (token && token === APP_TOKEN) {
      req.user = { email: 'shared-token', name: process.env.MOVACAL_REGISTRANT_NAME || process.env.MOVACAL_USER_NAME || 'AI音声カルテ' };
      return next();
    }
  }

  // 3) 認証未設定（ローカル開発のみ）
  if (!oauthClient && !APP_TOKEN_ENABLED) {
    req.user = { email: 'anon', name: process.env.MOVACAL_USER_NAME || 'AI音声カルテ' };
    return next();
  }

  // 4) それ以外はサインイン必須（共有トークン無効化済み）
  return res.status(401).json({ error: oauthClient ? 'Googleサインインが必要です' : '認証が必要です' });
}

// ---- フロント設定（認証方式をクライアントへ通知） ----
app.get('/api/config', (req, res) => {
  res.json({
    auth: oauthClient ? 'google' : (APP_TOKEN_ENABLED ? 'token' : 'open'),
    googleClientId: GOOGLE_CLIENT_ID || '',
    allowedHd: ALLOWED_HD,
    clinicSelector: process.env.CLINIC_SELECTOR !== '0',
  });
});

// ---- 診療所一覧（名前とIDのみ。code は返さない）＋ ユーザー既定院 ----
app.get('/api/clinics', authenticate, (req, res) => {
  const email = ((req.user && req.user.email) || '').toLowerCase();
  const userDefault = USER_CLINICS[email];
  res.json({
    clinics: clinicChoices(),
    default: userDefault || process.env.MOVACAL_CLINIC_ID || '',
  });
});
app.post('/api/dictate', authenticate, async (req, res) => {
  try {
    if (!genAI) return res.status(500).json({ error: 'GEMINI_API_KEY が未設定です' });
    const { audio, mimeType } = req.body || {};
    if (!audio || !mimeType) return res.status(400).json({ error: 'audio（Base64）と mimeType は必須です' });

    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const result = await model.generateContent([
      { text: FORMAT_PROMPT },
      { inlineData: { mimeType, data: audio } },
    ]);
    const note = (result.response.text() || '').trim();
    if (!note) return res.status(502).json({ error: '整形結果が空でした。録音をやり直してください。' });
    res.json({ note });
  } catch (e) {
    console.error('dictate error:', e.message || e); // 本文は記録しない
    res.status(500).json({ error: '整形に失敗しました', detail: String(e.message || e) });
  }
});

// ---- MOVACAL 書き込み（メモ / カルテ本文 を選択） ----
app.post('/api/register', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.orcaId) return res.status(400).json({ error: 'orcaId（ORCA ID）は必須です' });
    if (!b.content) return res.status(400).json({ error: 'content（本文）は必須です' });

    const jst = jstNow();
    const target = ['memo', 'karte', 'oncall'].includes(b.target) ? b.target : 'karte';
    let result;

    // 診療所の解決：clinicId が来たらレジストリから code を引く（client の code は信頼しない）
    let clinicId = b.clinicId || process.env.MOVACAL_CLINIC_ID || undefined;
    let clinicCode; // undefined のときは movacal 側が env 既定を使用
    let clinicMemoUserId; // clinics.json に memo_user_id があれば優先（無ければ自動解決）
    if (b.clinicId) {
      const c = clinicById(b.clinicId);
      if (!c) return res.status(400).json({ error: '未登録のクリニックです（clinics.json を確認してください）' });
      clinicId = c.id;
      clinicCode = c.code;
      clinicMemoUserId = c.memo_user_id ? String(c.memo_user_id) : undefined;
    }

    if (target === 'memo') {
      result = await movacal.registerMemo({
        orcaId: b.orcaId,
        memo: b.content,
        patientName: b.patientName,
        userName: process.env.MOVACAL_REGISTRANT_NAME || 'やまと音声カルテ', // メモの登録者名（固定）
        userId: clinicMemoUserId, // 院ごとの固定値があれば優先。無ければ getUserData で自動解決
        title: b.title || '音声カルテ',
        regDate: b.actDate || jst.date,
        regTime: b.startTime || jst.time,
        clinicId,
        clinicCode,
      });
    } else if (target === 'karte') {
      // カルテ本文＝その日の既存カルテのA/P欄に追記（新規カルテは作らない）
      const r = await movacal.appendToKarte({
        orcaId: b.orcaId,
        content: b.content,
        actDate: b.actDate || jst.date,
        clinicId,
        clinicCode,
      });
      if (!r.appended) {
        console.log(`register: target=karte skipped(${r.reason}) clinic=${clinicId} orca=${b.orcaId} by=${req.user && req.user.email}`);
        return res.status(409).json({
          error: r.reason === 'completed'
            ? '本日のカルテは診察完了のため追記できません（転記不要）。'
            : '本日のカルテが見つかりませんでした。先にMOVACALでカルテを作成してください。',
          reason: r.reason,
        });
      }
      result = r;
    } else {
      // オンコール＝新規カルテ（オンコールメモ 48）
      const diagType = 48;
      result = await movacal.registerObjective({
        orcaId: b.orcaId,
        objective: b.content,
        diagType,
        actDate: b.actDate || jst.date,
        startTime: b.startTime || jst.time,
        endTime: b.endTime || jst.time,
        clinicId,
        clinicCode,
      });
    }

    // 監査ログ（誰が・いつ・どの患者へ・どの院/どこへ。本文は残さない）
    console.log(`register: target=${target} clinic=${clinicId} orca=${b.orcaId} by=${req.user && req.user.email} at=${jst.date} ${jst.time}`);
    res.json({ ok: true, target, result });
  } catch (e) {
    console.error('register error:', e.message || e);
    res.status(500).json({ error: 'MOVACAL登録に失敗しました', detail: String(e.message || e) });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`movacal-voice-karte v2 on :${PORT} (model=${GEMINI_MODEL}, auth=${oauthClient ? 'google' : (APP_TOKEN_ENABLED ? 'token' : 'open')})`));

function jstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}

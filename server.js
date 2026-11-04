'use strict';

// .env を自動読込（ローカル開発用）。Cloud Run では実環境変数が優先され、
// dotenv は既存の環境変数を上書きしないため本番に影響しません。
try { require('dotenv').config(); } catch (_) { /* dotenv 未導入でも動作 */ }

const fs = require('fs');
const path = require('path');
const express = require('express');
const { GoogleGenAI } = require('@google/genai'); // Vertex AI（既定）/ APIキー方式 の両対応SDK
const { OAuth2Client } = require('google-auth-library');
const movacal = require('./movacal');

// ---- 診療所レジストリ（code はサーバー側のみ保持） ----
let CLINICS = [];
function loadClinics() {
  try {
    const file = (process.env.MOCK === '1' && !fs.existsSync(path.join(__dirname, 'clinics.json')))
      ? 'clinics.example.json' : 'clinics.json';
    const raw = process.env.CLINICS_JSON || fs.readFileSync(path.join(__dirname, file), 'utf8');
    CLINICS = (JSON.parse(raw).clinics || []).filter((c) => c && c.id && c.code);
  } catch (e) {
    console.warn('clinics.json 読み込み失敗:', e.message);
    CLINICS = [];
  }
  console.log(`clinics loaded: ${CLINICS.length} 院`);
}
function clinicById(id) { return CLINICS.find((c) => String(c.id) === String(id)); }

// 口述された診療所名をレジストリと照合する。曖昧（複数該当）なら null。
function matchClinic(spoken) {
  const t = String(spoken || '').replace(/\s|　/g, '').replace(/^やまと在宅診療所|^やまと|診療所$|クリニック$/g, '');
  if (!t) return null;
  const exact = CLINICS.find((c) => c.name === t);
  if (exact) return exact;
  // 口述に院名がまるごと含まれる（例:「やまと仙台北」→ 仙台北）。最も長い院名を優先
  const inSpoken = CLINICS.filter((c) => c.name && t.includes(c.name)).sort((a, b) => b.name.length - a.name.length);
  if (inSpoken.length) return inSpoken[0];
  // 口述が院名の一部（例:「小杉」→ 武蔵小杉）。一意に決まるときだけ採用
  const partial = CLINICS.filter((c) => c.name && t.length >= 2 && c.name.includes(t));
  return partial.length === 1 ? partial[0] : null;
}

// 患者IDの表記ゆれを正規化（全角→半角、空白・ハイフン除去）。先頭の0は保持。
function normalizeId(v) {
  return String(v || '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　\-ー－‐]/g, '')
    .replace(/[^0-9A-Za-z_]/g, '');
}

// 読み取った診療所名・IDをレジストリと照合して返す。何も無ければ null。
function buildSpoken(clinicRaw, idRaw) {
  const clinicText = String(clinicRaw || '').trim();
  const orcaId = normalizeId(idRaw);
  if (!clinicText && !orcaId) return null;
  const hit = clinicText ? matchClinic(clinicText) : null;
  return { clinicText, orcaId, clinicId: hit ? String(hit.id) : '', clinicName: hit ? hit.name : '' };
}
function clinicChoices() { return CLINICS.map((c) => ({ id: String(c.id), name: c.name })); }
loadClinics();

// ---- ユーザー（Googleメール）ごとの既定診療所 ----
let USER_CLINICS = {};
function loadUserClinics() {
  try {
    const ufile = (process.env.MOCK === '1' && !fs.existsSync(path.join(__dirname, 'user-clinics.json')))
      ? 'user-clinics.example.json' : 'user-clinics.json';
    const raw = process.env.USER_CLINICS_JSON || fs.readFileSync(path.join(__dirname, ufile), 'utf8');
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
// 共有トークン(APP_TOKEN)によるログインは廃止。認証は Google Workspace のみ。
// 利用申請フォーム（Googleフォーム等）のURL。設定するとサインイン画面と権限なし画面に案内が出る。
const ACCESS_REQUEST_URL = process.env.ACCESS_REQUEST_URL || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID; // Google Workspace サインイン用
const ALLOWED_HD = (process.env.ALLOWED_HD || '')
  .split(',').map((s) => s.trim()).filter(Boolean); // 許可する Workspace ドメイン（hd）
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); // 任意のメール許可リスト
const oauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
// 認証なしで動かしてよいのは開発時だけ（MOCK=1 か、明示的に ALLOW_OPEN=1）。
// 本番で GOOGLE_CLIENT_ID 等の設定が消えた場合は「誰でも使える」にはせず、停止する（fail-closed）。
const OPEN_MODE = process.env.MOCK === '1' || process.env.ALLOW_OPEN === '1';
const AUTH_MODE = oauthClient ? 'google' : (OPEN_MODE ? 'open' : 'disabled');

// ---- Gemini ----
// 開発用モックモード（MOCK=1）: MOVACAL/Gemini/Google認証を使わず、ダミー応答で画面を一通り動かせる。
// 認証情報も患者データも不要なので、開発担当者のPCで安全に検証できる。
const MOCK = process.env.MOCK === '1';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Vertex AI（既定）: Cloud Run のサービスアカウントで認証するため APIキー不要。
// リージョンを asia-northeast1 に固定でき、患者情報の越境移転を避けられる。
// VERTEX_PROJECT は必須（Cloud Run は GOOGLE_CLOUD_PROJECT を自動設定しないため）。
// USE_VERTEX=0 のときだけ、緊急用に APIキー方式（GEMINI_API_KEY）で動く。
const USE_VERTEX = process.env.USE_VERTEX !== '0';
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
const VERTEX_LOCATION = process.env.VERTEX_LOCATION || 'asia-northeast1';

let ai = null;
let aiBackend = 'none';
if (!MOCK) {
  try {
    if (USE_VERTEX) {
      if (!VERTEX_PROJECT) throw new Error('VERTEX_PROJECT が未設定です');
      ai = new GoogleGenAI({ vertexai: true, project: VERTEX_PROJECT, location: VERTEX_LOCATION });
      aiBackend = 'vertex';
    } else if (GEMINI_API_KEY) {
      ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
      aiBackend = 'apikey';
    }
  } catch (e) {
    console.error('AI 初期化に失敗:', e && (e.message || e));
  }
}

if (MOCK) console.log('🧪 MOCKモードで起動します（MOVACAL/Geminiには接続しません。ダミー応答を返します）');
else if (aiBackend === 'vertex') console.log(`Vertex AI を使用（project=${VERTEX_PROJECT}, location=${VERTEX_LOCATION}, model=${GEMINI_MODEL}）`);
else if (aiBackend === 'apikey') console.warn('⚠️  APIキー方式で動作しています（USE_VERTEX=0）。本番は Vertex AI 推奨');
else console.warn('⚠️  AIが未設定です（VERTEX_PROJECT を設定してください）');
if (AUTH_MODE === 'disabled') console.error('🛑 認証設定（GOOGLE_CLIENT_ID）が無いため、すべてのAPIを停止しています。環境変数を確認してください。');
if (AUTH_MODE === 'google' && ALLOWED_HD.length === 0 && ALLOWED_EMAILS.length === 0) console.error('🛑 許可ドメイン（ALLOWED_HD）も許可メール（ALLOWED_EMAILS）も未設定のため、ログインを拒否しています。');
if (AUTH_MODE === 'open' && !MOCK) console.warn('⚠️  ALLOW_OPEN=1：認証なしで動作しています（開発専用。本番では設定しないこと）');

// ---- 整形プロンプト（プロブレムリスト形式） ----
// 患者特定専用（整形とは別の呼び出し。整形の精度に影響させないため分離）
// 患者特定の応答を寛容に解釈する（```json 囲み・前後の余分な文字・末尾の切れに対応）
function parsePatientJson(raw) {
  const s = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  if (!s) return null;
  const tryParse = (t) => { try { const o = JSON.parse(t); return o && typeof o === 'object' ? o : null; } catch { return null; } };
  let o = tryParse(s);
  if (!o) { const m = s.match(/\{[\s\S]*\}/); if (m) o = tryParse(m[0]); }
  if (!o) {
    const c = s.match(/"clinic"\s*:\s*"([^"]*)"/);
    const p = s.match(/"patient_id"\s*:\s*"([^"]*)"/);
    if (c || p) o = { clinic: c ? c[1] : '', patient_id: p ? p[1] : '' };
  }
  if (!o) return null;
  return { clinic: String(o.clinic || ''), patient_id: String(o.patient_id || '') };
}

const PATIENT_PROMPT = `これは医師の口述音声です。冒頭で述べられた診療所名と患者IDだけを抜き出してください。
- 診療所名は口述された呼び方のまま（例：仙台北、日吉、あゆみ仙台）。法人名は付けない。
- 患者IDは口述された英数字を一字ずつそのまま。先頭の0も残す（「ゼロゼロキュウハチロク」は00986）。桁を補ったり削ったりしない。
- 述べられていなければ空文字にする。推測しない。`;

const FORMAT_PROMPT = `あなたは在宅診療に精通した医師の診療録作成を補助するアシスタントです。
これは医師が診察内容を口述した音声です。文字起こしし、下記の記載例と同じ書式・文体・水準の診療録に整形してください。

【書式】
- 問題ごとに、1行目を半角の「# 」で始めて見出しを書く。
- 2行目を「内容：」で始め、経過、本日の所見、現在の状態を1段落で書く。
- 3行目を「方針：」で始め、評価と方針を1段落で書く。口述に方針がなければ「方針：」の行は書かない。
- 問題と問題の間は1行空ける。
- 日付行や前置きは付けない。1行目から「# 」で始める。

【見出しの立て方】
- 関連する病名は「、」で並べて一つの見出しにまとめる（例：# 骨粗鬆症、腰椎圧迫骨折）。
- その問題を規定する要点（診断の根拠となった検査や日付、部位）が口述にあれば、見出しの後ろの（）内に書く（例：（8/18 MRIでL1、L2付近の新規圧迫骨折））。口述になければ（）は付けない。
- 症状の管理や薬剤調整など、独立した方針があるものは別の見出しにする（例：# 腰痛症 として疼痛コントロールを書く）。
- 全体に関わる方針、急変時の対応、療養場所の意向、家族との相談内容があれば「# 今後の方針」にまとめる。

【文体】
- 短いフレーズを「、」と「。」でつなぐ診療録の文体にする。体言止めを基本とし、「です・ます」は使わない。
- 「〜である」「〜している状態である」「〜が出ている」のような説明調の冗長な文末は避ける。
  書き換え例：
  「1本杖を用いてトイレまでの歩行は自立している。」→「一本杖でトイレ歩行自立。」
  「痛みは少しずつ良くなってきている。」→「疼痛は改善傾向。」
  「経過に大きな変化はない。」→「経過に著変なし。」
- 方針には、口述された理由を添える（例：「NSAIDs使用期間が長くなっているため、胃薬の併用を確認し、次回採血で腎機能・貧血を確認する。」）。
- 方針は具体的に書く。薬剤の変更や継続、他科での治療と次回予定、受診予定、検査予定、確認事項、本人や家族との確認内容を漏らさない。

【用語と表記】
- 診療科や職種、サービスは正式名で書く：整形外科、訪問リハビリ、訪問看護、ショートステイ、ケアマネジャー。
- 剤形は「坐薬」「貼付剤」と書く（口述で「サポ」と言われても「ボルタレン坐薬」と書く）。
- 用法は「3錠分3」「1日1回」「疼痛時」「早朝6時頃」のように書く。「3かけ」「3回に分けて」は「分3」と書く。
- 評価尺度や数値は空けずに書く：NRS2〜3、SpO2 96%、BT36.8℃、Na130、Alb2.4。
- 日付は「8/18」「10/14」、月だけなら「次回1月」と書く。範囲は「〜」を使う。
- 並列は「・」でつなぐ（例：本人・娘様、腎機能・貧血）。
- 医学用語や略語は口述に合わせて適切に用いる（例：NSAIDs、新規圧迫骨折、体動時痛、改善傾向、転倒予防）。

【選択肢の併記】
- 医師が複数の選択肢を挙げて、まだ決めていない場合は【A／B】の形で併記する（例：【1日1回定期＋疼痛時／疼痛時のみ】）。医師が決めた内容は選択肢にせず、そのまま書く。

【使用してよい記号】
- 見出しの「# 」、（）、、。・〜＋、選択肢の併記と要確認に使う【】と／、日付や数値の表記に必要な記号のみ。
- 箇条書き（-、＊、数字の列挙）は使わない。

【聞き取りと厳守事項】
- 在宅医療の口述で使われる用語、薬剤名、用法の言い回しは、医学的文脈から意図どおりの正しい表記に整える。
- 音声が不明瞭で語を特定できない場合、または薬剤名、用量、数値が複数に解釈できる場合に限り、その箇所に【要確認】と記す。医学的文脈から一意に定まる語は要確認にしない。
- 口述されていない事実、所見、検査値、評価、方針を創作しない。口述された内容は要約しすぎず、数値、日付、用量、部位を省略しない。
- 口語のフィラーや言い直しは整理する。意味は変えない。
- 口述冒頭の「仙台北の、ID 00986の患者です」のような、診療所名や患者IDを述べる発言は本文に含めない。

【記載例】
以下は書式と文体を示すための例である。書式と文体だけを参考にし、薬剤名や予定などの内容は流用しないこと。口述にない内容を書き加えてはならない。

# 骨粗鬆症、腰椎圧迫骨折（8/18 MRIでL1、L2付近の新規圧迫骨折）
内容：整形外科より1ヶ月安静の指示、訪問リハビリ休止中。現在は一本杖でトイレ歩行自立。
方針：10/14整形外科受診にてリハビリ再開可否を確認予定。プラリアは整形外科で継続（次回1月）。転倒予防について本人・娘様と確認。

# 腰痛症
内容：ボルタレン坐薬は1日1回程度（早朝6時頃）、カロナール3錠分3で、坐薬使用後NRS2〜3。疼痛は改善傾向。
方針：使用頻度の減少に合わせ、ボルタレン坐薬を【1日1回定期＋疼痛時／疼痛時のみ】へ減量。NSAIDs使用期間が長くなっているため、胃薬の併用を確認し、次回採血で腎機能・貧血を確認する。

出力は「# 」で始まる診療録本文のみ。`;

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
  // IAP を前段に置くと Authorization ヘッダーは IAP が自分宛てとして検証するため、
  // アプリのトークンは X-App-Auth で受け取る（旧クライアント向けに Authorization も受け付ける）
  const header = req.get('X-App-Auth') || req.get('Authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';

  // 1) Google ID トークン（JWT形式なら優先的に検証）
  if (oauthClient && bearer && bearer.split('.').length === 3) {
    try {
      const ticket = await oauthClient.verifyIdToken({ idToken: bearer, audience: GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      if (ALLOWED_HD.length === 0 && ALLOWED_EMAILS.length === 0) {
        // 許可範囲が未設定なら、どのGoogleアカウントも通さない（設定消失時の安全側）
        return res.status(503).json({ error: '利用許可の設定が見つからないため停止しています。管理者に連絡してください。' });
      }
      const hdOk = ALLOWED_HD.length === 0 || (p.hd && ALLOWED_HD.includes(p.hd));
      const emailOk = ALLOWED_EMAILS.length === 0 || ALLOWED_EMAILS.includes((p.email || '').toLowerCase());
      if (!p.email_verified || !hdOk || !emailOk) {
        const reason = !p.email_verified ? 'unverified' : (!hdOk ? 'domain' : 'not-allowed');
        console.warn(`audit auth-denied: email=${p.email || '-'} hd=${p.hd || '-'} reason=${reason} path=${req.path}`);
        return res.status(403).json({ error: 'このアカウントには利用権限がありません', denied: true });
      }
      req.user = { email: p.email, name: p.name || p.email, hd: p.hd };
      return next();
    } catch (e) {
      console.error('google auth error:', e && (e.message || e));
      return res.status(401).json({ error: 'Google認証に失敗しました', detail: String((e && e.message) || e) });
    }
  }

  // 2) 認証なし（開発時のみ：MOCK=1 または ALLOW_OPEN=1）
  if (AUTH_MODE === 'open') {
    req.user = { email: 'anon', name: process.env.MOVACAL_USER_NAME || 'AI音声カルテ' };
    return next();
  }

  // 3) 認証設定が無い本番は停止
  if (AUTH_MODE === 'disabled') {
    return res.status(503).json({ error: '認証設定が見つからないため停止しています。管理者に連絡してください。' });
  }

  // 4) それ以外はサインイン必須
  return res.status(401).json({ error: oauthClient ? 'Googleサインインが必要です' : '認証が必要です' });
}

// ---- フロント設定（認証方式をクライアントへ通知） ----
app.get('/api/config', (req, res) => {
  res.json({
    auth: AUTH_MODE,
    accessRequestUrl: ACCESS_REQUEST_URL,
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
    if (MOCK) {
      // Gemini を呼ばずにサンプルを返す（APIキー不要・課金なし）
      await new Promise((r) => setTimeout(r, 800)); // 生成待ちの体感を再現
      const spoken = buildSpoken('仙台北', '00986');
      const note = ([
          '# 慢性心不全（9/20往診時に下腿浮腫増悪）',
          '内容：フロセミド20mgから40mgへ増量後、体重2kg減少。本日下腿浮腫は軽度、SpO2 96%、労作時呼吸困難なし。',
          '方針：増量後の腎機能・電解質確認のため次回採血予定。2日で1.5kg以上の体重増加あれば訪問看護より連絡を受け、利尿薬追加を検討。',
          '',
          '# 嚥下機能低下',
          '内容：食事中のむせ込み増加を妻様より報告。本日水分でむせあり、固形物は摂取可。',
          '方針：水分はとろみ付きで提供、食後30分座位保持を指導。言語聴覚士による嚥下評価を【導入／経過観察】で検討。',
          '',
          'これはMOCKモードのサンプルです。実際の音声は解析していません。',
        ].join('\n')).trim();
      return res.json({ note, spoken });
    }
    if (!ai) return res.status(500).json({ error: 'AIの設定が未完了です（VERTEX_PROJECT を確認してください）' });
    const { audio, mimeType } = req.body || {};
    if (!audio || !mimeType) return res.status(400).json({ error: 'audio（Base64）と mimeType は必須です' });

    console.log(`audit dictate: by=${req.user && req.user.email} bytes=${audio.length}`);
    const audioPart = { inlineData: { mimeType, data: audio } };
    const [fmt, pid] = await Promise.allSettled([
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: FORMAT_PROMPT }, audioPart] }],
        config: { maxOutputTokens: 16384 },
      }),
      ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: 'user', parts: [{ text: PATIENT_PROMPT }, audioPart] }],
        config: {
          temperature: 0,
          // 思考トークンも上限に数えられるため余裕を持たせる（256では途中で切れてJSONが壊れた）
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { clinic: { type: 'STRING' }, patient_id: { type: 'STRING' } },
            required: ['clinic', 'patient_id'],
          },
        },
      }),
    ]);
    if (fmt.status !== 'fulfilled') throw fmt.reason;
    const result = fmt.value;
    const finish = result.candidates && result.candidates[0] && result.candidates[0].finishReason;
    if (finish && finish !== 'STOP') console.warn(`dictate: finishReason=${finish}（出力が途中で終了した可能性）`);
    let note = (result.text || '').trim();
    if (finish === 'MAX_TOKENS' && note) note += '\n\n（出力が長く途中で終了しました。続きを追記してください）';
    if (!note) return res.status(502).json({ error: '整形結果が空でした。録音をやり直してください。' });

    let spoken = null;
    if (pid.status === 'fulfilled') {
      const raw = pid.value.text || '';
      const j = parsePatientJson(raw);
      if (j) spoken = buildSpoken(j.clinic, j.patient_id);
      else {
        const pf = pid.value.candidates && pid.value.candidates[0] && pid.value.candidates[0].finishReason;
        console.warn(`dictate: 患者特定の応答を解析できませんでした finishReason=${pf} len=${raw.length}`); // 値そのものは残さない
      }
    } else {
      console.warn('dictate: 患者特定に失敗:', pid.reason && (pid.reason.message || pid.reason));
    }
    if (spoken) console.log(`dictate: spoken clinic=${spoken.clinicId || '(未照合)'} idLen=${spoken.orcaId.length}`); // 値そのものは残さない
    res.json({ note, spoken });
  } catch (e) {
    console.error('dictate error:', e.message || e); // 本文は記録しない
    res.status(500).json({ error: '整形に失敗しました', detail: String(e.message || e) });
  }
});

// ---- MOVACAL 書き込み（メモ / カルテ本文 を選択） ----
// 患者の本人確認（取り違え防止）。氏名・年齢・性別のみ返す。
app.post('/api/patient', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    const orcaId = normalizeId(b.orcaId);
    if (!orcaId) return res.status(400).json({ error: '患者IDが空です' });
    let clinicId, clinicCode;
    if (b.clinicId) {
      const c = clinicById(b.clinicId);
      if (!c) return res.status(400).json({ error: '未登録の診療所です' });
      clinicId = c.id; clinicCode = c.code;
    }
    if (MOCK) {
      await new Promise((r) => setTimeout(r, 300));
      console.log(`audit patient-lookup: by=${req.user && req.user.email} clinic=${clinicId || '-'} orca=${orcaId} found=${orcaId !== '9998'} (mock)`);
      if (orcaId === '9998') return res.json({ found: false });
      return res.json({ found: true, orcaId, name: '見本 花子', kana: 'ミホン ハナコ', gender: '女性', age: 88, status: 'ACTIVE' });
    }
    const r = await movacal.getPatient({ orcaId, clinicId, clinicCode });
    console.log(`audit patient-lookup: by=${req.user && req.user.email} clinic=${clinicId || '-'} orca=${orcaId} found=${!!r.found}`);
    res.json(r.found ? r : { found: false });
  } catch (e) {
    console.error('patient lookup error:', e.message || e);
    res.status(502).json({ error: '患者情報を確認できませんでした', detail: String(e.message || e) });
  }
});

app.post('/api/register', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.orcaId) return res.status(400).json({ error: 'orcaId（ORCA ID）は必須です' });
    if (!b.content) return res.status(400).json({ error: 'content（本文）は必須です' });

    if (MOCK) {
      // MOVACAL には一切接続しない。書き込み先ごとの応答だけ再現する。
      const t = b.target || 'karte';
      console.log(`[MOCK] register target=${t} orca=${b.orcaId} clinic=${b.clinicId || '-'} len=${String(b.content).length}`);
      await new Promise((r) => setTimeout(r, 500));
      if (t === 'karte' && String(b.orcaId) === '9999') {
        // 「診察完了で追記できない」ケースの確認用ダミー患者
        return res.status(409).json({ error: '本日のカルテは診察完了のため追記できません（転記不要）。', reason: 'completed' });
      }
      return res.json({ ok: true, result: t === 'karte' ? { org_karte_id: 123456 } : { insert_id: 123456 } });
    }

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
            : '本日のカルテが見つかりませんでした。MOVACALでカルテを作成し、診察完了にせず（中断または準備の状態で）保存してから再度お試しください。',
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

app.listen(PORT, () => console.log(`movacal-voice-karte v2 on :${PORT} (${MOCK ? 'MOCK' : 'live'}, ai=${MOCK ? 'mock' : aiBackend}, model=${GEMINI_MODEL}, auth=${AUTH_MODE})`));

function jstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}

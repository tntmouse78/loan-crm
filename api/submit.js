// ================================================================
//  Vercel Serverless Function — /api/submit.js
//  희망나눔플러스 상담 접수 처리
//
//  ▶ Vercel 환경변수 설정 (Dashboard → Settings → Environment Variables):
//    TELEGRAM_TOKEN          텔레그램 봇 토큰
//    TELEGRAM_CHAT_ID        텔레그램 채팅 ID
//    COOLSMS_API_KEY         CoolSMS API 키
//    COOLSMS_API_SECRET      CoolSMS 시크릿
//    COOLSMS_FROM            CoolSMS 발신번호 (01091287038)
//    MANAGER_PHONE           담당자 수신번호 (01064458521)
//    SHEET_URL               구글 Apps Script URL
//    ALLOWED_ORIGIN          허용 도메인 (https://hopeplus119.co.kr)
// ================================================================

export default async function handler(req, res) {
  // ── CORS 설정 ──────────────────────────────────────────────────
  const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://hopeplus119.co.kr';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  // ── 요청 파싱 ──────────────────────────────────────────────────
  const { name, tel, amount, type, period, keyword } = req.body;

  if (!name || !tel) {
    return res.status(400).json({ ok: false, error: '필수 항목 누락' });
  }

  // ── 환경변수 로드 ──────────────────────────────────────────────
  const TELEGRAM_TOKEN    = process.env.TELEGRAM_TOKEN;
  const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
  const COOLSMS_API_KEY   = process.env.COOLSMS_API_KEY;
  const COOLSMS_API_SECRET= process.env.COOLSMS_API_SECRET;
  const COOLSMS_FROM      = process.env.COOLSMS_FROM;
  const MANAGER_PHONE     = process.env.MANAGER_PHONE;
  const SHEET_URL         = process.env.SHEET_URL;

  // ── 시간 포맷 ──────────────────────────────────────────────────
  const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  // 비동기 처리 결과 수집 (실패해도 응답은 반환)
  const results = await Promise.allSettled([
    sendToSheet({ name, tel, amount, type, period, timeStr }, SHEET_URL),
    sendTelegram({ name, tel, amount, type, period, keyword, timeStr }, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID),
    sendSMS(MANAGER_PHONE, { name, tel, amount, type, period, timeStr }, COOLSMS_API_KEY, COOLSMS_API_SECRET, COOLSMS_FROM),
  ]);

  const errors = results
    .filter(r => r.status === 'rejected')
    .map(r => r.reason?.message || 'unknown');

  if (errors.length) {
    console.error('[submit] 일부 실패:', errors);
  }

  return res.status(200).json({ ok: true });
}

// ────────────────────────────────────────────────────────────────
//  구글 스프레드시트 저장
// ────────────────────────────────────────────────────────────────
async function sendToSheet({ name, tel, amount, type, period, timeStr }, sheetUrl) {
  if (!sheetUrl) return;
  const payload = JSON.stringify({
    time: timeStr,
    name,
    tel,
    amount: amount || '-',
    type:   type   || '-',
    period: period || '-',
  });
  const r = await fetch(sheetUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    payload,
  });
  if (!r.ok) throw new Error(`Sheet HTTP ${r.status}`);
}

// ────────────────────────────────────────────────────────────────
//  텔레그램 메시지 전송
// ────────────────────────────────────────────────────────────────
async function sendTelegram({ name, tel, amount, type, period, keyword, timeStr }, token, chatId) {
  if (!token || !chatId) return;
  const msg =
`🔔 새 상담 접수!
━━━━━━━━━━━━━━━
👤 성함: ${name}
📞 연락처: ${tel}
💰 신청금액: ${amount || '-'}
🏢 사업자 구분: ${type || '-'}
📅 사업 기간: ${period || '-'}
🔍 유입 키워드: ${keyword || '-'}
🕐 접수 시각: ${timeStr}
━━━━━━━━━━━━━━━
📍 희망나눔플러스 홈페이지`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, parse_mode: 'HTML', text: msg }),
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
}

// ────────────────────────────────────────────────────────────────
//  CoolSMS 문자 전송 (서버 사이드 HMAC-SHA256)
// ────────────────────────────────────────────────────────────────
async function sendSMS(to, { name, tel, amount, type, period, timeStr }, apiKey, apiSecret, from) {
  if (!apiKey || !apiSecret || !to || !from) return;

  const date = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const salt = Math.random().toString(36).substring(2, 12);
  const sigStr = date + salt;

  // Node.js crypto (Vercel 런타임에서 기본 제공)
  const { createHmac } = await import('crypto');
  const signature = createHmac('sha256', apiSecret).update(sigStr).digest('hex');

  const text = `[희망나눔플러스] 새 상담접수\n성함: ${name}\n연락처: ${tel}\n금액: ${amount||'-'}\n구분: ${type||'-'}\n기간: ${period||'-'}\n시각: ${timeStr}`;

  const r = await fetch('https://api.coolsms.co.kr/messages/v4/send', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    body: JSON.stringify({ message: { to, from, text } }),
  });
  if (!r.ok) throw new Error(`CoolSMS HTTP ${r.status}`);
}

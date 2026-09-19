const http = require('http');

const PORT = Number(process.env.PORT || 3000);
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'flota@allzonelogistics.com';
const SENDER_NAME = process.env.SENDER_NAME || 'Flota Allzone Logistics';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://jorgefelipecastro-debug.github.io';
const MAX_BODY = 22 * 1024 * 1024;
const rate = new Map();

function cors(res, origin) {
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS,GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, payload, origin) {
  cors(res, origin);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(payload));
}

function validEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

function limited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const current = (rate.get(ip) || []).filter(t => now - t < windowMs);
  if (current.length >= 12) {
    rate.set(ip, current);
    return true;
  }
  current.push(now);
  rate.set(ip, current);
  return false;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    cors(res, origin);
    res.writeHead(origin === ALLOWED_ORIGIN ? 204 : 403);
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {ok:true, mailConfigured:Boolean(BREVO_API_KEY)}, origin);
  }

  if (req.method !== 'POST' || req.url !== '/send-report') {
    return json(res, 404, {ok:false,error:'not_found'}, origin);
  }

  if (origin !== ALLOWED_ORIGIN) {
    return json(res, 403, {ok:false,error:'origin_not_allowed'}, origin);
  }

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) {
    return json(res, 429, {ok:false,error:'rate_limited'}, origin);
  }

  if (!BREVO_API_KEY) {
    return json(res, 503, {ok:false,error:'mail_not_configured'}, origin);
  }

  let size = 0;
  const chunks = [];
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) req.destroy(new Error('body_too_large'));
    else chunks.push(chunk);
  });
  req.on('error', () => {
    if (!res.headersSent) json(res, 413, {ok:false,error:'attachment_too_large'}, origin);
  });
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const rawRecipients = Array.isArray(body.recipients) ? body.recipients : [body.to];
      const recipients = [...new Set(rawRecipients.map(v=>String(v||'').trim().toLowerCase()).filter(validEmail))];
      if (!recipients.includes(SENDER_EMAIL.toLowerCase())) recipients.unshift(SENDER_EMAIL.toLowerCase());
      const filename = String(body.filename || 'Parte_Accidente_Allzone.pdf').replace(/[^A-Za-z0-9._-]/g,'_').slice(0,120);
      const pdfBase64 = String(body.pdfBase64 || '');
      const plateA = String(body.plateA || '').trim().slice(0,30);
      const plateB = String(body.plateB || '').trim().slice(0,30);
      const date = String(body.date || '').trim().slice(0,30);

      if (!recipients.length || recipients.length > 6) return json(res, 400, {ok:false,error:'invalid_recipient'}, origin);
      if (!pdfBase64 || pdfBase64.length > 20 * 1024 * 1024) return json(res, 400, {ok:false,error:'invalid_attachment'}, origin);

      const subject = ['Parte de accidente Allzone', plateA && ('A '+plateA), plateB && ('B '+plateB), date].filter(Boolean).join(' - ');
      const htmlContent = '<p>Adjuntamos el parte de accidente cumplimentado.</p><p><b>Vehículo A:</b> '+escapeHtml(plateA || '—')+
        '<br><b>Vehículo B:</b> '+escapeHtml(plateB || '—')+
        '<br><b>Fecha:</b> '+escapeHtml(date || '—')+
        '</p><p>Allzone Logistics</p>';

      const results = [];
      for (const to of recipients) {
        const payload = {
          sender: {email:SENDER_EMAIL, name:SENDER_NAME},
          to: [{email:to}],
          subject,
          htmlContent,
          attachment: [{name:filename, content:pdfBase64}],
          replyTo: {email:SENDER_EMAIL, name:SENDER_NAME}
        };
        const r = await fetch('https://api.brevo.com/v3/smtp/email', {
          method:'POST',
          headers:{'accept':'application/json','api-key':BREVO_API_KEY,'content-type':'application/json'},
          body:JSON.stringify(payload)
        });
        const text = await r.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch {}
        if (!r.ok) {
          console.error('brevo_send_failed', r.status, data && data.code, to);
          return json(res, 502, {ok:false,error:'mail_provider_rejected',failedRecipient:to}, origin);
        }
        results.push({email:to,messageId:data.messageId || null});
      }

      console.log('mail_sent', results.length);
      return json(res, 200, {ok:true,recipients:results.map(r=>r.email)}, origin);
    } catch (e) {
      console.error('send_report_error', e && e.message);
      return json(res, 400, {ok:false,error:'bad_request'}, origin);
    }
  });
});

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

server.listen(PORT, '0.0.0.0', () => console.log('Parte Accidente mailer listening on', PORT));

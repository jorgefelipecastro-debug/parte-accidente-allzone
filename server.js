// Railway mail gateway for Parte Accidente Allzone
// Fast path: browser uploads the PDF as binary; Railway forwards one Base64 copy to Supabase/Resend.
const http = require('http');

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_FUNCTION_URL = process.env.SUPABASE_FUNCTION_URL || '';
const SUPABASE_INTERNAL_KEY = process.env.SUPABASE_INTERNAL_KEY || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://jorgefelipecastro-debug.github.io';
const MAX_BINARY_PDF = 15 * 1024 * 1024;
const MAX_JSON_BODY = 24 * 1024 * 1024;
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

function collect(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('body_too_large'), {code:'BODY_TOO_LARGE'}));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({buffer:Buffer.concat(chunks),size}));
    req.on('error', reject);
  });
}

async function sendUpstream(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    return await fetch(SUPABASE_FUNCTION_URL, {
      method:'POST',
      headers:{
        'content-type':'application/json',
        'x-part-accident-key':SUPABASE_INTERNAL_KEY
      },
      signal:controller.signal,
      body:JSON.stringify(payload)
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function finishUpstream(r, res, origin, fallbackRecipients, meta={}) {
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok || !data.ok) {
    console.error('mail_upstream_failed', r.status, data && data.error);
    return json(res, 502, {
      ok:false,
      error:data && data.error === 'provider_rejected' ? 'mail_provider_rejected' :
            data && data.error === 'provider_timeout' ? 'mail_provider_timeout' : 'mail_provider_error',
      failedRecipient:data && data.failedRecipient ? data.failedRecipient : null
    }, origin);
  }
  console.log('mail_sent_fast', Array.isArray(data.recipients) ? data.recipients.length : 0, ...Object.entries(meta).flat());
  return json(res, 200, {ok:true,recipients:data.recipients || fallbackRecipients}, origin);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const parsed = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    cors(res, origin);
    res.writeHead(origin === ALLOWED_ORIGIN ? 204 : 403);
    return res.end();
  }

  if (req.method === 'GET' && parsed.pathname === '/health') {
    return json(res, 200, {ok:true,mailConfigured:Boolean(SUPABASE_FUNCTION_URL && SUPABASE_INTERNAL_KEY),fastBinary:true}, origin);
  }

  if (req.method === 'GET' && parsed.pathname === '/warm') {
    if (origin !== ALLOWED_ORIGIN) return json(res, 403, {ok:false,error:'origin_not_allowed'}, origin);
    try {
      const r = await sendUpstream({recipients:[],filename:'warm.pdf',pdfBase64:''});
      await r.text();
    } catch {}
    return json(res, 200, {ok:true,warmed:true}, origin);
  }

  if (req.method !== 'POST' || !['/send-report','/send-report-binary','/telemetry'].includes(parsed.pathname)) {
    return json(res, 404, {ok:false,error:'not_found'}, origin);
  }

  if (origin !== ALLOWED_ORIGIN) {
    return json(res, 403, {ok:false,error:'origin_not_allowed'}, origin);
  }

  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return json(res, 429, {ok:false,error:'rate_limited'}, origin);
  if (parsed.pathname === '/telemetry') {
    try {
      const {buffer}=await collect(req, 64 * 1024);
      const body=JSON.parse(buffer.toString('utf8'));
      const timings=body && body.timings && typeof body.timings==='object' ? body.timings : {};
      const clean={};
      for (const k of ['warm_ms','prepare_ms','build_ms','base64_ms','pdf_bytes','wait_report_ms','fetch_ms','total_send_ms']) {
        const v=Number(timings[k]);
        if (Number.isFinite(v) && v >= 0) clean[k]=Math.round(v);
      }
      const st=body && body.serverTimings && typeof body.serverTimings==='object' ? body.serverTimings : {};
      const serverClean={};
      for (const k of ['receive_ms','parse_ms','upstream_ms','total_ms']) {
        const v=Number(st[k]);
        if (Number.isFinite(v) && v >= 0) serverClean[k]=Math.round(v);
      }
      console.log('client_send_timing', String(body.mailBatchId||'').slice(0,120), JSON.stringify(clean), JSON.stringify(serverClean));
      return json(res, 200, {ok:true}, origin);
    } catch(e) {
      return json(res, 400, {ok:false,error:'bad_telemetry'}, origin);
    }
  }

  if (!SUPABASE_FUNCTION_URL || !SUPABASE_INTERNAL_KEY) return json(res, 503, {ok:false,error:'mail_not_configured'}, origin);

  try {
    const started = Date.now();

    if (parsed.pathname === '/send-report-binary') {
      const to = String(parsed.searchParams.get('to') || '').trim().toLowerCase();
      if (!validEmail(to)) return json(res, 400, {ok:false,error:'invalid_recipient'}, origin);

      const receive0=Date.now();
      const {buffer,size} = await collect(req, MAX_BINARY_PDF);
      const receiveMs=Date.now()-receive0;
      if (!size || String(req.headers['content-type'] || '').split(';')[0] !== 'application/pdf') {
        return json(res, 400, {ok:false,error:'invalid_attachment'}, origin);
      }

      const filename = String(parsed.searchParams.get('filename') || 'PARTE_COMPLETO_ALLZONE.pdf')
        .replace(/[^A-Za-z0-9._-]/g,'_').slice(0,120);
      const payload = {
        recipients:[to],
        filename,
        pdfBase64:buffer.toString('base64'),
        mailBatchId:String(parsed.searchParams.get('mailBatchId') || '').slice(0,120),
        plateA:String(parsed.searchParams.get('plateA') || '').slice(0,30),
        plateB:String(parsed.searchParams.get('plateB') || '').slice(0,30),
        date:String(parsed.searchParams.get('date') || '').slice(0,30),
        place:String(parsed.searchParams.get('place') || '').slice(0,240)
      };

      const upstreamStarted = Date.now();
      const r = await sendUpstream(payload);
      return finishUpstream(r,res,origin,[to],{
        raw_pdf_bytes:size,
        receive_ms:receiveMs,
        total_ms:Date.now()-started,
        upstream_ms:Date.now()-upstreamStarted
      });
    }

    // Legacy JSON endpoint kept for compatibility with cached older app versions.
    const receive0=Date.now();
    const {buffer,size} = await collect(req, MAX_JSON_BODY);
    const receiveMs=Date.now()-receive0;
    const parse0=Date.now();
    const body = JSON.parse(buffer.toString('utf8'));
    const parseMs=Date.now()-parse0;
    const rawRecipients = Array.isArray(body.recipients) ? body.recipients : [body.to];
    const recipients = [...new Set(rawRecipients.map(v=>String(v||'').trim().toLowerCase()).filter(validEmail))];
    const filename = String(body.filename || 'Parte_Accidente_Allzone.pdf').replace(/[^A-Za-z0-9._-]/g,'_').slice(0,120);
    const pdfBase64 = String(body.pdfBase64 || '');
    if (!recipients.length || recipients.length > 5) return json(res, 400, {ok:false,error:'invalid_recipient'}, origin);
    if (!pdfBase64 || pdfBase64.length > 20 * 1024 * 1024) return json(res, 400, {ok:false,error:'invalid_attachment'}, origin);

    const upstreamStarted = Date.now();
    const r = await sendUpstream({
      recipients,
      filename,
      pdfBase64,
      mailBatchId:String(body.mailBatchId || '').trim().slice(0,120),
      plateA:String(body.plateA || '').trim().slice(0,30),
      plateB:String(body.plateB || '').trim().slice(0,30),
      date:String(body.date || '').trim().slice(0,30),
      place:String(body.place || '').trim().slice(0,240),
      testMode:body && body.testMode === true
    });
    const upstreamMs=Date.now()-upstreamStarted;
    const totalMs=Date.now()-started;
    const clientTimings=body && body.clientTimings && typeof body.clientTimings==='object' ? body.clientTimings : {};
    console.log('mail_phase_timing', String(body.mailBatchId||'').slice(0,120),
      'receive_ms',receiveMs,'parse_ms',parseMs,'upstream_ms',upstreamMs,'total_ms',totalMs,
      'client',JSON.stringify(clientTimings));
    const text=await r.text();
    let data={};try{data=text?JSON.parse(text):{};}catch{}
    if(!r.ok||!data.ok){
      console.error('mail_upstream_failed',r.status,data&&data.error);
      return json(res,502,{ok:false,error:data&&data.error==='provider_rejected'?'mail_provider_rejected':data&&data.error==='provider_timeout'?'mail_provider_timeout':'mail_provider_error',failedRecipient:data&&data.failedRecipient?data.failedRecipient:null},origin);
    }
    return json(res,200,{ok:true,recipients:data.recipients||recipients,serverTimings:{receive_ms:receiveMs,parse_ms:parseMs,upstream_ms:upstreamMs,total_ms:totalMs,provider_ms:Number(data.provider_ms)||null,function_total_ms:Number(data.function_total_ms)||null}},origin);
  } catch (e) {
    console.error('send_report_error', e && e.message);
    if (e && (e.code === 'BODY_TOO_LARGE' || e.message === 'body_too_large')) {
      return json(res, 413, {ok:false,error:'attachment_too_large'}, origin);
    }
    if (e && e.name === 'AbortError') return json(res, 504, {ok:false,error:'mail_provider_timeout'}, origin);
    return json(res, 400, {ok:false,error:'bad_request'}, origin);
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('Parte Accidente fast mailer listening on', PORT));
import { Buffer } from 'node:buffer';

const origin = 'https://jorgefelipecastro-debug.github.io';
const maxBytes = 15 * 1024 * 1024;
const fleet = 'flota@allzonelogistics.com';
const email = v => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(v) && v.length <= 254;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cors = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-recipient,x-filename,x-plate-a,x-plate-b,x-accident-date,x-accident-place,x-mail-batch-id,x-turnstile-token',
  'Cache-Control': 'no-store',
};
const reply = (status, body) => Response.json(body, {status, headers: cors});

export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname !== '/send-accident-report') return reply(404, {ok:false});
    if (req.headers.get('origin') !== origin) return reply(403, {ok:false});
    if (req.method === 'OPTIONS') return new Response(null, {status:204, headers:cors});
    if (!env.BREVO_API_KEY || !email(env.BREVO_SENDER || '') || !env.TURNSTILE_SECRET || !env.RATE_LIMITER)
      return reply(503, {ok:false, error:'primary_not_configured', noDelivery:true, fallback:true});
    if (req.method === 'GET') return reply(200, {ok:true, ready:true});
    if (req.method !== 'POST') return reply(405, {ok:false});
    const h = name => req.headers.get(name) || '';
    const recipient = h('x-recipient').trim().toLowerCase();
    const batch = h('x-mail-batch-id');
    const token = h('x-turnstile-token');
    if (!email(recipient) || !uuid.test(batch) || h('content-type') !== 'application/pdf')
      return reply(400, {ok:false,error:'invalid_report',noDelivery:true});
    if (!token || token.length > 2048) return reply(403, {ok:false,error:'verification_required',noDelivery:true});
    const ip = h('cf-connecting-ip');
    try {
      if (!ip || !(await env.RATE_LIMITER.limit({key:ip})).success)
        return reply(429, {ok:false,error:'rate_limited',noDelivery:true});
      const verify = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method:'POST', body:new URLSearchParams({secret:env.TURNSTILE_SECRET,response:token,remoteip:ip}),
        signal:AbortSignal.timeout(8000),
      });
      const checked = await verify.json();
      if (!verify.ok || !checked.success || checked.hostname !== new URL(origin).hostname || checked.action !== 'accident_mail')
        return reply(403, {ok:false,error:'verification_failed',noDelivery:true});
    } catch { return reply(503, {ok:false,error:'verification_unavailable',noDelivery:true}); }

    let payload;
    let recipients;
    try {
      if (Number(h('content-length')) > maxBytes) return reply(413, {ok:false,error:'attachment_too_large',noDelivery:true});
      const reader = req.body?.getReader();
      if (!reader) return reply(400, {ok:false,error:'invalid_attachment',noDelivery:true});
      const chunks = [];
      let size = 0;
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); return reply(413, {ok:false,error:'attachment_too_large',noDelivery:true}); }
        chunks.push(value);
      }
      const pdf = Buffer.concat(chunks, size);
      if (pdf.subarray(0,5).toString('ascii') !== '%PDF-')
        return reply(400, {ok:false,error:'invalid_attachment',noDelivery:true});
      const filename = (h('x-filename') || 'PARTE_COMPLETO_ALLZONE.pdf').replace(/[^A-Za-z0-9._-]/g,'_').slice(0,120);
      const a = h('x-plate-a').slice(0,30), b = h('x-plate-b').slice(0,30);
      const place = decodeURIComponent(h('x-accident-place')).slice(0,240);
      const date = h('x-accident-date').slice(0,40);
      recipients = [...new Set([env.TEST_FLEET || fleet, recipient])];
      payload = JSON.stringify({
        sender:{name:'Allzone Logistics',email:env.BREVO_SENDER},
        replyTo:{email:env.TEST_FLEET || fleet},
        subject:['Parte de accidente Allzone',a && 'A '+a,b && 'B '+b].filter(Boolean).join(' · '),
        textContent:['Adjuntamos el parte completo del accidente, con la ubicación y las fotografías.',a && 'Vehículo A: '+a,b && 'Vehículo B: '+b,date && 'Fecha: '+date,place && 'Lugar: '+place].filter(Boolean).join('\n'),
        headers:{idempotencyKey:batch},
        messageVersions:[{to:recipients.map(email=>({email}))}],
        attachment:[{name:filename,content:pdf.toString('base64')}],
      });
    } catch { return reply(400, {ok:false,error:'invalid_report',noDelivery:true}); }
    try {
      const sent = await fetch('https://api.brevo.com/v3/smtp/email',{
        method:'POST',headers:{'api-key':env.BREVO_API_KEY,'Content-Type':'application/json','Accept':'application/json'},
        body:payload,signal:AbortSignal.timeout(40000),
      });
      const result = await sent.json().catch(()=>null);
      if (sent.ok && (result?.messageId || result?.messageIds?.length))
        return reply(200,{ok:true,recipients,provider:'brevo'});
      // Brevo can queue mail at its free daily limit. Never switch on quota, duplicate or uncertain responses.
      if (sent.status === 401 || sent.status === 403)
        return reply(502,{ok:false,error:'provider_authorization_rejected',noDelivery:true,fallback:true});
      return reply(502,{ok:false,error:'delivery_unknown'});
    } catch { return reply(504,{ok:false,error:'delivery_unknown'}); }
  }
};

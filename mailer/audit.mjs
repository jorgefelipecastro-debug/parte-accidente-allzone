import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from './worker.mjs';

const app=fs.readFileSync(new URL('../app.html',import.meta.url),'utf8');
for(const m of app.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
const code=app.slice(app.indexOf('async function chooseMailRoute'),app.indexOf('async function saveUnsentReport'));
const mock=(status,data)=>Response.json(data,{status});
const original=Buffer.from('%PDF-1.4\n prueba sin datos reales');
const primary='https://main.invalid', backup='https://backup.invalid';
async function route(queue,expected,check) {
 const calls=[];
 const ctx={PRIMARY_MAIL_API:primary,MAIL_API:backup,TURNSTILE_SITE_KEY:'widget',AbortSignal,getTurnstileToken:async()=> 'token',
  fetch:async(url,opts)=>{calls.push([url,opts.method||'GET']);if(opts.method==='POST')assert.equal(opts.body,original);
   const next=queue.shift();if(next instanceof Error)throw next;return next;}};
 vm.createContext(ctx);vm.runInContext(code,ctx);ctx.original=original;
 const result=await vm.runInContext('chooseMailRoute({},original)',ctx);
 assert.deepEqual(calls,expected);assert.equal(queue.length,0);check(result);
}
const pg=[primary,'GET'], pp=[primary,'POST'], bp=[backup,'POST'];
const ready=()=>mock(200,{ready:true}), ok=()=>mock(200,{ok:true});
await route([ready(),ok()],[pg,pp],r=>assert.equal(r.primary,true));
await route([mock(503,{}),ok()],[pg,bp],r=>assert.equal(r.primary,false));
await route([new Error('health offline'),ok()],[pg,bp],r=>assert.equal(r.data.ok,true));
await route([ready(),mock(502,{noDelivery:true,fallback:true}),ok()],[pg,pp,bp],r=>assert.equal(r.primary,false));
await route([ready(),new Error('response lost')],[pg,pp],r=>assert.equal(r.data.error,'delivery_unknown'));
await route([ready(),mock(504,{error:'delivery_unknown'})],[pg,pp],r=>assert.equal(r.data.error,'delivery_unknown'));
await route([ready(),mock(403,{error:'verification_failed',noDelivery:true})],[pg,pp],r=>assert.equal(r.data.error,'verification_failed'));
await route([mock(503,{}),mock(402,{message:'quota'})],[pg,bp],r=>assert.equal(r.primary,false));
console.log('8 browser routing cases passed (simulated network)');

const origin='https://jorgefelipecastro-debug.github.io';
const endpoint='https://mailer.invalid/send-accident-report';
const env={BREVO_API_KEY:'fake',BREVO_SENDER:'sender@example.invalid',TURNSTILE_SECRET:'fake',TEST_FLEET:'fleet@example.invalid',RATE_LIMITER:{limit:async()=>({success:true})}};
const headers={origin,'content-type':'application/pdf','x-recipient':'other@example.invalid','x-mail-batch-id':'3a79a8c3-952e-4637-abc1-da67dbeef851','x-turnstile-token':'mock','cf-connecting-ip':'192.0.2.2','x-plate-a':'1234ABC'};
const old=globalThis.fetch;
const make=(body=original,h=headers)=>new Request(endpoint,{method:'POST',headers:h,body});
let providerCalls=0, authorized=true, providerMode='ok', expectedPdf=original;
try {
 globalThis.fetch=async(url,opts)=>{
  if(url.includes('siteverify'))return mock(200,{success:authorized,hostname:new URL(origin).hostname,action:'accident_mail'});
  assert.equal(url,'https://api.brevo.com/v3/smtp/email');providerCalls++;
  const body=JSON.parse(opts.body);
  assert.deepEqual(body.messageVersions[0].to.map(x=>x.email),['fleet@example.invalid','other@example.invalid']);
  assert.deepEqual(Buffer.from(body.attachment[0].content,'base64'),expectedPdf);
  assert.equal(body.headers.idempotencyKey,headers['x-mail-batch-id']);
  if(providerMode==='lost') throw new Error('response lost');
  if(providerMode==='denied')return mock(401,{});
  if(providerMode==='quota')return mock(429,{});
  return mock(201,{messageIds:['fake-1']});
 };
 assert.equal((await worker.fetch(new Request(endpoint,{method:'OPTIONS',headers:{origin}}),env)).status,204);
 assert.equal((await worker.fetch(new Request(endpoint,{headers:{origin}}),env)).status,200);
 assert.equal((await worker.fetch(make(original,{...headers,origin:'https://wrong.invalid'}),env)).status,403);
 assert.equal((await worker.fetch(make(),env)).status,200);
 authorized=false;assert.equal((await worker.fetch(make(),env)).status,403);authorized=true;
 assert.equal((await worker.fetch(make(Buffer.alloc(15*1024*1024+1)),env)).status,413);
 assert.equal((await worker.fetch(make(Buffer.from('not a pdf')),env)).status,400);
 assert.equal(providerCalls,1);
 expectedPdf=Buffer.alloc(15*1024*1024);original.copy(expectedPdf);
 assert.equal((await worker.fetch(make(expectedPdf),env)).status,200);
 expectedPdf=original;
 providerMode='denied';assert.equal((await (await worker.fetch(make(),env)).json()).fallback,true);
 providerMode='lost';assert.equal((await (await worker.fetch(make(),env)).json()).error,'delivery_unknown');
 providerMode='quota';assert.equal((await (await worker.fetch(make(),env)).json()).fallback,undefined);
 assert.equal(providerCalls,5);
 console.log('11 Worker cases passed; recipients and attachment bytes verified against mock Brevo (including 15 MiB)');
} finally {globalThis.fetch=old;}

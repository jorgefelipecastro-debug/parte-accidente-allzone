const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const BASE = '882dd59754721aeedbcc62b454ccdb80f751b412';
const root = process.cwd();
const baseline = fs.mkdtempSync(path.join(os.tmpdir(), 'allzone-baseline-'));
const results = path.join(root, '.audit-results');
fs.mkdirSync(results, {recursive:true});
for (const name of execFileSync('git',['ls-tree','-r','--name-only',BASE],{encoding:'utf8'}).trim().split('\n')) {
  const out = path.join(baseline,name); fs.mkdirSync(path.dirname(out),{recursive:true});
  fs.writeFileSync(out,execFileSync('git',['show',`${BASE}:${name}`],{maxBuffer:20*1024*1024}));
}
const server = http.createServer((req,res) => {
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const base=pathname.startsWith('/baseline/')?baseline:root;
  const relative=pathname.replace(/^\/(baseline|candidate)\//,'');
  const target=path.resolve(base,relative);
  if (!target.startsWith(base+path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {res.writeHead(404);res.end();return;}
  const types={'.html':'text/html; charset=utf-8','.png':'image/png','.webp':'image/webp','.js':'text/javascript'};
  res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store'});
  res.end(fs.readFileSync(target));
});
const summary={base:BASE,tests:[],baselineFindings:[],regression:{},mail:'All POST requests intercepted; no real email sent.',limitations:['Camera capture and Android/iPhone native share hardware are simulated.','Real mailbox delivery is not exercised.']};
let browser,origin;
const hash=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const valueFor=(name,type)=>{
  if(type==='email')return 'auditoria@example.invalid';
  if(type==='tel'||/contact$/.test(name))return '600000000';
  if(type==='time')return '12:00';
  if(type==='date')return /birth/.test(name)?'1990-01-01':/until|_to$/.test(name)?'2030-01-01':'2026-10-10';
  if(name==='acc_place'||name==='property_address')return 'Calle de prueba 1, Municipio de prueba';
  if(/postcode|postal/.test(name))return '03000';
  if(/country$/.test(name))return 'España';
  if(/plate$/.test(name))return name==='a_plate'?'0000AAA':name==='b_plate'?'0000BBB':'0000CCC';
  if(name==='property_owner')return 'Titular de prueba';
  if(/damages|damage_description/.test(name))return 'Arañazo y golpe de prueba';
  if(name==='property_description')return 'Bien de prueba para auditoría';
  return 'Prueba '+name.replace(/_/g,' ');
};
async function setup(which, mobile=false) {
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:1000},isMobile:mobile,hasTouch:mobile,locale:'es-ES',timezoneId:'Europe/Madrid',geolocation:{latitude:10,longitude:20},permissions:['geolocation'],acceptDownloads:true});
  await context.addInitScript(()=>{
    const NativeDate=Date, fixed=1791626400000;
    window.Date=class extends NativeDate {constructor(...a){super(...(a.length?a:[fixed]));} static now(){return fixed;}};
    window.__paintText=[];
    const fillText=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__paintText.push(String(text));return fillText.call(this,text,...args);};
  });
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const errors=[],sent=[];let failMail=false;
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',async route=>{
    const req=route.request(),url=req.url();
    if(url.startsWith(origin+'/') || url.startsWith('data:') || url.startsWith('blob:'))return route.continue();
    if(url.includes('nominatim.openstreetmap.org'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({display_name:'Calle GPS de prueba',address:{road:'Calle GPS de prueba',house_number:'1',postcode:'03000',city:'Municipio de prueba',country:'España'}})});
    if(url.endsWith('/send-report')&&req.method()==='POST') {
      const data=req.postDataJSON();sent.push(data);
      assert.ok(data.recipients[0].endsWith('@example.invalid'));
      assert.ok(data.pdfBase64.startsWith('JVBERi0xLjQ'));
      assert.ok(data.pdfBase64.length<20*1024*1024,'PDF exceeds backend attachment limit');
      return route.fulfill({status:failMail?502:200,contentType:'application/json',body:JSON.stringify(failMail?{ok:false,error:'mail_provider_timeout'}:{ok:true,recipients:['flota@allzonelogistics.com',...data.recipients]})});
    }
    return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"mailConfigured":true}'});
  });
  await page.goto(`${origin}/${which}/app.html`);
  await page.waitForFunction(()=>window.AllzoneV16&&document.querySelector('#host h1'));
  await page.evaluate(()=>AllzoneV16.artworkReady);
  return {page,context,errors,sent,setFail:value=>failMail=value};
}
const step=page=>page.evaluate(()=>AllzoneV16.step().title);
async function clickNext(page){const before=await step(page);await page.locator('#nextBtn').click();await page.waitForFunction(t=>AllzoneV16.step().title!==t,before);}
async function fillFields(page,scenario){
  for(const details of await page.locator('details').all()) {
    if(scenario.rich && !(await details.getAttribute('open')))await details.locator('summary').click();
  }
  for(const el of await page.locator('#host [data-field]').all()) {
    if(!(await el.isVisible()))continue;
    const info=await el.evaluate(e=>({name:e.dataset.field,type:e.type,tag:e.tagName,value:e.value,options:e.options?[...e.options].map(o=>o.value):null}));
    if(info.name==='additional_vehicle_count'){await el.fill(String(scenario.extras||1));await el.dispatchEvent('change');continue;}
    if(info.options){
      const selected=info.name==='property_type'?(scenario.propertyType||'Fachada / muro'):/license_category/.test(info.name)?(/b_/.test(info.name)&&scenario.type==='Moto'?'A2':/b_/.test(info.name)&&scenario.type==='Camión'?'C':info.options.includes('B')?'B':info.options[1]):(scenario.victims?'Sí':info.options[1]);
      await el.selectOption(selected);continue;
    }
    await el.fill(valueFor(info.name,info.type));
  }
}
async function stroke(page,selector,impact=false){
  const el=page.locator(selector);await el.scrollIntoViewIfNeeded();const b=await el.boundingBox();
  if(impact){await page.mouse.click(b.x+b.width*.50,b.y+b.height*.36);return;}
  await page.mouse.move(b.x+b.width*.2,b.y+b.height*.4);await page.mouse.down();
  await page.mouse.move(b.x+b.width*.32,b.y+b.height*.5);await page.mouse.move(b.x+b.width*.48,b.y+b.height*.33);await page.mouse.move(b.x+b.width*.64,b.y+b.height*.5);await page.mouse.up();
}
async function photo(page,key,source='library'){
  await page.locator(`[data-photo-key="${key}"][data-origin="${source}"]`).setInputFiles(path.join(root,'assets/pantalla3-aprobada-exacta.png'));
  await page.waitForFunction(()=>AllzoneV16.ready());
  assert.equal(await page.locator(`#preview_${key} img`).count(),1);
}
async function capture(page,title,screens){
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.waitForFunction(()=>!document.querySelector('#host img:not([src^="blob:"])')||[...document.querySelectorAll('#host img')].every(im=>im.complete));
  const imagePath=path.join(results,`${new URL(page.url()).pathname.split('/')[1]}-${title.replace(/[^A-Za-z0-9]/g,'_')}.png`);
  const buffer=await page.locator('.shell').screenshot({animations:'disabled',caret:'hide',path:imagePath});
  screens[title]={hash:hash(buffer),path:imagePath,dom:await page.locator('#host').evaluate(el=>el.innerHTML.replace(/ data-side="[^"]*"/g,''))};
}
async function scenarioRun(scenario,which='candidate',regression=false){
  const test=await setup(which,scenario.mobile),{page,context}=test;
  const screens={},visited=[];
  await page.locator('[data-field="a_plate"]').fill('0000AAA');
  if(scenario.propertyOnly){await page.locator('#propertyOnly').check();assert.equal(await page.locator('[data-field="b_plate"]').count(),0);}
  else await page.locator('[data-field="b_plate"]').fill('0000BBB');
  await clickNext(page);
  for(let guard=0;guard<120;guard++){
    const title=await step(page);visited.push(title);
    if(scenario.propertyOnly)assert.ok(!['Tipo B','Conductor B','Asegurado B','Seguro B','Impacto B'].includes(title));
    if(title==='Accidente'){
      if(scenario.victims)await page.locator('[data-yn="victims"][data-value="Sí"]').click();
      if(!scenario.propertyOnly){
        if(scenario.extras)await page.locator('[data-yn="other_vehicles_damage"][data-value="Sí"]').click();
        if(scenario.property)await page.locator('[data-yn="other_objects_damage"][data-value="Sí"]').click();
      }
    }
    if(title==='Tipo B')await page.locator(`[data-choice="b_vehicle_type"][data-value="${scenario.type||'Coche'}"]`).click();
    if(title.startsWith('Datos adicional '))await page.locator(`[data-choice$="vehicle_type"][data-value="${scenario.extraType||'Coche'}"]`).click();
    await fillFields(page,scenario);
    if(title==='Impacto A'||title==='Impacto B'){
      await stroke(page,'#impactCanvas',true);
      const side=title.slice(-1);await page.locator(`[data-add-impact="${side}"]`).click();await stroke(page,'#impactCanvas',true);await page.locator(`[data-undo-impact="${side}"]`).click();
    }
    if(title==='Circunstancias'){
      await page.locator('[data-circ="left"][data-n="14"]').click();
      if(!scenario.propertyOnly)await page.locator('[data-circ="right"][data-n="1"]').click();
      else assert.equal(await page.locator('[data-circ="right"]').count(),0);
    }
    if(title==='Croquis'){
      const sides=await page.evaluate(()=>sceneState().items.map(x=>x.side));
      assert.deepEqual(sides,scenario.propertyOnly?['A']:['A','B',...Array.from({length:scenario.extras||0},(_,i)=>String.fromCharCode(67+i))]);
      assert.equal(await page.locator('[data-select-vehicle="B"]').count(),scenario.propertyOnly?0:1);
      assert.ok(await page.evaluate(()=>sceneState().items.every(it=>it.x>0&&it.x<860&&it.y>=85&&it.y<=475)),'All automatically placed vehicles must remain inside the sketch');
      for(const road of ['straight','cross','roundabout','blank']){await page.locator(`[data-road="${road}"]`).click();assert.equal(await page.evaluate(()=>sceneState().road),road);}
      await page.locator('[data-road="straight"]').click();
      await page.locator('#rotateLeft').click();await page.locator('#rotateRight').click();await page.locator('#growVehicle').click();
      await page.locator('#penTool').click();await stroke(page,'#sketch');await page.locator('#undoLine').click();await page.locator('#penTool').click();
      if(scenario.propertyOnly)await page.screenshot({path:path.join(results,scenario.mobile?'inmueble-movil-croquis.png':'inmueble-escritorio-croquis.png'),fullPage:true});
    }
    if(title==='Fotos'){
      await page.locator('#nextBtn').click();assert.equal(await step(page),'Fotos');
      const keys=await page.evaluate(()=>photoTargets().filter(t=>t.required).map(t=>t.key));
      if(scenario.propertyOnly)assert.deepEqual(keys,['a_damage','a_plate','property_damage']);
      for(const key of keys)await photo(page,key,key==='a_damage'?'camera':'library');
      if(scenario.rich){await photo(page,'scene');await photo(page,'docs');await page.locator('[data-delete-photo="docs"]').click();assert.equal(await page.locator('#preview_docs img').count(),0);await photo(page,'docs');}
      if(scenario.propertyOnly)await page.screenshot({path:path.join(results,scenario.mobile?'inmueble-movil-fotos.png':'inmueble-escritorio-fotos.png'),fullPage:true});
    }
    if(title==='Firmas'){
      await stroke(page,'#sigA');if(!scenario.propertyOnly)await stroke(page,'#sigB');else assert.equal(await page.locator('#sigB').count(),0);
    }
    if(title.startsWith('Firma adicional ')){
      await stroke(page,'#extraImpact',true);await stroke(page,'#extraSigA');await stroke(page,'#extraSig');
      const right=page.locator('[data-circ="right"][data-n="1"]');await right.click();await right.click();
      assert.equal(await right.textContent(),title.slice(-1));
    }
    if(title==='Entrega'){
      assert.equal(await page.locator('#sendAndFinish').isDisabled(),false,'Valid email should enable send');
      if(scenario.propertyOnly)assert.equal(await page.locator('label[for="field_b_copy_email"]').textContent(),'Correo del propietario / responsable');
      if(scenario.testFailure){
        test.setFail(true);await page.locator('#sendAndFinish').click();await page.waitForFunction(()=>!pdfBusy);
        assert.equal(await step(page),'Entrega');assert.match(await page.locator('#navigationMessage').textContent(),/No se ha enviado/);
        assert.ok(await page.evaluate(()=>photos.size)>0);test.setFail(false);
      }
      await page.locator('#sendAndFinish').click();await page.waitForFunction(()=>AllzoneV16.step().title==='Revisión');
      const payload=test.sent.at(-1);assert.equal(payload.plateB,scenario.propertyOnly?'':'0000BBB');
      const pdf=Buffer.from(payload.pdfBase64,'base64');
      assert.ok(pdf.toString('ascii',0,8).startsWith('%PDF-1.4'));
      const expectedPhotos=2+(scenario.propertyOnly?1:2)+2*(scenario.extras||0)+(scenario.rich?2:0);
      assert.equal(await page.evaluate(()=>finalFleetReport.photoCount),expectedPhotos);
      assert.ok(await page.evaluate(()=>finalFleetReport.pages)>=Math.ceil(expectedPhotos/2)+2+(scenario.propertyOnly||scenario.property?1:0));
      const texts=await page.evaluate(()=>window.__paintText);
      if(scenario.propertyOnly||scenario.property){assert.ok(texts.includes('Daños a propiedad'));assert.ok(texts.includes('Titular de prueba'));}
      assert.ok(!texts.includes('BORRADOR · FALTAN FIRMAS'));
      if(scenario.propertyOnly&&scenario.rich&&!scenario.mobile)fs.writeFileSync(path.join(results,'inmueble-escritorio.pdf'),pdf);
      if(scenario.propertyOnly&&scenario.mobile)fs.writeFileSync(path.join(results,'inmueble-movil.pdf'),pdf);
      if(scenario.rich||regression){
        const download=page.waitForEvent('download');await page.locator('#downloadFullOnly').click();const file=await download;
        const bytes=fs.readFileSync(await file.path());assert.equal(hash(bytes),hash(pdf),'download must match emailed PDF exactly');
      }
      const cleared=await page.evaluate(async()=>{const tx=database.transaction(['meta','photos'],'readonly');return await Promise.all(['meta','photos'].map(n=>new Promise(r=>{const q=tx.objectStore(n).count();q.onsuccess=()=>r(q.result)})));});
      assert.deepEqual(cleared,[0,0]);assert.deepEqual(test.errors,[]);
      await context.close();return {screens,pdfHash:hash(pdf),visited,pages:(pdf.toString('binary').match(/\/Type \/Page\b/g)||[]).length,bytes:pdf.length,photos:expectedPhotos};
    }
    if(regression&&title!=='Vehículos')await capture(page,title,screens);
    await clickNext(page);
  }
  throw new Error('Flow exceeded expected step count');
}
async function baselineFindings(){
  const {page,context}=await setup('baseline');
  await page.locator('[data-field="a_plate"]').fill('0000AAA');await page.locator('#nextBtn').click();assert.equal(await step(page),'Vehículos');
  summary.baselineFindings.push('The original first screen blocks when B plate is absent, before property selection.');
  await page.locator('[data-field="b_plate"]').fill('0000BBB');await clickNext(page);await page.locator('[data-yn="other_objects_damage"][data-value="Sí"]').click();
  assert.ok(await page.evaluate(()=>getSteps().some(s=>s.title==='Tipo B')));
  assert.deepEqual(await page.evaluate(()=>activeVehicles()),['A','B']);
  summary.baselineFindings.push('Selecting property damage keeps B vehicle steps, four A/B photo requirements and two vehicles in the sketch.');
  for(const type of ['Moto','Camión']) {
    await page.evaluate(type=>{state.b_vehicle_type=type;AllzoneV16.show('Conductor B')},type);
    const options=await page.locator('[data-field="b_license_category"] option').allTextContents();assert.deepEqual(options,['Seleccionar','B','B96','B+E']);
    summary.baselineFindings.push(type+' B offers only car licence categories in original.');
  }
  await page.evaluate(()=>{state.other_vehicles_damage='Sí';ensureExtraDefaults();AllzoneV16.show('Firma adicional C')});
  const right=page.locator('[data-circ="right"][data-n="1"]');await right.click();await right.click();assert.equal(await right.textContent(),'B');
  summary.baselineFindings.push('Additional C circumstance label changes to B after deselection.');
  await page.evaluate(()=>{state.additional_vehicle_count='20';AllzoneV16.show('Croquis')});
  assert.ok(await page.evaluate(()=>sceneState().items.some(it=>it.y>560)));
  summary.baselineFindings.push('At the maximum additional-vehicle count, original automatic placement puts vehicles outside the visible sketch.');
  await context.close();
}
async function negativeAndTransitions(){
  const t=await setup('candidate'),{page,context}=t;
  await page.locator('#propertyOnly').check();await page.locator('#nextBtn').click();assert.equal(await step(page),'Vehículos');
  await page.locator('[data-field="a_plate"]').fill('0000AAA');await clickNext(page);await page.locator('#backBtn').click();await page.locator('#propertyOnly').uncheck();
  assert.equal(await page.locator('[data-field="a_plate"]').inputValue(),'0000AAA');assert.equal(await page.locator('[data-field="b_plate"]').count(),1);
  await page.locator('[data-field="b_plate"]').fill('0000BBB');await clickNext(page);
  await page.locator('#gpsPlaceBtn').click();await page.waitForFunction(()=>document.querySelector('#gpsPlaceStatus').textContent.includes('Dirección detectada'));
  assert.match(await page.locator('[data-field="acc_place"]').inputValue(),/GPS de prueba/);
  await page.evaluate(()=>AllzoneV16.show('Fotos'));
  const inp=page.locator('[data-photo-key="a_damage"][data-origin="library"]');
  await inp.setInputFiles({name:'invalid.png',mimeType:'image/png',buffer:Buffer.from('invalid')});await page.waitForFunction(()=>AllzoneV16.ready());
  assert.match(await page.locator('#photoStatus_a_damage').textContent(),/No se ha podido leer/);assert.equal(await page.locator('#preview_a_damage img').count(),0);
  await inp.setInputFiles({name:'empty.png',mimeType:'image/png',buffer:Buffer.alloc(0)});await page.waitForFunction(()=>AllzoneV16.ready());assert.match(await page.locator('#photoStatus_a_damage').textContent(),/vacío/);
  await photo(page,'a_damage');await page.locator('#sharePhotos').click();assert.match(await page.locator('#navigationMessage').textContent(),/no permite compartir/);
  await page.evaluate(()=>{Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async d=>{window.__shared=d.files.map(f=>({name:f.name,type:f.type,size:f.size}));}});});
  await page.locator('#sharePhotos').click();assert.equal(await page.evaluate(()=>window.__shared.length),1);
  const download=page.waitForEvent('download');await page.locator('#downloadPhotos').click();assert.ok((await download).suggestedFilename().startsWith('FOTOS_'));
  assert.deepEqual(t.errors,[]);await context.close();summary.tests.push({name:'Invalid fields, mode transitions, GPS, corrupt/empty photos, photo sharing and photo PDF',ok:true});
}
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true});
  await baselineFindings();await negativeAndTransitions();
  const normal={name:'normal-car-regression',type:'Coche',rich:true};
  const old=await scenarioRun(normal,'baseline',true),fresh=await scenarioRun(normal,'candidate',true);
  fs.writeFileSync(path.join(results,'regression.json'),JSON.stringify({old,fresh},null,2));
  const comparisons=[];
  for(const title of Object.keys(old.screens)){
    assert.equal(fresh.screens[title].dom,old.screens[title].dom,'Unaffected DOM differs: '+title);
    const a=PNG.sync.read(fs.readFileSync(old.screens[title].path)),b=PNG.sync.read(fs.readFileSync(fresh.screens[title].path));
    assert.equal(a.width,b.width);assert.equal(a.height,b.height);
    let changedPixels=0,maxChannelDelta=0;
    for(let i=0;i<a.data.length;i+=4){let changed=false;for(let k=0;k<4;k++){const d=Math.abs(a.data[i+k]-b.data[i+k]);if(d)changed=true;maxChannelDelta=Math.max(maxChannelDelta,d);}if(changed)changedPixels++;}
    assert.ok(maxChannelDelta<=1&&changedPixels<=a.width*a.height*.001,'Visible screen differs: '+title);
    comparisons.push({title,changedPixels,maxChannelDelta,pixelExact:changedPixels===0});
  }
  assert.equal(fresh.pdfHash,old.pdfHash,'Normal car full PDF must be byte identical');
  summary.regression={screenCount:Object.keys(old.screens).length,domIdentical:true,comparisons,pdfByteIdentical:true};
  summary.tests.push({name:normal.name,ok:true,pages:fresh.pages,bytes:fresh.bytes});
  const types=['Moto','Coche','Camión'];
  const propertyTypes=['Mobiliario urbano','Señal de tráfico','Farola / alumbrado','Valla / barrera','Fachada / muro','Puerta / acceso','Otro'];
  const scenarios=[];
  for(const type of types)for(const property of [false,true])for(const victims of [false,true])scenarios.push({name:`B-${type}-property-${property}-victims-${victims}`,type,property,victims});
  for(const propertyType of propertyTypes)for(const victims of [false,true])scenarios.push({name:`property-only-${propertyType}-${victims}`,propertyOnly:true,propertyType,victims,rich:propertyType==='Fachada / muro'&&!victims,testFailure:propertyType==='Puerta / acceso'&&!victims});
  for(const extraType of types)scenarios.push({name:`additional-${extraType}`,extras:2,extraType,type:'Coche',property:true});
  scenarios.push({name:'maximum-20-additional',extras:20,type:'Camión'});
  scenarios.push({name:'property-only-mobile',propertyOnly:true,mobile:true,rich:true});
  scenarios.push({name:'two-vehicle-mobile',type:'Moto',mobile:true});
  scenarios.push({name:'additional-mobile',type:'Camión',extras:1,extraType:'Moto',mobile:true});
  for(const s of scenarios){console.log('RUN',s.name);const r=await scenarioRun(s);summary.tests.push({name:s.name,ok:true,steps:r.visited.length,pages:r.pages,bytes:r.bytes,photos:r.photos});fs.writeFileSync(path.join(results,'audit.json'),JSON.stringify(summary,null,2));console.log('PASS',s.name,r.pages+' pages',r.bytes+' bytes');}
  try{const r=await fetch('https://parte-accidente-mailer-production.up.railway.app/health',{headers:{Origin:'https://jorgefelipecastro-debug.github.io'},signal:AbortSignal.timeout(20000)});summary.liveMailHealth={status:r.status,body:await r.json(),cors:r.headers.get('access-control-allow-origin')};}catch(e){summary.liveMailHealth={error:e.message};}
  fs.writeFileSync(path.join(results,'audit.json'),JSON.stringify(summary,null,2));console.log('AUDIT COMPLETE',summary.tests.length,'checks');
})().catch(e=>{summary.failure=e.stack;fs.writeFileSync(path.join(results,'audit.json'),JSON.stringify(summary,null,2));console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.close();});

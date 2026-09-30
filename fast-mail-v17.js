(function(){
'use strict';

const DIRECT_MAIL_API_V17='https://raiekkhzybordgfhbvas.supabase.co/functions/v1/send-accident-report';

function resetTelemetryV17(){
  mailTelemetry={
    warm_ms:null,prepare_ms:null,build_ms:null,base64_ms:0,pdf_bytes:null,
    wait_report_ms:null,direct_fetch_ms:null,fallback_fetch_ms:null,
    total_send_ms:null,route:null,provider_ms:null,function_total_ms:null
  };
}

warmMailer=function(){
  if(mailerWarmPromise)return mailerWarmPromise;
  const t0=performance.now();
  mailerWarmPromise=fetch(DIRECT_MAIL_API_V17,{method:'GET',cache:'no-store'})
    .catch(()=>null)
    .finally(()=>{
      mailTelemetry.warm_ms=Math.round(performance.now()-t0);
      setTimeout(()=>{mailerWarmPromise=null;},30000);
    });
  return mailerWarmPromise;
};

prepareEmailReport=async function(){
  if(preparedEmailReport)return preparedEmailReport;
  if(preparedEmailReportPromise)return preparedEmailReportPromise;
  preparedEmailReportPromise=(async()=>{
    const prep0=performance.now();
    await new Promise(r=>requestAnimationFrame(r));
    const build0=performance.now();
    const fullResult=await buildDocument('full','B');
    mailTelemetry.build_ms=Math.round(performance.now()-build0);
    mailTelemetry.prepare_ms=Math.round(performance.now()-prep0);
    mailTelemetry.pdf_bytes=fullResult.blob.size;
    const clean=v=>String(v||'sin_datos').replace(/[^A-Za-z0-9_-]/g,'_');
    const commonFilename='PARTE_COMPLETO_ALLZONE_'+clean(state.acc_date)+'_'+clean(state.a_plate)+'_'+clean(state.b_plate)+'.pdf';
    const report={fullResult,commonFilename};
    preparedEmailReport=report;
    return report;
  })();
  try{return await preparedEmailReportPromise;}
  catch(e){preparedEmailReport=null;throw e;}
  finally{preparedEmailReportPromise=null;}
};

async function fallbackRailwayV17(report,recipients){
  const b640=performance.now();
  const fullPdfBase64=await blobToBase64(report.fullResult.blob);
  mailTelemetry.base64_ms=Math.round(performance.now()-b640);
  const fallback0=performance.now();
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),65000);
  let response;
  try{
    response=await fetch(MAIL_API+'/send-report',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal:controller.signal,
      body:JSON.stringify({
        recipients,
        filename:report.commonFilename,
        pdfBase64:fullPdfBase64,
        mailBatchId:currentMailBatchId,
        plateA:state.a_plate,
        plateB:state.b_plate,
        date:state.acc_date,
        place:state.acc_place,
        postcode:state.acc_postcode
      })
    });
  }finally{clearTimeout(timeout);}
  mailTelemetry.fallback_fetch_ms=Math.round(performance.now()-fallback0);
  let data={};try{data=await response.json();}catch{}
  if(!response.ok||!data.ok)throw new Error(data.error||'fallback_failed');
  mailTelemetry.route='railway_fallback';
  const st=data.serverTimings||{};
  mailTelemetry.provider_ms=Number(st.provider_ms)||null;
  mailTelemetry.function_total_ms=Number(st.function_total_ms)||null;
  return data;
}

sendReportByEmail=async function(){
  if(pdfBusy)return;
  sync();
  const recipients=[String(state.b_copy_email||'').trim()].filter(Boolean);
  const emailField=document.querySelector('[data-field="b_copy_email"]');
  if(!recipients.length||!emailField||!emailField.checkValidity()){
    navMessage('Introduce un correo válido del contrario.');
    emailField?.focus();
    return;
  }
  const requiredCore=['a_damage','a_plate','b_damage','b_plate'];
  const missingCore=requiredCore.filter(k=>!photos.has(k));
  if(missingCore.length){
    navMessage('No se puede enviar: faltan las 4 fotos obligatorias de los vehículos A y B.');
    return;
  }
  if(!String(state.acc_place||'').trim()){
    navMessage('No se puede enviar: falta la dirección exacta del accidente.');
    return;
  }

  resetTelemetryV17();
  pdfBusy=true;
  nextBtn.disabled=true;
  const btn=document.getElementById('sendAndFinish')||document.getElementById('sendEmailReport');
  if(btn){btn.disabled=true;btn.textContent='ENVIANDO…';}
  const total0=performance.now();

  try{
    const wait0=performance.now();
    const report=await prepareEmailReport();
    mailTelemetry.wait_report_ms=Math.round(performance.now()-wait0);
    if(!currentMailBatchId)currentMailBatchId=(crypto.randomUUID?crypto.randomUUID():(Date.now()+'-'+Math.random().toString(16).slice(2)));

    let data={};
    const direct0=performance.now();
    let directResponse;
    try{
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),45000);
      try{
        directResponse=await fetch(DIRECT_MAIL_API_V17,{
          method:'POST',
          headers:{
            'Content-Type':'application/pdf',
            'X-Recipient':recipients[0],
            'X-Filename':report.commonFilename,
            'X-Plate-A':String(state.a_plate||''),
            'X-Plate-B':String(state.b_plate||''),
            'X-Accident-Date':String(state.acc_date||''),
            'X-Accident-Place':encodeURIComponent(String(state.acc_place||'')),
            'X-Mail-Batch-Id':currentMailBatchId
          },
          signal:controller.signal,
          body:report.fullResult.blob
        });
      }finally{clearTimeout(timeout);}
      mailTelemetry.direct_fetch_ms=Math.round(performance.now()-direct0);
      try{data=await directResponse.json();}catch{data={};}

      if(!directResponse.ok||!data.ok){
        if([401,403,404,405,429].includes(directResponse.status)){
          data=await fallbackRailwayV17(report,recipients);
        }else{
          throw new Error(data.error||'direct_failed');
        }
      }else{
        mailTelemetry.route='direct_supabase';
        mailTelemetry.provider_ms=Number(data.provider_ms)||null;
        mailTelemetry.function_total_ms=Number(data.function_total_ms)||null;
      }
    }catch(e){
      if(e&&e.name==='AbortError')throw e;
      if(directResponse)throw e;
      throw e;
    }

    mailTelemetry.total_send_ms=Math.round(performance.now()-total0);
    try{
      fetch(TELEMETRY_API,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        keepalive:true,
        body:JSON.stringify({mailBatchId:currentMailBatchId,timings:mailTelemetry})
      }).catch(()=>{});
    }catch{}

    currentMailBatchId='';
    finalFleetReport={
      blob:report.fullResult.blob,
      file:new File([report.fullResult.blob],report.commonFilename,{type:'application/pdf',lastModified:Date.now()}),
      name:report.commonFilename,
      pages:report.fullResult.pages,
      photoCount:photoTargets().filter(t=>photos.has(t.key)).length
    };
    await clearPersistedDraft();
    idx=getSteps().findIndex(s=>s.title==='Revisión');
    render();
  }catch(e){
    const msg=e&&e.name==='AbortError'
      ?'El servidor ha tardado demasiado. Intenta enviar de nuevo; el parte se conserva.'
      :'No se pudo completar el envío. El parte se conserva para reintentar.';
    navMessage(msg);
    console.error(e);
  }finally{
    pdfBusy=false;
    nextBtn.disabled=false;
    if(btn){btn.disabled=false;btn.textContent='ENVIAR Y FINALIZAR';}
  }
};

const strip=document.querySelector('.version-strip');
if(strip)strip.textContent='V17.0 - PARTE ACCIDENTE';
if(window.AllzoneV16)window.AllzoneV16.version='V17.0 - ENVIO DIRECTO EUROPA';
})();
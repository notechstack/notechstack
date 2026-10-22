import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const host=readFileSync('shared/marketing-host.js','utf8');
const sandbox={window:{}};vm.runInNewContext(host,sandbox);
const allowed=sandbox.window.noMarketingHostAllowed;
const cases=[['www.notechstack.com.br',true],['notechstack.com.br',true],['WWW.NOTECHSTACK.COM.BR',true],
 ['notechstack-lp-git-t5-luccavgiani-spec.vercel.app',false],['notechstack-lp.vercel.app',false],['localhost',false],['127.0.0.1',false],
 ['notechstack.com.br.vercel.app',false],['evil-notechstack.com.br',false],['',false],[undefined,false]];
for(const [h,want] of cases){assert.equal(allowed(h),want,String(h));console.log(`${want?'permite':'bloqueia'}  ${h}`);}

// Each loader sends nothing outside production and loads GTM once in production.
function run(file,hostname,{withHost=true}={}){
 const scripts=[],listeners={},timers=[];
 const context={location:{hostname},Date,setTimeout:f=>timers.push(f),addEventListener:(e,f)=>(listeners[e]=f),
  window:{dataLayer:[]},document:{readyState:'complete',querySelector:()=>null,createElement:()=>({}),head:{appendChild:s=>scripts.push(s)},body:{append:s=>scripts.push(s)}}};
 context.window.addEventListener=context.addEventListener;
 if(withHost)vm.runInNewContext(host,context);
 vm.runInNewContext(readFileSync(file,'utf8'),context);
 Object.values(listeners).forEach(f=>f());timers.forEach(f=>f());
 return scripts.filter(s=>/googletagmanager/.test(s.src||''));
}
for(const file of ['shared/marketing.js','shared/marketing-lazy.js']){
 assert.equal(run(file,'www.notechstack.com.br').length,1,file+' www');
 for(const h of ['x.vercel.app','localhost','127.0.0.1'])assert.equal(run(file,h).length,0,file+' '+h);
 assert.equal(run(file,'www.notechstack.com.br',{withHost:false}).length,0,file+' sem marketing-host.js falha fechado');
}

// Every GTM load point in the repo goes through the single host function (noscript is justified in the inventory).
const pages={'agencia/index.html':'marketing.js','contato/index.html':'marketing.js',
 'lp-narrador/cenas-lp/lp-v8.html':'marketing.js','health/index.html':'inline','sobre/index.html':'inline',
 'lp-narrador/cenas-lp/lp-v5.html':'inline','lp-narrador/cenas-lp/lp-v7.html':'inline','lp-narrador/cenas-lp/lp-v3.html':'inline'};
for(const [file,kind] of Object.entries(pages)){
 const html=readFileSync(file,'utf8'),hostAt=html.indexOf('/shared/marketing-host.js');
 assert.equal((html.match(/\/shared\/marketing-host\.js/g)||[]).length,1,file+' carrega marketing-host.js uma vez');
 const loadAt=kind==='inline'?html.search(/gtm\.js\?id=/):html.indexOf('/shared/marketing.js');
 assert(hostAt>-1&&hostAt<loadAt,file+' marketing-host.js antes do carregamento');
 if(kind==='inline'){
  const tags=html.match(/<script>[^]*?<\/script>/g).filter(t=>/googletagmanager\.com\/gtm\.js/.test(t));
  assert(tags.length>0&&tags.every(t=>t.includes('window.noMarketingHostAllowed(location.hostname)')),file+' snippet protegido');
  for(const [h,want] of [['www.notechstack.com.br',1],['x.vercel.app',0],['localhost',0]]){
   const inserted=[],first={parentNode:{insertBefore:s=>inserted.push(s)}},cbs=[];
   const ctx={location:{hostname:h},Date,setTimeout:f=>cbs.push(f),
    document:{getElementsByTagName:()=>[first],createElement:()=>({}),head:{appendChild:s=>inserted.push(s)}}};
   ctx.window=ctx;ctx.addEventListener=(e,f)=>cbs.push(f);
   vm.runInNewContext(host,ctx);
   for(const t of tags)vm.runInNewContext(t.replace(/^<script>|<\/script>$/g,''),ctx);
   while(cbs.length)cbs.shift()();
   assert.equal(inserted.filter(s=>/googletagmanager/.test(s.src||'')).length,want,file+' '+h);
  }
 }
}
console.log('PASS: host único, loaders bloqueiam preview/local e todos os pontos de carga do GTM passam pela função');

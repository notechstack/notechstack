// Clique em link do WhatsApp dispara whatsapp_click (dataLayer/GA4) e Contact (Meta, se fbq existir).
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const code=readFileSync('shared/telemetria.js','utf8');

function el(tag,attrs={},parent=null){
 return {tagName:tag.toUpperCase(),parentNode:parent,getAttribute:k=>(k in attrs?attrs[k]:null)};
}
function boot(pathname,{withFbq=true}={}){
 const docListeners=[],fbqCalls=[],store={};
 const ctx={location:{hostname:'localhost',pathname,search:''},URLSearchParams,URL,Date,Math,JSON,String,Object,
  setTimeout:()=>0,clearTimeout:()=>{},addEventListener:()=>{},navigator:{},
  document:{referrer:'',cookie:'',visibilityState:'visible',
   addEventListener:(type,fn,capture)=>docListeners.push({type,fn,capture})}};
 ctx.sessionStorage={getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=String(v);}};
 ctx.window=ctx;
 if(withFbq)ctx.fbq=(...a)=>fbqCalls.push(a);
 vm.runInNewContext(code,ctx);
 const click=(target,{composed=false}={})=>{
  const ev={type:'click',target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
  if(composed){const p=[];for(let n=target;n;n=n.parentNode)p.push(n);ev.composedPath=()=>p;}
  docListeners.filter(l=>l.type==='click').forEach(l=>l.fn(ev));
  return ev;
 };
 return {ctx,docListeners,fbqCalls,click,events:()=>ctx.dataLayer.filter(e=>e.event==='whatsapp_click')};
}

// 1) rodapé em /agencia/: clique no <span> dentro do <a class="ft-whatsapp">
{
 const t=boot('/agencia/');
 const l=t.docListeners.find(l=>l.type==='click');
 assert(l&&l.capture===true,'listener de clique no document em capture');
 const a=el('a',{class:'ft-whatsapp',href:'https://wa.me/5511939289413?text=Ol%C3%A1'});
 const span=el('span',{},a);
 const ev=t.click(span);
 assert.equal(ev.defaultPrevented,false,'não bloqueia a navegação');
 const e=t.events();
 assert.equal(e.length,1);
 assert.equal(e[0].pagina,'/agencia/');assert.equal(e[0].link,'rodape');assert(e[0].lead_sid);
 assert.equal(t.fbqCalls.length,1);
 assert.deepEqual(JSON.parse(JSON.stringify(t.fbqCalls[0])),['track','Contact',{pagina:'/agencia/'}]);
 // cada clique conta (sem chave de sessão)
 t.click(a);
 assert.equal(t.events().length,2);assert.equal(t.fbqCalls.length,2);
 console.log('ok  rodapé /agencia/ ->',JSON.stringify({event:e[0].event,pagina:e[0].pagina,link:e[0].link}),'| fbq',JSON.stringify(t.fbqCalls[0]));
}
// 2) link de conteúdo api.whatsapp.com, via composedPath, na home
{
 const t=boot('/');
 const a=el('a',{href:'https://api.whatsapp.com/send?phone=5511939289413'});
 t.click(el('b',{},a),{composed:true});
 assert.equal(t.events().length,1);assert.equal(t.events()[0].link,'conteudo');assert.equal(t.events()[0].pagina,'/');
 console.log('ok  conteúdo api.whatsapp.com na home -> link=conteudo');
}
// 3) sem fbq: GA4 continua, nada quebra
{
 const t=boot('/contato/',{withFbq:false});
 t.click(el('a',{href:'https://wa.me/5511939289413'}));
 assert.equal(t.events().length,1);assert.equal(typeof t.ctx.fbq,'undefined');
 console.log('ok  sem window.fbq -> só dataLayer');
}
// 4) não dispara para links que não são WhatsApp, nem para <a> interno dentro de outro <a> wa.me
{
 const t=boot('/sobre/');
 for(const href of ['/contato/','https://example.com/?u=wa.me','https://notwa.me/x','mailto:oi@wa.me',null])t.click(el('a',href?{href}:{}));
 t.click(el('div'));
 assert.equal(t.events().length,0);assert.equal(t.fbqCalls.length,0);
 console.log('ok  links não-WhatsApp ignorados');
}
// 5) erro dentro do track não escapa do listener
{
 const t=boot('/agencia/');
 t.ctx.track=()=>{throw new Error('boom');};
 assert.doesNotThrow(()=>t.click(el('a',{class:'ft-whatsapp',href:'https://wa.me/1'})));
 console.log('ok  erro no track fica no try/catch');
}
// 6) rodapé gerado continua sem data-track (agencia.js dispararia cta_click/modo agencia)
assert(!/class="ft-whatsapp"[^>]*data-track/.test(readFileSync('shared/sync-site-layout.mjs','utf8')));
// 7) toda página com o rodapé compartilhado carrega a telemetria e o GTM (o clique chega ao GA4 e ao Meta)
for(const page of ['lp-narrador/cenas-lp/lp-v8.html','agencia/index.html','health/index.html','sobre/index.html','contato/index.html','termos/index.html','privacidade/index.html']){
 const html=readFileSync(page,'utf8');
 assert(html.includes('class="ft-whatsapp"'),page+' sem rodapé');
 assert(/\/shared\/telemetria\.js\?v=3/.test(html),page+' sem telemetria');
 assert(/marketing\.js|googletagmanager\.com\/gtm\.js\?id=/.test(html),page+' sem GTM');
}
console.log('ok  as 8 páginas do rodapé carregam telemetria e GTM');
console.log('PASS: whatsapp_click -> dataLayer (GA4) + fbq Contact (Meta), cada clique, sem bloquear navegação');

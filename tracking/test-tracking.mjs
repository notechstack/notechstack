import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const code=readFileSync('shared/marketing.js','utf8');
let scripts=[], pushes=[];
const context={location:{hostname:'www.notechstack.com.br'},Date,window:{dataLayer:{push:e=>pushes.push(e)}},document:{querySelector:()=>scripts[0],createElement:()=>({}),head:{appendChild:s=>scripts.push(s)}}};
vm.runInNewContext(readFileSync('shared/marketing-host.js','utf8'),context);
vm.runInNewContext(code,context);vm.runInNewContext(code,context);
assert.equal(scripts.length,1);assert.equal(pushes.length,1);assert.equal(pushes[0].event,'gtm.js');
for(const file of ['lp-narrador/cenas-lp/lp-v8.html','agencia/index.html','contato/index.html']){
 const html=readFileSync(file,'utf8');
 assert.equal((html.match(/src="\/shared\/marketing.js/g)||[]).length,1);
 assert.equal((html.match(/src="\/shared\/telemetria.js/g)||[]).length,1);
 assert(html.indexOf('/shared/telemetria.js')<html.indexOf('/shared/marketing.js'));
 assert(html.indexOf('/shared/marketing.js')<html.indexOf('</head>'));
 assert(!html.includes('marketing-lazy.js'));assert(!html.includes('window.track ='));
}
assert(!readFileSync('lp-narrador/cenas-lp/historia/home-lazy.js','utf8').includes('googletagmanager'));
console.log('PASS: loader idempotent, synchronous head tracking, no duplicate telemetry/loaders');

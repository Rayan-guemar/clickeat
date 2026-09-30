// Isolated, repeatable HTTP benchmark. Never opens the service's database.
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {api} from '../server/api.mjs';
import {Repository,SCHEMA} from '../server/repository.mjs';
const dir=await mkdtemp(join(tmpdir(),'click-eat-perf-')),sql=new DatabaseSync(join(dir,'test.sqlite'));
sql.exec('PRAGMA journal_mode=WAL;'+SCHEMA);
const db={prepare(q){const statement=(v=[])=>({bind(...x){return statement(x)},first:async()=>sql.prepare(q).get(...v)||null,all:async()=>({results:sql.prepare(q).all(...v)}),run:async()=>sql.prepare(q).run(...v)});return statement()}};
const repo=new Repository(db);await repo.init();const {state}=await repo.read();
state.orders=Array.from({length:4000},(_,i)=>({id:10000+i,name:'Fixture '+i,session:'fixture-'+i,items:{marg:1},slot:state.slots[0]-3600000,status:['QUEUED','PREPARING','BAKING','READY'][i%4],createdAt:Date.now(),bakedAt:Date.now()}));
await db.prepare('UPDATE service_state SET data=?,revision=revision+1 WHERE id=1').bind(JSON.stringify(state)).run();
const handle=api(db,{trustPlatform:true,ownerEmail:'benchmark@example.test'});
const server=createServer(async(req,res)=>{try{let body='';for await(const c of req)body+=c;const response=await handle(new Request('http://'+req.headers.host+req.url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body}:{})}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch(e){res.writeHead(500);res.end(e.message);}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const samples=[];
async function run(name,n,concurrency,path,body,owner=false){let cursor=0;const values=[];let errors=0;const errorTypes={};const start=performance.now();await Promise.all(Array.from({length:concurrency},async()=>{while(cursor<n){const i=cursor++,t=performance.now();try{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'oai-authenticated-user-id':owner?'owner':'visitor-'+i,...(owner?{'oai-authenticated-user-email':'benchmark@example.test'}:{}),Origin:base,'Content-Type':'application/json','X-Click-Eat':'1'},...(body?{body:JSON.stringify(body)}:{})});await r.arrayBuffer();if(!r.ok){errors++;errorTypes['HTTP '+r.status]=(errorTypes['HTTP '+r.status]||0)+1;}}catch(e){errors++;const key=e.cause?.code||e.message;errorTypes[key]=(errorTypes[key]||0)+1;}values.push(performance.now()-t);}}));values.sort((a,b)=>a-b);const pct=p=>Math.round(values[Math.min(values.length-1,Math.ceil(values.length*p)-1)]*100)/100;samples.push({name,requests:n,concurrency,p50_ms:pct(.5),p95_ms:pct(.95),p99_ms:pct(.99),max_ms:pct(1),errors,errorTypes,duration_ms:Math.round(performance.now()-start),target_ms:200,all_under_target:errors===0&&pct(1)<200});console.log(samples.at(-1));}
try{
 await run('Panier cumulé, séquentiel, 4000 commandes',100,1,'/api/check',{payload:{items:{marg:1,regina:1},slot:state.slots[0]}});
 await run('Panier cumulé, 1000 clients simultanés, 4000 commandes',1000,1000,'/api/check',{payload:{items:{marg:1,regina:1},slot:state.slots[0]}});
 await run('Pilotage, lecture de 4000 commandes',20,1,'/api/pilotage/state',null,true);
 const report={measuredAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch,database:'SQLite WAL temporaire',transport:'HTTP boucle locale, générateur et serveur dans le même processus'},orders:4000,samples,limitations:['Ce test local ne valide pas les latences réseau ou Cloudflare D1 en production.','1000 requêtes simultanées ne simulent pas 1000 navigateurs avec polling et paiements.','Le temps HTTP du pilotage ne mesure pas le rendu DOM du navigateur.']};
 await writeFile('docs/performance-results.json',JSON.stringify(report,null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));sql.close();await rm(dir,{recursive:true,force:true});}

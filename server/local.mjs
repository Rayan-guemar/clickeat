import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {api} from './api.mjs';
import {SCHEMA} from './repository.mjs';
const dir=resolve(process.env.DATA_DIR||'data');await mkdir(dir,{recursive:true});
const sql=new DatabaseSync(resolve(dir,'click-eat.sqlite'));sql.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
const db={exec:async s=>sql.exec(s),prepare(s){const statement=(values=[])=>({bind(...v){return statement(v)},first:async()=>sql.prepare(s).get(...values)||null,run:async()=>sql.prepare(s).run(...values)});return statement()}};
await db.exec(SCHEMA);
const handle=api(db),root=resolve('dist');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg'};
const server=createServer(async(req,res)=>{try{
 const origin=`http://${req.headers.host}`;const url=new URL(req.url,origin);
 if(url.pathname.startsWith('/api/')){
  let body='';for await(const chunk of req){body+=chunk;if(body.length>16384){res.writeHead(413);res.end();return}}
  const request=new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body}:{})});const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
 }
 const relative=decodeURIComponent(url.pathname)==='/'?'index.html':decodeURIComponent(url.pathname).slice(1),path=resolve(root,relative);
 if(!path.startsWith(root+'/')){res.writeHead(403);res.end();return}const body=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});res.end(body);
 }catch{res.writeHead(404);res.end('Not found')}});
server.listen(Number(process.env.PORT||4173),process.env.HOST||'127.0.0.1',()=>console.log(`Click Eat server: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||4173}`));

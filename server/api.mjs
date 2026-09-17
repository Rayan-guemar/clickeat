import {Repository} from './repository.mjs';
import {AppError} from './domain.mjs';
export function api(db){const repo=new Repository(db);let ready;
 return async request=>{
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  const url=new URL(request.url);let session=request.headers.get('cookie')?.match(/(?:^|; )ce_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
  if(!session){session=crypto.randomUUID();headers['Set-Cookie']=`ce_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${url.protocol==='https:'?'; Secure':''}`;}
  try{
   if(!ready)ready=repo.init().catch(e=>{ready=null;throw e});await ready;
   if(request.method==='GET'&&url.pathname==='/api/state')return Response.json(await repo.get(session),{headers});
   if(request.method==='GET'&&url.pathname==='/api/health')return Response.json({ok:true,database:'connected'},{headers});
   if(request.method!=='POST'||url.pathname!=='/api/action')throw new AppError('Route introuvable.',404);
   if(request.headers.get('Origin')!==url.origin||request.headers.get('X-Click-Eat')!=='1')throw new AppError('Origine non autorisée.',403);
   if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError('JSON requis.',415);
   const raw=await request.text();if(raw.length>16384)throw new AppError('Requête trop volumineuse.',413);
   let body;try{body=JSON.parse(raw)}catch{throw new AppError('JSON invalide.',400)}
   if(!body||typeof body!=='object')throw new AppError('Requête invalide.',400);
   return Response.json(await repo.mutate(session,body.requestId,body.action,body.payload),{headers});
  }catch(e){if(!(e instanceof AppError))console.error('API failure',e.message);return Response.json({error:e instanceof AppError?e.message:'Erreur serveur. Veuillez réessayer.'},{status:e.status||500,headers});}
 }
}

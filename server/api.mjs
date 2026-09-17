import {Repository} from './repository.mjs';
import {AppError} from './domain.mjs';
export async function identity(request,options={}){
 const id=options.trustPlatform?request.headers.get('oai-authenticated-user-id'):null;
 const email=options.trustPlatform?request.headers.get('oai-authenticated-user-email')?.toLowerCase():null;
 const manager=Boolean(id&&email&&options.ownerEmail&&email===options.ownerEmail.toLowerCase());
 return {id,email,manager};
}
export function api(db,options={}){const repo=new Repository(db);let ready;
 return async request=>{
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Cookie'};
  const url=new URL(request.url);let session=request.headers.get('cookie')?.match(/(?:^|; )ce_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
  if(!session){session=crypto.randomUUID();headers['Set-Cookie']=`ce_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${url.protocol==='https:'?'; Secure':''}`;}
  try{
   if(!ready)ready=repo.init().catch(e=>{ready=null;throw e});await ready;
   if(request.method==='GET'&&url.pathname==='/api/health')return Response.json({ok:true,database:'connected'},{headers});
   const auth=await identity(request,options);
   const authText=auth.id?'platform:'+auth.id:'anonymous:'+session;
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(authText));
   const authKey=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
   const visitor=await repo.user(authKey,session),isManager=url.pathname.startsWith('/api/pilotage/');
   if(isManager&&!auth.manager)throw new AppError(auth.id?'Cet espace est réservé à la pizzeria.':'Connectez-vous avec le compte propriétaire de la pizzeria.',403);
   const role=isManager?'manager':'client';
   if(request.method==='GET'&&['/api/state','/api/pilotage/state'].includes(url.pathname))return Response.json(await repo.get(visitor.id,role),{headers});
   if(request.method!=='POST'||!['/api/action','/api/pilotage/action'].includes(url.pathname))throw new AppError('Route introuvable.',404);
   if(request.headers.get('Origin')!==url.origin||request.headers.get('X-Click-Eat')!=='1')throw new AppError('Origine non autorisée.',403);
   if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError('JSON requis.',415);
   const raw=await request.text();if(raw.length>16384)throw new AppError('Requête trop volumineuse.',413);
   let body;try{body=JSON.parse(raw)}catch{throw new AppError('JSON invalide.',400)}
   if(!body||typeof body!=='object'||!body.payload||typeof body.payload!=='object'||Array.isArray(body.payload))throw new AppError('Requête invalide.',400);
   const allowed=role==='manager'?['advance','delay','cancel','stock','capacity','pause']:['reserve','release','pay'];
   if(!allowed.includes(body.action))throw new AppError('Action non autorisée pour cet espace.',403);
   const result=await repo.mutate(visitor.id,body.requestId,body.action,body.payload,role);
   return Response.json(result,{status:result.pending?202:200,headers});
  }catch(e){if(!(e instanceof AppError))console.error('API failure',e.message);return Response.json({error:e instanceof AppError?e.message:'Erreur serveur. Veuillez réessayer.'},{status:e.status||500,headers});}
 }
}

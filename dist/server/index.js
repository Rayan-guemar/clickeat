const recipes=[{id:'marg',name:'Margherita',desc:'Tomate San Marzano, mozzarella fior di latte, basilic frais.',price:11,bom:{dough:1,tomato:100,mozza:100,box:1},tag:'La grande classique'},{id:'regina',name:'Regina',desc:'Tomate, mozzarella, jambon blanc, champignons frais.',price:14,bom:{dough:1,tomato:100,mozza:100,ham:80,mushroom:60,box:1},tag:'La préférée du quartier'},{id:'burrata',name:'Burrata',desc:'Tomate, burrata crémeuse, roquette et huile d’olive.',price:16,bom:{dough:1,tomato:100,burrata:1,box:1},tag:'La généreuse'},{id:'quattro',name:'Quattro formaggi',desc:'Mozzarella, gorgonzola, chèvre et parmesan.',price:15,bom:{dough:1,mozza:100,cheese:100,box:1},tag:'Pour les amateurs de fromage'}];
function initial(){const now=Date.now(),base=Math.ceil((now+12*60000)/600000)*600000;return{slots:Array.from({length:8},(_,i)=>base+i*600000),capacity:50,pausedUntil:0,stock:{dough:{name:'Pâtons',qty:420,unit:'pièces',alert:50},tomato:{name:'Sauce tomate',qty:19000,unit:'g',alert:2000},mozza:{name:'Mozzarella',qty:14000,unit:'g',alert:2000},ham:{name:'Jambon blanc',qty:6000,unit:'g',alert:1000},mushroom:{name:'Champignons',qty:2800,unit:'g',alert:3000},burrata:{name:'Burrata',qty:8,unit:'pièces',alert:12},cheese:{name:'Mélange fromages',qty:6500,unit:'g',alert:1000},box:{name:'Boîtes à pizza',qty:480,unit:'pièces',alert:100}},orders:[{id:1042,name:'Camille D.',items:{regina:2,marg:1},slot:base,status:'PREPARING'},{id:1043,name:'Thomas L.',items:{burrata:2},slot:base,status:'BAKING',bakedAt:now-180000},{id:1044,name:'Sarah M.',items:{quattro:1,marg:1},slot:base,status:'READY'},{id:1045,name:'Lucas B.',items:{regina:3},slot:base,status:'QUEUED'},{id:1046,name:'Emma R.',items:{marg:2,burrata:1},slot:base+600000,status:'QUEUED'},{id:1047,name:'Hugo P.',items:{quattro:2},slot:base+600000,status:'QUEUED'}],hold:null,notifications:[],next:1048}}
class AppError extends Error { constructor(message,status=409){super(message);this.status=status;} }
const count=items=>Object.values(items).reduce((a,b)=>a+b,0);
function required(items){const out={};for(const recipe of recipes)for(const [id,n] of Object.entries(recipe.bom))out[id]=(out[id]||0)+n*(items[recipe.id]||0);return out;}
function fresh(){const s=initial();s.orders=[];s.notifications=[];s.next=1001;delete s.hold;s.holds={};s.receipts={};return s;}
function clean(s,now){for(const [id,h] of Object.entries(s.holds))if(h.expires<=now)delete s.holds[id];for(const [id,r] of Object.entries(s.receipts))if(r.at<now-7*86400000)delete s.receipts[id];const base=Math.ceil((now+12*60000)/600000)*600000;s.slots=Array.from({length:8},(_,i)=>base+i*600000);}
function snapshot(s,visitorId,revision,now=Date.now(),role='client'){
 clean(s,now);
 const other=Object.entries(s.holds).filter(([id])=>id!==visitorId).map(([,h])=>h),reservedOther={};
 for(const h of other)for(const [id,n] of Object.entries(required(h.items)))reservedOther[id]=(reservedOther[id]||0)+n;
 const ownOrders=s.orders.filter(o=>o.session===visitorId);
 const orders=(role==='manager'?s.orders:ownOrders).map(o=>({...o,client:o.session===visitorId,clientId:o.clientId||null,session:undefined}));
 const availability=Object.fromEntries(recipes.map(r=>[r.id,Math.max(0,Math.min(...Object.entries(r.bom).map(([id,n])=>Math.floor((s.stock[id].qty-(reservedOther[id]||0)-(required(s.holds[visitorId]?.items||{})[id]||0))/n))))]));
 return {revision,serverTime:now,role,clientId:visitorId,capacity:s.capacity,pausedUntil:s.pausedUntil,
 ...(role==='manager'?{stock:s.stock,reservedOther,notifications:s.notifications}:{}),orders,availability,
 hold:s.holds[visitorId]||null,slots:s.slots,slotLoads:Object.fromEntries(s.slots.map(t=>[t,used(s,t)])),
 slotHolds:Object.fromEntries(s.slots.map(t=>[t,other.filter(h=>h.slot===t).reduce((n,h)=>n+count(h.items),0)]))};
}
function integer(n,min,max,label){if(!Number.isSafeInteger(n)||n<min||n>max)throw new AppError(label,400);return n;}
function validateItems(items){if(!items||typeof items!=='object'||Array.isArray(items)||Object.keys(items).length===0)throw new AppError('Le panier est vide.',400);for(const [id,n] of Object.entries(items)){if(!recipes.some(r=>r.id===id))throw new AppError('Recette inconnue.',400);integer(n,1,50,'Quantité invalide.');}if(count(items)>50)throw new AppError('Maximum 50 pizzas par commande.',400);return items;}
function available(s,items,skipSession){const need=required(items);for(const [session,h] of Object.entries(s.holds))if(session!==skipSession)for(const [id,n] of Object.entries(required(h.items)))need[id]=(need[id]||0)+n;return Object.entries(need).every(([id,n])=>s.stock[id].qty>=n);}
function used(s,slot){return s.orders.filter(o=>o.slot===slot&&o.status!=='CANCELLED').reduce((n,o)=>n+count(o.items),0)+Object.values(s.holds).filter(h=>h.slot===slot).reduce((n,h)=>n+count(h.items),0);}
function apply(s,action,payload,session,now=Date.now()){
 clean(s,now);const p=payload||{};let result={};const notice=text=>s.notifications.push({at:now,text});
 switch(action){
 case 'reserve': {
  if(s.pausedUntil>now)throw new AppError('La prise de commandes est suspendue.');
  const items=validateItems(p.items);if(s.holds[session])throw new AppError('Vous avez déjà un panier réservé. Reprenez ou annulez le paiement.');
  if(!s.slots.includes(p.slot))throw new AppError('Ce créneau est expiré ou indisponible.');
  if(!available(s,items))throw new AppError('Stock insuffisant. Modifiez votre panier.');
  if(used(s,p.slot)+count(items)>s.capacity)throw new AppError('Ce créneau est complet. Choisissez le suivant.');
  s.holds[session]={id:crypto.randomUUID(),items:{...items},slot:p.slot,expires:now+300000};result={reservationId:s.holds[session].id};break;
 }
 case 'release': {const h=s.holds[session];if(h&&h.id!==p.reservationId)throw new AppError('La réservation a changé.');delete s.holds[session];break;}
 case 'pay': {
  const h=s.holds[session];if(!h||h.id!==p.reservationId)throw new AppError('La réservation a expiré.');
  const name=typeof p.name==='string'?p.name.trim():'';if(!name||name.length>60)throw new AppError('Indiquez un prénom de 1 à 60 caractères.',400);
  if(!available(s,h.items,session))throw new AppError('Un ingrédient est passé en rupture. Annulez la réservation.');
  for(const [id,n] of Object.entries(required(h.items)))s.stock[id].qty-=n;
  const id=s.next++;s.orders.push({id,name,items:h.items,slot:h.slot,status:'QUEUED',session,clientId:session,sequence:h.sequence||null,receivedAt:h.receivedAt||now,createdAt:now});delete s.holds[session];result={orderId:id};break;
 }
 case 'advance': {
  const o=s.orders.find(o=>o.id===p.id);if(!o)throw new AppError('Commande introuvable.',404);
  if(o.status!==p.expectedStatus)throw new AppError('Cette commande a déjà été modifiée.');
  const next={QUEUED:'PREPARING',PREPARING:'BAKING',BAKING:'READY',READY:'COLLECTED'}[o.status];if(!next)throw new AppError('Cette commande ne peut plus avancer.');
  if(o.status==='QUEUED'&&o.slot+(o.delay||0)-720000>now)throw new AppError('Il est trop tôt pour commencer cette commande.');
  o.status=next;if(next==='BAKING')o.bakedAt=now;if(next==='READY')notice(`Commande #${o.id} : votre commande est prête au comptoir !`);result={status:next};break;
 }
 case 'delay': {const o=s.orders.find(o=>o.id===p.id);if(!o)throw new AppError('Commande introuvable.',404);if(['CANCELLED','COLLECTED'].includes(o.status))throw new AppError('La commande est terminée.');o.delay=(o.delay||0)+300000;notice(`Commande #${o.id} : retrait décalé de 5 minutes.`);break;}
 case 'cancel': {const o=s.orders.find(o=>o.id===p.id);if(!o)throw new AppError('Commande introuvable.',404);if(['CANCELLED','COLLECTED'].includes(o.status))throw new AppError('La commande est déjà terminée.');if(o.status==='QUEUED')for(const [id,n] of Object.entries(required(o.items)))s.stock[id].qty+=n;o.status='CANCELLED';notice(`Commande #${o.id} annulée. Remboursement simulé.`);break;}
 case 'stock': {if(!s.stock[p.id])throw new AppError('Ingrédient inconnu.',400);s.stock[p.id].qty=integer(p.qty,0,10000000,'Quantité de stock invalide.');break;}
 case 'capacity': s.capacity=integer(p.capacity,1,200,'Capacité entre 1 et 200 pizzas.');break;
 case 'pause': if(![0,15,30,60].includes(p.minutes))throw new AppError('Durée de pause invalide.',400);s.pausedUntil=p.minutes?now+p.minutes*60000:0;break;
 default: throw new AppError('Action inconnue.',400);
 }
 return result;
}

const SCHEMA=`CREATE TABLE IF NOT EXISTS service_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY NOT NULL, auth_key TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reservation_queue (sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, request_key TEXT UNIQUE NOT NULL, visitor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reservation_queue_visitor_sequence ON reservation_queue(visitor_id,sequence);`;
class Repository {
 constructor(db){this.db=db;}
 async init(){await this.db.prepare('INSERT OR IGNORE INTO service_state(id,revision,data) VALUES(1,0,?)').bind(JSON.stringify(fresh())).run();}
 async user(authKey,legacySession){
  const inserted=await this.db.prepare('INSERT OR IGNORE INTO visitors(id,auth_key,created_at) VALUES(?,?,?) RETURNING id').bind(crypto.randomUUID(),authKey,Date.now()).first();
  const visitor=await this.db.prepare('SELECT id,created_at FROM visitors WHERE auth_key=?').bind(authKey).first();
  if(inserted&&legacySession){for(let attempt=0;attempt<12;attempt++){const {state,revision}=await this.read();const old=state.orders.filter(o=>o.session===legacySession);if(!old.length&&!state.holds[legacySession])break;for(const o of old){o.session=visitor.id;o.clientId=visitor.id;}if(state.holds[legacySession]){state.holds[visitor.id]=state.holds[legacySession];delete state.holds[legacySession];}const saved=await this.db.prepare('UPDATE service_state SET data=?, revision=revision+1 WHERE id=1 AND revision=? RETURNING revision').bind(JSON.stringify(state),revision).first();if(saved)break;}}
  return visitor;
 }
 async read(){const row=await this.db.prepare('SELECT revision,data FROM service_state WHERE id=1').first();if(!row)throw new Error('Database not initialized');return{revision:row.revision,state:JSON.parse(row.data)};}
 async view(state,visitorId,revision,role='client'){
  const value=snapshot(state,visitorId,revision,Date.now(),role);
  const rows=role==='manager'
   ? await this.db.prepare('SELECT sequence,visitor_id,request_id,request_key,received_at FROM reservation_queue ORDER BY sequence DESC LIMIT 30').all()
   : await this.db.prepare('SELECT sequence,visitor_id,request_id,request_key,received_at FROM reservation_queue WHERE visitor_id=? ORDER BY sequence DESC LIMIT 1').bind(visitorId).all();
  value.reservationQueue=(rows.results||rows).map(row=>{const receipt=state.receipts[row.request_key];return {sequence:row.sequence,clientId:row.visitor_id,requestId:row.request_id,receivedAt:row.received_at,status:receipt?(receipt.error?'REFUSED':'ACCEPTED'):row.sequence>(state.lastTicket||0)?'PENDING':'ARCHIVED',reason:receipt?.error?.message||null};});
  return value;
 }
 async get(visitorId,role='client'){const {state,revision}=await this.read();return this.view(state,visitorId,revision,role);}
 validateId(requestId){if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))throw new AppError('Identifiant de requête invalide.',400);}
 async reserve(visitorId,requestId,payload,role){
  const key=visitorId+':'+requestId,encoded=JSON.stringify(payload);
  const before=await this.read();if(before.state.receipts[key]&&before.state.receipts[key].fingerprint!==JSON.stringify({action:'reserve',payload}))throw new AppError('Identifiant déjà utilisé pour une autre action.');
  await this.db.prepare('INSERT OR IGNORE INTO reservation_queue(request_key,visitor_id,request_id,payload,received_at) VALUES(?,?,?,?,?)').bind(key,visitorId,requestId,encoded,Date.now()).run();
  const ticket=await this.db.prepare('SELECT sequence,payload FROM reservation_queue WHERE request_key=?').bind(key).first();
  if(ticket.payload!==encoded)throw new AppError('Identifiant déjà utilisé pour une autre réservation.');
  // Each competing worker helps process the same oldest ticket. The compare-and-swap
  // commits the decision AND advances the queue cursor in one atomic statement.
  for(let attempt=0;attempt<64;attempt++){
   const {state,revision}=await this.read();
   if(state.receipts[key])return this.reply(state,revision,visitorId,key,role);
   if((state.lastTicket||0)>=ticket.sequence)throw new AppError('Cette ancienne demande ne peut pas être rejouée.',410);
   const head=await this.db.prepare('SELECT * FROM reservation_queue WHERE sequence>? ORDER BY sequence LIMIT 1').bind(state.lastTicket||0).first();
   if(!head)continue;
   let result,error;
   try{result=apply(state,'reserve',JSON.parse(head.payload),head.visitor_id);const h=state.holds[head.visitor_id];h.sequence=head.sequence;h.clientId=head.visitor_id;h.receivedAt=head.received_at;result.sequence=head.sequence;result.clientId=head.visitor_id;}
   catch(e){if(!(e instanceof AppError))throw e;error={message:e.message,status:e.status};}
   state.lastTicket=head.sequence;
   state.receipts[head.request_key]={at:Date.now(),fingerprint:JSON.stringify({action:'reserve',payload:JSON.parse(head.payload)}),result,error};
   await this.db.prepare('UPDATE service_state SET data=?, revision=revision+1 WHERE id=1 AND revision=?').bind(JSON.stringify(state),revision).run();
  }
  return {pending:true,sequence:ticket.sequence};
 }
 async reply(state,revision,visitorId,key,role){const receipt=state.receipts[key];if(receipt.error)throw new AppError(receipt.error.message,receipt.error.status);return {result:receipt.result,state:await this.view(state,visitorId,revision,role)};}
 async mutate(visitorId,requestId,action,payload,role='client'){
  this.validateId(requestId);
  if(action==='reserve')return this.reserve(visitorId,requestId,payload,role);
  const key=visitorId+':'+requestId, fingerprint=JSON.stringify({action,payload});
  if(await this.db.prepare('SELECT sequence FROM reservation_queue WHERE request_key=?').bind(key).first())throw new AppError('Identifiant déjà utilisé pour une réservation.');
  for(let attempt=0;attempt<24;attempt++){
   const {state,revision}=await this.read();
   if(state.receipts[key]){if(state.receipts[key].fingerprint!==fingerprint)throw new AppError('Identifiant déjà utilisé pour une autre action.');return this.reply(state,revision,visitorId,key,role);}
   const result=apply(state,action,payload,visitorId);state.receipts[key]={at:Date.now(),fingerprint,result};
   const saved=await this.db.prepare('UPDATE service_state SET data=?, revision=revision+1 WHERE id=1 AND revision=? RETURNING revision').bind(JSON.stringify(state),revision).first();
   if(saved)return {result,state:await this.view(state,visitorId,saved.revision,role)};
  }
  throw new AppError('Le service est occupé. Réessayez dans un instant.',503);
 }
}

export async function identity(request,options={}){
 const id=options.trustPlatform?request.headers.get('oai-authenticated-user-id'):null;
 const email=options.trustPlatform?request.headers.get('oai-authenticated-user-email')?.toLowerCase():null;
 const manager=Boolean(id&&email&&options.ownerEmail&&email===options.ownerEmail.toLowerCase());
 return {id,email,manager};
}
function api(db,options={}){const repo=new Repository(db);let ready;
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

let handler;let boundDB;
export default {async fetch(request,env){if(new URL(request.url).pathname.startsWith('/api/')){if(!env.DB)return Response.json({error:'Database binding missing'},{status:503});if(boundDB!==env.DB){boundDB=env.DB;handler=api(env.DB,{trustPlatform:true,ownerEmail:env.PILOTAGE_OWNER_EMAIL});}return handler(request);}const url=new URL(request.url);if(['/','/client','/client/','/pilotage','/pilotage/'].includes(url.pathname)){url.pathname='/';return env.ASSETS.fetch(new Request(url,request));}return env.ASSETS.fetch(request);}};

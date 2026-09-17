import {fresh,apply,snapshot,AppError} from './domain.mjs';
export const SCHEMA=`CREATE TABLE IF NOT EXISTS service_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY NOT NULL, auth_key TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reservation_queue (sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, request_key TEXT UNIQUE NOT NULL, visitor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reservation_queue_visitor_sequence ON reservation_queue(visitor_id,sequence);`;
export class Repository {
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

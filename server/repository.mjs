import {fresh,apply,snapshot,AppError} from './domain.mjs';
export const SCHEMA=`CREATE TABLE IF NOT EXISTS service_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL CHECK(json_valid(data)));`;
export class Repository{
 constructor(db){this.db=db;}
 async init(){await this.db.exec(SCHEMA);await this.db.prepare('INSERT OR IGNORE INTO service_state(id,revision,data) VALUES(1,0,?)').bind(JSON.stringify(fresh())).run();}
 async read(){const row=await this.db.prepare('SELECT revision,data FROM service_state WHERE id=1').first();if(!row)throw new Error('Database not initialized');return{revision:row.revision,state:JSON.parse(row.data)};}
 async get(session){const {state,revision}=await this.read();return snapshot(state,session,revision);}
 async mutate(session,requestId,action,payload){
  if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))throw new AppError('Identifiant de requête invalide.',400);
  const key=session+':'+requestId, fingerprint=JSON.stringify({action,payload});
  for(let attempt=0;attempt<12;attempt++){
   const {state,revision}=await this.read();
   if(state.receipts[key]){if(state.receipts[key].fingerprint!==fingerprint)throw new AppError('Identifiant déjà utilisé pour une autre action.');return {result:state.receipts[key].result,state:snapshot(state,session,revision)};}
   const result=apply(state,action,payload,session);state.receipts[key]={at:Date.now(),fingerprint,result};
   const saved=await this.db.prepare('UPDATE service_state SET data=?, revision=revision+1 WHERE id=1 AND revision=? RETURNING revision').bind(JSON.stringify(state),revision).first();
   if(saved)return {result,state:snapshot(state,session,saved.revision)};
  }
  throw new AppError('Le service est occupé. Réessayez dans un instant.',503);
 }
}

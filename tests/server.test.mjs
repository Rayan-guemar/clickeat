import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {Repository,SCHEMA} from '../server/repository.mjs';import {api} from '../server/api.mjs';
function database(){const sql=new DatabaseSync(':memory:');sql.exec(SCHEMA);return {exec:async s=>sql.exec(s),prepare(s){const stmt=(v=[])=>({bind(...x){return stmt(x)},first:async()=>sql.prepare(s).get(...v)||null,all:async()=>({results:sql.prepare(s).all(...v)}),run:async()=>sql.prepare(s).run(...v)});return stmt()}}}
const id=()=>crypto.randomUUID();
test('concurrent reservations never exceed stock or capacity; pay is idempotent',async()=>{const db=database(),repo=new Repository(db);await repo.init();await repo.mutate('manager',id(),'capacity',{capacity:1});const state=await repo.get('one');const results=await Promise.allSettled(['one','two'].map(session=>repo.mutate(session,id(),'reserve',{items:{marg:1},slot:state.slots[0]})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const winner=results[0].status==='fulfilled'?'one':'two';const reserved=await repo.get(winner);const requestId=id(),payload={reservationId:reserved.hold.id,name:'Client'};await Promise.all([repo.mutate(winner,requestId,'pay',payload),repo.mutate(winner,requestId,'pay',payload)]);const paid=await repo.get(winner);assert.equal(paid.orders.length,1);assert.equal((await repo.get('manager','manager')).stock.dough.qty,419);assert.equal(paid.hold,null);assert.equal((await repo.get(winner==='one'?'two':'one')).orders.length,0);await assert.rejects(repo.mutate(winner,requestId,'pay',{...payload,name:'Autre'}));});
test('expiry releases ingredients; sessions cannot pay other holds; mutations validated',async()=>{const db=database(),repo=new Repository(db);await repo.init();await repo.mutate('manager',id(),'stock',{id:'burrata',qty:1});const s=await repo.get('one');await repo.mutate('one',id(),'reserve',{items:{burrata:1},slot:s.slots[0]});await assert.rejects(repo.mutate('two',id(),'reserve',{items:{burrata:1},slot:s.slots[1]}));const held=await repo.get('one');assert.equal((await repo.get('two')).hold,null);await assert.rejects(repo.mutate('two',id(),'pay',{reservationId:held.hold.id,name:'Other'}));const row=await repo.read();row.state.holds.one.expires=Date.now()-1;await db.prepare('UPDATE service_state SET data=? WHERE id=1').bind(JSON.stringify(row.state)).run();await repo.mutate('two',id(),'reserve',{items:{burrata:1},slot:s.slots[0]});await assert.rejects(repo.mutate('manager',id(),'stock',{id:'dough',qty:-1}));await assert.rejects(repo.mutate('manager',id(),'capacity',{capacity:0}));await repo.mutate('manager',id(),'pause',{minutes:15});await assert.rejects(repo.mutate('three',id(),'reserve',{items:{marg:1},slot:s.slots[0]}));});
test('manual lifecycle uses expected status and replays safely',async()=>{const db=database(),repo=new Repository(db);await repo.init();let state=await repo.get('one');await repo.mutate('one',id(),'reserve',{items:{regina:1},slot:state.slots[0]});state=await repo.get('one');const paid=await repo.mutate('one',id(),'pay',{reservationId:state.hold.id,name:'Client'});const orderId=paid.result.orderId;const row=await repo.read();row.state.orders[0].slot=Date.now()+600000;await db.prepare('UPDATE service_state SET data=? WHERE id=1').bind(JSON.stringify(row.state)).run();const key=id();await repo.mutate('kitchen',key,'advance',{id:orderId,expectedStatus:'QUEUED'});await repo.mutate('kitchen',key,'advance',{id:orderId,expectedStatus:'QUEUED'});await assert.rejects(repo.mutate('kitchen',id(),'advance',{id:orderId,expectedStatus:'QUEUED'}));await repo.mutate('kitchen',id(),'advance',{id:orderId,expectedStatus:'PREPARING'});await repo.mutate('kitchen',id(),'advance',{id:orderId,expectedStatus:'BAKING'});assert.equal((await repo.get('kitchen','manager')).notifications.length,1);await repo.mutate('kitchen',id(),'advance',{id:orderId,expectedStatus:'READY'});assert.equal((await repo.get('one')).orders[0].status,'COLLECTED');});
test('API session, JSON and origin protections',async()=>{const handle=api(database());const initial=await handle(new Request('http://localhost/api/state'));assert.equal(initial.status,200);assert.match(initial.headers.get('set-cookie'),/HttpOnly/);const bad=await handle(new Request('http://localhost/api/action',{method:'POST',body:'{}',headers:{'Content-Type':'application/json','Origin':'https://other.example','X-Click-Eat':'1'}}));assert.equal(bad.status,403);const invalid=await handle(new Request('http://localhost/api/action',{method:'POST',body:'{',headers:{'Content-Type':'application/json','Origin':'http://localhost','X-Click-Eat':'1'}}));assert.equal(invalid.status,400);});
test('data survives repository recreation',async()=>{const db=database(),one=new Repository(db);await one.init();await one.mutate('m',id(),'stock',{id:'dough',qty:123});const two=new Repository(db);await two.init();assert.equal((await two.get('other','manager')).stock.dough.qty,123);});

test('FIFO: a later worker processes an earlier registered request first',async()=>{
 const db=database(),repo=new Repository(db);await repo.init();await repo.mutate('manager',id(),'stock',{id:'burrata',qty:1});
 const slot=(await repo.get('first')).slots[0],firstRequest=id(),payload={items:{burrata:1},slot};
 await db.prepare('INSERT INTO reservation_queue(request_key,visitor_id,request_id,payload,received_at) VALUES(?,?,?,?,?)').bind('first:'+firstRequest,'first',firstRequest,JSON.stringify(payload),Date.now()).run();
 await assert.rejects(repo.mutate('second',id(),'reserve',payload),/Stock insuffisant/);
 const first=await repo.mutate('first',firstRequest,'reserve',payload);
 assert.equal(first.result.sequence,1);assert.equal(first.state.hold.clientId,'first');
 const audit=(await repo.get('manager','manager')).reservationQueue;
 assert.equal(audit.find(t=>t.sequence===1).status,'ACCEPTED');assert.equal(audit.find(t=>t.sequence===2).status,'REFUSED');
});
test('30 concurrent clients, only the earliest 3 tickets get limited stock',async()=>{
 const repo=new Repository(database());await repo.init();await repo.mutate('manager',id(),'stock',{id:'burrata',qty:3});const slot=(await repo.get('x')).slots[0];
 const results=await Promise.allSettled(Array.from({length:30},(_,i)=>repo.mutate('client-'+i,id(),'reserve',{items:{burrata:1},slot})));
 const accepted=results.filter(r=>r.status==='fulfilled'&&!r.value.pending).map(r=>r.value.result.sequence).sort((a,b)=>a-b);
 assert.deepEqual(accepted,[1,2,3]);assert.equal(results.filter(r=>r.status==='rejected').length,27);
 const {state}=await repo.read();assert.equal(Object.keys(state.holds).length,3);assert.equal(state.stock.burrata.qty,3);
});
test('client and pilotage API authorization, stable user IDs, no cross-client data',async()=>{
 const db=database(),handler=api(db,{trustPlatform:true,ownerEmail:'owner@example.test'});
 const request=async(path,identity={},action,payload)=>{
  const headers={...identity};const opts={headers};
  if(action){Object.assign(headers,{'Content-Type':'application/json','Origin':'http://localhost','X-Click-Eat':'1'});Object.assign(opts,{method:'POST',body:JSON.stringify({requestId:id(),action,payload})});}
  const response=await handler(new Request('http://localhost'+path,opts));return {response,data:await response.json()};
 };
 const alice={'oai-authenticated-user-id':'alice','oai-authenticated-user-email':'alice@example.test'};
 const bob={'oai-authenticated-user-id':'bob','oai-authenticated-user-email':'bob@example.test'};
 const owner={'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'};
 const a=await request('/api/state',alice),b=await request('/api/state',bob);
 assert.notEqual(a.data.clientId,b.data.clientId);assert.equal((await request('/api/state',alice)).data.clientId,a.data.clientId);
 assert.equal(a.data.stock,undefined);assert.equal(a.data.notifications,undefined);
 assert.equal((await request('/api/pilotage/state',alice)).response.status,403);
 assert.equal((await request('/api/pilotage/state',owner)).response.status,200);
 assert.equal((await request('/api/action',alice,'stock',{id:'dough',qty:0})).response.status,403);
 assert.equal((await request('/api/pilotage/action',bob,'pause',{minutes:60})).response.status,403);
 const hold=await request('/api/action',alice,'reserve',{items:{marg:1},slot:a.data.slots[0]});
 assert.equal((await request('/api/action',bob,'pay',{reservationId:hold.data.result.reservationId,name:'Bob'})).response.status,409);
 await request('/api/action',alice,'pay',{reservationId:hold.data.result.reservationId,name:'Alice'});
 assert.equal((await request('/api/state',bob)).data.orders.length,0);
 assert.equal((await request('/api/state',alice)).data.orders[0].clientId,a.data.clientId);
 assert.equal((await request('/api/pilotage/state',owner)).data.orders.length,1);
 const local=api(db);const spoofed=await local(new Request('http://localhost/api/pilotage/state',{headers:owner}));assert.equal(spoofed.status,403);
});
test('anonymous cookie retains identity and another visitor gets a different ID',async()=>{
 const handler=api(database());const first=await handler(new Request('http://localhost/api/state'));
 const cookie=first.headers.get('set-cookie').split(';')[0],one=await first.json();
 const again=await handler(new Request('http://localhost/api/state',{headers:{cookie}}));assert.equal((await again.json()).clientId,one.clientId);
 const different=await handler(new Request('http://localhost/api/state'));assert.notEqual((await different.json()).clientId,one.clientId);
});

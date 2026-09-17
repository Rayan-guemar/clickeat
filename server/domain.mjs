export const recipes=[{id:'marg',name:'Margherita',desc:'Tomate San Marzano, mozzarella fior di latte, basilic frais.',price:11,bom:{dough:1,tomato:100,mozza:100,box:1},tag:'La grande classique'},{id:'regina',name:'Regina',desc:'Tomate, mozzarella, jambon blanc, champignons frais.',price:14,bom:{dough:1,tomato:100,mozza:100,ham:80,mushroom:60,box:1},tag:'La préférée du quartier'},{id:'burrata',name:'Burrata',desc:'Tomate, burrata crémeuse, roquette et huile d’olive.',price:16,bom:{dough:1,tomato:100,burrata:1,box:1},tag:'La généreuse'},{id:'quattro',name:'Quattro formaggi',desc:'Mozzarella, gorgonzola, chèvre et parmesan.',price:15,bom:{dough:1,mozza:100,cheese:100,box:1},tag:'Pour les amateurs de fromage'}];
export function initial(){const now=Date.now(),base=Math.ceil((now+12*60000)/600000)*600000;return{slots:Array.from({length:8},(_,i)=>base+i*600000),capacity:50,pausedUntil:0,stock:{dough:{name:'Pâtons',qty:420,unit:'pièces',alert:50},tomato:{name:'Sauce tomate',qty:19000,unit:'g',alert:2000},mozza:{name:'Mozzarella',qty:14000,unit:'g',alert:2000},ham:{name:'Jambon blanc',qty:6000,unit:'g',alert:1000},mushroom:{name:'Champignons',qty:2800,unit:'g',alert:3000},burrata:{name:'Burrata',qty:8,unit:'pièces',alert:12},cheese:{name:'Mélange fromages',qty:6500,unit:'g',alert:1000},box:{name:'Boîtes à pizza',qty:480,unit:'pièces',alert:100}},orders:[{id:1042,name:'Camille D.',items:{regina:2,marg:1},slot:base,status:'PREPARING'},{id:1043,name:'Thomas L.',items:{burrata:2},slot:base,status:'BAKING',bakedAt:now-180000},{id:1044,name:'Sarah M.',items:{quattro:1,marg:1},slot:base,status:'READY'},{id:1045,name:'Lucas B.',items:{regina:3},slot:base,status:'QUEUED'},{id:1046,name:'Emma R.',items:{marg:2,burrata:1},slot:base+600000,status:'QUEUED'},{id:1047,name:'Hugo P.',items:{quattro:2},slot:base+600000,status:'QUEUED'}],hold:null,notifications:[],next:1048}}
export class AppError extends Error { constructor(message,status=409){super(message);this.status=status;} }
export const count=items=>Object.values(items).reduce((a,b)=>a+b,0);
export function required(items){const out={};for(const recipe of recipes)for(const [id,n] of Object.entries(recipe.bom))out[id]=(out[id]||0)+n*(items[recipe.id]||0);return out;}
export function fresh(){const s=initial();s.orders=[];s.notifications=[];s.next=1001;delete s.hold;s.holds={};s.receipts={};return s;}
export function clean(s,now){for(const [id,h] of Object.entries(s.holds))if(h.expires<=now)delete s.holds[id];for(const [id,r] of Object.entries(s.receipts))if(r.at<now-7*86400000)delete s.receipts[id];const base=Math.ceil((now+12*60000)/600000)*600000;s.slots=Array.from({length:8},(_,i)=>base+i*600000);}
export function snapshot(s,session,revision,now=Date.now()){clean(s,now);const other=Object.entries(s.holds).filter(([id])=>id!==session).map(([,h])=>h);const reservedOther={};for(const h of other)for(const [id,n] of Object.entries(required(h.items)))reservedOther[id]=(reservedOther[id]||0)+n;return {revision,serverTime:now,capacity:s.capacity,pausedUntil:s.pausedUntil,stock:s.stock,orders:s.orders.map(o=>({...o,client:o.session===session,session:undefined})),hold:s.holds[session]||null,notifications:s.notifications,slots:s.slots,reservedOther,slotHolds:Object.fromEntries(s.slots.map(t=>[t,other.filter(h=>h.slot===t).reduce((n,h)=>n+count(h.items),0)]))};}
function integer(n,min,max,label){if(!Number.isSafeInteger(n)||n<min||n>max)throw new AppError(label,400);return n;}
function validateItems(items){if(!items||typeof items!=='object'||Array.isArray(items)||Object.keys(items).length===0)throw new AppError('Le panier est vide.',400);for(const [id,n] of Object.entries(items)){if(!recipes.some(r=>r.id===id))throw new AppError('Recette inconnue.',400);integer(n,1,50,'Quantité invalide.');}if(count(items)>50)throw new AppError('Maximum 50 pizzas par commande.',400);return items;}
function available(s,items,skipSession){const need=required(items);for(const [session,h] of Object.entries(s.holds))if(session!==skipSession)for(const [id,n] of Object.entries(required(h.items)))need[id]=(need[id]||0)+n;return Object.entries(need).every(([id,n])=>s.stock[id].qty>=n);}
function used(s,slot){return s.orders.filter(o=>o.slot===slot&&o.status!=='CANCELLED').reduce((n,o)=>n+count(o.items),0)+Object.values(s.holds).filter(h=>h.slot===slot).reduce((n,h)=>n+count(h.items),0);}
export function apply(s,action,payload,session,now=Date.now()){
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
  const id=s.next++;s.orders.push({id,name,items:h.items,slot:h.slot,status:'QUEUED',session,createdAt:now});delete s.holds[session];result={orderId:id};break;
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

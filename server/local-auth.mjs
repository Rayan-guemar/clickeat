import {createHash,timingSafeEqual} from 'node:crypto';
export function localAuth(password=''){
 if(password&&password.length<16)throw new Error('PILOTAGE_PASSWORD doit contenir au moins 16 caractères.');
 const digest=text=>createHash('sha256').update(text).digest();
 const expected=digest('admin:'+password);
 return request=>{
  const header=request.headers.get('authorization')||'';
  if(!password||!header.startsWith('Basic '))return false;
  const credentials=Buffer.from(header.slice(6),'base64').toString('utf8');
  return timingSafeEqual(digest(credentials),expected);
 };
}

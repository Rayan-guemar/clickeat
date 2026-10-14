import test from 'node:test';
import assert from 'node:assert/strict';
import {localAuth} from '../server/local-auth.mjs';
import {identity} from '../server/api.mjs';
const req=value=>new Request('http://localhost/pilotage',{headers:value?{authorization:'Basic '+Buffer.from(value).toString('base64')}:{}});
test('standalone owner authentication rejects absent, wrong and disabled credentials',()=>{
 const check=localAuth('a-test-password-1234');
 assert.equal(check(req()),false);assert.equal(check(req('admin:wrong')),false);
 assert.equal(check(req('other:a-test-password-1234')),false);
 assert.equal(check(req('admin:a-test-password-1234')),true);
 assert.equal(localAuth()(req('admin:')),false);assert.throws(()=>localAuth('short'));
});
test('standalone resolver does not trust spoofed Sites identity headers',async()=>{
 const request=new Request('http://localhost',{headers:{'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'}});
 assert.equal((await identity(request,{resolveIdentity:r=>({manager:localAuth('a-test-password-1234')(r)})})).manager,false);
 assert.equal((await identity(request,{trustPlatform:true,ownerEmail:'owner@example.test'})).manager,true);
});

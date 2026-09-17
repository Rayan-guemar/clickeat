import {readFile,writeFile,mkdir,copyFile,cp} from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});await mkdir('dist/client',{recursive:true});await mkdir('dist/.openai',{recursive:true});
const modules=await Promise.all(['domain','repository','api'].map(async n=>(await readFile(`server/${n}.mjs`,'utf8')).replace(/^import .*;\n/gm,'').replace(/export (const|function|class)/g,'$1')));
const worker=`${modules.join('\n')}\nlet handler;let boundDB;\nexport default {async fetch(request,env){if(new URL(request.url).pathname.startsWith('/api/')){if(!env.DB)return Response.json({error:'Database binding missing'},{status:503});if(boundDB!==env.DB){boundDB=env.DB;handler=api(env.DB,{trustPlatform:true,ownerEmail:env.PILOTAGE_OWNER_EMAIL});}return handler(request);}const url=new URL(request.url);if(['/','/client','/client/','/pilotage','/pilotage/'].includes(url.pathname)){url.pathname='/index.html';return env.ASSETS.fetch(new Request(url,request));}return env.ASSETS.fetch(request);}};\n`;
await writeFile('dist/server/index.js',worker);
for(const file of ['index.html','style.css','app.js','server-client.js','sw.js','pizza.jpg'])await copyFile('dist/'+file,'dist/client/'+file);
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
console.log('Worker and browser assets built.');

await cp('drizzle','dist/.openai/drizzle',{recursive:true});

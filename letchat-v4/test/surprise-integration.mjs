import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { io } from "socket.io-client";
import pg from "pg";
import sharp from "sharp";

const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0,"127.0.0.1",r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; };
const dbPort=await freePort(), port=await freePort(), origin=`http://127.0.0.1:${port}`;
const db=await PGlite.create(), database=new PGLiteSocketServer({db,port:dbPort,host:"127.0.0.1",maxConnections:20});
let child, pool, logs="", count=0; const sockets=[];
function check(value,label) { assert.ok(value,label); count++; console.log(`✓ ${label}`); }
async function request(route,token,method="GET",body) {
  const r=await fetch(origin+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined?{"Content-Type":"application/json"}: {})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const text=await r.text();let data;try{data=JSON.parse(text);}catch{}
  return {status:r.status,data,text};
}
async function connect(user) {
  const s=io(origin,{auth:{token:user.token},transports:["websocket"],reconnection:false});sockets.push(s);
  await Promise.race([once(s,"connect"),once(s,"connect_error").then(([e])=>Promise.reject(e)),wait(5000).then(()=>Promise.reject(new Error("socket timeout")))]);return s;
}
const event = (socket,name,payload) => new Promise((resolve,reject)=>socket.timeout(4000).emit(name,payload,(e,r)=>e?reject(e):resolve(r)));
try {
  await database.start(); const connectionString=`postgresql://postgres:local-test-only@127.0.0.1:${dbPort}/postgres`;
  pool=new pg.Pool({connectionString});
  child=spawn(process.execPath,["server.js"],{env:{...process.env,PORT:String(port),DATABASE_URL:connectionString,JWT_SECRET:"local-social-test-secret-with-more-than-32-characters",NODE_ENV:"test",STRIPE_SECRET_KEY:"",VAPID_PUBLIC_KEY:"",VAPID_PRIVATE_KEY:"",ADMIN_UID:"",ADMIN_EMAIL:"",METERED_DOMAIN:""},stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",c=>logs+=c);child.stderr.on("data",c=>logs+=c);
  let ready=false;for(let i=0;i<100;i++){try{if((await request("/api/health")).status===200){ready=true;break;}}catch{}await wait(100);}
  assert.ok(ready,logs);
  const register=async name=>{const r=await request("/api/auth/register",null,"POST",{username:name,password:"Social-test-password-123",age:30,city:"Testville",gender:"neutral"});assert.equal(r.status,201);await request("/api/rules-accept",r.data.token,"POST",{accepted:true});return r.data;};
  const users=[];for(const name of ["Alice Social","Bruno Social","Clara Social","David Social","Emma Social"])users.push(await register(name));
  const [a,b,c,d,e]=users;
  const ss=[]; for(const u of users) ss.push(await connect(u));
  const [sa,sb,sc,sd,se]=ss;
  const act=(s,kind,payload={})=>event(s,`surprise-${kind}`,payload);
  const status=async s=>(await act(s,'status')).state;
  check((await act(sa,'join')).state.status==='waiting','first volunteer waits without inventing a partner');
  check((await status(sb)).status==='idle','connected members are never enrolled automatically');
  check((await act(sa,'join')).state.status==='waiting','repeated join is idempotent');
  let paired=(await act(sb,'join')).state;
  check(paired.status==='matched'&&paired.partner.id===a.user.id,'second volunteer is paired with first');
  check((await status(sa)).partner.id===b.user.id,'pair is reciprocal');
  check(!JSON.stringify(paired).includes('token')&&!JSON.stringify(paired).includes('email'),'matching only exposes public identity');
  const firstId=paired.matchId;
  await act(sa,'next',{matchId:firstId}); await act(sb,'join');
  check((await status(sa)).status==='waiting'&&(await status(sa)).skipped===true,'passing still excludes the previous person for the ongoing search');
  check((await status(sb)).status==='waiting','a passed person is not immediately paired back');
  await act(sa,'leave'); await act(sa,'join');
  check((await status(sa)).status==='matched','explicit restart clears only the temporary passed-person exclusion');
  const message=await request('/api/private',a.token,'POST',{recipientId:b.user.id,body:'Bonjour depuis Rencontre Surprise'});
  check(message.status===201,'matched people can use the existing private chat');
  check((await request(`/api/private/${a.user.id}`,b.token)).data.some(m=>m.body==='Bonjour depuis Rencontre Surprise'),'private message reaches the matched recipient');
  await Promise.all([sc,sd,se].map(s=>act(s,'join')));
  let states=await Promise.all(ss.map(status));
  const matched=states.filter(x=>x.status==='matched');
  check(matched.length===4&&states.filter(x=>x.status==='waiting').length===1,'simultaneous joins create disjoint pairs');
  for(let i=0;i<states.length;i++) if(states[i].partner){const j=users.findIndex(u=>u.user.id===states[i].partner.id);check(states[j].partner.id===users[i].user.id,'concurrent pair has a reciprocal partner');}
  await Promise.all(ss.map(s=>act(s,'leave')));
  check((await status(sa)).status==='idle','leave removes participation');
  await act(sa,'join');await act(sb,'join');
  check((await status(sa)).status==='matched'&&(await status(sb)).status==='matched','two accounts can restart an explicit search immediately after leaving');
  const secondA=await connect(a);
  check(!(await act(secondA,'join')).ok,'second tab cannot duplicate the same participant');
  secondA.disconnect();
  check((await status(sa)).status==='matched','closing an unrelated tab preserves the active match');
  await act(sc,'join');
  states=await Promise.all(ss.map(status));
  let i=states.findIndex(x=>x.status==='matched'), j=users.findIndex(u=>u.user.id===states[i].partner.id);
  const left=users[i],right=users[j],sl=ss[i],sr=ss[j];
  check((await request(`/api/blocks/${right.user.id}`,left.token,'POST')).status===201,'participant can block their match');
  check((await status(sl)).status==='idle'&&(await status(sr)).status==='idle','blocking immediately ends both sides');
  check((await request('/api/private',right.token,'POST',{recipientId:left.user.id,body:'Blocked message'})).status===403,'block prevents further private messages');
  await Promise.all(ss.map(s=>act(s,'leave')));
  await act(sl,'join');await act(sr,'join');
  check((await status(sl)).status==='waiting'&&(await status(sr)).status==='waiting','blocked users are excluded from matching');
  await request(`/api/blocks/${right.user.id}`,left.token,'DELETE');
  await wait(6000);
  check((await status(sl)).status==='matched'&&(await status(sr)).status==='matched','queued users are matched automatically after a block is removed, without another click');
  await Promise.all(ss.map(s=>act(s,'leave')));
  await pool.query("UPDATE profiles SET private_message_policy='nobody' WHERE user_id=$1",[c.user.id]);
  check(!(await act(sc,'join')).ok,'disabled private messages prevent participation');
  await pool.query("UPDATE profiles SET private_message_policy='everyone' WHERE user_id=$1",[c.user.id]);
  await pool.query('DELETE FROM letchat_consents WHERE user_id=$1',[c.user.id]);
  check(!(await act(sc,'join')).ok,'community rules must be accepted');
  await request('/api/rules-accept',c.token,'POST',{accepted:true});
  await act(sd,'join');sd.disconnect();await wait(100);
  const newD=await connect(d);ss[3]=newD;
  check((await status(newD)).status==='idle','reconnection never re-enrolls a user');
  await Promise.all(ss.map(s=>act(s,'join')));
  states=await Promise.all(ss.map(status));
  i=states.findIndex(x=>x.status==='matched');assert.ok(i>=0);
  j=users.findIndex(u=>u.user.id===states[i].partner.id);
  const oldId=states[i].matchId,oldPeer=states[i].partner.id;
  await Promise.all([act(ss[i],'next',{matchId:oldId}),act(ss[i],'next',{matchId:oldId})]);
  const after=await status(ss[i]);
  check(after.status==='waiting'||(after.status==='matched'&&after.partner.id!==oldPeer),'pass searches for a different partner');
  check((await status(ss[j])).status==='idle','passed partner is informed and not silently requeued');
  if(after.status==='matched')check(after.matchId!==oldId,'duplicate stale pass cannot end a new match');
  await Promise.all(ss.map(s=>act(s,'leave')));
  for(const s of ss)s.disconnect();
  if(process.env.LETCHAT_BROWSER_QA==='1') {
    const browserUsers=[];for(const name of ['Fanny Surprise','Gabriel Surprise'])browserUsers.push(await register(name));
    const {runSurpriseBrowserQA}=await import('./surprise-browser.mjs');
    await runSurpriseBrowserQA({origin,users:browserUsers,request,check});
  }
  check(!logs.includes('Erreur serveur'),'no unhandled server errors');
  console.log(`\n${count} Surprise integration checks passed.`);
} finally {
  for(const s of sockets)s.disconnect();
  if(child){child.kill('SIGTERM');await Promise.race([once(child,'exit'),wait(2000)]);}
  await pool?.end();await database.stop();
  // PGlite's socket adapter schedules client detachment on the next event loop.
  await wait(100);await db.close();
}

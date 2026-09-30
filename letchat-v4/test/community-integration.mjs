import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { io } from "socket.io-client";
import { purgeExpiredGuests } from "../lib/accounts.js";

const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const freePort = async () => { const s=net.createServer(); await new Promise(r=>s.listen(0,"127.0.0.1",r)); const port=s.address().port; await new Promise(r=>s.close(r)); return port; };
const port=await freePort(), dbPort=await freePort(), origin=`http://127.0.0.1:${port}`;
const externalDatabase=process.env.LETCHAT_COMMUNITY_TEST_DATABASE_URL;
const db=externalDatabase ? null : await PGlite.create(), database=db ? new PGLiteSocketServer({db,port:dbPort,host:"127.0.0.1",maxConnections:20}) : null;
let child,pool,logs="",count=0; const sockets=[];
function check(value,label) { assert.ok(value,label); count++; console.log(`✓ ${label}`); }
async function request(route,token,method="GET",body) {
  const response=await fetch(origin+route,{method,signal:AbortSignal.timeout(20000),headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body!==undefined?{"Content-Type":"application/json"}: {})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const text=await response.text(); let data; try{data=JSON.parse(text);}catch{}
  return {status:response.status,data,text};
}
async function connect(user) {
  const s=io(origin,{auth:{token:user.token},transports:["websocket"],reconnection:false}); sockets.push(s);
  await Promise.race([once(s,"connect"),once(s,"connect_error").then(([e])=>Promise.reject(e)),wait(5000).then(()=>Promise.reject(new Error("socket timeout")))]); return s;
}
const act=(socket,kind,payload={})=>new Promise((resolve,reject)=>socket.timeout(4000).emit(`surprise-${kind}`,payload,(e,r)=>e?reject(e):resolve(r)));
try {
  await database?.start(); const connectionString=externalDatabase || `postgresql://postgres:test-only@127.0.0.1:${dbPort}/postgres`;
  pool=new pg.Pool({connectionString});
  child=spawn(process.execPath,["server.js"],{env:{...process.env,PORT:String(port),DATABASE_URL:connectionString,JWT_SECRET:"local-community-test-secret-longer-than-32-characters",NODE_ENV:"test",STRIPE_SECRET_KEY:"",VAPID_PUBLIC_KEY:"",VAPID_PRIVATE_KEY:"",ADMIN_UID:"",ADMIN_EMAIL:"",METERED_DOMAIN:""},stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",c=>logs+=c); child.stderr.on("data",c=>logs+=c);
  let ready=false;for(let i=0;i<100;i++){try{if((await request("/api/health")).status===200){ready=true;break;}}catch{}await wait(100);}assert.ok(ready,logs);
  const register=async(name,guest=false)=>{
    const r=await request(guest?"/api/auth/guest":"/api/auth/register",null,"POST",{username:name,password:"Community-Test-1234",age:30,city:"Testville",gender:"neutral"});
    assert.equal(r.status,201,JSON.stringify(r.data)); await request("/api/rules-accept",r.data.token,"POST",{accepted:true}); return r.data;
  };
  const a=await register("Alice Community"),b=await register("Bruno Community"),g=await register("Invite Community",true);
  const sa=await connect(a),sb=await connect(b),sg=await connect(g),duplicate=await connect(a);
  check((await request("/api/community/home")).status===401,"home activity requires an authenticated session");
  const home=(await request("/api/community/home",g.token)).data;
  check(home.onlineCount===2&&home.rooms.find(r=>r.id==='cafe').count===2,"home counts distinct other accounts, not tabs or self");
  check(home.rooms.every(r=>!r.id.includes('premium')&&r.id!=='entraide'),"home never exposes adult Premium room activity");
  await request(`/api/blocks/${b.user.id}`,g.token,"POST");
  const blocked=(await request("/api/community/home",g.token)).data;
  check(blocked.onlineCount===1&&!blocked.members.some(m=>m.id===b.user.id),"blocked accounts are excluded from home counts and cards");
  const reverse=(await request("/api/community/home",b.token)).data;
  check(!reverse.members.some(m=>m.id===g.user.id),"the blocked participant cannot discover their blocker through home");
  await request(`/api/blocks/${b.user.id}`,g.token,"DELETE");
  duplicate.disconnect();
  check((await act(sa,"join",{interests:["musique"]})).state.status==='waiting',"an interest search waits for a volunteer");
  check((await act(sb,"join",{interests:["sport"]})).state.status==='waiting',"disjoint interests are not silently matched");
  const match=await act(sg,"join",{interests:["musique","musique","invalid"]});
  check(match.state.status==='matched'&&match.state.partner.id===a.user.id,"common interests match the compatible volunteer");
  check(match.state.sharedInterests.join()==='musique'&&match.state.interests.length===1,"interest payload is normalized and common topics returned");
  await Promise.all([sa,sb,sg].map(s=>act(s,"leave")));
  await act(sa,"join",{interests:["musique"]});
  check((await act(sb,"join")).state.status==='matched',"no preference remains open to all topics");
  await Promise.all([sa,sb,sg].map(s=>act(s,"leave")));

  const dm=await request("/api/private",g.token,"POST",{recipientId:a.user.id,body:"Mon message avant conservation"});
  check(dm.status===201,"guest can create a real conversation before conversion");
  await pool.query("INSERT INTO letchat_friends(requester_id,addressee_id,status) VALUES($1,$2,'accepted')",[g.user.id,a.user.id]);
  const bad=await request("/api/account/upgrade-guest",g.token,"POST",{username:a.user.loginUsername,password:"Guest-New-1234"});
  check(bad.status===409&&(await request("/api/auth/me",g.token)).data.user.guest,"duplicate login leaves the temporary account intact");
  const short=await request("/api/account/upgrade-guest",g.token,"POST",{username:"Permanent Guest",password:"tiny"});
  check(short.status===400,"weak-length passwords are rejected without changing the account");
  const pair=await Promise.all([1,2].map(()=>request("/api/account/upgrade-guest",g.token,"POST",{username:"Permanent Guest",password:"Guest-New-1234"})));
  const upgraded=pair.find(r=>r.status===200)?.data;
  check(Boolean(upgraded)&&pair.filter(r=>r.status===200).length===1,"simultaneous conversions yield one permanent account");
  check(upgraded.user.id===g.user.id&&!upgraded.user.guest&&upgraded.recoveryCode,"conversion preserves identity and returns a recovery code");
  check((await request("/api/auth/me",g.token)).status===401,"old guest credential is revoked");
  check((await request(`/api/private/${a.user.id}`,upgraded.token)).data.some(m=>m.id===dm.data.id),"private history survives conversion");
  check((await request("/api/friends",upgraded.token)).data.some(f=>f.user_id===a.user.id),"accepted friendships survive conversion");
  const local=(await pool.query("SELECT is_guest,expires_at,password_hash,session_version FROM letchat_local_accounts WHERE user_id=$1",[g.user.id])).rows[0];
  check(!local.is_guest&&local.expires_at===null&&local.password_hash&&!local.password_hash.includes('Guest-New'),"account has no guest expiry and password is hashed");
  const login=await request("/api/auth/login",null,"POST",{username:"Permanent Guest",password:"Guest-New-1234"});
  check(login.status===200&&login.data.user.id===g.user.id,"permanent account logs back in under the same identity");
  check((await request("/api/account/upgrade-guest",upgraded.token,"POST",{username:"Again",password:"Guest-New-1234"})).status===409,"permanent account cannot be converted again");
  const expired=await register("Expired Guest",true);
  await pool.query("UPDATE letchat_local_accounts SET expires_at=NOW()-INTERVAL '1 minute' WHERE user_id=$1",[expired.user.id]);
  check((await request("/api/account/upgrade-guest",expired.token,"POST",{username:"Resurrect",password:"Guest-New-1234"})).status===401,"expired guests cannot be converted");
  const noopIo={to:()=>({emit(){}}),in:()=>({disconnectSockets(){}})};
  await purgeExpiredGuests(pool,noopIo);
  check((await pool.query("SELECT 1 FROM profiles WHERE user_id=$1",[g.user.id])).rowCount===1,"expired-guest cleanup preserves the converted profile");
  check(Number((await pool.query("SELECT EXTRACT(EPOCH FROM (expires_at-created_at)) AS seconds FROM letchat_private_messages WHERE id=$1",[dm.data.id])).rows[0].seconds)===48*3600,"conversion does not extend message retention");
  for(const s of sockets)s.disconnect();
  if(process.env.LETCHAT_BROWSER_QA==='1') {
    const desktop=await register("Camille Browser"), mobile=await register("Invite Browser",true);
    const {runCommunityBrowserQA}=await import('./community-browser.mjs');
    await runCommunityBrowserQA({origin,users:[desktop,mobile],request,check});
  }
  check(!logs.includes('Erreur serveur'),"no unhandled server errors");
  console.log(`${count} community checks passed.`);
} catch(error) {
  console.error(error); console.error(logs); process.exitCode=1;
} finally {
  for(const s of sockets)s.disconnect();
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited.catch(()=>{});}
  await pool?.end();await database?.stop();
  // The socket adapter schedules detach/transaction cleanup on setImmediate.
  // Let it finish before disposing the WASM database instance.
  await wait(100);await db?.close();
}

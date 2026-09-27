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
  check((await request("/api/social/groups")).status===401,"authentication required");
  const created=await request("/api/social/groups",a.token,"POST",{name:"Les amis",members:[b.user.id,c.user.id]});
  check(created.status===201,"group creation with two invitations");const gid=created.data.id;
  check((await request("/api/social/groups",b.token)).data[0].status==="pending","invitation delivered to invitee");
  check((await request(`/api/social/groups/${gid}/messages`,b.token)).status===403,"pending invite cannot read group messages");
  check((await request(`/api/social/groups/${gid}/accept`,d.token,"POST")).status===404,"outsider cannot accept a missing invitation");
  check((await request(`/api/social/groups/${gid}/accept`,b.token,"POST")).status===200,"invited member explicitly accepts");
  const png=await sharp({create:{width:10,height:10,channels:3,background:"coral"}}).png().toBuffer();
  const msg=await request(`/api/social/groups/${gid}/messages`,a.token,"POST",{body:"Bonjour le groupe",mediaBase64:png.toString("base64"),mediaType:"image/png"});
  check(msg.status===201,"group text and photo persisted");
  check((await request(`/api/social/groups/${gid}/messages`,b.token)).data.length===1,"accepted member reads messages");
  check((await request(`/api/social/group-media/${msg.data.id}`,b.token)).status===200,"accepted member reads photo");
  check((await request(`/api/social/group-media/${msg.data.id}`,c.token)).status===403,"pending invite cannot fetch photo directly");
  check((await request(`/api/social/groups/${gid}/messages`,a.token,"POST",{mediaBase64:Buffer.from('<svg onload="evil()"/>').toString('base64'),mediaType:'image/svg+xml'})).status===415,"active content upload rejected");
  await request(`/api/social/groups/${gid}/accept`,c.token,"POST");
  check((await request(`/api/social/groups/${gid}/messages`,c.token)).data.length===0,"new member cannot read pre-acceptance history");
  await request(`/api/social/groups/${gid}/membership`,b.token,"DELETE");
  check((await request(`/api/social/group-media/${msg.data.id}`,b.token)).status===403,"leaving revokes photo access");

  const game=await request('/api/social/games',a.token,'POST',{opponentId:b.user.id,kind:'connect4'});const gameId=game.data.id;
  check(game.status===201,"game invitation created");
  check((await request(`/api/social/games/${gameId}/action`,a.token,'POST',{action:'move',move:0,version:0})).status===409,"cannot play before acceptance");
  check((await request(`/api/social/games/${gameId}/action`,c.token,'POST',{action:'accept'})).status===404,"third player cannot accept");
  const accepted=await request(`/api/social/games/${gameId}/action`,b.token,'POST',{action:'accept'});
  check(accepted.data.turn_id===a.user.id,"creator takes first turn after acceptance");
  check((await request(`/api/social/games/${gameId}/action`,b.token,'POST',{action:'move',move:1,version:1})).status===409,"wrong turn rejected");
  const racing=await Promise.all([0,1].map(move=>request(`/api/social/games/${gameId}/action`,a.token,'POST',{action:'move',move,version:1})));
  check(racing.filter(x=>x.status===200).length===1&&racing.filter(x=>x.status===409).length===1,"concurrent moves are applied once");
  let state=racing.find(x=>x.status===200).data;const column=state.board.findIndex(x=>x===1)%7, other=(column+1)%7;
  for (let i=0;i<3;i++) {
    state=(await request(`/api/social/games/${gameId}/action`,b.token,'POST',{action:'move',move:other,version:state.version})).data;
    state=(await request(`/api/social/games/${gameId}/action`,a.token,'POST',{action:'move',move:column,version:state.version})).data;
  }
  check(state.status==='won'&&state.winner_id===a.user.id,"four vertical pieces end the game with the right winner");
  check((await request(`/api/social/games/${gameId}/action`,b.token,'POST',{action:'move',move:2,version:state.version})).status===409,"finished game cannot accept another move");
  const tic=(await request('/api/social/games',a.token,'POST',{opponentId:b.user.id,kind:'tictactoe'})).data.id;
  await request(`/api/social/games/${tic}/action`,b.token,'POST',{action:'accept'});
  let version=1;for (const [u,move] of [[a,0],[b,3],[a,1],[b,4],[a,2]]) {state=(await request(`/api/social/games/${tic}/action`,u.token,'POST',{action:'move',move,version})).data;version=state.version;}
  check(state.status==='won'&&state.winner_id===a.user.id,"tic-tac-toe win persisted");
  check((await request('/api/social/games',d.token)).data.length===0,"game lists are private");

  check((await request('/api/social/profile',a.token,'PUT',{character:'Curieux',likes:'Cuisine',looking_for:'Discuter',visibility:'friends',coverBase64:png.toString('base64'),coverType:'image/png'})).status===200,"rich profile with protected cover saved");
  check((await request(`/api/social/profile/${a.user.id}`,b.token)).data.restricted===true,"friend-only profile hidden from non-friend");
  check((await request(`/api/social/profile/${a.user.id}/cover`,b.token)).status===404,"friend-only cover protected at media endpoint");
  await pool.query("INSERT INTO letchat_friends(requester_id,addressee_id,status) VALUES($1,$2,'accepted')",[a.user.id,b.user.id]);
  check((await request(`/api/social/profile/${a.user.id}`,b.token)).data.character==='Curieux',"friend can read extended profile");
  check((await request(`/api/social/profile/${a.user.id}/cover`,b.token)).status===200,"friend can fetch cover");
  check((await request('/api/account-export',a.token)).data.social.profile.character==='Curieux',"data export includes new profile and groups");

  const ss=[];for(const u of users)ss.push(await connect(u));const [sa,sb,sc,sd,se]=ss;
  check(!(await event(sa,'live-join',{scope:'room:entraide'})).ok,"premium room cannot be entered through live signalling");
  check(!(await event(sb,'live-join',{scope:`group:${gid}`})).ok,"former member cannot enter group call");
  check((await event(sa,'live-join',{scope:`group:${gid}`})).ok,"accepted member enters group call");
  check((await event(sc,'live-join',{scope:`group:${gid}`})).peers.length===1,"second group participant sees existing peer");
  check(!(await event(sd,'live-signal',{target:sa.id,data:{type:'offer',sdp:'outsider'}})).ok,"outsider signalling rejected");
  sa.emit('live-leave');sc.emit('live-leave');await wait(80);
  const joins=await Promise.all(ss.map(s=>event(s,'live-join',{scope:'room:cafe'})));
  check(joins.filter(x=>x.ok).length===4&&joins.filter(x=>!x.ok).length===1,"simultaneous joins respect the four-person cap");
  await request(`/api/blocks/${b.user.id}`,a.token,'POST');await wait(100);
  check((await request(`/api/social/profile/${a.user.id}/cover`,b.token)).status===403,"blocking revokes rich media access");
  check(!(await event(sa,'live-signal',{target:sb.id,data:{type:'offer',sdp:'after block'}})).ok,"blocking interrupts live signalling");
  check((await request('/api/social/games',a.token,'POST',{opponentId:b.user.id,kind:'tictactoe'})).status===403,"blocked member cannot be challenged");
  await request(`/api/blocks/${b.user.id}`,a.token,'DELETE');
  for(const s of ss)s.emit('live-leave');
  if(process.env.LETCHAT_BROWSER_QA==='1') { const {runBrowserQA}=await import('./social-browser.mjs');await runBrowserQA({origin,users,request,pool,check}); }
  await request('/api/account',a.token,'DELETE',{confirmation:'SUPPRIMER'});
  check(!(await pool.query('SELECT 1 FROM letchat_profile_extras WHERE user_id=$1',[a.user.id])).rowCount,"account deletion removes rich media");
  check(!(await pool.query('SELECT 1 FROM letchat_groups WHERE id=$1',[gid])).rowCount,"owner deletion removes group and child data");
  check(!logs.includes('Erreur serveur'),"no unhandled server errors");
  console.log(`\n${count} social integration checks passed.`);
} finally {
  for(const s of sockets)s.disconnect();
  if(child){child.kill('SIGTERM');await Promise.race([once(child,'exit'),wait(2000)]);}
  await pool?.end();await database.stop();
  // PGlite's socket adapter schedules client detachment on the next event loop.
  await wait(100);await db.close();
}

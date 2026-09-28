import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { io } from "socket.io-client";
import sharp from "sharp";
import { SignJWT } from "jose";
import { createCheckout } from "../lib/checkout.js";
import { purgeExpiredGuests } from "../lib/accounts.js";
import { CITY_DATA_URL } from "../public/city-autocomplete.js";


const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0,"127.0.0.1",r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const temporary = await mkdtemp(path.join(os.tmpdir(), "letchat-tests-"));
const dbPort = await freePort(), appPort = await freePort();
const externalDatabase = process.env.TEST_DATABASE_URL || "";
if (externalDatabase) {
  const url = new URL(externalDatabase);
  if (!["localhost", "127.0.0.1", "postgres"].includes(url.hostname) || url.pathname !== "/letchat_audit_test")
    throw new Error("TEST_DATABASE_URL must target the isolated local database letchat_audit_test");
}
const db = externalDatabase ? null : await PGlite.create();
const database = db ? new PGLiteSocketServer({ db, port:dbPort, host:"127.0.0.1", maxConnections:20 }) : null;
const secret = "isolated-test-secret-with-more-than-32-characters";
let child, pool, assertions = 0, logs = "";
const sockets = [];
const check = (condition, label) => { assert.ok(condition, label); assertions++; console.log(`✓ ${label}`); };
const request = async (route, token, method = "GET", body) => {
  const response = await fetch(`http://127.0.0.1:${appPort}${route}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? {"Content-Type":"application/json"} : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect:"manual"
  });
  const data = await response.text();
  let json; try { json=JSON.parse(data); } catch {}
  return { status: response.status, headers: response.headers, data, json };
};
const openSocket = async token => {
  const socket = io(`http://127.0.0.1:${appPort}`, { auth:{token},transports:["websocket"],reconnection:false }); sockets.push(socket);
  await Promise.race([once(socket,"connect"), once(socket,"connect_error").then(([e])=>Promise.reject(e)),wait(5000).then(()=>Promise.reject(new Error("socket timeout")))]);
  return socket;
};
try {
  await database?.start();
  const connectionString=externalDatabase || `postgresql://postgres:local-test-only@127.0.0.1:${dbPort}/postgres`;
  pool = new pg.Pool({ connectionString });
  child = spawn(process.execPath,["server.js"],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:connectionString,PORT:String(appPort),JWT_SECRET:secret,NODE_ENV:"test",STRIPE_SECRET_KEY:"",VAPID_PUBLIC_KEY:"",VAPID_PRIVATE_KEY:"",ADMIN_UID:"",ADMIN_EMAIL:""},stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",c=>{ logs+=c; }); child.stderr.on("data",c=>{ logs+=c; });
  let ready=false;
  for(let i=0;i<100;i++) { try { if((await request("/api/health")).status===200){ready=true;break;} }catch{} await wait(100); }
  assert.ok(ready,logs);
  const root = await request("/");
  check(root.status===200 && root.headers.get("cross-origin-opener-policy")==="same-origin-allow-popups", "OAuth popup policy and public page");
  check(root.headers.get("content-security-policy").includes("script-src-attr 'none'"),"CSP rejects inline script attributes");
  const scriptSources = root.headers.get("content-security-policy").split(";").find(d => d.trim().startsWith("script-src ")).trim().split(/\s+/).slice(1);
  check(["https://www.gstatic.com", "https://www.googleapis.com", "https://apis.google.com"].every(origin => scriptSources.includes(origin)), "Firebase Google sign-in keeps its required origins");
  check(!["*", "https:", "'unsafe-inline'", "'unsafe-eval'"].some(source => scriptSources.includes(source)), "chat keeps its restricted script policy");
  check(root.data.includes('name="description"') && root.data.includes('rel="canonical"'),"SEO metadata present");
  const asset=root.data.match(/\/assets\/app-v4-cafe-v2\.[a-f0-9]+\.js/)[0];
  check((await request(asset)).headers.get("cache-control").includes("immutable"),"fingerprinted assets use immutable cache");
  const cityScript=root.data.match(/\/assets\/city-autocomplete\.[a-f0-9]+\.js/)?.[0];
  const cityScriptResponse=cityScript && await request(cityScript);
  check(cityScriptResponse?.status===200 && cityScriptResponse.data.includes(CITY_DATA_URL),"delivered page serves the fingerprinted city module and its catalogue URL");
  const cityCatalogue=await request(CITY_DATA_URL);
  check(cityCatalogue.status===200 && cityCatalogue.headers.get("content-type").includes("application/json") && cityCatalogue.json.some(row=>row[0]==="Montpellier"),"city catalogue is available before sign-in as same-origin JSON");
  check((await request("/api/auth/me")).status===401,"sensitive API rejects anonymous requests");
  check((await request("/does-not-exist.html")).status===404,"unknown public page returns 404");
  const privacy=await request("/privacy.html");
  check(privacy.status===301&&privacy.headers.get("location")==="/confidentialite.html","old privacy link redirects to correct document");
  check((await request("/robots.txt")).data.startsWith("User-agent:"),"robots.txt is a real text resource");
  check(!(await request(asset)).data.includes("pagead2.googlesyndication.com"),"chat never injects AdSense");
  const discovery = await request("/decouvrir.html"), discoveryAgain = await request("/decouvrir.html");
  const nonce = discovery.data.match(/nonce="([^"]+)"/)?.[1];
  check(discovery.status === 200 && nonce && discovery.headers.get("content-security-policy").includes(`'nonce-${nonce}'`) && discovery.headers.get("content-security-policy").includes("'strict-dynamic'"), "public advertising document has a matching strict nonce CSP");
  check(discovery.headers.get("cache-control").includes("no-store") && !discoveryAgain.data.includes(`nonce="${nonce}"`), "advertising HTML is not cached and nonces are unique");
  check(!discovery.data.includes("adsbygoogle") && discovery.data.includes("discovery-page.js"), "public HTML does not request ads before the session and CMP checks");
  const legal = await request("/confidentialite.html");
  check(!/<script\b/i.test(legal.data) && !legal.headers.get("content-security-policy").includes("strict-dynamic"), "privacy page contains no scripts and keeps the restricted CSP");
  const config = (await request("/api/public-config")).json;
  check(config.advertisingEnabled === true && config.advertisingPages.length === 1 && config.advertisingPages[0] === "/decouvrir.html", "advertising configuration names only the public document");

  const register=async name=>{
    const result=await request("/api/auth/register",null,"POST",{username:name,password:"Initial-password-123",age:30,gender:"neutral",city:"Testville"});
    assert.equal(result.status,201,JSON.stringify(result.json));
    await request("/api/rules-accept",result.json.token,"POST",{accepted:true});return result.json;
  };
  const a=await register("Audit A"), b=await register("Audit B"), c=await register("Audit C");
  check(Boolean(a.recoveryCode)&&a.token,"registration returns recovery code and working token");
  check((await request("/api/admin/stats",a.token)).status===403,"standard account cannot access admin statistics");
  check((await request("/api/messages?room=entraide",a.token)).status===403,"free account cannot access XXX messages");
  const guest=(await request("/api/auth/guest",null,"POST",{username:"Temporary audit",age:30,gender:"neutral",city:"Testville"})).json;
  check((await request("/api/stripe/checkout",guest.token,"POST",{plan:"premium"})).status===403,"guest cannot open a payment");
  const sa=await openSocket(a.token), sb=await openSocket(b.token), sc=await openSocket(c.token);
  const signalsA=[],signalsB=[];sa.on("webrtc",d=>signalsA.push(d));sb.on("webrtc",d=>signalsB.push(d));
  const callId=randomUUID();
  sa.emit("webrtc",{target:sb.id,data:{type:"invite",callId}});await wait(180);
  check(signalsB.at(-1)?.data.type==="invite"&&!signalsB.at(-1).user.email&&!signalsB.at(-1).user.profile,"real Socket.IO invitation contains only public identity");
  sc.emit("webrtc",{target:sa.id,data:{type:"join",callId}});await wait(100);
  check(signalsA.length===0,"third account cannot join another call");
  sb.emit("webrtc",{target:sa.id,data:{type:"join",callId}});await wait(120);
  check(signalsA.at(-1)?.data.type==="join","invited account can explicitly accept");
  await request(`/api/blocks/${encodeURIComponent(b.user.id)}`,a.token,"POST");await wait(100);
  check(signalsA.at(-1)?.data.type==="leave"&&signalsB.at(-1)?.data.type==="leave","blocking disconnects the active call");
  await request(`/api/blocks/${encodeURIComponent(b.user.id)}`,a.token,"DELETE");

  const png=await sharp({create:{width:8,height:8,channels:3,background:"blue"}}).png().toBuffer();
  const malicious=await request("/api/messages",a.token,"POST",{room:"cafe",mediaBase64:Buffer.from("<svg onload='bad()'/>").toString("base64"),mediaType:"image/svg+xml"});
  check(malicious.status===415,"real media upload rejects SVG");
  const photo=await request("/api/messages",a.token,"POST",{room:"cafe",mediaBase64:png.toString("base64"),mediaType:"image/png"});
  check(photo.status===201&&photo.json.media_type==="image/webp","real image upload is re-encoded");
  const media=await request(`/api/media/${photo.json.id}`,b.token);
  check(media.status===200&&media.headers.get("content-security-policy").includes("sandbox"),"media is authenticated and sandboxed");
  check((await request(`/api/media/${photo.json.id}?t=${encodeURIComponent(b.token)}`)).status===401,"session tokens in media URLs are rejected");
  const incomingNotification=once(sb,"notification",{signal:AbortSignal.timeout(5000)});
  const pm=await request("/api/private",a.token,"POST",{recipientId:b.user.id,mediaBase64:png.toString("base64"),mediaType:"image/png",viewOnce:true});
  check(pm.status===201,"private view-once photo created");
  const [liveNotification]=await incomingNotification;
  check(liveNotification.type==="private_message" && liveNotification.actor_id===a.user.id && liveNotification.actor_name==="Audit A","live private-message notification includes the sender's display name");
  const inbox=await request("/api/notifications",b.token);
  check(inbox.status===200,"recipient can reload their notifications");
  assert.deepEqual(liveNotification,inbox.json.find(item=>item.id===liveNotification.id));
  check(true,"live and reloaded notifications expose the same public sender identity");
  check((await request(`/api/private-media/${pm.json.id}`,c.token)).status===404,"third account cannot fetch private media");
  const readings=await Promise.all([request(`/api/private-media/${pm.json.id}`,b.token),request(`/api/private-media/${pm.json.id}`,b.token)]);
  check(readings.filter(r=>r.status===200).length===1&&readings.filter(r=>r.status===410).length===1,"concurrent view-once reads consume the photo once");

  check((await request("/api/account/recovery-code",a.token,"POST",{password:"wrong"})).status===403,"recovery rotation requires the current password");
  const resetBody={username:"Audit A",recoveryCode:a.recoveryCode,password:"Changed-password-456"};
  const resets=await Promise.all([request("/api/auth/recover",null,"POST",resetBody),request("/api/auth/recover",null,"POST",resetBody)]);
  check(resets.filter(r=>r.status===200).length===1,"recovery code can only be consumed once concurrently");
  await wait(80);
  check(!sa.connected&&(await request("/api/auth/me",a.token)).status===401,"password reset revokes HTTP and socket sessions");
  check((await request("/api/auth/login",null,"POST",{username:"Audit A",password:"Initial-password-123"})).status===401,"old password no longer works");
  const newLogin=await request("/api/auth/login",null,"POST",{username:"Audit A",password:"Changed-password-456"});
  check(newLogin.status===200,"new password signs in");

  const expiry=new Date(Date.now()+2200);
  await pool.query("UPDATE letchat_local_accounts SET expires_at=$2 WHERE user_id=$1",[guest.user.id,expiry]);
  const sg=await openSocket(guest.token);
  await Promise.race([once(sg,"disconnect"),wait(4500).then(()=>Promise.reject(new Error("guest not disconnected")))]);
  check(!sg.connected,"guest socket closes automatically at expiry while idle");
  const ioStub={to(){return this},in(){return this},emit(){},disconnectSockets(){}};
  await purgeExpiredGuests(pool,ioStub);
  check(!(await pool.query("SELECT 1 FROM profiles WHERE user_id=$1",[guest.user.id])).rowCount,"expired guest profile is purged");
  const deleted=await request("/api/account",c.token,"DELETE",{confirmation:"SUPPRIMER"});await wait(100);
  check(deleted.status===200&&!sc.connected&&(await request("/api/auth/me",c.token)).status===401,"account deletion revokes active connections");

  // Stripe doubles simulate external responses, while actual PostgreSQL locks
  // and durable checkout records are exercised through PGlite. It multiplexes sessions;
  // real multi-process advisory-lock behavior requires PostgreSQL validation. No payment is performed.
  let sessionCalls=0, customerCalls=0, subscriptions=[], throwAfterCreate=false;
  const sessions=new Map(), byKey=new Map();
  const stripe={customers:{create:async()=>({id:`cus_${++customerCalls}`})},prices:{retrieve:async()=>({active:true,type:"recurring"})},
    subscriptions:{retrieve:async()=>({status:"canceled"}),list:async()=>({data:subscriptions})},
    checkout:{sessions:{retrieve:async id=>sessions.get(id),expire:async id=>{sessions.get(id).status="expired";return sessions.get(id)},create:async(params,{idempotencyKey})=>{
      await wait(30);
      if(byKey.has(idempotencyKey))return byKey.get(idempotencyKey);
      const session={id:`cs_${++sessionCalls}`,status:"open",url:`https://checkout.example.invalid/${sessionCalls}`};sessions.set(session.id,session);byKey.set(idempotencyKey,session);
      if(throwAfterCreate){throwAfterCreate=false;throw new Error("simulated lost response");}return session;
    }}}};
  const options={pool,stripe,user:{id:b.user.id,email:""},plan:"premium",priceId:"price_one",baseUrl:"https://www.letchat.fr"};
  const payments=await Promise.all([createCheckout(options),createCheckout(options),createCheckout(options)]);
  check(sessionCalls===1&&customerCalls===1&&payments.every(p=>p.url===payments[0].url),"parallel payments share one customer and one Checkout session");
  const changed=await createCheckout({...options,plan:"premium_plus",priceId:"price_two"});
  check(sessionCalls===2&&sessions.get("cs_1").status==="expired"&&changed.url.endsWith("/2"),"changing plan expires the previous open checkout");
  sessions.get("cs_2").status="expired";throwAfterCreate=true;
  await assert.rejects(createCheckout(options),/lost response/);
  const retried=await createCheckout(options);
  check(sessionCalls===3&&retried.url.endsWith("/3"),"lost Stripe response reuses the durable idempotency key");
  subscriptions=[{status:"active"}];
  await assert.rejects(createCheckout(options),{status:409});
  check(sessionCalls===3,"active external subscription prevents another checkout");
  check(!logs.includes("Erreur serveur"),"no unexpected server error during integration scenarios");
  console.log(`\n${assertions} integration checks passed on ${externalDatabase ? "isolated PostgreSQL" : "isolated PGlite (PostgreSQL WASM); multi-process advisory locks still need PostgreSQL validation"}.`);
} catch(error) { console.error(logs); console.error(error.stack || error.message); process.exitCode = 1; }
finally {
  for(const socket of sockets)socket.disconnect();
  if(child){child.kill("SIGTERM");await once(child,"exit").catch(()=>{});}
  await pool?.end(); await database?.stop().catch(()=>{}); await wait(100); await db?.close(); await rm(temporary,{recursive:true,force:true});
}

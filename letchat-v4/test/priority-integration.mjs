import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID, createECDH, randomBytes } from "node:crypto";
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
import webpush from "web-push";
import { runGuestJourney } from "./guest-journey.mjs";


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
const vapid = webpush.generateVAPIDKeys();
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
  child = spawn(process.execPath,["server.js"],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:connectionString,PORT:String(appPort),JWT_SECRET:secret,NODE_ENV:"test",STRIPE_SECRET_KEY:"",VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey,ADMIN_UID:"",ADMIN_EMAIL:""},stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",c=>{ logs+=c; }); child.stderr.on("data",c=>{ logs+=c; });
  let ready=false;
  for(let i=0;i<100;i++) { try { if((await request("/api/health")).status===200){ready=true;break;} }catch{} await wait(100); }
  assert.ok(ready,logs);
  const register = async username => {
    const r = await request("/api/auth/register", null, "POST", {username,password:"Initial-password-123",age:30,city:"Montpellier"});
    assert.equal(r.status,201,r.data);
    assert.equal((await request("/api/rules-accept",r.json.token,"POST",{accepted:true})).status,200);
    return r.json;
  };
  const a = await register("Stable Login"), b = await register("Other Login");
  check(a.user.loginUsername === "Stable Login", "registration returns the permanent login identifier");
  const renamed = await request("/api/profile",a.token,"PUT",{displayName:"Nouveau Nom",city:"Montpellier"});
  check(renamed.status === 200, "profile display name can still be changed");
  const me = (await request("/api/auth/me",a.token)).json.user;
  check(me.name === "Nouveau Nom" && me.loginUsername === "Stable Login", "restored session separates display name from login identifier");
  const profile = (await request("/api/profile",a.token)).json;
  check(profile.loginUsername === "Stable Login", "own profile returns the permanent login identifier");
  const otherProfile = (await request(`/api/profile/${encodeURIComponent(a.user.id)}`,b.token)).json;
  check(!JSON.stringify(otherProfile).includes("Stable Login"), "public profile does not reveal the private login identifier");
  const rotation = await request("/api/account/recovery-code",a.token,"POST",{password:"Initial-password-123"});
  check(rotation.status === 200 && rotation.json.loginUsername === "Stable Login", "recovery rotation returns canonical login after rename");
  const recovered = await request("/api/auth/recover",null,"POST",{username:rotation.json.loginUsername,recoveryCode:rotation.json.recoveryCode,password:"Changed-password-456"});
  check(recovered.status === 200 && recovered.json.loginUsername === "Stable Login", "account is recovered using only the recovery file fields");
  check((await request("/api/auth/me",a.token)).status === 401, "recovery revokes the previous session");
  check((await request("/api/auth/recover",null,"POST",{username:rotation.json.loginUsername,recoveryCode:rotation.json.recoveryCode,password:"Another-password-789"})).status === 400, "recovery code cannot be reused");
  const loggedIn = await request("/api/auth/login",null,"POST",{username:"Stable Login",password:"Changed-password-456"});
  check(loggedIn.status === 200 && loggedIn.json.user.loginUsername === "Stable Login" && loggedIn.json.user.name === "Nouveau Nom", "permanent identifier and new password sign in");
  a.token = loggedIn.json.token;
  const guest = await request("/api/auth/guest",null,"POST",{username:"Temporary",age:30,city:"Montpellier"});
  check((await request("/api/auth/me",guest.json.token)).json.user.loginUsername === null, "guest does not receive a permanent login identifier");
  check((await request("/api/account/recovery-code",guest.json.token,"POST",{password:"x"})).status === 400, "guests cannot generate account recovery codes");

  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const keys = {p256dh:ecdh.getPublicKey().toString("base64url"),auth:randomBytes(16).toString("base64url")};
  const endpoints = ["https://fcm.googleapis.com/wp/token", "https://updates.push.services.mozilla.com/wpush/v2/token", "https://web.push.apple.com/Q/token", "https://wns2-sg2p.notify.windows.com/w/?token=token"];
  for (const endpoint of endpoints) {
    const r = await request("/api/push/subscribe",a.token,"POST",{endpoint,keys});
    check(r.status === 200, `browser endpoint accepted: ${new URL(endpoint).hostname}`);
  }
  for (const endpoint of ["https://127.0.0.1/x", "https://169.254.169.254/x", "https://evil.invalid/x", "https://fcm.googleapis.com.evil.invalid/x"]) {
    check((await request("/api/push/subscribe",a.token,"POST",{endpoint,keys})).status === 400, "unsafe endpoint rejected before storage");
  }
  check((await request("/api/push/subscribe",a.token,"POST",{endpoint:endpoints[0],keys:{p256dh:"wrong",auth:"wrong"}})).status === 400, "invalid encryption keys rejected");
  check((await pool.query("SELECT COUNT(*)::int AS n FROM letchat_push_subscriptions")).rows[0].n === 4, "rejected subscriptions create no rows");
  for (let i=0;i<6;i++) assert.equal((await request("/api/push/subscribe",a.token,"POST",{endpoint:`https://fcm.googleapis.com/wp/extra-${i}`,keys})).status,200);
  check((await request("/api/push/subscribe",a.token,"POST",{endpoint:"https://fcm.googleapis.com/wp/overflow",keys})).status === 409, "eleventh device is rejected");
  check((await request("/api/push/subscribe",a.token,"POST",{endpoint:endpoints[0],keys})).status === 200, "existing device refresh still works at the limit");
  check((await request("/api/push/subscribe",b.token,"POST",{endpoint:endpoints[0],keys})).status === 200, "same browser can switch accounts");
  check((await pool.query("SELECT user_id FROM letchat_push_subscriptions WHERE endpoint=$1",[endpoints[0]])).rows[0].user_id === b.user.id, "switched endpoint belongs only to the new account");
  await request("/api/push/subscribe",a.token,"DELETE",{endpoint:endpoints[0]});
  check((await pool.query("SELECT 1 FROM letchat_push_subscriptions WHERE endpoint=$1",[endpoints[0]])).rowCount === 1, "old account cannot unsubscribe the new owner");
  await request("/api/push/subscribe",b.token,"DELETE",{endpoint:endpoints[0]});
  check((await pool.query("SELECT 1 FROM letchat_push_subscriptions WHERE endpoint=$1",[endpoints[0]])).rowCount === 0, "owner can unsubscribe");
  // Avoid all external delivery: clear allowed subscriptions, retain only an
  // old invalid row to prove the send path rejects legacy data before network.
  await pool.query("DELETE FROM letchat_push_subscriptions");
  await pool.query("INSERT INTO letchat_push_subscriptions(endpoint,user_id,p256dh,auth) VALUES($1,$2,$3,$4)",["https://127.0.0.1:1/never-send",b.user.id,keys.p256dh,keys.auth]);
  check((await request("/api/private",a.token,"POST",{recipientId:b.user.id,body:"Test local de notification"})).status === 201, "normal private message remains functional");
  for(let i=0;i<30;i++) {
    if(!(await pool.query("SELECT 1 FROM letchat_push_subscriptions")).rowCount) break;
    await wait(20);
  }
  check((await pool.query("SELECT 1 FROM letchat_push_subscriptions")).rowCount === 0, "legacy unsafe subscription removed before delivery");
  await pool.query("INSERT INTO letchat_reports(reporter_id,reported_id,reason,details) VALUES($1,$2,'other','confidential-marker')",[a.user.id,b.user.id]);
  await request(`/api/blocks/${encodeURIComponent(b.user.id)}`,a.token,"POST");
  const exportB = await request("/api/account-export",b.token);
  check(exportB.status === 200 && exportB.json.reports.length === 0 && exportB.json.blocks.length === 0 && !exportB.data.includes("confidential-marker"), "previous report and block privacy fix is preserved");
  const exportA = await request("/api/account-export",a.token);
  check(exportA.status === 200 && exportA.json.reports.length === 1 && exportA.json.blocks.length === 1, "member retains their own reports and blocks");
  check(!logs.includes("Erreur serveur"), "no unexpected server error during the regression checks");
  console.log(`\n${assertions} priority regression checks passed in an isolated local database. No production account or external push delivery used.`);
} catch(error) { console.error(logs); console.error(error.stack || error.message); process.exitCode = 1; }
finally {
  for(const socket of sockets)socket.disconnect();
  if(child){child.kill("SIGTERM");await once(child,"exit").catch(()=>{});}
  await pool?.end(); await database?.stop().catch(()=>{}); await wait(100); await db?.close(); await rm(temporary,{recursive:true,force:true});
}

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
  child = spawn(process.execPath,["--import","./test/private-fault-injection.mjs","server.js"],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:connectionString,PORT:String(appPort),JWT_SECRET:secret,NODE_ENV:"test",STRIPE_SECRET_KEY:"",VAPID_PUBLIC_KEY:"",VAPID_PRIVATE_KEY:"",ADMIN_UID:"",ADMIN_EMAIL:""},stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",c=>{ logs+=c; }); child.stderr.on("data",c=>{ logs+=c; });
  let ready=false;
  for(let i=0;i<100;i++) { try { if((await request("/api/health")).status===200){ready=true;break;} }catch{} await wait(100); }
  assert.ok(ready,logs);
  const member = async username => {
    const r=await request("/api/auth/register",null,"POST",{username,password:"Isolated-password-123",age:30,city:"Montpellier"});
    assert.equal(r.status,201,r.data);
    assert.equal((await request("/api/rules-accept",r.json.token,"POST",{accepted:true})).status,200);
    return r.json;
  };
  const a=await member("Sender absent"), b=await member("Sender policies"), c=await member("Recipient member"), deleted=await member("Deleted member");
  const sg=await request("/api/auth/guest",null,"POST",{username:"Expired recipient",age:30,city:"Montpellier"});
  assert.equal(sg.status,201);
  await pool.query("UPDATE letchat_local_accounts SET expires_at=NOW()-INTERVAL '1 minute' WHERE user_id=$1",[sg.json.user.id]);
  const orphan="local:orphan-test";
  await pool.query("INSERT INTO profiles(user_id,email,display_name,region,department,city) VALUES($1,'','Orphan','','','Montpellier')",[orphan]);
  assert.equal((await request("/api/account",deleted.token,"DELETE",{confirmation:"SUPPRIMER"})).status,200);
  const rowCounts=async()=> (await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM letchat_private_messages) AS messages,
    (SELECT COUNT(*)::int FROM letchat_notifications) AS notifications,
    (SELECT COUNT(*)::int FROM letchat_conversation_preferences) AS preferences`)).rows[0];
  const sa=await openSocket(a.token), sc=await openSocket(c.token);
  const events=[];sa.on("private-message",m=>events.push(m));sc.on("private-message",m=>events.push(m));
  for(const [recipientId,status,label] of [["missing-user",404,"missing recipient"],[deleted.user.id,404,"deleted recipient"],[sg.json.user.id,410,"expired guest"],[orphan,410,"orphan local profile"]]) {
    const before=await rowCounts();
    const r=await request("/api/private",a.token,"POST",{recipientId,body:`Refused ${label}`});
    check(r.status===status,`${label}: explicit HTTP ${status}, got ${r.status}`);
    assert.match(r.json.error,/compte|destinataire/i);
    assert.deepEqual(await rowCounts(),before);
    check(true,`${label}: no message, notification or conversation created`);
  }
  await wait(50);
  check(events.length===0,"refused sends do not emit successful socket messages");
  const dm=await request("/api/private",b.token,"POST",{recipientId:c.user.id,body:"Bonjour à un membre existant"});
  check(dm.status===201,"normal member still receives private messages");
  check((await request(`/api/private/${b.user.id}`,c.token)).json.some(m=>m.id===dm.json.id),"recipient can reload the accepted message");
  await pool.query("UPDATE letchat_conversation_preferences SET muted=TRUE WHERE user_id=$1 AND other_id=$2",[c.user.id,b.user.id]);
  const mutedBefore=await rowCounts();
  check((await request("/api/private",b.token,"POST",{recipientId:c.user.id,body:"Conversation silencieuse"})).status===201,"muted conversations accept messages");
  check((await rowCounts()).notifications===mutedBefore.notifications,"muted conversation does not create notifications");
  for(const [policy,label] of [["nobody","recipient refuses all PMs"],["friends","recipient allows friends only"]]) {
    await pool.query("UPDATE profiles SET private_message_policy=$2 WHERE user_id=$1",[c.user.id,policy]);
    const before=await rowCounts();
    check((await request("/api/private",b.token,"POST",{recipientId:c.user.id,body:label})).status===403,label);
    assert.deepEqual(await rowCounts(),before);
  }
  await pool.query("UPDATE profiles SET private_message_policy='everyone' WHERE user_id=$1",[c.user.id]);
  await pool.query("INSERT INTO letchat_blocks(blocker_id,blocked_id) VALUES($1,$2)",[c.user.id,b.user.id]);
  const blockedBefore=await rowCounts();
  check((await request("/api/private",b.token,"POST",{recipientId:c.user.id,body:"Message bloqué"})).status===403,"block still prevents sending");
  assert.deepEqual(await rowCounts(),blockedBefore);
  await pool.query("DELETE FROM letchat_blocks");
  sc.disconnect();
  check((await request("/api/private",a.token,"POST",{recipientId:c.user.id,body:"Un membre hors ligne reste joignable"})).status===201,"offline permanent member remains a valid recipient");
  // Force a failure AFTER message and conversation writes to check rollback.
  const beforeFailure=await rowCounts(), beforeEvents=events.length;
  check((await request("/api/private",a.token,"POST",{recipientId:b.user.id,body:"atomic-failure-probe"})).status===500,"injected notification failure rejects the send");
  assert.deepEqual(await rowCounts(),beforeFailure);
  await wait(50);
  check(events.length===beforeEvents,"failed transaction emits no success event");
  check(true,"message, conversation and notification writes roll back together");
  await purgeExpiredGuests(pool,{to(){return this},in(){return this},emit(){},disconnectSockets(){}});
  check(!(await pool.query("SELECT 1 FROM profiles WHERE user_id=$1",[sg.json.user.id])).rowCount,"expired-guest cleanup still works");
  check(child.exitCode === null && child.signalCode === null && (await request("/api/health")).status === 200, "server remains responsive after the error scenario");
  console.log(`\n${assertions} private-message checks passed in an isolated local database.`);
} catch(error) { console.error(logs); console.error(error.stack || error.message); process.exitCode = 1; }
finally {
  for(const socket of sockets)socket.disconnect();
  if(child && child.exitCode === null && child.signalCode === null) {
    const exited=once(child,"exit"); child.kill("SIGTERM"); await exited.catch(()=>{});
  }
  await pool?.end();
  await database?.stop().catch(()=>{});
  await wait(100); await db?.close(); await rm(temporary,{recursive:true,force:true});
}

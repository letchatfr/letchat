import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const room = "rencontres-premium";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function nextEvent(socket, name) {
  return new Promise((resolve, reject) => {
    const listener = data => { clearTimeout(timer); resolve(data); };
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Missing ${name}`)); }, 4000);
    socket.once(name, listener);
  });
}
const liveEvent = (socket, name, payload) => new Promise((resolve, reject) => socket.timeout(4000).emit(name, payload, (error, data) => error ? reject(error) : resolve(data)));

export async function runPremiumRoomQA({origin, users, request, pool, check, sockets, connect}) {
  const [a,b,c] = users, [sa,sb,sc] = sockets;
  const subscribe = (user, status = "active", plan = "premium") => pool.query(`INSERT INTO letchat_subscriptions(user_id,status,plan,current_period_end)
    VALUES($1,$2,$3,NOW()+INTERVAL '1 day') ON CONFLICT(user_id) DO UPDATE SET status=EXCLUDED.status,plan=EXCLUDED.plan,current_period_end=EXCLUDED.current_period_end`, [user.user.id,status,plan]);
  const join = async (socket, target) => { const ready = nextEvent(socket,"presence"); socket.emit("join-room",target); await ready; };
  const denied = nextEvent(sc,"premium-room-denied"); sc.emit("join-room",room); await denied;
  check(true,"free member cannot join the new Premium room through Socket.IO");
  check((await request(`/api/messages?room=${room}`,c.token)).status===403,"free member cannot read the new room");
  check((await request('/api/messages',c.token,'POST',{room,body:'Forbidden'})).status===403,"free member cannot post to the new room");
  check(!(await liveEvent(sc,'live-join',{scope:`room:${room}`})).ok,"free member cannot join the new room video");
  await subscribe(a); await subscribe(b,"trialing","premium_plus");
  await join(sa,room); await join(sb,room);
  check((await request(`/api/messages?room=${room}`,a.token)).status===200,"active Premium subscription grants access");
  check((await request(`/api/messages?room=${room}`,b.token)).status===200,"valid Premium+ trial grants access");
  const freeMessages=[], freeActivity=[];
  sc.on("message", m=>freeMessages.push(m)); sc.on("room-activity", m=>freeActivity.push(m));
  const png=await sharp({create:{width:8,height:8,channels:3,background:"coral"}}).png().toBuffer();
  const delivered=nextEvent(sb,"message");
  const photo=await request('/api/messages',a.token,'POST',{room,body:'Bonjour les membres Premium',mediaBase64:png.toString('base64'),mediaType:'image/png'});
  check(photo.status===201&&(await delivered).room===room,"Premium members exchange messages in the correct room");
  check((await request(`/api/media/${photo.data.id}`,b.token)).status===200,"subscribers can fetch room photos");
  check((await request(`/api/media/${photo.data.id}`,c.token)).status===403,"direct media links remain protected from free accounts");
  check((await request(`/api/messages/public/${photo.data.id}/reactions`,c.token,'POST',{emoji:'👍'})).status===404,"free members cannot react to protected messages");
  check(!freeMessages.some(m=>m.room===room)&&!freeActivity.some(m=>m.room===room),"room content and activity are not broadcast to free accounts");
  check((await liveEvent(sa,'live-join',{scope:`room:${room}`})).ok,"subscriber can enter the new room video");
  check((await liveEvent(sb,'live-join',{scope:`room:${room}`})).peers.length===1,"second subscriber joins the same room video");
  const otherTab=await connect(a); await wait(80); await join(otherTab,"entraide");
  const revocations=new Set();
  sa.on('premium-room-revoked',()=>revocations.add(sa.id));
  otherTab.on('premium-room-revoked',()=>revocations.add(otherTab.id));
  await pool.query("UPDATE letchat_subscriptions SET current_period_end=NOW()-INTERVAL '1 second' WHERE user_id=$1",[a.user.id]);
  check((await request(`/api/messages?room=${room}`,a.token)).status===403,"expired subscription loses read access");
  check((await request(`/api/media/${photo.data.id}`,a.token)).status===403,"expired subscription loses media access");
  check((await request('/api/messages',a.token,'POST',{room,body:'Expired'})).status===403,"expired subscription cannot post");
  check(!(await liveEvent(sa,'live-signal',{target:sb.id,data:{type:'offer',sdp:'expired'}})).ok,"expired subscription cannot relay video signalling");
  check((await request('/api/messages',b.token,'POST',{room,body:'Test du retrait des accès'})).status===201,"valid subscriber can still post after another subscription expires");
  for(let i=0;i<60&&revocations.size<2;i++) await wait(25);
  check(revocations.size===2,"expiration removes all tabs from both adult Premium rooms");
  await subscribe(a);
  check((await request('/api/messages?room=entraide',a.token)).status===200&&(await request('/api/messages?room=entraide',c.token)).status===403,"existing XXX room keeps its Premium restriction");
  await subscribe(a,"past_due");
  check((await request(`/api/messages?room=${room}`,a.token)).status===403,"unpaid subscription cannot enter the new room");
  if(process.env.LETCHAT_PREMIUM_BROWSER==='1') await browserQA({origin,user:c,subscribe,check});
  for(const s of [...sockets,otherTab]) { s.emit('live-leave'); s.emit('join-room','cafe'); }
  await pool.query("DELETE FROM letchat_subscriptions WHERE user_id=ANY($1::text[])",[[a.user.id,b.user.id,c.user.id]]);
  await wait(100);
}

async function browserQA({origin,user,subscribe,check}) {
  const require=createRequire(import.meta.url);
  const {chromium}=require(require.resolve('playwright',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||process.cwd()]}));
  const custom=process.env.LETCHAT_CHROMIUM_MODULE?(await import(process.env.LETCHAT_CHROMIUM_MODULE)).default:null;
  const browser=await chromium.launch({headless:true,...(custom?{executablePath:await custom.executablePath()}:{channel:'chromium'}),args:[...(custom?.args||[]).filter(a=>!['--single-process','--disable-web-security','--allow-running-insecure-content'].includes(a)),'--no-sandbox']});
  const output=process.env.LETCHAT_QA_OUTPUT||'/tmp/letchat-premium-qa'; await mkdir(output,{recursive:true});
  const context=await browser.newContext({viewport:{width:1365,height:900},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const firebase=`export const initializeApp=()=>({});export const getAuth=()=>({currentUser:null});export class GoogleAuthProvider{setCustomParameters(){}}
    export const browserLocalPersistence={};export const setPersistence=async()=>{};export const getRedirectResult=async()=>null;
    export const onAuthStateChanged=(a,cb)=>{setTimeout(()=>cb(null),0);return ()=>{}};export const signInWithPopup=async()=>{};
    export const signInWithRedirect=async()=>{};export const signOut=async()=>{};export const deleteUser=async()=>{};`;
  await page.route('https://www.gstatic.com/firebasejs/**',r=>r.fulfill({status:200,contentType:'text/javascript',body:firebase}));
  await page.addInitScript(token=>localStorage.setItem('letchatLocalToken',token),user.token);
  try {
    await page.goto(origin,{waitUntil:'networkidle'});
    await page.waitForFunction(()=>document.querySelector('#connectionStatus')?.dataset.state==='online');
    const link=page.locator(`.room[data-room="${room}"]`);
    assert.equal(await link.locator('xpath=ancestor::details').locator('summary').textContent(),'Espace adulte');
    await link.click(); await page.locator('#premiumRoomGate').waitFor({state:'visible'});
    check(true,"free account sees the Premium offer when clicking the new room");
    await page.locator('#closePremiumRoomGate').click();
    await subscribe(user); await link.click(); await page.locator('#adultRoomWarning').waitFor({state:'visible'});
    await page.locator('#enterAdultRoom').click();
    await page.locator('.chat > header h1').filter({hasText:'Rencontres privées'}).waitFor();
    await page.locator('#input').fill('Mon premier message dans Rencontres privées');await page.locator('#send').click();
    await page.locator('#messages').getByText('Mon premier message dans Rencontres privées',{exact:true}).waitFor();
    check(true,"subscriber enters from the menu and posts through the browser");
    await page.screenshot({path:output+'/premium-desktop.png'});
    await page.setViewportSize({width:390,height:844});await page.locator('#mobileNavRooms').click();
    await link.scrollIntoViewIfNeeded();await link.waitFor({state:'visible'});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"new room is available on mobile without horizontal page overflow");
    await page.screenshot({path:output+'/premium-mobile.png'});
    check(errors.length===0,`no browser runtime errors: ${errors.join('; ')}`);
  } catch(error) { await page.screenshot({path:output+'/failure.png'}).catch(()=>{});throw error; }
  finally { await browser.close(); }
}

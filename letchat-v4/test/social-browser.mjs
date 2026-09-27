import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import sharp from "sharp";

export async function runBrowserQA({origin,users,request,check}) {
  const require=createRequire(import.meta.url);
  const {chromium}=require(require.resolve('playwright',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||process.cwd()]}));
  const custom = process.env.LETCHAT_CHROMIUM_MODULE ? (await import(process.env.LETCHAT_CHROMIUM_MODULE)).default : null;
  const browser=await chromium.launch({headless:true,...(custom?{executablePath:await custom.executablePath()}:{channel:'chromium'}),args:[...(custom?.args||[]).filter(a=>!['--single-process','--disable-web-security','--allow-running-insecure-content'].includes(a)),'--no-sandbox','--allow-loopback-in-peer-connection','--disable-features=WebRtcHideLocalIpsWithMdns','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
  const pages=[], errors=[];const output=process.env.LETCHAT_QA_OUTPUT||'/tmp/letchat-social-qa';await mkdir(output,{recursive:true});
  const firebase=`export const initializeApp=()=>({}); export const getAuth=()=>({currentUser:null});
    export class GoogleAuthProvider {setCustomParameters(){}}; export const browserLocalPersistence={};
    export const setPersistence=async()=>{}; export const getRedirectResult=async()=>null;
    export const onAuthStateChanged=(a,cb)=>{setTimeout(()=>cb(null),0);return ()=>{}};
    export const signInWithPopup=async()=>{};export const signInWithRedirect=async()=>{};export const signOut=async()=>{};export const deleteUser=async()=>{};`;
  try {
    for(let i=0;i<4;i++) {
      const context=await browser.newContext({viewport:i===3?{width:390,height:844}:{width:1365,height:900},permissions:['camera','microphone'],serviceWorkers:'block'});
      const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));
      await page.route('https://www.gstatic.com/firebasejs/**',route=>route.fulfill({status:200,contentType:'text/javascript',body:firebase}));
      // Local WebRTC exercises direct browser media. Production uses the existing Metered TURN endpoint.
      await page.route('**/api/turn-credentials',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify([{urls:'stun:stun.l.google.com:19302'}])}));
      await page.addInitScript(token=>{
        localStorage.setItem('letchatLocalToken',token);localStorage.setItem('letchat-theme','light');
        window.__pcs=[];const PC=window.RTCPeerConnection;window.RTCPeerConnection=class extends PC {constructor(...args){super(...args);window.__pcs.push(this);}};
      },users[i].token);
      await page.goto(origin,{waitUntil:'networkidle'});
      await page.locator('.social-toolbar').waitFor({state:'visible'});
      await page.waitForFunction(()=>document.querySelector('#connectionStatus')?.dataset.state==='online'||document.querySelector('#onlineCount')?.textContent==='5');
      if(await page.locator('#profileModal').isVisible())await page.locator('#closeProfile').click();
    }
    const [a,b,c,d]=pages;
    for(let i=0;i<pages.length;i++) assert.equal(await pages[i].locator('#meName').textContent(),users[i].user.name,'independent browser identities');
    check(errors.length===0,`client starts without JavaScript errors: ${errors.join('; ')}`);
    await a.locator('[data-groups]').click();await a.locator('[data-new-group]').click();
    await a.locator('[data-create-group] input[name=name]').fill('Groupe de démonstration');
    for(const user of [users[1],users[2]]) await a.locator(`[data-create-group] input[name=members][value="${user.user.id}"]`).check();
    await a.locator('[data-create-group] button[type=submit]').click();
    await a.locator('[data-group-form]').waitFor();
    const group=(await request('/api/social/groups',users[0].token)).data.find(g=>g.name==='Groupe de démonstration');assert.ok(group);
    await b.locator('[data-groups]').click();await b.locator(`[data-group="${group.id}"]`).click();await b.locator('[data-accept-group]').click();await b.locator('[data-group-form]').waitFor();
    await a.locator('[data-group-form] textarea').fill('Bienvenue dans notre groupe !');await a.locator('[data-group-form] button[type=submit]').click();
    await b.locator('[data-group-messages]').getByText('Bienvenue dans notre groupe !',{exact:true}).waitFor();
    check(true,'two browser sessions exchange group messages in real time');
    const png=await sharp({create:{width:300,height:140,channels:3,background:'#ed8d78'}}).png().toBuffer();
    await a.locator('[data-group-file]').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:png});
    await b.waitForFunction(()=>document.querySelector('[data-group-messages] img')?.naturalWidth>0);
    check(true,'group photo uploads and displays in a second browser');
    await a.locator('[data-group-voice]').click();await a.locator('[data-record]').click();await a.waitForTimeout(1200);await a.locator('[data-stop]').click();
    await a.locator('[data-use]').waitFor({state:'visible'});
    check((await request(`/api/social/groups/${group.id}/messages`,users[0].token)).data.filter(m=>m.media_type?.startsWith('audio/')).length===0,'voice preview does not send automatically');
    await a.locator('[data-use]').click();await b.locator('[data-group-messages] audio').waitFor();
    check(true,'recorded browser audio is accepted and delivered');
    await b.screenshot({path:output+'/group-desktop.png'});
    await a.locator('.social-groups [data-close]').click();await b.locator('.social-groups [data-close]').click();
    await a.locator(`.person-button[data-user-id="${users[2].user.id}"]`).first().click();
    await a.locator('[data-games]').click();
    check(await a.locator('[data-create-game] select[name=members]').inputValue()===users[2].user.id,'game challenge preselects the current private conversation');
    await a.locator('[data-create-game] select[name=kind]').selectOption('connect4');await a.locator('[data-create-game] button[type=submit]').click();
    await a.locator('.social-game-status').filter({hasText:'En attente'}).waitFor();
    const game=(await request('/api/social/games',users[2].token)).data.find(g=>g.creator_id===users[0].user.id&&g.status==='pending');assert.ok(game);
    await c.locator('[data-games]').click();await c.locator(`[data-game="${game.id}"]`).click();await c.locator('[data-action=accept]').click();
    await a.locator('.social-game-status').filter({hasText:'À vous'}).waitFor();await a.locator('[data-move="2"]').first().click();
    await c.locator('.social-game-status').filter({hasText:'À vous'}).waitFor();
    check(true,'game invitation, acceptance and synchronized turns work in browsers');
    await a.locator('#input').fill('À toi de jouer !');await a.locator('#send').click();
    await a.locator('#messages').getByText('À toi de jouer !',{exact:true}).waitFor();
    check(true,'private messages remain usable while the game is open');
    await a.screenshot({path:output+'/game-desktop.png'});
    await a.locator('.social-games [data-close]').click();await c.locator('.social-games [data-close]').click();
    await a.locator('#voiceBtn').click();await a.locator('[data-record]').click();await a.waitForTimeout(1100);await a.locator('[data-stop]').click();await a.locator('[data-use]').click();
    await a.locator('#messages audio').waitFor();
    check(true,'the existing private conversation sends a voice recording after confirmation');
    await a.locator('.room[data-room=cafe]').click();
    await a.locator('#profileBtn').click();await a.locator('.social-rich-button').click();
    await a.locator('[data-rich-profile] textarea[name=character]').fill('Curieux et toujours partant pour discuter');
    await a.locator('[data-rich-profile] select[name=visibility]').selectOption('public');
    await a.locator('[data-rich-profile] input[name=cover]').setInputFiles({name:'couverture.png',mimeType:'image/png',buffer:png});
    await a.locator('[data-profile-voice]').click();await a.locator('[data-record]').click();await a.waitForTimeout(1200);await a.locator('[data-stop]').click();await a.locator('[data-use]').click();
    await a.locator('[data-rich-profile] button[type=submit]').click();await a.locator('[data-rich-profile] [data-status]').filter({hasText:'enregistré'}).waitFor();
    check((await request(`/api/social/profile/${users[0].user.id}`,users[2].token)).data.voice===true,'profile cover and recorded introduction persist');
    await a.screenshot({path:output+'/profile-desktop.png'});
    await a.locator('.social-profile [data-close]').click();await a.locator('#closeProfile').click();
    // Four actual RTCPeerConnections across independent browser contexts; fake cameras produce media.
    for(const p of pages)await p.locator('[data-live]').click();
    for(const p of pages)await p.waitForFunction(()=>document.querySelectorAll('.social-video').length===4);
    for(const p of pages) {await p.locator('[data-camera]').click();await p.locator('[data-mic]').click();await p.locator('[data-mic]').filter({hasText:'Couper mon micro'}).waitFor();}
    for(const p of pages) await p.waitForFunction(() => window.__pcs.filter(pc=>pc.connectionState==='connected').length===3,null,{timeout:25000});
    for(const p of pages) await p.waitForFunction(()=>[...document.querySelectorAll('.social-video video')].filter(v=>!v.muted).every(v=>v.videoWidth>0&&!v.paused&&v.readyState>=2),null,{timeout:12000});
    check(true,'remote cameras render visible video in all four browsers');
    for(const p of pages) await p.waitForFunction(()=>window.__pcs.filter(pc=>pc.connectionState==='connected').every(pc=>pc.getReceivers().every(r=>!r.track.muted)),null,{timeout:10000});
    for(const p of pages) assert.ok(await p.evaluate(async()=>{
      const stats=await Promise.all(window.__pcs.filter(pc=>pc.connectionState==='connected').map(pc=>pc.getStats()));
      return stats.length===3 && stats.every(s=>['video','audio'].every(kind=>[...s.values()].some(v=>v.type==='inbound-rtp'&&v.kind===kind&&v.bytesReceived>0)));
    }), 'each peer receives both audio and video');
    check(true,'four-browser mesh receives audio and video from three peers per participant');
    await a.locator('.social-video button').nth(1).click();
    check(await a.locator('.social-video.focused').count()===1,'individual camera can be enlarged');
    await a.screenshot({path:output+'/live-desktop.png'});await d.screenshot({path:output+'/live-mobile.png'});
    await d.evaluate(()=>window.__lastVideoTrack=document.querySelector('.social-video video').srcObject.getVideoTracks()[0]);
    await d.locator('[data-camera]').click();
    await a.locator('.social-video.camera-off').filter({hasText:'David Social'}).waitFor();
    check(await d.evaluate(()=>window.__lastVideoTrack.readyState==='ended'),'camera off stops capture and hides the remote picture');
    await d.locator('.social-live [data-close]').click();
    await a.waitForFunction(()=>document.querySelectorAll('.social-video').length===3);
    check(await d.evaluate(()=>window.__pcs.every(pc=>pc.connectionState==='closed')),'leaving closes all peer connections');
    for(const p of [a,b,c])await p.locator('.social-live [data-close]').click();
    await d.evaluate(()=>document.documentElement.dataset.theme='dark');await d.locator('[data-groups]').click();await d.locator('[data-new-group]').click();
    check(await d.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile page has no horizontal overflow');
    await d.screenshot({path:output+'/group-mobile-dark.png'});
    check(errors.length===0,`no client runtime exceptions across scenarios: ${errors.join('; ')}`);
  } catch(error) {
    const diagnostics = await Promise.all(pages.map(p => p.evaluate(() => ({
      name: document.querySelector('#meName')?.textContent,
      videos: [...document.querySelectorAll('.social-video video')].map(v => ({
        muted:v.muted, width:v.videoWidth, paused:v.paused, time:v.currentTime,
        tracks:v.srcObject?.getTracks().map(t => ({kind:t.kind,muted:t.muted,state:t.readyState,id:t.id}))
      })),
      pcs: window.__pcs.map(pc => ({state:pc.connectionState,ice:pc.iceConnectionState,gathering:pc.iceGatheringState,candidates:pc.localDescription?.sdp.split('\r\n').filter(l=>l.startsWith('a=candidate:')),transceivers:pc.getTransceivers().map(t => ({mid:t.mid,direction:t.currentDirection,kind:t.receiver.track.kind,muted:t.receiver.track.muted}))}))
    })).catch(() => null)));
    console.log('Browser diagnostics',JSON.stringify(diagnostics));
    for(let i=0;i<pages.length;i++) await pages[i].screenshot({path:`${output}/failure-${i}.png`}).catch(()=>{});
    throw error;
  } finally { await browser.close(); }
}

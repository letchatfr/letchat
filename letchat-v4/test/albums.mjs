import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

export async function runAlbumQA({ origin, users, request, pool, check }) {
  const [a,b,c,d,e] = users, route = `/api/social/albums/${a.user.id}`;
  const png = await sharp({create:{width:1800,height:1200,channels:3,background:"#eaa18b"}}).withMetadata({exif:{IFD0:{Artist:"Private camera metadata"}}}).png().toBuffer();
  const body = {mediaBase64:png.toString("base64"),mediaType:"image/png"};
  check((await request(route)).status===401,"anonymous visitors cannot list album photos");
  check((await request('/api/social/albums',null,'POST',body)).status===401,"anonymous uploads rejected");
  check((await request('/api/social/albums/missing',a.token)).status===404,"unknown album owner returns 404");
  check((await request(route,c.token)).data.photos.length===0,"non-friend can open an empty album without requesting access");
  check((await request('/api/social/albums',a.token,'POST',{})).status===415,"missing photo rejected");
  check((await request('/api/social/albums',a.token,'POST',{mediaBase64:Buffer.from('<svg onload="evil()"/>').toString('base64'),mediaType:'image/svg+xml'})).status===415,"active SVG content rejected");
  const wav=Buffer.alloc(48);wav.write('RIFF',0);wav.writeUInt32LE(40,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4,40);
  check((await request('/api/social/albums',a.token,'POST',{mediaBase64:wav.toString('base64'),mediaType:'audio/wav'})).status===415,"audio cannot be uploaded as an album photo");
  const created=await request('/api/social/albums',a.token,'POST',body);check(created.status===201,"owner uploads photo");const id=created.data.id;
  check((await request(route,c.token)).data.photos[0].id===id,"non-friend sees photo immediately without invitation or Premium");
  check((await request(`/api/social/profile/${a.user.id}`,c.token)).data.restricted===true,"album visibility does not change friends-only rich profile");
  check((await request(`${route}/${id}/image`)).status===401,"direct photo URL requires authentication");
  check((await request(`/api/social/albums/${b.user.id}/${id}/image`,c.token)).status===404,"photo cannot be fetched under a different owner's URL");
  check((await request(`${route}/${id}/invalid`,c.token)).status===404,"unknown image variant rejected");
  const full=await fetch(origin+`${route}/${id}/image`,{headers:{Authorization:`Bearer ${c.token}`}}),fullBuffer=Buffer.from(await full.arrayBuffer());
  const meta=await sharp(fullBuffer).metadata();
  check(full.status===200&&meta.width===1600&&!meta.exif&&full.headers.get('content-type').includes('image/webp'),"image is resized, converted to WebP and stripped of private metadata");
  check(full.headers.get('cache-control').includes('no-store'),"authenticated photo response is not cached");
  const thumb=await fetch(origin+`${route}/${id}/thumbnail`,{headers:{Authorization:`Bearer ${c.token}`}}),thumbMeta=await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
  check(thumbMeta.width<=400&&thumbMeta.height<=400,"profile uses small thumbnails");
  check((await request(`/api/social/albums/${id}`,c.token,'DELETE')).status===404,"another member cannot delete owner's photo");
  await request(`/api/blocks/${c.user.id}`,a.token,'POST');
  check((await request(route,c.token)).status===403&&(await request(`${route}/${id}/image`,c.token)).status===403&&(await request(`${route}/${id}/thumbnail`,c.token)).status===403,"owner block hides album, full images and thumbnails");
  check((await request(route,a.token)).status===200,"owner still sees their own album");
  await request(`/api/blocks/${c.user.id}`,a.token,'DELETE');await request(`/api/blocks/${a.user.id}`,c.token,'POST');
  check((await request(route,c.token)).status===403,"viewer-side block also hides the album");
  await request(`/api/blocks/${a.user.id}`,c.token,'DELETE');
  await pool.query('DELETE FROM letchat_age_consents WHERE user_id=$1',[d.user.id]);
  check((await request(route,d.token)).status===403&&(await request(`${route}/${id}/image`,d.token)).status===403,"age gate applies to listing and direct photo reads");
  await pool.query('INSERT INTO letchat_age_consents(user_id,over_18) VALUES($1,TRUE)',[d.user.id]);
  const tiny=await sharp({create:{width:8,height:8,channels:3,background:"#599ea6"}}).png().toBuffer(),smallBody={mediaBase64:tiny.toString('base64'),mediaType:'image/png'};
  for(let i=0;i<10;i++) assert.equal((await request('/api/social/albums',a.token,'POST',smallBody)).status,201);
  const racing=await Promise.all([1,2].map(()=>request('/api/social/albums',a.token,'POST',smallBody)));
  check(racing.filter(r=>r.status===201).length===1&&racing.filter(r=>r.status===409).length===1&&(await request(route,c.token)).data.photos.length===12,"concurrent uploads respect the twelve-photo cap");
  check((await request('/api/account-export',a.token)).data.social.album.length===12,"data export lists album photo metadata");
  check((await request(`/api/social/albums/${id}`,a.token,'DELETE')).status===200,"owner deletes a photo");
  check((await request(`${route}/${id}/image`,c.token)).status===404&&(await request(`${route}/${id}/thumbnail`,c.token)).status===404,"deleted image and thumbnail cannot be fetched");
  check((await request('/api/social/albums',a.token,'POST',smallBody)).status===201,"deleting a photo frees an album slot");
  if(process.env.LETCHAT_ALBUM_BROWSER==='1') await browserQA({origin,owner:e,viewer:c,request,check,png});
}

async function browserQA({origin,owner,viewer,request,check,png}) {
  const require=createRequire(import.meta.url);
  const {chromium}=require(require.resolve('playwright',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||process.cwd()]}));
  const custom=process.env.LETCHAT_CHROMIUM_MODULE?(await import(process.env.LETCHAT_CHROMIUM_MODULE)).default:null;
  const browser=await chromium.launch({headless:true,...(custom?{executablePath:await custom.executablePath()}:{channel:'chromium'}),args:[...(custom?.args||[]).filter(a=>!['--single-process','--disable-web-security','--allow-running-insecure-content'].includes(a)),'--no-sandbox']});
  const output=process.env.LETCHAT_QA_OUTPUT||'/tmp/letchat-album-qa';await mkdir(output,{recursive:true});const pages=[],errors=[];
  const firebase=`export const initializeApp=()=>({});export const getAuth=()=>({currentUser:null});export class GoogleAuthProvider{setCustomParameters(){}}
    export const browserLocalPersistence={};export const setPersistence=async()=>{};export const getRedirectResult=async()=>null;
    export const onAuthStateChanged=(a,cb)=>{setTimeout(()=>cb(null),0);return ()=>{}};export const signInWithPopup=async()=>{};
    export const signInWithRedirect=async()=>{};export const signOut=async()=>{};export const deleteUser=async()=>{};`;
  try {
    for(const user of [owner,viewer]) {
      const context=await browser.newContext({viewport:{width:1365,height:900},serviceWorkers:'block'}),page=await context.newPage();pages.push(page);
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('https://www.gstatic.com/firebasejs/**',r=>r.fulfill({status:200,contentType:'text/javascript',body:firebase}));
      await page.addInitScript(token=>{localStorage.setItem('letchatLocalToken',token);localStorage.setItem('letchat-theme','light');},user.token);
      await page.goto(origin,{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#connectionStatus')?.dataset.state==='online');
      if(await page.locator('#profileModal').isVisible())await page.locator('#closeProfile').click();
    }
    const [editor,reader]=pages;
    await editor.locator('#profileBtn').click();await editor.locator('.social-album-button').click();
    await editor.locator('.social-album-empty').filter({hasText:'Votre album est vide'}).waitFor();
    check(true,"owner finds album manager in their profile");
    const second=await sharp({create:{width:900,height:1400,channels:3,background:'#57989a'}}).png().toBuffer();
    await editor.locator('.social-album-manager input[type=file]').setInputFiles([{name:'vacances.png',mimeType:'image/png',buffer:png},{name:'portrait.png',mimeType:'image/png',buffer:second}]);
    await editor.waitForFunction(()=>document.querySelectorAll('.social-album-manager .social-album-card').length===2&&[...document.querySelectorAll('.social-album-manager img')].every(img=>img.naturalWidth>0));
    check(true,"multiple photo upload shows two thumbnails and updated count");
    await editor.screenshot({path:output+'/album-manager-desktop.png'});
    const readProfile=async()=>{
      if(await reader.locator('#publicProfileModal').isVisible())await reader.locator('#closePublicProfile').click();
      await reader.locator(`.person-button[data-user-id="${owner.user.id}"]`).first().click();await reader.locator('#privateProfileBtn').click();
      await reader.locator('.social-album-public h3').filter({hasText:'Album photo'}).waitFor();
    };
    await readProfile();
    await reader.waitForFunction(()=>document.querySelectorAll('.social-album-public img').length===2&&[...document.querySelectorAll('.social-album-public img')].every(img=>img.naturalWidth>0));
    check(true,"another member sees photos directly on the profile without any approval step");
    await reader.screenshot({path:output+'/album-profile-desktop.png'});
    await reader.locator('.social-album-public .social-album-thumb').first().click();
    await reader.waitForFunction(()=>document.querySelector('.social-album-viewer img')?.naturalWidth===1600);
    await reader.locator('.social-album-viewer [data-next]').click();
    await reader.waitForFunction(()=>document.querySelector('.social-album-viewer img')?.naturalHeight===1400);
    await reader.keyboard.press('ArrowLeft');await reader.locator('.social-album-viewer h2').filter({hasText:'Photo 1 sur 2'}).waitFor();
    await reader.keyboard.press('ArrowRight');await reader.locator('.social-album-viewer h2').filter({hasText:'Photo 2 sur 2'}).waitFor();
    check(true,"full-size viewer supports next, previous and keyboard navigation");
    await reader.keyboard.press('Escape');await reader.locator('.social-album-viewer').waitFor({state:'hidden'});
    check(await reader.locator('#publicProfileModal').isVisible(),"Escape closes only the photo viewer and keeps the profile open");
    await reader.setViewportSize({width:390,height:844});
    await reader.locator('.social-album-public').scrollIntoViewIfNeeded();
    check(await reader.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.public-profile-card').scrollWidth<=document.querySelector('.public-profile-card').clientWidth),"profile album fits mobile without horizontal overflow");
    await reader.screenshot({path:output+'/album-profile-mobile.png'});
    await reader.locator('.social-album-public .social-album-thumb').last().click();
    await reader.waitForFunction(()=>document.querySelector('.social-album-viewer img')?.naturalHeight===1400);
    check(await reader.locator('.social-album-viewer').evaluate(el=>el.scrollWidth<=el.clientWidth),"full-size viewer fits mobile");
    await reader.screenshot({path:output+'/album-viewer-mobile.png'});await reader.keyboard.press('Escape');
    await editor.setViewportSize({width:390,height:844});
    await editor.locator('.social-album-manager').waitFor({state:'visible'});
    await editor.evaluate(()=>document.documentElement.dataset.theme='dark');
    await editor.waitForFunction(()=>getComputedStyle(document.querySelector('.social-album-delete')).backgroundColor===getComputedStyle(document.querySelector('.social-album-manager')).backgroundColor);
    await editor.screenshot({path:output+'/album-manager-mobile-dark.png'});
    check(await editor.locator('.social-album-manager').evaluate(el=>el.scrollWidth<=el.clientWidth),"album manager fits mobile in dark mode");
    editor.once('dialog',dialog=>dialog.accept());await editor.locator('.social-album-delete').first().click();
    await editor.waitForFunction(()=>document.querySelectorAll('.social-album-manager .social-album-card').length===1);
    check((await request(`/api/social/albums/${owner.user.id}`,viewer.token)).data.photos.length===1,"delete button removes selected photo for everyone");
    await reader.setViewportSize({width:1365,height:900});await readProfile();
    await reader.waitForFunction(()=>document.querySelectorAll('.social-album-public .social-album-card').length===1);
    check(true,"reopened profile reflects photo deletion");
    await editor.locator('.social-album-manager [data-close]').click();await editor.locator('.social-album-button').click();
    await editor.waitForFunction(()=>document.querySelectorAll('.social-album-manager img').length===1&&document.querySelector('.social-album-manager img')?.naturalWidth>0);
    check(true,"reopening own album restores thumbnails after cleanup");
    check(errors.length===0,`no browser runtime errors: ${errors.join('; ')}`);
  } catch(error) { for(let i=0;i<pages.length;i++)await pages[i].screenshot({path:`${output}/failure-${i}.png`}).catch(()=>{});throw error; }
  finally {await browser.close();}
}

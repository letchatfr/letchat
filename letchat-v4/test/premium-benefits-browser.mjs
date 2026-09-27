import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdir} from "node:fs/promises";
import sharp from "sharp";

export async function runPremiumBenefitsBrowserQA({origin,users,request,pool,check,subscribe}) {
  const [a,,c]=users, require=createRequire(import.meta.url);
  const {chromium}=require(require.resolve('playwright',{paths:[process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES||process.cwd()]}));
  const custom=process.env.LETCHAT_CHROMIUM_MODULE?(await import(process.env.LETCHAT_CHROMIUM_MODULE)).default:null;
  const browser=await chromium.launch({headless:true,...(custom?{executablePath:await custom.executablePath()}:{channel:'chromium'}),args:[...(custom?.args||[]).filter(a=>!['--single-process','--disable-web-security','--allow-running-insecure-content'].includes(a)),'--no-sandbox']});
  const output=process.env.LETCHAT_QA_OUTPUT||'/tmp/letchat-premium-benefits-qa';await mkdir(output,{recursive:true});const pages=[],errors=[];
  const firebase=`export const initializeApp=()=>({});export const getAuth=()=>({currentUser:null});export class GoogleAuthProvider{setCustomParameters(){}}
    export const browserLocalPersistence={};export const setPersistence=async()=>{};export const getRedirectResult=async()=>null;
    export const onAuthStateChanged=(a,cb)=>{setTimeout(()=>cb(null),0);return ()=>{}};export const signInWithPopup=async()=>{};
    export const signInWithRedirect=async()=>{};export const signOut=async()=>{};export const deleteUser=async()=>{};`;
  try {
    for(const user of [a,c]){
      const context=await browser.newContext({viewport:{width:1365,height:1000},serviceWorkers:'block'}),page=await context.newPage();pages.push(page);
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('https://www.gstatic.com/firebasejs/**',r=>r.fulfill({status:200,contentType:'text/javascript',body:firebase}));
      await page.addInitScript(token=>{localStorage.setItem('letchatLocalToken',token);localStorage.setItem('letchat-theme','light');},user.token);
      await page.goto(origin,{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#connectionStatus')?.dataset.state==='online');
      if(await page.locator('#profileModal').isVisible())await page.locator('#closeProfile').click();
    }
    const [paid,free]=pages;
    await free.locator('#profileBtn').click();await free.locator('#premiumPerksBtn').click();
    await free.locator('.premium-settings [data-upgrade]').waitFor();
    check(await free.locator('.premium-settings .premium-offer li').count()===5,"free account sees the five Premium benefits and upgrade entry");
    await free.keyboard.press('Escape');check(await free.locator('#profileModal').isVisible(),"closing Premium dialog keeps profile open");await free.locator('#closeProfile').click();
    await paid.locator('#profileBtn').click();await paid.locator('#premiumPerksBtn').click();
    const form=paid.locator('.premium-settings-form');await form.waitFor();
    await form.locator('[name=accent]').selectOption('blue');await form.locator('[name=frame]').selectOption('gold');await form.locator('[name=badge]').check();
    check(await paid.locator('[data-preview-name]').getAttribute('data-premium-accent')==='blue',"appearance preview changes before saving");
    await form.locator('[type=submit]').click();await form.locator('[data-status]').filter({hasText:'enregistrées'}).waitFor();
    await free.waitForFunction(id=>[...document.querySelectorAll(`button[data-private-user="${id}"]`)].some(el=>el.dataset.premiumAccent==='blue'&&el.querySelector('.premium-member-badge')),a.user.id);
    check(true,"second browser sees saved Premium color and badge without reload");
    await paid.screenshot({path:output+'/premium-settings-desktop.png'});
    await free.locator(`.person-button[data-user-id="${a.user.id}"]`).first().click();await free.locator('#privateProfileBtn').click();
    await free.locator('#publicProfileName .premium-member-badge').waitFor();
    await form.locator('[name=discreet]').check();await form.locator('[type=submit]').click();
    await free.locator('#publicProfileLastSeen').filter({hasText:'Masquée'}).waitFor();
    check(await free.locator('#publicProfileStatus').textContent()==='Présence masquée',"discreet mode masks an already-open profile in another browser");
    await free.locator('#closePublicProfile').click();await free.locator('#onlineMembersLink').click();
    await free.waitForFunction(id=>![...document.querySelectorAll('[data-online-profile]')].some(el=>el.dataset.onlineProfile===id),a.user.id);
    check(true,"discreet subscriber disappears from the online member directory");
    await free.locator('#onlineMembersModal .premium-search-button').click();await free.locator('.premium-search [data-upgrade]').waitFor();
    check(true,"advanced search shows the Premium offer to a free account");await free.locator('.premium-search [data-close]').click();await free.locator('#closeOnlineMembers').click();
    await form.locator('[name=discreet]').uncheck();await form.locator('[type=submit]').click();
    await paid.waitForFunction(()=>document.querySelector('#premiumDiscreetState')?.hidden===true);
    await paid.locator('.premium-settings [data-close]').click();await paid.locator('.social-album-button').click();
    await paid.locator('.social-album-manager [data-count]').filter({hasText:'/ 36'}).waitFor();
    const png=await sharp({create:{width:220,height:160,channels:3,background:'#779fc6'}}).png().toBuffer();
    const before=(await request(`/api/social/albums/${a.user.id}`,a.token)).data.photos.length;
    await paid.locator('.social-album-manager input[type=file]').setInputFiles(Array.from({length:13},(_,i)=>({name:`photo-${i+1}.png`,mimeType:'image/png',buffer:png})));
    await paid.waitForFunction(count=>document.querySelectorAll('.social-album-manager .social-album-card').length===count,before+13);
    check(true,"Premium browser uploads a batch of thirteen photos, beyond the free quota");
    await paid.locator('.social-album-manager [data-close]').click();await paid.locator('#closeProfile').click();
    await paid.locator('[data-groups]').click();await paid.locator('[data-new-group]').click();
    await paid.locator('.social-invite-field legend').filter({hasText:'19 personnes'}).waitFor();
    check(true,"group creator displays nineteen invitation slots for Premium");await paid.locator('.social-groups [data-close]').click();
    await free.locator('[data-groups]').click();await free.locator('[data-new-group]').click();await free.locator('.social-invite-field legend').filter({hasText:'7 personnes'}).waitFor();
    check(true,"free group creator retains seven invitation slots");await free.locator('.social-groups [data-close]').click();
    await paid.locator('#onlineMembersLink').click();await paid.locator('#onlineMembersModal .premium-search-button').click();
    const search=paid.locator('.premium-search-form');await search.waitFor();
    await search.locator('[name=city]').fill('Lyon');await search.locator('[name=gender]').selectOption('female');await search.locator('[type=submit]').click();
    await paid.locator('[data-search-status]').filter({hasText:'24 membre(s)'}).waitFor();
    check(await paid.locator('.premium-member-card').count()===24,"advanced city and gender search renders server results");
    await paid.locator('.premium-search [data-more]').click();await paid.locator('[data-search-status]').filter({hasText:'26 membre(s)'}).waitFor();
    check(await paid.locator('.premium-member-card').count()===26,"advanced search loads the next page");
    await paid.screenshot({path:output+'/premium-search-desktop.png'});
    await search.locator('[name=city]').fill('');await search.locator('[name=gender]').selectOption('');await search.locator('[name=q]').fill('Clara Social');await search.locator('[type=submit]').click();
    await paid.locator('[data-search-status]').filter({hasText:'1 membre(s)'}).waitFor();await paid.locator('.premium-member-card [data-profile]').click();
    await paid.locator('#publicProfileName').filter({hasText:'Clara Social'}).waitFor();
    check(true,"search result opens the selected member's full profile");await paid.locator('#closePublicProfile').click();
    await paid.locator('#profileBtn').click();await paid.locator('#premiumPerksBtn').click();await form.waitFor();
    await paid.setViewportSize({width:390,height:844});await paid.evaluate(()=>document.documentElement.dataset.theme='dark');
    await paid.waitForFunction(()=>getComputedStyle(document.querySelector('.premium-settings [data-close]')).backgroundColor===getComputedStyle(document.querySelector('.premium-settings')).backgroundColor);
    check(await paid.locator('.premium-settings').evaluate(el=>el.scrollWidth<=el.clientWidth),"Premium preferences fit mobile in dark mode");
    await paid.screenshot({path:output+'/premium-settings-mobile-dark.png'});
    await paid.locator('.premium-settings [data-open-search]').click();await search.waitFor();
    check(await paid.locator('.premium-search').evaluate(el=>el.scrollWidth<=el.clientWidth),"advanced search fits mobile without horizontal overflow");
    await paid.screenshot({path:output+'/premium-search-mobile-dark.png'});
    await paid.keyboard.press('Escape');await paid.locator('#closeProfile').click();
    await paid.setViewportSize({width:1365,height:1000});
    await pool.query("UPDATE letchat_subscriptions SET status='canceled' WHERE user_id=$1",[a.user.id]);
    await paid.locator('#profileBtn').click();await paid.locator('#premiumPerksBtn').click();await paid.locator('.premium-settings [data-upgrade]').waitFor();
    check(true,"expired subscriber sees the offer instead of editable paid preferences");
    check(errors.length===0,`Premium browser flows have no runtime errors: ${errors.join('; ')}`);
    await subscribe(a);
  } catch(error){for(let i=0;i<pages.length;i++)await pages[i].screenshot({path:`${output}/failure-${i}.png`}).catch(()=>{});throw error;}
  finally{await browser.close();}
}

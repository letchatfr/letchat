import assert from "node:assert/strict";
import sharp from "sharp";

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function next(socket,event,predicate=()=>true){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off(event,listener);reject(new Error(`Missing ${event}`));},5000);const listener=data=>{if(!predicate(data))return;clearTimeout(timer);socket.off(event,listener);resolve(data);};socket.on(event,listener);});}
export async function runPremiumBenefitsQA({origin,users,request,pool,check,sockets,connect}) {
  const [a,b,c,d,e]=users,[sa,sb,sc]=sockets;
  const subscribe=(u,status="active",plan="premium")=>pool.query(`INSERT INTO letchat_subscriptions(user_id,status,plan,current_period_end) VALUES($1,$2,$3,NOW()+INTERVAL '1 day')
    ON CONFLICT(user_id) DO UPDATE SET status=EXCLUDED.status,plan=EXCLUDED.plan,current_period_end=EXCLUDED.current_period_end`,[u.user.id,status,plan]);
  const prefs=(u,body)=>request('/api/premium/preferences',u.token,'PATCH',body);
  check((await request('/api/premium/benefits')).status===401,"Premium settings require authentication");
  const free=(await request('/api/premium/benefits',c.token)).data;
  check(!free.premium&&free.albumLimit===12&&free.groupLimit===8,"free members keep 12 photos and eight-person groups");
  check((await prefs(c,{accent:'purple'})).status===403&&(await prefs(c,{discreet:true})).status===403,"free member cannot enable paid personalization or discretion");
  check((await request('/api/premium/members',c.token)).status===403,"advanced search is enforced on server");
  await subscribe(a);await subscribe(b,'trialing','premium_plus');
  check((await request('/api/premium/benefits',a.token)).data.albumLimit===36&&(await request('/api/premium/benefits',b.token)).data.groupLimit===20,"Premium and Premium+ grant all new advantages");
  check((await prefs(a,{frame:'url(evil)'})).status===400&&(await prefs(a,{user_id:c.user.id,badge:true})).status===400,"unrecognized style and account override rejected");
  check((await prefs(a,{accent:'purple',frame:'gold',badge:true})).status===200,"owner saves Premium profile appearance");
  const appearance=(await request('/api/premium/appearances',c.token,'POST',{ids:[a.user.id,c.user.id]})).data;
  check(appearance.find(x=>x.id===a.user.id)?.premium_frame==='gold'&&!appearance.find(x=>x.id===c.user.id)?.premium_badge,"free member sees subscriber's distinct Premium badge and frame");
  check((await request(`/api/profile/${a.user.id}`,c.token)).data.premium_accent==='purple',"public profile carries Premium appearance");
  await prefs(a,{badge:false});check(!(await request(`/api/profile/${a.user.id}`,c.token)).data.premium_badge,"subscriber can hide the Premium badge");await prefs(a,{badge:true});

  const png=await sharp({create:{width:16,height:16,channels:3,background:'#bc6f56'}}).png().toBuffer(),body={mediaBase64:png.toString('base64'),mediaType:'image/png'};
  const photo=await request('/api/social/albums',b.token,'POST',body);assert.equal(photo.status,201);
  await pool.query(`INSERT INTO letchat_album_photos(id,user_id,image_data,thumbnail_data) SELECT 'premium-photo-'||n,$1,image_data,thumbnail_data FROM letchat_album_photos CROSS JOIN generate_series(1,34) n WHERE id=$2`,[b.user.id,photo.data.id]);
  const race=await Promise.all([1,2].map(()=>request('/api/social/albums',b.token,'POST',body)));
  check(race.filter(r=>r.status===201).length===1&&race.filter(r=>r.status===409).length===1,"concurrent uploads cannot exceed 36 photos");
  check((await request(`/api/social/albums/${b.user.id}`,c.token)).data.photos.length===36,"all 36 photos remain directly visible to free members");
  await pool.query("UPDATE letchat_subscriptions SET current_period_end=NOW()-INTERVAL '1 second' WHERE user_id=$1",[b.user.id]);
  const expiredAlbum=(await request(`/api/social/albums/${b.user.id}`,b.token)).data;
  check(expiredAlbum.limit===12&&expiredAlbum.photos.length===36&&(await request('/api/social/albums',b.token,'POST',body)).status===409,"expiration preserves existing photos and prevents uploads over free quota");
  await subscribe(b);

  const extras=Array.from({length:26},(_,i)=>`premium-fixture-${i}`);
  for(const [i,id] of extras.entries()) {
    await pool.query("INSERT INTO profiles(user_id,display_name,region,department,city,gender,bio) VALUES($1,$2,'','','Lyon','female','Randonnée et musique')",[id,`Membre Test ${String(i).padStart(2,'0')}`]);
    await pool.query('INSERT INTO letchat_age_consents(user_id,over_18) VALUES($1,TRUE)',[id]);
  }
  const invitees=[c.user.id,...extras.slice(0,18)];
  check((await request('/api/social/groups',d.token,'POST',{name:'Trop grand',members:invitees.slice(0,8)})).status===400,"free creator cannot invite more than seven people");
  check((await request('/api/social/groups',a.token,'POST',{name:'Trop grand',members:[...invitees,extras[19]]})).status===400,"Premium creator cannot invite a twenty-first member");
  const group=await request('/api/social/groups',a.token,'POST',{name:'Le grand groupe Premium',members:invitees});assert.equal(group.status,201,JSON.stringify(group.data));
  check((await request(`/api/social/groups/${group.data.id}`,a.token)).data.members.length===20,"Premium creator invites nineteen members, twenty including the owner");
  check((await request(`/api/social/groups/${group.data.id}/accept`,c.token,'POST')).status===200,"free invitee can accept a Premium group invitation");
  await pool.query("UPDATE letchat_subscriptions SET status='canceled' WHERE user_id=$1",[a.user.id]);
  check((await request(`/api/social/groups/${group.data.id}`,a.token)).data.members.length===20,"existing group survives subscription expiration");
  check((await request('/api/social/groups',a.token,'POST',{name:'Nouvelle limite',members:invitees})).status===400,"expired subscriber cannot create another enlarged group");
  await subscribe(a);

  const search=async(u,query='')=>request('/api/premium/members?'+new URLSearchParams(query),u.token);
  const page1=await search(a,{city:'Lyon',gender:'female'}),page2=await search(a,{city:'Lyon',gender:'female',offset:String(page1.data.nextOffset)});
  check(page1.data.members.length===24&&page2.data.members.length===2&&new Set([...page1.data.members,...page2.data.members].map(x=>x.user_id)).size===26,"combined city and gender filters paginate without duplicates");
  check((await search(a,{q:'Randonnée'})).data.members.length===24,"advanced search finds public biography information");
  await pool.query("UPDATE profiles SET city='VilleSecrete',location_visible=FALSE WHERE user_id=$1",[c.user.id]);
  check((await search(a,{city:'VilleSecrete'})).data.members.length===0,"hidden cities cannot be discovered through search filters");
  await pool.query("INSERT INTO letchat_profile_extras(user_id,likes,visibility) VALUES($1,'PassionUltraSecrete','friends') ON CONFLICT(user_id) DO UPDATE SET likes=EXCLUDED.likes,visibility='friends'",[c.user.id]);
  check((await search(a,{q:'PassionUltraSecrete'})).data.members.length===0,"friends-only interests cannot be inferred through search");
  await pool.query("INSERT INTO letchat_friends(requester_id,addressee_id,status) VALUES($1,$2,'accepted')",[a.user.id,c.user.id]);
  check((await search(a,{q:'PassionUltraSecrete'})).data.members[0]?.user_id===c.user.id,"friends can search interests shared with them");
  await request(`/api/blocks/${c.user.id}`,a.token,'POST');
  check(!(await search(a,{q:'Clara'})).data.members.length,"blocked members are excluded from search");
  await request(`/api/blocks/${c.user.id}`,a.token,'DELETE');
  check((await search(a,{photo:'true'})).data.members.some(x=>x.user_id===b.user.id),"photo filter includes member albums");
  check((await search(a,{offset:'-1'})).status===400,"invalid pagination rejected");

  let visible=next(sc,'online-members',rows=>rows.some(x=>x.id===a.user.id));sa.emit('join-room','cafe');await visible;
  const otherTab=await connect(a);
  const gone=next(sc,'online-members',rows=>!rows.some(x=>x.id===a.user.id));
  const roomHidden=next(sc,'presence',rows=>!rows.some(x=>x.id===a.user.id));
  const statusHidden=next(sc,'private-status',r=>r.userId===a.user.id&&r.presence_hidden);
  sc.emit('watch-private-status',a.user.id);
  check((await prefs(a,{discreet:true})).status===200,"subscriber activates discreet mode");
  await gone;await roomHidden;const status=await statusHidden;
  check(!status.online&&status.lastSeen===null,"all tabs disappear from room/global lists and private status hides last seen");
  const hiddenProfile=(await request(`/api/profile/${a.user.id}`,c.token)).data;
  check(hiddenProfile.presence_hidden&&hiddenProfile.last_seen===null&&hiddenProfile.availability===null,"public profile API cannot reveal discreet presence");
  const friends=(await request('/api/friends',b.token)).data;
  // Blocking in the earlier social fixture removed the a/b friendship; add one for this check.
  if(!friends.some(row=>row.user_id===a.user.id))await pool.query("INSERT INTO letchat_friends(requester_id,addressee_id,status) VALUES($1,$2,'accepted') ON CONFLICT DO NOTHING",[a.user.id,b.user.id]);
  const hiddenFriend=(await request('/api/friends',b.token)).data.find(row=>row.user_id===a.user.id);
  check(hiddenFriend?.last_seen===null&&hiddenFriend?.availability===null,"friends endpoint also masks discreet status");
  await request('/api/private',a.token,'POST',{recipientId:c.user.id,body:'Bonjour en mode discret'});
  const hiddenConversation=(await request('/api/private-conversations',c.token)).data.find(row=>row.user_id===a.user.id);
  check(hiddenConversation?.availability===null,"conversation list masks discreet availability");
  check(!(await search(b,{online:'true'})).data.members.some(row=>row.user_id===a.user.id)&&!(await search(b,{availability:'available'})).data.members.some(row=>row.user_id===a.user.id),"online and availability search cannot expose discreet presence");
  const hiddenResult=(await search(b,{q:'Alice Social'})).data.members[0];check(hiddenResult?.presence_hidden&&hiddenResult.last_seen===null&&!hiddenResult.online,"name search exposes profile but no connection data");
  const typing=[];sc.on('typing',data=>typing.push(data));sc.on('private-typing',data=>typing.push(data));sa.emit('typing',true);otherTab.emit('private-typing',{target:c.user.id,active:true});await wait(150);
  check(!typing.some(x=>x.userId===a.user.id&&x.active),"typing indicators do not expose discreet members");
  const late=await connect(a);const snapshot=next(sc,'online-members');sc.emit('join-room','cafe');check(!(await snapshot).some(x=>x.id===a.user.id),"new socket also respects already enabled discreet mode");late.disconnect();
  await pool.query("UPDATE letchat_subscriptions SET current_period_end=NOW()-INTERVAL '1 second' WHERE user_id=$1",[a.user.id]);
  check((await request('/api/premium/members',a.token)).status===403&&(await prefs(a,{accent:'blue'})).status===403,"expiration revokes advanced search and new personalization changes");
  const expiredAppearance=(await request('/api/premium/appearances',c.token,'POST',{ids:[a.user.id]})).data[0];
  check(!expiredAppearance.premium_badge&&expiredAppearance.premium_accent==='default'&&expiredAppearance.premium_frame==='none',"expired badge and decorations stop being served");
  check((await request(`/api/profile/${a.user.id}`,c.token)).data.presence_hidden,"discretion remains enabled after expiry until owner disables it");
  const restored=next(sc,'online-members',rows=>rows.some(x=>x.id===a.user.id));
  check((await prefs(a,{discreet:false})).status===200,"former subscriber can explicitly disable discretion");await restored;
  check((await prefs(a,{discreet:true})).status===403,"former subscriber cannot re-enable paid discretion");
  await subscribe(a);await subscribe(b);
  if(process.env.LETCHAT_BENEFITS_BROWSER==='1'){
    const {runPremiumBenefitsBrowserQA}=await import('./premium-benefits-browser.mjs');await runPremiumBenefitsBrowserQA({origin,users,request,pool,check,subscribe});
  }
  otherTab.disconnect();
  await pool.query('DELETE FROM profiles WHERE user_id=ANY($1::text[])',[extras]);
  await pool.query('DELETE FROM letchat_subscriptions WHERE user_id=ANY($1::text[])',[[a.user.id,b.user.id,c.user.id,d.user.id,e.user.id]]);
}

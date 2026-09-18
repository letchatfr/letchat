let token=localStorage.getItem("letchat_token"),me=null,socket=null,mode="login",typingTimer=null,privateUser=null;
const $=x=>document.getElementById(x);
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function setMode(m){mode=m;document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.mode===m));$("authSubmit").textContent=m==="login"?"Se connecter":"Créer mon compte";$("authError").textContent=""}
document.querySelectorAll(".tab").forEach(x=>x.onclick=()=>setMode(x.dataset.mode));

$("authForm").onsubmit=async e=>{
 e.preventDefault();
 const r=await fetch("/api/"+(mode==="login"?"login":"register"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:$("username").value,password:$("password").value})});
 const d=await r.json();if(!r.ok){$("authError").textContent=d.error||"Erreur";return}
 token=d.token;localStorage.setItem("letchat_token",token);me=d.user;showChat();
};
async function showChat(){
 if(!token)return;
 const r=await fetch("/api/me",{headers:{Authorization:"Bearer "+token}});
 if(!r.ok){localStorage.removeItem("letchat_token");token=null;return}
 me=(await r.json()).user;$("auth").classList.add("hidden");$("chat").classList.remove("hidden");$("myName").textContent=me.username;
 connect();loadMessages();loadUsers();
}
function connect(){
 socket=io({auth:{token}});
 socket.on("message:new",m=>{if(!privateUser)addMessage(m)});
 socket.on("private:new",m=>{if(privateUser&&(String(m.senderId)===String(privateUser.id)||String(m.toUserId)===String(privateUser.id)))addPrivateMessage(m)});
 socket.on("presence",loadUsers);
 socket.on("typing",d=>{if(!privateUser)$("typing").textContent=d.username+" écrit…"});
 socket.on("stop-typing",()=>{$("typing").textContent=""});
}
async function loadMessages(){
 privateUser=null;$("roomTitle").textContent="Tchat général";$("messageInput").placeholder="Écrire un message...";
 const r=await fetch("/api/messages",{headers:{Authorization:"Bearer "+token}}),a=await r.json();
 $("messages").innerHTML="";a.forEach(addMessage);scroll();
}
function addMessage(m){
 if(document.querySelector('[data-msg="'+m.id+'"]'))return;
 const e=document.createElement("div");e.dataset.msg=m.id;e.className="message"+(String(m.userId)===String(me.id)?" mine":"");
 e.innerHTML=`<div class="meta">${esc(m.username)} · ${new Date(m.createdAt).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})}</div><div class="text">${esc(m.text)}</div>`;
 $("messages").appendChild(e);scroll();
}
async function loadUsers(){
 const r=await fetch("/api/users",{headers:{Authorization:"Bearer "+token}}),a=await r.json();
 $("onlineCount").textContent=a.filter(x=>x.online).length;
 $("users").innerHTML=a.map(u=>`<div class="user" data-id="${u.id}"><div class="avatar">${esc(u.username.slice(0,1).toUpperCase())}</div><span>${esc(u.username)}</span>${u.online?"<small>●</small>":""}</div>`).join("");
 document.querySelectorAll(".user").forEach(x=>x.onclick=()=>openPrivate(x.dataset.id));
}
async function openPrivate(uid){
 const r=await fetch("/api/users",{headers:{Authorization:"Bearer "+token}}),a=await r.json();privateUser=a.find(x=>String(x.id)===String(uid));
 if(!privateUser||String(privateUser.id)===String(me.id))return;
 $("roomTitle").textContent="Message avec "+privateUser.username;$("messageInput").placeholder="Message privé…";$("messages").innerHTML="";
 const p=await fetch("/api/private/"+privateUser.id,{headers:{Authorization:"Bearer "+token}});
 const msgs=await p.json();if(Array.isArray(msgs))msgs.forEach(addPrivateMessage);scroll();
}
function addPrivateMessage(m){
 const e=document.createElement("div");e.className="message"+(String(m.senderId)===String(me.id)?" mine":"");
 e.innerHTML=`<div class="meta">${esc(m.username)} · ${new Date(m.createdAt).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"})}</div><div class="text">${esc(m.text)}</div>`;
 $("messages").appendChild(e);scroll();
}
$("generalRoom").onclick=loadMessages;
$("messageForm").onsubmit=e=>{
 e.preventDefault();const text=$("messageInput").value.trim();if(!text||!socket)return;
 if(privateUser){
   socket.emit("private:send",{toUserId:privateUser.id,text},r=>{if(r?.ok)$("messageInput").value=""});
 }else{
   socket.emit("message:send",{text},r=>{if(r?.ok)$("messageInput").value=""});
 }
};
$("messageInput").addEventListener("input",()=>{socket?.emit("typing");clearTimeout(typingTimer);typingTimer=setTimeout(()=>socket?.emit("stop-typing"),800)});
$("logout").onclick=()=>{localStorage.removeItem("letchat_token");location.reload()};
function scroll(){$("messages").scrollTop=$("messages").scrollHeight}
showChat();
require("dotenv").config();
const express=require("express");
const http=require("http");
const path=require("path");
const {Server}=require("socket.io");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const {Pool}=require("pg");

const app=express();
const server=http.createServer(app);
const io=new Server(server);
const PORT=process.env.PORT||3000;
const JWT_SECRET=process.env.JWT_SECRET||"change-me-in-production";
const pool=process.env.DATABASE_URL?new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false
}):null;

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));

const memoryUsers=new Map(), memoryMessages=[];
const online=new Map();

function id(){return Math.random().toString(36).slice(2)+Date.now().toString(36)}
function pub(u){return {id:String(u.id),username:u.username,avatar:u.avatar||"",bio:u.bio||"",status:u.status||"",createdAt:u.created_at||u.createdAt}}
function makeToken(u){return jwt.sign({id:String(u.id)},JWT_SECRET,{expiresIn:"7d"})}
async function query(sql,params=[]){return pool.query(sql,params)}

async function initDb(){
 if(!pool){console.warn("DATABASE_URL absente : mode mémoire local.");return}
 await query(`CREATE TABLE IF NOT EXISTS users(
   id BIGSERIAL PRIMARY KEY,
   username VARCHAR(24) UNIQUE NOT NULL,
   password_hash TEXT NOT NULL,
   avatar TEXT DEFAULT '',
   created_at TIMESTAMPTZ DEFAULT NOW()
 )`);
 await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''`);
 await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(80) DEFAULT ''`);
 await query(`CREATE TABLE IF NOT EXISTS messages(
   id BIGSERIAL PRIMARY KEY,
   user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   text TEXT NOT NULL CHECK(length(text)<=2000),
   created_at TIMESTAMPTZ DEFAULT NOW()
 )`);
 await query(`CREATE TABLE IF NOT EXISTS conversations(
   id BIGSERIAL PRIMARY KEY,
   user_a BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   user_b BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   created_at TIMESTAMPTZ DEFAULT NOW(),
   UNIQUE(user_a,user_b)
 )`);
 await query(`CREATE TABLE IF NOT EXISTS private_messages(
   id BIGSERIAL PRIMARY KEY,
   conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
   sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
   text TEXT NOT NULL CHECK(length(text)<=2000),
   created_at TIMESTAMPTZ DEFAULT NOW()
 )`);
 await query(`CREATE INDEX IF NOT EXISTS messages_created_idx ON messages(created_at)`);
 await query(`CREATE INDEX IF NOT EXISTS private_messages_idx ON private_messages(conversation_id,created_at)`);
}

async function findUser(uid){
 if(pool){
   const r=await query("SELECT * FROM users WHERE id=$1",[uid]);
   return r.rows[0];
 }
 return memoryUsers.get(String(uid));
}
async function auth(req,res,next){
 try{
   const h=req.headers.authorization||"";
   if(!h.startsWith("Bearer ")) throw new Error();
   const p=jwt.verify(h.slice(7),JWT_SECRET);
   const u=await findUser(p.id);
   if(!u) throw new Error();
   req.user=u; next();
 }catch(e){res.status(401).json({error:"Session invalide."})}
}

app.get("/api/health",(req,res)=>res.json({
 ok:true,version:"3.0.0",database:!!pool
}));

app.post("/api/register",async(req,res)=>{
 try{
   const username=String(req.body.username||"").trim();
   const password=String(req.body.password||"");
   if(username.length<3||username.length>24||!/^[a-zA-Z0-9_À-ÿ -]+$/.test(username))
     return res.status(400).json({error:"Pseudo invalide (3 à 24 caractères)."});
   if(password.length<6)
     return res.status(400).json({error:"Mot de passe : 6 caractères minimum."});

   let u;
   const hash=await bcrypt.hash(password,12);
   if(pool){
     const exists=await query("SELECT id FROM users WHERE lower(username)=lower($1)",[username]);
     if(exists.rowCount)return res.status(409).json({error:"Ce pseudo existe déjà."});
     u=(await query(
       "INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING *",
       [username,hash]
     )).rows[0];
   }else{
     if([...memoryUsers.values()].some(x=>x.username.toLowerCase()===username.toLowerCase()))
       return res.status(409).json({error:"Ce pseudo existe déjà."});
     u={id:id(),username,password_hash:hash,avatar:"",createdAt:new Date().toISOString()};
     memoryUsers.set(String(u.id),u);
   }
   res.json({user:pub(u),token:makeToken(u)});
 }catch(e){console.error(e);res.status(500).json({error:"Erreur serveur."})}
});

app.post("/api/login",async(req,res)=>{
 try{
   const username=String(req.body.username||"").trim();
   const password=String(req.body.password||"");
   let u;
   if(pool){
     u=(await query("SELECT * FROM users WHERE lower(username)=lower($1)",[username])).rows[0];
   }else{
     u=[...memoryUsers.values()].find(x=>x.username.toLowerCase()===username.toLowerCase());
   }
   if(!u||!(await bcrypt.compare(password,u.password_hash)))
     return res.status(401).json({error:"Pseudo ou mot de passe incorrect."});
   res.json({user:pub(u),token:makeToken(u)});
 }catch(e){res.status(500).json({error:"Erreur serveur."})}
});

app.get("/api/me",auth,(req,res)=>res.json({user:pub(req.user)}));
app.patch("/api/me",auth,async(req,res)=>{
 try{
   const bio=String(req.body.bio??"").trim().slice(0,300);
   const status=String(req.body.status??"").trim().slice(0,80);
   const avatar=String(req.body.avatar??"").trim().slice(0,2);
   if(pool){
     const r=await query("UPDATE users SET bio=$1,status=$2,avatar=$3 WHERE id=$4 RETURNING *",[bio,status,avatar,req.user.id]);
     return res.json({user:pub(r.rows[0])});
   }
   req.user.bio=bio;req.user.status=status;req.user.avatar=avatar;
   memoryUsers.set(String(req.user.id),req.user);
   res.json({user:pub(req.user)});
 }catch(e){console.error(e);res.status(500).json({error:"Impossible de modifier le profil."})}
});

app.get("/api/users",auth,async(req,res)=>{
 try{
   let list=pool?(await query("SELECT id,username,avatar,created_at FROM users ORDER BY username")).rows:[...memoryUsers.values()];
   res.json(list.map(u=>({...pub(u),online:online.has(String(u.id))})));
 }catch(e){res.status(500).json({error:"Erreur serveur."})}
});

app.get("/api/messages",auth,async(req,res)=>{
 try{
   if(pool){
     const r=await query(`SELECT m.id,m.user_id,m.text,m.created_at,u.username
       FROM messages m JOIN users u ON u.id=m.user_id
       ORDER BY m.created_at DESC LIMIT 100`);
     return res.json(r.rows.reverse().map(x=>({
       id:String(x.id),userId:String(x.user_id),username:x.username,text:x.text,createdAt:x.created_at
     })));
   }
   res.json(memoryMessages.slice(-100));
 }catch(e){res.status(500).json({error:"Erreur serveur."})}
});

async function saveGeneral(u,text){
 if(pool){
   const r=await query(
     "INSERT INTO messages(user_id,text) VALUES($1,$2) RETURNING id,created_at",
     [u.id,text]
   );
   return {id:String(r.rows[0].id),userId:String(u.id),username:u.username,text,createdAt:r.rows[0].created_at};
 }
 const m={id:id(),userId:String(u.id),username:u.username,text,createdAt:new Date().toISOString()};
 memoryMessages.push(m); if(memoryMessages.length>500)memoryMessages.shift(); return m;
}

app.post("/api/messages",auth,async(req,res)=>{
 const text=String(req.body.text||"").trim();
 if(!text||text.length>2000)return res.status(400).json({error:"Message invalide."});
 try{
   const m=await saveGeneral(req.user,text);
   io.emit("message:new",m);
   res.status(201).json(m);
 }catch(e){res.status(500).json({error:"Impossible d'enregistrer le message."})}
});

async function conversationId(a,b){
 const A=BigInt(a),B=BigInt(b);
 const lo=A<B?A:B,hi=A<B?B:A;
 if(pool){
   let r=await query("SELECT id FROM conversations WHERE user_a=$1 AND user_b=$2",[lo,hi]);
   if(!r.rowCount)r=await query(
     `INSERT INTO conversations(user_a,user_b) VALUES($1,$2)
      ON CONFLICT(user_a,user_b) DO UPDATE SET user_a=EXCLUDED.user_a
      RETURNING id`,[lo,hi]
   );
   return r.rows[0].id;
 }
 return `${lo}-${hi}`;
}

app.get("/api/private/:userId",auth,async(req,res)=>{
 try{
   const other=await findUser(req.params.userId);
   if(!other)return res.status(404).json({error:"Utilisateur introuvable."});
   if(!pool)return res.json([]);
   const cid=await conversationId(req.user.id,other.id);
   const r=await query(`SELECT pm.id,pm.sender_id,pm.text,pm.created_at,u.username
     FROM private_messages pm JOIN users u ON u.id=pm.sender_id
     WHERE pm.conversation_id=$1 ORDER BY pm.created_at DESC LIMIT 100`,[cid]);
   res.json(r.rows.reverse().map(x=>({
     id:String(x.id),senderId:String(x.sender_id),username:x.username,text:x.text,createdAt:x.created_at
   })));
 }catch(e){res.status(500).json({error:"Erreur serveur."})}
});

app.post("/api/private/:userId",auth,async(req,res)=>{
 const text=String(req.body.text||"").trim();
 if(!text||text.length>2000)return res.status(400).json({error:"Message invalide."});
 try{
   const other=await findUser(req.params.userId);
   if(!other)return res.status(404).json({error:"Utilisateur introuvable."});
   if(!pool)return res.status(503).json({error:"PostgreSQL est nécessaire pour les messages privés."});
   const cid=await conversationId(req.user.id,other.id);
   const r=await query(
     "INSERT INTO private_messages(conversation_id,sender_id,text) VALUES($1,$2,$3) RETURNING id,created_at",
     [cid,req.user.id,text]
   );
   const m={id:String(r.rows[0].id),senderId:String(req.user.id),username:req.user.username,
     text,createdAt:r.rows[0].created_at,toUserId:String(other.id)};
   io.to("user:"+other.id).emit("private:new",m);
   io.to("user:"+req.user.id).emit("private:new",m);
   res.status(201).json(m);
 }catch(e){res.status(500).json({error:"Impossible d'envoyer le message."})}
});

io.use(async(socket,next)=>{
 try{
   const p=jwt.verify(socket.handshake.auth?.token,JWT_SECRET);
   const u=await findUser(p.id);
   if(!u)throw new Error();
   socket.user=u;next();
 }catch(e){next(new Error("unauthorized"))}
});

io.on("connection",socket=>{
 const uid=String(socket.user.id);
 online.set(uid,socket.id);
 socket.join("user:"+uid);
 io.emit("presence",{userId:uid,online:true});

 socket.on("typing",()=>socket.broadcast.emit("typing",{userId:uid,username:socket.user.username}));
 socket.on("stop-typing",()=>socket.broadcast.emit("stop-typing",{userId:uid}));

 socket.on("message:send",async(payload,ack)=>{
   const text=String(payload?.text||"").trim();
   if(!text||text.length>2000)return ack?.({ok:false,error:"Message invalide."});
   try{
     const m=await saveGeneral(socket.user,text);
     io.emit("message:new",m);ack?.({ok:true,msg:m});
   }catch(e){ack?.({ok:false,error:"Erreur d'enregistrement."})}
 });

 socket.on("private:send",async(payload,ack)=>{
   try{
     const text=String(payload?.text||"").trim();
     const other=await findUser(payload?.toUserId);
     if(!other||!text||text.length>2000)return ack?.({ok:false,error:"Message invalide."});
     if(!pool)return ack?.({ok:false,error:"PostgreSQL nécessaire."});
     const cid=await conversationId(socket.user.id,other.id);
     const r=await query(
       "INSERT INTO private_messages(conversation_id,sender_id,text) VALUES($1,$2,$3) RETURNING id,created_at",
       [cid,socket.user.id,text]
     );
     const m={id:String(r.rows[0].id),senderId:String(socket.user.id),username:socket.user.username,
       text,createdAt:r.rows[0].created_at,toUserId:String(other.id)};
     io.to("user:"+other.id).emit("private:new",m);
     io.to("user:"+socket.user.id).emit("private:new",m);
     ack?.({ok:true,msg:m});
   }catch(e){ack?.({ok:false,error:"Erreur serveur."})}
 });

 socket.on("disconnect",()=>{
   if(online.get(uid)===socket.id)online.delete(uid);
   io.emit("presence",{userId:uid,online:false});
 });
});

app.use((req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

initDb().then(()=>server.listen(PORT,()=>console.log("Letchat 3.0 lancé sur "+PORT)))
.catch(e=>{console.error(e);process.exit(1)});

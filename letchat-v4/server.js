import express from "express";
import helmet from "helmet";
import http from "node:http";
import pg from "pg";
import { Server } from "socket.io";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app=express(),server=http.createServer(app),io=new Server(server,{maxHttpBufferSize:10e6});
const projectId=process.env.FIREBASE_PROJECT_ID||"letchat-1d79d";
const jwks=createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});
await pool.query(`CREATE TABLE IF NOT EXISTS messages(id BIGSERIAL PRIMARY KEY,user_id TEXT NOT NULL,author TEXT NOT NULL,photo TEXT,body TEXT NOT NULL DEFAULT '',media_data BYTEA,media_type TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);`);
app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:"9mb"}));app.use(express.static("public"));
async function verify(token){const {payload}=await jwtVerify(token,jwks,{issuer:`https://securetoken.google.com/${projectId}`,audience:projectId});return{id:String(payload.sub),email:String(payload.email||""),name:String(payload.name||payload.email||"Utilisateur"),photo:typeof payload.picture==="string"?payload.picture:null};}
async function auth(req,res,next){try{const token=req.headers.authorization?.replace(/^Bearer\s+/i,"")||req.query.t;if(!token)throw new Error();req.user=await verify(String(token));next()}catch{res.status(401).json({error:"Connexion requise"})}}
app.get("/api/messages",auth,async(req,res)=>{const {rows}=await pool.query("SELECT id,user_id,author,photo,body,media_type,created_at,(media_data IS NOT NULL) AS has_media FROM messages ORDER BY id DESC LIMIT 100");res.json(rows.reverse())});
app.get("/api/media/:id",auth,async(req,res)=>{const {rows}=await pool.query("SELECT media_data,media_type FROM messages WHERE id=$1",[req.params.id]);if(!rows[0]?.media_data)return res.sendStatus(404);res.type(rows[0].media_type).set("Cache-Control","private,max-age=86400").send(rows[0].media_data)});
app.post("/api/messages",auth,async(req,res)=>{const body=String(req.body.body||"").trim().slice(0,4000),mediaType=String(req.body.mediaType||""),media=req.body.mediaBase64?Buffer.from(String(req.body.mediaBase64),"base64"):null;if(!body&&!media)return res.status(400).json({error:"Message vide"});if(media&&media.length>8e6)return res.status(413).json({error:"Fichier trop volumineux (8 Mo maximum)"});if(media&&!/^(image|video)\//.test(mediaType))return res.status(415).json({error:"Format non accepté"});const q=await pool.query("INSERT INTO messages(user_id,author,photo,body,media_data,media_type) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,user_id,author,photo,body,media_type,created_at,(media_data IS NOT NULL) AS has_media",[req.user.id,req.user.name,req.user.photo,body,media,mediaType||null]);io.emit("message",q.rows[0]);res.status(201).json(q.rows[0])});
const online=new Map();
io.use(async(socket,next)=>{try{socket.user=await verify(socket.handshake.auth?.token);next()}catch{next(new Error("unauthorized"))}});
io.on("connection",socket=>{online.set(socket.id,socket.user);io.emit("presence",[...online.values()]);socket.on("typing",v=>socket.broadcast.emit("typing",{name:socket.user.name,active:!!v}));socket.on("webrtc",({target,data})=>{if(target)io.to(target).emit("webrtc",{from:socket.id,user:socket.user,data});else socket.broadcast.emit("webrtc",{from:socket.id,user:socket.user,data})});socket.on("disconnect",()=>{online.delete(socket.id);io.emit("presence",[...online.values()])})});
app.use((_,res)=>res.sendFile(new URL("./public/index.html",import.meta.url).pathname));
server.listen(process.env.PORT||10000,()=>console.log("Letchat prêt"));

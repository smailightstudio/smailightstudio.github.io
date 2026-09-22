import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
import {
  getDatabase, ref, get, set, push, onValue, onChildAdded, query, orderByChild, startAt, onDisconnect, remove
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBk_izQABm0jbdYachF7UzS4C_URlYTtJY",
  authDomain: "slchat-back.firebaseapp.com",
  databaseURL: "https://slchat-back-default-rtdb.firebaseio.com",
  projectId: "slchat-back",
  storageBucket: "slchat-back.firebasestorage.app",
  messagingSenderId: "812000030757",
  appId: "1:812000030757:web:cc432e23be58fb291f8fcc",
  measurementId: "G-VJMKT42K25"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

let uid = null;
let currentRoom = null;
let keyBytes = null;
let memberRef = null;
let messagesUnsub = null;
let membersUnsub = null;
let roomUnsub = null;
const STORAGE_KEY = "privateChatState_v3";

function loadSavedState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; }
}
function saveState(extra = {}) {
  try {
    const old = loadSavedState() || {};
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...old,
      roomId: $("roomId")?.value?.trim() || old.roomId || "",
      nickname: $("nickname")?.value?.trim() || old.nickname || "",
      ...extra
    }));
  } catch {}
}
function saveLocalMessage(m) {
  try {
    const s = loadSavedState() || {};
    let h = Array.isArray(s.history) ? s.history : [];
    if (m.id && h.some(x => x.id === m.id)) return;
    h.push(m);
    if (h.length > 500) h = h.slice(-500);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({...s, roomId: currentRoom, history: h}));
  } catch {}
}
function removeLocalMessage(id) {
  try {
    const s = loadSavedState() || {};
    const h = Array.isArray(s.history) ? s.history.filter(x => x.id !== id) : [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify({...s, history: h}));
  } catch {}
}
function restoreLoginForm() {
  const s = loadSavedState();
  if (!s) return;
  if (s.roomId) $("roomId").value = s.roomId;
  if (s.nickname) $("nickname").value = s.nickname;
  if (s.password) $("roomPassword").value = s.password;
}
function renderLocalHistory() {
  const s = loadSavedState();
  if (!s || s.roomId !== currentRoom || !Array.isArray(s.history)) return;
  messagesEl.innerHTML = "";
  for (const m of s.history) {
    if (m.type === "file") addFileMessage(m, m.sender === uid);
    else addMessage(m.nickname || "匿名", m.text || "", m.sender === uid, m);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
function clearLocalHistory() {
  const s = loadSavedState() || {};
  localStorage.setItem(STORAGE_KEY, JSON.stringify({...s, history: []}));
}

let currentJoinTime = 0;
const $ = id => document.getElementById(id);
const login = $("login");
const chat = $("chat");
const status = $("loginStatus");
const messagesEl = $("messages");

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
function b64ToBuf(s) {
  const bin = atob(s);
  return Uint8Array.from(bin, c => c.charCodeAt(0)).buffer;
}
async function deriveKey(password, roomId) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {name:"PBKDF2", salt:enc.encode("private-chat:"+roomId), iterations:150000, hash:"SHA-256"},
    material, {name:"AES-GCM", length:256}, false, ["encrypt","decrypt"]
  );
}
async function encryptText(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name:"AES-GCM",iv}, keyBytes, new TextEncoder().encode(text));
  return {iv:bufToB64(iv), data:bufToB64(data)};
}
async function decryptText(iv, data) {
  const plain = await crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(b64ToBuf(iv))}, keyBytes, b64ToBuf(data));
  return new TextDecoder().decode(plain);
}

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
// RTDB SDK 单次写入上限为 16 MB，因此文件切成 5 MiB 分块；每块 Base64 后写入数据库。
const FILE_CHUNK_SIZE = 5 * 1024 * 1024;

function formatFileSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
}
function fileMetaRef(fileId) { return ref(db, `rooms/${currentRoom}/files/${fileId}/meta`); }
function fileRef(fileId) { return ref(db, `rooms/${currentRoom}/files/${fileId}`); }

async function sendFile(file) {
  if (!currentRoom || !keyBytes) return;
  if (file.type && file.type.startsWith("image/") && file.size > MAX_IMAGE_SIZE) { alert("图片不能超过 10 MB"); return; }
  if (file.size > MAX_FILE_SIZE) { alert("文件不能超过 100 MB"); return; }
  const btn=$("fileBtn"), st=$("fileStatus"); btn.disabled=true; st.textContent="正在加密…";
  const fileId=crypto.randomUUID();
  try {
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv}, keyBytes, await file.arrayBuffer()));
    const totalChunks=Math.ceil(encrypted.byteLength/FILE_CHUNK_SIZE);
    await set(fileMetaRef(fileId), {
      ownerUid:uid, name:file.name.slice(0,120), mime:file.type||"application/octet-stream",
      size:file.size, encryptedSize:encrypted.byteLength, chunkSize:FILE_CHUNK_SIZE,
      totalChunks, iv:bufToB64(iv), createdAt:Date.now()
    });
    for(let i=0;i<totalChunks;i++){
      const a=i*FILE_CHUNK_SIZE, b=Math.min(encrypted.byteLength,a+FILE_CHUNK_SIZE);
      await set(ref(db,`rooms/${currentRoom}/files/${fileId}/chunks/${i}`),bufToB64(encrypted.slice(a,b)));
      st.textContent=`正在上传… ${Math.round(b/encrypted.byteLength*100)}%`;
    }
    const now=Date.now(), nick=$("nickname").value.trim()||"匿名";
    const messageRef=await push(messagesRef(),{type:"file",sender:uid,nickname:nick,name:file.name.slice(0,120),mime:file.type||"application/octet-stream",size:file.size,iv:bufToB64(iv),fileId,ownerUid:uid,createdAt:now,totalChunks});
    saveLocalMessage({id:messageRef.key,type:"file",sender:uid,nickname:nick,name:file.name.slice(0,120),mime:file.type||"application/octet-stream",size:file.size,iv:bufToB64(iv),fileId,ownerUid:uid,createdAt:now,totalChunks});
  } catch(e) {
    console.error(e); try{await remove(fileRef(fileId));}catch{}
    alert("发送文件失败："+(e.message||e.code||"未知错误"));
  } finally { btn.disabled=false; st.textContent=""; }
}

async function downloadEncryptedFile(m) {
  try {
    const snap=await get(fileRef(m.fileId)); if(!snap.exists()) throw new Error("文件已被撤回或不存在");
    const d=snap.val()||{}, meta=d.meta||{}, chunks=d.chunks||{};
    const total=Number(meta.totalChunks||m.totalChunks||0); if(!total) throw new Error("文件数据不完整");
    const parts=[]; let totalBytes=0;
    for(let i=0;i<total;i++){
      const s=chunks[String(i)]; if(typeof s!=="string") throw new Error(`缺少第 ${i+1} 个文件分块`);
      const p=new Uint8Array(b64ToBuf(s)); parts.push(p); totalBytes+=p.byteLength;
    }
    const encrypted=new Uint8Array(totalBytes); let off=0;
    for(const p of parts){encrypted.set(p,off);off+=p.byteLength;}
    const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(b64ToBuf(meta.iv||m.iv))},keyBytes,encrypted);
    const blob=new Blob([plain],{type:meta.mime||m.mime||"application/octet-stream"});
    const u=URL.createObjectURL(blob), a=document.createElement("a"); a.href=u; a.download=meta.name||m.name||"file"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(u),1000);
  } catch(e){console.error(e);alert("文件下载或解密失败："+(e.message||"未知错误"));}
}
function addFileMessage(m,mine) {
  const div=document.createElement("div"); div.className="msg"+(mine?" mine":""); div.dataset.messageId=m.id||"";
  const meta=document.createElement("div"); meta.className="meta"; meta.textContent=m.nickname||"匿名";
  const button=document.createElement("button"); button.type="button"; button.className="fileMessage"; button.textContent=`📎 ${m.name||"文件"}${m.size?` (${formatFileSize(m.size)})`:""}`; button.onclick=()=>downloadEncryptedFile(m);
  div.appendChild(meta);div.appendChild(button);addRecallButton(div,m);messagesEl.appendChild(div);
}
function addRecallButton(container,m){if(!m.id||(m.sender!==uid&&!isHost()))return;const btn=document.createElement("button");btn.type="button";btn.className="recallBtn";btn.textContent="撤回";btn.onclick=()=>recallMessage(m);container.appendChild(btn);}
async function recallMessage(m){
  if(!m.id||!currentRoom||(m.sender!==uid&&!isHost()))return;
  try{await remove(ref(db,`rooms/${currentRoom}/messages/${m.id}`));if(m.type==="file"&&m.fileId){try{await remove(fileRef(m.fileId));}catch(e){console.warn("文件删除失败",e);}}removeLocalMessage(m.id);const el=[...messagesEl.children].find(x=>x.dataset.messageId===m.id);if(el)el.remove();}
  catch(e){alert("撤回失败："+(e.message||e.code||"未知错误"));}
}

async function authUser() {
  if (!auth.currentUser) await signInAnonymously(auth);
  uid = auth.currentUser.uid;
}
function roomRef() { return ref(db, `rooms/${currentRoom}/info`); }
function membersRef() { return ref(db, `rooms/${currentRoom}/members`); }
function messagesRef() { return ref(db, `rooms/${currentRoom}/messages`); }

async function join() {
  status.textContent = "正在连接服务器…";$('joinBtn').disabled=true;
  const room=$("roomId").value.trim(),password=$("roomPassword").value,nickname=$("nickname").value.trim()||"匿名";
  if(!room||!password){status.textContent="请输入房间 ID 和密码";$('joinBtn').disabled=false;return;}
  try {
    await authUser();currentRoom=room;keyBytes=await deriveKey(password,room);saveState({roomId:room,nickname,password});
    const snap=await get(roomRef());
    if(!snap.exists()){
      chat.dataset.host=uid;
      const verifier=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(password));
      await set(roomRef(),{passwordHash:bufToB64(verifier),hostUid:uid,createdAt:Date.now()});
    }else{
      chat.dataset.host=snap.val().hostUid||"";
      const verifier=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(password));
      if(snap.val().passwordHash!==bufToB64(verifier))throw new Error("房间密码错误");
    }
    currentJoinTime=Date.now();
    memberRef=ref(db,`rooms/${room}/members/${uid}`);
    await set(memberRef,{nickname,online:true,joinedAt:currentJoinTime});onDisconnect(memberRef).remove();
    $("roomTitle").textContent=`房间：${room}`;login.classList.add("hidden");chat.classList.remove("hidden");
    renderLocalHistory();listen();$('joinBtn').disabled=false;
  }catch(e){console.error(e);status.textContent=e.code?`${e.code}: ${e.message||"进入房间失败"}`:(e.message||"进入房间失败");$('joinBtn').disabled=false;cleanup();}
}

function listen() {
  membersUnsub=onValue(membersRef(),snap=>{
    const members=snap.val()||{},list=$("members");list.innerHTML="";
    const arr=Object.entries(members).filter(([id,m])=>m&&typeof m==="object");$("online").textContent=`${arr.length} 人在线`;
    if(!arr.length){const li=document.createElement("li");li.textContent="暂无成员";list.appendChild(li);}
    arr.forEach(([id,m])=>{
      const li=document.createElement("li"),name=document.createElement("span");name.textContent=`${m.nickname||"匿名"}${id===currentHost()?" 👑":""}`;li.appendChild(name);
      if(isHost()&&id!==uid){const btn=document.createElement("button");btn.textContent="踢出";btn.className="kick";btn.onclick=()=>kick(id);li.appendChild(btn);}list.appendChild(li);
    });
    $("ownerInfo").textContent=`房主：${members[currentHost()]?.nickname||"房主"}`;
  },error=>{
    console.error("你断开了网络连接或被踢出:",error);$("online").textContent="成员列表读取失败";$("members").innerHTML="";
    const li=document.createElement("li");li.textContent=`读取失败：${error.message||error.code||"权限错误"}`;$("members").appendChild(li);$("ownerInfo").textContent="请检查 Firebase Database Rules 是否已发布";
  });

  roomUnsub=onValue(roomRef(),snap=>{if(!snap.exists()){alert("房间已关闭");leave();}});
  const newMessagesQuery=query(messagesRef(),orderByChild("createdAt"),startAt(currentJoinTime));
  messagesUnsub=onChildAdded(newMessagesQuery,async snap=>{
    const m=snap.val();if(!m)return;
    try{
      if(m.type==="file"){
        const message={id:snap.key,type:"file",sender:m.sender,nickname:m.nickname||"匿名",name:m.name,mime:m.mime,size:m.size,iv:m.iv,fileId:m.fileId,ownerUid:m.ownerUid||m.sender,createdAt:m.createdAt||Date.now()};
        saveLocalMessage(message);addFileMessage(message,message.sender===uid);
      }else{
        const text=await decryptText(m.iv,m.data);
        const message={id:snap.key,sender:m.sender,nickname:m.nickname||"匿名",text,createdAt:m.createdAt||Date.now()};
        saveLocalMessage(message);addMessage(message.nickname,message.text,message.sender===uid,message);
      }
      messagesEl.scrollTop=messagesEl.scrollHeight;
    }catch(e){console.warn("无法处理消息",e);}
  });
}
function currentHost(){return chat.dataset.host||"";}
function isHost(){return uid===currentHost();}
function addMessage(nickname,text,mine,messageMeta=null){
  const div=document.createElement("div");div.className="msg"+(mine?" mine":"");div.dataset.messageId=messageMeta?.id||"";
  const meta=document.createElement("div");meta.className="meta";meta.textContent=nickname;const body=document.createElement("div");body.textContent=text;
  div.appendChild(meta);div.appendChild(body);if(messageMeta)addRecallButton(div,messageMeta);messagesEl.appendChild(div);
}
async function sendMessage(text){
  if(!text.trim())return;const roomSnap=await get(roomRef());if(!roomSnap.exists())return;chat.dataset.host=roomSnap.val().hostUid||"";
  const encrypted=await encryptText(text.trim()),now=Date.now();
  const messageRef=await push(messagesRef(),{sender:uid,nickname:$("nickname").value.trim()||"匿名",iv:encrypted.iv,data:encrypted.data,createdAt:now});
  saveState({roomId:currentRoom,nickname:$("nickname").value.trim()||"匿名",password:$("roomPassword").value});
  saveLocalMessage({id:messageRef.key,sender:uid,nickname:$("nickname").value.trim()||"匿名",text:text.trim(),createdAt:now});
  $("messageInput").value="";
}
async function kick(targetUid){if(!isHost()||targetUid===uid)return;await remove(ref(db,`rooms/${currentRoom}/members/${targetUid}`));}
function cleanup(){if(messagesUnsub)messagesUnsub();if(membersUnsub)membersUnsub();if(roomUnsub)roomUnsub();messagesUnsub=membersUnsub=roomUnsub=null;currentRoom=null;keyBytes=null;currentJoinTime=0;memberRef=null;}
async function leave(){try{if(memberRef)await remove(memberRef);}catch{}cleanup();chat.classList.add("hidden");login.classList.remove("hidden");messagesEl.innerHTML="";}

restoreLoginForm();
$("joinBtn").onclick=join;
$("leaveBtn").onclick=leave;
$("sendForm").onsubmit=e=>{e.preventDefault();sendMessage($("messageInput").value);};
window.addEventListener("pagehide",cleanup);
const clearHistoryBtn=document.getElementById("clearHistoryBtn");
if(clearHistoryBtn)clearHistoryBtn.onclick=()=>{if(confirm("确定清除本机保存的聊天记录吗？")){clearLocalHistory();messagesEl.innerHTML="";}};
const fileInput=document.getElementById("fileInput");
if(fileInput)fileInput.onchange=async()=>{const f=fileInput.files?.[0];fileInput.value="";if(f)await sendFile(f);};

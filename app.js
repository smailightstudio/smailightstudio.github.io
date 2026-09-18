import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
import {
  getDatabase, ref, get, set, push, onValue, onChildAdded, query, orderByChild, startAt, onDisconnect, remove
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-database.js";

/*
  IMPORTANT:
  Replace this configuration with your Firebase project's Web App config.
*/
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
let currentKey = null;
let memberRef = null;
let messagesUnsub = null;
let membersUnsub = null;
let roomUnsub = null;
let keyBytes = null;
let currentJoinTime = 0;

const $ = id => document.getElementById(id);
const login = $("login");
const chat = $("chat");
const status = $("loginStatus");
const messagesEl = $("messages");

function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
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

async function authUser() {
  if (!auth.currentUser) await signInAnonymously(auth);
  uid = auth.currentUser.uid;
}

function roomRef() { return ref(db, `rooms/${currentRoom}/info`); }
function membersRef() { return ref(db, `rooms/${currentRoom}/members`); }
function messagesRef() { return ref(db, `rooms/${currentRoom}/messages`); }

async function join() {
  status.textContent = "正在连接 Firebase…";
  $("joinBtn").disabled = true;
  const room = $("roomId").value.trim();
  const password = $("roomPassword").value;
  const nickname = $("nickname").value.trim() || "匿名";

  if (!room || !password) {
    status.textContent = "请输入房间 ID 和密码";
    return;
  }

  try {
    await authUser();
    currentRoom = room;
    keyBytes = await deriveKey(password, room);

    const snap = await get(roomRef());
    if (!snap.exists()) {
      chat.dataset.host = uid;
      // Store only a verifier, never the plaintext room password.
      const verifier = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
      await set(roomRef(), {
        passwordHash: bufToB64(verifier),
        hostUid: uid,
        createdAt: Date.now()
      });
    } else {
      chat.dataset.host = snap.val().hostUid || "";
      const verifier = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
      const expected = snap.val().passwordHash;
      if (expected !== bufToB64(verifier)) throw new Error("房间密码错误");
    }

    currentJoinTime = Date.now();
    memberRef = ref(db, `rooms/${room}/members/${uid}`);
    await set(memberRef, {nickname, online:true, joinedAt:currentJoinTime});
    onDisconnect(memberRef).remove();

    $("roomTitle").textContent = `房间：${room}`;
    login.classList.add("hidden");
    chat.classList.remove("hidden");

    listen();
    $("joinBtn").disabled = false;
  } catch (e) {
    console.error(e);
    status.textContent = e.code ? `${e.code}: ${e.message || "进入房间失败"}` : (e.message || "进入房间失败");
    $("joinBtn").disabled = false;
    cleanup();
  }
}

function listen() {
  membersUnsub = onValue(membersRef(), snap => {
    const members = snap.val() || {};
    const list = $("members");
    list.innerHTML = "";
    const arr = Object.entries(members);
    $("online").textContent = `${arr.length} 人在线`;

    arr.forEach(([id,m]) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = m.nickname || "匿名";
      li.appendChild(name);

      if (id !== uid && id === currentHost()) {
        // host is shown naturally; no kick button
      }
      if (isHost() && id !== uid) {
        const btn = document.createElement("button");
        btn.textContent = "踢出";
        btn.className = "kick";
        btn.onclick = () => kick(id);
        li.appendChild(btn);
      }
      list.appendChild(li);
    });
    $("ownerInfo").textContent = `房主：${members[currentHost()]?.nickname || "房主"}`;
  });

  roomUnsub = onValue(roomRef(), snap => {
    if (!snap.exists()) {
      alert("房间已关闭");
      leave();
    }
  });

  // 只监听“加入房间之后”的新消息，不加载 Firebase 中以前的聊天记录。
  // 这样可以保证房间成员都能收到广播，同时新加入的人不会看到旧消息。
  const newMessagesQuery = query(messagesRef(), orderByChild("createdAt"), startAt(currentJoinTime));
  messagesUnsub = onChildAdded(newMessagesQuery, async snap => {
    const m = snap.val();
    if (!m) return;
    try {
      const text = await decryptText(m.iv, m.data);
      addMessage(m.nickname || "匿名", text, m.sender === uid);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (e) {
      console.warn("无法解密消息", e);
    }
  });
}

function currentHost() {
  // Cached host from room object is kept in data-host.
  return chat.dataset.host || "";
}
function isHost() { return uid === currentHost(); }

function addMessage(nickname, text, mine) {
  const div = document.createElement("div");
  div.className = "msg" + (mine ? " mine" : "");

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = nickname;

  const body = document.createElement("div");
  body.textContent = text;

  div.appendChild(meta);
  div.appendChild(body);
  messagesEl.appendChild(div);
}

async function sendMessage(text) {
  if (!text.trim()) return;
  const roomSnap = await get(roomRef());
  if (!roomSnap.exists()) return;
  chat.dataset.host = roomSnap.val().hostUid || "";

  const encrypted = await encryptText(text.trim());
  await push(messagesRef(), {
    sender: uid,
    nickname: $("nickname").value.trim() || "匿名",
    iv: encrypted.iv,
    data: encrypted.data,
    createdAt: Date.now()
  });
  $("messageInput").value = "";
}

async function kick(targetUid) {
  if (!isHost() || targetUid === uid) return;
  await remove(ref(db, `rooms/${currentRoom}/members/${targetUid}`));
}

function cleanup() {
  if (messagesUnsub) messagesUnsub();
  if (membersUnsub) membersUnsub();
  if (roomUnsub) roomUnsub();
  messagesUnsub = membersUnsub = roomUnsub = null;
  currentRoom = null;
  keyBytes = null;
  currentJoinTime = 0;
}
async function leave() {
  try { if (memberRef) await remove(memberRef); } catch {}
  cleanup();
  chat.classList.add("hidden");
  login.classList.remove("hidden");
  messagesEl.innerHTML = "";
}

$("joinBtn").onclick = join;
$("leaveBtn").onclick = leave;
$("sendForm").onsubmit = e => { e.preventDefault(); sendMessage($("messageInput").value); };

// Chat history is intentionally kept only in this page's DOM/memory.
// Never use localStorage/sessionStorage/IndexedDB for chat history.
// Messages exist only in the current page's memory/UI and disappear when the page is closed/refreshed.
window.addEventListener("pagehide", cleanup);

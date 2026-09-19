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
  for (const m of s.history) addMessage(m.nickname || "匿名", m.text || "", m.sender === uid);
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
  status.textContent = "正在连接云端服务器（可能需要挂梯子）";
  $("joinBtn").disabled = true;
  const room = $("roomId").value.trim();
  const password = $("roomPassword").value;
  const nickname = $("nickname").value.trim() || "匿名";

  if (!room || !password) {
    status.textContent = "请输入房间 ID 和密码";
    $("joinBtn").disabled = false;
    return;
  }

  try {
    await authUser();
    currentRoom = room;
    keyBytes = await deriveKey(password, room);
    saveState({roomId: room, nickname, password});

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

    renderLocalHistory();
    listen();
    $("joinBtn").disabled = false;
  } catch (e) {
    console.error(e);
    status.textContent = e.code ? `${e.code}: ${e.message || "进入房间失败（可能需要挂梯子）"}` : (e.message || "进入房间失败");
    $("joinBtn").disabled = false;
    cleanup();
  }
}

function listen() {
  membersUnsub = onValue(
    membersRef(),
    snap => {
      const members = snap.val() || {};
      const list = $("members");
      list.innerHTML = "";

      const arr = Object.entries(members).filter(([id, m]) => m && typeof m === "object");
      $("online").textContent = `${arr.length} 人在线`;

      if (arr.length === 0) {
        const li = document.createElement("li");
        li.textContent = "暂无成员";
        list.appendChild(li);
      }

      arr.forEach(([id, m]) => {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.textContent = `${m.nickname || "匿名"}${id === currentHost() ? " 👑" : ""}`;
        li.appendChild(name);

        if (isHost() && id !== uid) {
          const btn = document.createElement("button");
          btn.textContent = "踢出";
          btn.className = "kick";
          btn.onclick = () => kick(id);
          li.appendChild(btn);
        }
        list.appendChild(li);
      });

      $("ownerInfo").textContent =
        `房主：${members[currentHost()]?.nickname || "房主不在线"}`;
    },
    error => {
      console.error("成员列表读取失败:", error);
      $("online").textContent = "成员列表读取失败";
      $("members").innerHTML = "";
      const li = document.createElement("li");
      li.textContent = `读取失败：${error.message || error.code || "权限错误（你有可能被踢出服务器或断开服务器连接）"}`;
      $("members").appendChild(li);
      $("ownerInfo").textContent = "你已与云端服务器断开连接，检查梯子状态并刷新页面（或被踢出服务器）";
    }
  );

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
      const message = {
        id: snap.key,
        sender: m.sender,
        nickname: m.nickname || "匿名",
        text,
        createdAt: m.createdAt || Date.now()
      };
      saveLocalMessage(message);
      addMessage(message.nickname, message.text, message.sender === uid);
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
  const messageRef = await push(messagesRef(), {
    sender: uid,
    nickname: $("nickname").value.trim() || "匿名",
    iv: encrypted.iv,
    data: encrypted.data,
    createdAt: Date.now()
  });
  saveState({
    roomId: currentRoom,
    nickname: $("nickname").value.trim() || "匿名",
    password: $("roomPassword").value
  });
  saveLocalMessage({
    id: messageRef.key,
    sender: uid,
    nickname: $("nickname").value.trim() || "匿名",
    text: text.trim(),
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

restoreLoginForm();

$("joinBtn").onclick = join;
$("leaveBtn").onclick = leave;
$("sendForm").onsubmit = e => { e.preventDefault(); sendMessage($("messageInput").value); };

// Chat history is intentionally kept only in this page's DOM/memory.
// Never use localStorage/sessionStorage/IndexedDB for chat history.
// Messages exist only in the current page's memory/UI and disappear when the page is closed/refreshed.
window.addEventListener("pagehide", cleanup);

const clearHistoryBtn = document.getElementById("clearHistoryBtn");
if (clearHistoryBtn) {
  clearHistoryBtn.onclick = () => {
    if (confirm("确定清除本机保存的聊天记录吗？")) {
      clearLocalHistory();
      messagesEl.innerHTML = "";
    }
  };
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  setPersistence,
  browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
import {
  getDatabase,
  ref,
  get,
  set,
  push,
  remove,
  onValue,
  onChildAdded,
  onChildRemoved,
  onDisconnect,
  query,
  orderByChild,
  startAt
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-database.js";

/* =========================
   slchat - clean client
   ========================= */

const firebaseConfig = {
  apiKey: "AIzaSyBk_izQABm0jbdYachF7UzS4C_URtJY",
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

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const FILE_CHUNK_SIZE = 5 * 1024 * 1024;
const STORAGE_KEY = "slchatState_v1";

let uid = null;
let currentRoom = null;
let nickname = "";
let roomKey = "";
let keyBytes = null;
let isHost = false;
let memberRef = null;
let messagesUnsub = null;
let removedUnsub = null;
let membersUnsub = null;
let roomUnsub = null;
let currentJoinTime = 0;

const $ = id => document.getElementById(id);
const login = $("login");
const chat = $("chat");
const status = $("status");
const messagesEl = $("messages");
const membersEl = $("members");
const memberCountEl = $("memberCount");
const sendBtn = $("sendBtn");
const textInput = $("textInput");
const fileInput = $("fileInput");
const joinBtn = $("joinBtn");
const leaveBtn = $("leaveBtn");

function setStatus(text) {
  if (status) status.textContent = text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function bytesToBase64(bytes) {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(s);
}

function base64ToBytes(str) {
  const raw = atob(str);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function deriveKey(password, room) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("slchat:" + room),
      iterations: 150000,
      hash: "SHA-256"
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    keyBytes,
    new TextEncoder().encode(text)
  );
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(data)) };
}

async function decryptText(iv64, data64) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv64) },
    keyBytes,
    base64ToBytes(data64)
  );
  return new TextDecoder().decode(plain);
}

function roomRef() {
  return ref(db, `rooms/${currentRoom}`);
}
function infoRef() {
  return ref(db, `rooms/${currentRoom}/info`);
}
function membersRef() {
  return ref(db, `rooms/${currentRoom}/members`);
}
function messagesRef() {
  return ref(db, `rooms/${currentRoom}/messages`);
}
function filesRef() {
  return ref(db, `rooms/${currentRoom}/files`);
}
function fileRef(id) {
  return ref(db, `rooms/${currentRoom}/files/${id}`);
}

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  } catch {
    return null;
  }
}

function saveState(history = null) {
  const old = loadState() || {};
  const state = {
    ...old,
    roomId: currentRoom,
    nickname,
    password: $("roomPassword")?.value || old.password || "",
    history: history ?? old.history ?? []
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function addLocalMessage(message) {
  const state = loadState() || {};
  const history = Array.isArray(state.history) ? state.history : [];
  const filtered = history.filter(x => x?.id !== message.id);
  filtered.push(message);
  saveState(filtered.slice(-500));
}

function removeLocalMessage(id) {
  const state = loadState();
  if (!state || !Array.isArray(state.history)) return;
  saveState(state.history.filter(x => x?.id !== id));
}

async function ensureAuth() {
  await setPersistence(auth, browserLocalPersistence).catch(() => {});
  if (auth.currentUser) {
    uid = auth.currentUser.uid;
    return;
  }
  try {
    const result = await signInAnonymously(auth);
    uid = result.user.uid;
  } catch (e) {
    if (e.code === "auth/operation-not-allowed") {
      throw new Error("服务器未开启匿名登录");
    }
    if (e.code === "auth/network-request-failed") {
      throw new Error("服务器连接失败，请检查网络");
    }
    throw new Error("服务器登录失败：" + (e.message || e.code || "未知错误"));
  }
}

async function verifyOrCreateRoom(room, password) {
  const info = await get(ref(db, `rooms/${room}/info`));

  if (!info.exists()) {
    const passwordHash = await sha256(password);
    await set(ref(db, `rooms/${room}/info`), {
      passwordHash,
      hostUid: uid,
      createdAt: Date.now()
    });
    return { host: true };
  }

  const data = info.val() || {};
  const hash = await sha256(password);
  if (hash !== data.passwordHash) {
    throw new Error("房间密码错误");
  }
  return { host: data.hostUid === uid };
}

async function sha256(text) {
  const data = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(data)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function joinRoom() {
  const room = $("roomId")?.value.trim();
  const password = $("roomPassword")?.value || "";
  const name = $("nickname")?.value.trim() || "匿名";

  if (!room) throw new Error("请输入房间号");
  if (!password) throw new Error("请输入房间密码");

  cleanup();
  currentRoom = room;
  nickname = name;
  currentJoinTime = Date.now();

  await ensureAuth();

  const roomResult = await verifyOrCreateRoom(room, password);
  isHost = roomResult.host;
  roomKey = room;

  keyBytes = await deriveKey(password, room);

  const myMember = ref(db, `rooms/${room}/members/${uid}`);
  memberRef = myMember;

  await set(myMember, {
    nickname,
    online: true,
    joinedAt: Date.now()
  });

  onDisconnect(myMember).remove();

  $("roomTitle") && ($("roomTitle").textContent = "slchat");
  login?.classList.add("hidden");
  chat?.classList.remove("hidden");
  messagesEl && (messagesEl.innerHTML = "");

  await syncLocalHistoryWithServer();
  renderLocalHistory();
  listen();

  setStatus("已连接服务器");
}

async function syncLocalHistoryWithServer() {
  const state = loadState();
  if (!state || state.roomId !== currentRoom || !Array.isArray(state.history)) return;

  try {
    const snap = await get(messagesRef());
    const server = snap.val() || {};
    const ids = new Set(Object.keys(server));
    saveState(state.history.filter(m => ids.has(m.id)).slice(-500));
  } catch (e) {
    console.warn("同步历史失败", e);
  }
}

function renderLocalHistory() {
  const state = loadState();
  if (!state?.history || !messagesEl) return;

  for (const m of state.history) {
    renderMessage(m, false);
  }
}

function listen() {
  const q = query(messagesRef(), orderByChild("createdAt"), startAt(currentJoinTime));

  messagesUnsub = onChildAdded(q, async snap => {
    const m = { id: snap.key, ...(snap.val() || {}) };
    await handleIncomingMessage(m);
  });

  removedUnsub = onChildRemoved(q, snap => {
    removeLocalMessage(snap.key);
    const el = messagesEl?.querySelector(`[data-message-id="${CSS.escape(snap.key)}"]`);
    el?.remove();
  });

  membersUnsub = onValue(membersRef(), snap => {
    const members = snap.val() || {};
    const list = Object.entries(members);

    if (memberCountEl) memberCountEl.textContent = String(list.length);
    if (!membersEl) return;

    membersEl.innerHTML = "";
    for (const [id, m] of list) {
      const row = document.createElement("div");
      row.className = "member";
      row.textContent = m.nickname || "匿名";

      if (isHost && id !== uid) {
        const kick = document.createElement("button");
        kick.textContent = "踢出";
        kick.onclick = () => kickUser(id);
        row.appendChild(kick);
      }
      membersEl.appendChild(row);
    }
  });

  roomUnsub = onValue(infoRef(), snap => {
    if (!snap.exists()) {
      setStatus("服务器已断开连接");
      return;
    }
    const info = snap.val() || {};
    if (info.deletingAt) {
      setStatus("房间已关闭");
      cleanup();
      return;
    }
  });

  // 服务器连接状态：不是“无法显示用户”，而是明确显示断开连接。
  onValue(ref(db, ".info/connected"), snap => {
    if (snap.val() === true) {
      setStatus("已连接服务器");
    } else {
      setStatus("服务器连接已断开");
    }
  });
}

async function handleIncomingMessage(m) {
  if (!m.id || !m.sender) return;

  // 本地历史已经渲染过的消息不要重复显示。
  if (messagesEl?.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`)) return;

  addLocalMessage(m);
  await renderMessage(m, true);
}

async function renderMessage(m, canRecall = true) {
  const row = document.createElement("div");
  row.className = "message";
  row.dataset.messageId = m.id;

  const head = document.createElement("div");
  head.className = "message-head";
  head.textContent = `${m.nickname || "匿名"} · ${new Date(m.createdAt || Date.now()).toLocaleTimeString()}`;

  const body = document.createElement("div");
  body.className = "message-body";

  try {
    if (m.type === "file") {
      await renderFile(m, body);
    } else {
      body.textContent = await decryptText(m.iv, m.data);
    }
  } catch {
    body.textContent = "消息解密失败";
  }

  row.append(head, body);

  if (canRecall && (m.sender === uid || isHost)) {
    const recall = document.createElement("button");
    recall.textContent = "撤回";
    recall.onclick = () => recallMessage(m);
    row.appendChild(recall);
  }

  messagesEl?.appendChild(row);
  messagesEl && (messagesEl.scrollTop = messagesEl.scrollHeight);
}

async function renderFile(m, body) {
  const name = escapeHtml(m.name || "文件");
  const button = document.createElement("button");
  button.textContent = `📎 ${m.name || "文件"} (${formatBytes(m.size || 0)})`;
  button.onclick = () => downloadFile(m);
  body.appendChild(button);

  if ((m.mime || "").startsWith("image/")) {
    const img = document.createElement("img");
    img.alt = m.name || "图片";
    img.loading = "lazy";
    img.style.maxWidth = "100%";
    img.style.maxHeight = "420px";
    img.style.display = "block";
    img.style.marginTop = "8px";

    try {
      const blob = await decryptFile(m);
      img.src = URL.createObjectURL(blob);
      body.appendChild(img);
    } catch {
      // 文件按钮仍然可用。
    }
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function sendText() {
  const text = textInput?.value.trim();
  if (!text || !currentRoom || !uid) return;

  const encrypted = await encryptText(text);
  const msg = {
    sender: uid,
    nickname,
    ...encrypted,
    createdAt: Date.now(),
    type: "text"
  };

  await push(messagesRef(), msg);
  textInput.value = "";
}

async function sendFile(file) {
  if (!file) return;

  const isImage = (file.type || "").startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$/i.test(file.name);

  if (isImage && file.size > MAX_IMAGE_SIZE) {
    throw new Error("图片不能超过 10 MB");
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("文件不能超过 100 MB");
  }

  // 为保证手机和电脑兼容，按块读取并分别 AES-GCM 加密。
  const fileId = push(filesRef()).key;
  const totalChunks = Math.ceil(file.size / FILE_CHUNK_SIZE);
  const meta = {
    ownerUid: uid,
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    chunkSize: FILE_CHUNK_SIZE,
    totalChunks,
    createdAt: Date.now()
  };

  await set(ref(db, `rooms/${currentRoom}/files/${fileId}/meta`), meta);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * FILE_CHUNK_SIZE;
    const end = Math.min(file.size, start + FILE_CHUNK_SIZE);
    const plain = new Uint8Array(await file.slice(start, end).arrayBuffer());
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      keyBytes,
      plain
    ));

    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv, 0);
    combined.set(encrypted, iv.length);

    await set(
      ref(db, `rooms/${currentRoom}/files/${fileId}/chunks/${i}`),
      bytesToBase64(combined)
    );
  }

  await push(messagesRef(), {
    sender: uid,
    nickname,
    type: "file",
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    fileId,
    ownerUid: uid,
    totalChunks,
    createdAt: Date.now()
  });
}

async function decryptFile(m) {
  const snap = await get(fileRef(m.fileId));
  if (!snap.exists()) throw new Error("文件不存在");

  const data = snap.val() || {};
  const chunks = data.chunks || {};
  const parts = [];

  for (let i = 0; i < (m.totalChunks || 0); i++) {
    if (!chunks[i]) throw new Error("文件分块缺失");

    const combined = base64ToBytes(chunks[i]);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      keyBytes,
      ciphertext
    );
    parts.push(new Uint8Array(plain));
  }

  return new Blob(parts, { type: m.mime || "application/octet-stream" });
}

async function downloadFile(m) {
  try {
    setStatus("正在从服务器读取文件…");
    const blob = await decryptFile(m);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = m.name || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus("已连接服务器");
  } catch (e) {
    alert("文件读取失败：" + (e.message || "未知错误"));
    setStatus("服务器连接已断开或文件不存在");
  }
}

async function recallMessage(m) {
  if (!m?.id || !currentRoom) return;
  if (m.sender !== uid && !isHost) return;

  try {
    await remove(ref(db, `rooms/${currentRoom}/messages/${m.id}`));

    if (m.fileId) {
      // 由房主或文件拥有者清理整个文件节点。
      try {
        await remove(fileRef(m.fileId));
      } catch (e) {
        console.warn("文件数据删除失败", e);
      }
    }

    removeLocalMessage(m.id);
    messagesEl?.querySelector(`[data-message-id="${CSS.escape(m.id)}"]`)?.remove();
  } catch (e) {
    alert("撤回失败：" + (e.message || "服务器拒绝操作"));
  }
}

async function kickUser(targetUid) {
  if (!isHost || !currentRoom || targetUid === uid) return;

  try {
    await remove(ref(db, `rooms/${currentRoom}/members/${targetUid}`));
  } catch (e) {
    alert("踢出失败：" + (e.message || "服务器拒绝操作"));
  }
}

function cleanup() {
  messagesUnsub?.();
  removedUnsub?.();
  membersUnsub?.();
  roomUnsub?.();

  messagesUnsub = null;
  removedUnsub = null;
  membersUnsub = null;
  roomUnsub = null;

  if (memberRef) {
    // 不主动删除自己的成员节点，交给重新加入/服务器断开逻辑处理。
    memberRef = null;
  }

  currentRoom = null;
  roomKey = "";
  keyBytes = null;
  isHost = false;
  currentJoinTime = 0;
}

async function leaveRoom() {
  try {
    if (memberRef) await remove(memberRef);
  } catch {}
  cleanup();
  chat?.classList.add("hidden");
  login?.classList.remove("hidden");
  setStatus("已断开服务器");
}

function bindEvents() {
  if (joinBtn) {
    joinBtn.onclick = async () => {
      if (joinBtn.dataset.busy === "1") return;
      joinBtn.dataset.busy = "1";
      joinBtn.disabled = true;
      setStatus("正在连接服务器…");

      try {
        await joinRoom();
      } catch (e) {
        console.error(e);
        setStatus(e?.message || "连接服务器失败");
        cleanup();
      } finally {
        joinBtn.dataset.busy = "0";
        joinBtn.disabled = false;
      }
    };
  }

  sendBtn?.addEventListener("click", () => {
    sendText().catch(e => alert("发送失败：" + (e.message || "未知错误")));
  });

  textInput?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendText().catch(err => alert("发送失败：" + (err.message || "未知错误")));
    }
  });

  fileInput?.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;

    try {
      setStatus("正在上传到服务器…");
      await sendFile(file);
      setStatus("已连接服务器");
    } catch (e) {
      alert("文件发送失败：" + (e.message || "未知错误"));
      setStatus("服务器连接已断开或上传失败");
    }
  });

  leaveBtn?.addEventListener("click", leaveRoom);
}

function restoreLoginForm() {
  const state = loadState();
  if (!state) return;

  if ($("roomId") && state.roomId) $("roomId").value = state.roomId;
  if ($("nickname") && state.nickname) $("nickname").value = state.nickname;
  if ($("roomPassword") && state.password) $("roomPassword").value = state.password;
}

function boot() {
  restoreLoginForm();
  bindEvents();

  // 启动错误也直接显示，避免“点击完全没反应”。
  setStatus("等待连接服务器");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

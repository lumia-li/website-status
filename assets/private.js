const PAYLOAD_URL = "./data/status-private.json";
const THEME_KEY = "liyue-status-theme";
const UNLOCK_KEY = "liyue-status-private-password";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function b64ToBytes(text) {
  const bin = atob(String(text).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function decryptPayload(blob, password) {
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64ToBytes(blob.salt), iterations: Number(blob.iterations || 210000), hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(blob.nonce) }, key, b64ToBytes(blob.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

function applyTheme() {
  const theme = localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  if ($("#theme-color")) $("#theme-color").content = theme === "dark" ? "#090909" : "#f7f7f8";
  $("#theme-icon").innerHTML = theme === "dark"
    ? '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>';
}

function setMessage(text, isError) {
  const el = $("#lock-msg");
  el.textContent = text || "";
  el.className = "lock-msg" + (isError ? " error" : "");
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return isNaN(d) ? value : d.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

function render(payload) {
  const monitors = payload.monitors || [];
  const events = payload.events || [];
  const down = monitors.filter((m) => m.last_check && !m.ok);

  $("#lock").hidden = true;
  $("#content").hidden = false;

  $("#banner").className = "banner " + (monitors.length && !down.length ? "" : "down");
  $("#banner-icon").textContent = monitors.length && !down.length ? "✓" : "!";
  $("#overall").textContent = monitors.length && !down.length ? "私有服务全部正常" : "部分私有服务异常";
  $("#summary").textContent = monitors.length && !down.length
    ? `共 ${monitors.length} 项服务，最近检查 ${fmtDate(payload.generated_at)}`
    : `${down.length} 项服务最近一次检查失败`;

  $("#monitors").innerHTML = monitors.map((m) => {
    const checked = !!m.last_check;
    const ok = checked && m.ok;
    return `<article class="private-row"><div class="monitor-head"><span class="status-check ${ok ? "" : "down"}">${ok ? "✓" : "!"}</span><span class="monitor-name">${esc(m.name)}</span><span class="uptime">${esc(ok ? "正常" : "异常")}</span></div><div class="private-meta"><a class="private-url" href="${esc(m.url)}" target="_blank" rel="noreferrer noopener">${esc(m.url)}</a><span>HTTP ${esc(m.http_status ?? "—")}</span><span>${esc(m.response_ms ?? "—")} ms</span><span>${esc(fmtDate(m.last_check))}</span>${m.error ? `<span class="private-error">${esc(m.error)}</span>` : ""}</div></article>`;
  }).join("") || '<div class="empty">暂无数据</div>';

  $("#events").innerHTML = events.length
    ? events.slice(0, 50).map((e) => `<div class="event"><div class="event-title">${esc((e.type === "down" ? "服务检查失败" : "服务恢复正常") + " · " + (e.name || e.monitor_id))}</div><div class="event-meta">${esc(fmtDate(e.at))}</div></div>`).join("")
    : '<div class="empty">目前没有状态变化事件</div>';
}

async function fetchPayload() {
  const res = await fetch(PAYLOAD_URL + "?" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("missing");
  return res.json();
}

async function unlock(password, remember) {
  const button = $("#unlock-btn");
  button.disabled = true;
  setMessage("正在解锁…", false);
  try {
    const blob = await fetchPayload();
    const payload = await decryptPayload(blob, password);
    if (remember) sessionStorage.setItem(UNLOCK_KEY, password);
    setMessage("", false);
    render(payload);
  } catch (err) {
    sessionStorage.removeItem(UNLOCK_KEY);
    setMessage(err && err.message === "missing" ? "服务端还没有生成私有数据，请先运行一次监控任务。" : "密码错误，或数据尚未生成。", true);
  } finally {
    button.disabled = false;
  }
}

$("#theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
});

$("#unlock-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const password = $("#password").value;
  if (!password) return;
  $("#password").value = "";
  unlock(password, true);
});

$("#relock").addEventListener("click", () => {
  sessionStorage.removeItem(UNLOCK_KEY);
  $("#content").hidden = true;
  $("#lock").hidden = false;
  $("#monitors").innerHTML = "";
  $("#events").innerHTML = "";
  setMessage("已锁定", false);
  $("#password").focus();
});

applyTheme();
const cached = sessionStorage.getItem(UNLOCK_KEY);
if (cached) unlock(cached, false);

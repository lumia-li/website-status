import { connect } from "cloudflare:sockets";
const SITE_URL="https://status.liyueovo.top";const ALLOWED_ORIGINS=["https://status.liyueovo.top","https://airliny.github.io","http://localhost:8788","http://localhost:5173"];const baseHeaders={"Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization,X-Monitor-Secret","Content-Type":"application/json; charset=utf-8"};const corsFor=(request)=>{const origin=request?.headers.get("Origin")||"";return{...baseHeaders,"Access-Control-Allow-Origin":ALLOWED_ORIGINS.includes(origin)?origin:SITE_URL,"Vary":"Origin"}};const corsHeaders=corsFor(null);const json=(data,status=200,request)=>new Response(JSON.stringify(data),{status,headers:request?corsFor(request):corsHeaders});const token=()=>{const b=new Uint8Array(32);crypto.getRandomValues(b);return Array.from(b,x=>x.toString(16).padStart(2,"0")).join("")};const htmlEsc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function wrapBase64(value) { return value.match(/.{1,76}/g)?.join("\r\n") || ""; }
function encodedSubject(subject) { return "=?UTF-8?B?" + wrapBase64(base64Utf8(subject)).replace(/\r\n/g, "") + "?="; }
async function sendEmail(env, to, subject, html) {
  if (env.RESEND_API_KEY) return sendViaResend(env, to, subject, html);
  return sendViaSmtp(env, to, subject, html);
}
async function sendViaResend(env, to, subject, html) {
  const raw = String(env.FROM_EMAIL || "").replace(/[^\x20-\x7e]/g, " ").trim();
  const addrMatch = /<([^<>]+)>/.exec(raw);
  const from = (addrMatch ? addrMatch[1] : raw).trim();
  if (!from || from.indexOf("@") < 0) throw new Error("FROM_EMAIL must be a plain address like status@liyueovo.top (got: " + raw.slice(0, 60) + ")");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Liyue Status <" + from + ">", to: [to], subject, html })
  });
  const text = await res.text();
  if (!res.ok) throw new Error("Resend " + res.status + ": " + text.slice(0, 220));
  try { return JSON.parse(text); } catch { return {}; }
}
async function sendViaSmtp(env, to, subject, html) {
  const host = env.SMTP_HOST;
  const port = Number(env.SMTP_PORT || 465);
  const username = env.SMTP_USERNAME || env.FROM_EMAIL;
  const password = env.SMTP_PASSWORD;
  const from = env.FROM_EMAIL || username;
  if (!host || !username || !password || !from) throw new Error("SMTP is not configured; set SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD and FROM_EMAIL");
  if (port !== 465) throw new Error("This Worker requires SMTP port 465 with implicit TLS.");
  const socket = connect({ hostname: host, port }, { secureTransport: "on" });
  const reader = socket.readable.getReader(), writer = socket.writable.getWriter();
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffer = "";
  async function readLine() {
    while (true) {
      const i = buffer.indexOf("\r\n");
      if (i >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 2); return line; }
      const part = await reader.read();
      if (part.done) throw new Error("SMTP server closed the connection");
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 65536) throw new Error("SMTP response too long");
    }
  }
  async function response() {
    const lines = []; let code;
    do {
      const line = await readLine(); lines.push(line);
      const match = /^(\d{3})([ -])/.exec(line);
      if (!match) throw new Error("Invalid SMTP response");
      code = Number(match[1]);
      if (match[2] === " ") break;
    } while (lines.length < 50);
    return { code, text: lines.join("\n") };
  }
  async function expect(codes, step) {
    const r = await response();
    if (!codes.includes(r.code)) throw new Error("SMTP " + step + " failed (" + r.code + "): " + r.text.slice(0, 220));
  }
  async function command(line, codes, step) { await writer.write(encoder.encode(line + "\r\n")); await expect(codes, step); }
  try {
    await expect([220], "greeting");
    await command("EHLO liyue-status", [250], "EHLO");
    const nul = String.fromCharCode(0);
    let plainAuth = false;
    try {
      await command("AUTH LOGIN", [334], "AUTH");
    } catch (e) {
      if (!/failed \((\d{3})\)/.test(String(e.message || ""))) throw e;
      plainAuth = true;
    }
    if (plainAuth) {
      await command("AUTH PLAIN " + btoa(nul + username + nul + password), [235], "AUTH PLAIN");
    } else {
      await command(btoa(username), [334], "username");
      await command(btoa(password), [235], "password");
    }
    await command("MAIL FROM:<" + from + ">", [250], "MAIL FROM");
    await command("RCPT TO:<" + to + ">", [250, 251], "RCPT TO");
    await command("DATA", [354], "DATA");
    const message = [
      "From: Liyue Status <" + from + ">",
      "To: <" + to + ">",
      "Subject: " + encodedSubject(subject),
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(base64Utf8(html)),
      ".",
      ""
    ].join("\r\n");
    await writer.write(encoder.encode(message));
    await expect([250], "message submission");
    await command("QUIT", [221], "QUIT");
  } finally {
    try { reader.releaseLock(); } catch {}
    try { writer.releaseLock(); } catch {}
    try { await socket.close(); } catch {}
  }
}
function page(env,title,message){return new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>'+htmlEsc(title)+'</title><body style="font:16px system-ui;max-width:600px;margin:12vh auto;padding:24px;background:#090909;color:#f5f5f5"><h1>'+htmlEsc(title)+'</h1><p>'+htmlEsc(message)+'</p><a style="color:#8297ff" href="'+htmlEsc(env.SITE_URL||SITE_URL)+'">返回 Liyue Status</a></body></html>',{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}})}async function mail(env,to,subject,body,unsubscribeUrl){await sendEmail(env,to,subject,'<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#222;line-height:1.7"><h2 style="color:#4169f5">Liyue Status</h2>'+body+'<hr style="border:0;border-top:1px solid #ddd;margin-top:28px"><p style="font-size:12px;color:#666">你收到此邮件是因为订阅了 Liyue Status。<a href="'+unsubscribeUrl+'">取消订阅 / Unsubscribe</a></p></div>')};export default {async fetch(request,env){const url=new URL(request.url);const respond=(data,status=200)=>json(data,status,request);if(request.method==="OPTIONS")return new Response(null,{headers:corsFor(request)});try{if(url.pathname==="/api/health")return respond({ok:true,service:"airliny-status-subscriptions",mailer:env.RESEND_API_KEY?"resend":"smtp"});if(url.pathname==="/api/subscribe"&&request.method==="POST"){const body=await request.json().catch(()=>null);const email=String(body?.email||"").trim().toLowerCase();const lang=body?.lang==="en"?"en":"zh";if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return respond({error:"请输入有效邮箱地址"},400);const pending=token(),unsub=token(),now=new Date().toISOString();await env.DB.prepare("INSERT INTO subscribers (email, verified, confirm_token, unsubscribe_token, lang, created_at) VALUES (?, 0, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET verified=0, confirm_token=excluded.confirm_token, unsubscribe_token=excluded.unsubscribe_token, lang=excluded.lang, created_at=excluded.created_at").bind(email,pending,unsub,lang,now).run();const link=url.origin+"/confirm?token="+pending;await sendEmail(env,email,lang==="en"?"Confirm your Liyue Status subscription":"请确认订阅 Liyue Status",'<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;line-height:1.7"><h2>Liyue Status</h2><p>'+(lang==="en"?"Click the button below to confirm email notifications.":"点击下方按钮确认接收 Liyue Status 邮件通知。")+'</p><p><a href="'+link+'" style="display:inline-block;padding:11px 18px;border-radius:8px;background:#4169f5;color:white;text-decoration:none">'+(lang==="en"?"Confirm subscription":"确认订阅")+'</a></p><p style="font-size:12px;color:#666">'+(lang==="en"?"If you did not request this, ignore this email.":"如果不是你本人操作，请忽略此邮件。")+'</p></div>');return respond({ok:true,message:lang==="en"?"Check your inbox to confirm your subscription.":"请检查邮箱并点击验证链接完成订阅。"})}if(url.pathname==="/confirm"&&request.method==="GET"){const t=url.searchParams.get("token")||"";if(!/^[a-f0-9]{64}$/.test(t))return page(env,"链接无效","确认链接无效或已过期。");const row=await env.DB.prepare("SELECT email, unsubscribe_token, lang FROM subscribers WHERE confirm_token=? AND verified=0").bind(t).first();if(!row)return page(env,"链接无效","链接已使用、无效或已过期。");await env.DB.prepare("UPDATE subscribers SET verified=1, confirm_token=NULL, verified_at=? WHERE email=?").bind(new Date().toISOString(),row.email).run();const unsub=url.origin+"/unsubscribe?token="+row.unsubscribe_token;await mail(env,row.email,row.lang==="en"?"Subscription confirmed":"订阅确认成功",'<p>'+(row.lang==="en"?"You will receive email alerts when monitored services go down or recover.":"你已成功订阅。监控服务发生故障或恢复时，我们会发送邮件通知。")+'</p>',unsub);return page(env,"订阅成功","你的邮箱已验证。发生故障或恢复时，你会收到通知邮件。")}if(url.pathname==="/unsubscribe"&&request.method==="GET"){const t=url.searchParams.get("token")||"";if(!/^[a-f0-9]{64}$/.test(t))return page(env,"链接无效","退订链接无效。");const row=await env.DB.prepare("SELECT email FROM subscribers WHERE unsubscribe_token=?").bind(t).first();if(!row)return page(env,"已退订或链接无效","此订阅可能已经取消。");await env.DB.prepare("DELETE FROM subscribers WHERE unsubscribe_token=?").bind(t).run();return page(env,"已取消订阅","该邮箱已从通知列表中移除。")}if(url.pathname==="/api/notify"&&request.method==="POST"){const expectedSecret=String(env.MONITOR_SECRET||"").trim(),gotSecret=String(request.headers.get("X-Monitor-Secret")||"").trim();if(!expectedSecret||gotSecret!==expectedSecret)return respond({error:"Unauthorized"},401);const body=await request.json();if(!Array.isArray(body.monitors))return respond({error:"Expected monitors array"},400);const changed=[];for(const m of body.monitors){if(!m.id||typeof m.ok!=="boolean")continue;const prev=await env.DB.prepare("SELECT ok FROM monitor_state WHERE monitor_id=?").bind(m.id).first();if(prev&&Boolean(prev.ok)!==m.ok)changed.push({...m,transition:m.ok?"recovered":"down"});await env.DB.prepare("INSERT INTO monitor_state (monitor_id, ok, name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(monitor_id) DO UPDATE SET ok=excluded.ok, name=excluded.name, updated_at=excluded.updated_at").bind(m.id,m.ok?1:0,m.name||m.id,new Date().toISOString()).run()}if(!changed.length)return respond({ok:true,notifications:0});const subs=await env.DB.prepare("SELECT email,unsubscribe_token,lang FROM subscribers WHERE verified=1").all();let sent=0;for(const sub of subs.results||[]){const en=sub.lang==="en",un=url.origin+"/unsubscribe?token="+sub.unsubscribe_token,downList=changed.filter(m=>m.transition==="down"),rows=changed.map(m=>{const down=m.transition==="down",detail=down?(m.error||("HTTP "+(m.http_status??"unavailable"))):"HTTP "+(m.http_status??"OK");return '<p style="margin:14px 0"><strong>'+(down?"🔴 ":"🟢 ")+htmlEsc(m.name||m.id)+'</strong><br>'+(en?(down?"Service may be unavailable.":"Service has recovered."):(down?"监控发现服务可能不可用。":"监控发现服务已恢复正常。"))+'<br>'+(en?"URL":"地址")+'：'+htmlEsc(m.url||"")+'<br>'+(en?"Result":"当前结果")+'：'+htmlEsc(detail)+'<br>'+(en?"Checked":"检查时间")+'：'+htmlEsc(m.last_check||new Date().toISOString())+'</p>'}).join(""),subject=(en?(downList.length?"🔴 "+downList.length+" service(s) down":"🟢 Services recovered"):(downList.length?"🔴 "+downList.length+" 个服务异常":"🟢 服务已恢复"))+(changed.length>1?(en?" ("+changed.length+" changes)":"（共 "+changed.length+" 项变化）"):"");await mail(env,sub.email,subject,rows,un);sent++}return respond({ok:true,notifications:sent})}return respond({error:"Not found"},404)}catch(e){return respond({error:"Internal error",detail:String(e.message||e).slice(0,180)},500)}}};
"use strict";(function(){"use strict";
// Client half of the login card on the secret-entry page. Every dynamic
// string lives in the double table below and mirrors the server catalog
// (login.*); the locale comes from the server-rendered data attribute,
// falling back to <html lang>. The admin panel keeps its own minified
// binding in admin.js — this module only ever loads on the secret-entry
// page, and is fully self-contained (own fetch wrapper + esc).
var MSGS={
  zh:{
    title:"欢迎回来",
    sub:"登录以管理你的站点内容",
    title_codelogin:"验证码登录",
    sub_codelogin:"使用邮箱或手机验证码免密登录",
    title_forgot:"找回密码",
    sub_forgot:"输入邮箱或昵称，向绑定邮箱发送重置码",
    title_twofa:"两步验证",
    sub_twofa:"输入动态码或恢复码完成登录",
    submit:"登 录",
    submit_codelogin:"验证码登录",
    submit_forgot:"发送重置码",
    submit_twofa:"验证并登录",
    submit_reset_sent:"重置密码",
    target_sms:"登录手机号",
    target_email:"登录邮箱",
    target_ph_sms:"账号绑定的手机号",
    target_ph_email:"账号绑定的邮箱",
    send_code:"发送验证码",
    countdown:"{n}s 后重发",
    err_target_sms:"请先填写手机号",
    err_target_email:"请先填写邮箱",
    sent_sms:"若该手机号已注册，登录码已发送，10 分钟内有效。",
    sent_email:"若该邮箱已注册，登录码已发送，10 分钟内有效。",
    reset_sent:"若该账号存在且绑定了邮箱，重置码已发送，10 分钟内有效。",
    reset_done:"密码已重置，请使用新密码登录。",
    oauth_or:"其他登录方式",
    oauth_use:"使用 {x} 登录",
    req_fail:"请求失败 ({n})"
  },
  en:{
    title:"Welcome back",
    sub:"Sign in to manage your site content",
    title_codelogin:"Code sign-in",
    sub_codelogin:"Sign in without a password using an email or SMS code",
    title_forgot:"Reset password",
    sub_forgot:"Enter your email or nickname to send a reset code to the bound inbox",
    title_twofa:"Two-step verification",
    sub_twofa:"Enter your authenticator or recovery code to finish signing in",
    submit:"Sign in",
    submit_codelogin:"Sign in",
    submit_forgot:"Send reset code",
    submit_twofa:"Verify and sign in",
    submit_reset_sent:"Reset password",
    target_sms:"Account phone",
    target_email:"Account email",
    target_ph_sms:"Phone number bound to your account",
    target_ph_email:"Email bound to your account",
    send_code:"Send code",
    countdown:"Resend in {n}s",
    err_target_sms:"Enter your phone number first",
    err_target_email:"Enter your email first",
    sent_sms:"If that phone number is registered, the login code has been sent and is valid for 10 minutes.",
    sent_email:"If that email is registered, the login code has been sent and is valid for 10 minutes.",
    reset_sent:"If that account exists and has a bound inbox, the reset code has been sent and is valid for 10 minutes.",
    reset_done:"Password reset. Please sign in with your new password.",
    oauth_or:"Other sign-in methods",
    oauth_use:"Sign in with {x}",
    req_fail:"Request failed ({n})"
  }
};
function loc(e){var a=e&&e.getAttribute?e.getAttribute("data-oboe-login-locale"):"";if(a!=="en"&&a!=="zh-CN"){var d=typeof document!=="undefined"&&document.documentElement?document.documentElement.getAttribute("lang"):"";a=d==="en"?"en":"zh-CN"}return a}
function M(e,t){return(loc(e)==="en"?MSGS.en:MSGS.zh)[t]}
function T(e,t,n){var s=M(e,t);return n===undefined?s:s.split("{n}").join(n)}
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
function api(method,url,body,root){
  var h={"x-locale":loc(root)};
  if(body!==undefined)h["Content-Type"]="application/json";
  return fetch(url,{method:method,headers:h,body:body!==undefined?JSON.stringify(body):undefined}).then(async function(r){
    var j=null;try{j=await r.json()}catch{}
    if(!r.ok){var m=j&&j.error||T(root,"req_fail",r.status),e=new Error(m);throw e.status=r.status,e}
    return j
  })
}
function S(){
var root=document.querySelector("[data-login-root]");
if(!root||root.__loginCardBound)return;
root.__loginCardBound=!0;
var form=root.querySelector("form[data-adm-form=login]");
if(!form)return;
var msg=root.querySelector("[data-adm-msg]"),btn=root.querySelector("[data-login-submit]");
var st={mode:"login",channels:{email:!1,sms:!1},channel:"email",ticket:"",resetSent:!1,cd:0,cdTimer:null,captchaOn:!1,captchaNonce:0};
function setMsg(text,ok){msg&&(msg.textContent=text||"",msg.style.color=ok?"#4ade80":ok===!1?"#fca5a5":"")}
function paint(){
  var mode=st.mode;
  form.setAttribute("data-login-mode",mode);
  root.querySelectorAll("[data-login-show]").forEach(function(el){
    var show=" "+(el.getAttribute("data-login-show")||"")+" ";
    el.hidden=show.indexOf(" "+mode+" ")<0;
  });
  var titles={
    login:[T(root,"title"),T(root,"sub")],
    codelogin:[T(root,"title_codelogin"),T(root,"sub_codelogin")],
    forgot:[T(root,"title_forgot"),T(root,"sub_forgot")],
    twofa:[T(root,"title_twofa"),T(root,"sub_twofa")]
  };
  var m=titles[mode]||titles.login;
  root.querySelector("[data-login-title]").textContent=m[0];
  root.querySelector("[data-login-sub]").textContent=m[1];
  var labels={
    login:T(root,"submit"),
    codelogin:T(root,"submit_codelogin"),
    forgot:T(root,"submit_forgot"),
    twofa:T(root,"submit_twofa")
  };
  btn.textContent=mode==="forgot"&&st.resetSent?T(root,"submit_reset_sent"):(labels[mode]||labels.login);
  var tl=root.querySelector("[data-login-target-label]");
  if(tl)tl.textContent=st.channel==="sms"?T(root,"target_sms"):T(root,"target_email");
  var tgt=form.target;
  if(tgt){tgt.type=st.channel==="sms"?"tel":"email";tgt.placeholder=st.channel==="sms"?T(root,"target_ph_sms"):T(root,"target_ph_email")}
  var cap=root.querySelector("[data-login-captcha]");
  if(cap&&st.captchaOn)cap.hidden=mode==="forgot"&&st.resetSent;
}
function refreshCaptcha(){
  st.captchaNonce=Date.now();
  var img=root.querySelector("[data-login-captcha-img]");
  if(img)img.src="/api/captcha/image?t="+st.captchaNonce+"&l="+encodeURIComponent(loc(root));
  if(form.captcha)form.captcha.value="";
  if(form.captchaToken)form.captchaToken.value="";
}
api("GET","/api/captcha",undefined,root).then(function(cfg){
  st.captchaOn=!!cfg.enabled;
  var box=root.querySelector("[data-login-captcha]");
  if(!box||!st.captchaOn)return;
  var builtin=cfg.mode!=="custom";
  var b=root.querySelector("[data-login-captcha-builtin]"),im=root.querySelector("[data-login-captcha-img]"),c=root.querySelector("[data-login-captcha-custom]");
  if(b)b.hidden=!builtin;
  if(im)im.hidden=!builtin;
  if(c)c.hidden=builtin;
  box.hidden=!1;
  if(builtin)refreshCaptcha();
}).catch(function(){});
try{var oe=new URLSearchParams(window.location.search).get("oauth_error");if(oe)setMsg(oe,!1)}catch{}
api("GET","/api/oauth/providers",undefined,root).then(function(list){
  var wrap=root.querySelector("[data-login-oauth]");
  if(!wrap||!Array.isArray(list)||!list.length)return;
  var html='<div style="display:flex;align-items:center;gap:10px;margin:16px 0 10px;font-size:11px;color:var(--adm-faint);"><span style="flex:1;height:1px;background:currentColor;opacity:.25;"></span>'+esc(T(root,"oauth_or"))+'<span style="flex:1;height:1px;background:currentColor;opacity:.25;"></span></div><div style="display:grid;gap:8px;">';
  list.forEach(function(p){
    var name=String(p.label||p.key);
    html+='<a class="adm-btn adm-btn-ghost adm-btn-block" style="display:flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;" href="/api/oauth/'+encodeURIComponent(p.key)+'/start"><span style="width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;background:'+(p.color||"#6366F1")+';">'+esc(name.slice(0,1))+"</span>"+esc(T(root,"oauth_use").split("{x}").join(name))+"</a>";
  });
  wrap.innerHTML=html+"</div>";
  wrap.hidden=!1;
}).catch(function(){});
function switchMode(mode){
  st.mode=mode;
  if(mode!=="forgot")st.resetSent=!1;
  if(mode!=="twofa")st.ticket="";
  setMsg("");
  paint();
  var first=root.querySelector('[data-login-show~="'+mode+'"]:not([hidden]) input');
  if(first)first.focus();
}
function startCountdown(){
  st.cd=60;
  var b=root.querySelector('[data-adm-act="login-send-code"]');
  if(st.cdTimer)clearInterval(st.cdTimer);
  st.cdTimer=setInterval(function(){
    st.cd-=1;
    if(!b)return;
    if(st.cd<=0){clearInterval(st.cdTimer);b.disabled=!1;b.textContent=T(root,"send_code")}
    else{b.disabled=!0;b.textContent=T(root,"countdown",st.cd)}
  },1e3);
  if(b){b.disabled=!0;b.textContent=T(root,"countdown",60)}
}
function sendCode(){
  var target=String(form.target.value||"").trim();
  if(!target){setMsg(st.channel==="sms"?T(root,"err_target_sms"):T(root,"err_target_email"),!1);return}
  var b=root.querySelector('[data-adm-act="login-send-code"]');
  b.disabled=!0;
  api("POST","/api/auth/send-code",{channel:st.channel,target:target,purpose:"login"},root).then(function(){
    startCountdown();
    setMsg(st.channel==="sms"?T(root,"sent_sms"):T(root,"sent_email"),!0);
  }).catch(function(err){
    b.disabled=!1;
    setMsg(err.message,!1);
  });
}
function toTwoFa(res){
  st.ticket=res.ticket||"";
  st.mode="twofa";
  setMsg("");
  paint();
  var f=form.twoFaCode;
  if(f){f.value="";f.focus()}
}
function submit(){
  var mode=st.mode;
  var account=String(form.account.value||"").trim();
  var captcha="";
  if(st.captchaOn)captcha=form.captcha&&!form.captcha.hidden?form.captcha.value:(form.captchaToken?form.captchaToken.value:"");
  btn.disabled=!0;
  var done=function(){btn.disabled=!1;if(st.captchaOn&&form.captcha&&!form.captcha.hidden)refreshCaptcha()};
  if(mode==="twofa"){
    api("POST","/api/auth/login-2fa",{ticket:st.ticket,code:String(form.twoFaCode.value||"").replace(/\s/g,"")},root).then(function(){
      setMsg("",!0);
      window.location.href="/admin";
    }).catch(function(err){setMsg(err.message,!1);done()});
    return;
  }
  if(mode==="codelogin"){
    api("POST","/api/auth/login-code",{channel:st.channel,target:String(form.target.value||"").trim(),code:String(form.code.value||"").trim(),captcha:captcha},root).then(function(res){
      if(res.twoFactorRequired){btn.disabled=!1;toTwoFa(res);return}
      setMsg("",!0);
      window.location.href="/admin";
    }).catch(function(err){setMsg(err.message,!1);done()});
    return;
  }
  if(mode==="forgot"){
    if(!st.resetSent){
      api("POST","/api/auth/forgot",{account:account,captcha:captcha},root).then(function(){
        st.resetSent=!0;
        setMsg(T(root,"reset_sent"),!0);
        btn.disabled=!1;
        paint();
      }).catch(function(err){setMsg(err.message,!1);done()});
      return;
    }
    api("POST","/api/auth/reset",{account:account,code:String(form.resetCode.value||"").trim(),password:String(form.resetPassword.value||"")},root).then(function(){
      setMsg(T(root,"reset_done"),!0);
      switchMode("login");
      form.password.value="";
      btn.disabled=!1;
    }).catch(function(err){setMsg(err.message,!1);done()});
    return;
  }
  api("POST","/api/auth/login",{account:account,password:String(form.password.value||""),captcha:captcha},root).then(function(res){
    if(res.twoFactorRequired){btn.disabled=!1;toTwoFa(res);return}
    setMsg("",!0);
    window.location.href="/admin";
  }).catch(function(err){setMsg(err.message,!1);done()});
}
form.__loginSubmit=submit;
root.addEventListener("click",function(ev){
  if(ev.target.hasAttribute&&ev.target.hasAttribute("data-login-captcha-img")){refreshCaptcha();return}
  var act=ev.target.closest?ev.target.closest("[data-adm-act]"):null;
  if(!act||!root.contains(act))return;
  var v=act.getAttribute("data-adm-act");
  if(v==="login-forgot")switchMode("forgot");
  else if(v==="login-codelogin")switchMode("codelogin");
  else if(v==="login-back"||v==="login-2fa-back")switchMode("login");
  else if(v==="login-send-code")sendCode();
});
api("GET","/api/auth/login-config",undefined,root).then(function(cfg){
  st.channels={email:!!cfg.email,sms:!!cfg.sms};
  if(!st.channels.email&&st.channels.sms)st.channel="sms";
  var link=root.querySelector('[data-adm-act="login-codelogin"]');
  if(link)link.hidden=!(st.channels.email||st.channels.sms);
  paint();
}).catch(function(){});
paint();
window.addEventListener("pagehide",function(){if(st.cdTimer)clearInterval(st.cdTimer)});
}
if(typeof document!=="undefined"&&typeof document.addEventListener==="function"){document.readyState==="loading"?document.addEventListener("DOMContentLoaded",S):S()}
if(typeof module!=="undefined"&&module.exports){module.exports={MSGS:MSGS,loc:loc,M:M,T:T,esc:esc}}
})();

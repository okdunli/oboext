"use strict";(function(){"use strict";
// Client half of the registration form. Every string lives in the double
// table below and mirrors the server catalog (reg.*); the locale comes from
// the server-rendered data attribute, falling back to <html lang>.
var MSGS={
  zh:{
    send_code:"发送验证码",
    countdown:"{n}s 后重发",
    err_email_first:"请先填写邮箱",
    err_phone_first:"请先填写手机号",
    sent_ok:"验证码已发送，10 分钟内有效",
    send_fail:"发送失败，请稍后再试",
    net_err:"网络异常，请稍后再试",
    err_name_min:"昵称至少 2 个字符",
    err_name_max:"昵称最多 32 个字符",
    err_password_min:"密码至少 8 位",
    err_password_required:"请填写密码",
    err_email_required:"请填写邮箱",
    err_phone_required:"请填写手机号",
    err_email_code:"请填写邮箱验证码",
    err_phone_code:"请填写手机验证码",
    err_invite:"请填写邀请码",
    submitting:"注册中…",
    ok_redirect:"注册成功，正在进入…",
    fail:"注册失败，请稍后再试",
    submit:"注 册"
  },
  en:{
    send_code:"Send code",
    countdown:"Resend in {n}s",
    err_email_first:"Enter your email first",
    err_phone_first:"Enter your phone number first",
    sent_ok:"Code sent, valid for 10 minutes",
    send_fail:"Failed to send, please try again later",
    net_err:"Network error, please try again later",
    err_name_min:"Nickname must be at least 2 characters",
    err_name_max:"Nickname must be at most 32 characters",
    err_password_min:"Password must be at least 8 characters",
    err_password_required:"Please enter a password",
    err_email_required:"Please enter your email",
    err_phone_required:"Please enter your phone number",
    err_email_code:"Please enter the email code",
    err_phone_code:"Please enter the SMS code",
    err_invite:"Please enter the invite code",
    submitting:"Signing up...",
    ok_redirect:"Registered, entering...",
    fail:"Registration failed, please try again later",
    submit:"Sign up"
  }
};
function loc(e){var a=e&&e.getAttribute?e.getAttribute("data-oboe-reg-locale"):"";if(a!=="en"&&a!=="zh-CN"){var d=typeof document!=="undefined"&&document.documentElement?document.documentElement.getAttribute("lang"):"";a=d==="en"?"en":"zh-CN"}return a}
function M(e,t){return(loc(e)==="en"?MSGS.en:MSGS.zh)[t]}
function T(e,t,n){var s=M(e,t);return n===undefined?s:s.split("{n}").join(n)}
function S(){
var e=document.querySelector("form[data-oboe-reg]");
if(!e)return;
var f=e.querySelector("[data-oboe-reg-msg]"),s=e.querySelector("[data-oboe-reg-submit]"),d=function(a){return e.getAttribute(a)==="1"},h=[];
function r(a,t){f&&(f.textContent=a||"",f.style.color=t?"#16a34a":"#dc2626")}
function g(a){var t=60;a.disabled=!0;var i=setInterval(function(){t-=1,t<=0?(clearInterval(i),a.disabled=!1,a.textContent=T(e,"send_code")):a.textContent=T(e,"countdown",t)},1e3);h.push(i)}
function C(a,t){var i=a==="email"?(e.email.value||"").trim():(e.phone.value||"").trim();if(!i){r(a==="email"?T(e,"err_email_first"):T(e,"err_phone_first"),!1);return}t.disabled=!0,fetch("/api/auth/send-code",{method:"POST",headers:{"Content-Type":"application/json","x-locale":loc(e)},body:JSON.stringify({channel:a,target:i,purpose:"register"})}).then(async function(o){if(o.ok){g(t),r(T(e,"sent_ok"),!0);return}var l={};try{l=await o.json()}catch{}t.disabled=!1,r(l.error||T(e,"send_fail"),!1)}).catch(function(){t.disabled=!1,r(T(e,"net_err"),!1)})}
e.addEventListener("click",function(a){if(a.target.hasAttribute&&a.target.hasAttribute("data-oboe-reg-captcha-img")){a.target.src="/api/captcha/image?t="+Date.now();var t=e.querySelector("[name=captcha]");t&&(t.value="");return}var i=a.target.closest?a.target.closest("[data-oboe-reg-send]"):null;!i||!e.contains(i)||i.disabled||C(i.getAttribute("data-oboe-reg-send"),i)});
function v(){var a=e.querySelector("[data-oboe-reg-captcha-img]");a&&(a.src="/api/captcha/image?t="+Date.now()),e.captcha&&(e.captcha.value="")}
e.addEventListener("submit",function(a){a.preventDefault(),r("");var t=(e.name.value||"").trim(),i=(e.email.value||"").trim(),o=(e.phone.value||"").trim(),l=e.password.value||"",c=e.inviteCode?(e.inviteCode.value||"").trim():"";if(d("data-name-required")&&t.length<2)return r(T(e,"err_name_min"),!1);if(t&&t.length>32)return r(T(e,"err_name_max"),!1);if(l&&l.length<8)return r(T(e,"err_password_min"),!1);if(d("data-password-required")&&!l)return r(T(e,"err_password_required"),!1);if(d("data-email-required")&&!i)return r(T(e,"err_email_required"),!1);if(d("data-phone-required")&&!o)return r(T(e,"err_phone_required"),!1);if(e.emailCode&&i&&!(e.emailCode.value||"").trim())return r(T(e,"err_email_code"),!1);if(e.phoneCode&&o&&!(e.phoneCode.value||"").trim())return r(T(e,"err_phone_code"),!1);if(d("data-invite-only")&&!c)return r(T(e,"err_invite"),!1);var u="";e.captcha&&!e.captcha.hidden?u=e.captcha.value:e.captchaToken&&(u=e.captchaToken.value),s.disabled=!0,s.textContent=T(e,"submitting");var n={};t&&(n.name=t),i&&(n.email=i),o&&(n.phone=o),l&&(n.password=l),c&&(n.inviteCode=c),e.emailCode&&i&&(n.emailCode=(e.emailCode.value||"").trim()),e.phoneCode&&o&&(n.phoneCode=(e.phoneCode.value||"").trim()),u&&(n.captcha=u),fetch("/api/auth/register",{method:"POST",headers:{"Content-Type":"application/json","x-locale":loc(e)},body:JSON.stringify(n)}).then(async function(p){if(p.ok){r(T(e,"ok_redirect"),!0),window.location.href=loc(e)==="en"?"/en/":"/";return}var m={};try{m=await p.json()}catch{}r(m.error||T(e,"fail"),!1),v()}).catch(function(){r(T(e,"net_err"),!1),v()}).finally(function(){s.disabled=!1,s.textContent=T(e,"submit")})}),window.addEventListener("pagehide",function(){h.forEach(clearInterval)})
}
if(typeof document!=="undefined"&&typeof document.addEventListener==="function"){document.readyState==="loading"?document.addEventListener("DOMContentLoaded",S):S()}
if(typeof module!=="undefined"&&module.exports){module.exports={MSGS:MSGS,loc:loc,M:M,T:T}}
})();

import { definePlugin } from "../../oboext/src/server/plugin-api.js";
import { verifyCommentCaptcha } from "../../oboext/src/server/comment-captcha.js";

type Settings = {

  guestsOnly?: boolean;
};

type SubmissionPayload = {
  data: {
    captchaToken?: unknown;
    captchaAnswer?: unknown;
    [k: string]: unknown;
  };
  userId: number | null;
  ip: string | null;
  reject?: string;
};

function clientScript(guestsOnly: boolean): string {
  const cfg = JSON.stringify({ g: guestsOnly });
  /* Every visual value is a CSS custom property with a sane fallback, so a
     theme restyles the captcha by overriding the block under its own selector
     (e.g. `.th-bluemix .ccap-row{ --ccap-h:44px; --ccap-radius:6px }`) without
     touching this plugin. Layout/behavior live in JS; looks live in CSS. */
  return `<style>
.ccap-row{
  --ccap-h:40px; --ccap-radius:8px; --ccap-gap:10px;
  --ccap-img-w:104px; --ccap-ans-w:132px;
  --ccap-border:rgba(127,127,127,.35); --ccap-focus:var(--primary-color,#5b8cff);
  --ccap-ok:#2ea043; --ccap-err:#e5484d; --ccap-ink:inherit;
  display:inline-flex;align-items:center;gap:var(--ccap-gap);flex-wrap:wrap;
  margin:0 12px 0 0;vertical-align:middle;
}
.ccap-img{
  width:var(--ccap-img-w);height:var(--ccap-h);border-radius:var(--ccap-radius);
  border:1px solid var(--ccap-border);cursor:pointer;display:block;background:#fff;
  user-select:none;flex:none;
}
.ccap-field{ position:relative;display:inline-flex;align-items:center;width:var(--ccap-ans-w); }
.ccap-ans{
  width:100%;height:var(--ccap-h);padding:0 30px 0 12px;
  border-radius:var(--ccap-radius);border:1px solid var(--ccap-border);
  background:transparent;color:var(--ccap-ink);font:inherit;font-size:14px;outline:none;
}
.ccap-ans:focus{ border-color:var(--ccap-focus); }
/* ✓ / ✗ rendered INSIDE the field on its right edge. */
.ccap-state{
  position:absolute;right:10px;top:50%;transform:translateY(-50%);
  width:16px;height:16px;line-height:16px;text-align:center;border-radius:50%;
  font-size:12px;font-weight:700;color:#fff;pointer-events:none;
  opacity:0;transition:opacity .15s;
}
.ccap-field.is-ok .ccap-state{ opacity:1;background:var(--ccap-ok); }
.ccap-field.is-ok .ccap-state:before{ content:"\\2713"; }
.ccap-field.is-err .ccap-state{ opacity:1;background:var(--ccap-err); }
.ccap-field.is-err .ccap-state:before{ content:"\\2715"; }
.ccap-field.is-ok .ccap-ans{ border-color:var(--ccap-ok); }
.ccap-field.is-err .ccap-ans{ border-color:var(--ccap-err); }
.ccap-msg{ color:var(--ccap-err);font-size:12.5px; }
.ccap-row .btn-submit[disabled]{ opacity:.5;cursor:not-allowed; }
</style>
<script>(function(){
if(window.__ccap)return;window.__ccap=1;
var C=${cfg};
var cur={token:"",ans:null,field:null,msg:null,btn:null,skip:false};
function setMsg(t){if(cur.msg)cur.msg.textContent=t||"";}
function clearState(){
  if(cur.field)cur.field.classList.remove("is-ok","is-err");
  if(cur.btn)cur.btn.disabled=false;
}
function setState(cls,msg){
  if(cur.field){
    cur.field.classList.remove("is-ok","is-err");
    if(cls)cur.field.classList.add(cls);
  }
  /* Wrong answer locks the publish button; a correct/cleared state releases it. */
  if(cur.btn)cur.btn.disabled=(cls==="is-err");
  if(msg)setMsg(msg);
}
function refresh(){
  fetch("/api/comment-captcha",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
    if(!d||!d.token)return;
    cur.token=d.token;
    var img=document.querySelector(".ccap-img");
    if(img)img.src="data:image/svg+xml;charset=utf-8,"+encodeURIComponent(d.svg);
    if(cur.ans)cur.ans.value="";
    clearState();setMsg("");
  }).catch(function(){});
}
function check(){
  var a=cur.ans?cur.ans.value.trim():"";
  if(!a||!cur.token){ clearState();return; }
  var url="/api/comment-captcha?action=check&token="+encodeURIComponent(cur.token)+"&answer="+encodeURIComponent(a);
  fetch(url,{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
    if(!cur.ans||cur.ans.value.trim()!==a)return; /* stale */
    if(d&&d.ok)setState("is-ok","");
    else setState("is-err","验证码错误");
  }).catch(function(){});
}
function isLoggedIn(){
  return fetch("/api/auth/me",{cache:"no-store"})
    .then(function(r){return r.ok?r.json():null})
    .then(function(d){return !!(d&&d.user)})
    .catch(function(){return false;});
}
function mount(form){
  var row=document.createElement("div");row.className="ccap-row";
  var img=document.createElement("img");
  img.className="ccap-img";img.alt="验证码";img.title="看不清？点击更换";
  var field=document.createElement("span");field.className="ccap-field";
  var ans=document.createElement("input");
  ans.className="ccap-ans";ans.type="text";ans.maxLength=6;
  ans.setAttribute("inputmode","numeric");ans.autocomplete="off";
  ans.placeholder="验证码";
  var state=document.createElement("span");state.className="ccap-state";
  field.appendChild(ans);field.appendChild(state);
  var msg=document.createElement("span");msg.className="ccap-msg";
  row.appendChild(img);row.appendChild(field);row.appendChild(msg);
  /* Sit immediately to the LEFT of the publish button inside .form-actions,
     falling back to the actions row / form end. */
  var actions=form.querySelector(".form-actions");
  var submit=form.querySelector(".btn-submit");
  if(submit&&submit.parentNode)submit.parentNode.insertBefore(row,submit);
  else if(actions)actions.insertBefore(row,actions.firstChild);
  else form.appendChild(row);
  cur.ans=ans;cur.field=field;cur.msg=msg;cur.btn=submit;
  img.addEventListener("click",refresh);
  ans.addEventListener("input",function(){ clearState();setMsg(""); });
  ans.addEventListener("blur",check);
  form.addEventListener("submit",function(e){
    if(!ans.value.trim()){
      e.preventDefault();e.stopPropagation();
      setState("is-err","请输入图中算式的结果");ans.focus();
    }
  },true);
  refresh();
}
var pending=false;
function tick(){
  if(pending||cur.skip)return;
  var form=document.querySelector("form.comment-form");
  if(!form||form.querySelector(".ccap-row"))return;
  pending=true;
  var gate=C.g?isLoggedIn():Promise.resolve(false);
  gate.then(function(loggedIn){
    pending=false;
    var f=document.querySelector("form.comment-form");
    if(!f||f.querySelector(".ccap-row"))return;
    if(loggedIn){cur.skip=true;return;}
    mount(f);
  });
}
var ofetch=window.fetch;
window.fetch=function(input,init){
  var url=typeof input==="string"?input:((input&&input.url)||"");
  var method=((init&&init.method)||(typeof input!=="string"&&input&&input.method)||"GET");
  if(String(method).toUpperCase()==="POST"&&/\\/api\\/comments(?:\\?|$)/.test(url)){
    if(init&&typeof init.body==="string"){
      try{
        var b=JSON.parse(init.body);
        b.captchaToken=cur.token||"";
        b.captchaAnswer=cur.ans?cur.ans.value.trim():"";
        init=Object.assign({},init,{body:JSON.stringify(b)});
      }catch(e){}
    }
    return ofetch.call(this,input,init).then(function(res){refresh();return res;},function(err){refresh();throw err;});
  }
  return ofetch.apply(this,arguments);
};
setInterval(tick,800);tick();
})();</script>`;
}

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    addFilter<SubmissionPayload>(HOOKS.commentSubmission, async (payload) => {
      if (payload.reject) return payload;

      const guestsOnly = settings.guestsOnly !== false;
      if (guestsOnly && payload.userId != null) return payload;

      const token = typeof payload.data.captchaToken === "string" ? payload.data.captchaToken : "";
      const answer = typeof payload.data.captchaAnswer === "string" ? payload.data.captchaAnswer : "";
      if (!verifyCommentCaptcha(token, answer)) {
        payload.reject = "请正确完成验证码";
      }
      return payload;
    });

    addFilter<{ html: string[] }>(HOOKS.footerHtml, (payload) => {
      payload.html.push(clientScript(settings.guestsOnly !== false));
      return payload;
    });
  },
});

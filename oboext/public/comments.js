"use strict";(function(){"use strict";var MSGS={zh:{lang:"zh-CN",label:"\u8BC4\u8BBA",submit:"\u53D1\u8868\u8BC4\u8BBA",submit_reply:"\u56DE\u590D\u8BC4\u8BBA",err_content:"\u8BF7\u586B\u5199\u8BC4\u8BBA\u5185\u5BB9\uFF01",err_name:"\u6635\u79F0\u5FC5\u586B\uFF01",err_email:"\u90AE\u7BB1\u5FC5\u586B\uFF01",err_url:"\u94FE\u63A5\u5FC5\u586B\uFF01",err_email_format:"\u8BF7\u8F93\u5165\u6B63\u786E\u7684\u90AE\u7BB1\u683C\u5F0F\uFF01",anonymous:"\u533F\u540D",ok_published:"\u8BC4\u8BBA\u5DF2\u53D1\u5E03",ok_pending:"\u8BC4\u8BBA\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u5BA1\u6838",err_fail:"\u63D0\u4EA4\u5931\u8D25",provider_unconfigured:"\u672A\u914D\u7F6E\u7B2C\u4E09\u65B9\u8BC4\u8BBA\u670D\u52A1\u53C2\u6570\uFF0C\u8BF7\u5728\u300C\u7AD9\u70B9\u8BBE\u7F6E \u2192 \u8BC4\u8BBA\u300D\u4E2D\u586B\u5199\u3002",placeholder_waline:"\u8BF4\u70B9\u4EC0\u4E48\u5427\uFF5E"},en:{lang:"en",label:"Comment",submit:"Post comment",submit_reply:"Reply",err_content:"Please write a comment.",err_name:"Nickname is required.",err_email:"Email is required.",err_url:"Link is required.",err_email_format:"Please enter a valid email address.",anonymous:"Anonymous",ok_published:"Comment published.",ok_pending:"Comment submitted, awaiting review.",err_fail:"Submission failed.",provider_unconfigured:"The third-party comment service is not configured. Fill it in under Site Settings > Comments.",placeholder_waline:"Say something~"}};function M(e,t){var a=e&&e.getAttribute?e.getAttribute("data-comment-locale"):"";if(a!=="en"&&a!=="zh-CN"){var d=typeof document!=="undefined"&&document.documentElement?document.documentElement.getAttribute("lang"):"";a=d==="en"?"en":"zh-CN"}return(a==="en"?MSGS.en:MSGS.zh)[t]}function L(e){var a=e&&e.getAttribute?e.getAttribute("data-comment-locale"):"";if(a!=="en"&&a!=="zh-CN"){var d=typeof document!=="undefined"&&document.documentElement?document.documentElement.getAttribute("lang"):"";a=d==="en"?"en":"zh-CN"}return a}function s(e,t){var a=e.querySelector("[data-comment-notice]")||document.querySelector("[data-comment-notice]");a&&(a.textContent=t,a.style.display=t?"block":"none")}function f(e,t){var a=e.querySelector('input[name="parentId"]');a&&(a.value=t||"");var r=e.querySelector("[data-comment-cancel]");r&&(r.style.display=t?"inline-flex":"none");var i=e.querySelector("[data-submit-label]");i&&(i.textContent=t?M(e,"submit_reply"):M(e,"submit"))}function j(e){var t=e.querySelector(".input")||e;try{t.scrollIntoView({behavior:"smooth",block:"center"})}catch{t.scrollIntoView()}var a=e.querySelector("textarea");a&&a.focus({preventScroll:!0})}async function k(e){var t=e.querySelector('textarea[name="content"]'),a=t?t.value.trim():"",r=e.getAttribute("data-require")==="1",i=!!e.querySelector('input[name="authorName"]'),n=e.querySelector('input[name="authorName"]'),o=e.querySelector('input[name="authorEmail"]'),c=e.querySelector('input[name="authorUrl"]'),u=n?n.value.trim():"",d=o?o.value.trim():"",b=c?c.value.trim():"";if(!a)return s(e,M(e,"err_content"));if(i&&r&&!u)return s(e,M(e,"err_name"));if(i&&r&&!d)return s(e,M(e,"err_email"));if(i&&e.getAttribute("data-require-url")==="1"&&!b)return s(e,M(e,"err_url"));if(i&&d&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d))return s(e,M(e,"err_email_format"));var m={postId:Number(e.getAttribute("data-post-id")),postType:e.getAttribute("data-post-type")||"post",content:t.value},h=e.querySelector('input[name="parentId"]');h&&h.value&&(m.parentId=Number(h.value)),i&&(m.authorName=u||M(e,"anonymous"),d&&(m.authorEmail=d),b&&(m.authorUrl=b));var v=e.querySelector(".btn-submit");v&&(v.disabled=!0);try{var E=await fetch("/api/comments",{method:"POST",headers:{"Content-Type":"application/json","x-locale":L(e)},body:JSON.stringify(m)}),A=await E.json().catch(function(){return{}});E.ok?A.isPublic?(s(e,M(e,"ok_published")),t.value="",f(e,null),loadThread(e)):(t.value="",f(e,null),s(e,M(e,"ok_pending"))):s(e,A.error||M(e,"err_fail"))}catch{s(e,M(e,"err_fail"))}finally{v&&(v.disabled=!1)}}var p=null;function L(){return p||(p=fetch("/api/emojis").then(function(e){return e.ok?e.json():null})),p}function T(e){var t=document.createElement("span");t.className="emoji-panel",t.onmousedown=function(i){i.preventDefault()};var a=Object.keys(e).map(function(i){return{name:i,items:e[i]}}),r='<div class="panel">';return a.forEach(function(i,n){r+='<section class="emoji-group" data-emoji-group="'+n+'"><div class="title">'+i.name+'</div><div class="emoji-grid">'+i.items.map(function(o){return'<button type="button" class="emoji" data-emoji="'+o+'">'+o+"</button>"}).join("")+"</div></section>"}),r+="</div>",r+='<div class="tabs">'+a.map(function(i,n){return'<button type="button" class="emoji-tab'+(n===0?" active":"")+'" title="'+i.name+'" data-emoji-tab="'+n+'">'+i.items[0]+"</button>"}).join("")+"</div>",t.innerHTML=r,t}function g(e){if(e){var t=e.querySelector(".emoji-panel");if(t){var a=e.getBoundingClientRect(),r=t.offsetHeight||320,i=a.top,n=window.innerHeight-a.bottom;i<r+12&&n>r+12?e.classList.add("is-below"):e.classList.remove("is-below")}}}function w(e,t){e.querySelectorAll("[data-emoji-tab]").forEach(function(a,r){a.classList.toggle("active",r===t)})}function N(e,t){var a=e.querySelectorAll("[data-emoji-group]"),r=t.scrollTop+10,i=0;a.forEach(function(n,o){n.offsetTop<=r&&(i=o)}),w(e,i)}async function x(e){var t=e.querySelector("[data-emoji-panel]");if(t){var a=t.classList.contains("is-in"),r=e.querySelector("[data-comment-emoji]"),i=t.querySelector(".panel");if(a){t.classList.remove("is-in"),t.setAttribute("aria-hidden","true"),r&&r.classList.remove("is-active");return}if(!i){var n=await L();if(!n||!t.isConnected)return;t.appendChild(T(n)),i=t.querySelector(".panel"),t.querySelectorAll("[data-emoji-tab]").forEach(function(o){o.addEventListener("click",function(){var c=t.querySelector('[data-emoji-group="'+o.getAttribute("data-emoji-tab")+'"]');c&&i&&(i.scrollTop=c.offsetTop,w(t,Number(o.getAttribute("data-emoji-tab"))))})}),i&&i.addEventListener("scroll",function(){N(t,i)})}g(t),t.offsetWidth,t.classList.add("is-in"),t.setAttribute("aria-hidden","false"),r&&r.classList.add("is-active")}}function C(e,t){var a=e.querySelector('textarea[name="content"]');if(a){var r=a.selectionStart!=null?a.selectionStart:a.value.length,i=a.selectionEnd!=null?a.selectionEnd:a.value.length;a.value=a.value.slice(0,r)+t+a.value.slice(i);var n=r+t.length;a.focus(),a.setSelectionRange(n,n)}}function l(e){if(!(e.id&&document.getElementById(e.id))){var t=document.createElement("script");e.id&&(t.id=e.id),t.src=e.src,t.async=!0,Object.keys(e.attrs||{}).forEach(function(a){t.setAttribute(a,e.attrs[a])}),e.onLoad&&t.addEventListener("load",e.onLoad),(e.appendTo||document.body).appendChild(t)}}function y(e){return typeof window[e]<"u"}function I(e){if(!e.getAttribute("data-injected")){e.setAttribute("data-injected","1");var t;try{t=JSON.parse(e.getAttribute("data-config")||"{}")}catch{return}var a=e.getAttribute("data-comment-provider");if(a==="giscus"&&t.giscus&&t.giscus.repo){var r={src:"https://giscus.app/client.js","data-repo":t.giscus.repo,"data-repo-id":t.giscus.repoId,"data-category":t.giscus.category,"data-category-id":t.giscus.categoryId,"data-mapping":t.giscus.mapping,"data-strict":"0","data-reactions-enabled":t.giscus.reactions?"1":"0","data-emit-metadata":"0","data-input-position":"bottom","data-lang":M(e,"lang"),"data-theme":t.giscus.theme||"preferred_color_scheme",crossorigin:"anonymous"};l({src:r.src,id:"giscus-script",attrs:r,appendTo:e})}else if(a==="utterances"&&t.utterances&&t.utterances.repo)l({src:"https://utteranc.es/client.js",id:"utterances-script",attrs:{repo:t.utterances.repo,"issue-term":t.utterances.term,label:M(e,"label"),theme:"preferred-color-scheme",crossorigin:"anonymous"},appendTo:e});else if(a==="artalk"&&t.artalk&&t.artalk.server){l({src:"https://cdn.jsdelivr.net/npm/artalk@2/dist/Artalk.js",id:"artalk-script",appendTo:e,onLoad:function(){y("Artalk")&&window.Artalk.init({el:e,server:t.artalk.server,site:t.artalk.site||location.hostname})}});var i=document.createElement("link");i.id="artalk-style",i.rel="stylesheet",i.href="https://cdn.jsdelivr.net/npm/artalk@2/dist/Artalk.css",document.head.appendChild(i)}else if(a==="waline"&&t.waline&&t.waline.server){l({src:"https://cdn.jsdelivr.net/npm/@waline/client@v3/dist/waline.js",id:"waline-script",appendTo:e,onLoad:function(){y("Waline")&&window.Waline.init({el:e,serverURL:t.waline.server,path:location.pathname,reaction:!0,locale:{placeholder:M(e,"placeholder_waline")}})}});var n=document.createElement("link");n.id="waline-style",n.rel="stylesheet",n.href="https://cdn.jsdelivr.net/npm/@waline/client@v3/dist/waline.css",document.head.appendChild(n)}else a==="twikoo"&&t.twikoo&&t.twikoo.envId?l({src:"https://cdn.jsdelivr.net/npm/twikoo@1.6.41/dist/twikoo.all.min.js",id:"twikoo-script",appendTo:e,onLoad:function(){y("twikoo")&&window.twikoo.init({envId:t.twikoo.envId,el:e})}}):a==="disqus"&&t.disqus&&t.disqus.shortname?(window.disqus_config=function(){this.page.url=location.href,this.page.identifier=location.pathname},l({src:"https://"+t.disqus.shortname+".disqus.com/embed.js",id:"disqus-script",appendTo:e})):e.textContent=M(e,"provider_unconfigured")}}function q(e){(e||document).querySelectorAll("[data-comment-provider]").forEach(I)}function CLS(){try{return new Set(JSON.parse(localStorage.getItem("oboext_comment_likes")||"[]"))}catch{return new Set()}}function CLSave(s){try{localStorage.setItem("oboext_comment_likes",JSON.stringify(Array.from(s)))}catch{}}var CLcounts={};function CLmark(b,on){b.setAttribute("aria-pressed",on?"true":"false"),b.style.opacity=on?"1":".65"}function CLpaint(){var s=CLS();document.querySelectorAll("[data-comment-like]").forEach(function(b){var id=b.getAttribute("data-comment-like");CLmark(b,s.has(id))}),CLinit()}function CLinit(){var bs=document.querySelectorAll("[data-comment-like]"),ids=[];for(var i=0;i<bs.length&&ids.length<200;i++){var id=bs[i].getAttribute("data-comment-like"),n=Number(id);n>0&&CLcounts[id]===void 0&&ids.indexOf(id)<0&&ids.push(id)}if(!ids.length)return;fetch("/api/comment-like?ids="+encodeURIComponent(ids.join(","))).then(function(r){return r.ok?r.json():null}).then(function(d){if(!d||!d.counts)return;var s=CLS();for(var k in d.counts)CLcounts[k]=d.counts[k];document.querySelectorAll("[data-comment-like]").forEach(function(x){var id=x.getAttribute("data-comment-like"),c=x.querySelector("[data-comment-like-count]");c&&CLcounts[id]!==void 0&&(c.textContent=CLcounts[id]),CLmark(x,s.has(id))})}).catch(function(){})}async function CLhit(b,method){var id=b.getAttribute("data-comment-like");b.disabled=!0;try{var u="/api/comment-like";method==="DELETE"&&(u+="?commentId="+encodeURIComponent(id));var r=await fetch(u,{method:method,headers:method==="POST"?{"Content-Type":"application/json"}:void 0,body:method==="POST"?JSON.stringify({commentId:Number(id)}):void 0}),d=await r.json().catch(function(){return{}});if(!r.ok)return;var s=CLS(),on=method==="POST";on?s.add(id):s.delete(id),CLSave(s);var c=b.querySelector("[data-comment-like-count]");c&&(CLcounts[id]=d.likes,c.textContent=d.likes),CLmark(b,on)}catch{}finally{b.disabled=!1}}function CLclick(e){var b=e.target.closest&&e.target.closest("[data-comment-like]");if(b&&!b.disabled){var on=b.getAttribute("aria-pressed")==="true";e.preventDefault(),CLhit(b,on?"DELETE":"POST")}}function O(e){var lb=e.target.closest&&e.target.closest("[data-comment-like]");if(lb){CLclick(e);return}var t=e.target.closest&&e.target.closest("[data-comment-reply]");if(t){var a=t.closest("form[data-comment-form]")||document.querySelector("form[data-comment-form]");a&&(f(a,t.getAttribute("data-comment-reply")),j(a));return}var r=e.target.closest&&e.target.closest("[data-comment-cancel]");if(r){var i=r.closest("form");i&&(f(i,null),j(i));return}var n=e.target.closest&&e.target.closest("[data-emoji]");if(n&&n.closest("[data-emoji-panel]")){var o=n.closest("form");o&&C(o,n.getAttribute("data-emoji"));return}var c=e.target.closest&&e.target.closest("[data-comment-emoji]");if(c){var u=c.closest("form");u&&x(u)}}function F(e){var t=e.target.closest&&e.target.closest("form[data-comment-form]");t&&(e.preventDefault(),k(t))}function P(e){if(!(!e.target||e.target.tagName!=="TEXTAREA")){var t=e.target.closest("form[data-comment-form]"),a=t&&t.querySelector(".input");a&&a.classList.add("is_focused")}}function _(e){if(!(!e.target||e.target.tagName!=="TEXTAREA")){var t=e.target.closest("form[data-comment-form]"),a=t&&t.querySelector(".input");a&&a.classList.remove("is_focused")}}function B(e){var t=e.target.closest&&e.target.closest("[data-emoji-panel]"),a=e.target.closest&&e.target.closest("[data-comment-emoji]");t||a||document.querySelectorAll("[data-emoji-panel].is-in").forEach(function(r){r.classList.remove("is-in"),r.setAttribute("aria-hidden","true");var i=r.closest&&r.closest("form[data-comment-form]"),n=i&&i.querySelector("[data-comment-emoji]");n&&n.classList.remove("is-active")})}function S(){window.addEventListener("oboext-emoji-updated",function(){document.querySelectorAll("[data-emoji-panel].is-in").forEach(g)}),window.addEventListener("resize",function(){document.querySelectorAll("[data-emoji-panel].is-in").forEach(g)}),document.addEventListener("click",O),document.addEventListener("submit",F),document.addEventListener("focusin",P),document.addEventListener("focusout",_),document.addEventListener("mousedown",B),q(document),CLpaint();var e=new MutationObserver(function(t){for(var a=0;a<t.length;a++)for(var r=t[a].addedNodes,i=0;i<r.length;i++)r[i].nodeType===1&&r[i].querySelector&&(q(r[i]),r[i].querySelector("[data-comment-like]")&&CLpaint())});e.observe(document.body,{childList:!0,subtree:!0})}if(typeof document!=="undefined"&&typeof document.addEventListener==="function"){document.readyState==="loading"?document.addEventListener("DOMContentLoaded",S):S()}if(typeof module!=="undefined"&&module.exports){module.exports={MSGS:MSGS,M:M}}})();

/* Live hint: a reader who leaves the tab open misses new comments. A cheap
   poll (30s, paused while the tab is hidden) compares the comment count and
   shows a one-line "new comments - click to refresh" notice. It never
   re-renders the thread on its own: a reader mid-reply must not lose the
   text they typed. */
(function(){"use strict";
if(window.__cmtLiveBound)return;window.__cmtLiveBound=!0;
var POLL_MS=30000;
function form(){return document.querySelector("form[data-comment-form]");}
function count(){
  var f=form();
  if(!f)return 0;
  var list=f.parentNode?f.parentNode.querySelector(".comment-list"):null;
  return list?list.querySelectorAll("li[id^=comment-item-]").length:0;
}
function notice(){
  var f=form();
  if(!f)return null;
  // The notice div is the form's PREVIOUS SIBLING (render.ts emits it right
  // before the form), not a child of the form's parent in every theme - walk
  // up to the nearest common container and search it.
  var box=f.parentNode;
  for(var i=0;i<4&&box;i++,box=box.parentNode){
    var n=box.querySelector?box.querySelector("[data-comment-notice]"):null;
    if(n)return n;
  }
  return document.querySelector("[data-comment-notice]");
}
// The baseline is the server-rendered comment count (what the visitor can
// actually see). The API's total is only the comparison signal - anchoring
// the baseline on the API instead races the first poll.
var baseline=count();
function total(){
  // The DOM count never changes on its own (the thread is server-rendered),
  // so the signal has to come from the server: the API's total.
  var f=form();
  if(!f)return Promise.resolve(0);
  var pid=f.getAttribute("data-post-id");
  var pt=f.getAttribute("data-post-type")||"post";
  if(!pid)return Promise.resolve(0);
  return fetch("/api/comments?post="+encodeURIComponent(pid)+"&postType="+encodeURIComponent(pt),{credentials:"same-origin"})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){return d&&typeof d.total==="number"?d.total:null;})
    .catch(function(){return null;});
}
function loadThread(f){
  // Swap the thread in place instead of reloading the document: the reader
  // keeps their scroll position and anything they typed in the form.
  var pid=f.getAttribute("data-post-id");
  var pt=f.getAttribute("data-post-type")||"post";
  var host=f.parentNode;
  var list=host?host.querySelector(".comment-list"):null;
  if(!pid||!list)return;
  fetch("/api/comments?post="+encodeURIComponent(pid)+"&postType="+encodeURIComponent(pt),{credentials:"same-origin"})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){
      if(!d||!Array.isArray(d.items))return;
      // Rebuild the thread tree client-side: the API returns a flat list
      // (oldest first), but the server render nests replies under their
      // parents - a flat swap would visually un-nest every reply.
      var byId={},roots=[];
      for(var i=0;i<d.items.length;i++){var c=d.items[i];byId[c.id]=c;c.__kids=[];}
      for(var j=0;j<d.items.length;j++){
        var it=d.items[j];
        if(it.parentId&&byId[it.parentId])byId[it.parentId].__kids.push(it);
        else roots.push(it);
      }
      var renderItem=function(c){
        var name=c.authorName||"";
        var who=name?escapeHtml(name):"";
        if(c.authorUrl)who='<a href="'+escapeHtml(c.authorUrl)+'" rel="nofollow noopener noreferrer">'+who+"</a>";
        var kids=(c.__kids||[]).map(renderItem).join("");
        return "<li id=\"comment-item-"+c.id+"\"><div class=\"wrapper flex\">" +
          '<div class="avatar relative flex-shrink-0" style="background-image:linear-gradient(135deg,#dce8f7,#bcd6f3)"><div class="highlight"></div></div>' +
          '<div class="body flex-grow"><div class="flex items-start">' +
          '<div class="flex-grow flex items-center justify-between info"><div class="name"><span>'+who+"</span></div>" +
          '<div class="date">'+escapeHtml(c.createdAt?String(c.createdAt).slice(0,16).replace("T"," "):"")+"</div></div>" +
          '<span><div class="flex-shrink-0 reply flex items-center" data-comment-reply="'+c.id+'" title="reply">'+
          '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg></div></span>' +
          '<span><button type="button" class="sf-clike" data-comment-like="'+c.id+'" aria-pressed="false" title="\ud83d\udc4d" style="display:inline-flex;align-items:center;gap:3px;border:0;background:none;cursor:pointer;font-size:13px;line-height:1;padding:2px 4px;color:inherit;opacity:.65;transition:opacity .15s">\ud83d\udc4d<span data-comment-like-count></span></button></span>' +
          "</div>" +
          '<div class="content has-emoji">'+escapeHtml(c.content||"")+"</div></div></div>"+
          (kids?'<ul class="comment-list sub-list">'+kids+"</ul>":"")+
          "</li>";
      };
      var rows=roots.map(renderItem).join("");
      list.innerHTML=rows;
      baseline=d.total||rows.length;
      var box=notice();
      if(box){box.__liveHint=0;box.style.display="none";box.onclick=null;}
    })
    .catch(function(){});
}
function escapeHtml(s){
  return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function tick(){
  // A hidden tab still polls: the reader may be looking at the page in
  // another window, and the hint is one small request per 30s. Pausing on
  // hidden is the browser default for BACKGROUND TIMERS - a throttled
  // interval can be pushed to minutes, which makes the hint useless exactly
  // when the tab was left open overnight.
  var f=form();
  if(!f){baseline=count();return;}
  total().then(function(n){
    if(n===null)return;
    if(n>baseline){
    var box=notice();
    if(box&&!box.__liveHint){
      box.__liveHint=1;
      var en=(document.documentElement.getAttribute("lang")||"")==="en";
      box.textContent=en?"New comments - click to refresh.":"有新的评论，点击刷新。";
      box.style.display="";
      box.style.cursor="pointer";
      box.onclick=function(){loadThread(f);};
    }
  }else if(n<baseline){
    baseline=n;
  }
  });
}
document.addEventListener("visibilitychange",function(){if(!document.hidden)tick();});

document.addEventListener("rv:nav",function(){baseline=count();var box=notice();if(box){box.__liveHint=0;box.style.display="none";box.onclick=null;}});
setInterval(tick,POLL_MS);
})();
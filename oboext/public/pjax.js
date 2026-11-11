"use strict";(function(){"use strict";"scrollRestoration"in history&&(history.scrollRestoration="manual");let w=0,T=location.pathname+location.search;const S=i=>new Promise(c=>setTimeout(c,i));function g(i){pb(i)}
let P=null;function pb(i){if(i==="start"){if(!P){P=document.createElement("div"),P.className="bmx-nav-progress",P.innerHTML="<i></i>";const s=document.createElement("style");s.textContent=".bmx-nav-progress{position:fixed;top:0;left:0;right:0;height:3px;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .15s}.bmx-nav-progress>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent,#e91e63),var(--accent-2,#ff9800));box-shadow:0 0 10px var(--accent,#e91e63);transition:width .25s ease}.bmx-nav-progress.on{opacity:1}.bmx-nav-progress.go>i{width:92%;transition:width 8s linear}.bmx-nav-progress.end>i{width:100%;transition:width .12s ease}.bmx-nav-progress.off{opacity:0;transition:opacity .3s ease .1s}@media (prefers-reduced-motion:reduce){.bmx-nav-progress{display:none}}",(document.head||document.documentElement).appendChild(s),document.body&&document.body.appendChild(P)}if(P){const b=P.firstElementChild;b.style.transition="none",b.style.width="0",P.className="bmx-nav-progress",requestAnimationFrame(()=>{b.style.transition="",b.style.width="",P&&(P.className="bmx-nav-progress on go")})}}else if(i==="done"&&P){P.className="bmx-nav-progress on end";const p=P;setTimeout(()=>{p.className="bmx-nav-progress off",setTimeout(()=>{p.parentNode&&p.parentNode.removeChild(p),P===p&&(P=null)},400)},120)}}
function p(i){if(!i||!i.getAttribute("href"))return!1;const c=i.getAttribute("href");if(!c.startsWith("/")||c.startsWith("//")||i.target==="_blank"||i.hasAttribute("download")||i.hasAttribute("data-no-pjax")||/\.[a-z0-9]+($|[?#])/i.test(c.split("?")[0].split("#")[0]))return!1;const l=new URL(c,location.href);return l.pathname.startsWith("/api/")||l.pathname.startsWith("/admin")||l.pathname===location.pathname&&l.search===location.search&&l.hash?!1:l}async function R(i){const __pfk=i.pathname+i.search,__pf=window.__pjaxPrefetch&&window.__pjaxPrefetch.get(__pfk);if(__pf&&__pf.t>Date.now()-60000&&window.__pjaxPrefetch){window.__pjaxPrefetch.delete(__pfk);const __e=new DOMParser().parseFromString(__pf.h,"text/html"),__t=__e.getElementById("sk-main");if(__t)return{doc:__e,next:__t,url:new URL(__pfk,location.href)}}let c;try{if(c=await fetch(i.pathname+i.search,{credentials:"same-origin",cache:"no-store",headers:{"X-PJAX":"1"}}),!c.ok){const n=await fetch(i.pathname+i.search,{credentials:"same-origin",cache:"no-store",headers:{"X-PJAX":"1"}});n.ok&&(c=n)}}catch{return null}if((c.headers.get("content-type")||"").indexOf("text/html")<0||!c.ok&&c.status!==404)return null;const L=await c.text(),e=new DOMParser().parseFromString(L,"text/html"),t=e.getElementById("sk-main");return t?{doc:e,next:t,url:new URL(c.url||i.href)}:null}async function M(i,c){const l=++w,L=new URL(i,location.href),e=Date.now();g("start");const t=await R(L);if(l!==w)return;if(!t){g("done"),location.href=L.href;return}const n=document.getElementById("sk-main");if(n.style.transition="opacity 180ms ease",n.style.opacity="0",await S(180),l!==w)return;n.innerHTML=t.next.innerHTML,n.getBoundingClientRect(),n.style.opacity="1";const r=t.doc.querySelector("title");r&&(document.title=r.textContent);const a=t.url;if(c&&(history.replaceState({rv:1,y:window.scrollY},""),history.pushState({rv:1,y:0},"",a.pathname+a.search+a.hash)),T=a.pathname+a.search,g("done"),setTimeout(()=>g(null),900),document.dispatchEvent(new CustomEvent("rv:nav")),a.hash){const o=document.getElementById(a.hash.slice(1))||document.querySelector(a.hash);if(o){o.scrollIntoView();return}}window.scrollTo(0,c?0:history.state&&history.state.y||0)}document.addEventListener("click",i=>{if(i.defaultPrevented||i.button!==0||i.ctrlKey||i.metaKey||i.shiftKey||i.altKey||!document.getElementById("sk-main"))return;const c=i.target.tagName==="A"?i.target:i.target.closest&&i.target.closest("a"),l=p(c);l&&(i.preventDefault(),M(l.pathname+l.search+l.hash,!0))}),window.addEventListener("popstate",()=>{if(!document.getElementById("sk-main")){location.reload();return}location.pathname+location.search!==T&&M(location.pathname+location.search,!1)})})(),function(){"use strict";var __MSGS={zh:{copied:"\u5DF2\u590D\u5236",shared:"\u5DF2\u5206\u4EAB",copy_failed:"\u590D\u5236\u5931\u8D25",no_match:"\u6CA1\u6709\u5339\u914D\u300C{q}\u300D\u7684\u6587\u7AE0",total:"\u5171 {n} \u7BC7\uFF0C\u6309 Enter \u67E5\u770B\u5168\u90E8"},en:{copied:"Copied",shared:"Shared",copy_failed:"Copy failed",no_match:"No posts matching “{q}”",total:"{n} posts in total, press Enter to see all"}};function __loc(){var d=typeof document!=="undefined"&&document.documentElement?document.documentElement.getAttribute("lang"):"";return d==="en"?"en":"zh-CN";}function __t(l,v){var m=(l==="en"?__MSGS.en:__MSGS.zh)[v]||"";if(arguments.length>2&&arguments[2]){for(var k in arguments[2]){m=m.split("{"+k+"}").join(String(arguments[2][k]));}}return m;}function w(){var e=document.querySelector(".df-search-input");e&&(e.focus(),e.select())}function T(e){if(!e)return!1;var t=e.tagName;return t==="INPUT"||t==="TEXTAREA"||t==="SELECT"||e.isContentEditable}document.addEventListener("keydown",function(e){if(!(e.key!=="/"||e.metaKey||e.ctrlKey||e.altKey)&&!T(e.target)){var t=document.querySelector(".df-search-box");t&&(e.preventDefault(),w())}}),document.addEventListener("focusin",function(e){if(e.target&&e.target.classList&&e.target.classList.contains("df-search-input")){var t=e.target.closest(".df-search-box");t&&t.classList.add("is-focused")}}),document.addEventListener("focusout",function(e){if(e.target&&e.target.classList&&e.target.classList.contains("df-search-input")){var t=e.target.closest(".df-search-box");t&&t.classList.remove("is-focused")}});function x(){for(var e=document.querySelectorAll(".df-aside .df-card"),t=0;t<e.length;t++)e[t].style.transitionDelay=60+t*70+"ms"}x(),document.addEventListener("rv:nav",x);function q(){var e=document.querySelector("details.dfm-menu[open]");e&&e.removeAttribute("open")}document.addEventListener("click",function(e){var t=e.target&&e.target.closest?e.target.closest(".dfm-list a"):null;t&&q()}),document.addEventListener("rv:nav",q);function k(){for(var e=function(y){return y.split("?")[0].split("#")[0].replace(/\/+$/,"")||"/"},t=e(location.pathname),n=document.querySelectorAll(".df-menu-list, .dfm-list, .df-cat-tree, .df-side-list"),r=0;r<n.length;r++)for(var a=n[r].querySelectorAll("a[href]"),o=0;o<a.length;o++){var f=a[o];if(!(f.getAttribute("href")==="#"||f.hasAttribute("data-no-nav"))){var s=e(f.getAttribute("href")||"");if(!(!s||/^[a-z][a-z0-9+.-]*:/i.test(s))){var u=t==="/"?s==="/":s!=="/"&&(t===s||t.indexOf(s+"/")===0);f.classList.toggle("is-current",u),u?f.setAttribute("aria-current","page"):f.removeAttribute("aria-current")}}}}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",k):k(),document.addEventListener("rv:nav",k);function d(){for(var e=document.querySelectorAll(".df-menu-list"),t=0;t<e.length;t++){var n=e[t],r=n.querySelectorAll(".df-menu-link");if(r.length){for(var a=-1,o=0;o<r.length;o++)if(r[o].classList.contains("is-current")){a=o;break}var f=function(s){for(var u=0;u<r.length;u++)r[u].tabIndex=u===s?0:-1};f(a>=0?a:0),n.dataset.rvRoving!=="1"&&(n.dataset.rvRoving="1",n.addEventListener("keydown",function(s){if(!(s.key!=="ArrowRight"&&s.key!=="ArrowLeft"&&s.key!=="Home"&&s.key!=="End")){for(var u=this.querySelectorAll(".df-menu-link"),y=-1,D=0;D<u.length;D++)if(u[D]===document.activeElement){y=D;break}if(!(y<0)){s.preventDefault();var _=y;s.key==="ArrowRight"?_=(y+1)%u.length:s.key==="ArrowLeft"?_=(y-1+u.length)%u.length:s.key==="Home"?_=0:_=u.length-1,u[_].focus();for(var I=0;I<u.length;I++)u[I].tabIndex=I===_?0:-1}}}))}}}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",d):d(),document.addEventListener("rv:nav",d);function v(e,t){var n=e.querySelector("[data-share-label]");n&&(e.__t0===void 0&&(e.__t0=n.textContent),n.textContent=t,clearTimeout(e.__t),e.__t=setTimeout(function(){n.textContent=e.__t0},1600))}function E(e){try{var t=document.createElement("textarea");t.value=e,t.setAttribute("readonly",""),t.style.position="fixed",t.style.top="-1000px",t.style.opacity="0",document.body.appendChild(t),t.select(),t.setSelectionRange(0,e.length);var n=document.execCommand("copy");if(document.body.removeChild(t),n)return Promise.resolve(__t(__loc(),"copied"))}catch{}return Promise.reject()}document.addEventListener("click",function(e){var t=e.target&&e.target.closest?e.target.closest("[data-share-copy]"):null;if(t){e.preventDefault();var n=location.href,r=navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(n).then(function(){return __t(__loc(),"copied")}):Promise.reject();r.catch(function(){return E(n)}).catch(function(){return navigator.share?navigator.share({url:n}).then(function(){return __t(__loc(),"shared")}):Promise.reject()}).then(function(a){v(t,a)},function(){v(t,__t(__loc(),"copy_failed"))})}});function m(){for(var e=document.querySelectorAll("[data-views-post]"),t=0;t<e.length;t++){var n=e[t],r=n.getAttribute("data-views-post"),a=n.querySelector("[data-views-count]");!r||!a||fetch("/api/posts/"+encodeURIComponent(r)+"/views",{headers:{accept:"application/json","x-locale":__loc()}}).then(function(o){return o.ok?o.json():null}).then(function(o){o&&typeof o.views=="number"&&(a.textContent=o.views)}).catch(function(){})}}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",m):m(),document.addEventListener("rv:nav",m);var S=2,b=180,A=8;function g(e){return String(e??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function C(e,t){var n=g(e);if(!t)return n;for(var r=n.toLowerCase(),a=t.toLowerCase(),o="",f=0;;){var s=r.indexOf(a,f);if(s<0)break;o+=n.slice(f,s)+'<span class="df-suggest-mark">'+n.slice(s,s+a.length)+"</span>",f=s+a.length}return o+n.slice(f)}function h(e){var t=e.getAttribute("aria-controls");return t?document.getElementById(t):null}function p(e){var t=h(e);t&&(t.hidden=!0,t.innerHTML=""),e.setAttribute("aria-expanded","false"),e.removeAttribute("aria-activedescendant"),e.__df&&(e.__df.active=-1)}function R(e,t,n){var r=h(e);if(r){var a=n&&n.items||[];if(!a.length)r.innerHTML='<div class="df-suggest-empty">'+__t(__loc(),"no_match",{q:g(t)})+"</div>";else{var o=a.slice(0,A).map(function(s,u){var y=s.thumbnail?'<img class="df-suggest-thumb" src="'+g(s.thumbnail)+'" alt="" loading="lazy">':"";return'<a class="df-suggest-item" id="df-suggest-opt-'+u+'" role="option" href="'+g(s.url)+'">'+y+'<span class="df-suggest-title">'+C(s.title,t)+"</span></a>"}).join(""),f=n&&typeof n.total=="number"&&n.total>a.length?'<div class="df-suggest-foot">'+__t(__loc(),"total",{n:n.total})+"</div>":"";r.innerHTML='<div role="listbox">'+o+"</div>"+f}r.hidden=!1,e.setAttribute("aria-expanded","true"),e.__df&&(e.__df.active=-1)}}function M(e){var t=e.__df,n=e.value.trim();if(n.length<S){p(e);return}var r=++t.seq;fetch("/api/search-suggest?q="+encodeURIComponent(n),{headers:{accept:"application/json"}}).then(function(a){return a.ok?a.json():null}).then(function(a){r===t.seq&&R(e,n,a)}).catch(function(){r===t.seq&&p(e)})}function i(e){var t=h(e);if(!t)return null;var n=t.querySelectorAll(".df-suggest-item");return e.__df&&e.__df.active>=0&&n[e.__df.active]||null}function c(e,t){var n=h(e);if(n){var r=n.querySelectorAll(".df-suggest-item");if(r.length){var a=e.__df,o=a.active+t;o>=r.length&&(o=t>0?0:r.length-1),o<0&&(o=t<0?r.length-1:0),a.active>=0&&r[a.active]&&r[a.active].classList.remove("is-active"),r[o].classList.add("is-active"),a.active=o,e.setAttribute("aria-activedescendant",r[o].id),r[o].scrollIntoView({block:"nearest"})}}}function l(e){!e||e.__df||(e.__df={seq:0,timer:0,active:-1},e.addEventListener("input",function(){var t=e.__df;clearTimeout(t.timer);var n=e.value.trim();if(n.length<S){t.seq++,p(e);return}t.timer=setTimeout(function(){M(e)},b)}),e.addEventListener("keydown",function(t){var n=e.__df,r=h(e)&&!h(e).hidden;if(t.key==="Escape"){r&&(t.preventDefault(),p(e));return}if(t.key==="ArrowDown"||t.key==="ArrowUp"){if(!r)return;t.preventDefault(),c(e,t.key==="ArrowDown"?1:-1);return}if(t.key==="Enter"){var a=i(e);a&&(t.preventDefault(),a.click())}}))}function L(){for(var e=document.querySelectorAll(".df-search-input[aria-controls]"),t=0;t<e.length;t++)l(e[t])}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",L):L(),document.addEventListener("rv:nav",L),document.addEventListener("click",function(e){var t=e.target&&e.target.closest?e.target.closest(".df-search-box"):null;if(!t)for(var n=document.querySelectorAll(".df-search-input[aria-controls]"),r=0;r<n.length;r++)p(n[r])}),document.addEventListener("submit",function(e){var t=e.target;if(!(!t||!t.classList||!t.classList.contains("df-search-form"))&&document.getElementById("sk-main")){var n=new FormData(t),r=String(n.get("q")||"").trim();if(r){e.preventDefault();for(var a=document.querySelectorAll(".df-search-input[aria-controls]"),o=0;o<a.length;o++)p(a[o]);var f="/search?q="+encodeURIComponent(r),s=document.createElement("a");s.href=f,document.body.appendChild(s),s.click(),document.body.removeChild(s)}}})}();
(function(){"use strict";var __MSGS2={zh:{toc:"\u76EE\u5F55",switch:"English"},en:{toc:"Contents",switch:"\u4E2D\u6587"}};function __loc2(){var d=typeof document!=="undefined"&&document.documentElement?document.documentElement.getAttribute("lang"):"";return d==="en"?"en":"zh-CN";}function __t2(l,v){return (l==="en"?__MSGS2.en:__MSGS2.zh)[v]||"";}
var inited=false;
var scrollRaf=0;
// Reading progress bar only. The table of contents is NOT built here: the
// theme renders it server-side (df-toc), and this client copy rewrote the
// heading ids, which broke the server-side anchors.
function build(){
  var old=document.getElementById("rv-progress");if(old)old.remove();
  if(!document.querySelector(".post-content"))return;
  var bar=document.createElement("div");bar.id="rv-progress";bar.setAttribute("role","progressbar");bar.setAttribute("aria-label","Reading progress");document.body.appendChild(bar);
}
function onScroll(){
  if(scrollRaf)return;
  scrollRaf=requestAnimationFrame(function(){
    scrollRaf=0;
    var bar=document.getElementById("rv-progress");
    if(bar){var d=document.documentElement;var max=d.scrollHeight-d.clientHeight;var p=max>0?(d.scrollTop||document.body.scrollTop)/max*100:0;if(p>100)p=100;if(p<0)p=0;bar.style.width=p+"%";bar.setAttribute("aria-valuenow",String(Math.round(p)));}
  });
}
if(!inited){inited=true;window.addEventListener("scroll",onScroll,{passive:true});window.addEventListener("resize",onScroll,{passive:true});}
if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",build);}else{build();}
document.addEventListener("rv:nav",build);
window.__pjaxT=__t2;window.__pjaxLoc=__loc2;})();
(function(){"use strict";
// Locale switcher sync. The pill is server-rendered for the full-load path
// and carries data-no-pjax (a locale switch must reload the document, pjax
// only swaps #sk-main). This keeps its href pointed at the CURRENT path after
// a client-side navigation, so it never sends the visitor back to the page
// they left. Label follows the locale the URL is in.
function syncLocaleSwitch(){
  var a=document.querySelector("[data-locale-switch]");
  if(!a)return;
  var p=location.pathname||"/";
  var en=/^\/en(?=\/|$)/.test(p);
  var target=en?(p.replace(/^\/en(?=\/|$)/,"")||"/"):(p==="/"?"/en/":"/en"+p);
  a.setAttribute("href",target);
  a.textContent=__pjaxT(en?"en":"zh-CN","switch");
}
if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",syncLocaleSwitch);}else{syncLocaleSwitch();}
document.addEventListener("rv:nav",syncLocaleSwitch);
})();
(function(){"use strict";function stampLocaleCookie(ev){var a=ev.target;while(a&&a.nodeType===1&&!a.hasAttribute("data-locale-switch"))a=a.parentElement;if(!a)return;var en=/^\/en(?=\/|$)/.test(location.pathname||"/");document.cookie="oboext_locale="+(en?"zh-CN":"en")+"; path=/; max-age=31536000; samesite=lax";}document.addEventListener("click",stampLocaleCookie,true);})();
// The newsletter confirm/unsubscribe links land on /?subscribed=1 (or the
// error/unsubscribe markers) and the banner is rendered server-side. Drop the
// marker once it has been shown, so a refresh or a copied URL does not replay
// it and the address stays the clean canonical /.
(function () {
  try {
    var u = new URL(location.href);
    var seen = false;
    ["subscribed", "unsubscribed", "newsletter_error"].forEach(function (k) {
      if (u.searchParams.has(k)) {
        u.searchParams.delete(k);
        seen = true;
      }
    });
    if (!seen) return;
    history.replaceState(history.state, "", u.pathname + (u.search || "") + (u.hash || ""));
  } catch (e) {}
})();

/* Hover / viewport prefetch for the soft navigation: the click path above
   re-fetches every navigation, so a hovered link costs a round trip on the
   click itself. Mirrors the framework's own guards — a bounded cache (8,
   insertion-order eviction), a save-data / 2g opt-out, and the same link
   qualifier the click path uses. */
(function(){"use strict";
var CACHE_MAX=8;
var store=null;
try{store=new Map();window.__pjaxPrefetch=store;}catch(e){return;}
var pending={};
function signedIn(){
  // A signed-in reader gets a DIFFERENT comment form (identity row instead of
  // the nickname/email inputs), so a prefetched document is only correct for
  // one of the two states. The session cookie is HttpOnly and unreadable from
  // script - its PRESENCE on document.cookie is the signal.
  var c=document.cookie||"";
  var parts=c.split(";");
  for(var i=0;i<parts.length;i++){
    var p=parts[i].trim();
    if(p.indexOf("cms_session=")===0)return true;
  }
  return false;
}
function netOk(){
  var c=navigator.connection||navigator.mozConnection||navigator.webkitConnection;
  if(c&&(c.saveData||/^(slow-)?2g$/i.test(c.effectiveType||"")))return false;
  return true;
}
function qual(a){
  if(!a||!a.getAttribute("href"))return null;
  var h=a.getAttribute("href");
  if(!h||h.charAt(0)!=="/"||h.charAt(1)==="/"||a.target==="_blank"||a.hasAttribute("download")||a.hasAttribute("data-no-pjax"))return null;
  if(/\.[a-z0-9]+($|[?#])/i.test(h.split("?")[0].split("#")[0]))return null;
  var l;
  try{l=new URL(h,location.href);}catch(e){return null;}
  if(l.origin!==location.origin)return null;
  var pn=l.pathname;
  if(pn.indexOf("/api/")===0||pn.indexOf("/admin")===0)return null;
  if(pn===location.pathname&&l.search===location.search)return null;
  var k=pn+l.search;
  var hit=store.get(k);if(hit&&hit.t>Date.now()-60000)return null;if(pending[k])return null;return k;
}
function prefetch(k){
  if(!netOk())return;
  if(signedIn())return;
  if(Object.keys(pending).length>4)return;
  pending[k]=1;
  // credentials:"omit" on purpose: a prefetched document is cached for EVERY
  // visitor of this browser, and the comment form differs between a signed-in
  // reader (identity row) and a guest (nickname/email inputs). Fetching
  // anonymously keeps the cached bytes the guest shape - a signed-in reader
  // then sees the guest form until they reload, which is far less wrong than
  // showing one reader another reader's identity row.
  fetch(k,{credentials:"omit",cache:"no-store",headers:{"X-PJAX":"1"}})
    .then(function(r){
      if(!r.ok||(r.headers.get("content-type")||"").indexOf("text/html")<0)throw 0;
      return r.text();
    })
    .then(function(html){
      if(store.size>=CACHE_MAX){var oldest=store.keys().next().value;store.delete(oldest);}
      store.set(k,{h:html,t:Date.now()});
    })
    .catch(function(){})
    .then(function(){delete pending[k];});
}
var lastKey="";
var hoverTimer=null;
document.addEventListener("mouseover",function(e){
  var a=e.target&&e.target.closest?e.target.closest("a"):null;
  if(!a)return;
  var k=qual(a);
  if(!k||k===lastKey)return;
  lastKey=k;
  clearTimeout(hoverTimer);
  hoverTimer=setTimeout(function(){prefetch(k);},80);
},{passive:true});
var io=null;
function scan(){
  if(!("IntersectionObserver" in window))return;
  if(!io){
    io=new IntersectionObserver(function(entries){
      for(var i=0;i<entries.length;i++){
        if(!entries[i].isIntersecting)continue;
        var k=qual(entries[i].target);
        if(k){io.unobserve(entries[i].target);prefetch(k);}
      }
    });
  }
  var links=document.querySelectorAll('a[href^="/"]:not([data-no-pjax])');
  for(var i=0;i<links.length;i++){
    var h=links[i].getAttribute("href")||"";
    if(!/\.[a-z0-9]+($|[?#])/i.test(h.split("?")[0].split("#")[0])&&h.indexOf("/api/")!==0&&h.indexOf("/admin")!==0)io.observe(links[i]);
  }
}
function idle(fn){
  var w=window;
  if(w.requestIdleCallback)w.requestIdleCallback(fn,{timeout:1500});
  else setTimeout(fn,200);
}
if(netOk()){
  idle(scan);
  document.addEventListener("rv:nav",function(){idle(scan);});
}
})();
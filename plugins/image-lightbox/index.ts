import { definePlugin } from "../../oboext/src/server/plugin-api.js";

type Settings = {
  caption: boolean;
  minSize: number;
};

const CONTENT_SEL =
  "#post-body,.pl-article-wrap,.post-wrapper,.bmx-blocks,.prose-cms,.post-content,.entry-content,.article-content";

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    addFilter<{ html: string[] }>(HOOKS.footerHtml, (payload) => {
      const cfg = JSON.stringify({
        cap: !!settings.caption,
        min: Math.max(0, Number(settings.minSize) || 0),
      });

      payload.html.push(`<style>
.oboe-lb{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:4vh 4vw;background:rgba(6,10,18,.86);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);cursor:zoom-out;opacity:0;visibility:hidden;transition:opacity .25s ease,visibility .25s ease}
.oboe-lb.oboe-lb-on{opacity:1;visibility:visible}
.oboe-lb img{display:block;max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 12px 60px rgba(0,0,0,.6);cursor:zoom-out;transform:scale(.92);transition:transform .28s cubic-bezier(.4,1.4,.5,1)}
.oboe-lb.oboe-lb-on img{transform:scale(1)}
.oboe-lb-cap{position:absolute;left:0;right:0;bottom:3vh;box-sizing:border-box;padding:0 8vw;text-align:center;font:13px/1.6 var(--font,sans-serif);color:rgba(255,255,255,.78);text-shadow:0 1px 4px rgba(0,0,0,.8)}
.oboe-lb-close{position:absolute;top:18px;right:22px;width:38px;height:38px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.08);cursor:pointer;transition:background-color .18s,transform .25s}
.oboe-lb-close:hover{background:rgba(255,255,255,.2);transform:rotate(90deg)}
.oboe-lb-close:before,.oboe-lb-close:after{content:"";position:absolute;left:50%;top:50%;width:16px;height:2px;border-radius:1px;background:#fff}
.oboe-lb-close:before{transform:translate(-50%,-50%) rotate(45deg)}
.oboe-lb-close:after{transform:translate(-50%,-50%) rotate(-45deg)}
@media (prefers-reduced-motion:reduce){.oboe-lb,.oboe-lb img{transition:none}.oboe-lb img{transform:none}}
</style>
<script>(function(){var C=${cfg};
var overlay=document.createElement('div');overlay.className='oboe-lb';
overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-hidden','true');
var big=document.createElement('img');big.alt='';overlay.appendChild(big);
var cap=document.createElement('div');cap.className='oboe-lb-cap';overlay.appendChild(cap);
var x=document.createElement('button');x.type='button';x.className='oboe-lb-close';x.setAttribute('aria-label','关闭');overlay.appendChild(x);
var open=false;
function close(){
  if(!open)return;
  open=false;
  overlay.classList.remove('oboe-lb-on');
  overlay.setAttribute('aria-hidden','true');
  document.body.style.overflow='';
}
function fit(){
  var nw=big.naturalWidth,nh=big.naturalHeight;
  if(!nw||!nh)return;
  var cs=getComputedStyle(overlay);
  var aw=overlay.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);
  var ah=overlay.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom);
  if(aw<=0||ah<=0)return;
  var r=nw/nh,w=aw,h=w/r;
  if(h>ah){h=ah;w=h*r;}
  big.style.width=Math.round(w)+'px';big.style.height=Math.round(h)+'px';
}
function openBox(src,text){
  big.style.width='';big.style.height='';
  big.src=src;
  cap.textContent=text||'';
  cap.style.display=text?'':'none';
  overlay.classList.toggle('oboe-lb-has-cap',!!text);
  open=true;
  document.body.style.overflow='hidden';
  overlay.setAttribute('aria-hidden','false');
  if(big.complete&&big.naturalWidth)fit();
  requestAnimationFrame(function(){overlay.classList.add('oboe-lb-on');});
}
big.addEventListener('load',function(){if(open)fit();});
window.addEventListener('resize',function(){if(open)fit();});
overlay.addEventListener('click',function(e){
  var t=e.target;
  if(t===x||t===overlay||t===big||t===cap)close();
});
document.addEventListener('keydown',function(e){if(e.key==='Escape')close();});
function mount(){if(!overlay.parentNode)document.body.appendChild(overlay);}
if(document.readyState!=='loading')mount();else document.addEventListener('DOMContentLoaded',mount);
document.addEventListener('click',function(e){
  var t=e.target;
  if(!(t instanceof HTMLImageElement))return;
  if(t.closest('.oboe-lb'))return;
  if(!t.closest('${CONTENT_SEL}'))return;
  if(t.closest('a'))return;
  if(C.min>0&&t.naturalWidth&&t.naturalWidth<C.min)return;
  e.preventDefault();
  var fig=t.closest('figure');
  var fcap=fig&&fig.querySelector('figcaption');
  var text=C.cap?((fcap&&fcap.textContent&&fcap.textContent.trim())||t.alt||''):'';
  openBox(t.currentSrc||t.src,text);
});
})();</script>`);
      return payload;
    });
  },
});
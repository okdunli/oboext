import { definePlugin } from "../../oboext/src/server/plugin-api.js";

type Settings = {
  color: string;
  height: number;
  position: "top" | "bottom";
  onlyArticle: boolean;
};

const CONTENT_SEL =
  "#post-body,.pl-article-wrap,.post-wrapper,.bmx-blocks,.prose-cms,.post-content,.entry-content,.article-content";

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    addFilter<{ html: string[]; kind?: string }>(HOOKS.footerHtml, (payload) => {
      const single = payload.kind === "post" || payload.kind === "page";
      const cfg = JSON.stringify({
        c: settings.color || "#5b8cff",
        h: Math.max(1, Math.min(12, Number(settings.height) || 3)),
        p: settings.position === "bottom" ? "bottom" : "top",
        a: !!settings.onlyArticle,
        k: single ? 1 : 0,
      });

      payload.html.push(`<style>
.oboe-rp{position:fixed;left:0;right:0;z-index:9998;height:0;-webkit-appearance:none;appearance:none;pointer-events:none}
.oboe-rp-top{top:0}
.oboe-rp-bottom{bottom:0}
.oboe-rp > i{display:block;height:100%;width:0}
</style>
<script>(function(){var C=${cfg};
if(C.a&&!C.k&&!document.querySelector('${CONTENT_SEL}'))return;
var bar=document.createElement('div');
bar.className='oboe-rp '+(C.p==='bottom'?'oboe-rp-bottom':'oboe-rp-top');
bar.style.height=C.h+'px';
var inner=document.createElement('i');
inner.style.background=C.c;
bar.appendChild(inner);
function mount(){if(!bar.parentNode)document.body.appendChild(bar);}
if(document.readyState!=='loading')mount();else document.addEventListener('DOMContentLoaded',mount);
var ticking=false;
function upd(){
  var de=document.documentElement,max=de.scrollHeight-de.clientHeight;
  inner.style.width=(max>0?Math.min(1,de.scrollTop/max)*100:0)+'%';
  ticking=false;
}
window.addEventListener('scroll',function(){
  if(!ticking){ticking=true;requestAnimationFrame(upd);}
},{passive:true});
window.addEventListener('resize',function(){if(!ticking){ticking=true;requestAnimationFrame(upd);}},{passive:true});
upd();
})();</script>`);
      return payload;
    });
  },
});

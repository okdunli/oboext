import { definePlugin } from "../../oboext/src/server/plugin-api.js";

type Settings = {
  text: string;
  link: string;
  linkText: string;
  position: "top" | "bottom";
  dismissible: boolean;
  bgColor: string;
  textColor: string;
};

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    const text = (settings.text || "").trim();
    if (!text) return;
    addFilter<{ html: string[] }>(HOOKS.footerHtml, (payload) => {
      const cfg = JSON.stringify({
        t: text,
        u: (settings.link || "").trim(),
        b: settings.linkText || "了解更多",
        p: settings.position === "bottom" ? "bottom" : "top",
        d: !!settings.dismissible,
        bg: settings.bgColor || "#5b8cff",
        fg: settings.textColor || "#ffffff",
      });

      payload.html.push(`<style>
.oboe-ann{box-sizing:border-box;width:100%;font:13px/1.5 var(--font,sans-serif);display:flex;align-items:center;justify-content:center;gap:10px;padding:8px 36px;text-align:center}
.oboe-ann-top{position:relative}
.oboe-ann-bottom{position:fixed;left:0;right:0;bottom:0;z-index:9997;box-shadow:0 -4px 20px rgba(0,0,0,.12)}
.oboe-ann a{color:inherit;text-decoration:underline;font-weight:600;white-space:nowrap}
.oboe-ann-x{position:absolute;right:10px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:inherit;opacity:.7;font-size:16px;line-height:1;cursor:pointer;padding:2px 6px}
.oboe-ann-x:hover{opacity:1}
</style>
<script>(function(){var C=${cfg};
function hash(s){var h=0;for(var i=0;i<s.length;i++){h=((h<<5)-h+s.charCodeAt(i))|0;}return String(h);}
var key='oboe-ann:'+hash(C.t+C.p);
if(C.d){try{if(localStorage.getItem(key)==='1')return;}catch(e){}}
function init(){
  var bar=document.createElement('div');
  bar.className='oboe-ann '+(C.p==='bottom'?'oboe-ann-bottom':'oboe-ann-top');
  bar.style.background=C.bg;bar.style.color=C.fg;
  var span=document.createElement('span');span.textContent=C.t;bar.appendChild(span);
  if(/^https?:\\/\\//i.test(C.u)){
    var a=document.createElement('a');a.href=C.u;a.textContent=C.b;
    try{if(new URL(C.u).hostname!==location.hostname){a.target='_blank';a.rel='noopener';}}catch(e){}
    bar.appendChild(a);
  }
  if(C.d){
    var x=document.createElement('button');x.type='button';x.className='oboe-ann-x';
    x.setAttribute('aria-label','关闭公告');x.innerHTML='&times;';
    x.addEventListener('click',function(){
      bar.parentNode&&bar.parentNode.removeChild(bar);
      try{localStorage.setItem(key,'1');}catch(e){}
    });
    bar.appendChild(x);
  }
  if(C.p==='bottom'){document.body.appendChild(bar);}
  else{document.body.insertBefore(bar,document.body.firstChild);}
}
if(document.readyState!=='loading')init();else document.addEventListener('DOMContentLoaded',init);
})();</script>`);
      return payload;
    });
  },
});

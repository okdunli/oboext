import { definePlugin } from "../../oboext/src/server/plugin-api.js";

type Settings = {
  buttonText: string;
  copiedText: string;
  showLang: boolean;
  showLineNumbers: boolean;
};

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    addFilter<{ html: string[] }>(HOOKS.footerHtml, (payload) => {
      const cfg = JSON.stringify({
        copy: settings.buttonText || "复制",
        done: settings.copiedText || "已复制",
        lang: !!settings.showLang,
        ln: !!settings.showLineNumbers,
      });

      payload.html.push(`<style>
.oboe-code-wrap{position:relative}
.oboe-code-bar{position:absolute;top:.5rem;right:.5rem;display:flex;gap:.4rem;align-items:center;opacity:0;transition:opacity .18s}
.oboe-code-wrap:hover .oboe-code-bar{opacity:1}
.oboe-code-lang{font:600 10px/1 var(--font-mono,monospace);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:.28rem .45rem;border:1px solid var(--border);border-radius:6px}
.oboe-code-copy{font:500 11px/1 var(--font,sans-serif);cursor:pointer;color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:.3rem .55rem;transition:color .18s,border-color .18s}
.oboe-code-copy:hover{color:var(--accent);border-color:var(--accent)}
.oboe-ln{counter-reset:l}
.oboe-ln .oboe-ln-row{counter-increment:l;display:block}
.oboe-ln .oboe-ln-row::before{content:counter(l);display:inline-block;width:2.2em;margin-right:1em;text-align:right;color:var(--muted);opacity:.5;user-select:none}
</style>
<script>(function(){var C=${cfg};
function wrap(pre){
  var wrap=document.createElement('div');wrap.className='oboe-code-wrap';
  pre.parentNode.insertBefore(wrap,pre);wrap.appendChild(pre);
  var bar=document.createElement('div');bar.className='oboe-code-bar';
  var code=pre.querySelector('code')||pre;
  if(C.lang){var l=(pre.getAttribute('data-lang')||'').toLowerCase();
    if(!l){var m=(code.className||'').match(/language-([\\w+#-]+)/);if(m)l=m[1];}
    if(l&&l!=='text'&&l!=='plaintext'){var s=document.createElement('span');s.className='oboe-code-lang';s.textContent=l;bar.appendChild(s);}}
  var btn=document.createElement('button');btn.type='button';btn.className='oboe-code-copy';btn.textContent=C.copy;
  btn.addEventListener('click',function(){var t=code.innerText;
    (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){
      btn.textContent=C.done;setTimeout(function(){btn.textContent=C.copy;},1600);},function(){
      var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();
      try{document.execCommand('copy');btn.textContent=C.done;setTimeout(function(){btn.textContent=C.copy;},1600);}catch(e){}
      document.body.removeChild(ta);});});
  bar.appendChild(btn);wrap.appendChild(bar);
  if(C.ln){code.classList.add('oboe-ln');
    var lines=code.innerHTML.split('\\n');
    if(lines.length>1&&!code.querySelector('.oboe-ln-row')){
      code.innerHTML=lines.map(function(l){return '<span class="oboe-ln-row">'+(l||' ')+'</span>';}).join('\\n');}}
}
function init(root){
  var scope=(root&&typeof root.querySelectorAll==='function')?root:document;
  scope.querySelectorAll('pre:not([data-oboe])').forEach(function(pre){
  pre.setAttribute('data-oboe','1');wrap(pre);});}
if(document.readyState!=='loading')init();else document.addEventListener('DOMContentLoaded',function(){init();});
new MutationObserver(function(es){es.forEach(function(e){e.addedNodes&&e.addedNodes.forEach(function(n){
  if(n.nodeType!==1)return;
  if(n.tagName==='PRE'&&!n.hasAttribute('data-oboe'))init();
  else if(n.querySelector&&n.querySelector('pre:not([data-oboe])'))init();
});});}).observe(document.documentElement,{childList:true,subtree:true});
})();</script>`);
      return payload;
    });
  },
});

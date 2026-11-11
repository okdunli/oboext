import { definePlugin } from "../../oboext/src/server/plugin-api.js";

type Settings = {
  scope: "content" | "all";
  noreferrer: boolean;
  nofollow: boolean;
};

const CONTENT_SEL =
  "#post-body,.pl-article-wrap,.post-wrapper,.bmx-blocks,.prose-cms,.post-content,.entry-content,.article-content";

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    addFilter<{ html: string[] }>(HOOKS.footerHtml, (payload) => {
      const cfg = JSON.stringify({
        all: settings.scope === "all",
        ref: !!settings.noreferrer,
        nf: !!settings.nofollow,
      });

      payload.html.push(`<script>(function(){var C=${cfg};
function init(){
  var roots=C.all?[document]:Array.prototype.slice.call(document.querySelectorAll('${CONTENT_SEL}'));
  var rels=['noopener'];
  if(C.ref)rels.push('noreferrer');
  if(C.nf)rels.push('nofollow');
  roots.forEach(function(root){
    var links=root.querySelectorAll('a[href^="http"]');
    for(var i=0;i<links.length;i++){
      var a=links[i];
      var host;
      try{host=new URL(a.href).hostname;}catch(e){continue;}
      if(host.toLowerCase()===location.hostname.toLowerCase())continue;
      a.target='_blank';
      var old=(a.getAttribute('rel')||'').split(/\\s+/).filter(Boolean);
      rels.forEach(function(r){if(old.indexOf(r)<0)old.push(r);});
      a.setAttribute('rel',old.join(' '));
    }
  });
}
if(document.readyState!=='loading')init();else document.addEventListener('DOMContentLoaded',init);
})();</script>`);
      return payload;
    });
  },
});

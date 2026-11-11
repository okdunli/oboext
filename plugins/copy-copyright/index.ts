import { definePlugin } from "../../oboext/src/server/plugin-api.js";

type Settings = {
  template: string;
  onlyArticle: boolean;
  minChars: number;
};

const CONTENT_SEL =
  "#post-body,.pl-article-wrap,.post-wrapper,.bmx-blocks,.prose-cms,.post-content,.entry-content,.article-content";

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    addFilter<{ html: string[] }>(HOOKS.footerHtml, (payload) => {

      const tpl = (settings.template || "").replace(/\\r\\n|\\n/g, "\n");
      const cfg = JSON.stringify({
        t: tpl,
        a: !!settings.onlyArticle,
        min: Math.max(0, Number(settings.minChars) || 0),
      });

      payload.html.push(`<script>(function(){var C=${cfg};
document.addEventListener('copy',function(e){
  var sel=window.getSelection?window.getSelection():null;
  var text=sel?String(sel.toString()||''):'';
  if(!text||text.length<C.min)return;
  if(C.a&&sel.rangeCount){
    var node=sel.anchorNode;
    var el=node&&node.nodeType===1?node:(node?node.parentElement:null);
    if(!el||!el.closest('${CONTENT_SEL}'))return;
  }
  var add=C.t.replace(/\\{url\\}/g,location.href).replace(/\\{title\\}/g,document.title);
  if(e.clipboardData&&e.clipboardData.setData){
    e.clipboardData.setData('text/plain',text+add);
    e.preventDefault();
  }
});
})();</script>`);
      return payload;
    });
  },
});

import { definePlugin } from "../../oboext/src/server/plugin-api.js";
import { APP_BRAND } from "../../oboext/src/server/version.js";
import { BRAND_ART } from "./brand-art";

type Settings = {
  enabled: boolean;
  content: string;
  showTime: boolean;
  showUrl: boolean;
  showVersion: boolean;
};

export default definePlugin<Settings>({
  setup({ settings, addFilter, HOOKS }) {
    addFilter<{ html: string[] }>(HOOKS.footerHtml, (payload) => {

      if (!settings.enabled) return payload;

      const cfg = JSON.stringify({
        content: settings.content || "",
        showTime: !!settings.showTime,
        showUrl: !!settings.showUrl,
        showVersion: settings.showVersion !== false,

        brand: APP_BRAND,
      });

      payload.html.push(`<script>(function(){
  var C=${cfg};
  // 跳过后台，避免管理界面控制台被刷屏（仅在前台演示）。
  if(typeof location!=='undefined' && location.pathname.indexOf('/admin')===0) return;
  function pad(n){return n;}
  function ts(){
    var d=new Date();
    return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()+' '+d.getHours()+':'+d.getMinutes()+':'+d.getSeconds();
  }
  var lines=[];
  var body=(C.content && C.content.trim()) ? C.content : ${JSON.stringify(BRAND_ART)};
  lines.push(body);
  if(C.showVersion) lines.push(C.brand || '');
  if(C.showTime) lines.push('页面加载时间 '+ts());
  if(C.showUrl) lines.push('当前 URL '+location.href);
  var art=lines.join('\\n');
  // %c 让字符画带品牌色与等宽字体，在 DevTools 里更清晰。
  console.log('%c'+art, 'color:#5b8cff;font-family:ui-monospace,Menlo,Consolas,monospace');
})();</script>`);
      return payload;
    });
  },
});

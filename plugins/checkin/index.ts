import { definePlugin } from "../../oboext/src/server/plugin-api.js";
import { HOOKS } from "../../oboext/src/server/hooks.js";
import { rawQuery } from "../../oboext/src/server/db.js";
import { getSettings } from "../../oboext/src/server/queries.js";
import { getSessionFromRequest } from "../../oboext/src/server/auth.js";
import type { SiteRoutesPayload } from "../../oboext/src/server/virtual-routes.js";
import type { PluginApiPayload, PluginApiResponse } from "../../oboext/src/server/plugin-gateway.js";

type Mode = "fixed" | "random";
type Anonymity = "none" | "partial" | "full";
type RankSort = "points" | "time";

type Settings = {
  currencyName: string;
  mode: Mode;
  fixedAmount: number;
  randomMin: number;
  randomMax: number;
  rankingEnabled: boolean;
  rankingAnonymity: Anonymity;
  rankingSort: RankSort;
  floatEnabled: boolean;
};

type UserCenterMenuItem = { href: string; label: string; icon?: string };

function readSettings(raw: Record<string, unknown>): Settings {
  const num = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const mode: Mode = raw.mode === "random" ? "random" : "fixed";
  const anonymity: Anonymity =
    raw.rankingAnonymity === "partial" || raw.rankingAnonymity === "full"
      ? raw.rankingAnonymity
      : "none";
  const sort: RankSort = raw.rankingSort === "time" ? "time" : "points";
  let min = num(raw.randomMin, 1);
  let max = num(raw.randomMax, 20);
  if (min < 0) min = 0;
  if (max < min) max = min;
  return {
    currencyName: String(raw.currencyName ?? "积分") || "积分",
    mode,
    fixedAmount: Math.max(1, num(raw.fixedAmount, 5)),
    randomMin: min,
    randomMax: max,
    rankingEnabled: raw.rankingEnabled !== false,
    rankingAnonymity: anonymity,
    rankingSort: sort,
    floatEnabled: raw.floatEnabled !== false,
  };
}

let schemaPromise: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await rawQuery(
        `create table if not exists checkin_records (
           id serial primary key,
           user_id integer not null references users(id) on delete cascade,
           day date not null,
           amount integer not null,
           created_at timestamptz not null default now(),
           unique (user_id, day)
         )`,
      );
      await rawQuery(
        `create table if not exists checkin_logs (
           id serial primary key,
           user_id integer not null references users(id) on delete cascade,
           amount integer not null,
           balance integer not null,
           reason text not null default '签到',
           created_at timestamptz not null default now()
         )`,
      );
      await rawQuery(
        `create index if not exists idx_checkin_logs_user on checkin_logs(user_id, created_at desc)`,
      );
      await rawQuery(
        `create index if not exists idx_checkin_records_user on checkin_records(user_id, day desc)`,
      );
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

// R532: a check-in day belongs to the SITE's calendar, not the server's.
//
// The old localDay() read the SERVER's clock fields (getDate/getMonth/
// getYear), so on the common deployment - a UTC server with the default
// Asia/Shanghai site - the label was one day behind for eight hours a day.
// Two instants inside the SAME Shanghai day (16:30Z and the next 01:00Z)
// produced two different labels, so a user could check in twice on one
// calendar day and farm a double reward; and the streak broke at the wrong
// moment. Every other calendar in the app (sitemap lastmod, visit sources)
// already uses the site's timezone - this plugin now does too.

const DAY_FMT = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(tz: string): Intl.DateTimeFormat {
  let f = DAY_FMT.get(tz);
  if (!f) {
    const opts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, ...opts });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", ...opts });
    }
    DAY_FMT.set(tz, f);
  }
  return f;
}

/** The calendar day (YYYY-MM-DD) an instant falls on, in `tz`. */
export function checkinDayLabel(d: Date, tz: string): string {
  return dayFormatter(tz).format(d);
}

/**
 * Add `delta` calendar days to a YYYY-MM-DD label.
 *
 * Pure date arithmetic on the label: the day string is a calendar date, so it
 * is walked in UTC - a DST transition or a server timezone change can never
 * shift the result by a day.
 */
export function checkinDayAdd(day: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const base = m
    ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : Date.UTC(1970, 0, 1);
  const d = new Date(base + delta * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** The site's timezone - the calendar a check-in day belongs to. */
async function siteTimeZone(): Promise<string> {
  const settings = await getSettings();
  const tz = String((settings as { timezone?: unknown }).timezone || "");
  return tz || "Asia/Shanghai";
}

/** Today's label in the site's calendar. */
async function todayLabel(): Promise<string> {
  return checkinDayLabel(new Date(), await siteTimeZone());
}

function calcStreak(days: string[], today: string): number {
  const set = new Set(days);
  let cursor = today;
  let streak = 0;

  if (!set.has(cursor)) cursor = checkinDayAdd(cursor, -1);
  while (set.has(cursor)) {
    streak += 1;
    cursor = checkinDayAdd(cursor, -1);
  }
  return streak;
}

function rewardAmount(s: Settings): number {
  if (s.mode === "fixed") return s.fixedAmount;
  const span = s.randomMax - s.randomMin;
  return s.randomMin + Math.floor(Math.random() * (span + 1));
}

function publicSettings(s: Settings) {
  return {
    currencyName: s.currencyName,
    mode: s.mode,
    rankingEnabled: s.rankingEnabled,
  };
}

type State = {
  checkedToday: boolean;
  todayAmount: number | null;
  balance: number;
  streak: number;
};

async function getState(userId: number, today: string): Promise<State> {
  const [todayRows, balanceRows, dayRows] = await Promise.all([
    rawQuery<{ amount: number }>(
      `select amount from checkin_records where user_id=$1 and day=$2`,
      [userId, today],
    ),
    rawQuery<{ balance: string }>(
      `select coalesce(sum(amount),0)::int as balance from checkin_logs where user_id=$1`,
      [userId],
    ),
    rawQuery<{ day: string }>(
      `select day::text from checkin_records where user_id=$1 order by day desc limit 400`,
      [userId],
    ),
  ]);
  return {
    checkedToday: todayRows.length > 0,
    todayAmount: todayRows[0]?.amount ?? null,
    balance: Number(balanceRows[0]?.balance ?? 0),
    streak: calcStreak(dayRows.map((r) => r.day), today),
  };
}

function maskName(name: string): string {
  const n = name || "用户";
  if (n.length <= 1) return n + "*";
  if (n.length === 2) return n[0] + "*";
  return n[0] + "*".repeat(n.length - 2) + n[n.length - 1];
}

async function getRanking(s: Settings, meId: number) {
  const order =
    s.rankingSort === "time"
      ? "coalesce(max(l.created_at), '1970-01-01'::timestamptz) desc"
      : "sum(l.amount) desc, max(l.created_at) asc";
  const rows = await rawQuery<{
    id: number;
    name: string;
    pts: string;
    last_at: string | null;
  }>(
    `select u.id, u.name, coalesce(sum(l.amount),0)::int pts, max(l.created_at) as last_at
       from checkin_logs l join users u on u.id=l.user_id
      group by u.id, u.name
      order by ${order}
      limit 50`,
  );
  const list = rows.map((r, i) => {
    const rank = i + 1;
    const showReal =
      s.rankingAnonymity === "none" ||
      (s.rankingAnonymity === "partial" && (rank <= 3 || r.id === meId));
    return {
      rank,
      id: r.id,
      name: showReal ? r.name : maskName(r.name),
      points: Number(r.pts),
      isMe: r.id === meId,
      lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
    };
  });
  const mine = list.find((r) => r.isMe) ?? null;
  return {
    sort: s.rankingSort,
    anonymity: s.rankingAnonymity,
    currencyName: s.currencyName,
    list,
    mine,
  };
}

async function handleApi(
  p: PluginApiPayload,
  s: Settings,
): Promise<PluginApiResponse | null> {
  await ensureSchema();
  const user = await getSessionFromRequest(p.request);
  if (!user) return { status: 401, body: { error: "请先登录" } };
  const userId = user.id;
  const [resource] = p.path;

  if (p.method === "GET" && resource === "state") {
    return {
      body: {
        ...(await getState(userId, await todayLabel())),
        settings: publicSettings(s),
      },
    };
  }

  if (p.method === "POST" && resource === "checkin") {
    // R532: the label is resolved ONCE and used for both the "already
    // checked in?" test and the insert, so a request that straddles the
    // site's midnight cannot check in under two different days.
    const today = await todayLabel();
    const state = await getState(userId, today);
    if (state.checkedToday) {
      return { status: 409, body: { error: "今日已签到", state } };
    }
    const amount = rewardAmount(s);
    try {
      await rawQuery(
        `insert into checkin_records (user_id, day, amount) values ($1, $2, $3)`,
        [userId, today, amount],
      );
    } catch (err) {

      if ((err as { code?: string })?.code === "23505") {
        return {
          status: 409,
          body: { error: "今日已签到", state: await getState(userId, today) },
        };
      }
      throw err;
    }
    const balanceRows = await rawQuery<{ balance: string }>(
      `select coalesce(sum(amount),0)::int as balance from checkin_logs where user_id=$1`,
      [userId],
    );
    const balance = Number(balanceRows[0]?.balance ?? 0) + amount;
    await rawQuery(
      `insert into checkin_logs (user_id, amount, balance, reason) values ($1,$2,$3,'签到')`,
      [userId, amount, balance],
    );
    return { body: { gained: amount, state: await getState(userId, today) } };
  }

  if (p.method === "GET" && resource === "logs") {
    const url = new URL(p.request.url);
    const pageSize = 20;
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const [rows, countRows] = await Promise.all([
      rawQuery<{
        id: number;
        amount: number;
        balance: number;
        reason: string;
        created_at: string;
      }>(
        `select id, amount, balance, reason, created_at from checkin_logs
          where user_id=$1 order by created_at desc, id desc limit $2 offset $3`,
        [userId, pageSize, (page - 1) * pageSize],
      ),
      rawQuery<{ total: string }>(
        `select count(*)::int total from checkin_logs where user_id=$1`,
        [userId],
      ),
    ]);
    return {
      body: {
        page,
        pageSize,
        total: Number(countRows[0]?.total ?? 0),
        items: rows.map((r) => ({
          id: r.id,
          amount: r.amount,
          balance: r.balance,
          reason: r.reason,
          at: new Date(r.created_at).toISOString(),
        })),
        currencyName: s.currencyName,
      },
    };
  }

  if (p.method === "GET" && resource === "ranking") {
    if (!s.rankingEnabled) return { status: 404, body: { error: "排行榜未开启" } };
    return { body: await getRanking(s, userId) };
  }

  return { status: 404, body: { error: "接口不存在" } };
}

const STYLE = `
.oboe-ck{max-width:760px;margin:8px 0 24px}
.oboe-ck-tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
.oboe-ck-tab{padding:6px 16px;border-radius:9em;font-size:.85rem;text-decoration:none;color:inherit;background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);transition:all .18s}
.oboe-ck-tab.is-active{background:var(--primary-color,var(--accent,#6366f1));color:#fff;border-color:transparent}
.oboe-ck-card{border-radius:16px;background:rgba(127,127,127,.07);border:1px solid rgba(127,127,127,.22);padding:24px;margin-bottom:14px}
.oboe-ck-balance{font-size:2.4rem;font-weight:800;line-height:1.1;color:var(--primary-color,var(--accent,#6366f1))}
.oboe-ck-sub{margin-top:6px;font-size:.85rem;opacity:.65}
.oboe-ck-streak{display:inline-block;margin-top:10px;padding:3px 12px;border-radius:9em;font-size:.8rem;background:var(--primary-opacity-2,rgba(99,102,241,.15));color:var(--primary-color,var(--accent,#6366f1))}
.oboe-ck-btn{display:inline-block;margin-top:18px;padding:11px 34px;border-radius:9em;border:none;cursor:pointer;font-size:.95rem;background:var(--primary-color,var(--accent,#6366f1));color:#fff;transition:transform .15s,opacity .15s}
.oboe-ck-btn:hover{transform:translateY(-1px)}
.oboe-ck-btn:disabled{opacity:.5;cursor:default;transform:none}
.oboe-ck-msg{margin-top:12px;font-size:.85rem;min-height:1.2em}
.oboe-ck-msg.err{color:#e11d48}
.oboe-ck-msg.ok{color:#059669}
.oboe-ck-table{width:100%;border-collapse:collapse;font-size:.9rem}
.oboe-ck-table th{text-align:left;font-weight:600;font-size:.78rem;opacity:.55;padding:8px 10px;border-bottom:1px solid rgba(127,127,127,.2)}
.oboe-ck-table td{padding:10px;border-bottom:1px solid rgba(127,127,127,.12)}
.oboe-ck-pos{color:#059669;font-weight:600}
.oboe-ck-pager{display:flex;gap:10px;align-items:center;margin-top:14px;font-size:.85rem}
.oboe-ck-pager button{padding:5px 14px;border-radius:8px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer}
.oboe-ck-pager button:disabled{opacity:.4;cursor:default}
.oboe-ck-rank{display:flex;align-items:center;gap:12px;padding:11px 6px;border-bottom:1px solid rgba(127,127,127,.12)}
.oboe-ck-no{width:30px;height:30px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border-radius:999px;font-size:.82rem;font-weight:700;background:rgba(127,127,127,.14)}
.oboe-ck-rank:nth-child(1) .oboe-ck-no,.oboe-ck-rank:nth-child(2) .oboe-ck-no,.oboe-ck-rank:nth-child(3) .oboe-ck-no{background:linear-gradient(135deg,#f59e0b,#f97316);color:#fff}
.oboe-ck-rname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oboe-ck-me{font-size:.68rem;padding:1px 7px;border-radius:9em;background:var(--primary-opacity-2,rgba(99,102,241,.18));color:var(--primary-color,var(--accent,#6366f1));margin-left:6px}
.oboe-ck-rpts{font-weight:700}
.oboe-ck-empty{opacity:.6;padding:24px 0;text-align:center}
.oboe-ck-float{position:fixed;right:18px;bottom:84px;z-index:60;display:flex;align-items:center;gap:6px;padding:9px 16px;border-radius:999px;text-decoration:none;font-size:.85rem;color:#fff;background:var(--primary-color,var(--accent,#6366f1));box-shadow:0 8px 22px rgba(99,102,241,.35);transition:transform .18s}
.oboe-ck-float:hover{transform:translateY(-2px)}
@media(max-width:640px){.oboe-ck-float span{display:none}.oboe-ck-float{padding:11px}}
`;

function clientScript(): string {
  return `(function(){
var API="/api/plugin/checkin";
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function fmt(iso){var d=new Date(iso);return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")+" "+String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");}
function api(path,opt){return fetch(API+path,opt).then(function(r){return r.json().then(function(d){return{ok:r.ok,status:r.status,d:d};});});}
var box=document.getElementById("oboe-ck-app");if(!box)return;
var state=null,cfg={currencyName:"积分",rankingEnabled:true};
function tabs(active){
  var links=[["/checkin","每日签到"],["/checkin/logs","积分记录"]];
  if(cfg.rankingEnabled)links.push(["/checkin/ranking","排行榜"]);
  return '<div class="oboe-ck-tabs">'+links.map(function(l){return '<a class="oboe-ck-tab'+(location.pathname===l[0]?" is-active":"")+'" href="'+l[0]+'">'+l[1]+"</a>";}).join("")+"</div>";
}
function guestView(){
  box.innerHTML='<div class="oboe-ck-card" style="text-align:center"><div style="font-size:1.15rem;font-weight:700">请先登录</div><p class="oboe-ck-sub">登录后即可参与每日签到</p><a class="oboe-ck-btn" href="/admin/login?from='+encodeURIComponent(location.pathname)+'">登录</a></div>';
}
function homeView(){
  var st=state;
  var btn=st.checkedToday
    ? '<button class="oboe-ck-btn" disabled>今日已签到</button>'
    : '<button class="oboe-ck-btn" id="oboe-ck-do">立即签到</button>';
  box.innerHTML=tabs("/checkin")+
    '<div class="oboe-ck-card"><div class="oboe-ck-balance">'+st.balance+' <small style="font-size:.9rem;font-weight:400;opacity:.7">'+esc(cfg.currencyName)+'</small></div>'+
    '<div class="oboe-ck-sub">当前'+esc(cfg.currencyName)+'余额</div>'+
    '<div class="oboe-ck-streak">连续签到 '+st.streak+' 天</div>'+
    '<div>'+btn+'</div><div class="oboe-ck-sub" id="oboe-ck-msg">'+
    (st.checkedToday&&st.todayAmount!=null?"今日已获得 "+st.todayAmount+" "+esc(cfg.currencyName):"每天签到可获得"+esc(cfg.currencyName)+"奖励")+"</div></div>";
  var b=document.getElementById("oboe-ck-do");
  if(b)b.onclick=function(){b.disabled=true;api("/checkin",{method:"POST"}).then(function(r){
    var m=document.getElementById("oboe-ck-msg");
    if(r.ok){state=r.d.state;homeView();}
    else{state=r.d.state||state;b.disabled=false;m.className="oboe-ck-msg err";m.textContent=r.d.error||"签到失败";}
  }).catch(function(){b.disabled=false;});};
}
function logsView(page){
  box.innerHTML=tabs("/checkin/logs")+'<div class="oboe-ck-card" id="oboe-ck-logs">加载中…</div>';
  api("/logs?page="+page).then(function(r){
    if(!r.ok){document.getElementById("oboe-ck-logs").textContent=r.d.error||"加载失败";return;}
    var d=r.d,p=d.page,pages=Math.max(1,Math.ceil(d.total/d.pageSize));
    var rows=d.items.length?('<table class="oboe-ck-table"><thead><tr><th>时间</th><th>说明</th><th>变动</th><th>余额</th></tr></thead><tbody>'+
      d.items.map(function(it){return '<tr><td>'+fmt(it.at)+'</td><td>'+esc(it.reason)+'</td><td class="oboe-ck-pos">+'+it.amount+'</td><td>'+it.balance+"</td></tr>";}).join("")+
      "</tbody></table>"):'<div class="oboe-ck-empty">还没有记录，去签个到吧。</div>';
    document.getElementById("oboe-ck-logs").innerHTML=rows+
      '<div class="oboe-ck-pager"><button '+(p<=1?"disabled":"")+' data-p="'+(p-1)+'">上一页</button><span>'+p+" / "+pages+'</span><button '+(p>=pages?"disabled":"")+' data-p="'+(p+1)+'">下一页</button></div>';
    Array.prototype.forEach.call(document.querySelectorAll(".oboe-ck-pager button"),function(bt){bt.onclick=function(){logsView(Number(bt.getAttribute("data-p")));};});
  });
}
function rankView(){
  box.innerHTML=tabs("/checkin/ranking")+'<div class="oboe-ck-card">加载中…</div>';
  api("/ranking").then(function(r){
    if(!r.ok){box.querySelector(".oboe-ck-card").textContent=r.d.error||"加载失败";return;}
    cfg.currencyName=r.d.currencyName||cfg.currencyName;
    var rows=r.d.list.length?r.d.list.map(function(it){
      return '<div class="oboe-ck-rank"><span class="oboe-ck-no">'+it.rank+'</span><span class="oboe-ck-rname">'+esc(it.name)+(it.isMe?'<span class="oboe-ck-me">我</span>':"")+'</span>'+
        (r.d.sort==="time"&&it.lastAt?'<span class="oboe-ck-sub">'+fmt(it.lastAt)+"</span>":"")+
        '<span class="oboe-ck-rpts">'+it.points+" "+esc(r.d.currencyName)+"</span></div>";
    }).join(""):'<div class="oboe-ck-empty">排行榜还没有数据。</div>';
    box.querySelector(".oboe-ck-card").innerHTML=rows;
  });
}
function route(){
  var p=location.pathname;
  if(p.indexOf("/checkin/logs")===0)return logsView(1);
  if(p.indexOf("/checkin/ranking")===0){if(!cfg.rankingEnabled){box.innerHTML='<div class="oboe-ck-empty">排行榜未开启。</div>';return;}return rankView();}
  return homeView();
}
api("/state").then(function(r){
  if(!r.ok){guestView();return;}
  state=r.d;cfg=r.d.settings||cfg;route();
}).catch(guestView);
})();`;
}

function pageHtml(): string {
  return `<style>${STYLE}</style><div class="oboe-ck" id="oboe-ck-app">加载中…</div><script>${clientScript()}</script>`;
}

const CALENDAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';

export default definePlugin({
  slug: "checkin",

  setup({ settings, addFilter, HOOKS, log }) {
    const s = () => readSettings(settings);

    void ensureSchema().catch((err) => log("schema init failed:", err));

    addFilter<PluginApiPayload>(HOOKS.apiRequest, async (payload) => {
      if (payload.slug !== "checkin" || payload.response) return payload;
      try {
        payload.response = await handleApi(payload, s());
      } catch (err) {
        log("api error:", err);
        payload.response = { status: 500, body: { error: "服务器错误" } };
      }
      return payload;
    });

    addFilter<SiteRoutesPayload>(HOOKS.siteRoutes, (payload) => {
      if (payload.route) return payload;
      const cfg = s();
      const seg = payload.segments;
      if (seg[0] !== "checkin") return payload;
      if (seg.length === 1) {
        payload.route = { title: "每日签到", html: pageHtml(), path: "/checkin" };
      } else if (seg.length === 2 && seg[1] === "logs") {
        payload.route = { title: "积分记录", html: pageHtml(), path: "/checkin/logs" };
      } else if (seg.length === 2 && seg[1] === "ranking" && cfg.rankingEnabled) {
        payload.route = { title: "排行榜", html: pageHtml(), path: "/checkin/ranking" };
      }
      return payload;
    });

    addFilter<{ items: UserCenterMenuItem[] }>(HOOKS.userCenterMenu, (payload) => {
      const cfg = s();
      payload.items.push({ href: "/checkin", label: "每日签到", icon: CALENDAR_SVG });
      payload.items.push({
        href: "/checkin/logs",
        label: `${cfg.currencyName}记录`,
      });
      if (cfg.rankingEnabled) {
        payload.items.push({ href: "/checkin/ranking", label: "签到排行榜" });
      }
      return payload;
    });

    addFilter<{ html: string[] }>(HOOKS.footerHtml, (payload) => {
      if (!s().floatEnabled) return payload;
      payload.html.push(
        `<style>${STYLE}</style><a class="oboe-ck-float" href="/checkin">${CALENDAR_SVG}<span>每日签到</span></a>`,
      );
      return payload;
    });
  },
});

// ====================================================================
//  Freelance Jobs Bot  (Cloudflare Workers + Cron + D1)
//  أي حد يفتح البوت ويدوس /start بيوصله المشاريع الجديدة.
//  المواقع: كفيل، مستقل، نفذلي، خمسات، Freelancer (API)
//
//  Bindings / Variables (من Settings في الـ Worker):
//    DB              -> D1 database binding (الاسم لازم يكون DB)
//    BOT_TOKEN       -> توكن البوت من BotFather           (Secret)
//    WEBHOOK_SECRET  -> كلمة سر للـ webhook (حروف/أرقام/_/-)  (Secret)
//    ADMIN_KEY       -> كلمة سر لصفحات /setup و الاختبار   (Secret)
//    ADMIN_ID        -> اختياري: chat id بتاعك عشان أمر /stats
//  Trigger: Cron "* * * * *"
// ====================================================================

// ---- حدود الخطة المجانية (50 subrequest و 50 D1 query في كل تشغيلة) ----
// لو عملت ترقية للخطة المدفوعة تقدر ترفع الأرقام دي بأمان.
const MAX_NEW_PER_RUN = 10; // أقصى عدد مشاريع جديدة بنعالجها في التشغيلة
const SEND_BATCH = 30; // أقصى عدد رسايل بتتبعت في التشغيلة
const DEFAULT_SITES = "kafiil,mostaql,nafezly,khamsat"; // Freelancer مقفول افتراضياً (حجمه كبير)
const MAX_KEYWORDS = 20;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "ar,en;q=0.8",
};

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS state (site TEXT PRIMARY KEY, last_id INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS users (
     chat_id INTEGER PRIMARY KEY,
     active INTEGER NOT NULL DEFAULT 1,
     sites TEXT NOT NULL DEFAULT '${DEFAULT_SITES}',
     keywords TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL
   )`,
  "CREATE TABLE IF NOT EXISTS messages (key TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, msg_key TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_outbox_chat ON outbox(chat_id)",
  "CREATE INDEX IF NOT EXISTS idx_users_active ON users(active)",
];

// ---------------------------------------------------------------------
//  تعريف المواقع
// ---------------------------------------------------------------------

// موقع HTML: بنجيب صفحة القايمة ونطلّع روابط المشاريع (ID + URL)،
// وبعدين لكل مشروع جديد بنفتح صفحته ونطلّع التفاصيل.
function htmlSite({ key, name, base, listUrl, linkRe, descBetween, budgetBetween }) {
  return {
    key,
    name,
    async list() {
      const res = await fetch(listUrl, { headers: HEADERS });
      if (!res.ok) throw new Error(`${key} list HTTP ${res.status}`);
      const html = await res.text();
      const found = new Map();
      for (const m of html.matchAll(linkRe)) {
        const id = Number(m[1]);
        if (!found.has(id)) found.set(id, base + m[0]);
      }
      return [...found].map(([id, url]) => ({ id, url }));
    },
    async detail(item) {
      const res = await fetch(item.url, { headers: HEADERS });
      if (!res.ok) throw new Error(`${key} detail HTTP ${res.status}`);
      const html = await res.text();

      let title =
        meta(html, "og:title") ||
        decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
      title = title
        .replace(/\s*[|\-–—]\s*(مستقل|خمسات|نفذلي|كفيل|كاف|Mostaql|Khamsat|Nafezly|Kafiil).*$/i, "")
        .trim();

      let description = "";
      let budget = "";

      // بنحوّل جزء صغير بس من الصفحة لنص (عشان نوفر CPU في الخطة المجانية)
      if (descBetween) {
        const idx = html.indexOf(descBetween[0]);
        if (idx >= 0) {
          const text = htmlToText(html.slice(Math.max(0, idx - 100), idx + 30000));
          description = textBetween(text, descBetween[0], descBetween[1]);
          if (title && description.startsWith(title)) description = description.slice(title.length).trim();
          if (description.length > 6000) description = "";
          if (budgetBetween) {
            budget = textBetween(text, budgetBetween[0], budgetBetween[1]).replace(/\s+/g, " ");
            if (budget.length > 60) budget = "";
          }
        }
      }
      if (!description) description = meta(html, "og:description") || meta(html, "description");
      if (!budget) budget = (html.match(/\$\s?[\d,.]+(?:\s*-\s*\$\s?[\d,.]+)?/) || [""])[0];

      return { ...item, title: title || `مشروع جديد #${item.id}`, description, budget, skills: [], extra: [] };
    },
  };
}

const freelancer = {
  key: "freelancer",
  name: "Freelancer",
  async list() {
    const base = "https://www.freelancer.com/api/projects/0.1/projects/active/";
    const tries = [
      `${base}?limit=30&full_description=true&job_details=true&sort_field=submitdate&reverse_sort=true`,
      `${base}?limit=30&full_description=true&job_details=true`,
    ];
    let data = null;
    for (const url of tries) {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) {
        data = await res.json();
        break;
      }
    }
    if (!data) throw new Error("freelancer API failed");

    return (data.result?.projects || []).map((p) => {
      const cur = p.currency || {};
      const b = p.budget || {};
      let budget = "";
      if (b.minimum != null || b.maximum != null) {
        budget = `${cur.sign || ""}${b.minimum ?? "?"} - ${cur.sign || ""}${b.maximum ?? "?"} ${cur.code || ""}`.trim();
        if (p.type === "hourly") budget += " (بالساعة)";
      }
      const extra = [];
      if (p.bid_stats?.bid_count != null) extra.push(`عدد العروض: ${p.bid_stats.bid_count}`);
      return {
        id: p.id,
        url: `https://www.freelancer.com/projects/${p.seo_url || p.id}`,
        title: p.title || `Project #${p.id}`,
        description: p.description || p.preview_description || "",
        budget,
        skills: (p.jobs || []).map((j) => j.name).filter(Boolean).slice(0, 8),
        extra,
      };
    });
  },
};

const SITES = [
  htmlSite({
    key: "kafiil",
    name: "كفيل",
    base: "https://kafiil.com",
    listUrl: "https://kafiil.com/projects",
    linkRe: /\/project\/(\d+)-[^"'\s<>)]*/g,
  }),
  htmlSite({
    key: "mostaql",
    name: "مستقل",
    base: "https://mostaql.com",
    listUrl: "https://mostaql.com/projects",
    linkRe: /\/project\/(\d+)(?:-[^"'\s<>)]*)?/g,
    descBetween: ["تفاصيل المشروع", "حالة المشروع"],
    budgetBetween: ["الميزانية", "مدة التنفيذ"],
  }),
  htmlSite({
    key: "nafezly",
    name: "نفذلي",
    base: "https://nafezly.com",
    listUrl: "https://nafezly.com/projects",
    linkRe: /\/project\/(\d+)(?:-[^"'\s<>)]*)?/g,
  }),
  htmlSite({
    key: "khamsat",
    name: "خمسات",
    base: "https://khamsat.com",
    listUrl: "https://khamsat.com/community/requests",
    linkRe: /\/community\/requests\/(\d+)(?:-[^"'\s<>)]*)?/g,
  }),
  freelancer,
];
const SITE_KEYS = SITES.map((s) => s.key);

// ---------------------------------------------------------------------
//  Cron: نجيب المشاريع الجديدة -> نحطها في الـ outbox -> نبعت دفعة
// ---------------------------------------------------------------------
async function run(env) {
  const [state, users] = await withSchema(env, () => Promise.all([loadState(env), loadUsers(env)]));
  const updates = {};
  const pending = []; // { key, text, chatIds }
  let processed = 0;

  const lists = await Promise.allSettled(SITES.map((s) => s.list()));

  for (let i = 0; i < SITES.length; i++) {
    const site = SITES[i];
    const r = lists[i];
    if (r.status === "rejected") {
      console.error(`[${site.key}] list failed:`, String(r.reason));
      continue;
    }
    const items = r.value;
    if (!items.length) continue;

    // أول تشغيل للموقع: نسجل أعلى ID من غير ما نبعت حاجة
    if (state[site.key] == null) {
      updates[site.key] = Math.max(...items.map((x) => x.id));
      continue;
    }

    const fresh = items.filter((x) => x.id > state[site.key]).sort((a, b) => a.id - b.id);
    let last = state[site.key];

    for (const item of fresh) {
      if (processed >= MAX_NEW_PER_RUN) break;

      // مين مهتم بالموقع ده؟ لو محدش، منضيعش طلبات على تفاصيله
      const audience = users.filter((u) => u.sites.includes(site.key));
      if (!audience.length) {
        last = item.id;
        continue;
      }

      let full;
      try {
        full = site.detail ? await site.detail(item) : item;
      } catch (e) {
        console.error(`[${site.key}] detail failed #${item.id}:`, String(e));
        full = { ...item, title: `مشروع جديد #${item.id}`, description: "", budget: "", skills: [], extra: [] };
      }

      const hay = `${full.title} ${full.description} ${(full.skills || []).join(" ")}`.toLowerCase();
      const chatIds = audience.filter((u) => matchesKeywords(u.keywords, hay)).map((u) => u.chat_id);

      if (chatIds.length) {
        pending.push({ key: `${site.key}:${item.id}`, text: formatMessage(site, full), chatIds });
      }
      processed++;
      last = item.id;
    }

    if (last !== state[site.key]) updates[site.key] = last;
  }

  await enqueueAndSave(env, pending, updates);
  await flushOutbox(env);
}

async function enqueueAndSave(env, pending, updates) {
  const now = Math.floor(Date.now() / 1000);
  const stmts = [];
  for (const m of pending) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO messages (key, text, created_at) VALUES (?1, ?2, ?3)").bind(m.key, m.text, now)
    );
    stmts.push(
      env.DB.prepare("INSERT INTO outbox (chat_id, msg_key) SELECT value, ?1 FROM json_each(?2)").bind(
        m.key,
        JSON.stringify(m.chatIds)
      )
    );
  }
  for (const [site, id] of Object.entries(updates)) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO state (site, last_id) VALUES (?1, ?2) ON CONFLICT(site) DO UPDATE SET last_id = excluded.last_id"
      ).bind(site, id)
    );
  }
  if (stmts.length) await env.DB.batch(stmts); // batch واحدة = transaction واحدة
}

async function flushOutbox(env) {
  const { results } = await env.DB.prepare(
    "SELECT o.id, o.chat_id, m.text FROM outbox o JOIN messages m ON m.key = o.msg_key ORDER BY o.id LIMIT ?1"
  )
    .bind(SEND_BATCH)
    .all();
  if (!results.length) return;

  const doneIds = [];
  const blocked = new Set();

  for (const row of results) {
    try {
      await sendMessage(env, row.chat_id, row.text);
      doneIds.push(row.id);
      await sleep(60);
    } catch (e) {
      console.error(`send failed chat ${row.chat_id}:`, String(e));
      if (e.status === 403 || (e.status === 400 && /chat not found/i.test(String(e)))) {
        blocked.add(row.chat_id); // اليوزر عمل block للبوت
        doneIds.push(row.id);
      } else if (e.status === 400) {
        // غالباً مشكلة في الـ HTML أو اللينك: نعيد المحاولة كنص عادي بدل ما نضيّع المشروع
        try {
          await sendMessage(env, row.chat_id, toPlain(row.text), { parse_mode: undefined });
        } catch (e2) {
          console.error(`plain fallback failed chat ${row.chat_id}:`, String(e2));
        }
        doneIds.push(row.id);
      } else {
        break; // 429 أو مشكلة شبكة: نكمل في التشغيلة الجاية
      }
    }
  }

  const stmts = [];
  if (doneIds.length) {
    stmts.push(
      env.DB.prepare("DELETE FROM outbox WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(doneIds))
    );
  }
  if (blocked.size) {
    const ids = JSON.stringify([...blocked]);
    stmts.push(env.DB.prepare("UPDATE users SET active = 0 WHERE chat_id IN (SELECT value FROM json_each(?1))").bind(ids));
    stmts.push(env.DB.prepare("DELETE FROM outbox WHERE chat_id IN (SELECT value FROM json_each(?1))").bind(ids));
  }
  // تنضيف الرسايل اللي مفيش حد مستنيها
  stmts.push(
    env.DB.prepare(
      "DELETE FROM messages WHERE created_at < ?1 AND key NOT IN (SELECT msg_key FROM outbox)"
    ).bind(Math.floor(Date.now() / 1000) - 600)
  );
  await env.DB.batch(stmts);
}

// ---------------------------------------------------------------------
//  Telegram webhook (أوامر اليوزرز)
// ---------------------------------------------------------------------
const HELP = [
  "أهلاً 👋 البوت ده بيبعتلك المشاريع الجديدة من مواقع العمل الحر أول ما تنزل.",
  "",
  "المواقع: كفيل، مستقل، نفذلي، خمسات، وFreelancer.",
  "",
  "الأوامر:",
  "/sites - اختار المواقع اللي تحب تتابعها",
  "/keywords - فلتر بكلمات (مثال: /keywords python, بوت, تصميم)",
  "/status - إعداداتك الحالية",
  "/stop - إيقاف الإشعارات",
  "/start - تشغيل الإشعارات تاني",
  "",
  "من غير كلمات مفتاحية هتوصلك كل المشاريع من المواقع المفعّلة.",
].join("\n");

async function handleUpdate(env, upd) {
  if (upd.callback_query) return handleCallback(env, upd.callback_query);

  const msg = upd.message;
  if (!msg || !msg.text || msg.chat?.type !== "private") return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const first = text.split(/\s+/)[0] || "";
  const cmd = first.toLowerCase().replace(/@.*$/, "");
  const args = text.slice(first.length).trim();

  switch (cmd) {
    case "/start": {
      await withSchema(env, () =>
        env.DB.prepare(
          "INSERT INTO users (chat_id, active, sites, keywords, created_at) VALUES (?1, 1, ?2, '', ?3) " +
            "ON CONFLICT(chat_id) DO UPDATE SET active = 1"
        )
          .bind(chatId, DEFAULT_SITES, Math.floor(Date.now() / 1000))
          .run()
      );
      return sendMessage(env, chatId, HELP + "\n\n✅ تم تفعيل الإشعارات. (Freelancer مقفول افتراضياً، فعّله من /sites)");
    }

    case "/stop": {
      await withSchema(env, () => env.DB.prepare("UPDATE users SET active = 0 WHERE chat_id = ?1").bind(chatId).run());
      return sendMessage(env, chatId, "⏸ تم إيقاف الإشعارات. ابعت /start وقت ما تحب ترجع.");
    }

    case "/sites": {
      const user = await getOrCreateUser(env, chatId);
      return sendMessage(env, chatId, "اختار المواقع (دوس على الموقع لتفعيله/إلغائه):", {
        reply_markup: sitesKeyboard(user.sites.split(",")),
      });
    }

    case "/keywords": {
      const user = await getOrCreateUser(env, chatId);
      if (!args) {
        const cur = user.keywords ? esc(user.keywords.split(",").join("، ")) : "مفيش (بتوصلك كل المشاريع)";
        return sendMessage(
          env,
          chatId,
          `🔎 كلماتك الحالية: ${cur}\n\nلتغييرها: /keywords python, بوت, تصميم\nلمسحها: /keywords clear`
        );
      }
      if (/^(clear|مسح)$/i.test(args)) {
        await env.DB.prepare("UPDATE users SET keywords = '' WHERE chat_id = ?1").bind(chatId).run();
        return sendMessage(env, chatId, "🧹 اتمسحت الكلمات. هتوصلك كل المشاريع.");
      }
      const list = [
        ...new Set(
          args
            .split(/[,،\n]/)
            .map((s) => s.trim().toLowerCase().slice(0, 30))
            .filter(Boolean)
        ),
      ].slice(0, MAX_KEYWORDS);
      await env.DB.prepare("UPDATE users SET keywords = ?1 WHERE chat_id = ?2").bind(list.join(","), chatId).run();
      return sendMessage(
        env,
        chatId,
        `✅ هتوصلك المشاريع اللي فيها واحدة من: ${esc(list.join("، "))}\n(الفلتر بيدور في العنوان والوصف، فاكتب الكلمة بالعربي والإنجليزي لو عايز)`
      );
    }

    case "/status": {
      const user = await getOrCreateUser(env, chatId);
      const names = user.sites
        .split(",")
        .map((k) => SITES.find((s) => s.key === k)?.name)
        .filter(Boolean);
      return sendMessage(
        env,
        chatId,
        [
          `الحالة: ${user.active ? "✅ شغال" : "⏸ متوقف"}`,
          `المواقع: ${names.length ? names.join("، ") : "مفيش"}`,
          `الكلمات: ${user.keywords ? esc(user.keywords.split(",").join("، ")) : "مفيش (كل المشاريع)"}`,
        ].join("\n")
      );
    }

    case "/stats": {
      if (!env.ADMIN_ID || String(chatId) !== String(env.ADMIN_ID)) return;
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM users"
      ).first();
      return sendMessage(env, chatId, `👥 المستخدمين: ${row.total} (نشطين: ${row.active})`);
    }

    case "/help":
    default:
      return sendMessage(env, chatId, HELP);
  }
}

async function handleCallback(env, cq) {
  const chatId = cq.message?.chat?.id;
  try {
    if (chatId && (cq.data || "").startsWith("t:")) {
      const key = cq.data.slice(2);
      if (SITE_KEYS.includes(key)) {
        const user = await getOrCreateUser(env, chatId);
        const set = new Set(user.sites.split(",").filter(Boolean));
        if (set.has(key)) set.delete(key);
        else set.add(key);
        const sites = SITE_KEYS.filter((k) => set.has(k)).join(",");
        await env.DB.prepare("UPDATE users SET sites = ?1 WHERE chat_id = ?2").bind(sites, chatId).run();
        await tg(env, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: cq.message.message_id,
          reply_markup: sitesKeyboard([...set]),
        });
      }
    }
  } catch (e) {
    console.error("callback failed:", String(e));
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
}

function sitesKeyboard(selected) {
  return {
    inline_keyboard: SITES.map((s) => [
      { text: `${selected.includes(s.key) ? "✅" : "❌"} ${s.name}`, callback_data: `t:${s.key}` },
    ]),
  };
}

async function getOrCreateUser(env, chatId) {
  return withSchema(env, async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (chat_id, active, sites, keywords, created_at) VALUES (?1, 1, ?2, '', ?3)"
    )
      .bind(chatId, DEFAULT_SITES, Math.floor(Date.now() / 1000))
      .run();
    return env.DB.prepare("SELECT chat_id, active, sites, keywords FROM users WHERE chat_id = ?1").bind(chatId).first();
  });
}

// ---------------------------------------------------------------------
//  Telegram API
// ---------------------------------------------------------------------
async function tg(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(`Telegram ${method} ${res.status}: ${data.description || ""}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const sendMessage = (env, chat_id, text, extra = {}) =>
  tg(env, "sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

function formatMessage(site, p) {
  const lines = [`🆕 <b>${esc(p.title)}</b>`, `🌐 ${esc(site.name)}`];
  if (p.budget) lines.push(`💰 ${esc(p.budget)}`);
  for (const e of p.extra || []) lines.push(`📌 ${esc(e)}`);
  if (p.skills?.length) lines.push(`🏷 ${esc(p.skills.join("، "))}`);
  if (p.description) lines.push("", esc(truncate(p.description, 1800)));
  lines.push("", `🔗 <a href="${esc(safeUrl(p.url))}">فتح المشروع</a>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------
//  D1
// ---------------------------------------------------------------------
async function loadState(env) {
  const { results } = await env.DB.prepare("SELECT site, last_id FROM state").all();
  return Object.fromEntries(results.map((r) => [r.site, r.last_id]));
}

async function loadUsers(env) {
  const { results } = await env.DB.prepare("SELECT chat_id, sites, keywords FROM users WHERE active = 1").all();
  return results;
}

// لو الجداول لسه مش موجودة بننشئها تلقائي ونعيد المحاولة
async function withSchema(env, fn) {
  try {
    return await fn();
  } catch (e) {
    if (/no such table/i.test(String(e))) {
      await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
      return await fn();
    }
    throw e;
  }
}

// ---------------------------------------------------------------------
//  Dry run: للتأكد إن الـ parsers شغالة (من غير إرسال ولا تخزين)
// ---------------------------------------------------------------------
async function dryRun() {
  const out = {};
  await Promise.all(
    SITES.map(async (site) => {
      try {
        const items = await site.list();
        const sorted = items.slice().sort((a, b) => b.id - a.id);
        let sample = null;
        if (sorted[0]) {
          sample = site.detail ? await site.detail(sorted[0]) : sorted[0];
          sample = { ...sample, description: truncate(sample.description || "", 400) };
        }
        out[site.key] = { found: items.length, newestIds: sorted.slice(0, 5).map((x) => x.id), sample };
      } catch (e) {
        out[site.key] = { error: String(e) };
      }
    })
  );
  return out;
}

// ---------------------------------------------------------------------
//  أدوات مساعدة
// ---------------------------------------------------------------------
function matchesKeywords(keywords, hay) {
  if (!keywords) return true;
  return keywords.split(",").some((k) => k && hay.includes(k));
}

function meta(html, name) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const t of tags) {
    if (new RegExp(`(?:property|name)=["']${name}["']`, "i").test(t)) {
      const m = t.match(/content=["']([^"']*)["']/i);
      if (m) return decode(m[1]).trim();
    }
  }
  return "";
}

function htmlToText(html) {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function textBetween(text, a, b) {
  const i = text.indexOf(a);
  if (i < 0) return "";
  const start = i + a.length;
  const end = text.indexOf(b, start);
  if (end < 0) return "";
  return text.slice(start, end).trim();
}

function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const truncate = (s, n) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// يضمن إن اللينك صالح: بيرمّز الحروف العربية ويشيل أي رموز زيادة في آخره
function safeUrl(u) {
  try {
    return new URL(decode(String(u)).replace(/[\\,;.]+$/, "")).href;
  } catch {
    return String(u);
  }
}

// نسخة نص عادي من الرسالة (اللينك بيظهر كامل) للاستخدام لو تيليجرام رفض الـ HTML
function toPlain(html) {
  return decode(html.replace(/<a href="([^"]*)">[^<]*<\/a>/g, "$1").replace(/<\/?b>/g, ""));
}

// ---------------------------------------------------------------------
//  Entry points
// ---------------------------------------------------------------------
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Telegram webhook
    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        await handleUpdate(env, await request.json());
      } catch (e) {
        console.error("update failed:", String(e));
      }
      return new Response("ok"); // دايماً 200 عشان تيليجرام ميعيدش الإرسال
    }

    // صفحات الأدمن
    const isAdmin = env.ADMIN_KEY && url.searchParams.get("key") === env.ADMIN_KEY;
    if (!isAdmin) return new Response("OK");

    // /setup?key=ADMIN_KEY : يسجل الـ webhook والأوامر
    if (url.pathname === "/setup") {
      try {
        const hook = await tg(env, "setWebhook", {
          url: `${url.origin}/webhook`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: true,
        });
        const cmds = await tg(env, "setMyCommands", {
          commands: [
            { command: "start", description: "تشغيل الإشعارات" },
            { command: "sites", description: "اختيار المواقع" },
            { command: "keywords", description: "فلتر بكلمات مفتاحية" },
            { command: "status", description: "إعداداتي" },
            { command: "stop", description: "إيقاف الإشعارات" },
            { command: "help", description: "مساعدة" },
          ],
        });
        return Response.json({ hook, cmds });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // /?key=ADMIN_KEY&ping=<chat_id> : رسالة اختبار
    if (url.searchParams.get("ping")) {
      try {
        await sendMessage(env, url.searchParams.get("ping"), "✅ البوت شغال");
        return new Response("sent");
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }

    // /?key=ADMIN_KEY : يعرض اللي الـ parsers شايفاه
    return new Response(JSON.stringify(await dryRun(), null, 2), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};

// =====================================================================
// Freelance Jobs Bot — Cloudflare Workers + Cron + D1
// Sites: Kafiil, Mostaql, Nafezly, Khamsat, Freelancer
// Required bindings/secrets:
//   DB (D1), BOT_TOKEN, WEBHOOK_SECRET, ADMIN_KEY; ADMIN_ID optional
// Cron: * * * * *
// =====================================================================

const MAX_NEW_PER_RUN = 10;
const SEND_BATCH = 30;
const MAX_KEYWORDS = 20;
const DEFAULT_SITES = "kafiil,mostaql,nafezly,khamsat,freelancer";
const MAX_DESCRIPTION = 1800;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
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
// Site parsers
// ---------------------------------------------------------------------
function htmlSite({ key, name, base, listUrl, linkRe }) {
  return {
    key,
    name,
    async list() {
      const res = await fetch(listUrl, { headers: HEADERS, redirect: "follow" });
      if (!res.ok) throw new Error(`${key} list HTTP ${res.status}`);
      const html = await res.text();
      if (looksLikeChallenge(html)) throw new Error(`${key} list returned an anti-bot/challenge page`);

      const found = new Map();
      for (const match of html.matchAll(linkRe)) {
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        const path = match[0].split(/[?#]/, 1)[0];
        const url = new URL(path, base).href;
        if (!found.has(id)) found.set(id, url);
      }
      return [...found].map(([id, url]) => ({ id, url }));
    },
    async detail(item) {
      const res = await fetch(item.url, { headers: HEADERS, redirect: "follow" });
      if (!res.ok) throw new Error(`${key} detail HTTP ${res.status}`);
      const html = await res.text();
      if (looksLikeChallenge(html)) throw new Error(`${key} detail returned an anti-bot/challenge page`);
      return parseHtmlProject(key, html, item);
    },
  };
}

const freelancer = {
  key: "freelancer",
  name: "Freelancer",
  async list() {
    const base = "https://www.freelancer.com/api/projects/0.1/projects/active/";
    const urls = [
      `${base}?limit=30&full_description=true&job_details=true&sort_field=submitdate&reverse_sort=true`,
      `${base}?limit=30&full_description=true&job_details=true`,
    ];
    let lastError = "no successful response";
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { ...HEADERS, Accept: "application/json" } });
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          continue;
        }
        const data = await res.json();
        const projects = data?.result?.projects;
        if (!Array.isArray(projects)) {
          lastError = "API response did not contain result.projects";
          continue;
        }
        return projects.map((p) => {
          const currency = p.currency || {};
          const budgetObj = p.budget || {};
          let budget = "";
          if (budgetObj.minimum != null || budgetObj.maximum != null) {
            const low = budgetObj.minimum ?? "?";
            const high = budgetObj.maximum ?? "?";
            budget = `${currency.sign || ""}${low} - ${currency.sign || ""}${high}${currency.code ? ` ${currency.code}` : ""}`.trim();
            if (p.type === "hourly") budget += " (بالساعة)";
          }
          const extra = [];
          if (p.bid_stats?.bid_count != null) extra.push(`عدد العروض: ${p.bid_stats.bid_count}`);
          return {
            id: Number(p.id),
            url: `https://www.freelancer.com/projects/${p.seo_url || p.id}`,
            title: cleanText(p.title || `مشروع جديد #${p.id}`),
            description: cleanText(p.description || p.preview_description || ""),
            budget,
            skills: (p.jobs || []).map((job) => cleanText(job.name || "")).filter(Boolean).slice(0, 8),
            extra,
          };
        }).filter((p) => Number.isSafeInteger(p.id) && p.id > 0);
      } catch (error) {
        lastError = String(error);
      }
    }
    throw new Error(`Freelancer API failed: ${lastError}`);
  },
};

const SITES = [
  htmlSite({
    key: "kafiil",
    name: "كفيل",
    base: "https://kafiil.com",
    listUrl: "https://kafiil.com/projects",
    linkRe: /\/project\/(\d+)(?:-[^"'\s<>?#]*)?/g,
  }),
  htmlSite({
    key: "mostaql",
    name: "مستقل",
    base: "https://mostaql.com",
    listUrl: "https://mostaql.com/projects",
    linkRe: /\/project\/(\d+)(?:-[^"'\s<>?#]*)?/g,
  }),
  htmlSite({
    key: "nafezly",
    name: "نفذلي",
    base: "https://nafezly.com",
    listUrl: "https://nafezly.com/projects",
    linkRe: /\/project\/(\d+)(?:-[^"'\s<>?#]*)?/g,
  }),
  htmlSite({
    key: "khamsat",
    name: "خمسات",
    base: "https://khamsat.com",
    listUrl: "https://khamsat.com/community/requests",
    linkRe: /\/community\/requests\/(\d+)(?:-[^"'\s<>?#]*)?/g,
  }),
  freelancer,
];
const SITE_KEYS = SITES.map((site) => site.key);

function looksLikeChallenge(html) {
  return /cf-chl-|challenge-platform|verify you are human|checking your browser|just a moment\.\.\./i.test(String(html).slice(0, 25000));
}

function parseHtmlProject(siteKey, html, item) {
  const plain = htmlToText(html);
  const jsonLd = extractJsonLd(html);
  const h1 = firstTagText(html, "h1");
  const pageTitle = firstTagText(html, "title");
  const metaTitle = meta(html, "og:title") || meta(html, "twitter:title");
  let title = cleanTitle(metaTitle || h1 || jsonLd.title || pageTitle || "", siteKey);
  const slugTitle = titleFromUrl(item.url);
  if (!title || /^مشروع جديد\s*#?\d+$/i.test(title) || isGenericTitle(title, siteKey)) {
    title = slugTitle || `مشروع جديد #${item.id}`;
  }

  // Some sites expose the full project description only in the visible HTML,
  // not in Open Graph metadata. Prefer label-bounded text, then metadata/JSON-LD,
  // then likely content containers/paragraphs.
  let description = "";
  if (siteKey === "mostaql") {
    description = textAfterAnyLabel(plain, ["تفاصيل المشروع", "وصف المشروع"], ["حالة المشروع", "الميزانية", "مدة التنفيذ"]);
  } else if (siteKey === "nafezly") {
    description = textAfterAnyLabel(plain, ["تفاصيل المشروع", "وصف المشروع", "قم بوصف المشروع"], ["الميزانية", "المدة المتوقعة", "عدد العروض", "حالة المشروع"]);
  } else if (siteKey === "khamsat") {
    description = textAfterAnyLabel(plain, ["تفاصيل الطلب", "تفاصيل المشروع", "وصف الطلب"], ["آخر تفاعل", "تاريخ النشر", "صاحب الطلب", "الميزانية"]);
  }
  if (!isUsefulDescription(description, title)) description = "";
  if (!description) description = meta(html, "og:description") || meta(html, "description") || meta(html, "twitter:description") || cleanText(jsonLd.description || "");
  if (!isUsefulDescription(description, title)) description = "";
  if (!description) description = extractLikelyDescription(html, title);
  description = normalizeDescription(description, title);

  let budget = extractBudget(plain);
  if (!budget) budget = extractBudget(`${meta(html, "og:description")} ${meta(html, "description")} ${jsonLd.description || ""}`);

  const skills = extractSkills(plain);
  const extra = [];
  const bids = plain.match(/(?:عدد العروض|العروض|bids)\s*:?\s*(\d+)/i);
  if (bids) extra.push(`عدد العروض: ${bids[1]}`);

  return { ...item, title: title || `مشروع جديد #${item.id}`, description, budget, skills, extra };
}

function extractJsonLd(html) {
  const scripts = String(html).matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const data = JSON.parse(decode(match[1].trim()));
      const queue = Array.isArray(data) ? [...data] : [data];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node)) { queue.push(...node); continue; }
        if (node.description && typeof node.description === "string") {
          return { description: cleanText(node.description), title: cleanText(node.headline || node.name || "") };
        }
        if (node["@graph"]) queue.push(node["@graph"]);
      }
    } catch (_) {
      // Ignore invalid JSON-LD and use normal HTML extraction.
    }
  }
  return {};
}

function extractLikelyDescription(html, title) {
  const containerRe = /<(div|section|article|blockquote)[^>]*(?:class|id)=["'][^"']*(description|details|project-content|request-content|post-content|post-body|content-body|project-body|request-body|brief)[^"']*["'][^>]*>/gi;
  const candidates = [];
  for (const match of String(html).matchAll(containerRe)) {
    const tag = match[1].toLowerCase();
    const inner = matchingElementInnerHTML(html, tag, match.index);
    if (!inner) continue;
    const text = htmlToText(inner);
    if (isUsefulDescription(text, title)) candidates.push(text);
    if (candidates.length >= 4) break;
  }
  candidates.sort((a, b) => Math.min(b.length, 2400) - Math.min(a.length, 2400));
  if (candidates.length) return candidates[0];

  const paragraphTexts = [];
  for (const match of String(html).matchAll(/<(p|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = htmlToText(match[2]);
    if (isUsefulDescription(text, title) && text.length >= 45) paragraphTexts.push(text);
    if (paragraphTexts.join("\n").length > 3500) break;
  }
  if (paragraphTexts.length) return paragraphTexts.slice(0, 5).join("\n");

  // Last resort: accept only a modest main/article section, not the whole navigation-heavy page.
  const mainMatch = String(html).match(/<(article|main)\b[^>]*>([\s\S]{0,20000}?)<\/\1>/i);
  if (mainMatch) {
    const text = htmlToText(mainMatch[2]);
    if (isUsefulDescription(text, title)) return text;
  }
  return "";
}

function matchingElementInnerHTML(html, tag, openIndex) {
  const openEnd = html.indexOf(">", openIndex);
  if (openEnd < 0) return "";
  const tokenRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tokenRe.lastIndex = openEnd + 1;
  let depth = 1;
  let match;
  let scanned = 0;
  while ((match = tokenRe.exec(html)) && scanned < 25000) {
    scanned = match.index - openEnd;
    if (/^<\//.test(match[0])) depth--;
    else if (!/\/\s*>$/.test(match[0])) depth++;
    if (depth === 0) return html.slice(openEnd + 1, match.index);
  }
  return "";
}

function extractSkills(plain) {
  const result = [];
  const match = String(plain).match(/(?:المهارات المطلوبة|المهارات|skills)\s*:?\s*([\s\S]{0,300})/i);
  if (!match) return result;
  const section = match[1].split(/(?:الميزانية|مدة التنفيذ|حالة المشروع|عدد العروض|الوصف|تفاصيل المشروع)/i)[0];
  return section.split(/[،,|\n•·]/).map((s) => cleanText(s)).filter((s) => s.length > 1 && s.length < 50).slice(0, 8);
}

// ---------------------------------------------------------------------
// Cron: fetch new projects -> enqueue once -> send outbox batch
// ---------------------------------------------------------------------
async function run(env) {
  const startedAt = Date.now();
  const [state, users] = await withSchema(env, () => Promise.all([loadState(env), loadUsers(env)]));
  const stateUpdates = {};
  const pending = [];
  let processed = 0;

  console.log(`[run] started; activeUsers=${users.length}; sites=${SITES.length}`);
  if (!users.length) console.warn("[run] no active users; discovered projects will be baselined without notifications");

  const listResults = await Promise.allSettled(SITES.map((site) => site.list()));
  for (let i = 0; i < SITES.length; i++) {
    const site = SITES[i];
    const result = listResults[i];
    if (result.status === "rejected") {
      console.error(`[${site.key}] list failed: ${String(result.reason)}`);
      continue; // Never advance state on a failed fetch.
    }

    const items = result.value.filter((item) => Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0);
    const newestId = items.length ? Math.max(...items.map((item) => Number(item.id))) : null;
    console.log(`[${site.key}] found=${items.length}; storedLastId=${state[site.key] ?? "missing"}; newestId=${newestId ?? "none"}`);
    if (!items.length) {
      console.warn(`[${site.key}] no project links parsed; state was not changed`);
      continue;
    }

    // Repair a missing state row immediately after a successful list fetch.
    // This first successful scan is a baseline: do not flood users with old projects.
    if (state[site.key] == null) {
      await env.DB.prepare("INSERT OR IGNORE INTO state (site, last_id) VALUES (?1, ?2)")
        .bind(site.key, newestId).run();
      const stored = await env.DB.prepare("SELECT last_id FROM state WHERE site = ?1").bind(site.key).first();
      state[site.key] = Number(stored?.last_id ?? newestId);
      console.warn(`[${site.key}] initialized missing state row at last_id=${state[site.key]}; existing projects were not sent`);
      continue;
    }

    const lastId = Number(state[site.key]);
    const fresh = items
      .filter((item) => Number(item.id) > lastId)
      .sort((a, b) => Number(a.id) - Number(b.id));
    console.log(`[${site.key}] freshProjects=${fresh.length}`);
    if (!fresh.length) continue;

    const audience = users.filter((user) => parseSites(user.sites).includes(site.key));
    if (!audience.length) {
      // Do not accumulate old jobs while nobody is subscribed to this site.
      stateUpdates[site.key] = newestId;
      console.warn(`[${site.key}] no active subscribers selected this site; skipping ${fresh.length} new jobs and advancing to ${newestId}`);
      continue;
    }

    let lastProcessedId = lastId;
    for (const item of fresh) {
      if (processed >= MAX_NEW_PER_RUN) {
        console.warn(`[run] MAX_NEW_PER_RUN=${MAX_NEW_PER_RUN} reached; remaining projects will be handled in later runs`);
        break;
      }

      let full;
      try {
        full = site.detail ? await site.detail(item) : item;
      } catch (error) {
        console.error(`[${site.key}] detail failed id=${item.id}: ${String(error)}`);
        full = { ...item, title: titleFromUrl(item.url) || `مشروع جديد #${item.id}`, description: "", budget: "", skills: [], extra: [] };
      }

      const haystack = `${full.title || ""} ${full.description || ""} ${(full.skills || []).join(" ")}`.toLocaleLowerCase();
      const recipients = audience
        .filter((user) => matchesKeywords(user.keywords, haystack))
        .map((user) => Number(user.chat_id));

      processed++;
      lastProcessedId = Number(item.id);
      if (recipients.length) {
        pending.push({ key: `${site.key}:${item.id}`, text: formatMessage(site, full), chatIds: recipients });
        console.log(`[${site.key}] project=${item.id}; recipients=${recipients.length}; queued=true`);
      } else {
        console.log(`[${site.key}] project=${item.id}; recipients=0; skipped_by_keyword_filter=true`);
      }
    }
    if (lastProcessedId > lastId) stateUpdates[site.key] = lastProcessedId;
  }

  const recipientCount = pending.reduce((sum, project) => sum + project.chatIds.length, 0);
  console.log(`[run] discovery complete; processed=${processed}; pendingProjects=${pending.length}; pendingRecipients=${recipientCount}; stateUpdates=${Object.keys(stateUpdates).length}`);
  await enqueueAndSave(env, pending, stateUpdates);
  await flushOutbox(env);
  console.log(`[run] complete in ${Date.now() - startedAt}ms`);
}

async function enqueueAndSave(env, pending, stateUpdates) {
  const now = Math.floor(Date.now() / 1000);
  const statements = [];
  for (const message of pending) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO messages (key, text, created_at) VALUES (?1, ?2, ?3)")
        .bind(message.key, message.text, now)
    );
    // Avoid duplicate outbox rows if scheduled invocations overlap or a key is reprocessed.
    statements.push(
      env.DB.prepare(
        "INSERT INTO outbox (chat_id, msg_key) " +
        "SELECT value, ?1 FROM json_each(?2) " +
        "WHERE NOT EXISTS (SELECT 1 FROM outbox o WHERE o.chat_id = value AND o.msg_key = ?1)"
      ).bind(message.key, JSON.stringify(message.chatIds))
    );
  }
  for (const [site, id] of Object.entries(stateUpdates)) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO state (site, last_id) VALUES (?1, ?2) " +
        "ON CONFLICT(site) DO UPDATE SET last_id = MAX(state.last_id, excluded.last_id)"
      ).bind(site, id)
    );
  }
  if (statements.length) await env.DB.batch(statements);
  console.log(`[db] queuedProjects=${pending.length}; queuedRecipients=${pending.reduce((sum, project) => sum + project.chatIds.length, 0)}; stateUpdates=${Object.keys(stateUpdates).length}`);
}

async function flushOutbox(env) {
  const { results = [] } = await env.DB.prepare(
    "SELECT o.id, o.chat_id, o.msg_key, m.text " +
    "FROM outbox o JOIN messages m ON m.key = o.msg_key ORDER BY o.id LIMIT ?1"
  ).bind(SEND_BATCH).all();
  console.log(`[outbox] rowsToProcess=${results.length}`);
  if (!results.length) return;

  const doneIds = [];
  const deferredIds = [];
  const blockedChats = new Set();
  for (const row of results) {
    try {
      await sendMessage(env, row.chat_id, row.text);
      doneIds.push(row.id);
      console.log(`[outbox] sent id=${row.id} chat=${row.chat_id} key=${row.msg_key}`);
      await sleep(60);
    } catch (error) {
      console.error(`[outbox] send failed id=${row.id} chat=${row.chat_id} status=${error.status ?? "unknown"}: ${String(error)}`);
      if (isBlockedChatError(error)) {
        blockedChats.add(Number(row.chat_id));
        doneIds.push(row.id);
        continue;
      }
      if (error.status === 400) {
        try {
          await sendMessage(env, row.chat_id, toPlain(row.text), { parse_mode: undefined });
          doneIds.push(row.id);
          console.log(`[outbox] plain-text fallback sent id=${row.id} chat=${row.chat_id}`);
        } catch (fallbackError) {
          console.error(`[outbox] plain-text fallback failed id=${row.id} chat=${row.chat_id}: ${String(fallbackError)}`);
          if (isBlockedChatError(fallbackError)) {
            blockedChats.add(Number(row.chat_id));
            doneIds.push(row.id);
          } else {
            deferredIds.push(row.id);
          }
        }
        continue;
      }
      // Network failures, rate limits, and server errors stay in the queue.
      break;
    }
  }

  const statements = [];
  if (doneIds.length) {
    statements.push(env.DB.prepare("DELETE FROM outbox WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(doneIds)));
  }
  if (deferredIds.length) {
    const idsJson = JSON.stringify(deferredIds);
    statements.push(
      env.DB.prepare(
        "INSERT INTO outbox (chat_id, msg_key) " +
        "SELECT chat_id, msg_key FROM outbox WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id"
      ).bind(idsJson)
    );
    statements.push(env.DB.prepare("DELETE FROM outbox WHERE id IN (SELECT value FROM json_each(?1))").bind(idsJson));
  }
  if (blockedChats.size) {
    const idsJson = JSON.stringify([...blockedChats]);
    statements.push(env.DB.prepare("UPDATE users SET active = 0 WHERE chat_id IN (SELECT value FROM json_each(?1))").bind(idsJson));
    statements.push(env.DB.prepare("DELETE FROM outbox WHERE chat_id IN (SELECT value FROM json_each(?1))").bind(idsJson));
  }
  statements.push(
    env.DB.prepare("DELETE FROM messages WHERE created_at < ?1 AND key NOT IN (SELECT msg_key FROM outbox)")
      .bind(Math.floor(Date.now() / 1000) - 600)
  );
  if (statements.length) await env.DB.batch(statements);
  console.log(`[outbox] complete; removed=${doneIds.length}; deferred=${deferredIds.length}; blockedChats=${blockedChats.size}`);
}

// ---------------------------------------------------------------------
// Telegram commands/webhook
// ---------------------------------------------------------------------
const HELP = [
  "أهلاً 👋 البوت ده بيبعتلك المشاريع الجديدة من مواقع العمل الحر.",
  "",
  "المواقع: كفيل، مستقل، نفذلي، خمسات، وFreelancer.",
  "",
  "الأوامر:",
  "/sites - اختيار المواقع",
  "/sites all - تفعيل كل المواقع مرة واحدة",
  "/keywords python, بوت, تصميم - فلترة بالكلمات",
  "/keywords clear - مسح فلتر الكلمات",
  "/status - إعداداتك الحالية",
  "/stop - إيقاف الإشعارات",
  "/start - تشغيل الإشعارات",
  "",
  "من غير كلمات مفتاحية هتوصلك كل المشاريع من المواقع المفعّلة.",
].join("\n");

async function handleUpdate(env, update) {
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg || !msg.text || msg.chat?.type !== "private") return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const first = text.split(/\s+/)[0] || "";
  const command = first.toLowerCase().replace(/@.*$/, "");
  const args = text.slice(first.length).trim();

  switch (command) {
    case "/start": {
      await withSchema(env, () => env.DB.prepare(
        "INSERT INTO users (chat_id, active, sites, keywords, created_at) VALUES (?1, 1, ?2, '', ?3) " +
        "ON CONFLICT(chat_id) DO UPDATE SET active = 1"
      ).bind(chatId, DEFAULT_SITES, Math.floor(Date.now() / 1000)).run());
      return sendMessage(env, chatId, `${HELP}\n\n✅ تم تفعيل الإشعارات. لو عايز كل المواقع بما فيها Freelancer ابعت /sites all`);
    }
    case "/stop": {
      await withSchema(env, () => env.DB.prepare("UPDATE users SET active = 0 WHERE chat_id = ?1").bind(chatId).run());
      return sendMessage(env, chatId, "⏸ تم إيقاف الإشعارات. ابعت /start وقت ما تحب ترجع.");
    }
    case "/sites": {
      const user = await getOrCreateUser(env, chatId);
      if (/^(all|كلها|الكل)$/i.test(args)) {
        await env.DB.prepare("UPDATE users SET sites = ?1, active = 1 WHERE chat_id = ?2")
          .bind(DEFAULT_SITES, chatId).run();
        return sendMessage(env, chatId, "✅ تم تفعيل كل المواقع الخمسة، ومنها نفذلي وFreelancer.", {
          reply_markup: sitesKeyboard(SITE_KEYS),
        });
      }
      return sendMessage(env, chatId, "اختار المواقع اللي عايز تتابعها، أو ابعت /sites all لتفعيلها كلها:", {
        reply_markup: sitesKeyboard(parseSites(user.sites)),
      });
    }
    case "/keywords": {
      const user = await getOrCreateUser(env, chatId);
      if (!args) {
        const current = user.keywords ? esc(user.keywords.split(",").join("، ")) : "مفيش (بتوصلك كل المشاريع)";
        return sendMessage(env, chatId, `🔎 كلماتك الحالية: ${current}\n\nلتغييرها: /keywords python, بوت, تصميم\nلمسحها: /keywords clear`);
      }
      if (/^(clear|مسح)$/i.test(args)) {
        await env.DB.prepare("UPDATE users SET keywords = '' WHERE chat_id = ?1").bind(chatId).run();
        return sendMessage(env, chatId, "🧹 اتمسحت الكلمات. هتوصلك كل المشاريع.");
      }
      const list = [...new Set(args.split(/[,،\n]/).map((value) => value.trim().toLocaleLowerCase().slice(0, 30)).filter(Boolean))].slice(0, MAX_KEYWORDS);
      await env.DB.prepare("UPDATE users SET keywords = ?1 WHERE chat_id = ?2").bind(list.join(","), chatId).run();
      return sendMessage(env, chatId, `✅ هتوصلك المشاريع اللي فيها واحدة من: ${esc(list.join("، "))}\n(الفلتر بيدور في العنوان والوصف والمهارات)`);
    }
    case "/status": {
      const user = await getOrCreateUser(env, chatId);
      const selected = parseSites(user.sites);
      const names = selected.map((key) => SITES.find((site) => site.key === key)?.name).filter(Boolean);
      return sendMessage(env, chatId, [
        `الحالة: ${user.active ? "✅ شغال" : "⏸ متوقف"}`,
        `المواقع: ${names.length ? names.join("، ") : "مفيش"}`,
        `الكلمات: ${user.keywords ? esc(user.keywords.split(",").join("، ")) : "مفيش (كل المشاريع)"}`,
      ].join("\n"));
    }
    case "/stats": {
      if (!env.ADMIN_ID || String(chatId) !== String(env.ADMIN_ID)) return;
      const row = await env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM users").first();
      return sendMessage(env, chatId, `👥 المستخدمين: ${row.total} (نشطين: ${row.active})`);
    }
    case "/help":
    default:
      return sendMessage(env, chatId, HELP);
  }
}

async function handleCallback(env, callback) {
  const chatId = callback.message?.chat?.id;
  try {
    if (chatId && String(callback.data || "").startsWith("t:")) {
      const key = callback.data.slice(2);
      if (SITE_KEYS.includes(key)) {
        const user = await getOrCreateUser(env, chatId);
        const selected = new Set(parseSites(user.sites));
        if (selected.has(key)) selected.delete(key); else selected.add(key);
        const nextSites = SITE_KEYS.filter((siteKey) => selected.has(siteKey));
        await env.DB.prepare("UPDATE users SET sites = ?1 WHERE chat_id = ?2").bind(nextSites.join(","), chatId).run();
        await tg(env, "editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: callback.message.message_id,
          reply_markup: sitesKeyboard(nextSites),
        });
      }
    }
  } catch (error) {
    console.error(`[callback] failed: ${String(error)}`);
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});
}

function sitesKeyboard(selected) {
  return {
    inline_keyboard: SITES.map((site) => [{
      text: `${selected.includes(site.key) ? "✅" : "❌"} ${site.name}`,
      callback_data: `t:${site.key}`,
    }]),
  };
}

async function getOrCreateUser(env, chatId) {
  return withSchema(env, async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (chat_id, active, sites, keywords, created_at) VALUES (?1, 1, ?2, '', ?3)"
    ).bind(chatId, DEFAULT_SITES, Math.floor(Date.now() / 1000)).run();
    return env.DB.prepare("SELECT chat_id, active, sites, keywords FROM users WHERE chat_id = ?1").bind(chatId).first();
  });
}

// ---------------------------------------------------------------------
// Telegram API / formatting
// ---------------------------------------------------------------------
async function tg(env, method, payload) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN secret is missing");
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(`Telegram ${method} HTTP ${response.status}: ${data.description || "unknown error"}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const sendMessage = (env, chat_id, text, extra = {}) => tg(env, "sendMessage", {
  chat_id,
  text,
  parse_mode: "HTML",
  disable_web_page_preview: true,
  ...extra,
});

function formatMessage(site, project) {
  const lines = [`🆕 <b>${esc(project.title || `مشروع جديد #${project.id}`)}</b>`, `🌐 ${esc(site.name)}`];
  if (project.budget) lines.push(`💰 ${esc(project.budget)}`);
  for (const item of project.extra || []) lines.push(`📌 ${esc(item)}`);
  if (project.skills?.length) lines.push(`🏷 ${esc(project.skills.join("، "))}`);
  if (project.description) lines.push("", esc(truncate(project.description, MAX_DESCRIPTION)));
  lines.push("", `🔗 <a href="${esc(safeUrl(project.url))}">فتح المشروع</a>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// D1/schema
// ---------------------------------------------------------------------
async function loadState(env) {
  const { results = [] } = await env.DB.prepare("SELECT site, last_id FROM state").all();
  return Object.fromEntries(results.map((row) => [row.site, Number(row.last_id)]));
}

async function loadUsers(env) {
  const { results = [] } = await env.DB.prepare("SELECT chat_id, sites, keywords FROM users WHERE active = 1").all();
  return results;
}

async function withSchema(env, callback) {
  try {
    return await callback();
  } catch (error) {
    if (/no such table/i.test(String(error))) {
      await env.DB.batch(SCHEMA.map((statement) => env.DB.prepare(statement)));
      return await callback();
    }
    throw error;
  }
}

// ---------------------------------------------------------------------
// Admin-only dry run and setup endpoints
// ---------------------------------------------------------------------
async function dryRun() {
  const output = {};
  await Promise.all(SITES.map(async (site) => {
    try {
      const items = await site.list();
      const sorted = items.slice().sort((a, b) => Number(b.id) - Number(a.id));
      let sample = null;
      if (sorted[0]) {
        sample = site.detail ? await site.detail(sorted[0]) : sorted[0];
        sample = { ...sample, description: truncate(sample.description || "", 500) };
      }
      output[site.key] = { found: items.length, newestIds: sorted.slice(0, 5).map((item) => item.id), sample };
    } catch (error) {
      output[site.key] = { error: String(error) };
    }
  }));
  return output;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function parseSites(value) {
  return String(value || "").split(",").map((site) => site.trim()).filter((site) => SITE_KEYS.includes(site));
}

function matchesKeywords(keywords, haystack) {
  const terms = String(keywords || "").split(",").map((term) => term.trim().toLocaleLowerCase()).filter(Boolean);
  if (!terms.length) return true;
  return terms.some((term) => haystack.includes(term));
}

function meta(html, name) {
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) || []) {
    const key = getAttribute(tag, "property") || getAttribute(tag, "name") || getAttribute(tag, "itemprop");
    if (String(key).toLowerCase() === String(name).toLowerCase()) {
      const content = getAttribute(tag, "content");
      if (content) return cleanText(content);
    }
  }
  return "";
}

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag).match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match ? decode(match[2]) : "";
}

function firstTagText(html, tagName) {
  const match = String(html).match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? htmlToText(match[1]) : "";
}

function titleFromUrl(value) {
  try {
    let slug = decodeURIComponent(new URL(value).pathname.split("/").filter(Boolean).pop() || "");
    slug = slug.replace(/^\d+[-_]?/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    return cleanText(slug);
  } catch (_) {
    return "";
  }
}

function cleanTitle(value, siteKey) {
  let title = cleanText(value);
  title = title.replace(/\s*[|–—-]\s*(مستقل|خمسات|نفذلي|كفيل|كافيل|Mostaql|Khamsat|Nafezly|Kafiil|Freelancer).*$/i, "").trim();
  if (siteKey === "khamsat") title = title.replace(/^طلبات الخدمات غير الموجودة\s*[|–—-]?\s*/i, "").trim();
  return title;
}

function isGenericTitle(title, siteKey) {
  if (!title) return true;
  if (siteKey === "khamsat" && /^(?:طلبات الخدمات غير الموجودة|خمسات|المجتمع)(?:\s|$)/i.test(title)) return true;
  return /^(مشروع جديد|project)\s*#?\d+$/i.test(title);
}

function textAfterAnyLabel(text, startLabels, stopLabels) {
  const source = String(text || "");
  const lower = source.toLocaleLowerCase();
  let chosen = null;
  for (const label of startLabels) {
    const index = lower.indexOf(label.toLocaleLowerCase());
    if (index >= 0 && (!chosen || index < chosen.index)) chosen = { index, label };
  }
  if (!chosen) return "";
  let start = chosen.index + chosen.label.length;
  while (start < source.length && /[\s:：،-]/.test(source[start])) start++;
  let end = source.length;
  for (const label of stopLabels) {
    const index = lower.indexOf(label.toLocaleLowerCase(), start);
    if (index >= 0 && index < end) end = index;
  }
  return cleanText(source.slice(start, end)).slice(0, 6000);
}

function extractBudget(text) {
  const source = normalizeDigits(String(text || ""));
  const label = /(?:الميزانية(?:\s+المتوقعة)?|ميزانية المشروع|budget|estimated budget|price range)\s*[:：]?/i.exec(source);
  if (!label) return "";
  const after = source.slice(label.index + label[0].length, label.index + label[0].length + 220);
  const amount = /(?:[$€£]\s*)?\d+(?:[,.٫]\d+)?(?:\s*(?:-|–|—|إلى|الى|to)\s*(?:[$€£]\s*)?\d+(?:[,.٫]\d+)?)?(?:\s*(?:USD|US\$|EUR|GBP|SAR|EGP|دولار(?:اً)?|ريال(?:اً)?|جنيه(?:اً)?))?/i.exec(after);
  if (!amount || !/\d/.test(amount[0])) return "";
  const value = cleanText(amount[0]);
  return value.length <= 65 ? value : "";
}

function normalizeDigits(value) {
  return String(value).replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/٫/g, ".");
}

function normalizeDescription(value, title) {
  let result = cleanText(value);
  if (!isUsefulDescription(result, title)) return "";
  // Remove common adjacent labels at the beginning/end of scraped content.
  result = result.replace(/^(?:تفاصيل المشروع|تفاصيل الطلب|وصف المشروع|الوصف)\s*[:：-]?\s*/i, "");
  result = result.replace(/\s+(?:حالة المشروع|عدد العروض|آخر تفاعل)\s*:?\s*[\s\S]*$/i, "").trim();
  return isUsefulDescription(result, title) ? result.slice(0, 6000) : "";
}

function isUsefulDescription(value, title) {
  const text = cleanText(value);
  if (text.length < 25) return false;
  if (title && text.toLocaleLowerCase() === cleanText(title).toLocaleLowerCase()) return false;
  if (/^(?:تسجيل الدخول|إنشاء حساب|طلبات الخدمات غير الموجودة|الرئيسية|أضف مشروعك|بحث|التصنيفات)$/i.test(text)) return false;
  return true;
}

function htmlToText(html) {
  return decode(String(html)
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[\t\u00a0 ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanText(value) {
  return decode(String(value ?? "").replace(/<[^>]+>/g, " "))
    .replace(/[\t\u00a0 ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function decode(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—");
}

function safeCodePoint(value) {
  try { return String.fromCodePoint(value); } catch (_) { return ""; }
}

const esc = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const truncate = (value, max) => {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeUrl(value) {
  try {
    const url = new URL(decode(String(value)).replace(/[\\,;.]+$/, ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "https://example.com";
    return url.href;
  } catch (_) {
    return "https://example.com";
  }
}

function toPlain(html) {
  return decode(String(html)
    .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<\/?(?:b|strong|i|em)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " "))
    .replace(/[\t ]+/g, " ")
    .trim();
}

function isBlockedChatError(error) {
  const message = String(error || "").toLowerCase();
  return error?.status === 403 || (error?.status === 400 && /(chat not found|bot was blocked|user is deactivated|can't initiate conversation)/i.test(message));
}

// ---------------------------------------------------------------------
// Worker entry points
// ---------------------------------------------------------------------
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env).catch((error) => {
      console.error(`[scheduled] run failed: ${String(error)} ${error?.stack || ""}`);
    }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      try {
        await handleUpdate(env, await request.json());
      } catch (error) {
        console.error(`[webhook] update failed: ${String(error)} ${error?.stack || ""}`);
      }
      return new Response("ok");
    }

    // Keep diagnostic/setup endpoints private. No ADMIN_KEY is needed for normal cron/webhook operation.
    const isAdmin = Boolean(env.ADMIN_KEY) && url.searchParams.get("key") === env.ADMIN_KEY;
    if (!isAdmin) return new Response("OK");

    if (url.pathname === "/setup") {
      try {
        const hook = await tg(env, "setWebhook", {
          url: `${url.origin}/webhook`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: true,
        });
        const commands = await tg(env, "setMyCommands", {
          commands: [
            { command: "start", description: "تشغيل الإشعارات" },
            { command: "sites", description: "اختيار المواقع" },
            { command: "keywords", description: "فلتر بالكلمات المفتاحية" },
            { command: "status", description: "إعداداتي" },
            { command: "stop", description: "إيقاف الإشعارات" },
            { command: "help", description: "مساعدة" },
          ],
        });
        return Response.json({ hook, commands });
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
    }

    if (url.searchParams.has("ping")) {
      try {
        await sendMessage(env, url.searchParams.get("ping"), "✅ البوت شغال");
        return new Response("sent");
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
    }

    if (url.searchParams.get("db") === "1") {
      try {
        const [state, users, outbox] = await Promise.all([
          env.DB.prepare("SELECT site, last_id FROM state ORDER BY site").all(),
          env.DB.prepare("SELECT chat_id, active, sites, keywords FROM users ORDER BY created_at DESC LIMIT 50").all(),
          env.DB.prepare("SELECT COUNT(*) AS total FROM outbox").first(),
        ]);
        return Response.json({ state: state.results, users: users.results, outbox: outbox.total });
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
    }

    return Response.json(await dryRun());
  },
};

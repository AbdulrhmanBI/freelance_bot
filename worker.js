// =====================================================================
// Freelance Jobs Bot — Cloudflare Workers + Cron + D1
// Sites: Kafiil, Mostaql, Nafezly (public Telegram feed), Khamsat, Freelancer
// Required bindings/secrets:
//   DB (D1), BOT_TOKEN, WEBHOOK_SECRET, ADMIN_KEY; ADMIN_ID optional
// Cron: * * * * *
// Telegram UI: clickable profile greeting only on /start; all inline buttons are English.
// Freelancer source: supported time_updated sort, newest-first, original submission age <= 15 minutes.
// =====================================================================

const MAX_NEW_PER_RUN = 10;
const SEND_BATCH = 30;
const MAX_KEYWORDS = 20;
const DEFAULT_SITES = "kafiil,mostaql,nafezly,khamsat,freelancer";
const MAX_DESCRIPTION = 3200;
// Freelancer: only deliver projects whose original submission timestamp is within 15 minutes.
// The API query sorts by a supported field (time_updated); we still validate the original
// submission time locally so an old project that was merely updated is never announced.
const FREELANCER_MAX_AGE_SECONDS = 15 * 60;
const FREELANCER_FUTURE_CLOCK_SKEW_SECONDS = 5 * 60;

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
  "CREATE TABLE IF NOT EXISTS user_input_state (chat_id INTEGER PRIMARY KEY, action TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
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
    const nowAtStart = Math.floor(Date.now() / 1000);
    const cutoffAtStart = nowAtStart - FREELANCER_MAX_AGE_SECONDS;

    // Freelancer's supported sort field here is time_updated (not submitdate).
    // reverse_sort=false returns newest first in the SDK examples. Filter the API
    // server-side to a 15-minute window, and enforce original submission time locally.
    // to_time bounds the window so future projects are not inadvertently included.
    const filteredUrls = [
      `${base}?limit=50&full_description=true&job_details=true&from_time=${cutoffAtStart}&to_time=${nowAtStart}&sort_field=time_updated&reverse_sort=false`,
      `${base}?limit=50&full_description=true&job_details=true&from_time=${cutoffAtStart}&sort_field=time_updated&reverse_sort=false`,
    ];

    let lastError = "no successful response";
    let sawValidProjectArray = false;

    const convertAndFilter = (projects, attemptLabel) => {
      const checkedAt = Math.floor(Date.now() / 1000);
      const cutoff = checkedAt - FREELANCER_MAX_AGE_SECONDS;
      let rejectedOld = 0;
      let rejectedMissingDate = 0;
      let rejectedFutureDate = 0;
      const recent = [];

      for (const project of projects) {
        const id = Number(project.id);
        if (!Number.isSafeInteger(id) || id <= 0) continue;

        // Use original submission time only. Never use time_updated: an old
        // project can be updated while remaining open for years.
        const submittedAt = normalizeUnixSeconds(project.time_submitted)
          ?? normalizeUnixSeconds(project.submitdate);

        if (!submittedAt) {
          rejectedMissingDate++;
          continue;
        }
        if (submittedAt < cutoff) {
          rejectedOld++;
          continue;
        }
        if (submittedAt > checkedAt + FREELANCER_FUTURE_CLOCK_SKEW_SECONDS) {
          rejectedFutureDate++;
          continue;
        }

        const currency = project.currency || {};
        const budgetObject = project.budget || {};
        let budget = "";
        if (budgetObject.minimum != null || budgetObject.maximum != null) {
          const minimum = budgetObject.minimum ?? "?";
          const maximum = budgetObject.maximum ?? "?";
          budget = `${currency.sign || ""}${minimum} - ${currency.sign || ""}${maximum}${currency.code ? ` ${currency.code}` : ""}`.trim();
          if (project.type === "hourly") budget += " (بالساعة)";
        }

        const extra = [];
        if (project.bid_stats?.bid_count != null) extra.push(`عدد العروض: ${project.bid_stats.bid_count}`);

        recent.push({
          id,
          url: `https://www.freelancer.com/projects/${project.seo_url || id}`,
          title: cleanText(project.title || `مشروع جديد #${id}`),
          description: cleanText(project.description || project.preview_description || ""),
          budget,
          skills: (project.jobs || []).map((job) => cleanText(job.name || "")).filter(Boolean).slice(0, 8),
          extra,
          submittedAt,
        });
      }

      const topBySubmission = projects
        .map((project) => ({
          id: Number(project.id),
          submittedAt: normalizeUnixSeconds(project.time_submitted) ?? normalizeUnixSeconds(project.submitdate),
        }))
        .filter((project) => Number.isSafeInteger(project.id) && project.id > 0 && project.submittedAt)
        .sort((a, b) => b.submittedAt - a.submittedAt || b.id - a.id)
        .slice(0, 5)
        .map((project) => `${project.id}:${Math.max(0, Math.floor((checkedAt - project.submittedAt) / 60))}m`);

      console.log(
        `[freelancer] ${attemptLabel}: raw=${projects.length}; recent15m=${recent.length}; ` +
        `rejectedOld=${rejectedOld}; missingTimestamp=${rejectedMissingDate}; ` +
        `futureTimestamp=${rejectedFutureDate}; maxAgeSeconds=${FREELANCER_MAX_AGE_SECONDS}; ` +
        `newestBySubmission(id:age)=${topBySubmission.join(",") || "none"}`
      );
      return recent.sort((a, b) => (b.submittedAt - a.submittedAt) || (b.id - a.id));
    };

    // Try server-side filtering using two supported query variants. If the API
    // still returns old projects, the local timestamp filter drops them and we
    // try the alternate query before declaring that no recent projects exist.
    for (let attempt = 0; attempt < filteredUrls.length; attempt++) {
      try {
        const response = await fetch(filteredUrls[attempt], {
          headers: { ...HEADERS, Accept: "application/json" },
          redirect: "follow",
        });
        if (!response.ok) {
          lastError = `HTTP ${response.status}`;
          console.error(`[freelancer] filtered API attempt ${attempt + 1} failed: ${lastError}`);
          continue;
        }

        const data = await response.json();
        const projects = data?.result?.projects;
        if (!Array.isArray(projects)) {
          lastError = "API response did not contain result.projects";
          console.error(`[freelancer] filtered API attempt ${attempt + 1} failed: ${lastError}`);
          continue;
        }

        sawValidProjectArray = true;
        const recent = convertAndFilter(projects, `filtered API attempt ${attempt + 1}`);
        if (recent.length > 0) {
          console.log(`[freelancer] accepted ${recent.length} project(s) submitted within the last 15 minutes`);
          return recent;
        }
        if (projects.length === 0) {
          console.log(`[freelancer] attempt ${attempt + 1} returned an empty list; trying the next supported query variant`);
        }
      } catch (error) {
        lastError = String(error);
        console.error(`[freelancer] filtered API attempt ${attempt + 1} failed: ${lastError}`);
      }
    }

    // If valid API responses only contain old projects or records without timestamps,
    // return none; never fall back to announcing stale jobs. The plain query is used
    // only when the filtered API requests fail at HTTP/JSON level.
    if (sawValidProjectArray) {
      console.warn(`[freelancer] no verifiably recent projects; old/undated projects will not be sent`);
      return [];
    }

    // Compatibility fallback only when both filtered query variants failed at HTTP/JSON level.
    // The local 15-minute submission-time check is still mandatory.
    try {
      const fallbackUrl = `${base}?limit=50&full_description=true&job_details=true&sort_field=time_updated&reverse_sort=false`;
      const response = await fetch(fallbackUrl, {
        headers: { ...HEADERS, Accept: "application/json" },
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const projects = data?.result?.projects;
      if (!Array.isArray(projects)) throw new Error("API response did not contain result.projects");
      const recent = convertAndFilter(projects, "unfiltered fallback");
      console.log(`[freelancer] unfiltered fallback yielded ${recent.length} project(s) submitted within the last 15 minutes`);
      return recent;
    } catch (error) {
      lastError = String(error);
    }

    throw new Error(`Freelancer API failed: ${lastError}`);
  },
};

// Normalize Freelancer's Unix timestamps. The API normally returns seconds;
// accept milliseconds defensively in case the response format changes.
function normalizeUnixSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  let numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (numeric > 100000000000) numeric = numeric / 1000;
  numeric = Math.floor(numeric);
  return numeric > 0 ? numeric : null;
}

// Nafezly blocks requests from this Worker with HTTP 403.
// Its public Telegram channel publishes project title, description, budget, and project link,
// so use that public feed instead of repeatedly requesting the blocked listing page.
const nafezlyTelegram = {
  key: "nafezly",
  name: "نفذلي",
  async list() {
    const response = await fetch("https://t.me/s/nafezly", {
      headers: {
        ...HEADERS,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: "https://t.me/",
      },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`nafezly Telegram feed HTTP ${response.status}`);
    const html = await response.text();
    const items = parseNafezlyTelegramFeed(html);
    console.log(`[nafezly] source=public Telegram feed; found=${items.length}`);
    if (!items.length) throw new Error("Nafezly Telegram feed loaded but no project posts could be parsed");
    return items;
  },
  // The public channel post often contains only a shortened preview ending in "...".
  // When a fresh project is being processed, fetch its actual project page and prefer
  // the full description. If Nafezly blocks the detail request, safely fall back to the
  // channel excerpt and log the reason so it is visible in Cloudflare Observability.
  async detail(item) {
    const feedItem = { ...item };
    try {
      const response = await fetch(item.url, {
        headers: {
          ...HEADERS,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: "https://nafezly.com/projects",
        },
        redirect: "follow",
      });
      if (!response.ok) {
        console.warn(`[nafezly] project detail HTTP ${response.status} for #${item.id}; using Telegram excerpt (${(feedItem.description || "").length} chars)`);
        return feedItem;
      }

      const html = await response.text();
      if (looksLikeChallenge(html)) {
        console.warn(`[nafezly] project detail returned a challenge for #${item.id}; using Telegram excerpt`);
        return feedItem;
      }

      const pageItem = parseHtmlProject("nafezly", html, item);
      const feedDescription = cleanText(feedItem.description || "");
      const pageDescription = cleanText(pageItem.description || "");
      const usePageDescription = pageDescription.length > feedDescription.length;
      const result = {
        ...feedItem,
        ...pageItem,
        title: isUsefulDescription(pageItem.title || "", "") ? pageItem.title : feedItem.title,
        description: usePageDescription ? pageDescription : feedDescription,
        budget: pageItem.budget || feedItem.budget || "",
        skills: pageItem.skills?.length ? pageItem.skills : (feedItem.skills || []),
        extra: pageItem.extra?.length ? pageItem.extra : (feedItem.extra || []),
      };
      console.log(`[nafezly] detail source=${usePageDescription ? "project-page" : "telegram-feed"}; id=${item.id}; pageDescriptionChars=${pageDescription.length}; feedDescriptionChars=${feedDescription.length}; sentDescriptionChars=${result.description.length}`);
      return result;
    } catch (error) {
      console.warn(`[nafezly] project detail fetch failed for #${item.id}: ${String(error)}; using Telegram excerpt (${(feedItem.description || "").length} chars)`);
      return feedItem;
    }
  },
};

function parseNafezlyTelegramFeed(html) {
  const source = String(html);
  const wrapperRe = /<div\b[^>]*class=["'][^"']*\btgme_widget_message_wrap\b[^"']*["'][^>]*>/gi;
  const wrappers = [...source.matchAll(wrapperRe)];
  const projects = new Map();

  for (let index = 0; index < wrappers.length; index++) {
    const start = wrappers[index].index;
    const end = index + 1 < wrappers.length ? wrappers[index + 1].index : source.length;
    const block = source.slice(start, end);

    const urlMatch = block.match(/href=["'](https?:\/\/(?:www\.)?nafezly\.com\/project\/(\d+)(?:-[^"'?#\s<>]*)?(?:\?[^"']*)?)["']/i);
    if (!urlMatch) continue;

    const bodyMatch = block.match(/<div\b[^>]*class=["'][^"']*\btgme_widget_message_text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    if (!bodyMatch) continue;
    const text = htmlToText(bodyMatch[1]);
    if (!/تم\s+إضافة\s+مشروع\s+جديد/.test(text)) continue;

    const id = Number(urlMatch[2]);
    if (!Number.isSafeInteger(id) || id <= 0) continue;

    let title = textBetweenLabels(text, "عنوان المشروع", "تفاصيل المشروع|الميزانية|رابط المشروع");
    let description = textBetweenLabels(text, "تفاصيل المشروع", "الميزانية|رابط المشروع");
    let budget = textBetweenLabels(text, "الميزانية", "رابط المشروع");
    title = cleanText(title).replace(/^[:：-]\s*/, "");
    description = normalizeDescription(description, title);
    budget = cleanText(budget).replace(/^[:：-]\s*/, "");

    const url = new URL(urlMatch[1]).href;
    if (!title) title = titleFromUrl(url) || `مشروع جديد #${id}`;

    const item = {
      id,
      url,
      title,
      description,
      budget: /\d/.test(budget) ? budget.slice(0, 65) : "",
      skills: [],
      extra: [],
      source: "nafezly-telegram",
    };

    const existing = projects.get(id);
    if (!existing || item.description.length > existing.description.length) projects.set(id, item);
  }

  return [...projects.values()].sort((a, b) => a.id - b.id);
}

function textBetweenLabels(text, startLabel, endLabels) {
  const input = String(text || "");
  const startRe = new RegExp(`(?:^|\\n)\\s*${startLabel}\\s*[:：]\\s*`, "i");
  const startMatch = startRe.exec(input);
  if (!startMatch) return "";
  const start = startMatch.index + startMatch[0].length;
  const remainder = input.slice(start);
  const endRe = new RegExp(`\\n\\s*(?:${endLabels})\\s*[:：]`, "i");
  const endMatch = endRe.exec(remainder);
  return cleanText(endMatch ? remainder.slice(0, endMatch.index) : remainder);
}

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
  nafezlyTelegram,
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
  // Some sites (notably Khamsat) return a JS-disabled/anti-bot placeholder
  // with HTTP 200. Never parse that placeholder as if it were a real project.
  const source = String(html).slice(0, 50000);
  return /cf-chl-|challenge-platform|verify you are human|checking your browser|just a moment\.\.\.|javascript\s+is\s+disabled|enable\s+javascript|javascript\s+must\s+be\s+enabled|please\s+enable\s+javascript|access denied/i.test(source);
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
    // Stop at the skills/action area so it does not accidentally absorb the bid list or footer.
    description = textAfterAnyLabel(
      plain,
      ["تفاصيل المشروع", "وصف المشروع", "قم بوصف المشروع"],
      ["مهارات مطلوبة", "المهارات المطلوبة", "الميزانية", "المدة المتوقعة", "عدد العروض", "حالة المشروع", "أضف عرضك الآن"]
    );
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
      console.warn(`[${site.key}] no eligible projects returned; state was not changed`);
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
      const recipients = [];
      for (const user of audience) {
        const matchedTerms = matchingKeywordTerms(user.keywords, haystack);
        if (!String(user.keywords || "").trim() || matchedTerms.length > 0) {
          recipients.push(Number(user.chat_id));
          console.log(`[filter] site=${site.key} project=${item.id} chat=${user.chat_id} terms=${String(user.keywords || "<none>")} matched=${matchedTerms.join("|") || "<no filter>"}`);
        } else {
          console.log(`[filter] site=${site.key} project=${item.id} chat=${user.chat_id} terms=${String(user.keywords || "")} matched=<none>; skipped`);
        }
      }

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

  // Re-check each queued notification against the user's CURRENT settings.
  // This prevents old outbox rows (queued before a keyword change) from bypassing
  // the newly saved keyword filter or sending from a site the user has disabled.
  const chatIds = [...new Set(results.map((row) => Number(row.chat_id)).filter(Number.isSafeInteger))];
  const currentUsersResult = chatIds.length
    ? await env.DB.prepare(
        "SELECT chat_id, active, sites, keywords FROM users " +
        "WHERE chat_id IN (SELECT value FROM json_each(?1))"
      ).bind(JSON.stringify(chatIds)).all()
    : { results: [] };
  const currentUsers = new Map((currentUsersResult.results || []).map((user) => [Number(user.chat_id), user]));

  for (const row of results) {
    const currentUser = currentUsers.get(Number(row.chat_id));
    const siteKey = String(row.msg_key || "").split(":", 1)[0];
    const messageSearchText = searchableMessageText(row.text);
    const matchedTerms = currentUser ? matchingKeywordTerms(currentUser.keywords, messageSearchText) : [];
    let skipReason = "";

    if (!currentUser) skipReason = "user_not_found";
    else if (Number(currentUser.active) !== 1) skipReason = "notifications_paused";
    else if (!parseSites(currentUser.sites).includes(siteKey)) skipReason = "site_disabled";
    else if (String(currentUser.keywords || "").trim() && matchedTerms.length === 0) skipReason = "current_keywords_not_matched";

    if (skipReason) {
      // Drop stale queued notices instead of sending them under obsolete settings.
      doneIds.push(row.id);
      console.log(`[outbox] skipped id=${row.id} chat=${row.chat_id} key=${row.msg_key} reason=${skipReason}`);
      continue;
    }

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
  "الأوامر المتاحة في Freelance Bot:",
  "",
  "/settings - إدارة المنصات والكلمات المفتاحية والإشعارات",
  "/welcome - لوحة تحرير وترتيب رسالة الترحيب (للأدمن)",
  "/sites - اختيار المنصات",
  "/sites all - تفعيل كل المنصات",
  "/keywords python, Excel - تحديد الكلمات المفتاحية",
  "/keywords clear - مسح فلتر الكلمات",
  "/status - عرض إعداداتك الحالية",
  "/stop - إيقاف الإشعارات",
  "/start - تشغيل الإشعارات وعرض رسالة الترحيب",
].join("\n");

function defaultWelcomeTemplate() {
  const text = [
    "أهلاً فيك #name_link في Freelance Bot",
    "تابع مشاريع العمل الحر من مكان واحد، واستقبل إشعارات بالمشاريع الجديدة من المنصات اللي تختارها.",
    "",
    "المنصات المتاحة:",
    "Kafiil | Mostaql | Nafezly | Khamsat | Freelancer",
    "",
    "تم تفعيل الإشعارات. تقدر تخصص إعداداتك من خلال /settings.",
  ].join("\n");
  const heading = "المنصات المتاحة:";
  return {
    text,
    entities: [{ type: "bold", offset: text.indexOf(heading), length: heading.length }],
  };
}

function welcomePanelKeyboard(blocks) {
  const count = Array.isArray(blocks) ? blocks.length : 0;
  return {
    inline_keyboard: [
      [{ text: "Manage content order", callback_data: "welcome:order" }],
      [
        { text: "Add text block", callback_data: "welcome:add-text" },
        { text: "Add media block", callback_data: "welcome:add-media" },
      ],
      [{ text: "Preview welcome", callback_data: "welcome:preview" }],
      [{ text: "Reset to default", callback_data: "welcome:reset" }],
    ],
  };
}

function welcomePanelText(blocks) {
  const items = Array.isArray(blocks) ? blocks : [];
  const brief = items.slice(0, 10).map((block, index) => {
    if (block.kind === "media") return `${index + 1}. Media (${block.media_type || "file"})`;
    const text = String(block.text || "").replace(/\s+/g, " ").trim();
    return `${index + 1}. Text: ${esc(text.slice(0, 44))}${text.length > 44 ? "…" : ""}`;
  });
  return [
    "<b>Welcome message control panel</b>",
    "",
    "Build the welcome message from ordered text and media blocks. Move items up or down to control the exact order shown to users.",
    "",
    `<b>Content blocks:</b> ${items.length}`,
    ...(brief.length ? ["", ...brief] : []),
    "",
    "Use #name_link in any text block to insert the recipient's clickable Telegram profile name.",
  ].join("\n");
}

function welcomeOrderText(blocks) {
  const items = Array.isArray(blocks) ? blocks : [];
  if (!items.length) return "<b>Welcome content order</b>\n\nNo content blocks yet. Add a text or media block.";
  const lines = items.map((block, index) => {
    if (block.kind === "media") return `${index + 1}. <b>Media</b> — ${esc(block.media_type || "file")}${block.caption ? " (caption)" : ""}`;
    const compact = esc(String(block.text || "").replace(/\s+/g, " ").trim().slice(0, 70));
    return `${index + 1}. <b>Text</b> — ${compact || "(empty text)"}`;
  });
  return [
    "<b>Welcome content order</b>",
    "Move each block up or down. Edit or delete any block. This order is the order users receive it in.",
    "",
    ...lines,
  ].join("\n");
}

function welcomeOrderKeyboard(blocks) {
  const items = Array.isArray(blocks) ? blocks : [];
  const rows = [];
  items.forEach((block, index) => {
    const label = block.kind === "media" ? `Media ${index + 1}` : `Text ${index + 1}`;
    const row = [];
    if (index > 0) row.push({ text: `↑ ${index + 1}`, callback_data: `welcome:up:${index}` });
    if (index < items.length - 1) row.push({ text: `↓ ${index + 1}`, callback_data: `welcome:down:${index}` });
    if (block.kind === "text") row.push({ text: `Edit ${index + 1}`, callback_data: `welcome:edit-text:${index}` });
    else row.push({ text: `Replace ${index + 1}`, callback_data: `welcome:edit-media:${index}` });
    row.push({ text: `Delete ${index + 1}`, callback_data: `welcome:delete:${index}` });
    // Keep each row at Telegram's supported practical width.
    rows.push(row);
  });
  rows.push([
    { text: "Add text block", callback_data: "welcome:add-text" },
    { text: "Add media block", callback_data: "welcome:add-media" },
  ]);
  rows.push([{ text: "Back to welcome panel", callback_data: "welcome:panel" }]);
  return { inline_keyboard: rows };
}

function isAdmin(env, chatId) {
  return Boolean(env.ADMIN_ID) && String(chatId) === String(env.ADMIN_ID);
}

async function getBotSetting(env, key) {
  return withSchema(env, async () => {
    const row = await env.DB.prepare("SELECT value FROM bot_settings WHERE key = ?1").bind(key).first();
    return row?.value ?? null;
  });
}

async function setBotSetting(env, key, value) {
  return withSchema(env, () => env.DB.prepare(
    "INSERT INTO bot_settings (key, value, updated_at) VALUES (?1, ?2, ?3) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(key, value, Math.floor(Date.now() / 1000)).run());
}

async function deleteBotSetting(env, key) {
  return withSchema(env, () => env.DB.prepare("DELETE FROM bot_settings WHERE key = ?1").bind(key).run());
}

async function getWelcomeTemplate(env) {
  const raw = await getBotSetting(env, "welcome_text");
  if (!raw) return defaultWelcomeTemplate();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.text === "string") {
      return { text: parsed.text, entities: Array.isArray(parsed.entities) ? parsed.entities : [] };
    }
  } catch (error) {
    console.error(`[welcome] invalid stored text template: ${String(error)}`);
  }
  return defaultWelcomeTemplate();
}

async function getWelcomeMedia(env) {
  const raw = await getBotSetting(env, "welcome_media");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.type === "string" && typeof parsed.file_id === "string") return parsed;
  } catch (error) {
    console.error(`[welcome] invalid stored media template: ${String(error)}`);
  }
  return null;
}

function normalizeWelcomeContent(value) {
  if (!Array.isArray(value)) return null;
  const blocks = [];
  for (const block of value) {
    if (!block || typeof block !== "object") continue;
    if (block.kind === "text" && typeof block.text === "string") {
      blocks.push({
        kind: "text",
        text: block.text.slice(0, 4000),
        entities: Array.isArray(block.entities) ? block.entities : [],
      });
    } else if (block.kind === "media" && typeof block.file_id === "string" && typeof block.media_type === "string") {
      blocks.push({
        kind: "media",
        media_type: block.media_type,
        file_id: block.file_id,
        caption: typeof block.caption === "string" ? block.caption.slice(0, 1024) : "",
        caption_entities: Array.isArray(block.caption_entities) ? block.caption_entities : [],
      });
    }
  }
  return blocks.slice(0, 20);
}

async function getWelcomeContent(env) {
  const raw = await getBotSetting(env, "welcome_content");
  if (raw) {
    try {
      const content = normalizeWelcomeContent(JSON.parse(raw));
      if (content) return content;
    } catch (error) {
      console.error(`[welcome] invalid content order: ${String(error)}`);
    }
  }

  // Migrate older installations with the previous single-text/single-media settings.
  // The previous sender displayed media before the text, so retain that order.
  const content = [];
  const legacyMedia = await getWelcomeMedia(env);
  const rawText = await getBotSetting(env, "welcome_text");
  if (legacyMedia) {
    content.push({
      kind: "media",
      media_type: legacyMedia.type,
      file_id: legacyMedia.file_id,
      caption: "",
      caption_entities: [],
    });
  }
  let template = defaultWelcomeTemplate();
  if (rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed.text === "string") {
        template = { text: parsed.text, entities: Array.isArray(parsed.entities) ? parsed.entities : [] };
      }
    } catch (_) {}
  }
  content.push({ kind: "text", text: template.text, entities: template.entities || [] });
  return content;
}

async function saveWelcomeContent(env, blocks) {
  const safe = normalizeWelcomeContent(blocks) || [];
  await setBotSetting(env, "welcome_content", JSON.stringify(safe));
  return safe;
}

function welcomeTextBlock(text, entities) {
  return { kind: "text", text: String(text || "").slice(0, 4000), entities: Array.isArray(entities) ? entities : [] };
}

function welcomeMediaBlock(media, caption = "", captionEntities = []) {
  return {
    kind: "media",
    media_type: media.type,
    file_id: media.file_id,
    caption: String(caption || "").slice(0, 1024),
    caption_entities: Array.isArray(captionEntities) ? captionEntities : [],
  };
}

function renderWelcomeTemplate(template, from) {
  const userId = Number(from?.id);
  const first = String(from?.first_name || "").trim();
  const last = String(from?.last_name || "").trim();
  const username = String(from?.username || "").trim();
  const displayName = [first, last].filter(Boolean).join(" ") || (username ? `@${username}` : "مستخدم تيليجرام");
  const marker = "#name_link";
  const sourceText = String(template?.text ?? defaultWelcomeTemplate().text);
  const sourceEntities = Array.isArray(template?.entities) ? template.entities : [];
  const occurrences = [];
  let cursor = 0;
  while ((cursor = sourceText.indexOf(marker, cursor)) !== -1) {
    occurrences.push(cursor);
    cursor += marker.length;
  }

  let text = sourceText;
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const at = occurrences[i];
    text = text.slice(0, at) + displayName + text.slice(at + marker.length);
  }

  const delta = displayName.length - marker.length;
  const mapPosition = (position, isEnd = false) => {
    const original = Number(position) || 0;
    let adjustment = 0;
    for (const at of occurrences) {
      if (original >= at + marker.length) {
        adjustment += delta;
      } else if (original > at || (isEnd && original === at)) {
        return at + adjustment + (isEnd ? displayName.length : 0);
      }
    }
    return original + adjustment;
  };
  const entities = sourceEntities.map((entity) => {
    const oldOffset = Number(entity.offset) || 0;
    const oldEnd = oldOffset + (Number(entity.length) || 0);
    const newOffset = mapPosition(oldOffset, false);
    const newEnd = mapPosition(oldEnd, true);
    return { ...entity, offset: newOffset, length: Math.max(0, newEnd - newOffset) };
  }).filter((entity) => entity.length > 0);

  if (Number.isSafeInteger(userId) && userId > 0) {
    for (const at of occurrences) {
      entities.push({
        type: "text_link",
        offset: mapPosition(at, false),
        length: displayName.length,
        url: `tg://user?id=${userId}`,
      });
    }
  }
  return { text, entities };
}

function getWelcomeMediaInfo(message) {
  if (Array.isArray(message.photo) && message.photo.length) return { type: "photo", file_id: message.photo[message.photo.length - 1].file_id };
  for (const type of ["animation", "video", "document", "audio", "voice", "video_note", "sticker"]) {
    if (message[type]?.file_id) return { type, file_id: message[type].file_id };
  }
  return null;
}

async function sendWelcomeMediaBlock(env, chatId, block, from) {
  const type = block.media_type;
  const methodByType = {
    photo: "sendPhoto", animation: "sendAnimation", video: "sendVideo", document: "sendDocument",
    audio: "sendAudio", voice: "sendVoice", video_note: "sendVideoNote", sticker: "sendSticker",
  };
  const method = methodByType[type];
  if (!method) throw new Error(`Unsupported welcome media type: ${type}`);
  const payload = { chat_id: chatId, [type]: block.file_id };
  const captionTypes = new Set(["photo", "animation", "video", "document", "audio", "voice"]);
  let captionRendered = null;
  if (block.caption && captionTypes.has(type)) {
    captionRendered = renderWelcomeTemplate({ text: block.caption, entities: block.caption_entities || [] }, from);
    if (captionRendered.text.length <= 1024) {
      payload.caption = captionRendered.text;
      payload.caption_entities = captionRendered.entities;
    }
  }
  await tg(env, method, payload);
  // A media caption is limited by Telegram; if it ever cannot be attached, preserve it as a text block after media.
  if (block.caption && captionTypes.has(type) && !payload.caption) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: captionRendered.text,
      entities: captionRendered.entities,
      disable_web_page_preview: true,
    });
  }
}

async function sendWelcome(env, chatId, from) {
  const blocks = await getWelcomeContent(env);
  for (const block of blocks) {
    try {
      if (block.kind === "media") {
        await sendWelcomeMediaBlock(env, chatId, block, from);
      } else if (block.kind === "text") {
        const rendered = renderWelcomeTemplate(block, from);
        if (!rendered.text) continue;
        await tg(env, "sendMessage", {
          chat_id: chatId,
          text: rendered.text,
          entities: rendered.entities,
          disable_web_page_preview: true,
        });
      }
    } catch (error) {
      console.error(`[welcome] failed to send ${block.kind} block: ${String(error)}`);
    }
  }
}

function settingsKeyboard(user) {
  return {
    inline_keyboard: [
      [
        { text: "Platforms", callback_data: "settings:sites" },
        { text: "Keywords", callback_data: "settings:keywords" },
      ],
      [{ text: user.active ? "Pause notifications" : "Resume notifications", callback_data: "settings:toggle" }],
      [{ text: "My current settings", callback_data: "settings:status" }],
    ],
  };
}

function settingsText(user) {
  const selected = parseSites(user.sites);
  const names = selected.map((key) => SITES.find((site) => site.key === key)?.name).filter(Boolean);
  const keywordText = user.keywords
    ? esc(user.keywords.split(",").join("، "))
    : "غير محددة (استقبال كل المشاريع)";
  return [
    "<b>إعدادات Freelance Bot</b>",
    "",
    `حالة الإشعارات: <b>${user.active ? "مفعّلة" : "متوقفة"}</b>`,
    `المنصات المفعّلة: ${names.length ? esc(names.join("، ")) : "لا توجد منصات مفعّلة"}`,
    `الكلمات المفتاحية: ${keywordText}`,
    "",
    "اختار الإعداد اللي عايز تغيّره.",
  ].join("\n");
}

function sitesSettingsText(_user) {
  return [
    "<b>اختيار المنصات</b>",
    "اضغط على اسم المنصة لتفعيلها أو إيقافها. علامة الصح تعني أن المنصة مفعّلة.",
  ].join("\n");
}

async function handleUpdate(env, update) {
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg || msg.chat?.type !== "private") return;

  const chatId = msg.chat.id;
  const from = msg.from || {};
  const rawText = typeof msg.text === "string" ? msg.text : "";
  const text = rawText.trim();
  const first = text.split(/\s+/)[0] || "";
  const command = first.toLowerCase().replace(/@.*$/, "");
  const args = text.slice(first.length).trim();
  const pending = await getPendingInput(env, chatId);

  if (command === "/cancel") {
    await clearPendingInput(env, chatId);
    await deleteBotSetting(env, `keyword_draft:${chatId}`);
    if (pending?.action?.startsWith("welcome_")) {
      const blocks = await getWelcomeContent(env);
      return sendMessage(env, chatId, "Cancelled. No pending welcome-content changes were saved.", {
        reply_markup: welcomePanelKeyboard(blocks),
      });
    }
    const user = await getOrCreateUser(env, chatId);
    return sendMessage(env, chatId, "Cancelled. Your existing keyword settings were not changed.", {
      reply_markup: settingsKeyboard(user),
    });
  }

  // Admin is building the ordered welcome content. Supported pending actions:
  // welcome_text_add, welcome_text_edit:N, welcome_media_add, welcome_media_edit:N.
  if (isAdmin(env, chatId) && (pending?.action === "welcome_text" || pending?.action?.startsWith("welcome_text_"))) {
    if (!rawText) return sendMessage(env, chatId, "Please send a text message, or /cancel to leave without changes.");
    if (rawText.length > 4000) return sendMessage(env, chatId, "Text is longer than Telegram's limit. Send a shorter text or /cancel.");
    const blocks = await getWelcomeContent(env);
    const block = welcomeTextBlock(rawText, Array.isArray(msg.entities) ? msg.entities : []);
    const editMatch = pending.action.match(/^welcome_text_edit:(\d+)$/);
    if (editMatch) {
      const index = Number(editMatch[1]);
      if (index >= 0 && index < blocks.length && blocks[index]?.kind === "text") blocks[index] = block;
      else blocks.push(block);
    } else {
      blocks.push(block);
    }
    if (blocks.length > 20) return sendMessage(env, chatId, "The welcome message can contain up to 20 content blocks. Delete a block first or send /cancel.");
    await saveWelcomeContent(env, blocks);
    await clearPendingInput(env, chatId);
    return sendMessage(env, chatId, "Text block saved. Use Manage content order to move it, edit it, or delete it.", {
      reply_markup: welcomePanelKeyboard(blocks),
    });
  }

  if (isAdmin(env, chatId) && (pending?.action === "welcome_media" || pending?.action?.startsWith("welcome_media_"))) {
    const media = getWelcomeMediaInfo(msg);
    if (!media) return sendMessage(env, chatId, "Send a photo, sticker, video, GIF/animation, document, audio, voice message, or video note. Send /cancel to leave without changes.");
    if (typeof msg.caption === "string" && msg.caption.length > 1024) {
      return sendMessage(env, chatId, "Telegram media captions can be at most 1024 characters. Send the media with a shorter caption, or /cancel.");
    }
    const blocks = await getWelcomeContent(env);
    const block = welcomeMediaBlock(media, msg.caption || "", Array.isArray(msg.caption_entities) ? msg.caption_entities : []);
    const editMatch = pending.action.match(/^welcome_media_edit:(\d+)$/);
    if (editMatch) {
      const index = Number(editMatch[1]);
      if (index >= 0 && index < blocks.length && blocks[index]?.kind === "media") blocks[index] = block;
      else blocks.push(block);
    } else {
      blocks.push(block);
    }
    if (blocks.length > 20) return sendMessage(env, chatId, "The welcome message can contain up to 20 content blocks. Delete a block first or send /cancel.");
    await saveWelcomeContent(env, blocks);
    await clearPendingInput(env, chatId);
    return sendMessage(env, chatId, "Media block saved in the current content order. Use Manage content order to move it.", {
      reply_markup: welcomePanelKeyboard(blocks),
    });
  }

  if (!text) return;

  // Keyword edits are staged first. The Cancel button is shown only after the
  // user has submitted a draft; existing settings remain unchanged until Save.
  if (!text.startsWith("/") && pending?.action === "keywords") {
    const list = [...new Set(
      text.split(/[,،\n]/).map((value) => value.trim().toLocaleLowerCase().slice(0, 30)).filter(Boolean)
    )].slice(0, MAX_KEYWORDS);
    if (!list.length) {
      return sendMessage(env, chatId, "ابعت كلمة واحدة على الأقل مفصولة بفواصل، مثال: Python, Excel, تصميم. لإلغاء العملية استخدم /cancel.");
    }
    await setBotSetting(env, `keyword_draft:${chatId}`, JSON.stringify(list));
    await setPendingInput(env, chatId, "keywords_confirm");
    return sendMessage(
      env,
      chatId,
      `<b>مراجعة الكلمات المفتاحية</b>\n\n${esc(list.join("، "))}\n\nاحفظ الكلمات الجديدة أم عدّلها؟`,
      { reply_markup: keywordDraftKeyboard() }
    );
  }

  // Ignore additional free text while a draft is waiting for Save/Cancel.
  if (!text.startsWith("/") && pending?.action === "keywords_confirm") {
    let draft = [];
    try {
      draft = JSON.parse((await getBotSetting(env, `keyword_draft:${chatId}`)) || "[]");
    } catch { draft = []; }
    return sendMessage(
      env,
      chatId,
      `<b>لديك كلمات بانتظار التأكيد:</b>\n${esc(Array.isArray(draft) ? draft.join("، ") : "")}\nاستخدم الأزرار لحفظها أو إلغائها.`,
      { reply_markup: keywordDraftKeyboard() }
    );
  }

  // If a user issues another slash-command while in the keyword editor,
  // leave that input flow so the next ordinary text is not misread as keywords.
  if (text.startsWith("/") && (pending?.action === "keywords" || pending?.action === "keywords_confirm")) {
    await clearPendingInput(env, chatId);
    await deleteBotSetting(env, `keyword_draft:${chatId}`);
  }

  switch (command) {
    case "/start": {
      await withSchema(env, () => env.DB.prepare(
        "INSERT INTO users (chat_id, active, sites, keywords, created_at) VALUES (?1, 1, ?2, '', ?3) " +
        "ON CONFLICT(chat_id) DO UPDATE SET active = 1"
      ).bind(chatId, DEFAULT_SITES, Math.floor(Date.now() / 1000)).run());
      await getOrCreateUser(env, chatId);
      return sendWelcome(env, chatId, from);
    }
    case "/stop": {
      await withSchema(env, () => env.DB.prepare("UPDATE users SET active = 0 WHERE chat_id = ?1").bind(chatId).run());
      const user = await getOrCreateUser(env, chatId);
      return sendMessage(env, chatId, "تم إيقاف الإشعارات. تقدر تشغيلها مرة تانية من /settings أو /start.", { reply_markup: settingsKeyboard(user) });
    }
    case "/settings": {
      const user = await getOrCreateUser(env, chatId);
      return sendMessage(env, chatId, settingsText(user), { reply_markup: settingsKeyboard(user) });
    }
    case "/sites": {
      const user = await getOrCreateUser(env, chatId);
      if (/^(all|كلها|الكل)$/i.test(args)) {
        await env.DB.prepare("UPDATE users SET sites = ?1 WHERE chat_id = ?2").bind(DEFAULT_SITES, chatId).run();
        const refreshed = await getOrCreateUser(env, chatId);
        return sendMessage(env, chatId, "تم تفعيل كل المنصات الخمسة.", { reply_markup: sitesKeyboard(parseSites(refreshed.sites)) });
      }
      return sendMessage(env, chatId, sitesSettingsText(user), { reply_markup: sitesKeyboard(parseSites(user.sites)) });
    }
    case "/keywords": {
      const user = await getOrCreateUser(env, chatId);
      if (!args) {
        const current = user.keywords ? esc(user.keywords.split(",").join("، ")) : "غير محددة (استقبال كل المشاريع)";
        return sendMessage(env, chatId, `الكلمات المفتاحية الحالية: ${current}\n\nاستخدم /keywords python, بوت, تصميم لتغييرها مباشرة.\nاستخدم /keywords clear لمسح الفلتر.\nأو افتح /settings لإدارتها من الأزرار.`, { reply_markup: settingsKeyboard(user) });
      }
      if (/^(clear|مسح)$/i.test(args)) {
        await env.DB.prepare("UPDATE users SET keywords = '' WHERE chat_id = ?1").bind(chatId).run();
        const refreshed = await getOrCreateUser(env, chatId);
        return sendMessage(env, chatId, "تم مسح فلتر الكلمات. هتوصلك كل المشاريع.", { reply_markup: settingsKeyboard(refreshed) });
      }
      const list = [...new Set(args.split(/[,،\n]/).map((value) => value.trim().toLocaleLowerCase().slice(0, 30)).filter(Boolean))].slice(0, MAX_KEYWORDS);
      await env.DB.prepare("UPDATE users SET keywords = ?1 WHERE chat_id = ?2").bind(list.join(","), chatId).run();
      const refreshed = await getOrCreateUser(env, chatId);
      return sendMessage(env, chatId, `تم تحديث الكلمات المفتاحية: ${esc(list.join("، "))}`, { reply_markup: settingsKeyboard(refreshed) });
    }
    case "/status": {
      const user = await getOrCreateUser(env, chatId);
      return sendMessage(env, chatId, settingsText(user), { reply_markup: settingsKeyboard(user) });
    }
    case "/welcome": {
      if (!isAdmin(env, chatId)) return sendMessage(env, chatId, "Welcome control panel is available to the admin only. Set ADMIN_ID to your Telegram user ID in Worker settings.");
      const blocks = await getWelcomeContent(env);
      return sendMessage(env, chatId, welcomePanelText(blocks), { reply_markup: welcomePanelKeyboard(blocks) });
    }
    case "/stats": {
      if (!env.ADMIN_ID || String(chatId) !== String(env.ADMIN_ID)) return;
      const row = await env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(active), 0) AS active FROM users").first();
      return sendMessage(env, chatId, `المستخدمون: ${row.total} (النشطون: ${row.active})`);
    }
    case "/help": return sendMessage(env, chatId, HELP);
    default: return;
  }
}

async function handleCallback(env, callback) {
  const chatId = callback.message?.chat?.id;
  try {
    const data = String(callback.data || "");
    if (!chatId) return;

    if (data.startsWith("welcome:")) {
      if (!isAdmin(env, chatId)) {
        await tg(env, "answerCallbackQuery", { callback_query_id: callback.id, text: "Admin only", show_alert: true }).catch(() => {});
        return;
      }
      const action = data.slice("welcome:".length);
      const getContent = () => getWelcomeContent(env);
      const editMessage = async (text, replyMarkup) => tg(env, "editMessageText", {
        chat_id: chatId,
        message_id: callback.message.message_id,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      });
      const showPanel = async () => {
        const blocks = await getContent();
        await editMessage(welcomePanelText(blocks), welcomePanelKeyboard(blocks));
      };
      const showOrder = async () => {
        const blocks = await getContent();
        await editMessage(welcomeOrderText(blocks), welcomeOrderKeyboard(blocks));
      };

      if (action === "panel") {
        await clearPendingInput(env, chatId);
        await showPanel();
      } else if (action === "order") {
        await clearPendingInput(env, chatId);
        await showOrder();
      } else if (action === "add-text") {
        await setPendingInput(env, chatId, "welcome_text_add");
        await editMessage(
          "Send the text block you want to add. Preserve your line breaks and use Telegram's formatting tools (bold, italic, links, etc.) before sending. Use #name_link for the clickable profile name. Use /cancel to leave without saving.",
          { inline_keyboard: [[{ text: "Cancel", callback_data: "welcome:panel" }]] }
        );
      } else if (action === "add-media") {
        await setPendingInput(env, chatId, "welcome_media_add");
        await editMessage(
          "Send one photo, sticker, video, GIF/animation, document, audio, voice message, or video note. You may include a caption when Telegram supports it. The block will be appended; you can reorder it afterwards. Use /cancel to leave without saving.",
          { inline_keyboard: [[{ text: "Cancel", callback_data: "welcome:panel" }]] }
        );
      } else if (action.startsWith("edit-text:")) {
        const index = Number(action.split(":")[1]);
        const blocks = await getContent();
        if (!Number.isInteger(index) || !blocks[index] || blocks[index].kind !== "text") {
          await showOrder();
        } else {
          await setPendingInput(env, chatId, `welcome_text_edit:${index}`);
          await editMessage(
            `Send the replacement text for block ${index + 1}. Use #name_link for the clickable profile name. Text formatting/entities are preserved. Use /cancel to leave without saving.`,
            { inline_keyboard: [[{ text: "Cancel", callback_data: "welcome:order" }]] }
          );
        }
      } else if (action.startsWith("edit-media:")) {
        const index = Number(action.split(":")[1]);
        const blocks = await getContent();
        if (!Number.isInteger(index) || !blocks[index] || blocks[index].kind !== "media") {
          await showOrder();
        } else {
          await setPendingInput(env, chatId, `welcome_media_edit:${index}`);
          await editMessage(
            `Send replacement media for block ${index + 1}. Send /cancel to leave without saving.`,
            { inline_keyboard: [[{ text: "Cancel", callback_data: "welcome:order" }]] }
          );
        }
      } else if (/^(up|down):\d+$/.test(action)) {
        const [direction, indexText] = action.split(":");
        const index = Number(indexText);
        const blocks = await getContent();
        const destination = direction === "up" ? index - 1 : index + 1;
        if (index >= 0 && index < blocks.length && destination >= 0 && destination < blocks.length) {
          [blocks[index], blocks[destination]] = [blocks[destination], blocks[index]];
          await saveWelcomeContent(env, blocks);
        }
        await showOrder();
      } else if (action.startsWith("delete:")) {
        const index = Number(action.split(":")[1]);
        const blocks = await getContent();
        if (Number.isInteger(index) && index >= 0 && index < blocks.length) {
          blocks.splice(index, 1);
          await saveWelcomeContent(env, blocks);
        }
        await showOrder();
      } else if (action === "reset") {
        await clearPendingInput(env, chatId);
        await deleteBotSetting(env, "welcome_content");
        await deleteBotSetting(env, "welcome_text");
        await deleteBotSetting(env, "welcome_media");
        await showPanel();
      } else if (action === "preview") {
        await sendWelcome(env, chatId, callback.from || callback.message?.from || {});
        await showPanel();
      }
      return;
    }

    // Backward-compatible site toggles from the older /sites keyboard.
    if (data.startsWith("t:")) {
      const key = data.slice(2);
      if (SITE_KEYS.includes(key)) {
        const user = await getOrCreateUser(env, chatId);
        const selected = new Set(parseSites(user.sites));
        if (selected.has(key)) selected.delete(key); else selected.add(key);
        const nextSites = SITE_KEYS.filter((siteKey) => selected.has(siteKey));
        await env.DB.prepare("UPDATE users SET sites = ?1 WHERE chat_id = ?2").bind(nextSites.join(","), chatId).run();
        const refreshed = await getOrCreateUser(env, chatId);
        await tg(env, "editMessageText", {
          chat_id: chatId,
          message_id: callback.message.message_id,
          text: sitesSettingsText(refreshed),
          parse_mode: "HTML",
          reply_markup: sitesKeyboard(parseSites(refreshed.sites)),
        });
      }
      return;
    }

    if (!data.startsWith("settings:")) return;
    const action = data.slice("settings:".length);
    // Keep the pending keyword state only while the user is on its input prompt.
    if (action !== "keywords") await clearPendingInput(env, chatId);
    let user = await getOrCreateUser(env, chatId);
    const edit = async (text, replyMarkup) => tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: callback.message.message_id,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });

    if (action === "home") {
      await edit(settingsText(user), settingsKeyboard(user));
    } else if (action === "sites") {
      await edit(sitesSettingsText(user), sitesKeyboard(parseSites(user.sites)));
    } else if (action.startsWith("site:")) {
      const key = action.slice("site:".length);
      if (SITE_KEYS.includes(key)) {
        const selected = new Set(parseSites(user.sites));
        if (selected.has(key)) selected.delete(key); else selected.add(key);
        const nextSites = SITE_KEYS.filter((siteKey) => selected.has(siteKey));
        await env.DB.prepare("UPDATE users SET sites = ?1 WHERE chat_id = ?2").bind(nextSites.join(","), chatId).run();
        user = await getOrCreateUser(env, chatId);
      }
      await edit(sitesSettingsText(user), sitesKeyboard(parseSites(user.sites)));
    } else if (action === "sites:all") {
      await env.DB.prepare("UPDATE users SET sites = ?1 WHERE chat_id = ?2").bind(DEFAULT_SITES, chatId).run();
      user = await getOrCreateUser(env, chatId);
      await edit(sitesSettingsText(user), sitesKeyboard(parseSites(user.sites)));
    } else if (action === "sites:none") {
      await env.DB.prepare("UPDATE users SET sites = '' WHERE chat_id = ?1").bind(chatId).run();
      user = await getOrCreateUser(env, chatId);
      await edit(sitesSettingsText(user), sitesKeyboard(parseSites(user.sites)));
    } else if (action === "keywords") {
      await deleteBotSetting(env, `keyword_draft:${chatId}`);
      await setPendingInput(env, chatId, "keywords");
      await edit(
        "<b>تعديل الكلمات المفتاحية</b>\n\nابعت الكلمات اللي عايز تتابعها، وافصل بينها بفاصلة.\nمثال: Python, Excel, تصميم.",
        { inline_keyboard: [
          [{ text: "Clear filter", callback_data: "settings:keywords:clear" }],
          [{ text: "Back to settings", callback_data: "settings:home" }],
        ] }
      );
    } else if (action === "keywords:clear") {
      await env.DB.prepare("UPDATE users SET keywords = '' WHERE chat_id = ?1").bind(chatId).run();
      console.log(`[keywords] cleared chat=${chatId}; future queued messages are evaluated with no filter`);
      await clearPendingInput(env, chatId);
      await deleteBotSetting(env, `keyword_draft:${chatId}`);
      user = await getOrCreateUser(env, chatId);
      await edit("تم مسح فلتر الكلمات. هتوصلك كل المشاريع من المنصات المفعّلة.", settingsKeyboard(user));
    } else if (action === "keywords:save") {
      const rawDraft = await getBotSetting(env, `keyword_draft:${chatId}`);
      let draft = [];
      try { draft = JSON.parse(rawDraft || "[]"); } catch { draft = []; }
      if (!Array.isArray(draft) || !draft.length) {
        await clearPendingInput(env, chatId);
        await deleteBotSetting(env, `keyword_draft:${chatId}`);
        user = await getOrCreateUser(env, chatId);
        await edit("لا توجد كلمات معلّقة للحفظ. لم تتغير إعداداتك.", settingsKeyboard(user));
      } else {
        await env.DB.prepare("UPDATE users SET keywords = ?1 WHERE chat_id = ?2").bind(draft.join(","), chatId).run();
        console.log(`[keywords] saved chat=${chatId} terms=${draft.join("|")}; queued messages will be rechecked before send`);
        await clearPendingInput(env, chatId);
        await deleteBotSetting(env, `keyword_draft:${chatId}`);
        user = await getOrCreateUser(env, chatId);
        await edit(`تم حفظ الكلمات المفتاحية: ${esc(draft.join("، "))}`, settingsKeyboard(user));
      }
    } else if (action === "keywords:edit") {
      let draft = [];
      try { draft = JSON.parse((await getBotSetting(env, `keyword_draft:${chatId}`)) || "[]"); } catch { draft = []; }
      await deleteBotSetting(env, `keyword_draft:${chatId}`);
      await setPendingInput(env, chatId, "keywords");
      await edit(
        `<b>تعديل الكلمات المفتاحية</b>\n\nابعت القائمة الجديدة مفصولة بفواصل.\nالقائمة السابقة غير المحفوظة: ${esc(Array.isArray(draft) ? draft.join("، ") : "")}`,
        { inline_keyboard: [
          [{ text: "Clear filter", callback_data: "settings:keywords:clear" }],
          [{ text: "Back to settings", callback_data: "settings:home" }],
        ] }
      );
    } else if (action === "keywords:cancel") {
      await clearPendingInput(env, chatId);
      await deleteBotSetting(env, `keyword_draft:${chatId}`);
      user = await getOrCreateUser(env, chatId);
      await edit("تم إلغاء التعديل. لم تتغير الكلمات المفتاحية الحالية.", settingsKeyboard(user));
    } else if (action === "toggle") {
      await env.DB.prepare("UPDATE users SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE chat_id = ?1").bind(chatId).run();
      user = await getOrCreateUser(env, chatId);
      await edit(settingsText(user), settingsKeyboard(user));
    } else if (action === "status") {
      await edit(settingsText(user), { inline_keyboard: [[{ text: "Back to settings", callback_data: "settings:home" }]] });
    }
  } catch (error) {
    console.error(`[callback] failed: ${String(error)}`);
  } finally {
    await tg(env, "answerCallbackQuery", { callback_query_id: callback.id }).catch(() => {});
  }
}

function keywordDraftKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Save keywords", callback_data: "settings:keywords:save" }],
      [
        { text: "Edit keywords", callback_data: "settings:keywords:edit" },
        { text: "Cancel", callback_data: "settings:keywords:cancel" },
      ],
    ],
  };
}

function sitesKeyboard(selected) {
  const selectedSet = new Set(selected || []);
  const rows = [];
  for (let index = 0; index < SITES.length; index += 2) {
    rows.push(SITES.slice(index, index + 2).map((site) => ({
      // Mark selected sites with a check only; leave unselected sites plain.
      text: `${selectedSet.has(site.key) ? "✓ " : ""}${site.name}`,
      callback_data: `settings:site:${site.key}`,
    })));
  }
  rows.push([
    { text: "Enable all", callback_data: "settings:sites:all" },
    { text: "Disable all", callback_data: "settings:sites:none" },
  ]);
  rows.push([{ text: "Back to settings", callback_data: "settings:home" }]);
  return { inline_keyboard: rows };
}

async function setPendingInput(env, chatId, action) {
  return withSchema(env, () => env.DB.prepare(
    "INSERT INTO user_input_state (chat_id, action, updated_at) VALUES (?1, ?2, ?3) " +
    "ON CONFLICT(chat_id) DO UPDATE SET action = excluded.action, updated_at = excluded.updated_at"
  ).bind(chatId, action, Math.floor(Date.now() / 1000)).run());
}

async function getPendingInput(env, chatId) {
  return withSchema(env, async () => {
    const row = await env.DB.prepare("SELECT action, updated_at FROM user_input_state WHERE chat_id = ?1").bind(chatId).first();
    if (!row) return null;
    if (Math.floor(Date.now() / 1000) - Number(row.updated_at) > 15 * 60) {
      await env.DB.prepare("DELETE FROM user_input_state WHERE chat_id = ?1").bind(chatId).run();
      return null;
    }
    return row;
  });
}

async function clearPendingInput(env, chatId) {
  return withSchema(env, () => env.DB.prepare("DELETE FROM user_input_state WHERE chat_id = ?1").bind(chatId).run());
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
  if (project.description) {
    // Telegram sendMessage allows up to 4096 characters. Reserve room for the
    // final project link and markup, and use as much of the remaining space as possible.
    const framingLength = lines.join("\n").length + 100;
    const telegramSafeDescriptionLimit = Math.max(0, Math.min(MAX_DESCRIPTION, 3900 - framingLength));
    lines.push("", esc(truncate(project.description, telegramSafeDescriptionLimit)));
  }
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
      const sorted = items.slice().sort((a, b) => {
        if (site.key === "freelancer") {
          const aTime = normalizeUnixSeconds(a.submittedAt) ?? 0;
          const bTime = normalizeUnixSeconds(b.submittedAt) ?? 0;
          return bTime - aTime || Number(b.id) - Number(a.id);
        }
        return Number(b.id) - Number(a.id);
      });
      let sample = null;
      if (sorted[0]) {
        sample = site.detail ? await site.detail(sorted[0]) : sorted[0];
        sample = { ...sample, description: truncate(sample.description || "", 500) };
      }
      const result = { found: items.length, newestIds: sorted.slice(0, 5).map((item) => item.id), sample };
      if (site.key === "freelancer" && sorted[0]?.submittedAt) {
        const newestTimestamp = normalizeUnixSeconds(sorted[0].submittedAt);
        result.newestSubmittedAt = new Date(newestTimestamp * 1000).toISOString();
        result.newestAgeMinutes = Math.max(0, Math.floor((Date.now() / 1000 - newestTimestamp) / 60));
      }
      output[site.key] = result;
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

function matchingKeywordTerms(keywords, haystack) {
  const terms = String(keywords || "")
    .split(",")
    .map((term) => term.trim().toLocaleLowerCase())
    .filter(Boolean);
  const text = String(haystack || "").toLocaleLowerCase();

  return terms.filter((term) => {
    // For simple English/numeric keywords, use word boundaries so "bot" does not
    // match an unrelated word such as "robotics" or "bottom". Multi-word terms
    // and terms containing punctuation are still supported.
    if (/^[a-z0-9]+(?:\s+[a-z0-9]+)*$/i.test(term)) {
      const escaped = term.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
      const pattern = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i");
      return pattern.test(text);
    }
    return text.includes(term);
  });
}

function matchesKeywords(keywords, haystack) {
  return matchingKeywordTerms(keywords, haystack).length > 0;
}

function searchableMessageText(html) {
  // Exclude project URLs from keyword matching; URL slugs can contain accidental
  // matches that do not appear in the notification's actual title/description.
  const withoutLinks = String(html || "").replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, " ");
  return decode(withoutLinks.replace(/<[^>]+>/g, " "))
    .replace(/[\t\u00a0 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
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
  // Titles returned by anti-bot/JavaScript placeholders are not project titles.
  if (/^(?:javascript is disabled|enable javascript|please enable javascript|just a moment|access denied|checking your browser|verify you are human)$/i.test(String(title).trim())) return true;
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
            { command: "settings", description: "إعدادات البوت" },
            { command: "welcome", description: "تحرير وترتيب رسالة الترحيب (للأدمن)" },
            { command: "sites", description: "اختيار المنصات" },
            { command: "keywords", description: "تعديل الكلمات المفتاحية" },
            { command: "status", description: "عرض إعداداتك" },
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

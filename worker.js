// =====================================================================
// Freelance Jobs Bot — Cloudflare Workers + Cron + D1
// Sites: Kafiil, Mostaql, Nafezly (public Telegram feed), Khamsat, Freelancer
// Fix: keep official nafezly.com project links unchanged; never rewrite their host.
// Required bindings/secrets:
//   DB (D1), BOT_TOKEN, WEBHOOK_SECRET, ADMIN_KEY; ADMIN_ID optional
// Cron: * * * * *
// Telegram UI: clickable profile greeting only on /start; all inline buttons are English.
// v5: classify legitimate single LinkedIn profile/account setup as CV services; reject bulk account creation.
// v3: Khamsat requests are read from the public Telegram channel @KhamsatRequests.
// v2: precise anti-bot detection (normal pages are no longer discarded), line-based extraction of
//     Mostaql/Kafiil/Khamsat project details, Telegram 4096-char safety, /?probe=<url> diagnostics.
// Freelancer source: supported time_updated sort, newest-first, original submission age <= 15 minutes.
// =====================================================================

const MAX_NEW_PER_RUN = 10;
const MAX_FRESH_BURST = 15; // more new projects than this in one minute = anomaly (outage / id change)
const BURST_KEEP_NEWEST = 5; // in an anomaly, only the newest few are sent
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
  `CREATE TABLE IF NOT EXISTS channel_outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     channel_id TEXT NOT NULL,
     msg_key TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     UNIQUE(channel_id, msg_key)
   )`,
  "CREATE INDEX IF NOT EXISTS idx_channel_outbox_id ON channel_outbox(id)",
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
      if (looksLikeChallenge(html, res)) throw new Error(`${key} list returned an anti-bot/challenge page`);

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
      if (looksLikeChallenge(html, res)) throw new Error(`${key} detail returned an anti-bot/challenge page`);
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

// Preserve the exact project URL published by Nafezly's official Telegram feed.
// Do not rewrite nafezly.com to another hostname: the rewritten links can fail to open.
function preserveNafezlyProjectUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return String(rawUrl || "");
    return url.href;
  } catch {
    return String(rawUrl || "");
  }
}

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
  async detail(item) {
    // Keep the source URL exactly as published in the Telegram channel.
    const originalUrl = preserveNafezlyProjectUrl(item.url);
    const feedItem = { ...item, url: originalUrl };
    const candidates = originalUrl ? [originalUrl] : [];
    const feedDescription = cleanText(feedItem.description || "");
    let lastReason = "no page attempt succeeded";

    for (const candidateUrl of candidates) {
      try {
        const response = await fetch(candidateUrl, {
          headers: {
            ...HEADERS,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: "https://nafezly.com/projects",
          },
          redirect: "follow",
        });
        const host = (() => { try { return new URL(candidateUrl).hostname; } catch { return "unknown"; } })();
        console.log(`[nafezly] detail fetch id=${item.id}; host=${host}; status=${response.status}`);
        if (!response.ok) {
          lastReason = `HTTP ${response.status} on ${host}`;
          continue;
        }

        const html = await response.text();
        if (looksLikeChallenge(html, response)) {
          lastReason = `challenge/JavaScript placeholder on ${host}`;
          console.warn(`[nafezly] detail page was a challenge/JS placeholder for #${item.id} on ${host}; preserving the official Telegram project link`);
          continue;
        }

        const pageItem = parseHtmlProject("nafezly", html, { ...item, url: candidateUrl });
        const pageDescription = cleanText(pageItem.description || "");
        const titleIsUseful = pageItem.title && !isGenericTitle(pageItem.title, "nafezly") && !/^javascript is disabled$/i.test(pageItem.title.trim());
        const pageHasUsefulData = titleIsUseful || isUsefulDescription(pageDescription, pageItem.title || feedItem.title);
        if (!pageHasUsefulData) {
          lastReason = `page parsed but no useful project content on ${host}`;
          console.warn(`[nafezly] detail parse yielded no useful content for #${item.id} on ${host}; preserving the official Telegram project link`);
          continue;
        }

        const usePageDescription = pageDescription.length > feedDescription.length;
        const result = {
          ...feedItem,
          ...pageItem,
          url: feedItem.url,
          title: titleIsUseful ? pageItem.title : feedItem.title,
          debug: { ...(pageItem.debug || {}), titleFrom: titleIsUseful ? "project-page" : "telegram-feed", feedTitleLooksCut: /(?:…|\.\.\.)\s*$/.test(feedItem.title || "") },
          description: usePageDescription ? pageDescription : feedDescription,
          budget: pageItem.budget || feedItem.budget || "",
          skills: pageItem.skills?.length ? pageItem.skills : (feedItem.skills || []),
          extra: pageItem.extra?.length ? pageItem.extra : (feedItem.extra || []),
        };
        console.log(`[nafezly] detail source=${usePageDescription ? "project-page" : (pageDescription ? "page-title+feed-description" : "telegram-feed")}; id=${item.id}; host=${host}; pageDescriptionChars=${pageDescription.length}; feedDescriptionChars=${feedDescription.length}; sentDescriptionChars=${result.description.length}`);
        return result;
      } catch (error) {
        lastReason = String(error);
        console.warn(`[nafezly] detail fetch failed id=${item.id}; url=${candidateUrl}; error=${lastReason}`);
      }
    }

    console.warn(`[nafezly] full detail unavailable for #${item.id}; reason=${lastReason}; using Telegram excerpt (${feedDescription.length} chars)`);
    return feedItem;
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

    const urlMatch = block.match(/href=["'](https?:\/\/(?:www\.)?(?:nafezly|nafzly)\.com\/project\/(\d+)(?:-[^"'?#\s<>]*)?(?:\?[^"']*)?)["']/i);
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

    const url = preserveNafezlyProjectUrl(urlMatch[1]);
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


// Khamsat's detail pages may return a JavaScript-disabled placeholder to Workers.
// Still publish the real request discovered on the listing page: preserve its ID,
// use the actual listing anchor text when available, otherwise derive a readable
// title from the request URL slug. A blocked detail page must never replace the
// project title with "JavaScript is disabled" or cause the request to disappear.
const khamsatSite = {
  key: "khamsat",
  name: "خمسات",
  base: "https://khamsat.com",
  listUrl: "https://khamsat.com/community/requests",
  async list() {
    const response = await fetch(this.listUrl, { headers: HEADERS, redirect: "follow" });
    if (!response.ok) throw new Error(`khamsat list HTTP ${response.status}`);
    const html = await response.text();
    if (looksLikeChallenge(html, response)) throw new Error("khamsat listing returned a challenge page; no reliable project list available");

    const found = new Map();
    const anchorRe = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
    for (const match of html.matchAll(anchorRe)) {
      const rawHref = decode(match[2] || "");
      let url;
      try { url = new URL(rawHref, this.base); } catch { continue; }
      const idMatch = url.pathname.match(/^\/community\/requests\/(\d+)(?:-|$)/);
      if (!idMatch) continue;
      const id = Number(idMatch[1]);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const normalizedUrl = `https://khamsat.com${url.pathname}`;
      const anchorText = cleanTitle(htmlToText(match[3] || ""), "khamsat");
      const slugTitle = titleFromUrl(normalizedUrl);
      const anchorIsUseful = anchorText && !/^(?:فتح\s+(?:المشروع|الطلب)|عرض\s+(?:المشروع|الطلب)|المزيد|اقرأ المزيد|javascript is disabled|enable javascript)$/i.test(anchorText);
      const title = anchorIsUseful ? anchorText : (slugTitle || `طلب جديد #${id}`);
      const candidate = { id, url: normalizedUrl, title, description: "", budget: "", skills: [], extra: [], source: "khamsat-listing" };
      const current = found.get(id);
      // Prefer a descriptive title over a button label or numeric fallback.
      if (!current || (candidate.title.length > current.title.length && !isGenericTitle(candidate.title, "khamsat"))) {
        found.set(id, candidate);
      }
    }

    // Fallback for list HTML where project URLs are present but not wrapped in a
    // simple <a> element that matched the parser above.
    const pathRe = /\/community\/requests\/(\d+)(?:-[^"'\s<>?#]*)?/g;
    for (const match of html.matchAll(pathRe)) {
      const id = Number(match[1]);
      if (!Number.isSafeInteger(id) || id <= 0 || found.has(id)) continue;
      const path = match[0].split(/[?#]/, 1)[0];
      const url = new URL(path, this.base).href;
      found.set(id, {
        id, url,
        title: titleFromUrl(url) || `طلب جديد #${id}`,
        description: "", budget: "", skills: [], extra: [], source: "khamsat-listing-slug",
      });
    }

    const items = [...found.values()].sort((a, b) => a.id - b.id);
    console.log(`[khamsat] listing parsed ${items.length} real request(s); newest=${items.length ? items.reduce((max, item) => Math.max(max, item.id), 0) : "none"}`);
    if (!items.length) throw new Error("khamsat listing loaded, but no request links could be parsed");
    return items;
  },
  async detail(item) {
    const fallback = {
      ...item,
      title: (item.title && !isGenericTitle(item.title, "khamsat")) ? item.title : (titleFromUrl(item.url) || `طلب جديد #${item.id}`),
      description: item.description || "",
      budget: item.budget || "",
      skills: item.skills || [],
      extra: item.extra || [],
    };
    try {
      const response = await fetch(item.url, {
        headers: { ...HEADERS, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", Referer: "https://khamsat.com/community/requests" },
        redirect: "follow",
      });
      // Some responses that are not HTTP 200 still include Open Graph/JSON-LD
      // metadata. Parse first, then decide whether the response has useful fields.
      const html = await response.text();
      const parsed = parseHtmlProject("khamsat", html, item);
      const title = isGenericTitle(parsed.title, "khamsat") ? fallback.title : parsed.title;
      const description = isUsefulDescription(parsed.description, title) ? parsed.description : fallback.description;
      const budget = parsed.budget || fallback.budget;
      const skills = parsed.skills?.length ? parsed.skills : fallback.skills;
      const extra = parsed.extra?.length ? parsed.extra : fallback.extra;
      const challenge = looksLikeChallenge(html, response);
      const hasUsefulDetails = Boolean(description || budget || skills.length || extra.length);

      if ((!response.ok || challenge) && !hasUsefulDetails) {
        console.warn(`[khamsat] detail unavailable for #${item.id}; status=${response.status}; challenge=${challenge}; no useful metadata in response`);
        return fallback;
      }
      const result = { ...fallback, ...parsed, title, description, budget, skills, extra };
      console.log(`[khamsat] detail source=${description ? (parsed.debug?.descSource || "project-page") : hasUsefulDetails ? "project-page-metadata-only" : "listing-title-fallback"}; id=${item.id}; status=${response.status}; challenge=${challenge}; budget=${Boolean(budget)}; descriptionChars=${description.length}; htmlChars=${html.length}`);
      return result;
    } catch (error) {
      console.warn(`[khamsat] detail fetch failed for #${item.id}: ${String(error)}; sending listing title and project link`);
      return fallback;
    }
  },
};

// ---------------------------------------------------------------------
// Khamsat requests via the public Telegram channel (https://t.me/s/KhamsatRequests)
// Khamsat's own request pages are not readable from a Worker (they are rendered by JavaScript),
// so the channel is the source of truth: it is public, fast and carries the request text.
// ---------------------------------------------------------------------
const KHAMSAT_CHANNEL = "KhamsatRequests";
const KHAMSAT_MESSAGE_ID_OFFSET = 1_000_000_000; // only used if the channel posts carry no khamsat.com link

// Raw posts from a t.me/s/<channel> preview page.
function extractTelegramPosts(html) {
  const source = String(html);
  const wrappers = [...source.matchAll(/<div\b[^>]*class=["'][^"']*\btgme_widget_message_wrap\b[^"']*["'][^>]*>/gi)];
  const posts = [];
  for (let index = 0; index < wrappers.length; index++) {
    const start = wrappers[index].index;
    const end = index + 1 < wrappers.length ? wrappers[index + 1].index : source.length;
    const block = source.slice(start, end);
    const postMatch = block.match(/data-post=["'][^"'\/]*\/(\d+)["']/i);
    const bodyMatch = block.match(/<div\b[^>]*class=["'][^"']*\btgme_widget_message_text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    if (!postMatch || !bodyMatch) continue;
    // Links can be in the text OR in the inline keyboard button ("open request") under the post.
    const links = [...block.matchAll(/href=["']([^"']+)["']/gi)].map((m) => decode(m[1]));
    posts.push({ messageId: Number(postMatch[1]), text: htmlToText(bodyMatch[1]), links });
  }
  return posts;
}

const REQUEST_LABELS = {
  title: ["عنوان الطلب", "عنوان المشروع", "العنوان", "عنوان"],
  description: ["تفاصيل الطلب", "تفاصيل المشروع", "وصف الطلب", "الوصف", "التفاصيل", "تفاصيل"],
  budget: ["الميزانية المتوقعة", "ميزانية الطلب", "ميزانية المشروع", "الميزانية", "الميزانيه", "السعر", "budget", "estimated budget", "price range"],
  owner: ["صاحب الطلب", "اسم صاحب الطلب", "المشتري"],
  requestType: ["نوع الطلب", "التصنيف", "القسم"],
  duration: ["مدة التنفيذ", "المدة", "مدة"],
  skip: ["رابط الطلب", "رابط المشروع", "الرابط", "الحالة", "عدد العروض", "تاريخ النشر", "الوقت", "منذ"],
};

// Removes emoji / bullets / markdown marks in front of a line and around a label.
function stripPostDecoration(line) {
  return String(line || "")
    .replace(/[*_`~]/g, "")
    .replace(/^(?:\s*[0-9#*]\uFE0F?\u20E3)+/u, "")
    .replace(/^[\s\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200d\u200f\u200e•▪▫◾◽➖➡▶►»«\-–—#|]+/u, "")
    .trim();
}

function matchRequestLabel(line) {
  const clean = stripPostDecoration(line);
  for (const [field, labels] of Object.entries(REQUEST_LABELS)) {
    for (const label of labels) {
      // Metadata fields may be written as "label: value" or "label value".
      // The value-after-space variant is enabled only for budget/owner/type so
      // ordinary prose is not accidentally consumed as a labelled field.
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const separator = field === "budget" || field === "owner" || field === "requestType"
        ? "\\s*(?:[:：]\\s*(.*)|\\s+(.+)|)"
        : "\\s*(?:[:：]\\s*(.*)|)";
      const match = clean.match(new RegExp(`^${escaped}${separator}$`, "i"));
      if (match) return { field, rest: (match[1] || match[2] || "").trim() };
    }
  }
  return null;
}

// Parses one channel post into title / description / budget, with or without labels.
function extractStandaloneBudgetLine(rawLine) {
  let source = normalizeDigits(stripPostDecoration(rawLine));
  if (!source) return "";
  source = source.replace(/^(?:الميزانية(?:\s+المتوقعة)?|ميزانية(?:\s+(?:الطلب|المشروع))?|الميزانيه|السعر|budget|estimated budget|price range)\s*[:：-]?\s*/i, "").trim();
  const hasCurrency = /[$€£]|\b(?:USD|US\$|EUR|GBP|SAR|EGP|AED|دولار(?:اً)?|ريال(?:اً)?|جنيه(?:اً)?|ج\.?م\.?)\b/i.test(source)
    || /(?:دولار|ريال|جنيه)/i.test(source);
  if (!hasCurrency || !/^\s*(?:(?:من|from)\s*)?(?:[$€£]\s*)?\d/.test(source)) return "";
  const amount = /(?:[$€£]\s*)?\d[\d,٫.]*(?:\s*(?:-|–|—|إلى|الى|to)\s*(?:[$€£]\s*)?\d[\d,٫.]*)?\s*(?:[$€£]|US\$|USD|EUR|GBP|SAR|EGP|AED|دولار(?:اً)?|ريال(?:اً)?|جنيه(?:اً)?|ج\.?م\.?)?/i.exec(source);
  if (!amount || !/\d/.test(amount[0]) || !/[$€£]|US\$|USD|EUR|GBP|SAR|EGP|AED|دولار|ريال|جنيه|ج\.?م\.?/i.test(amount[0])) return "";
  const value = cleanText(amount[0]);
  return value.length <= 65 ? value : "";
}

function parseRequestPost(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const buckets = { title: [], description: [], budget: [], duration: [], owner: [], requestType: [], skip: [], preamble: [] };
  const ownerBits = [];
  let current = "preamble";
  for (const line of lines) {
    // "👤 name" / badge lines describe the buyer; keep them separate from body text.
    if (current === "preamble" && buckets.preamble.length >= 1 && /^\s*(?:\u{1F464}|\u{1F396}|\u{1F3C5}|\u{1F947}|\u{1F948}|\u{1F949})/u.test(line)) {
      ownerBits.push(stripPostDecoration(line));
      continue;
    }
    const label = matchRequestLabel(line);
    if (label) {
      current = label.field;
      if (label.rest) buckets[current].push(label.rest);
      continue;
    }
    // Some channel posts publish the amount as a standalone line (for example
    // "💰 $100 - $250"), without an explicit "الميزانية:" label.
    if (current !== "budget") {
      const inferredBudget = extractStandaloneBudgetLine(line);
      if (inferredBudget) {
        buckets.budget.push(inferredBudget);
        continue;
      }
    }
    buckets[current].push(line);
  }

  const isNoise = (rawLine) => {
    const line = stripPostDecoration(rawLine);
    return /^https?:\/\/\S+$/i.test(line) || /^(?:#[^\s#]+\s*)+$/.test(line) || /^(?:@\w+)$/.test(line);
  };
  const isHeader = (line) => /^(?:طلب|مشروع|خدمة)\s+(?:جديد|جديدة)\s*[!:.]*$/.test(stripPostDecoration(line));
  const clean = (list) => list.filter((line) => !isNoise(line)).join("\n").trim();

  let title = cleanText(clean(buckets.title).split("\n")[0] || "");
  let description = clean(buckets.description);

  const preamble = buckets.preamble.filter((line) => !isNoise(line) && !isHeader(line));
  if (!title && preamble.length) {
    title = cleanText(stripPostDecoration(preamble[0]));
    preamble.shift();
  }
  if (!description && preamble.length) description = preamble.join("\n").trim();

  const budget = cleanText(clean(buckets.budget)).replace(/^[:：-]\s*/, "");
  const duration = cleanText(clean(buckets.duration));
  const isRequestType = (value) => /^(?:سيرة ذاتية|كتابة(?:\s+وترجمة)?|ترجمة|تصميم(?:\s+جرافيك)?|برمجة(?:\s+وتطوير)?|تسويق(?:\s+إلكتروني)?|فيديو(?:\s+وأنيميشن)?|صوتيات|هندسة(?:\s+وعمارة)?|أعمال(?:\s+وخدمات\s+استشارية)?|خدمات\s+استشارية|تدريب\s+وتعليم|تعليم|كتابة\s+محتوى|مواقع\s+إلكترونية|تطبيقات|عروض\s+تقديمية|إدخال\s+بيانات|دعم\s+فني|أخرى)$/i.test(stripPostDecoration(value));

  // Prefer explicitly labelled owner/type fields. If the feed appends a profile
  // headline after the owner's name, never merge that headline into the name.
  const rawOwnerValues = [...ownerBits, ...buckets.owner.map((value) => stripPostDecoration(value)).filter(Boolean)];
  let owner = "";
  let requestType = cleanText(clean(buckets.requestType));
  for (const rawValue of rawOwnerValues) {
    const segments = String(rawValue || "").split(/\s+[•·|]\s+/).map((part) => part.trim()).filter(Boolean);
    if (!segments.length) continue;
    if (!owner) owner = segments[0];
    const tailType = segments.slice(1).find(isRequestType);
    if (!requestType && tailType) requestType = tailType;
    // Non-category text after the first segment is usually a buyer profile tagline,
    // not the project type; intentionally do not display it as part of the name.
  }

  return {
    title: title.replace(/^[:：-]\s*/, ""),
    owner: owner.slice(0, 100),
    requestType: requestType.slice(0, 80),
    description: cleanText(description).slice(0, 6000),
    budget: /\d/.test(budget) ? budget.slice(0, 65) : "",
    duration: duration && duration.length <= 40 ? duration : "",
  };
}

function buildKhamsatItems(posts) {
  const requestUrlRe = /^https?:\/\/(?:www\.)?khamsat\.com\/(?:[a-z]{2}\/)?community\/requests\/(\d+)(?:-[^?#\s]*)?/i;
  const withLink = posts.map((post) => {
    const linkMatch = post.links.map((href) => href.match(requestUrlRe)).find(Boolean)
      || post.text.match(/https?:\/\/(?:www\.)?khamsat\.com\/(?:[a-z]{2}\/)?community\/requests\/(\d+)(?:-[^?#\s]*)?/i);
    return { ...post, requestId: linkMatch ? Number(linkMatch[1]) : 0, requestUrl: linkMatch ? linkMatch[0] : "" };
  });

  // Normal case: posts link to khamsat.com, so the request id is the same id space as before.
  const linked = withLink.filter((post) => post.requestId > 0);
  const useRequestIds = linked.length > 0 && linked.length >= withLink.length / 2;
  const source = useRequestIds ? linked : withLink;

  const items = new Map();
  for (const post of source) {
    const parsed = parseRequestPost(post.text);
    const id = useRequestIds ? post.requestId : KHAMSAT_MESSAGE_ID_OFFSET + post.messageId;
    const url = useRequestIds ? post.requestUrl : `https://t.me/${KHAMSAT_CHANNEL}/${post.messageId}`;
    const title = parsed.title || (useRequestIds ? titleFromUrl(url) : "") || `طلب جديد #${id}`;
    if (!parsed.title && !parsed.description) continue;
    const item = {
      id, url, title,
      description: normalizeDescription(parsed.description, title, 3),
      budget: parsed.budget,
      skills: [],
      extra: [
        parsed.owner ? `صاحب الطلب: ${parsed.owner}` : "",
        parsed.requestType ? `نوع الطلب: ${parsed.requestType}` : "",
        parsed.duration ? `المدة: ${parsed.duration}` : "",
      ].filter(Boolean),
      source: "khamsat-telegram",
      debug: { mode: useRequestIds ? "request-id-from-link" : "telegram-message-id", messageId: post.messageId },
    };
    const existing = items.get(id);
    if (!existing || item.description.length > existing.description.length) items.set(id, item);
  }
  return [...items.values()].sort((a, b) => a.id - b.id);
}

// When a channel post carries no khamsat.com link, find the same request on the khamsat.com
// listing (by title) so the notification still opens the request itself, never the Telegram post.
async function resolveKhamsatLinksFromListing(items) {
  let listing = [];
  try {
    listing = await khamsatSite.list();
  } catch (error) {
    console.warn(`[khamsat] listing lookup for direct links failed: ${String(error)}`);
    return [];
  }
  const norm = (value) => cleanText(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLocaleLowerCase();
  const index = listing.map((entry) => ({ ...entry, key: norm(entry.title) })).filter((entry) => entry.key);
  const resolved = [];
  for (const item of items) {
    const key = norm(item.title);
    if (key.length < 8) continue;
    const hit = index.find((entry) => entry.key === key)
      || index.find((entry) => entry.key.length >= 12 && key.length >= 12 && (entry.key.startsWith(key.slice(0, 25)) || key.startsWith(entry.key.slice(0, 25))));
    if (hit) resolved.push({ ...item, id: hit.id, url: hit.url, debug: { ...(item.debug || {}), mode: "matched-from-khamsat-listing" } });
  }
  return resolved.sort((a, b) => a.id - b.id);
}

const khamsatTelegram = {
  key: "khamsat",
  name: "خمسات",
  async list() {
    const response = await fetch(`https://t.me/s/${KHAMSAT_CHANNEL}`, {
      headers: { ...HEADERS, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", Referer: "https://t.me/" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`khamsat Telegram feed HTTP ${response.status}`);
    const posts = extractTelegramPosts(await response.text());
    let items = buildKhamsatItems(posts);
    console.log(`[khamsat] source=public Telegram feed; posts=${posts.length}; requests=${items.length}; mode=${items[0]?.debug?.mode || "none"}`);
    if (!items.length) throw new Error("Khamsat Telegram feed loaded but no request posts could be parsed");

    if (items[0].debug?.mode === "telegram-message-id") {
      // The posts have no khamsat.com link: look the requests up on khamsat.com to get the real link.
      const matched = await resolveKhamsatLinksFromListing(items);
      console.log(`[khamsat] posts without a link: matched ${matched.length}/${items.length} on the khamsat.com listing`);
      if (!matched.length) throw new Error("Khamsat posts carry no request link and none could be matched on khamsat.com; refusing to send Telegram-channel links");
      items = matched;
    }
    return items;
  },
  async detail(item) {
    // Use the Telegram post for its full body. If it did not include a budget,
    // still inspect the original Khamsat page for budget metadata (when available).
    if (item.description && item.description.length >= 15 && item.budget) return item;
    if (!/^https?:\/\/(?:www\.)?khamsat\.com\//i.test(item.url || "")) return item;
    try {
      const page = await khamsatSite.detail(item);
      const enriched = {
        ...item,
        ...page,
        title: item.title && !isGenericTitle(item.title, "khamsat") ? item.title : page.title,
        description: item.description || page.description,
        budget: page.budget || item.budget,
        skills: page.skills?.length ? page.skills : (item.skills || []),
        extra: [...(item.extra || [])],
      };
      // Add only relevant page metadata not already present in the channel post.
      for (const value of page.extra || []) {
        if (value && !enriched.extra.includes(value)) enriched.extra.push(value);
      }
      console.log(`[khamsat] page enrichment: id=${item.id}; descriptionFromFeed=${Boolean(item.description)}; budgetFromFeed=${Boolean(item.budget)}; budgetAfterPage=${Boolean(enriched.budget)}`);
      return enriched;
    } catch (error) {
      console.warn(`[khamsat] page enrichment failed for #${item.id}: ${String(error)}`);
      return item;
    }
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
  nafezlyTelegram,
  khamsatTelegram,

  freelancer,
];
const SITE_KEYS = SITES.map((site) => site.key);

// A real anti-bot interstitial is a tiny page whose ONLY content is the challenge.
// Do NOT match on "challenge-platform" or "enable javascript" alone: Cloudflare injects
// /cdn-cgi/challenge-platform/... into perfectly normal pages, and many sites carry a
// <noscript>"enable JavaScript"</noscript> notice. Treating those as challenges made the
// bot discard good project pages (Khamsat/Nafezly) and fall back to the title only.
function visibleText(html) {
  return decode(String(html)
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeChallenge(html, response = null) {
  if (response?.headers?.get?.("cf-mitigated")) return true;
  const source = String(html || "");
  const head = source.slice(0, 20000);
  if (/<title[^>]*>\s*(?:just a moment|attention required|access denied|checking your browser|verify you are human)/i.test(head)) return true;
  if (/id=["']challenge-(?:form|running|error-text|stage)["']|cf-browser-verification|class=["'][^"']*cf-error-details/i.test(head)) return true;
  if (source.length < 30000) {
    const visible = visibleText(source);
    if (visible.length < 600 && /enable javascript|javascript\s+(?:is\s+)?(?:disabled|required)|verify you are human|checking your browser|just a moment/i.test(visible)) return true;
  }
  return false;
}

// Labels that appear as standalone lines on the project pages (Mostaql, Kafiil, Nafezly...).
// Used to know where one section ends and the next begins, so a description that happens
// to contain the word "الميزانية" is not cut in the middle.
const PROJECT_LABELS = [
  "تفاصيل المشروع", "تفاصيل الطلب", "وصف المشروع", "حالة المشروع", "تاريخ النشر", "الميزانية",
  "الميزانية المتوقعة", "مدة التنفيذ", "مدة المشروع", "المهارات", "المهارات المطلوبة", "صاحب المشروع",
  "صاحب الطلب", "العروض المقدمة", "تقدم للمشروع", "عروض", "أضف عرضك", "معلومات المشروع",
  "عدد العروض", "متوسط العروض", "عن الموضوع",
];
const DESCRIPTION_STOP_LABELS = PROJECT_LABELS.filter((label) => !["تفاصيل المشروع", "تفاصيل الطلب", "وصف المشروع"].includes(label));

function plainLines(plain) {
  return String(plain || "").split("\n").map((line) => line.trim());
}

function isLabelLine(line, labels) {
  return labels.some((label) => line === label || line.startsWith(`${label}:`) || line.startsWith(`${label}：`));
}

// Text of the section that starts at a standalone label line and runs until the next label line.
function sectionBetweenLines(plain, startLabels, stopLabels) {
  const lines = plainLines(plain);
  const start = lines.findIndex((line) => isLabelLine(line, startLabels));
  if (start < 0) return "";
  const out = [];
  const inline = lines[start].replace(/^[^:：]*[:：]\s*/, "");
  if (inline && inline !== lines[start]) out.push(inline);
  for (let i = start + 1; i < lines.length; i++) {
    if (isLabelLine(lines[i], stopLabels)) break;
    out.push(lines[i]);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
}

// Value that follows a label: either on the same line ("الميزانية $25 - $50") or on the next line.
function labelValue(plain, labels, { numeric = false } = {}) {
  const lines = plainLines(plain);
  const numericStart = /^[$€£]?\s*[\d٠-٩]/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const label = labels.find((l) => line === l || line.startsWith(`${l} `) || line.startsWith(`${l}:`) || line.startsWith(`${l}：`));
    if (!label) continue;
    const rest = line.slice(label.length).replace(/^[\s:：|\-]+/, "").trim();
    if (rest && (!numeric || numericStart.test(rest))) return rest;
    if (rest) continue; // a sentence that merely starts with the label word
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      if (!lines[j]) continue;
      if (isLabelLine(lines[j], PROJECT_LABELS)) break;
      if (!numeric || numericStart.test(lines[j])) return lines[j];
      break;
    }
  }
  return "";
}

// Khamsat "طلبات الخدمات غير الموجودة": the request body sits between the heading and the
// "عن الموضوع" block (there is no "تفاصيل الطلب" label on the page).
function extractKhamsatDescription(plain, title) {
  const lines = plainLines(plain).filter(Boolean);
  const aboutIdx = lines.findIndex((line) => line === "عن الموضوع");
  if (aboutIdx < 0) return "";
  const norm = (value) => cleanText(value).replace(/\s+/g, " ").toLocaleLowerCase();
  const wanted = norm(title || "");
  let start = -1;
  if (wanted) {
    for (let i = aboutIdx - 1; i >= 0; i--) {
      if (norm(lines[i]) === wanted) { start = i + 1; break; }
    }
  }
  if (start < 0) {
    for (let i = aboutIdx - 1; i >= 0; i--) {
      if (lines[i] === "طلبات الخدمات غير الموجودة") { start = i + 2; break; }
    }
  }
  if (start < 0 || start >= aboutIdx) return "";
  return lines.slice(start, aboutIdx).join("\n");
}

// Everything after the description section (from the first following label line on).
function textAfterDescription(plain) {
  const lines = plainLines(plain);
  const start = lines.findIndex((line) => isLabelLine(line, ["تفاصيل المشروع", "وصف المشروع", "تفاصيل الطلب"]));
  if (start < 0) return plain;
  for (let i = start + 1; i < lines.length; i++) {
    if (isLabelLine(lines[i], DESCRIPTION_STOP_LABELS)) return lines.slice(i).join("\n");
  }
  return plain;
}

// Some sites ship the request text only inside a <script> JSON payload (SPA hydration state,
// __NEXT_DATA__, JSON-LD...) and render nothing readable in the HTML. Look for an object that
// belongs to this project (same id or same title) and take its longest text-like field.
function extractDescriptionFromScripts(html, title, id) {
  const textKeys = /^(?:description|desc|content|body|details?|text|message|brief|summary|request_?details?|full_?description)$/i;
  const wantedTitle = cleanText(title || "").replace(/\s+/g, " ").toLocaleLowerCase();
  const candidates = [];
  const seen = new Set();

  const consider = (node) => {
    const ownsId = id && Object.values(node).some((value) => typeof value === "number" && value === Number(id));
    const ownsTitle = wantedTitle && Object.values(node).some((value) => typeof value === "string" && cleanText(value).replace(/\s+/g, " ").toLocaleLowerCase() === wantedTitle);
    if (!ownsId && !ownsTitle) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value !== "string" || !textKeys.test(key)) continue;
      const text = cleanText(value.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|div|li)>/gi, "\n"));
      if (text.length >= 15 && text.toLocaleLowerCase() !== wantedTitle) candidates.push(text);
    }
  };

  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 14 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const child of node.slice(0, 300)) walk(child, depth + 1); return; }
    consider(node);
    for (const child of Object.values(node)) walk(child, depth + 1);
  };

  let scanned = 0;
  for (const match of String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (++scanned > 80) break;
    const attrs = match[1] || "";
    const body = (match[2] || "").trim();
    if (!body || body.length > 500000 || /\bsrc=/i.test(attrs)) continue;
    const payloads = [];
    if (/type=["']application\/(?:[\w.+-]*\+)?json["']/i.test(attrs) || /^[\[{]/.test(body)) payloads.push(body);
    else {
      const assignment = body.match(/=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*;?\s*$/);
      if (assignment) payloads.push(assignment[1]);
    }
    for (const payload of payloads) {
      try { walk(JSON.parse(payload), 0); } catch (_) { /* not JSON: ignore */ }
    }
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || "";
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

  // Description, best source first. Open Graph / meta descriptions are usually cut to
  // ~160-200 characters, so they are only a last resort.
  let description = "";
  let descSource = "none";
  const accept = (value, source, minLength = 8) => {
    if (description) return;
    const cleaned = normalizeDescription(value, title, minLength);
    if (cleaned) { description = cleaned; descSource = source; }
  };

  if (siteKey === "khamsat") accept(extractKhamsatDescription(plain, title), "khamsat-heading-block");
  accept(sectionBetweenLines(plain, ["تفاصيل المشروع", "وصف المشروع", "تفاصيل الطلب"], DESCRIPTION_STOP_LABELS), "label-lines");
  if (!description) {
    const inline = siteKey === "khamsat"
      ? textAfterAnyLabel(plain, ["تفاصيل الطلب", "تفاصيل المشروع", "وصف الطلب"], ["آخر تفاعل", "تاريخ النشر", "صاحب الطلب", "الميزانية"])
      : textAfterAnyLabel(plain, ["تفاصيل المشروع", "وصف المشروع", "قم بوصف المشروع"], ["مهارات مطلوبة", "المهارات المطلوبة", "حالة المشروع", "المدة المتوقعة", "عدد العروض", "أضف عرضك الآن"]);
    accept(inline, "label-inline", 25);
  }
  if (!description) accept(extractDescriptionFromScripts(html, title, item.id), "script-json", 8);
  accept(jsonLd.description, "json-ld", 25);
  accept(extractLikelyDescription(html, title), "container-heuristic", 25);
  accept(meta(html, "og:description") || meta(html, "description") || meta(html, "twitter:description"), "meta-description-truncated", 25);

  // Metadata (budget, duration, bids, skills) lives AFTER the description block.
  const afterBody = textAfterDescription(plain);

  // Budget: read the value that follows the label line first (accurate), then fall back.
  let budget = "";
  const budgetValue = labelValue(afterBody, ["الميزانية", "الميزانية المتوقعة", "ميزانية المشروع"], { numeric: true });
  if (budgetValue) budget = extractBudget(`الميزانية: ${budgetValue}`);
  if (!budget) budget = extractBudget(`${meta(html, "og:description")} ${meta(html, "description")} ${jsonLd.description || ""}`);

  const skills = extractSkills(afterBody);
  const extra = [];
  const bids = normalizeDigits(afterBody).match(/عدد العروض\s*:?\s*(\d+)/);
  if (bids) extra.push(`عدد العروض: ${bids[1]}`);
  const duration = labelValue(afterBody, ["مدة التنفيذ", "مدة المشروع"]);
  if (duration && duration.length <= 40) extra.push(`المدة: ${duration}`);

  return {
    ...item,
    title: title || `مشروع جديد #${item.id}`,
    description,
    budget,
    skills,
    extra,
    debug: { descSource, htmlLength: String(html).length, textLength: plain.length, descriptionLength: description.length },
  };
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
  const lines = plainLines(plain);
  const skillLabels = ["المهارات المطلوبة", "المهارات"];
  const index = lines.findIndex((line) => skillLabels.some((label) => line === label || line.startsWith(`${label}:`) || line.startsWith(`${label}：`) || line.startsWith(`${label} `)));
  if (index < 0) return [];
  const result = [];
  const label = skillLabels.find((l) => lines[index].startsWith(l)) || "";
  const sameLine = lines[index].slice(label.length).replace(/^[\s:：]+/, "");
  if (sameLine && sameLine.length <= 60 && !isLabelLine(sameLine, PROJECT_LABELS)) {
    for (const part of sameLine.split(/[،,|•·]/)) {
      const skill = cleanText(part);
      if (skill.length > 1 && skill.length < 50) result.push(skill);
    }
  }
  for (let i = index + 1; i < lines.length && result.length < 8; i++) {
    const line = lines[i];
    if (!line) { if (result.length) break; continue; }
    if (isLabelLine(line, PROJECT_LABELS) || line.length > 60) break;
    for (const part of line.split(/[،,|•·]/)) {
      const skill = cleanText(part);
      if (skill.length > 1 && skill.length < 50) result.push(skill);
    }
  }
  return [...new Set(result)].slice(0, 8);
}

// ---------------------------------------------------------------------
// Category-channel classifier
// The specialized channel accepts two types of jobs:
// 1) Real data analysis / BI work.
// 2) General execution tasks (PDF, PowerPoint, CV, generic Excel, data entry,
//    simple document work and social-media services).
// Python or SQL alone is NOT enough to classify a job as data analysis.
// ---------------------------------------------------------------------
const CHANNEL_CATEGORY_LABELS = {
  data_analysis: "تحليل بيانات وذكاء أعمال",
  excel_office: "Excel وجداول ومهام مكتبية",
  pdf_documents: "PDF وتحويل وتنسيق ملفات",
  presentations: "PowerPoint وعروض تقديمية",
  cv_resume: "CV وسيرة ذاتية وملفات التقديم",
  data_entry: "إدخال بيانات ونسخ وكتابة",
  transcription_subtitles: "تفريغ صوتي وترجمة مرئية",
  voiceover_audio: "تعليق صوتي وتسجيل ودوبلاج",
  translation: "ترجمة وتعريب",
  arabic_content: "كتابة محتوى باللغة العربية",
  proofreading: "تدقيق لغوي ومراجعة نصوص",
  social_media: "سوشيال ميديا وتفاعل وإدارة حسابات",
  research_assistant: "بحث على الإنترنت ومساعد افتراضي",
  ecommerce_listing: "إدخال منتجات ومتاجر إلكترونية",
  basic_design: "تصميمات بسيطة وتعديل صور وقوالب",
  video_audio: "مونتاج فيديو وتعديل صوت",
  customer_support: "خدمة عملاء ومتابعة ورسائل",
  forms_surveys: "نماذج واستبيانات وتجميع معلومات",
};

function normalizeCategoryText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ").trim();
}

// Whole-phrase matching in normalized English and Arabic, to avoid accidental
// matches on tiny fragments such as "sql" inside unrelated words.
function categoryHasAny(text, phrases) {
  if (!text) return false;
  const padded = ` ${text} `;
  return phrases.some((phrase) => {
    const normalized = normalizeCategoryText(phrase);
    return normalized && padded.includes(` ${normalized} `);
  });
}

const DATA_ANALYSIS_STRONG = [
  "data analysis", "data analyst", "data analytics", "business intelligence", "bi analyst",
  "bi reporting", "business analytics", "data science", "data visualization", "data visualisation",
  "power bi", "powerbi", "tableau", "looker studio", "qlik sense", "qlikview", "metabase",
  "apache superset", "dax", "power query", "power pivot", "data warehouse", "data warehousing",
  "data pipeline", "etl pipeline", "data modeling", "data modelling", "data mart", "olap cube",
  "data dashboard", "analytics dashboard", "sales dashboard", "financial dashboard", "executive dashboard",
  "interactive dashboard", "kpi dashboard", "dashboard development", "dashboard creation",
  "data reporting", "sales analytics", "financial analytics", "customer analytics", "marketing analytics",
  "retail analytics", "data cleaning", "data cleansing", "data wrangling", "exploratory data analysis",
  "statistical analysis", "predictive analytics", "forecasting model", "time series analysis",
  "customer segmentation", "cohort analysis", "ab testing analysis", "marketing dashboard", "operations dashboard",
  "supply chain analytics", "logistics analytics", "inventory analytics", "retention analysis", "churn analysis",
  "profitability analysis", "variance analysis", "financial modeling", "financial modelling", "forecast model",
  "تحليل سلاسل الامداد", "تحليل المخزون", "تحليل الربحية", "تحليل الانحرافات", "تحليل الاحتفاظ بالعملاء",
  "تحليل فقدان العملاء", "تحليل العمليات", "تحليل لوجستي", "تحليل سلسلة الامداد", "تحليل البيانات", "تحليل بيانات",
  "تحليل الداتا", "محلل بيانات", "محلل البيانات", "محلله بيانات", "تحليلات البيانات", "علم البيانات",
  "ذكاء الاعمال", "تحليل احصائي", "تحليل المبيعات", "تحليل مالي", "تحليل الاداء", "تحليل العملاء",
  "تحليل التسويق", "تحليل بيانات العملاء", "تحليل بيانات المبيعات", "تحليل بيانات مالية",
  "تنظيف البيانات", "تنظيف الداتا", "تصور البيانات", "تصوير البيانات", "لوحة مؤشرات", "لوحات معلومات",
  "لوحة معلومات", "لوحة تحكم تحليلية", "لوحات تحكم تحليلية", "داشبورد", "داش بورد", "داشبورد تفاعلية",
  "لوحة بيانات تفاعلية", "مؤشرات الاداء", "تقارير ذكاء الاعمال", "تقارير البيانات", "تقارير تحليلية",
  "تقرير تحليلي", "تقرير مبيعات", "تقارير المبيعات", "التنبؤ بالمبيعات", "التنبؤ بالطلب",
  "تحليل الاتجاهات", "تحليل السلاسل الزمنية", "تحليل الاستبيانات", "تحليل احصائيات",
];
const ANALYSIS_CONTEXT = [
  "analysis", "analytics", "analytical", "reporting", "data report", "dashboard", "dashboards",
  "kpi", "kpis", "metrics", "business metrics", "visualization", "visualisation", "forecasting",
  "statistics", "dataset", "datasets", "data cleaning", "data model", "data insights", "sales analysis",
  "financial analysis", "customer analysis", "performance analysis", "data quality", "trend analysis",
  "تحليل", "تحليلات", "تقارير", "تقرير", "لوحات معلومات", "لوحة معلومات", "لوحات تحكم", "داشبورد",
  "مؤشرات الاداء", "احصائيات", "تنظيف البيانات", "تحليل المبيعات", "تحليل مالي", "تحليل العملاء",
  "التنبؤ", "البيانات التاريخية", "استخراج المؤشرات", "استخراج الرؤى", "عرض النتائج", "تصور البيانات",
];
const BROAD_DATA_TOOLS = [
  "excel", "microsoft excel", "ms excel", "google sheets", "spreadsheet", "spreadsheets", "sql",
  "mysql", "postgresql", "postgres", "python", "pandas", "numpy", "r programming", "jupyter",
  "jupyter notebook", "power query", "power pivot", "pivot table", "pivot tables", "csv", "dataframe",
  "data frame", "اكسل", "اكسيل", "جداول البيانات", "مايكروسوفت اكسل", "جوجل شيتس", "بايثون", "اس كيو ال",
];
const REPORT_SIGNALS = [
  "dashboard", "dashboards", "kpi", "kpis", "business metrics", "data report", "sales report",
  "financial report", "data visualization", "forecasting", "data cleaning", "pivot table analysis",
  "لوحات معلومات", "لوحة معلومات", "لوحات تحكم", "داشبورد", "مؤشرات الاداء", "تقرير تحليلي",
  "تقارير تحليلية", "تحليل المبيعات", "تقارير المبيعات",
];

const GENERAL_CATEGORIES = [
 { key:"transcription_subtitles", phrases:["transcription","audio transcription","video transcription","transcribe audio","transcribe video","speech to text","audio to text","voice to text","arabic transcription","english transcription","meeting transcription","interview transcription","lecture transcription","podcast transcription","verbatim transcription","subtitles","subtitle creation","subtitle editing","captions","closed captions","srt subtitles","srt file","vtt captions","captioning","transcript writing","تفريغ صوتي","تفريغ فيديو","تفريغ محاضرات","تفريغ مقابلات","تفريغ اجتماع","تفريغ تسجيلات","تحويل الصوت الى نص","تحويل الصوت لنص","تحويل الكلام الى نص","كتابة الكلام المسموع","تفريغ عربي","تفريغ انجليزي","اضافة ترجمة للفيديو","ترجمة مرئية","ملف srt","تفريغ بودكاست"]},
 { key:"voiceover_audio", phrases:["voiceover","voice over","voice-over","voice over artist","voice actor","voice acting","voice talent","voice recording","voice narration","narration","audio narration","arabic voice over","arabic voiceover","english voiceover","female voiceover","male voiceover","commercial voice over","ivr recording","audiobook narration","dubbing","voice dub","تعليق صوتي","التعليق الصوتي","معلق صوتي","معلقة صوتية","معلق صوتي عربي","تعليق صوتي عربي","تعليق صوتي انجليزي","تسجيل صوتي","تسجيل اعلان صوتي","تسجيل إعلاني","تسجيل فويس اوفر","فويس اوفر","فويس أوفر","دوبلاج","اداء صوتي","أداء صوتي","تسجيل كتب صوتية","تعليق للفيديو","قراءة نص صوتيا"]},
 { key:"translation", phrases:["translation","translate","translator","translating","translation services","arabic translation","english arabic translation","arabic english translation","translate to arabic","translate to english","localization","localisation","website translation","document translation","subtitle translation","ترجمة","مترجم","ترجمة عربية","ترجمة انجليزي","ترجمة من العربية","ترجمة من الانجليزية","ترجمة من الانجليزي للعربي","ترجمة من العربي للانجليزي","ترجمة ملفات","ترجمة مستندات","ترجمة فيديو","تعريب","تعريب محتوى","تعريب موقع","ترجمة نصوص","ترجمة مقالات"]},
 { key:"arabic_content", phrases:["arabic writing","write arabic articles","arabic articles","write articles in arabic","arabic content","arabic copywriting","content writing","copywriting","article writing","blog writing","blog post","product description writing","product descriptions","script writing","social media captions","ad copy","writing in arabic","arabic writer","seo content writing","website content","creative writing","content creation","كتابة باللغة العربية","الكتابة باللغة العربية","كتابة محتوى","محتوى عربي","كتابة محتوى عربي","كاتب محتوى","كتابة مقالات","كتابة مقال","كتابة تدوينات","كتابة بوستات","كتابة منشورات","كتابة اعلانات","صياغة اعلانية","كتابة وصف منتجات","وصف المنتجات","كتابة محتوى تسويقي","كتابة سكريبت","كتابة نصوص اعلانية","صياغة المحتوى","كتابة محتوى لموقع","كتابة محتوى للسوشيال ميديا","كتابة محتوى متوافق مع السيو"]},
 { key:"proofreading", phrases:["proofreading","proofreader","proofread","copy editing","copy edit","grammar check","spell check","spelling correction","text editing","editing arabic text","arabic proofreading","language review","formatting text","diacritics","arabic diacritics","تدقيق لغوي","تدقيق املائي","مراجعة لغوية","مراجعة النصوص","مراجعة نص","تصحيح لغوي","تصحيح املائي","تصحيح الاخطاء","ضبط التشكيل","تشكيل النص","تشكيل الكلمات","اضافة التشكيل","تنسيق النصوص","تحرير نصوص","مراجعة وتحرير"]},
 { key:"presentations", phrases:["powerpoint","power point","ppt","pptx","presentation","presentations","slide deck","slides","google slides","keynote presentation","pitch deck","presentation design","presentation formatting","academic presentation","business presentation","make a presentation","عروض تقديمية","عرض تقديمي","عرض بوربوينت","باوربوينت","باور بوينت","بوربوينت","عمل برزنتيشن","تصميم برزنتيشن","تصميم عرض تقديمي","اعداد عرض تقديمي","شرائح عرض","تنسيق شرائح","تجهيز شرائح","عرض جامعي","عرض اكاديمي","عرض تفاعلي","تحويل pdf الى powerpoint"]},
 { key:"cv_resume", phrases:["cv","resume","curriculum vitae","resume writing","cv writing","cv design","resume design","linkedin profile","linkedin profile setup","set up linkedin profile","create linkedin profile","linkedin account setup","create a linkedin account","set up a linkedin account","linkedin account creation","cover letter","personal statement","job application documents","سيرة ذاتية","السيرة الذاتية","كتابة cv","تصميم cv","تنسيق cv","سي في","سى في","عمل cv","اعداد سيرة ذاتية","تطوير السيرة الذاتية","تحسين cv","تحسين لينكد ان","بروفايل لينكد ان","إنشاء حساب لينكدإن","انشاء حساب لينكدإن","انشاء حساب لينكد ان","إنشاء حساب لينكد ان","إنشاء حساب لينكدان","انشاء حساب لينكدان","إعداد حساب لينكدإن","اعداد حساب لينكد ان","إنشاء ملف لينكدإن","رسالة تغطية","خطاب تقديم","خطاب تعريفي","ملف تقديم وظيفي","سيرة ذاتية ats","cv ats","resume ats"]},
 { key:"pdf_documents", phrases:["pdf","edit pdf","pdf editing","pdf conversion","convert pdf","pdf to word","word to pdf","merge pdf","split pdf","compress pdf","reduce pdf size","scan to pdf","image to pdf","pdf to image","ocr","document formatting","format document","word document","ms word","microsoft word","docx","doc file","file conversion","convert files","document conversion","formatting documents","scan documents","fillable pdf","pdf form","تعديل pdf","تعديل ملف pdf","تعديل ملفات pdf","تحويل pdf","تحويل ملفات pdf","تحويل pdf الى word","تحويل وورد الى pdf","دمج pdf","دمج ملفات pdf","تقسيم pdf","ضغط pdf","تقليل حجم pdf","صور الى pdf","تحويل الصور الى pdf","مسح ضوئي","استخراج نص من pdf","استخراج النص من الصور","تنسيق ملف word","تنسيق ملف وورد","تنسيق ملفات word","تنسيق مستندات","تنسيق مستند","تحويل الملفات","تعبئة pdf","ملء نموذج pdf","تعديل ملفات وورد"]},
 { key:"data_entry", phrases:["data entry","data-entry","data input","data collection","copy typing","typing job","typing","database entry","data annotation","data labeling","data labelling","tagging data","web scraping data","lead list building","copy paste","copy and paste","manual data entry","product data entry","form filling","ادخال بيانات","ادخال البيانات","مدخل بيانات","تفريغ بيانات","نقل بيانات","نسخ ولصق","نسخ بيانات","كتابة بيانات","كتابة من صور","تحويل الصور الى نص","تحويل صورة الى نص","ادخال بيانات excel","ادخال بيانات على اكسل","تجميع بيانات","جمع بيانات","تصنيف بيانات يدويا","وسم البيانات","تعليم البيانات","تعبئة نماذج","ملء استمارات","ادخال استبيانات","تفريغ جداول"]},
 { key:"excel_office", phrases:["excel","microsoft excel","ms excel","google sheets","spreadsheet","spreadsheets","excel formatting","excel formulas","excel function","excel functions","excel template","excel spreadsheet","excel workbook","excel file","google sheet","worksheet formatting","conditional formatting","simple excel formulas","basic excel","data formatting","اكسل","اكسيل","جداول البيانات","جداول اكسل","ملف اكسل","ملف excel","تنسيق اكسل","تنسيق اكسيل","معادلات اكسل","معادلات excel","دوال اكسل","دوال excel","تنسيق جدول","تنسيق جداول","تنسيق شيت","جوجل شيتس","جوجل شيت","تنسيق جداول بيانات","عمل جدول اكسل","انشاء جدول اكسل","تعديل ملف اكسل","تعديل ملف excel"]},
 { key:"social_media", phrases:["social media management","social media manager","social media marketing","social media engagement","social engagement","engagement campaign","increase engagement","increase followers","likes and comments","instagram engagement","facebook engagement","tiktok engagement","youtube engagement","followers","likes","comments","shares","post scheduling","community management","manage instagram account","manage facebook page","manage tiktok account","social media posting","content calendar","سوشيال ميديا","وسائل التواصل الاجتماعي","ادارة حسابات التواصل","ادارة صفحات","ادارة صفحة فيسبوك","ادارة انستجرام","زيادة التفاعل","زيادة تفاعل","زيادة المتابعين","زيادة اللايكات","زيادة الاعجابات","لايكات","اعجابات","تعليقات","متابعين","تفاعل على فيسبوك","تفاعل على انستجرام","تفاعل على تيك توك","تفاعل على السوشيال ميديا","نشر بوستات","جدولة منشورات","ادارة محتوى السوشيال","نشر محتوى","تفاعل انستجرام","تفاعل تيك توك","تفاعل يوتيوب","تسويق عبر السوشيال ميديا"]},
 { key:"research_assistant", phrases:["virtual assistant","virtual assistance","va services","administrative assistant","admin support","web research","internet research","online research","internet search","online search","internet data collection","research assistant","email management","calendar management","appointment scheduling","lead generation","lead research","email list building","list building","market research assistant","organize files","file organization","مساعد افتراضي","مساعدة افتراضية","مساعد اداري","بحث على الانترنت","بحث عبر الانترنت","بحث اونلاين","تجميع معلومات","جمع معلومات من الانترنت","بحث وجمع بيانات","البحث عبر الويب","ادارة البريد الالكتروني","تنظيم البريد","تنظيم ملفات","تنظيم مواعيد","جدولة مواعيد","دعم اداري","مساعدة ادارية","توليد عملاء محتملين","تجميع ايميلات","تجميع عناوين بريد"]},
 { key:"ecommerce_listing", phrases:["product listing","product upload","upload products","product catalog entry","product data entry","shopify product listing","shopify product upload","woocommerce product upload","woocommerce product listing","amazon product listing","ecommerce product upload","e-commerce product upload","catalog upload","store product entry","upload products to shopify","inventory listing","ادخال منتجات","رفع منتجات","اضافة منتجات للمتجر","رفع منتجات للمتجر","ادخال منتجات المتجر","رفع المنتجات","اضافة منتجات","ادخال كتالوج","اضافة منتجات شوبيفاي","رفع منتجات شوبيفاي","اضافة منتجات ووكومرس","رفع منتجات ووكومرس","ادخال بيانات المنتجات"]},
 { key:"basic_design", phrases:["canva template","edit canva template","canva thumbnail","thumbnail edit","remove background","background removal","image resizing","resize images","image editing","simple photo editing","thumbnail design","youtube thumbnail","social media post design","instagram post design","simple banner design","presentation template","edit template","photo retouching","كانفا","تصميم كانفا","تعديل قالب","تعديل قوالب","تعديل صور","تعديل صورة","قص الصور","قص صورة","ازالة الخلفية","حذف الخلفية","تغيير مقاس الصور","تغيير حجم الصور","تصميم صورة مصغرة","تصميم ثامبنيل","تصميم غلاف يوتيوب","تصميم منشورات السوشيال","تصميم بوست","تعديل قالب جاهز","تصميم بانر بسيط","تحسين جودة الصور","تعديل مقاسات الصور"]},
 { key:"video_audio", phrases:["video editing","edit video","video editor","short video editing","edit short reels","edit reels","reels editing","youtube shorts","tiktok video editing","cut video","trim video","merge video clips","podcast editing","audio editing","audio cleanup","noise removal audio","remove background noise","مونتاج فيديو","تعديل فيديو","تعديل مقاطع فيديو","قص فيديو","دمج مقاطع فيديو","مونتاج ريلز","مونتاج تيك توك","تعديل فيديو يوتيوب","مونتاج شورتس","تعديل صوت","مونتير محترف","مونتير","مونتير ريلز","مونتير تيك توك","مونتير لمقاطع الريلز","مونتاج مقاطع الريلز","مونتاج مقاطع تيك توك","مونتاج مقاطع قصيرة","مونتاج فيديوهات قصيرة","تحرير فيديوهات قصيرة","مونتاج شورت فيديو","تنقية الصوت","ازالة الضوضاء","تحسين جودة الصوت","تعديل بودكاست","مونتاج بودكاست"]},
 { key:"customer_support", phrases:["customer support","customer service","chat support","email support","answer customer messages","respond to customers","customer care","support agent","live chat agent","order follow up","خدمة عملاء","دعم العملاء","الرد على العملاء","الرد على رسائل العملاء","متابعة العملاء","متابعة الطلبات","خدمة العملاء عبر الشات","خدمة عملاء عن بعد","الرد على الاستفسارات","استقبال مكالمات","متابعة رسائل"]},
 { key:"forms_surveys", phrases:["survey data collection","online survey","survey creation","google form","google forms","microsoft forms","form creation","data collection form","questionnaire formatting","questionnaire creation","استبيان","استبيانات","عمل استبيان","تصميم استبيان","انشاء استبيان","تجميع نتائج الاستبيان","جمع بيانات استبيان","نماذج جوجل","جوجل فورمز","انشاء نموذج","انشاء فورم","تصميم نموذج الكتروني"]},
];

function classifyChannelProject(project) {
  const title = normalizeCategoryText(project?.title || "");
  const description = normalizeCategoryText(project?.description || "");
  const skills = normalizeCategoryText((project?.skills || []).join(" "));
  const all = `${title} ${description} ${skills}`.trim();
  if (!title || !all) return null;

  const titleHas = (phrases) => categoryHasAny(title, phrases);
  const bodyHas = (phrases) => categoryHasAny(`${description} ${skills}`.trim(), phrases);
  const allHas = (phrases) => categoryHasAny(all, phrases);

  // High-risk financial-document replication: do not route requests to recreate
  // realistic bank statements with editable transaction rows or indistinguishable styling.
  // This is deliberately narrower than ordinary PDF/Word/Excel editing.
  const financialDocumentReplication = [
    "bank statement template", "editable bank statement", "recreate bank statement",
    "rebuild bank statement", "replica bank statement", "indistinguishable bank statement",
    "mirror the original statement", "editable transaction rows", "bank statement clone",
    "td bank statement", "bank statement pdf editable", "كشف حساب بنكي قابل للتعديل",
    "انشاء كشف حساب بنكي", "إعادة إنشاء كشف حساب بنكي", "تقليد كشف حساب بنكي",
    "كشف حساب مطابق للاصل", "كشف حساب بنكي قابل للتحرير", "تعديل معاملات كشف الحساب"
  ];
  const financialDocumentContext = allHas(["bank statement", "bank statements", "td bank", "كشف حساب بنكي", "كشف حساب مصرفي"]);
  const replicationIntent = allHas([
    "indistinguishable from the source", "indistinguishable from original", "look exactly like the original",
    "mirror the supplied statement", "every transaction row", "editable transaction rows",
    "recreate the statement", "rebuild the statement", "fully editable statement",
    "مطابق تماما للاصل", "مطابق للنسخة الاصلية", "كل المعاملات قابلة للتعديل", "كشف حساب قابل للتعديل"
  ]);
  if (titleHas(financialDocumentReplication) || (financialDocumentContext && replicationIntent)) {
    console.log(`[category-channel] classifier=reject reason=financial-document-replication title=${String(project?.title || "").slice(0, 100)}`);
    return null;
  }

  // PRINCIPLE: classify the actual deliverable, not any incidental word in the
  // description or the source site's often-wrong category. A title signal wins.
  // If the title describes an unrelated specialist deliverable, secondary words
  // such as voice acting, marketing, writing, or analytics must not pull it in.
  const hardOutOfScopeTitle = [
    // Legal / litigation
    "motion for extension", "motion to extend", "party deposition", "deposition deadline",
    "rules of civil procedure", "court scheduling order", "proposed court order",
    "legal motion", "legal writing", "legal research", "legal article", "legal content", "law firm article", "law firm content", "court filing", "litigation support",
    "مذكرة قانونية", "بحث قانوني", "صياغة قانونية", "مستندات قضائية", "مرافعة قانونية", "مقال قانوني", "كتابة قانونية",
    // Game development
    "roblox developer", "roblox game", "game development", "game developer", "game design",
    "game programmer", "game programming", "game mechanics", "video game", "mobile game",
    "unity developer", "unreal engine", "lua scripting", "تطوير العاب", "تطوير لعبة",
    "تصميم العاب", "برمجة العاب", "لعبة روبلوكس",
    // Animation / full video production (voice is only a subtask)
    "animated film", "animation film", "2d animation", "3d animation", "animated movie",
    "animation production", "cartoon animation", "character animation", "film production",
    "short film production", "full video production", "انتاج فيلم رسوم متحركة", "فيلم انيميشن",
    "تحريك ثنائي الابعاد", "تحريك ثلاثي الابعاد", "انتاج فيلم", "انتاج رسوم متحركة",
    // Other unrelated specialist work
    "website development", "web development", "web developer", "mobile app development",
    "software development", "software engineer", "backend development", "frontend development",
    "machine learning engineer", "ai engineer", "blockchain developer", "smart contract developer",
    "game art", "game asset", "character modeling", "3d artist", "3d animator", "architectural rendering",
    "مطور ذكاء اصطناعي", "تعلم الآلة", "بلوك تشين", "تطوير عقود ذكية", "فنان ثلاثي الابعاد",
    "3d modeling", "3d modelling", "architectural design", "mechanical engineering",
    "تطوير مواقع", "برمجة مواقع", "تطوير تطبيقات", "تطوير برمجيات", "نمذجة ثلاثية الابعاد",
  ];
  // Bulk creation/sale of social accounts is not a normal social-media service.
  // Exclude it rather than accidentally accepting it as account management or engagement.
  const accountAbuseSignals = [
    "create facebook accounts", "create 25 facebook accounts", "bulk facebook accounts",
    "facebook accounts for sale", "buy facebook accounts", "aged facebook accounts",
    "fake facebook accounts", "multiple facebook accounts", "bulk social media accounts",
    "account farming", "mass account creation", "create multiple accounts",
    "انشاء حسابات فيسبوك", "إنشاء حسابات فيسبوك", "حسابات فيسبوك جاهزة",
    "بيع حسابات فيسبوك", "شراء حسابات فيسبوك", "انشاء حسابات متعددة",
    "إنشاء حسابات متعددة", "حسابات فيسبوك فعالة", "حسابات فيسبوك نشطة",
  ];
  // A normal single-account setup can be a legitimate CV/profile service. Do not
  // automatically publish bulk LinkedIn account-creation gigs, including titles
  // that use singular Arabic wording followed by a minimum quantity requirement.
  const linkedinAccountContext = allHas([
    "linkedin account", "linkedin profile", "linkedin accounts", "لينكدان",
    "لينكد ان", "لينكدإن", "حساب لينكد", "حساب على لينكد", "ملف لينكد"
  ]);
  const accountCreationIntent = allHas([
    "create account", "create accounts", "account creation", "set up account",
    "set up accounts", "make accounts", "إنشاء حساب", "انشاء حساب", "إنشاء حسابات",
    "انشاء حسابات", "إعداد حساب", "اعداد حساب", "إنشاء ملف", "انشاء ملف"
  ]) || /\b(?:create|creating|setup|register|open|make)\b.{0,50}\b(?:account|accounts|profile|profiles)\b/.test(all)
     || /(?:انشاء|اعداد|تجهيز|فتح).{0,50}(?:حساب|حسابات|ملف)/.test(all);
  const bulkQuantityIntent = allHas([
    "bulk", "multiple", "several accounts", "many accounts", "mass account",
    "number of accounts", "at least", "minimum number", "minimum of", "accounts per",
    "dozens of accounts", "hundreds of accounts", "بعدد لا يقل", "عدد لا يقل",
    "عدد كبير", "عدد من الحسابات", "حسابات متعددة", "حسابات بالجملة", "بأعداد",
    "عشرات الحسابات", "مئات الحسابات", "عدد حسابات", "حساب لكل", "حسابات لينكد",
    "حسابات لينكدان", "حسابات لينكد ان", "حسابات لينكدإن"
  ]) || /\b\d+\s+(?:linkedin\s+)?(?:accounts|profiles)\b/.test(all)
     || /(?:عدد لا يقل|لا يقل عن|على الاقل|حد ادنى).{0,20}\d+/.test(all)
     || /\b\d+\s+(?:حساب|حسابات|ملف|ملفات)\b/.test(all);
  if (titleHas(hardOutOfScopeTitle) || titleHas(accountAbuseSignals)) return null;
  if (linkedinAccountContext && accountCreationIntent && bulkQuantityIntent) {
    console.log(`[category-channel] classifier=reject reason=bulk-linkedin-account-creation title=${String(project?.title || "").slice(0, 100)}`);
    return null;
  }

  // Very strong data/BI intent. Generic tools (Python, SQL, Excel) do not qualify
  // unless the title or the brief actually asks for analysis/reporting/BI output.
  const strongAnalysisTitle = titleHas(DATA_ANALYSIS_STRONG);
  const explicitAnalysisDeliverable = bodyHas([
    "perform data analysis", "analyze the data", "analyse the data", "analyze sales data",
    "analyse sales data", "build a dashboard", "create a dashboard", "develop a dashboard",
    "create kpi report", "build kpi dashboard", "data visualization", "data visualisation",
    "business intelligence report", "clean and analyze data", "clean and analyse data",
    "تحليل البيانات", "تحليل بيانات", "تحليل المبيعات", "تحليل مالي", "تحليل احصائي",
    "انشاء داشبورد", "تصميم داشبورد", "بناء لوحة معلومات", "لوحة مؤشرات الاداء",
    "استخراج مؤشرات الاداء", "تنظيف وتحليل البيانات", "تصور البيانات"
  ]);
  const analysisContext = allHas(ANALYSIS_CONTEXT);
  const broadDataTool = allHas(BROAD_DATA_TOOLS);
  if (strongAnalysisTitle || (explicitAnalysisDeliverable && (analysisContext || broadDataTool))) {
    return {
      key:"data_analysis", label:CHANNEL_CATEGORY_LABELS.data_analysis,
      reason:strongAnalysisTitle ? "explicit-data-analysis-title" : "explicit-analysis-deliverable-with-context",
      group:"data_analysis"
    };
  }

  // Map title phrases to categories first. This prevents a secondary mention in
  // the description (e.g. voice acting inside an animation job) from winning.
  const titlePriority = [
    "ecommerce_listing", "pdf_documents", "presentations", "cv_resume", "data_entry",
    "excel_office", "transcription_subtitles", "translation", "proofreading",
    "arabic_content", "social_media", "research_assistant", "customer_support",
    "forms_surveys", "basic_design", "video_audio", "voiceover_audio"
  ];
  for (const key of titlePriority) {
    const category = GENERAL_CATEGORIES.find((item) => item.key === key);
    if (category && titleHas(category.phrases)) {
      return {
        key:category.key, label:CHANNEL_CATEGORY_LABELS[category.key],
        reason:`explicit-title:${category.key}`, group:"general_tasks"
      };
    }
  }

  // Description fallback is intentionally stricter: require wording that clearly
  // asks for the service, not just a related skill/word. Skills alone never qualify.
  const directIntent = [
    {key:"ecommerce_listing", phrases:["upload products to", "add products to", "create product listings", "enter product listings", "رفع منتجات للمتجر", "ادخال منتجات المتجر"]},
    {key:"pdf_documents", phrases:["edit this pdf", "edit pdf files", "convert pdf to", "convert files to pdf", "merge pdf files", "split pdf", "compress pdf", "تحويل pdf", "تعديل ملف pdf", "دمج ملفات pdf", "ضغط ملف pdf"]},
    {key:"presentations", phrases:["create a powerpoint", "make a powerpoint", "prepare a presentation", "design a presentation", "create a slide deck", "prepare slides", "اعداد عرض تقديمي", "تصميم عرض تقديمي", "عمل عرض بوربوينت"]},
    {key:"cv_resume", phrases:["write my cv", "create a cv", "write a resume", "design my resume", "prepare a cover letter", "create a linkedin profile", "set up my linkedin profile", "help me set up my linkedin account", "create my linkedin account", "كتابة سيرة ذاتية", "تصميم cv", "اعداد سيرة ذاتية", "إنشاء حساب لينكدإن", "انشاء حساب لينكد ان", "إعداد بروفايل لينكدإن", "تحسين بروفايل لينكدإن"]},
    {key:"data_entry", phrases:["data entry task", "enter data into", "copy data into", "transfer data from", "manual data entry", "ادخال بيانات", "نقل بيانات الى", "نسخ البيانات الى"]},
    {key:"excel_office", phrases:["format an excel spreadsheet", "format excel file", "organize excel data", "create excel formulas", "clean up this spreadsheet", "تنسيق ملف اكسل", "تعديل ملف اكسل", "عمل معادلات اكسل"]},
    {key:"transcription_subtitles", phrases:["transcribe this audio", "transcribe audio files", "transcribe a video", "create subtitles", "add subtitles to", "convert audio to text", "تفريغ صوتي", "تفريغ تسجيل", "اضافة ترجمة للفيديو"]},
    {key:"translation", phrases:["translate this document", "translate documents", "translate from english into", "translate from arabic into", "translate the following text", "ترجمة مستندات", "ترجمة ملف", "ترجمة من الانجليزية الى", "ترجمة من العربية الى"]},
    {key:"proofreading", phrases:["proofread this text", "proofread a document", "check grammar and spelling", "edit and proofread", "تدقيق لغوي", "مراجعة لغوية", "تصحيح املائي"]},
    {key:"arabic_content", phrases:["write arabic content", "write articles in arabic", "write an arabic article", "arabic blog writing", "كتابة محتوى عربي", "كتابة مقال عربي", "كتابة مقالات باللغة العربية"]},
    {key:"social_media", phrases:["manage our social media", "manage instagram and facebook", "manage social media accounts", "create a social media calendar", "schedule social media posts", "increase social media engagement", "ادارة حسابات التواصل", "ادارة صفحات السوشيال ميديا", "جدولة منشورات", "زيادة التفاعل على السوشيال ميديا"]},
    {key:"research_assistant", phrases:["web research task", "research information online", "collect information from websites", "virtual assistant needed", "بحث على الانترنت", "جمع معلومات من المواقع", "مساعد افتراضي"]},
    {key:"customer_support", phrases:["respond to customer messages", "provide customer support", "answer customer inquiries", "customer service agent needed", "الرد على رسائل العملاء", "خدمة عملاء", "الرد على استفسارات العملاء"]},
    {key:"forms_surveys", phrases:["create a google form", "create an online survey", "build a questionnaire", "collect survey responses", "انشاء استبيان", "تصميم نموذج جوجل", "جمع نتائج الاستبيان"]},
    {key:"basic_design", phrases:["remove image background", "edit images for", "resize a batch of images", "edit a canva template", "ازالة خلفية الصور", "تعديل صور", "تعديل قالب كانفا"]},
    {key:"video_audio", phrases:["edit this video", "edit video clips", "edit a podcast", "clean up audio recording", "video editor for reels", "edit reels for tiktok", "short form video editor", "مونتاج فيديو", "تعديل مقاطع فيديو", "مونتاج مقاطع الريلز", "مونتاج مقاطع تيك توك", "مونتاج مقاطع فيديو قصيرة", "مونتير محترف لمقاطع الريلز", "مونتير محترف لمقاطع الريلز بالتيك توك", "مونتير ريلز", "مونتير تيك توك", "تنقية الصوت"]},
    {key:"voiceover_audio", phrases:["record a voiceover", "need a voiceover artist", "record voice narration", "provide voice acting only", "dub this video", "تعليق صوتي فقط", "تسجيل فويس اوفر", "مطلوب معلق صوتي", "دوبلاج فقط"]},
  ];
  for (const intent of directIntent) {
    if (!bodyHas(intent.phrases)) continue;
    const category = GENERAL_CATEGORIES.find((item) => item.key === intent.key);
    if (category) return {
      key:category.key, label:CHANNEL_CATEGORY_LABELS[category.key],
      reason:`explicit-body-intent:${category.key}`, group:"general_tasks"
    };
  }

  // No reliable primary service detected -> do not publish. This conservative
  // default is deliberate: a smaller, relevant channel is better than noise.
  return null;
}
function formatChannelMessage(site, project, category) {
  // The source site's category can be inaccurate (e.g. a social-media project
  // mislabeled as Arabic content). Remove it and show only our content-based
  // classifier's category in the dedicated channel.
  const lines = formatMessage(site, project).split("\n").filter((line) =>
    !/^\s*🗂\s*(?:<b>)?المجال(?:<\/b>)?\s*[:：]/i.test(line)
  );
  // Place the corrected category near the top, immediately after the source line.
  lines.splice(Math.min(2, lines.length), 0, `🗂 <b>المجال:</b> ${esc(category.label)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Cron: fetch new projects -> enqueue once -> send user and channel outboxes
// ---------------------------------------------------------------------
async function run(env) {
  const startedAt = Date.now();
  // Idempotent CREATE IF NOT EXISTS statements also migrate existing D1 databases.
  await env.DB.batch(SCHEMA.map((statement) => env.DB.prepare(statement)));
  const [state, users] = await Promise.all([loadState(env), loadUsers(env)]);
  const stateUpdates = {};
  const pending = [];
  const pendingChannel = [];
  const channelId = String(env.JOBS_CHANNEL_ID || "").trim();
  let processed = 0;

  console.log(`[run] started; activeUsers=${users.length}; sites=${SITES.length}; categoryChannel=${channelId ? "configured" : "not-configured"}`);
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

    // The ID space changed (for example a source switched from site ids to Telegram message ids).
    // Re-baseline instead of waiting forever (stored > newest) or flooding users (stored << newest).
    const jumped = (a, b) => a > b * 1.5 && a - b > 100000;
    if (jumped(lastId, newestId) || jumped(newestId, lastId)) {
      await env.DB.prepare("UPDATE state SET last_id = ?1 WHERE site = ?2").bind(newestId, site.key).run();
      state[site.key] = newestId;
      console.warn(`[${site.key}] id space changed (stored=${lastId}, newest=${newestId}); re-baselined without sending old projects`);
      continue;
    }

    let fresh = items
      .filter((item) => Number(item.id) > lastId)
      .sort((a, b) => Number(a.id) - Number(b.id));
    console.log(`[${site.key}] freshProjects=${fresh.length}`);
    if (!fresh.length) continue;

    // A normal minute brings 0-3 projects. A big burst means something went wrong (outage, id change):
    // send only the newest few instead of dumping the whole backlog on users.
    let burstSkippedUpTo = lastId;
    if (fresh.length > MAX_FRESH_BURST) {
      const skipped = fresh.slice(0, fresh.length - BURST_KEEP_NEWEST);
      burstSkippedUpTo = Number(skipped[skipped.length - 1].id);
      fresh = fresh.slice(-BURST_KEEP_NEWEST);
      console.warn(`[${site.key}] burst of ${skipped.length + fresh.length} new projects; skipping ${skipped.length} older and sending the newest ${fresh.length}`);
    }

    const audience = users.filter((user) => parseSites(user.sites).includes(site.key));
    if (!audience.length && !channelId) {
      // Preserve the old behavior when channel publishing has not been configured.
      stateUpdates[site.key] = newestId;
      console.warn(`[${site.key}] no active subscribers selected this site and no category channel is configured; skipping ${fresh.length} new jobs and advancing to ${newestId}`);
      continue;
    }
    if (!audience.length && channelId) {
      console.log(`[${site.key}] no private subscribers; still checking new projects for the category channel`);
    }

    let lastProcessedId = burstSkippedUpTo;
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
      const messageKey = `${site.key}:${item.id}`;
      if (recipients.length) {
        pending.push({ key: messageKey, text: formatMessage(site, full), chatIds: recipients });
        console.log(`[${site.key}] project=${item.id}; recipients=${recipients.length}; queued=true`);
      } else {
        console.log(`[${site.key}] project=${item.id}; recipients=0; skipped_by_keyword_filter_or_no_subscribers=true`);
      }

      if (channelId) {
        const category = classifyChannelProject(full);
        if (category) {
          pendingChannel.push({
            channelId,
            key: messageKey,
            text: formatChannelMessage(site, full, category),
          });
          console.log(`[category-channel] site=${site.key} project=${item.id} category=${category.key} reason=${category.reason} queued=true`);
        } else {
          console.log(`[category-channel] site=${site.key} project=${item.id} category=none reason=no-confident-primary-service; title=${String(full.title || "").slice(0, 100)}`);
        }
      }
    }
    if (lastProcessedId > lastId) stateUpdates[site.key] = lastProcessedId;
  }

  const recipientCount = pending.reduce((sum, project) => sum + project.chatIds.length, 0);
  console.log(`[run] discovery complete; processed=${processed}; pendingProjects=${pending.length}; pendingRecipients=${recipientCount}; stateUpdates=${Object.keys(stateUpdates).length}`);
  await enqueueAndSave(env, pending, stateUpdates, pendingChannel);
  await flushOutbox(env);
  if (channelId) await flushChannelOutbox(env);
  console.log(`[run] complete in ${Date.now() - startedAt}ms`);
}

async function enqueueAndSave(env, pending, stateUpdates, pendingChannel = []) {
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
  for (const channelMessage of pendingChannel) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO channel_outbox (channel_id, msg_key, text, created_at) VALUES (?1, ?2, ?3, ?4)"
      ).bind(channelMessage.channelId, channelMessage.key, channelMessage.text, now)
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
  console.log(`[db] queuedProjects=${pending.length}; queuedRecipients=${pending.reduce((sum, project) => sum + project.chatIds.length, 0)}; queuedChannelMessages=${pendingChannel.length}; stateUpdates=${Object.keys(stateUpdates).length}`);
}

async function flushChannelOutbox(env) {
  const channelId = String(env.JOBS_CHANNEL_ID || "").trim();
  if (!channelId) return;

  const cutoff = Math.floor(Date.now() / 1000) - 3 * 3600;
  const stale = await env.DB.prepare("DELETE FROM channel_outbox WHERE created_at < ?1").bind(cutoff).run();
  if (Number(stale?.meta?.changes || 0)) console.warn(`[category-channel] removed stale queued messages=${stale.meta.changes}`);

  const { results = [] } = await env.DB.prepare(
    "SELECT id, channel_id, msg_key, text, attempts FROM channel_outbox ORDER BY id LIMIT 10"
  ).all();
  console.log(`[category-channel] rowsToProcess=${results.length}; channel=${channelId}`);
  for (const row of results) {
    try {
      await sendMessage(env, row.channel_id, row.text);
      await env.DB.prepare("DELETE FROM channel_outbox WHERE id = ?1").bind(row.id).run();
      console.log(`[category-channel] sent id=${row.id} key=${row.msg_key}`);
      await sleep(120);
    } catch (error) {
      if (error.status === 400) {
        try {
          await sendMessage(env, row.channel_id, toPlain(row.text), { parse_mode: undefined });
          await env.DB.prepare("DELETE FROM channel_outbox WHERE id = ?1").bind(row.id).run();
          console.log(`[category-channel] sent plain-text fallback id=${row.id} key=${row.msg_key}`);
          await sleep(120);
          continue;
        } catch (fallbackError) {
          error = fallbackError;
        }
      }
      await env.DB.prepare("UPDATE channel_outbox SET attempts = attempts + 1 WHERE id = ?1").bind(row.id).run();
      console.error(`[category-channel] send failed id=${row.id} key=${row.msg_key} attempt=${Number(row.attempts || 0) + 1} status=${error.status ?? "unknown"}: ${String(error)}`);
      // Keep this row queued for retry; entries older than 3 hours are pruned above.
      break;
    }
  }
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
  // A notice that could not be delivered for 3 hours is stale: drop it instead of retrying forever.
  statements.push(
    env.DB.prepare("DELETE FROM outbox WHERE msg_key IN (SELECT key FROM messages WHERE created_at < ?1)")
      .bind(Math.floor(Date.now() / 1000) - 3 * 3600)
  );
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
  const build = (descriptionLimit) => {
    const title = truncate(project.title || `مشروع جديد #${project.id}`, 300);
    const lines = [`🆕 <b>${esc(title)}</b>`, `🌐 ${esc(site.name)}`];
    // Khamsat: show a budget only when the source actually provides a numeric amount.
    // If the budget is missing, blocked, or only says "unknown / negotiable", omit the line entirely.
    const budgetText = String(project.budget ?? "").trim();
    const hasKhamsatBudget = /[0-9٠-٩۰-۹]/u.test(budgetText);
    if (site.key === "khamsat" ? hasKhamsatBudget : Boolean(budgetText)) {
      lines.push(`💰 ${esc(budgetText)}`);
    }
    for (const item of project.extra || []) lines.push(`📌 ${esc(item)}`);
    if (project.skills?.length) lines.push(`🏷 ${esc(project.skills.join("، "))}`);
    if (project.description && descriptionLimit > 0) {
      lines.push("", esc(truncate(project.description, descriptionLimit)));
    }
    lines.push("", `🔗 <a href="${esc(safeUrl(project.url))}">فتح المشروع</a>`);
    return lines.join("\n");
  };

  // Telegram allows 4096 characters AFTER entities are parsed, and escaping (&amp; &lt; ...)
  // makes the text longer than the raw description. Shrink until the final text fits.
  let limit = MAX_DESCRIPTION;
  let text = build(limit);
  while (text.length > 3990 && limit > 0) {
    limit = limit > 300 ? Math.floor(limit * 0.85) : 0;
    text = build(limit);
  }
  return text;
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

function parsedIdInHtml(html, id) {
  return Boolean(id) && String(html).includes(String(id));
}

// Which <script> blocks carry the project data? Helps decide how to extract it.
function scriptSummaries(html, title) {
  const wanted = cleanText(title || "").slice(0, 40);
  const out = [];
  for (const match of String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const body = (match[2] || "").trim();
    if (!body || /\bsrc=/i.test(match[1] || "")) continue;
    const hasTitle = Boolean(wanted) && body.includes(wanted);
    if (!hasTitle && out.length >= 3) continue;
    out.push({ attrs: (match[1] || "").trim().slice(0, 80), length: body.length, containsTitle: hasTitle, head: body.slice(0, 200) });
    if (out.length >= 8) break;
  }
  return out;
}

const PROBE_HOSTS = ["khamsat.com", "nafezly.com", "mostaql.com", "kafiil.com", "t.me"];

async function probePage(rawUrl) {
  const target = new URL(String(rawUrl || ""));
  if (!["https:", "http:"].includes(target.protocol) || !PROBE_HOSTS.some((host) => target.hostname === host || target.hostname.endsWith(`.${host}`))) {
    throw new Error(`probe is limited to: ${PROBE_HOSTS.join(", ")}`);
  }
  const response = await fetch(target.href, { headers: HEADERS, redirect: "follow" });
  const html = await response.text();
  if (target.hostname === "t.me") {
    const posts = extractTelegramPosts(html);
    const items = buildKhamsatItems(posts);
    return {
      status: response.status,
      postCount: posts.length,
      parsedRequests: items.length,
      mode: items[0]?.debug?.mode || "none",
      newestIds: items.slice(-5).map((item) => item.id),
      // Raw text of the last posts (as the bot sees it) next to what the parser extracted from them.
      samples: posts.slice(-3).map((post) => ({
        messageId: post.messageId,
        links: post.links.slice(0, 8),
        rawText: post.text.slice(0, 1200),
        parsed: parseRequestPost(post.text),
      })),
    };
  }
  const text = htmlToText(html);
  const siteKey = /khamsat/.test(target.hostname) ? "khamsat" : /nafezly/.test(target.hostname) ? "nafezly" : /mostaql/.test(target.hostname) ? "mostaql" : "kafiil";
  const idMatch = target.pathname.match(/(\d+)/);
  const parsed = parseHtmlProject(siteKey, html, { id: idMatch ? Number(idMatch[1]) : 0, url: target.href });
  return {
    status: response.status,
    finalUrl: response.url,
    htmlLength: html.length,
    cfMitigated: response.headers.get("cf-mitigated"),
    looksLikeChallenge: looksLikeChallenge(html, response),
    htmlHead: html.slice(0, 300),
    containsProjectId: parsedIdInHtml(html, idMatch ? idMatch[1] : ""),
    scripts: scriptSummaries(html, parsed.title),
    visibleTextHead: text.slice(0, 1500),
    parsed: { ...parsed, description: truncate(parsed.description || "", 800) },
  };
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

function normalizeDescription(value, title, minLength = 25) {
  let result = cleanText(value);
  if (!isUsefulDescription(result, title, minLength)) return "";
  // Remove common adjacent labels at the beginning/end of scraped content.
  result = result.replace(/^(?:تفاصيل المشروع|تفاصيل الطلب|وصف المشروع|الوصف)\s*[:：-]?\s*/i, "");
  result = result.replace(/\s+(?:حالة المشروع|عدد العروض|آخر تفاعل)\s*:?\s*[\s\S]*$/i, "").trim();
  return isUsefulDescription(result, title, minLength) ? result.slice(0, 6000) : "";
}

function isUsefulDescription(value, title, minLength = 25) {
  const text = cleanText(value);
  if (text.length < minLength) return false;
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
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th|\/dt|\/dd|\/section|\/article|\/blockquote)\b[^>]*>/gi, "\n")
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
    .replace(/&mdash;/g, "—")
    .replace(/&hellip;/g, "…")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&bull;/g, "•")
    .replace(/&middot;/g, "·")
    .replace(/&zwj;/gi, "\u200d")
    .replace(/&zwnj;/gi, "\u200c")
    // Invisible direction marks (&rlm; &lrm; and their characters) only add noise to the message.
    .replace(/&(?:rlm|lrm);/gi, "")
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
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

    // /?key=ADMIN_KEY&probe=<page url> : shows exactly what the Worker receives from a page
    // (status, challenge detection, visible text and what the parser extracts from it).
    if (url.searchParams.has("probe")) {
      try {
        return Response.json(await probePage(url.searchParams.get("probe")));
      } catch (error) {
        return new Response(String(error), { status: 400 });
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

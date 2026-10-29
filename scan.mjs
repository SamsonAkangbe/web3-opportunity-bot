// Web3 Opportunity Bot (single file). Runs hourly via GitHub Actions and sends alerts to ntfy.
// Collectors: each returns an array of
// { category, title, url, source, date (ms), extra }
// category "lead" = unclassified; rank.js sorts it into the right bucket.
// Everything works with no API key. X_BEARER_TOKEN is optional (paid X API).

const UA = { "User-Agent": "Mozilla/5.0 (compatible; web3-opportunity-bot/1.0)" };
const errs = [];

async function getText(url, headers = {}, timeoutMs = 20000) {
  const res = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

async function getJson(url, headers = {}) {
  return JSON.parse(await getText(url, { Accept: "application/json", ...headers }));
}

// ---- minimal RSS/Atom parser (no dependencies) ----
const entities = (s) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");

// Decodes twice because some feeds double-encode (e.g. "&amp;nbsp;"), with tags stripped in between.
function decode(s = "") {
  const raw = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return entities(entities(raw).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

function parseFeed(xml, category, source) {
  const items = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi) || [];
  return items.map((it) => {
    let link = tag(it, "link");
    if (!link) {
      const m = it.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1].replace(/&amp;/g, "&") : "";
    }
    const dateStr = tag(it, "pubDate") || tag(it, "published") || tag(it, "updated");
    const parsed = dateStr ? Date.parse(dateStr) : NaN;
    const title = tag(it, "title") || tag(it, "description").slice(0, 140);
    let extra = tag(it, "description").slice(0, 160);
    // Many feeds (e.g. Google News) just repeat the headline as the description: drop the repeat.
    const letters = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40);
    if (!extra || letters(extra) === letters(title)) extra = "";
    return {
      category,
      title,
      url: link,
      source,
      date: Number.isFinite(parsed) ? parsed : Date.now(),
      extra,
    };
  });
}

// Fetch one feed; a failure is recorded (so you can see it in the run log) but never stops the scan.
async function feed(url, category, source) {
  try {
    return parseFeed(await getText(url), category, source);
  } catch (e) {
    errs.push(`${source}: ${e.message}`);
    return [];
  }
}

const many = async (list) => (await Promise.all(list.map((f) => feed(...f)))).flat();

// ---- Airdrops & free money ----
const airdrops = () =>
  many([
    ["https://airdrops.io/feed/", "airdrop", "Airdrops.io"],
    ["https://airdropalert.com/feed/", "airdrop", "AirdropAlert"],
  ]);

// ---- Funding rounds (projects that just raised = likely future airdrops / jobs) ----
async function fundingRounds() {
  try {
    const data = await getJson("https://api.llama.fi/raises");
    return (data.raises || [])
      .filter((r) => r.date)
      .sort((a, b) => b.date - a.date)
      .slice(0, 60)
      .map((r) => ({
        category: "funding",
        title: `${r.name} raised ${r.amount ? "$" + r.amount + "M" : "a round"}${r.round ? " (" + r.round + ")" : ""}`,
        url: r.source || "https://defillama.com/raises",
        source: "DefiLlama",
        date: r.date * 1000,
        extra: [r.category, (r.leadInvestors || []).slice(0, 3).join(", ")].filter(Boolean).join(" | "),
      }));
  } catch (e) {
    errs.push(`DefiLlama: ${e.message}`);
    return [];
  }
}

// ---- NFT news, mints ----
const nftNews = () =>
  many([
    ["https://nftnow.com/feed/", "nft", "NFT Now"],
    ["https://nftevening.com/feed/", "nft", "NFT Evening"],
    ["https://www.nftculture.com/feed/", "nft", "NFT Culture"],
  ]);

// ---- Trending (no timestamps, included once a day) ----
async function trending() {
  try {
    const data = await getJson("https://api.coingecko.com/api/v3/search/trending");
    const coins = (data.coins || []).slice(0, 7).map((c) => ({
      category: "trending",
      title: `Trending coin: ${c.item.name} (${c.item.symbol})`,
      url: `https://www.coingecko.com/en/coins/${c.item.id}`,
      source: "CoinGecko",
      date: Date.now(),
      extra: c.item.market_cap_rank ? `Rank #${c.item.market_cap_rank}` : "Unranked, early",
    }));
    const nfts = (data.nfts || []).slice(0, 5).map((n) => ({
      category: "trending",
      title: `Trending NFT collection: ${n.name}`,
      url: `https://www.coingecko.com/en/nft/${n.id}`,
      source: "CoinGecko",
      date: Date.now(),
      extra: n.floor_price_24h_percentage_change ? `Floor 24h: ${n.floor_price_24h_percentage_change.toFixed(1)}%` : "",
    }));
    return [...coins, ...nfts];
  } catch (e) {
    errs.push(`CoinGecko: ${e.message}`);
    return [];
  }
}

// ---- Jobs, bounties, grants ----
const jobsAndBounties = () =>
  many([
    ["https://web3.career/web3-jobs.rss", "job", "Web3.career"],
    ["https://cryptocurrencyjobs.co/index.xml", "job", "CryptoJobs"],
    ["https://earn.superteam.fun/feed.xml", "bounty", "Superteam Earn"],
  ]);

// ---- Market and ecosystem news ----
const news = () =>
  many([
    ["https://cointelegraph.com/rss", "news", "Cointelegraph"],
    ["https://decrypt.co/feed", "news", "Decrypt"],
    ["https://thedefiant.io/api/feed", "news", "The Defiant"],
  ]);

// ---- Google News searches: catches opportunities reported anywhere on the web ----
const GOOGLE_QUERIES = [
  "crypto airdrop", "retroactive airdrop", "airdrop confirmed snapshot", "testnet incentivized airdrop",
  "NFT whitelist", "NFT free mint", "NFT giveaway", "submit wallet address airdrop", "wallet whitelist giveaway crypto",
  "crypto giveaway", "web3 grant program", "crypto hackathon prize", "web3 ambassador program",
  "crypto quest campaign rewards", "token launch waitlist", "crypto bounty program", "points program airdrop",
];
const googleNews = () =>
  many(
    GOOGLE_QUERIES.map((q) => [
      `https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:2h")}&hl=en-US&gl=US&ceid=US:en`,
      "lead",
      "Google News",
    ]),
  );

// ---- Reddit (best effort; Reddit sometimes blocks cloud IPs) ----
const SUBREDDITS = ["airdrops", "CryptoAirdrops", "NFTsMarketplace", "NFT", "CryptoMoonShots", "ethdev", "solana", "defi"];
const reddit = () => many(SUBREDDITS.map((s) => [`https://www.reddit.com/r/${s}/new/.rss`, "lead", `r/${s}`]));

// ---- X (Twitter) ----
// Where wallet-submission posts, WL giveaways and "drop your address" threads actually live.
const X_QUERIES = [
  '"submit your wallet"', '"drop your wallet"', '"drop your address"', '"wallet address" giveaway',
  "whitelist giveaway", '"WL spots"', '"free mint"', "airdrop wallet", "retroactive airdrop", '"comment your wallet"',
  "USDT giveaway", "USDC giveaway", '"token giveaway"', '"drop your SOL address"', '"drop your ETH address"',
  '"reply with your wallet"', '"retweet to win" USDT', '"airdrop" "like and retweet"', '"claim your airdrop"',
  '"wallet submission"', ...(process.env.X_EXTRA_QUERIES || "").split("|").map((s) => s.trim()).filter(Boolean),
];

function toXUrl(link) {
  try {
    const u = new URL(link);
    return `https://x.com${u.pathname}`;
  } catch {
    return link;
  }
}

// Free route: Nitter RSS mirrors. Unreliable by nature (instances come and go), so several are tried.
async function xViaNitter() {
  const instances = (process.env.NITTER_INSTANCES || "https://nitter.net,https://nitter.privacydev.net,https://nitter.poast.org")
    .split(",").map((s) => s.trim()).filter(Boolean);
  // All queries run in parallel; each tries the mirrors in order with a short timeout.
  const perQuery = await Promise.all(
    X_QUERIES.map(async (q) => {
      for (const inst of instances) {
        try {
          const xml = await getText(`${inst}/search/rss?f=tweets&q=${encodeURIComponent(q)}`, {}, 8000);
          return parseFeed(xml, "lead", "X").map((i) => ({ ...i, url: toXUrl(i.url) }));
        } catch {
          /* try next instance */
        }
      }
      return null;
    }),
  );
  if (perQuery.every((r) => r === null)) errs.push("X (Nitter): no free mirror reachable right now");
  return perQuery.flat().filter(Boolean);
}

// Official route: needs a paid X API plan (set X_BEARER_TOKEN). Most reliable.
async function xViaApi() {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return [];
  // X limits query length, so the query list is split into several requests of under ~400 characters.
  const batches = [];
  let cur = [];
  for (const q of X_QUERIES) {
    if ([...cur, q].join(" OR ").length > 400) {
      batches.push(cur);
      cur = [];
    }
    cur.push(q);
  }
  if (cur.length) batches.push(cur);

  const start = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const out = [];
  for (const b of batches) {
    try {
      const q = `(${b.join(" OR ")}) -is:retweet lang:en`;
      const url =
        `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(q)}&max_results=100` +
        `&start_time=${start}&tweet.fields=created_at&expansions=author_id&user.fields=username`;
      const data = await getJson(url, { Authorization: `Bearer ${token}` });
      const users = Object.fromEntries((data.includes?.users || []).map((u) => [u.id, u.username]));
      for (const t of data.data || []) {
        out.push({
          category: "lead",
          title: t.text.replace(/\s+/g, " ").slice(0, 220),
          url: `https://x.com/${users[t.author_id] || "i"}/status/${t.id}`,
          source: "X",
          date: Date.parse(t.created_at),
          extra: "",
        });
      }
    } catch (e) {
      errs.push(`X API: ${e.message}`);
    }
  }
  return out;
}

const x = async () => [...(await xViaApi()), ...(await xViaNitter())];

// ---- Anything else you want: EXTRA_FEEDS="https://site1/feed,https://site2/rss" ----
const extraFeeds = () =>
  many((process.env.EXTRA_FEEDS || "").split(",").map((s) => s.trim()).filter(Boolean).map((u) => [u, "lead", new URL(u).hostname]));

// X only (used by the dedicated X scanner workflow).
async function collectX() {
  errs.length = 0;
  const items = await x();
  return { items, errors: [...errs] };
}

async function collectAll() {
  errs.length = 0;
  const jobs = { airdrops, fundingRounds, nftNews, trending, jobsAndBounties, news, googleNews, reddit, x, extraFeeds };
  const names = Object.keys(jobs);
  const results = await Promise.allSettled(names.map((n) => jobs[n]()));
  const items = [];
  const errors = [...errs];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") items.push(...r.value);
    else errors.push(`${names[i]}: ${r.reason?.message || r.reason}`);
  });
  return { items, errors };
}
// Classify, filter to fresh items, score, and group. Nothing relevant is capped or dropped.

const SUBMIT_RE =
  /(submit|drop|comment|reply|share|send|enter|post|leave|fill)\b[^.\n]{0,30}\b(wallet|address|0x\w*|\.eth|\.sol)|wallet (submission|collection|drop|list)|collecting wallets|\bwl\b|whitelist|allowlist|guaranteed (mint|spot|wl|allocation)|giveaway|waitlist|early access|\bog role|snapshot|(retweet|\brt\b) to win|\bwin\b[^.\n]{0,20}(usdt|usdc|\$\d)|(usdt|usdc)[^.\n]{0,25}(giveaway|airdrop|winners?)/i;
const AIRDROP_RE = /airdrop|retroactive|claim|token (launch|generation)|\btge\b|points program|season \d/i;
const NFT_RE = /\bmint|nft|collection|pfp/i;
const BOUNTY_RE = /grant|bounty|hackathon|ambassador|quest|campaign|reward|prize|testnet|incentiv/i;
const JOB_RE = /hiring|job|vacanc|role:|remote/i;

const BOOST = [
  [/airdrop|retroactive|claim/i, 5],
  [SUBMIT_RE, 5],
  [/mint|whitelist|allowlist|\bwl\b|free mint/i, 4],
  [/testnet|points|season|quest|incentiv/i, 4],
  [/grant|bounty|hackathon|ambassador/i, 4],
  [/raised|seed|series [ab]|funding/i, 3],
  [/hiring|remote|intern|junior|community (manager|mod)/i, 2],
  [/launch|mainnet|listing|ido|ico|presale/i, 2],
];

const CATEGORY_BASE = { submit: 6, airdrop: 5, bounty: 5, nft: 3, funding: 3, job: 2, trending: 2, news: 1 };

const CATEGORY_LABEL = {
  submit: "📝 Submit wallet / WL / giveaways",
  airdrop: "🪂 Airdrops",
  bounty: "💰 Bounties, grants & quests",
  nft: "🖼 NFT",
  funding: "🏦 Fresh funding (watch for airdrops)",
  job: "💼 Web3 jobs",
  trending: "🔥 Trending now",
  news: "📰 News",
};

const ORDER = ["submit", "airdrop", "bounty", "nft", "funding", "job", "trending", "news"];

// Put unclassified ("lead") items and wallet-submission posts into the right bucket.
function classify(item) {
  const text = `${item.title} ${item.extra || ""}`;
  if (item.category === "lead") {
    if (SUBMIT_RE.test(text)) return "submit";
    if (AIRDROP_RE.test(text)) return "airdrop";
    if (BOUNTY_RE.test(text)) return "bounty";
    if (JOB_RE.test(text)) return "job";
    if (NFT_RE.test(text) && /mint|giveaway|free/i.test(text)) return "nft";
    return "news";
  }
  if (["news", "nft"].includes(item.category) && SUBMIT_RE.test(text)) return "submit";
  return item.category;
}

function score(item) {
  let s = CATEGORY_BASE[item.category] ?? 1;
  const text = `${item.title} ${item.extra || ""}`;
  for (const [re, pts] of BOOST) if (re.test(text)) s += pts;
  return s;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 90);

function pick(items, { windowMinutes = 65, now = Date.now(), includeTrending = false } = {}) {
  const cutoff = now - windowMinutes * 60 * 1000;
  const seenUrl = new Set();
  const seenTitle = new Set();
  const fresh = [];
  for (const raw of items) {
    if (!raw.title || !raw.url) continue;
    const i = { ...raw, category: classify(raw) };
    if (i.category === "trending") {
      if (!includeTrending) continue;
    } else if (!Number.isFinite(i.date) || i.date < cutoff) continue;
    const t = norm(i.title);
    if (seenUrl.has(i.url) || seenTitle.has(t)) continue;
    seenUrl.add(i.url);
    seenTitle.add(t);
    fresh.push({ ...i, score: score(i) });
  }

  // Plain market news (price moves etc.) only shows up if it matches an opportunity keyword.
  const kept = fresh.filter((i) => i.category !== "news" || i.score > CATEGORY_BASE.news);

  const groups = {};
  for (const i of kept.sort((a, b) => b.score - a.score)) (groups[i.category] ||= []).push(i);
  return groups;
}

// First `maxIndividual` opportunities get their own tappable notification.
// Everything beyond that is bundled into digest notifications, so nothing is dropped.
function buildNotifications(groups, maxIndividual = 25) {
  const flat = [];
  for (const cat of ORDER) for (const i of groups[cat] || []) flat.push({ cat, ...i });

  const out = flat.slice(0, maxIndividual).map((i) => ({
    title: `${CATEGORY_LABEL[i.cat]} · ${i.source}`,
    message: [i.title, i.extra].filter(Boolean).join("\n").slice(0, 400),
    click: i.url,
  }));

  const rest = flat.slice(maxIndividual);
  if (rest.length) {
    let chunk = [];
    let len = 0;
    const flush = () => {
      if (!chunk.length) return;
      out.push({ title: `➕ More opportunities (${chunk.length})`, message: chunk.join("\n\n") });
      chunk = [];
      len = 0;
    };
    for (const i of rest) {
      const line = `${CATEGORY_LABEL[i.cat].split(" ")[0]} ${i.title.slice(0, 120)}\n${i.url}`;
      if (len + line.length > 3500) flush();
      chunk.push(line);
      len += line.length + 2;
    }
    flush();
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendNtfy(topic, notifications) {
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  for (const n of notifications) {
    const res = await fetch(server, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, ...n, tags: ["rocket"] }),
    });
    if (!res.ok) throw new Error(`ntfy error ${res.status}: ${await res.text()}`);
    await sleep(400);
  }
}
// ---- main ----
async function runScan({ dryRun = false } = {}) {
  const topic = process.env.NTFY_TOPIC;
  if (!dryRun && !topic) throw new Error("Missing NTFY_TOPIC secret");
  const windowMinutes = Number(process.env.WINDOW_MINUTES || 65);
  const now = new Date();
  // Trending lists have no timestamps, so include them once a day (06:00 UTC).
  const includeTrending = process.env.FORCE_TRENDING === "1" || now.getUTCHours() === 6;

  const { items, errors } = await collectAll();
  // If every source failed, fail loudly so the GitHub run shows red (and GitHub emails you).
  if (!items.length) throw new Error(`All sources failed: ${errors.join("; ")}`);
  const groups = pick(items, { windowMinutes, now: now.getTime(), includeTrending });
  const notes = buildNotifications(groups);
  if (!dryRun && notes.length) await sendNtfy(topic, notes);
  return {
    collected: items.length,
    picked: Object.values(groups).reduce((n, g) => n + g.length, 0),
    sent: dryRun ? 0 : notes.length,
    failedSources: errors,
    preview: dryRun ? notes : undefined,
  };
}

const result = await runScan({ dryRun: process.env.DRY_RUN === "1" });
console.log(JSON.stringify(result, null, 2));
    

// Leedly AI Visibility Scanner - Supabase Edge Function
// POST https://ywhhzhhbfzkcknljlwow.supabase.co/functions/v1/submit-scan
//
// Edge Function Secrets required (Supabase dashboard - Edge Functions - Secrets):
//   DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
// Optional: GHL_API_KEY, GHL_LOCATION_ID
// Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Scoring model (both scores 0-100, full range reachable):
//   AI Visibility = LLM mentions (0-40) + brand SERP (0-25) + backlinks (0-15) + domain rank (0-20)
//   Agent Readiness = on-site checks: HTTPS, JSON-LD schema, robots.txt AI-crawler access,
//                     llms.txt, sitemap.xml, title/meta/H1/OpenGraph (0-100)
// Cost controls: scan_cache reuses API findings per domain for 7 days; rate_limits caps
// per-IP and per-domain scan frequency. LLM Mentions costs ~$0.10/call, so cache matters.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CACHE_TTL_DAYS = 7;
const RATE_LIMITS = {
  ip_per_hour: 5,
  ip_per_day: 20,
  domain_per_day: 3,
};

const AI_CRAWLERS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: "follow" });
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const { website_url, name, email, phone, business_type,
      city_or_service_area, competitor_url, monthly_marketing_budget,
      main_goal, consent_given } = body;

    if (!website_url) return json(400, { error: "website_url is required" });

    const normalized_domain = website_url
      .replace(/^https?:\/\//, "").replace(/^www\./, "")
      .split("/")[0].toLowerCase().trim();

    if (!/^[a-z0-9][a-z0-9.-]{2,250}\.[a-z]{2,24}$/.test(normalized_domain)) {
      return json(400, { error: "That doesn't look like a valid website address." });
    }

    const clientIp = (req.headers.get("x-forwarded-for") || "unknown")
      .split(",")[0].trim();

    const authHeader = "Basic " + btoa(
      Deno.env.get("DATAFORSEO_LOGIN") + ":" + Deno.env.get("DATAFORSEO_PASSWORD")
    );
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const sbHeaders = {
      "apikey": SUPABASE_SERVICE_KEY!,
      "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
      "Content-Type": "application/json",
    };

    async function sbInsert(table: string, data: unknown) {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: "POST",
        headers: { ...sbHeaders, "Prefer": "return=representation" },
        body: JSON.stringify(data)
      });
      if (!resp.ok) throw new Error("DB insert failed: " + await resp.text());
      const rows = await resp.json();
      return Array.isArray(rows) ? rows[0] : rows;
    }

    async function sbUpdate(table: string, id: string, data: unknown) {
      await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: "PATCH", headers: sbHeaders, body: JSON.stringify(data)
      });
    }

    async function sbSelect(path: string) {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
      if (!resp.ok) return null;
      return await resp.json();
    }

    // --- Rate limiting (fail open: a rate-limit outage must not kill scans) ---
    try {
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      const dayAgo = new Date(Date.now() - 86400_000).toISOString();
      const [ipHour, ipDay, domDay] = await Promise.all([
        sbSelect(`rate_limits?identifier=eq.${encodeURIComponent(clientIp)}&kind=eq.ip&created_at=gte.${hourAgo}&select=id`),
        sbSelect(`rate_limits?identifier=eq.${encodeURIComponent(clientIp)}&kind=eq.ip&created_at=gte.${dayAgo}&select=id`),
        sbSelect(`rate_limits?identifier=eq.${encodeURIComponent(normalized_domain)}&kind=eq.domain&created_at=gte.${dayAgo}&select=id`),
      ]);
      if ((ipHour?.length ?? 0) >= RATE_LIMITS.ip_per_hour ||
          (ipDay?.length ?? 0) >= RATE_LIMITS.ip_per_day) {
        return json(429, { error: "Too many scans from this connection. Try again in an hour." });
      }
      if ((domDay?.length ?? 0) >= RATE_LIMITS.domain_per_day) {
        return json(429, { error: "This domain was already scanned several times today. Try again tomorrow." });
      }
      await Promise.all([
        sbInsert("rate_limits", { identifier: clientIp, kind: "ip" }),
        sbInsert("rate_limits", { identifier: normalized_domain, kind: "domain" }),
      ]);
    } catch (e) {
      console.error("Rate limit check skipped:", (e as Error).message);
    }

    const scanReq = await sbInsert("scan_requests", {
      website_url, normalized_domain,
      name: name || null, email: email || null, phone: phone || null,
      business_type: business_type || null,
      city_or_service_area: city_or_service_area || null,
      competitor_url: competitor_url || null,
      monthly_marketing_budget: monthly_marketing_budget || null,
      main_goal: main_goal || null,
      consent_given: consent_given === true,
      scan_tier: "free", status: "processing"
    });

    async function logApi(endpoint: string, task: any, cost: number) {
      try {
        await sbInsert("api_usage_logs", {
          scan_request_id: scanReq.id, provider: "dataforseo", endpoint,
          task_id: task?.id || null, estimated_cost: cost,
          status: task?.status_code === 20000 ? "success" : "error",
          raw_response_summary: task?.status_message || null
        });
      } catch (e) { console.error("api log:", (e as Error).message); }
    }

    // --- Check cache: skip paid API calls for recently scanned domains ---
    let apiFindings: any = null;
    let cacheHit = false;
    try {
      const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 86400_000).toISOString();
      const cached = await sbSelect(
        `scan_cache?normalized_domain=eq.${encodeURIComponent(normalized_domain)}&created_at=gte.${cutoff}&select=payload&order=created_at.desc&limit=1`);
      if (cached?.[0]?.payload) { apiFindings = cached[0].payload; cacheHit = true; }
    } catch (e) { console.error("cache read:", (e as Error).message); }

    // --- Paid signals (DataForSEO) - only on cache miss ---
    if (!apiFindings) {
      apiFindings = { serp: {}, backlinks: {}, llm: {} };

      // 1. Brand SERP: does the domain rank for its own name?
      try {
        const serpData = await (await fetchWithTimeout(
          "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
          { method: "POST", headers: { Authorization: authHeader, "Content-Type": "application/json" },
            body: JSON.stringify([{ keyword: normalized_domain.replace(/\.[a-z]{2,24}$/, ""), location_code: 2840, language_code: "en", depth: 10 }]) },
          25000
        )).json();
        const task = serpData?.tasks?.[0];
        const items = task?.result?.[0]?.items ?? [];
        const hit = items.find((i: any) => (i?.domain || "").replace(/^www\./, "") === normalized_domain);
        apiFindings.serp = {
          items_count: items.length,
          domain_in_serp: !!hit,
          serp_position: hit?.rank_absolute ?? null,
          measured: task?.status_code === 20000
        };
        await logApi("serp/google/organic/live/advanced", task, 0.0015);
      } catch (e) { console.error("SERP:", (e as Error).message); }

      // 2. Backlinks + domain rank
      try {
        const blData = await (await fetchWithTimeout(
          "https://api.dataforseo.com/v3/backlinks/summary/live",
          { method: "POST", headers: { Authorization: authHeader, "Content-Type": "application/json" },
            body: JSON.stringify([{ target: normalized_domain }]) },
          25000
        )).json();
        const task = blData?.tasks?.[0];
        const r = task?.result?.[0] ?? {};
        apiFindings.backlinks = task?.status_code === 20000 ? {
          domain_rank: r.rank ?? 0,
          backlinks: r.backlinks ?? 0,
          referring_domains: r.referring_domains ?? null,
          measured: true
        } : { domain_rank: null, backlinks: null, referring_domains: null, measured: false };
        await logApi("backlinks/summary/live", task, 0.0025);
      } catch (e) { console.error("Backlinks:", (e as Error).message); }

      // 3. LLM mentions: is this domain actually cited by ChatGPT?
      // ~$0.10/call - the single most expensive signal, which is why cache TTL is 7 days.
      try {
        const llmData = await (await fetchWithTimeout(
          "https://api.dataforseo.com/v3/ai_optimization/llm_mentions/aggregated_metrics/live",
          { method: "POST", headers: { Authorization: authHeader, "Content-Type": "application/json" },
            body: JSON.stringify([{ target: [{ domain: normalized_domain }], platform: "chat_gpt", language_code: "en" }]) },
          30000
        )).json();
        const task = llmData?.tasks?.[0];
        const total = task?.result?.[0]?.total ?? {};
        const platforms = Array.isArray(total.platform) ? total.platform : [];
        const mentions = platforms.reduce((s: number, p: any) => s + (p?.mentions ?? 0), 0);
        const aiVolume = platforms.reduce((s: number, p: any) => s + (p?.ai_search_volume ?? 0), 0);
        apiFindings.llm = task?.status_code === 20000
          ? { chatgpt_mentions: mentions, ai_search_volume: aiVolume, measured: true }
          : { chatgpt_mentions: null, ai_search_volume: null, measured: false };
        await logApi("ai_optimization/llm_mentions/aggregated_metrics/live", task, 0.101);
      } catch (e) { console.error("LLM mentions:", (e as Error).message); }

      try {
        await sbInsert("scan_cache", { normalized_domain, payload: apiFindings });
      } catch (e) { console.error("cache write:", (e as Error).message); }
    }

    // --- Free signals: fetch the actual site (agent readiness) ---
    const site: any = {
      https_ok: false, title: false, meta_description: false, h1: false,
      open_graph: false, json_ld: false, json_ld_types: [] as string[],
      robots_txt: false, ai_crawlers_allowed: [] as string[], ai_crawlers_blocked: [] as string[],
      llms_txt: false, sitemap_xml: false,
      // Did we actually get a usable answer for each group? A blocked/failed fetch
      // must not be scored as "everything is missing" — those groups drop out of
      // the denominator instead (see Agent Readiness scoring below).
      home_measured: false, home_reachable: false,
      robots_measured: false, llms_measured: false, sitemap_measured: false
    };
    const origin = `https://${normalized_domain}`;
    // Mainstream browser UA + Accept: many WAFs (Cloudflare, Akamai) challenge or
    // block unknown agents, which would otherwise make a well-built site read as empty.
    const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
    const siteHeaders = {
      "User-Agent": BROWSER_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    };

    const [homeRes, robotsRes, llmsRes, sitemapRes] = await Promise.allSettled([
      fetchWithTimeout(origin, { headers: siteHeaders }),
      fetchWithTimeout(`${origin}/robots.txt`, { headers: siteHeaders }),
      fetchWithTimeout(`${origin}/llms.txt`, { headers: siteHeaders }),
      fetchWithTimeout(`${origin}/sitemap.xml`, { method: "HEAD", headers: siteHeaders }),
    ]);

    // Homepage: measured only if we actually loaded it (2xx). A 403/blocked page or
    // a network error means "couldn't analyze", not "all on-page signals are absent".
    if (homeRes.status === "fulfilled") {
      site.home_reachable = true;
      if (homeRes.value.ok) {
        site.home_measured = true;
        site.https_ok = true;
        const html = (await homeRes.value.text()).slice(0, 500_000);
        site.title = /<title[^>]*>[^<]{3,}<\/title>/i.test(html);
        site.meta_description = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(html) ||
          /<meta[^>]+content=["'][^"']{20,}["'][^>]+name=["']description["']/i.test(html);
        site.h1 = /<h1[\s>]/i.test(html);
        site.open_graph = /<meta[^>]+property=["']og:/i.test(html);
        const ldBlocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
        site.json_ld = ldBlocks.length > 0;
        for (const block of ldBlocks) {
          const types = block.match(/"@type"\s*:\s*"([^"]+)"/g) || [];
          for (const t of types) {
            const m = t.match(/"@type"\s*:\s*"([^"]+)"/);
            if (m && !site.json_ld_types.includes(m[1])) site.json_ld_types.push(m[1]);
          }
        }
      }
    }

    // robots.txt: a 2xx is a real file; a 404/410 is a real "no robots.txt".
    // A 403/429/5xx or network error is unknown -> leave robots_measured false.
    if (robotsRes.status === "fulfilled") {
      const r = robotsRes.value;
      if (r.ok) {
        site.robots_measured = true;
        site.robots_txt = true;
        const txt = (await r.text()).slice(0, 100_000);
        // Parse per-agent Disallow rules; a crawler is blocked if its own block (or *) has "Disallow: /"
        const sections = txt.split(/(?=^user-agent:)/gim);
        const blockedAgents = new Set<string>();
        for (const sec of sections) {
          const agents = [...sec.matchAll(/^user-agent:\s*(.+)$/gim)].map(m => m[1].trim().toLowerCase());
          const fullBlock = /^disallow:\s*\/\s*$/im.test(sec);
          if (fullBlock) agents.forEach(a => blockedAgents.add(a));
        }
        for (const bot of AI_CRAWLERS) {
          const blocked = blockedAgents.has(bot.toLowerCase()) ||
            (blockedAgents.has("*") && !txt.toLowerCase().includes(bot.toLowerCase()));
          (blocked ? site.ai_crawlers_blocked : site.ai_crawlers_allowed).push(bot);
        }
      } else if (r.status === 404 || r.status === 410) {
        site.robots_measured = true;
        site.robots_txt = false;
        site.ai_crawlers_allowed = [...AI_CRAWLERS]; // no robots.txt = nothing blocked
      }
    }

    if (llmsRes.status === "fulfilled") {
      const r = llmsRes.value;
      if (r.ok || r.status === 404 || r.status === 410) {
        site.llms_measured = true;
        site.llms_txt = r.ok && (r.headers.get("content-type") || "").includes("text");
      }
    }

    if (sitemapRes.status === "fulfilled") {
      const r = sitemapRes.value;
      if (r.ok || r.status === 404 || r.status === 410) {
        site.sitemap_measured = true;
        site.sitemap_xml = r.ok;
      }
    }

    // --- AI Visibility score (0-100), measured signals only ---
    // Each signal contributes to BOTH the earned points and the denominator only
    // when it was actually measured. A missing signal drops out of the scale
    // instead of silently costing points, so the score reflects what we could see.
    const llm = apiFindings.llm ?? {};
    const bl = apiFindings.backlinks ?? {};
    const serp = apiFindings.serp ?? {};

    const llmMeasured = llm.measured === true;
    const serpMeasured = serp.measured === true;
    const blMeasured = bl.measured === true;
    const mentions = llm.chatgpt_mentions ?? 0;
    const backlinks = bl.backlinks ?? 0;
    const rank = bl.domain_rank ?? 0;

    let aiEarned = 0, aiPossible = 0;
    if (llmMeasured) {
      aiPossible += 40;
      aiEarned += mentions >= 100 ? 40 : mentions >= 20 ? 32 : mentions >= 5 ? 24 : mentions >= 1 ? 14 : 0;
    }
    if (serpMeasured) {
      aiPossible += 25;
      aiEarned += (serp.domain_in_serp ? 15 : 0) + (serp.serp_position === 1 ? 10 : 0);
    }
    if (blMeasured) {
      aiPossible += 35;
      aiEarned += backlinks >= 1000 ? 15 : backlinks >= 100 ? 10 : backlinks >= 10 ? 5 : 0;
      aiEarned += rank >= 70 ? 20 : rank >= 50 ? 15 : rank >= 30 ? 10 : rank >= 10 ? 5 : 0;
    }
    const aiVisibilityMeasured = aiPossible > 0;
    // aiPossible < 100 means some AI-visibility signals were unavailable; the score
    // is rescaled over the rest and flagged partial so the UI can caveat it.
    const aiVisibilityPartial = aiPossible < 100;
    let aiVisibilityScore = aiVisibilityMeasured ? Math.round(aiEarned / aiPossible * 100) : 0;

    // --- Agent Readiness score (0-100), measured groups only ---
    let agEarned = 0, agPossible = 0;
    if (site.home_measured) {
      agPossible += 55;
      if (site.https_ok) agEarned += 10;
      if (site.json_ld) agEarned += 20;
      if (site.json_ld_types.some((t: string) =>
        /Organization|LocalBusiness|Product|Service|FAQPage|Article/i.test(t))) agEarned += 5;
      if (site.title) agEarned += 5;
      if (site.meta_description) agEarned += 5;
      if (site.h1) agEarned += 5;
      if (site.open_graph) agEarned += 5;
    }
    if (site.robots_measured) {
      agPossible += 25;
      if (site.robots_txt) agEarned += 5;
      agEarned += Math.round(site.ai_crawlers_allowed.length / AI_CRAWLERS.length * 20);
    }
    if (site.llms_measured) {
      agPossible += 10;
      if (site.llms_txt) agEarned += 10;
    }
    if (site.sitemap_measured) {
      agPossible += 10;
      if (site.sitemap_xml) agEarned += 10;
    }
    const agentReadinessMeasured = agPossible > 0;
    const agentReadinessPartial = agPossible < 100;
    let agentReadinessScore = agentReadinessMeasured ? Math.round(agEarned / agPossible * 100) : 0;

    aiVisibilityScore = Math.min(100, Math.max(0, aiVisibilityScore));
    agentReadinessScore = Math.min(100, Math.max(0, agentReadinessScore));

    // Grade scale matches the frontend gradeInfo(): A>=86, B>=71, C>=56, D>=41, F below.
    // Average only the top-level scores we could actually measure.
    const measuredScores: number[] = [];
    if (aiVisibilityMeasured) measuredScores.push(aiVisibilityScore);
    if (agentReadinessMeasured) measuredScores.push(agentReadinessScore);
    const avg = measuredScores.length
      ? Math.round(measuredScores.reduce((a, b) => a + b, 0) / measuredScores.length)
      : 0;
    const grade = !measuredScores.length ? "N/A"
      : avg >= 86 ? "A" : avg >= 71 ? "B" : avg >= 56 ? "C" : avg >= 41 ? "D" : "F";

    // --- Issues and opportunities from actual findings ---
    const topIssues: { title: string; description: string }[] = [];
    const topOpportunities: { title: string; description: string }[] = [];

    if (llmMeasured && mentions === 0) topIssues.push({
      title: "Not cited by ChatGPT",
      description: "We found zero ChatGPT citations for your domain. AI assistants are answering your customers' questions with someone else's business." });
    if (site.robots_measured && site.ai_crawlers_blocked.length > 0) topIssues.push({
      title: "AI crawlers blocked",
      description: `Your robots.txt blocks ${site.ai_crawlers_blocked.join(", ")}. Those AI engines cannot read your site, so they cannot recommend you.` });
    if (site.home_measured && !site.json_ld) topIssues.push({
      title: "No structured data",
      description: "Your homepage has no Schema.org markup. AI agents have to guess what your business is instead of reading it directly." });
    if (serpMeasured && !serp.domain_in_serp) topIssues.push({
      title: "Weak brand search presence",
      description: "Your site doesn't rank in the top 10 when someone Googles your brand name. That's the first signal AI engines check." });
    if (blMeasured && backlinks < 50) topIssues.push({
      title: "Low authority signals",
      description: `Only ${backlinks} sites link to you. AI engines lean on link authority when deciding which businesses to cite.` });
    if (site.home_measured && (!site.meta_description || !site.title)) topIssues.push({
      title: "Missing basic meta tags",
      description: "Title or meta description is missing on your homepage, which weakens how both search and AI engines summarize you." });
    if (!site.home_measured) topIssues.push({
      title: "We couldn't fully read your site",
      description: "Your homepage didn't load for our scanner — often bot protection (e.g. Cloudflare) blocking automated visitors. If AI crawlers are treated the same way, they can't read you either. Your Agent Readiness score reflects only what we could reach." });

    if (site.home_measured && !site.json_ld) topOpportunities.push({
      title: "Add Schema markup",
      description: "LocalBusiness or Organization structured data is the fastest way to make your business machine-readable." });
    if (site.llms_measured && !site.llms_txt) topOpportunities.push({
      title: "Publish an llms.txt file",
      description: "A simple llms.txt tells AI models exactly what your business does. Most competitors don't have one yet." });
    if (site.robots_measured && site.ai_crawlers_blocked.length > 0) topOpportunities.push({
      title: "Unblock AI crawlers",
      description: "One robots.txt edit lets GPTBot, ClaudeBot and PerplexityBot index you again. Quickest win on this list." });
    if (llmMeasured && mentions < 5) topOpportunities.push({
      title: "Build AI citation sources",
      description: "Get listed in the directories and publications AI engines cite most in your category." });
    if (site.sitemap_measured && !site.sitemap_xml) topOpportunities.push({
      title: "Add an XML sitemap",
      description: "A sitemap helps every crawler, AI included, find all of your pages instead of just your homepage." });
    topOpportunities.push({
      title: "Publish authoritative content",
      description: "Original expert content with real numbers is what AI engines quote. Thin service pages are invisible to them." });

    const technicalFindings = {
      ...bl, site_checks: site,
      llm_mentions: llm, cache_hit: cacheHit,
      ai_visibility_partial: aiVisibilityPartial,
      agent_readiness_partial: agentReadinessPartial,
      site_unreachable: !site.home_measured
    };

    const recommendedOffer =
      aiVisibilityScore < 50 ? "AI SEO Foundation Package" :
      agentReadinessScore < 60 ? "Agent-Ready Website Upgrade" : "Authority Builder Program";
    const mentionsText = llmMeasured ? `${mentions} ChatGPT mentions` : `ChatGPT mentions not measured`;
    const llmSummary = `${normalized_domain} scored ${aiVisibilityScore}/100 AI Visibility (${mentionsText}), ${agentReadinessScore}/100 Agent Readiness. Grade: ${grade}.`;

    await sbInsert("scan_results", {
      scan_request_id: scanReq.id,
      ai_visibility_score: aiVisibilityScore, agent_readiness_score: agentReadinessScore,
      overall_grade: grade,
      top_issues_json: topIssues.slice(0, 3),
      top_opportunities_json: topOpportunities.slice(0, 3),
      technical_findings_json: technicalFindings, serp_findings_json: serp,
      competitor_findings_json: {}, recommended_offer: recommendedOffer, llm_summary: llmSummary
    });

    await sbUpdate("scan_requests", scanReq.id, { status: "complete" });

    // --- GHL CRM sync (fire-and-forget, only when email is present) ---
    if (email) {
      try {
        const GHL_API_KEY = Deno.env.get("GHL_API_KEY");
        const GHL_LOCATION_ID = Deno.env.get("GHL_LOCATION_ID");
        if (GHL_API_KEY && GHL_LOCATION_ID) {
          const nameParts = (name || "").trim().split(/\s+/);
          await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + GHL_API_KEY,
              "Version": "2021-07-28",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              locationId: GHL_LOCATION_ID,
              email: email.trim(),
              firstName: nameParts[0] || "",
              lastName: nameParts.slice(1).join(" ") || "",
              phone: phone || undefined,
              website: website_url || undefined,
              tags: ["ai-scanner-lead"]
            })
          });
        }
      } catch (ghlErr) {
        console.error("GHL sync error (non-fatal):", (ghlErr as Error).message);
      }
    }

    return json(200, {
      success: true, scan_request_id: scanReq.id, normalized_domain,
      ai_visibility_score: aiVisibilityScore, agent_readiness_score: agentReadinessScore,
      overall_grade: grade,
      ai_visibility_partial: aiVisibilityPartial,
      agent_readiness_partial: agentReadinessPartial,
      site_unreachable: !site.home_measured,
      top_issues: topIssues.slice(0, 3),
      top_opportunities: topOpportunities.slice(0, 3),
      technical_findings: technicalFindings, serp_findings: serp,
      recommended_offer: recommendedOffer, llm_summary: llmSummary
    });

  } catch (err) {
    console.error("Error:", (err as Error).message);
    return json(500, { error: String(err) });
  }
});

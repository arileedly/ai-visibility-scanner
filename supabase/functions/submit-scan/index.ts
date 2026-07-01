// Leedly AI Visibility Scanner — Supabase Edge Function
// POST https://ywhhzhhbfzkcknljlwow.supabase.co/functions/v1/submit-scan
//
// Edge Function Secrets required (Supabase dashboard → Edge Functions → Secrets):
//   DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
// Auto-injected: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const { website_url, name, email, phone, business_type,
      city_or_service_area, competitor_url, monthly_marketing_budget,
      main_goal, consent_given } = body;

    if (!website_url) {
      return new Response(JSON.stringify({ error: "website_url is required" }), {
        status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const normalized_domain = website_url
      .replace(/^https?:\/\//, "").replace(/^www\./, "")
      .split("/")[0].toLowerCase().trim();

    const authHeader = "Basic " + btoa(
      Deno.env.get("DATAFORSEO_LOGIN") + ":" + Deno.env.get("DATAFORSEO_PASSWORD")
    );
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    async function sbInsert(table, data) {
      const resp = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
        method: "POST",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify(data)
      });
      if (!resp.ok) throw new Error("DB insert failed: " + await resp.text());
      const rows = await resp.json();
      return Array.isArray(rows) ? rows[0] : rows;
    }

    async function sbUpdate(table, id, data) {
      await fetch(SUPABASE_URL + "/rest/v1/" + table + "?id=eq." + id, {
        method: "PATCH",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": "Bearer " + SUPABASE_SERVICE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
      });
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

    let aiVisibilityScore = 50, agentReadinessScore = 50;
    let technicalFindings = {}, serpFindings = {};

    // DataForSEO: SERP check
    try {
      const serpData = await (await fetch(
        "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
        { method: "POST", headers: { Authorization: authHeader, "Content-Type": "application/json" },
          body: JSON.stringify([{ keyword: normalized_domain, location_code: 2840, language_code: "en", depth: 10 }]) }
      )).json();
      const items = serpData?.tasks?.[0]?.result?.[0]?.items ?? [];
      const inSerp = items.some(i => (i?.domain||"").includes(normalized_domain) || (i?.url||"").includes(normalized_domain));
      serpFindings = { items_count: items.length, domain_in_serp: inSerp };
      if (inSerp) aiVisibilityScore += 15;
      await sbInsert("api_usage_logs", {
        scan_request_id: scanReq.id, provider: "dataforseo",
        endpoint: "serp/google/organic/live/advanced",
        task_id: serpData?.tasks?.[0]?.id || null, estimated_cost: 0.0015,
        status: serpData?.tasks?.[0]?.status_code === 20000 ? "success" : "error",
        raw_response_summary: serpData?.tasks?.[0]?.status_message || null
      });
    } catch(e) { console.error("SERP:", e.message); }

    // DataForSEO: Backlinks
    try {
      const blData = await (await fetch(
        "https://api.dataforseo.com/v3/backlinks/domain_pages_summary/live",
        { method: "POST", headers: { Authorization: authHeader, "Content-Type": "application/json" },
          body: JSON.stringify([{ target: normalized_domain }]) }
      )).json();
      const r = blData?.tasks?.[0]?.result?.[0] ?? {};
      technicalFindings = { domain_rank: r.rank ?? 0, backlinks: r.backlinks ?? 0 };
      if ((r.rank??0) > 50) agentReadinessScore += 10;
      if ((r.rank??0) > 30) agentReadinessScore += 5;
      if ((r.backlinks??0) > 100) aiVisibilityScore += 10;
      if ((r.backlinks??0) > 1000) aiVisibilityScore += 5;
      await sbInsert("api_usage_logs", {
        scan_request_id: scanReq.id, provider: "dataforseo",
        endpoint: "backlinks/domain_pages_summary/live",
        task_id: blData?.tasks?.[0]?.id || null, estimated_cost: 0.0025,
        status: blData?.tasks?.[0]?.status_code === 20000 ? "success" : "error",
        raw_response_summary: blData?.tasks?.[0]?.status_message || null
      });
    } catch(e) { console.error("Backlinks:", e.message); }

    aiVisibilityScore = Math.min(100, Math.max(0, aiVisibilityScore));
    agentReadinessScore = Math.min(100, Math.max(0, agentReadinessScore));

    const avg = (aiVisibilityScore + agentReadinessScore) / 2;
    const grade = avg >= 90 ? "A" : avg >= 80 ? "B" : avg >= 70 ? "C+" : avg >= 60 ? "C" : avg >= 50 ? "D" : "F";

    const topIssues = [];
    if (agentReadinessScore < 60) topIssues.push({ title: "Low agent readiness", description: "Your site lacks structured data for AI agents to parse confidently." });
    if (aiVisibilityScore < 60) topIssues.push({ title: "Weak AI visibility", description: "AI search engines struggle to confidently identify your business." });
    if ((technicalFindings as any).backlinks < 50) topIssues.push({ title: "Low authority signals", description: "Very few sites link to you, reducing AI citation confidence." });

    const topOpportunities = [
      { title: "Add Schema markup", description: "Structured data helps AI engines understand your business context." },
      { title: "Claim AI directory listings", description: "Get listed in AI-indexed directories to boost citation rates." },
      { title: "Publish authoritative content", description: "Original expert content increases AI recommendation probability." }
    ];

    const recommendedOffer = aiVisibilityScore < 50 ? "AI SEO Foundation Package" :
      agentReadinessScore < 60 ? "Agent-Ready Website Upgrade" : "Authority Builder Program";
    const llmSummary = `${normalized_domain} scored ${aiVisibilityScore}/100 AI Visibility, ${agentReadinessScore}/100 Agent Readiness. Grade: ${grade}.`;

    await sbInsert("scan_results", {
      scan_request_id: scanReq.id,
      ai_visibility_score: aiVisibilityScore, agent_readiness_score: agentReadinessScore,
      overall_grade: grade, top_issues_json: topIssues, top_opportunities_json: topOpportunities,
      technical_findings_json: technicalFindings, serp_findings_json: serpFindings,
      competitor_findings_json: {}, recommended_offer: recommendedOffer, llm_summary: llmSummary
    });

    await sbUpdate("scan_requests", scanReq.id, { status: "complete" });

    return new Response(JSON.stringify({
      success: true, scan_request_id: scanReq.id, normalized_domain,
      ai_visibility_score: aiVisibilityScore, agent_readiness_score: agentReadinessScore,
      overall_grade: grade, top_issues: topIssues, top_opportunities: topOpportunities,
      technical_findings: technicalFindings, serp_findings: serpFindings,
      recommended_offer: recommendedOffer, llm_summary: llmSummary
    }), { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("Error:", err.message);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
});

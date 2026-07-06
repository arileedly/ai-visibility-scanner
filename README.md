# AI Visibility Scanner

**Leedly AI Visibility & Agent Readiness Scanner** — a lead-generation tool that scores how visible a business is to AI search engines (ChatGPT, Gemini, Perplexity, Google AI Mode) and delivers a branded report to capture qualified leads.

## Stack
- **Frontend**: Single-file HTML/CSS/JS — `public/index.html`
- **Backend**: Supabase Edge Function — `supabase/functions/submit-scan/index.ts`
- **Database**: Supabase PostgreSQL — 5 tables
- **Scoring APIs**: DataForSEO (SERP + Backlinks + LLM Mentions) and direct site checks

## Scoring model (v2, July 2026)

Both scores run 0–100 and the full range is reachable. Grade scale (same in
frontend and backend): A ≥ 86, B ≥ 71, C ≥ 56, D ≥ 41, F below.

**AI Visibility (0–100)** — measured signals:
| Signal | Source | Points |
|---|---|---|
| ChatGPT citations of the domain | DataForSEO LLM Mentions | up to 40 |
| Ranks top 10 for own brand name | DataForSEO SERP | 15 (+10 if #1) |
| Backlink volume | DataForSEO Backlinks | up to 15 |
| Domain rank | DataForSEO Backlinks | up to 20 |

**Agent Readiness (0–100)** — the function fetches the live site and checks:
HTTPS (10), JSON-LD schema (20, +5 for business types), robots.txt present (5),
AI crawlers not blocked — GPTBot / ClaudeBot / PerplexityBot / Google-Extended
(up to 20), llms.txt (10), sitemap.xml (10), title (5), meta description (5),
H1 (5), Open Graph (5).

**Measured vs estimated in the UI:** the ChatGPT row and the backlink/authority
card show measured API data. Other AI-platform rows are labeled `est.` and
derived from the measured visibility score. Competitor comparison rows are
anonymized estimates only — we never attach scores to real businesses we
haven't scanned.

## Cost controls
- **LLM Mentions is ~$0.10/call** (SERP + backlinks together are under $0.005).
- `scan_cache` reuses API findings per domain for 7 days — repeat scans are free.
- `rate_limits` caps scans at 5/hour and 20/day per IP, 3/day per domain.
- Every API call is logged in `api_usage_logs` with estimated cost.

## Repo Structure
```
ai-visibility-scanner/
├── public/
│   └── index.html              # Full scanner UI (HTML/CSS/JS)
├── supabase/
│   ├── functions/
│   │   └── submit-scan/
│   │       └── index.ts        # Edge Function — DataForSEO + site checks + DB writes
│   └── migrations/
│       ├── 20260704_rate_limits_and_cache.sql   # run BEFORE deploying the function
│       └── 20260706_enable_rls.sql              # run next: locks lead data behind RLS
├── .env.example
└── README.md
```

## Deploying an update
1. Run `supabase/migrations/20260704_rate_limits_and_cache.sql`, then
   `supabase/migrations/20260706_enable_rls.sql`, in the Supabase SQL editor.
   The RLS migration blocks the public `anon` key from reading lead data; the
   Edge Function uses the service-role key and is unaffected.
2. Push to `main` — GitHub Actions deploys Pages (`public/`) and the Edge Function.
3. Root `index.html` is a copy of `public/index.html`; keep them in sync.

## Environment Variables (Edge Function Secrets)
| Variable | Description |
|---|---|
| `DATAFORSEO_LOGIN` | DataForSEO account email |
| `DATAFORSEO_PASSWORD` | DataForSEO API password |
| `GHL_API_KEY` | GoHighLevel API key (optional, lead sync) |
| `GHL_LOCATION_ID` | GoHighLevel location (optional, lead sync) |
| `SUPABASE_URL` | Auto-injected by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase |

## Database Schema
- **scan_requests** — lead form submissions
- **scan_results** — AI visibility & agent readiness scores
- **api_usage_logs** — DataForSEO cost tracking
- **rate_limits** — abuse prevention (per-IP and per-domain counters)
- **scan_cache** — cached DataForSEO findings per domain (7-day TTL)

## Edge Function Endpoint
`POST https://ywhhzhhbfzkcknljlwow.supabase.co/functions/v1/submit-scan`

Accepts: website_url, name, email, phone, business_type, city_or_service_area, competitor_url, monthly_marketing_budget, main_goal, consent_given

Returns: ai_visibility_score, agent_readiness_score, overall_grade (A–F), top_issues, top_opportunities, technical_findings (site checks + LLM mentions), recommended_offer

---
Built by Leedly · [leedly.com](https://leedly.com)

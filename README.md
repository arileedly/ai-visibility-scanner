# AI Visibility Scanner

**Leedly AI Visibility & Agent Readiness Scanner** — a lead-generation tool that scores how visible a business is to AI search engines (ChatGPT, Gemini, Perplexity, Google AI Mode) and delivers a branded report to capture qualified leads.

## Stack
- **Frontend**: Single-file HTML/CSS/JS — `public/index.html`
- **Backend**: Supabase Edge Function — `supabase/functions/submit-scan/index.ts`
- **Database**: Supabase PostgreSQL — 5 tables
- **Scoring APIs**: DataForSEO (SERP + Backlinks)

## Repo Structure
```
ai-visibility-scanner/
├── public/
│   └── index.html              # Full scanner UI (HTML/CSS/JS)
├── supabase/
│   └── functions/
│       └── submit-scan/
│           └── index.ts        # Edge Function — DataForSEO + DB writes
├── .env.example
└── README.md
```

## Environment Variables (Edge Function Secrets)
| Variable | Description |
|---|---|
| `DATAFORSEO_LOGIN` | DataForSEO account email |
| `DATAFORSEO_PASSWORD` | DataForSEO API password |
| `SUPABASE_URL` | Auto-injected by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase |

## Database Schema
- **scan_requests** — lead form submissions
- **scan_results** — AI visibility & agent readiness scores
- **api_usage_logs** — DataForSEO cost tracking
- **rate_limits** — abuse prevention
- **scan_cache** — cached domain results

## Edge Function Endpoint
`POST https://ywhhzhhbfzkcknljlwow.supabase.co/functions/v1/submit-scan`

Accepts: website_url, name, email, phone, business_type, city_or_service_area, competitor_url, monthly_marketing_budget, main_goal, consent_given

Returns: ai_visibility_score, agent_readiness_score, overall_grade (A–F), top_issues, top_opportunities, recommended_offer

---
Built by Leedly · [leedly.com](https://leedly.com)

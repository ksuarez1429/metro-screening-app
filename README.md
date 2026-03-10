# Metropolitan Holdings — Accounting Coordinator Screening App

A fully self-hosted candidate screening platform with AI-graded Excel assessments.

## What it does

1. **Candidates** visit your URL → complete a 20-question written assessment → download 3 Excel task files → work in real Excel → upload completed files
2. **Claude AI** reads each uploaded spreadsheet and grades it on formula accuracy, correct function types, no hardcoded values, and completeness (0–100 per task)
3. **You** receive an email with full results + can view a live dashboard at `/dashboard`

---

## Setup in Claude Code

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your email and Anthropic API key
```

### 3. Start the server
```bash
node server.js
```

### 4. Share the link
Send candidates: `http://your-server:3000`
Your dashboard: `http://your-server:3000/dashboard`

---

## Deployment options

### Claude Code (simplest)
Run `node server.js` in Claude Code terminal. Claude Code can expose the port for external access.

### Railway / Render / Fly.io (free tier)
Push to GitHub, connect to Railway/Render, set environment variables in their dashboard.

### VPS / EC2
```bash
npm install pm2 -g
pm2 start server.js --name metro-screening
pm2 save
```

---

## Email Setup (Gmail)

1. Enable 2-Factor Authentication on your Google account
2. Go to: myaccount.google.com/apppasswords
3. Generate a new App Password for "Mail"
4. Use that 16-character password as `SMTP_PASS` in .env

---

## Excel Tasks Summary

| Task | Level | Skills Tested |
|------|-------|---------------|
| Task 1 — AP Reconciliation | Intermediate | SUMIFS, COUNTIFS, IF, INDEX/MATCH |
| Task 2 — GL Variance Analysis | Advanced | SUMIFS, INDEX/MATCH dynamic lookup, RANK, nested IFs, % formulas |
| Task 3 — Month-End Close | Mixed | TODAY(), IF, SUMIF, COUNTIF, classification logic |

---

## Grading

Claude grades each submitted Excel file on:
- Correct formula types used (SUMIFS vs SUMIF, INDEX/MATCH vs VLOOKUP, etc.)
- Mathematical accuracy of results
- No hardcoded values in answer cells
- All required cells completed
- Bonus points for advanced techniques

Scores are 0–100 per task. The dashboard shows per-task scores, AI feedback, and all written responses.

---

## File structure
```
metro-screening/
├── server.js              # Main app
├── .env.example           # Config template
├── public/
│   ├── index.html         # Candidate questionnaire
│   ├── dashboard.html     # Hiring manager dashboard
│   └── assets/
│       ├── logo.jpg
│       ├── task1_ap_reconciliation.xlsx
│       ├── task2_gl_variance.xlsx
│       └── task3_month_end_close.xlsx
└── submissions/           # Created automatically
    └── [uuid]/
        ├── submission.json
        ├── task1_ap_reconciliation.xlsx  (candidate's upload)
        └── ...
```

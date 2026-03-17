/**
 * Metropolitan Holdings — Accounting Coordinator Screening App
 * Run: node server.js
 * Configure: copy .env.example to .env and fill in your values
 */

require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config (set via environment variables or edit defaults here) ──────────
const CONFIG = {
  HIRING_MANAGER_EMAIL : process.env.HIRING_EMAIL   || 'hiring@metropolitanholdings.com',
  SMTP_HOST            : process.env.SMTP_HOST       || 'smtp.gmail.com',
  SMTP_PORT            : parseInt(process.env.SMTP_PORT || '587'),
  SMTP_USER            : process.env.SMTP_USER       || '',
  SMTP_PASS            : process.env.SMTP_PASS       || '',
  ANTHROPIC_API_KEY    : process.env.ANTHROPIC_API_KEY || '',
  DATA_DIR             : path.join(__dirname, 'submissions'),
};

// ── Ensure data directory exists ──────────────────────────────────────────
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── File upload config ────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(CONFIG.DATA_DIR, req.body.submissionId || 'unknown');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const ok = file.originalname.match(/\.(xlsx|xls)$/i);
    cb(ok ? null : new Error('Only .xlsx files accepted'), !!ok);
  }
});

// ── Routes ────────────────────────────────────────────────────────────────

// Serve main questionnaire
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Serve dashboard
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// Start a new submission session
app.post('/api/start', (req, res) => {
  const id = uuidv4();
  res.json({ submissionId: id });
});

// Submit the questionnaire answers
app.post('/api/submit-questionnaire', async (req, res) => {
  try {
    const { submissionId, answers } = req.body;
    if (!submissionId || !answers) return res.status(400).json({ error: 'Missing data' });

    const dir = path.join(CONFIG.DATA_DIR, submissionId);
    fs.mkdirSync(dir, { recursive: true });

    const record = {
      submissionId,
      submittedAt: new Date().toISOString(),
      applicant: {
        name  : answers.applicant_name  || '',
        email : answers.applicant_email || '',
        phone : answers.applicant_phone || '',
      },
      answers,
      excelScores: null,
      status: 'awaiting_excel',
    };

    fs.writeFileSync(path.join(dir, 'submission.json'), JSON.stringify(record, null, 2));
    console.log(`[${new Date().toISOString()}] Questionnaire submitted: ${submissionId} — ${record.applicant.name}`);
    res.json({ ok: true, submissionId });
  } catch (e) {
    console.error('Submit error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload and grade Excel tasks
app.post('/api/upload-excel', upload.fields([
  { name: 'task1', maxCount: 1 },
  { name: 'task2', maxCount: 1 },
]), async (req, res) => {
  try {
    const { submissionId } = req.body;
    if (!submissionId) return res.status(400).json({ error: 'Missing submissionId' });

    const dir  = path.join(CONFIG.DATA_DIR, submissionId);
    const file = path.join(dir, 'submission.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Submission not found' });

    const record = JSON.parse(fs.readFileSync(file));

    // Grade each uploaded task with Claude
    const scores = {};
    for (const taskKey of ['task1', 'task2']) {
      if (req.files[taskKey]) {
        const fp = req.files[taskKey][0].path;
        scores[taskKey] = await gradeExcelWithClaude(taskKey, fp);
      }
    }

    record.excelScores = scores;
    record.status = 'complete';
    record.completedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(record, null, 2));

    // Send results email
    try {
      await sendResultsEmail(record);
    } catch (emailErr) {
      console.error('Email send failed (non-fatal):', emailErr);
    }

    console.log(`[${new Date().toISOString()}] Excel graded & email sent: ${submissionId}`);
    res.json({ ok: true, scores });
  } catch (e) {
    console.error('Upload error:', e);
    res.status(500).json({ error: 'Server error during grading' });
  }
});

// Dashboard API — list all submissions
app.get('/api/submissions', (req, res) => {
  try {
    const items = [];
    if (!fs.existsSync(CONFIG.DATA_DIR)) return res.json([]);
    for (const id of fs.readdirSync(CONFIG.DATA_DIR)) {
      const f = path.join(CONFIG.DATA_DIR, id, 'submission.json');
      if (fs.existsSync(f)) {
        const s = JSON.parse(fs.readFileSync(f));
        items.push({
          submissionId : s.submissionId,
          name         : s.applicant?.name || 'Unknown',
          email        : s.applicant?.email || '',
          submittedAt  : s.submittedAt,
          status       : s.status,
          excelScores  : s.excelScores,
          overallScore : calcOverallScore(s),
        });
      }
    }
    items.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    res.json(items);
  } catch (e) {
    console.error('Dashboard error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Dashboard API — single submission detail
app.get('/api/submissions/:id', (req, res) => {
  const f = path.join(CONFIG.DATA_DIR, req.params.id, 'submission.json');
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Not found' });
  res.json(JSON.parse(fs.readFileSync(f)));
});

// ── Claude Excel Grading ──────────────────────────────────────────────────
async function gradeExcelWithClaude(taskKey, filePath) {
  if (!CONFIG.ANTHROPIC_API_KEY) {
    return { score: null, feedback: 'Grading unavailable — ANTHROPIC_API_KEY not set.', rawResponse: '' };
  }

  // Read the Excel file and convert to base64 for Claude
  let fileData;
  try {
    fileData = fs.readFileSync(filePath).toString('base64');
  } catch (e) {
    return { score: null, feedback: 'Could not read uploaded file.', error: e.message };
  }

  const taskInstructions = {
    task1: `You are grading Task 1 (AP Reconciliation) of an Accounting Coordinator assessment.
The candidate was given:
- An Invoice Register sheet with ~40 vendor invoices
- A Payment Log sheet with ~30 payments
- A Reconciliation sheet with yellow cells to fill using SUMIFS/COUNTIFS formulas
- A Summary sheet requiring totals, counts, and an INDEX/MATCH for largest outstanding vendor

GRADE on a scale of 0–100 based on:
1. (25pts) SUMIFS formulas correctly used in Reconciliation sheet to total invoiced amounts per vendor
2. (25pts) SUMIFS formulas correctly used to total paid amounts per vendor
3. (20pts) Outstanding balance formula (invoiced minus paid) — mathematically correct
4. (15pts) IF formula for status flag (OUTSTANDING / CLEAR)
5. (15pts) Summary sheet completed with correct formulas, including INDEX/MATCH

DEDUCT points for:
- Hardcoded values instead of formulas (-10 each)
- Wrong formula types used (e.g., SUMIF instead of SUMIFS) (-5 each)
- Mathematical errors in results (-10 each)
- Incomplete yellow cells (-5 each)

Return a JSON object ONLY with no markdown: {"score": 0-100, "breakdown": {"sumifs_invoiced": 0-25, "sumifs_paid": 0-25, "balance_formula": 0-20, "if_flag": 0-15, "summary_sheet": 0-15}, "strengths": ["..."], "concerns": ["..."], "feedback": "2-3 sentence summary"}`,

    task2: `You are grading Task 2 (GL Variance Analysis) of an Accounting Coordinator assessment.
The candidate was given Q3 2024 GL journal entry data across 6 accounts and had to complete a Variance Analysis sheet with these yellow cells:
- Column C: SUMIFS formula to calculate total Q3 actual spend per account (cross-sheet reference to GL Data)
- Column D: Pre-filled budget values (should NOT be changed)
- Column E: $ Variance formula (Actual minus Budget)
- Column F: % Variance formula ((Actual-Budget)/Budget), formatted as percentage
- Column G: IF flag — 'REVIEW' if % variance > 10% or < -10%, otherwise blank
- Summary section (4 cells): total actual, total budget, total variance, count of REVIEW flags

GRADE on a scale of 0–100:
1. (40pts) SUMIFS formulas — correct cross-sheet syntax, accurate results, no hardcoded values
2. (20pts) $ Variance formula — correct subtraction, no hardcodes
3. (20pts) % Variance formula — correct calculation, formatted as %
4. (10pts) IF flag formula — correctly identifies accounts >10% or <-10% variance
5. (10pts) Summary section — all 4 cells completed with formulas

DEDUCT: Hardcoded values instead of formulas (-10 each), wrong formula type (-5), math errors (-8 each), incomplete cells (-5 each)

Return JSON ONLY with no markdown: {"score": 0-100, "breakdown": {"sumifs": 0-40, "dollar_variance": 0-20, "pct_variance": 0-20, "if_flag": 0-10, "summary": 0-10}, "strengths": ["..."], "concerns": ["..."], "feedback": "2-3 sentence summary"}`,
  };

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type'      : 'application/json',
        'x-api-key'         : CONFIG.ANTHROPIC_API_KEY,
        'anthropic-version' : '2023-06-01',
      },
      body: JSON.stringify({
        model      : 'claude-sonnet-4-6',
        max_tokens : 1500,
        messages   : [{
          role    : 'user',
          content : [
            {
              type   : 'document',
              source : { type: 'base64', media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: fileData },
            },
            { type: 'text', text: taskInstructions[taskKey] },
          ],
        }],
      }),
    });

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';

    // Strip any markdown fences and parse JSON
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return { ...parsed, rawResponse: text };
  } catch (e) {
    console.error(`Claude grading error for ${taskKey}:`, e);
    return { score: null, feedback: 'Auto-grading failed — manual review required.', error: e.message };
  }
}

// ── Score aggregation ─────────────────────────────────────────────────────
function calcOverallScore(record) {
  if (!record.excelScores) return null;
  const scores = Object.values(record.excelScores)
    .map(s => s.score)
    .filter(s => s !== null && s !== undefined);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// ── Email results ─────────────────────────────────────────────────────────
async function sendResultsEmail(record) {
  if (!CONFIG.SMTP_USER || !CONFIG.SMTP_PASS) {
    console.log('[Email] SMTP not configured — skipping email send');
    return;
  }

  const transporter = nodemailer.createTransporter({
    host   : CONFIG.SMTP_HOST,
    port   : CONFIG.SMTP_PORT,
    secure : CONFIG.SMTP_PORT === 465,
    auth   : { user: CONFIG.SMTP_USER, pass: CONFIG.SMTP_PASS },
  });

  const overall = calcOverallScore(record);
  const scores  = record.excelScores || {};

  const excelRows = ['task1', 'task2'].map(k => {
    const s = scores[k];
    if (!s) return '';
    const taskNames = { task1: 'AP Reconciliation', task2: 'GL Variance Analysis' };
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${taskNames[k]}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">
          <span style="background:${scoreColor(s.score)};color:white;padding:3px 10px;border-radius:12px;font-weight:700">${s.score ?? 'N/A'}/100</span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#555;font-size:13px">${s.feedback || ''}</td>
      </tr>`;
  }).join('');

  const questionRows = Object.entries(record.answers || {})
    .filter(([k]) => !k.startsWith('applicant_'))
    .map(([k, v]) => `<tr><td style="padding:6px 10px;font-weight:600;color:#444;font-size:12px;border-bottom:1px solid #f0f0f0;white-space:nowrap">${k}</td><td style="padding:6px 10px;font-size:12px;color:#222;border-bottom:1px solid #f0f0f0">${String(v).replace(/\n/g,'<br>')}</td></tr>`)
    .join('');

  const html = `
<!DOCTYPE html><html><body style="margin:0;font-family:Arial,sans-serif;background:#f5f5f5">
<div style="max-width:720px;margin:0 auto;background:white">
  <div style="background:#1a1a1a;padding:28px 32px;text-align:center">
    <div style="font-size:22px;font-weight:900;color:white;letter-spacing:2px">METROPOLITAN</div>
    <div style="background:#B8962E;padding:4px 16px;display:inline-block;margin-top:4px">
      <span style="font-size:12px;font-weight:700;color:white;letter-spacing:3px">HOLDINGS</span>
    </div>
    <div style="color:rgba(255,255,255,0.6);font-size:12px;margin-top:12px">Accounting Coordinator — Candidate Assessment Results</div>
  </div>

  <div style="padding:28px 32px;border-bottom:3px solid #B8962E">
    <table style="width:100%">
      <tr>
        <td><div style="font-size:22px;font-weight:700;color:#1a1a1a">${record.applicant.name}</div>
            <div style="color:#888;margin-top:2px">${record.applicant.email} &nbsp;·&nbsp; ${record.applicant.phone}</div>
            <div style="color:#aaa;font-size:12px;margin-top:4px">Submitted: ${new Date(record.submittedAt).toLocaleString()}</div></td>
        <td style="text-align:right">
          <div style="font-size:42px;font-weight:900;color:${scoreColor(overall)}">${overall ?? '—'}</div>
          <div style="font-size:12px;color:#888;font-weight:600">EXCEL SCORE AVG</div>
        </td>
      </tr>
    </table>
  </div>

  <div style="padding:24px 32px">
    <div style="font-size:14px;font-weight:700;color:#1a1a1a;margin-bottom:12px;letter-spacing:1px;text-transform:uppercase">Excel Task Scores</div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden">
      <tr style="background:#f8f8f8">
        <th style="padding:10px 12px;text-align:left;font-size:12px;color:#888">TASK</th>
        <th style="padding:10px 12px;text-align:center;font-size:12px;color:#888">SCORE</th>
        <th style="padding:10px 12px;text-align:left;font-size:12px;color:#888">AI FEEDBACK</th>
      </tr>
      ${excelRows}
    </table>
  </div>

  <div style="padding:0 32px 24px">
    <div style="font-size:14px;font-weight:700;color:#1a1a1a;margin-bottom:12px;letter-spacing:1px;text-transform:uppercase">Questionnaire Responses</div>
    <table style="width:100%;border-collapse:collapse;border:1px solid #eee;font-size:13px">
      ${questionRows}
    </table>
  </div>

  <div style="background:#1a1a1a;padding:16px 32px;text-align:center">
    <span style="color:#B8962E;font-size:11px;font-weight:700;letter-spacing:2px">METROPOLITAN HOLDINGS  ·  CONFIDENTIAL  ·  INTERNAL USE ONLY</span>
  </div>
</div>
</body></html>`;

  await transporter.sendMail({
    from    : `"Metro Holdings Recruiting" <${CONFIG.SMTP_USER}>`,
    to      : CONFIG.HIRING_MANAGER_EMAIL,
    subject : `[Screening] ${record.applicant.name} — Accounting Coordinator${overall ? ` · Score: ${overall}/100` : ''}`,
    html,
  });
}

function scoreColor(score) {
  if (score === null || score === undefined) return '#888';
  if (score >= 80) return '#2E7D32';
  if (score >= 65) return '#B8962E';
  return '#C0392B';
}

// ── Start server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✦ Metropolitan Holdings Screening App`);
  console.log(`  Running at: http://localhost:${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}/dashboard`);
  console.log(`  Data dir:   ${CONFIG.DATA_DIR}\n`);
});

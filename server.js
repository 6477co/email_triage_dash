const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'inbox-triage-secret-key-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(__dirname, 'public')));

// OAuth2 Client helper
function getOAuthClient(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${protocol}://${host}/auth/google/callback`;

  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

// Auth Routes
app.get('/auth/google', (req, res) => {
  const oauth2Client = getOAuthClient(req);
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ]
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Authorization code missing.');
  try {
    const oauth2Client = getOAuthClient(req);
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (err) {
    console.error('Error getting tokens:', err);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

// Auth Middleware
function requireAuth(req, res, next) {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// API Routes
app.get('/api/threads', requireAuth, async (req, res) => {
  try {
    const batchSize = parseInt(req.query.batch) || 10;
    const exclude = JSON.parse(req.query.exclude || '[]');
    const excludeSet = new Set(exclude);

    const oauth2Client = getOAuthClient(req);
    oauth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // List threads in inbox
    const listRes = await gmail.users.threads.list({
      userId: 'me',
      q: 'in:inbox',
      maxResults: batchSize + exclude.length + 10
    });

    const threadsList = listRes.data.threads || [];
    const targetThreads = threadsList.filter(t => !excludeSet.has(t.id)).slice(0, batchSize);

    const rows = [];
    for (const t of targetThreads) {
      try {
        const detail = await gmail.users.threads.get({
          userId: 'me',
          id: t.id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date']
        });

        const messages = detail.data.messages || [];
        const lastMsg = messages[messages.length - 1];
        if (!lastMsg) continue;

        const headers = lastMsg.payload?.headers || [];
        const getHeader = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        const fromHeader = getHeader('From');
        let from = fromHeader;
        let addr = '';
        const match = fromHeader.match(/^(?:"?([^"]*)"?\s)?(?:<)?([^>]+)(?:>)?$/);
        if (match) {
          from = (match[1] || match[2]).trim();
          addr = (match[2] || '').trim();
        }

        const subject = getHeader('Subject');
        const dateISO = new Date(getHeader('Date') || parseInt(lastMsg.internalDate) || Date.now()).toISOString();
        const labels = lastMsg.labelIds || [];

        rows.push({
          threadId: t.id,
          messageId: lastMsg.id,
          from,
          addr,
          subject,
          dateISO,
          labels
        });
      } catch (err) {
        console.error(`Error fetching thread ${t.id}:`, err.message);
      }
    }

    res.json({ rows });
  } catch (err) {
    console.error('Error listing threads:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/thread/:id', requireAuth, async (req, res) => {
  try {
    const oauth2Client = getOAuthClient(req);
    oauth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const detail = await gmail.users.threads.get({
      userId: 'me',
      id: req.params.id,
      format: 'full'
    });

    const messages = detail.data.messages || [];
    const lastMsg = messages[messages.length - 1];
    
    let body = '';
    function extractBody(payload) {
      if (!payload) return;
      if (payload.mimeType === 'text/plain' && payload.body?.data) {
        body += Buffer.from(payload.body.data, 'base64').toString('utf8');
      }
      if (payload.parts) {
        for (const part of payload.parts) {
          extractBody(part);
        }
      }
    }

    extractBody(lastMsg?.payload);
    if (!body && lastMsg?.snippet) {
      body = lastMsg.snippet;
    }

    res.json({ body: body.trim(), truncated: false });
  } catch (err) {
    console.error('Error fetching thread body:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/thread/:id/action', requireAuth, async (req, res) => {
  try {
    const { action } = req.body;
    const threadId = req.params.id;

    const oauth2Client = getOAuthClient(req);
    oauth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    if (action === 'archive') {
      await gmail.users.threads.modify({
        userId: 'me',
        id: threadId,
        requestBody: { removeLabelIds: ['INBOX'] }
      });
    } else if (action === 'p1') {
      // Find or create P1 label and add STARRED
      const labelsRes = await gmail.users.labels.list({ userId: 'me' });
      let p1Label = labelsRes.data.labels.find(l => l.name.toUpperCase() === 'P1' || l.name.toUpperCase().endsWith('/P1'));
      if (!p1Label) {
        const createRes = await gmail.users.labels.create({
          userId: 'me',
          requestBody: { name: 'P1', labelListVisibility: 'labelShow', messageListVisibility: 'show' }
        });
        p1Label = createRes.data;
      }
      await gmail.users.threads.modify({
        userId: 'me',
        id: threadId,
        requestBody: { addLabelIds: ['STARRED', p1Label.id] }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error performing action:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/thread/:id/reply', requireAuth, async (req, res) => {
  try {
    const threadId = req.params.id;
    const { messageId, addr, subject, text, archive } = req.body;

    const oauth2Client = getOAuthClient(req);
    oauth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const rawSubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
    const emailLines = [
      `To: ${addr}`,
      `Subject: ${rawSubject}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      ``,
      text
    ];
    const email = emailLines.join('\r\n');
    const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        draft: {
          message: {
            threadId,
            raw: encodedEmail
          }
        }
      }
    });

    if (archive) {
      await gmail.users.threads.modify({
        userId: 'me',
        id: threadId,
        requestBody: { removeLabelIds: ['INBOX'] }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving reply draft:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/thread/:id/draft-ai', requireAuth, async (req, res) => {
  try {
    const { from, addr, subject, body } = req.body;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not configured on the server.' });
    }

    const anthropic = new Anthropic({ apiKey });

    const prompt = `Draft a reply from Brian Coyne, CEO of Peterson's, to this email. His style: direct, concise, short paragraphs, no filler, no pleasantries beyond a word. He decides and states the decision. Sign off exactly "Thanks,\\nBrian".

From: ${from} <${addr}>
Subject: ${subject}

${body.slice(0, 4000)}

Return ONLY the reply body text. No subject line, no commentary, no quotes around it.`;

    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    res.json({ reply: text });
  } catch (err) {
    console.error('Error drafting with AI:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Email Triage Dashboard running on port ${PORT}`);
});

# Email Triage Dashboard (`email_triage_dash`)

A streamlined, high-speed Gmail inbox triage application featuring P0/P1 sorting, keyboard shortcuts, AI draft replies (via Anthropic Claude), and direct Google API integration.

## Features

- **Direct Gmail API Integration**: Authenticate securely with Google OAuth2. Reads threads (`in:inbox`), archives, labels P1, and saves drafts directly to Gmail.
- **AI-Powered Replies**: Drafts concise, CEO-style replies using the Anthropic API.
- **Optimized UI**: Fast keyboard-driven workflow (`A` to archive, `S` to skip, `P` to make P1, `R` to reply).

---

## Local Development

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Configure environment variables**:
   Copy `.env.example` to `.env` and fill in your Google OAuth Client credentials and Anthropic API key.
3. **Run the server**:
   ```bash
   npm start
   ```
   Open `http://localhost:8080` in your browser.

---

## Google Cloud Run Deployment

1. **Build and push container image using Cloud Build**:
   ```bash
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/email-triage-dash
   ```
2. **Deploy to Cloud Run**:
   ```bash
   gcloud run deploy email-triage-dash \
     --image gcr.io/YOUR_PROJECT_ID/email-triage-dash \
     --platform managed \
     --region us-central1 \
     --allow-unauthenticated \
     --set-env-vars="GOOGLE_CLIENT_ID=...,GOOGLE_CLIENT_SECRET=...,ANTHROPIC_API_KEY=...,SESSION_SECRET=..."
   ```

---

## GitHub Repository Creation

To create and push this repository to GitHub:
```bash
git init
git add .
git commit -m "Initial commit: email_triage_dash"
gh repo create email_triage_dash --public --source=. --remote=origin --push
```

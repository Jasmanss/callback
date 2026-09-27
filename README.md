# Callback

The job application tracker that follows up. Callback shows every application from wishlist to offer, flags the ones waiting on a reply, and keeps the pipeline honest — rejection emails update statuses, and applications that go silent for 4 months are moved to Ghosted automatically.

**Live at [jasmanss.github.io/callback](https://jasmanss.github.io/callback/).**

Your data stays in your browser (localStorage). There's no account or server. Export a JSON backup to keep a copy or move to another device.

## What it tracks

| Group | Fields |
| --- | --- |
| The job | Company, role, job posting link, location, work mode (remote / hybrid / on-site), salary, where you found it |
| Progress | Status, date applied, follow-up date, priority (low / normal / high) |
| People and materials | Contact name, contact email, resume version sent |
| Notes | Free-form notes (interview questions, prep, who you spoke to) |
| History | Every status change with its date, recorded automatically |

### Stages

| Stage | Meaning |
| --- | --- |
| Wishlist | Saved to apply to later |
| Applied | Sent and waiting to hear back |
| Screening | Recruiter call or assessment |
| Interviewing | In interview rounds |
| Offer | Offer in hand |
| Rejected | They passed |
| Ghosted | No reply, even after following up |
| Withdrawn | You pulled out |

## Features

- **Board view.** Drag cards between stages. Rejected, Ghosted and Withdrawn are grouped in one closed column.
- **Table view.** Sort by any column and filter by status.
- **Auto-ghost, and back again.** Applications in Applied or Screening with no activity for 4 months move to Ghosted automatically when you open the app — announced with an undo, never silently. And if a ghosted company emails again (interview, offer, even a late rejection), Gmail sync moves the application back to the right stage on its own.
- **Needs a follow-up list.** Shows applications whose follow-up date has arrived, and anything still in *Applied* after 14 days with no reminder set. One click sets a reminder for a week out or marks the application ghosted.
- **Summary.** Applications sent, how many heard back, how many reached interviews, offers, and how many you sent this week, plus a bar showing the pipeline by stage.
- **Search** across company, role, location, source, contact and notes.
- **Add from email.** Scan your Gmail (read-only, in your browser — see [docs/gmail-setup.md](docs/gmail-setup.md)) or paste any application email; the tracker recognises confirmations, interview invites, offers and rejections from LinkedIn, Indeed, Greenhouse, Lever, Workday and plain recruiter emails — reading sender addresses, Reply-To headers, sign-offs and footers, and matching follow-ups against companies you already track. Matching applications get a status update instead of a duplicate. Optionally, emails the patterns can't read are sent to Claude under your own API key ([docs/ai-setup.md](docs/ai-setup.md), pennies a month).
- **Import and export.** CSV for spreadsheets, JSON for full backups including history. CSV import recognises common column names such as *Company*, *Position*, *Stage* and *Link*, and skips duplicates.
- **Undo** for moves, deletes, reminders and imports.
- Keyboard shortcuts: <kbd>/</kbd> to search, <kbd>n</kbd> to add an application.
- Light and dark themes follow your system setting.

## Run it locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Build

```bash
npm run build
```

The static site goes to `dist/`. Every push to `main` deploys it to GitHub Pages through `.github/workflows/deploy.yml`.

## Cloud Sync (optional)

An opt-in AWS serverless backend for two things localStorage can't do: using Callback from more than one device, and analytics over your full application history. **Local-only mode is unaffected** — without opting in, nothing contacts AWS and the app works exactly as described above.

**Status: the code and infrastructure definitions in this repo are complete and tested (unit tests, `cdk synth`), but nothing is deployed anywhere.** Cloud Sync does nothing until *you* deploy the stack to your own AWS account and paste its output into the app.

### Architecture

```
Browser ──Cognito JWT──▶ API Gateway (HTTP API, JWT authorizer)
                              │
                              ▼
                    Lambda (applications CRUD) ──▶ DynamoDB (1 table, PK=user, SK=app)
                              │
                        PutEvents on status change
                              ▼
                    EventBridge bus ──rule──▶ SQS ──hourly Lambda──▶ S3 (JSONL, dt= partitions)
                                                                        │
Browser ──▶ Lambda (analytics) ──SQL──▶ Athena ──▶ Glue table (partition projection)
```

- **Cognito** is the only identity system: email + password (10+ chars, email-code confirmation). The DynamoDB partition key is the Cognito `sub`. Google sign-in is a documented next step (add `UserPoolIdentityProviderGoogle` + a hosted UI domain), **not built**.
- **DynamoDB** stores each application as one item with its history embedded — the only read is "everything for this user", one Query, no GSIs.
- **EventBridge → SQS → hourly Lambda → S3**: status changes are emitted as events; the queue buffers them (EventBridge routes but doesn't store); the hourly batcher writes one newline-delimited-JSON file per run under `events/dt=YYYY-MM-DD/`. JSONL over Parquet: correct to write with zero dependencies and natively readable by Athena — at this data volume Parquet's scan savings round to zero (tradeoff commented in `backend/src/handlers/batcher.ts`).
- **Athena + Glue** (partition projection, no crawler) answer the analytics endpoint with real SQL — median days from Applied to first response, grouped by source and by month, always scoped to the caller's verified user id via a bound query parameter.
- Code layout: `infra/` (CDK, one stack, three constructs), `backend/` (Lambda handlers + Vitest tests), `src/cloud/` (frontend auth/API/sync).

### Deploying it (your AWS account, ~10 minutes)

```bash
npm install
npm run check:cloud        # type-checks backend + infra
npx vitest run backend     # handler tests
cd infra
npx cdk bootstrap          # once per account/region (needs AWS credentials configured)
npx cdk deploy
```

`cdk deploy` prints a `CloudConfig` output (JSON with `region`, `clientId`, `apiUrl`). In the app: **Data → Cloud sync & analytics**, paste it, create an account, done. Tear everything down with `npx cdk destroy` (the bucket and table are set to delete with the stack — deliberate for a personal project).

### Idle cost

With no traffic: DynamoDB on-demand, Lambda, HTTP API, EventBridge, SQS and Cognito all bill $0 idle. What's left is the hourly batcher (~720 invocations/month — inside the Lambda free tier, and fractions of a cent without it), S3 storage (a few KB/day of events — well under $0.01/month), and CloudWatch log storage (similar). Athena bills $5/TB scanned per query — at this volume, thousandths of a cent per analytics view, with a 1 GB per-query cap set on the workgroup as a backstop. Realistic idle total: **under $0.05/month**. There is deliberately no VPC/NAT (the classic idle-cost trap) and no Glue crawler.

### Known limitations (honest list)

- **No delete tombstones**: deleting an application on device A while device B still holds it can resurrect it when B pushes. Fixing this means storing tombstones — a reasonable next step, not built.
- **Analytics lag**: events reach S3 on the hourly batch, so the analytics view trails reality by up to an hour.
- **Sync is last-write-wins per application** by `updatedAt` — simultaneous edits to the same application on two devices keep the newer save.
- The Athena query polls up to ~20 s; a cold query that runs longer returns a retry message rather than an answer.

## Tech

React 19, TypeScript, Vite. No UI or state libraries.

```
src/
  App.tsx            app state, actions, layout
  types.ts           data model, stages, labels
  storage.ts         localStorage + record validation
  io.ts              CSV/JSON import and export
  stats.ts           summary numbers and follow-up rules
  dates.ts           date helpers
  sample.ts          fictional sample data
  components/        Board, TableView, Drawer, Summary, Attention, Stamp, EmptyState
```

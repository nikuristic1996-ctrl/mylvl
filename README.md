# mylvl — Real-Life RPG

A mobile-first fitness PWA where real-world movement earns experience and helps your avatar level up.

## Run locally

```bash
npm install
npm run dev
```

For a production build, run `npm run build`.

## Prototype features

- Responsive dashboard with level progression, weekly consistency, activity history and streak overview.
- Avatar appearance customization and activity statistics.
- Manual activity logging with configurable, centralized XP rules.
- Screenshot upload, analysis preview, editable metrics and explicit confirmation before earning XP. Without an analysis endpoint, the UI uses clearly reviewable demo values.
- Duplicate screenshot import protection.
- Local browser persistence for the prototype.
- PWA manifest and offline shell caching.
- Supabase email magic-link sign-in when configured, plus a database schema with row-level security in `supabase/schema.sql`.
- Provider connection states are placeholders. Apple Health, Health Connect, Garmin and Strava are not connected.

## Environment

Copy `.env.example` to `.env.local` and configure the public Supabase URL and anon key to enable authentication. The screenshot analysis endpoint must be a server you control; keep provider API secrets server-side. Its response can include `type`, `date`, `duration`, `distance`, `calories`, `steps`, and `notes`.

The Supabase SQL schema is a foundation for profiles, private activities, experience transactions, progress and integrations. Local prototype activity data remains in the browser; cloud synchronization is a next step.

## Deploy to Vercel

Import the GitHub repository in Vercel. The Vite build command is `npm run build` and the output directory is `dist`. Add Supabase environment variables in the Vercel project settings if cloud sign-in is enabled.

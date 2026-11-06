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
- Supabase email magic-link sign-in, cloud activity and avatar storage when configured, plus the secure database schema in `supabase/schema.sql`.
- Provider connection states are placeholders. Apple Health, Health Connect, Garmin and Strava are not connected.

## Environment

Copy `.env.example` to `.env.local` and configure the Supabase project URL and publishable key to enable authentication and cloud storage. Run `supabase/schema.sql` in the Supabase SQL editor. Add the local development URL and the deployed Vercel URL to Supabase Auth's allowed redirect URLs. Never use a service-role key in the browser. The screenshot analysis endpoint must be a server you control; keep provider API secrets server-side. Its response can include `type`, `date`, `duration`, `distance`, `calories`, `steps`, and `notes`.

With no signed-in account, the prototype saves to local browser storage. Once Supabase is configured and a user signs in, activities and avatar changes use the private cloud tables. Existing local demo data is not uploaded automatically.

## Deploy to Vercel

Import the GitHub repository in Vercel. The Vite build command is `npm run build` and the output directory is `dist`. Add Supabase environment variables in the Vercel project settings if cloud sign-in is enabled.

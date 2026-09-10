# Supabase setup

## 1. Create project
- New Supabase project, region close to Vercel deployment.
- Copy `Project URL` → `SUPABASE_URL`, `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`.

## 2. Run the migration
```bash
supabase link --project-ref <ref>
supabase db push
```
This applies every file in `migrations/` in order: extensions, tables, RLS (deny-all), the `cost_per_day` view, seed rows for the 5 hook families, vector search functions, and the title-feedback tables.

`0005_secure_cost_view.sql` sets `security_invoker` on `cost_per_day` and revokes it from `anon`/`authenticated`. Without it the view runs as its owner and leaks daily spend through the REST API, which is what Supabase's `security_definer_view` lint flags.

## 3. Create the `uploads` storage bucket (one-time, dashboard)
- Storage → New bucket → name `uploads`, **Private**.
- Bucket settings → File size limit: 50 MB. Allowed MIME types: `video/mp4, video/quicktime`.

## 4. Enable 7-day lifecycle on `uploads` (one-time, dashboard or SQL)
Supabase storage lifecycle is configured via the dashboard (Storage → bucket → Configuration → "Delete files older than"). Set to **7 days**.

If the dashboard option is unavailable in your tier, run this SQL as a daily cron from Supabase Edge Functions:
```sql
-- Delete files older than 7 days from the uploads bucket
delete from storage.objects
 where bucket_id = 'uploads'
   and created_at < now() - interval '7 days';
```

## 5. Verify
```sql
-- Should return 5 rows
select id, display_name from hook_families order by id;

-- Should return zero rows but no error (proves vector type works)
select count(*) from corpus_titles;
```

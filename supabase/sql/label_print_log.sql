-- Print history for shipping labels (who / when / from where), plus a DB-level audit of EVERY print_count change.
-- Purpose (Tar 2026-10-16): decide whether a surprising print count is a system fault or a human action.
-- Additive only: new table + new trigger. Does not change shipping_labels data or how counting works.
create table if not exists public.label_print_log (
  id            text primary key default gen_random_uuid()::text,
  printed_at    timestamptz not null default now(),
  action        text not null,            -- 'print_click' (written by the app) | 'db_change' (written by the DB trigger)
  label_id      text,
  label_number  text,
  printed_by    text,                     -- app user name (print_click only)
  printed_by_id text,
  batch_id      text,                     -- one id per click of the print button
  batch_size    int,
  count_before  int,
  count_after   int,
  dialog_ms     int,                      -- how long window.print() blocked; ~0 = dialog did not block / was dismissed at once
  page          text,
  app_version   text,
  client_session text,                    -- random id per browser tab load
  user_agent    text,
  db_role       text,                     -- db_change only: DB role that made the change
  request_origin text,                    -- db_change only: Origin / Referer header of the API call (shows which site/app wrote it)
  note          text
);
create index if not exists label_print_log_label_idx on public.label_print_log (label_id, printed_at desc);
create index if not exists label_print_log_time_idx  on public.label_print_log (printed_at desc);

create or replace function public.trg_log_label_print_count() returns trigger
language plpgsql security definer set search_path = public as $$
declare h jsonb;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  insert into public.label_print_log(action, label_id, label_number, count_before, count_after, db_role, request_origin, user_agent)
  values ('db_change', new.id, new.label_number, old.print_count, new.print_count, current_user,
          coalesce(h->>'origin', h->>'referer'), left(h->>'user-agent', 300));
  return new;
end $$;

drop trigger if exists trg_label_print_count_audit on public.shipping_labels;
create trigger trg_label_print_count_audit
  after update of print_count on public.shipping_labels
  for each row when (old.print_count is distinct from new.print_count)
  execute function public.trg_log_label_print_count();

-- Excel-like sheets inside Marketing Studio (v8.64). Idempotent. RLS ON with NO policies:
-- tables are reachable only through the SECURITY DEFINER functions below, which all check the staff
-- session token (x-ms-token header -> ms_sessions) and derive the user name server-side (cannot be forged).
create table if not exists public.ms_sheets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tabs jsonb not null default '{}'::jsonb,   -- {tabId:{meta:{name,order,rows,cols,colw,rowh,freeze},cells:{"r,c":{v,f,s}}}}
  version bigint not null default 0,
  owner_only boolean not null default false,     -- only role=owner can see/open it
  staff_readonly boolean not null default false, -- staff (admin role) can only view
  created_by text, created_at timestamptz not null default now(),
  updated_by text, updated_at timestamptz not null default now()
);
create table if not exists public.ms_sheet_changes (
  id bigserial primary key,
  sheet_id uuid not null references public.ms_sheets(id) on delete cascade,
  version bigint not null,
  tab_id text, tab_name text,
  cell_key text, cell_ref text,
  old_text text, new_text text,
  new_cell jsonb,
  kind text not null default 'cell',   -- cell (shown in log) | sync (catch-up only, hidden) | bulk (summary, shown) | meta (shown, others reload)
  user_id text, user_name text,
  changed_at timestamptz not null default now()
);
create index if not exists ms_sheet_changes_sheet_ver on public.ms_sheet_changes(sheet_id, version);
create table if not exists public.ms_sheet_backups (
  id bigserial primary key,
  sheet_id uuid not null references public.ms_sheets(id) on delete cascade,
  version bigint not null,
  tabs jsonb not null,
  reason text, created_by text,
  created_at timestamptz not null default now()
);
create index if not exists ms_sheet_backups_sheet on public.ms_sheet_backups(sheet_id, created_at desc);
alter table public.ms_sheets enable row level security;
alter table public.ms_sheet_changes enable row level security;
alter table public.ms_sheet_backups enable row level security;
revoke all on public.ms_sheets, public.ms_sheet_changes, public.ms_sheet_backups from anon, authenticated;

create or replace function public.ms_sheet_a1(r int, c int) returns text language plpgsql immutable as $$
declare s text := ''; n int := c + 1;
begin
  while n > 0 loop s := chr(65 + ((n - 1) % 26)) || s; n := (n - 1) / 26; end loop;
  return s || (r + 1)::text;
end $$;

-- who is calling (from the session token header). Returns null row when invalid or role not owner/admin.
create or replace function public.ms_sheet_actor(out o_id text, out o_name text, out o_role text)
language sql stable security definer set search_path to 'public','extensions' as $$
  select s.user_id, s.user_name, s.role from public.ms_sessions s
  where s.token_hash = encode(digest(coalesce(nullif(current_setting('request.headers', true),'')::json->>'x-ms-token',''),'sha256'),'hex')
    and s.expires_at > now() and s.role in ('owner','admin')
  order by s.created_at desc limit 1
$$;

create or replace function public.ms_sheet_cell_text(c jsonb) returns text language sql immutable as $$
  select case when c is null or c = 'null'::jsonb then null when c ? 'f' and coalesce(c->>'f','')<>'' then c->>'f' else c->>'v' end
$$;

create or replace function public.ms_sheet_list() returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare a record; res jsonb;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'version',version,'owner_only',owner_only,'staff_readonly',staff_readonly,'updated_by',updated_by,'updated_at',updated_at) order by created_at),'[]'::jsonb)
    into res from public.ms_sheets where (a.o_role='owner' or not owner_only);
  return jsonb_build_object('me', jsonb_build_object('id',a.o_id,'name',a.o_name,'role',a.o_role), 'sheets', res);
end $$;

create or replace function public.ms_sheet_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare a record; s public.ms_sheets;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select * into s from public.ms_sheets where id = p_id and (a.o_role='owner' or not owner_only);
  if s.id is null then raise exception 'not found'; end if;
  return jsonb_build_object('id',s.id,'name',s.name,'tabs',s.tabs,'version',s.version,'owner_only',s.owner_only,'staff_readonly',s.staff_readonly,
    'can_edit', (a.o_role='owner' or not s.staff_readonly), 'me', jsonb_build_object('id',a.o_id,'name',a.o_name,'role',a.o_role));
end $$;

create or replace function public.ms_sheet_create(p_name text, p_tabs jsonb default '{}'::jsonb, p_owner_only boolean default false) returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare a record; s public.ms_sheets;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  insert into public.ms_sheets(name,tabs,version,owner_only,created_by,updated_by) values (left(coalesce(nullif(trim(p_name),''),'Untitled'),120), coalesce(p_tabs,'{}'::jsonb), 1, coalesce(p_owner_only,false) and a.o_role='owner', a.o_name, a.o_name) returning * into s;
  insert into public.ms_sheet_changes(sheet_id,version,kind,new_text,user_id,user_name) values (s.id,1,'meta','ສ້າງໄຟລ໌ໃໝ່',a.o_id,a.o_name);
  return jsonb_build_object('id',s.id,'version',s.version);
end $$;

-- Cell-level merge. patch = {"tabs":{"<tabId>":{"del":true} | {"meta":{...},"cells":{"r,c":{...}|null}}}}
create or replace function public.ms_sheet_apply(p_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare a record; s public.ms_sheets; ver bigint; v_tabs jsonb; t_id text; tp jsonb; ocells jsonb; ncells jsonb; k text; c jsonb;
  nulls text[]; nn int := 0; total int := 0; cr int; cc int; bulk boolean; tname text; structural boolean := false;
  parts text[]; otxt text; ntxt text; nt jsonb; nnotes int := 0; nn_t int;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select * into s from public.ms_sheets where id = p_id and (a.o_role='owner' or not owner_only) for update;
  if s.id is null then raise exception 'not found'; end if;
  if s.staff_readonly and a.o_role <> 'owner' then raise exception 'read only'; end if;
  -- daily backup (Laos date) before the first change of the day
  if not exists (select 1 from public.ms_sheet_backups b where b.sheet_id = s.id and (b.created_at at time zone 'Asia/Vientiane')::date = (now() at time zone 'Asia/Vientiane')::date) then
    insert into public.ms_sheet_backups(sheet_id,version,tabs,reason,created_by) values (s.id,s.version,s.tabs,'daily',a.o_name);
    delete from public.ms_sheet_backups where sheet_id = s.id and id not in (select id from public.ms_sheet_backups where sheet_id = s.id order by created_at desc limit 40);
  end if;
  ver := s.version + 1; v_tabs := s.tabs;
  -- count cells to decide log style
  for t_id, tp in select * from jsonb_each(coalesce(p_patch->'tabs','{}'::jsonb)) loop
    if tp ? 'cells' then total := total + (select count(*) from jsonb_object_keys(tp->'cells')); end if;
  end loop;
  bulk := total > 400;
  for t_id, tp in select * from jsonb_each(coalesce(p_patch->'tabs','{}'::jsonb)) loop
    if coalesce(tp->>'del','') = 'true' then
      tname := v_tabs->t_id->'meta'->>'name';
      v_tabs := v_tabs - t_id; structural := true;
      insert into public.ms_sheet_changes(sheet_id,version,tab_id,tab_name,kind,new_text,user_id,user_name) values (s.id,ver,t_id,tname,'meta','ລົບແຜ່ນງານ',a.o_id,a.o_name);
      continue;
    end if;
    if not (v_tabs ? t_id) then
      v_tabs := jsonb_set(v_tabs, array[t_id], jsonb_build_object('meta','{}'::jsonb,'cells','{}'::jsonb));
      structural := true;
      insert into public.ms_sheet_changes(sheet_id,version,tab_id,tab_name,kind,new_text,user_id,user_name) values (s.id,ver,t_id,tp#>>'{meta,name}','meta','ເພີ່ມແຜ່ນງານ',a.o_id,a.o_name);
    end if;
    if tp ? 'meta' then
      if (v_tabs->t_id->'meta'->>'name') is distinct from (tp#>>'{meta,name}') and (tp#>>'{meta,name}') is not null and (v_tabs->t_id->'meta'->>'name') is not null then
        insert into public.ms_sheet_changes(sheet_id,version,tab_id,tab_name,kind,old_text,new_text,user_id,user_name) values (s.id,ver,t_id,tp#>>'{meta,name}','meta',v_tabs->t_id->'meta'->>'name',tp#>>'{meta,name}',a.o_id,a.o_name);
      end if;
      v_tabs := jsonb_set(v_tabs, array[t_id,'meta'], coalesce(v_tabs->t_id->'meta','{}'::jsonb) || (tp->'meta'));
      structural := true; -- column widths / freeze / rename: other people reload (cheap, rare)
    end if;
    if tp ? 'cells' then
      tname := v_tabs->t_id->'meta'->>'name';
      ocells := coalesce(v_tabs->t_id->'cells','{}'::jsonb);
      nulls := array[]::text[]; ncells := '{}'::jsonb;
      if bulk then
        -- v8.69: big patches (row/column delete shifts thousands of cells) are merged set-based, with no per-cell log rows.
        -- (the old per-cell loop took ~14 s for 6000 cells -> hit the 3 s anon statement timeout -> the save was lost)
        select count(*) into nn_t from jsonb_each(tp->'cells') p left join jsonb_each(ocells) o on o.key = p.key
          where public.ms_sheet_cell_text(p.value) is distinct from public.ms_sheet_cell_text(o.value);
        nn := nn + nn_t;
        select coalesce(jsonb_object_agg(key, value) filter (where value <> 'null'::jsonb), '{}'::jsonb), coalesce(array_agg(key) filter (where value = 'null'::jsonb), array[]::text[])
          into ncells, nulls from jsonb_each(tp->'cells');
      else
      for k, c in select * from jsonb_each(tp->'cells') loop
        if c = 'null'::jsonb then nulls := nulls || k; else ncells := ncells || jsonb_build_object(k, c); end if;
        otxt := public.ms_sheet_cell_text(ocells->k);
        ntxt := public.ms_sheet_cell_text(c);
        if otxt is distinct from ntxt then
          parts := string_to_array(k, ',');
          insert into public.ms_sheet_changes(sheet_id,version,tab_id,tab_name,cell_key,cell_ref,old_text,new_text,new_cell,kind,user_id,user_name)
            values (s.id,ver,t_id,tname,k,public.ms_sheet_a1(parts[1]::int,parts[2]::int),left(otxt,500),left(ntxt,500),c,case when bulk then 'sync' else 'cell' end,a.o_id,a.o_name);
          nn := nn + 1;
        else
          -- style-only change: still must reach other people
          insert into public.ms_sheet_changes(sheet_id,version,tab_id,tab_name,cell_key,cell_ref,new_cell,kind,user_id,user_name)
            values (s.id,ver,t_id,tname,k,null,c,'sync',a.o_id,a.o_name);
        end if;
      end loop;
      end if;
      ocells := (ocells || ncells);
      if array_length(nulls,1) is not null then ocells := ocells - nulls; end if;
      v_tabs := jsonb_set(v_tabs, array[t_id,'cells'], ocells);
    end if;
  end loop;
  if bulk then
    insert into public.ms_sheet_changes(sheet_id,version,kind,new_text,user_id,user_name) values (s.id,ver,'bulk',
      case when nn > 0 then 'ແກ້ໄຂຫຼາຍຊ່ອງພ້ອມກັນ ('||nn||' ຊ່ອງ)' else 'ປ່ຽນຮູບແບບຫຼາຍຊ່ອງພ້ອມກັນ ('||total||' ຊ່ອງ)' end, a.o_id,a.o_name);
    if nn > 400 then   -- big destructive/shifting edit: keep the state from before it (owner can restore)
      insert into public.ms_sheet_backups(sheet_id,version,tabs,reason,created_by) values (s.id,s.version,s.tabs,'before-bulk',a.o_name);
      delete from public.ms_sheet_backups where sheet_id = s.id and id not in (select id from public.ms_sheet_backups where sheet_id = s.id order by created_at desc limit 40);
    end if;
  end if;
  -- v8.69: the client describes structural actions (delete row 12 + what was in it, column width, ...) as notes
  for nt in select * from jsonb_array_elements(case when jsonb_typeof(p_patch->'notes')='array' then p_patch->'notes' else '[]'::jsonb end) limit 60 loop
    if coalesce(nt->>'t','') <> '' then
      nnotes := nnotes + 1;
      insert into public.ms_sheet_changes(sheet_id,version,tab_name,kind,new_text,user_id,user_name) values (s.id,ver,left(nt->>'tab',100),'meta',left(nt->>'t',700),a.o_id,a.o_name);
    end if;
  end loop;
  if nnotes > 0 then structural := true; end if;
  if structural and nnotes = 0 then
    insert into public.ms_sheet_changes(sheet_id,version,kind,new_text,user_id,user_name) values (s.id,ver,'meta','ປ່ຽນໂຄງສ້າງ/ຮູບແບບຕາຕະລາງ',a.o_id,a.o_name);
  end if;
  update public.ms_sheets set tabs = v_tabs, version = ver, updated_by = a.o_name, updated_at = now() where id = s.id;
  return jsonb_build_object('version', ver, 'structural', structural);
end $$;

-- Changes by others since a version. full=true => client must reload everything (structure changed or too many).
create or replace function public.ms_sheet_since(p_id uuid, p_since bigint) returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare a record; s public.ms_sheets; res jsonb; cnt int;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select * into s from public.ms_sheets where id = p_id and (a.o_role='owner' or not owner_only);
  if s.id is null then raise exception 'not found'; end if;
  if s.version = p_since then return jsonb_build_object('version',s.version,'full',false,'changes','[]'::jsonb); end if;
  if exists (select 1 from public.ms_sheet_changes where sheet_id = p_id and version > p_since and kind in ('meta','bulk')) then
    return jsonb_build_object('version',s.version,'full',true);
  end if;
  select count(*) into cnt from public.ms_sheet_changes where sheet_id = p_id and version > p_since and cell_key is not null;
  if cnt > 4000 then return jsonb_build_object('version',s.version,'full',true); end if;
  select coalesce(jsonb_agg(jsonb_build_object('tab',tab_id,'key',cell_key,'cell',new_cell,'by',user_name)),'[]'::jsonb) into res
  from (select distinct on (tab_id, cell_key) tab_id, cell_key, new_cell, user_name from public.ms_sheet_changes
        where sheet_id = p_id and version > p_since and cell_key is not null order by tab_id, cell_key, version desc) x;
  return jsonb_build_object('version',s.version,'full',false,'changes',res);
end $$;

create or replace function public.ms_sheet_log(p_id uuid, p_limit int default 200, p_before bigint default null) returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare a record; res jsonb;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.ms_sheets where id = p_id and (a.o_role='owner' or not owner_only)) then raise exception 'not found'; end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]'::jsonb) into res from (
    select id, version, tab_name, cell_ref, old_text, new_text, kind, user_name, changed_at from public.ms_sheet_changes
    where sheet_id = p_id and kind in ('cell','bulk','meta') and (p_before is null or id < p_before)
    order by id desc limit least(coalesce(p_limit,200),500)) x;
  return res;
end $$;

-- Replace the whole content (xlsx import). Backs up first. Everyone else reloads.
create or replace function public.ms_sheet_replace(p_id uuid, p_tabs jsonb, p_label text default 'ນຳເຂົ້າໄຟລ໌') returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare a record; s public.ms_sheets; ver bigint;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select * into s from public.ms_sheets where id = p_id and (a.o_role='owner' or not owner_only) for update;
  if s.id is null then raise exception 'not found'; end if;
  if s.staff_readonly and a.o_role <> 'owner' then raise exception 'read only'; end if;
  insert into public.ms_sheet_backups(sheet_id,version,tabs,reason,created_by) values (s.id,s.version,s.tabs,'replace',a.o_name);
  delete from public.ms_sheet_backups where sheet_id = s.id and id not in (select id from public.ms_sheet_backups where sheet_id = s.id order by created_at desc limit 40);
  ver := s.version + 1;
  update public.ms_sheets set tabs = p_tabs, version = ver, updated_by = a.o_name, updated_at = now() where id = s.id;
  insert into public.ms_sheet_changes(sheet_id,version,kind,new_text,user_id,user_name) values (s.id,ver,'meta',left(p_label,200),a.o_id,a.o_name);
  return jsonb_build_object('version', ver);
end $$;

create or replace function public.ms_sheet_backups_list(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare a record;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null or a.o_role <> 'owner' then raise exception 'not allowed'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'version',version,'reason',reason,'by',created_by,'at',created_at) order by created_at desc) from public.ms_sheet_backups where sheet_id = p_id),'[]'::jsonb);
end $$;

create or replace function public.ms_sheet_restore(p_backup bigint) returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare a record; b public.ms_sheet_backups; ver bigint;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null or a.o_role <> 'owner' then raise exception 'not allowed'; end if;
  select * into b from public.ms_sheet_backups where id = p_backup;
  if b.id is null then raise exception 'not found'; end if;
  insert into public.ms_sheet_backups(sheet_id,version,tabs,reason,created_by) select id,version,tabs,'before-restore',a.o_name from public.ms_sheets where id = b.sheet_id;
  update public.ms_sheets set tabs = b.tabs, version = version + 1, updated_by = a.o_name, updated_at = now() where id = b.sheet_id returning version into ver;
  insert into public.ms_sheet_changes(sheet_id,version,kind,new_text,user_id,user_name) values (b.sheet_id,ver,'meta','ຍ້ອນກັບໄປເວີຊັນຂອງ '||to_char(b.created_at at time zone 'Asia/Vientiane','DD/MM/YYYY HH24:MI'),a.o_id,a.o_name);
  return jsonb_build_object('version', ver);
end $$;

create or replace function public.ms_sheet_set_flags(p_id uuid, p_owner_only boolean, p_staff_readonly boolean, p_name text default null) returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare a record;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null or a.o_role <> 'owner' then raise exception 'not allowed'; end if;
  update public.ms_sheets set owner_only = coalesce(p_owner_only,owner_only), staff_readonly = coalesce(p_staff_readonly,staff_readonly), name = coalesce(nullif(trim(p_name),''),name) where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.ms_sheet_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare a record;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null or a.o_role <> 'owner' then raise exception 'not allowed'; end if;
  delete from public.ms_sheets where id = p_id;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.ms_sheet_actor(), public.ms_sheet_list(), public.ms_sheet_get(uuid), public.ms_sheet_create(text,jsonb,boolean), public.ms_sheet_apply(uuid,jsonb), public.ms_sheet_since(uuid,bigint), public.ms_sheet_log(uuid,int,bigint), public.ms_sheet_replace(uuid,jsonb,text), public.ms_sheet_backups_list(uuid), public.ms_sheet_restore(bigint), public.ms_sheet_set_flags(uuid,boolean,boolean,text), public.ms_sheet_delete(uuid) to anon, authenticated;

-- ===== v8.70: file manager (trash instead of instant delete, rename, per-file info) =====
alter table public.ms_sheets add column if not exists deleted_at timestamptz;
alter table public.ms_sheets add column if not exists deleted_by text;

create or replace function public.ms_sheet_list() returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare a record; res jsonb;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'version',version,'owner_only',owner_only,'staff_readonly',staff_readonly,'updated_by',updated_by,'updated_at',updated_at) order by created_at),'[]'::jsonb)
    into res from public.ms_sheets where deleted_at is null and (a.o_role='owner' or not owner_only);
  return jsonb_build_object('me', jsonb_build_object('id',a.o_id,'name',a.o_name,'role',a.o_role), 'sheets', res);
end $$;

create or replace function public.ms_sheet_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare a record; s public.ms_sheets;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select * into s from public.ms_sheets where id = p_id and deleted_at is null and (a.o_role='owner' or not owner_only);
  if s.id is null then raise exception 'not found'; end if;
  return jsonb_build_object('id',s.id,'name',s.name,'tabs',s.tabs,'version',s.version,'owner_only',s.owner_only,'staff_readonly',s.staff_readonly,
    'can_edit', (a.o_role='owner' or not s.staff_readonly), 'me', jsonb_build_object('id',a.o_id,'name',a.o_name,'role',a.o_role));
end $$;

-- every file the caller may see, trash included. can_manage = owner, or the account that created it.
create or replace function public.ms_sheet_files() returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare a record; res jsonb;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'version',version,'owner_only',owner_only,'staff_readonly',staff_readonly,
      'created_by',created_by,'created_at',created_at,'updated_by',updated_by,'updated_at',updated_at,'bytes',pg_column_size(tabs),
      'tabs',(select count(*) from jsonb_object_keys(tabs)),'deleted_at',deleted_at,'deleted_by',deleted_by,
      'can_manage',(a.o_role='owner' or created_by = a.o_name)) order by deleted_at is not null, created_at),'[]'::jsonb)
    into res from public.ms_sheets where (a.o_role='owner' or not owner_only);
  return jsonb_build_object('me', jsonb_build_object('id',a.o_id,'name',a.o_name,'role',a.o_role), 'files', res);
end $$;

create or replace function public.ms_sheet_rename(p_id uuid, p_name text) returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare a record; s public.ms_sheets; nn text;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  nn := left(nullif(trim(p_name),''),120);
  if nn is null then raise exception 'empty name'; end if;
  select * into s from public.ms_sheets where id = p_id and (a.o_role='owner' or not owner_only);
  if s.id is null then raise exception 'not found'; end if;
  if not (a.o_role='owner' or s.created_by = a.o_name) then raise exception 'not allowed'; end if;
  update public.ms_sheets set name = nn where id = p_id;
  insert into public.ms_sheet_changes(sheet_id,version,kind,old_text,new_text,user_id,user_name) values (p_id,s.version,'meta',s.name,nn,a.o_id,a.o_name);
  return jsonb_build_object('ok', true);
end $$;

-- soft delete: file goes to the trash (still restorable); p_trash=false brings it back
create or replace function public.ms_sheet_trash(p_id uuid, p_trash boolean default true) returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare a record; s public.ms_sheets;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select * into s from public.ms_sheets where id = p_id and (a.o_role='owner' or not owner_only);
  if s.id is null then raise exception 'not found'; end if;
  if not (a.o_role='owner' or s.created_by = a.o_name) then raise exception 'not allowed'; end if;
  if p_trash then
    update public.ms_sheets set deleted_at = now(), deleted_by = a.o_name where id = p_id;
  else
    update public.ms_sheets set deleted_at = null, deleted_by = null where id = p_id;
  end if;
  insert into public.ms_sheet_changes(sheet_id,version,kind,new_text,user_id,user_name) values (p_id,s.version,'meta', case when p_trash then 'ຍ້າຍໄຟລ໌ໄປຖັງຂີ້ເຫຍື້ອ' else 'ກູ້ໄຟລ໌ຄືນຈາກຖັງຂີ້ເຫຍື້ອ' end,a.o_id,a.o_name);
  return jsonb_build_object('ok', true);
end $$;

-- permanent delete: owner only, and only for a file that is already in the trash
create or replace function public.ms_sheet_purge(p_id uuid) returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare a record;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null or a.o_role <> 'owner' then raise exception 'not allowed'; end if;
  delete from public.ms_sheets where id = p_id and deleted_at is not null;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.ms_sheet_files(), public.ms_sheet_rename(uuid,text), public.ms_sheet_trash(uuid,boolean), public.ms_sheet_purge(uuid) to anon, authenticated;

-- ===== v8.71: per-file account access (creator/owner picks which accounts can open / edit a file) =====
alter table public.ms_sheets add column if not exists restricted boolean not null default false;
create table if not exists public.ms_sheet_access (
  sheet_id uuid not null references public.ms_sheets(id) on delete cascade,
  user_id text not null,
  can_edit boolean not null default true,
  primary key (sheet_id, user_id)
);
alter table public.ms_sheet_access enable row level security;
revoke all on public.ms_sheet_access from anon, authenticated;

-- may this account SEE the file? owner role always; creator always; otherwise not owner_only and (unrestricted or listed)
create or replace function public.ms_sheet_vis(s public.ms_sheets, uid text, uname text, urole text) returns boolean
language sql stable security definer set search_path to 'public','extensions' as $$
  select urole = 'owner' or (not s.owner_only and (not s.restricted or s.created_by = uname
         or exists (select 1 from public.ms_sheet_access x where x.sheet_id = s.id and x.user_id = uid)))
$$;
-- may this account EDIT the file?
create or replace function public.ms_sheet_edit(s public.ms_sheets, uid text, uname text, urole text) returns boolean
language sql stable security definer set search_path to 'public','extensions' as $$
  select urole = 'owner' or s.created_by = uname
      or (case when s.restricted then exists (select 1 from public.ms_sheet_access x where x.sheet_id = s.id and x.user_id = uid and x.can_edit)
               else not s.staff_readonly end)
$$;
revoke all on function public.ms_sheet_vis(public.ms_sheets,text,text,text), public.ms_sheet_edit(public.ms_sheets,text,text,text) from public, anon, authenticated;

-- patch every existing function that decides visibility / editing (idempotent: patterns vanish after the first run)
do $$
declare fn text; def text; nd text; n int := 0;
begin
  foreach fn in array array['ms_sheet_list','ms_sheet_get','ms_sheet_files','ms_sheet_apply','ms_sheet_since','ms_sheet_log','ms_sheet_replace','ms_sheet_rename','ms_sheet_trash','ms_sheet_backups_list','ms_sheet_restore'] loop
    select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname=fn limit 1;
    if def is null then continue; end if;
    nd := replace(def, '(a.o_role=''owner'' or not owner_only)', 'public.ms_sheet_vis(ms_sheets,a.o_id,a.o_name,a.o_role)');
    nd := replace(nd, 's.staff_readonly and a.o_role <> ''owner''', 'not public.ms_sheet_edit(s,a.o_id,a.o_name,a.o_role)');
    nd := replace(nd, '(a.o_role=''owner'' or not s.staff_readonly)', 'public.ms_sheet_edit(s,a.o_id,a.o_name,a.o_role)');
    if nd <> def then execute nd; n := n + 1; end if;
  end loop;
  raise notice 'patched % functions', n;
end $$;

create or replace function public.ms_sheet_access_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare a record; s public.ms_sheets;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select * into s from public.ms_sheets where id = p_id;
  if s.id is null or not public.ms_sheet_vis(s,a.o_id,a.o_name,a.o_role) then raise exception 'not found'; end if;
  if not (a.o_role='owner' or s.created_by = a.o_name) then raise exception 'not allowed'; end if;
  return jsonb_build_object('restricted', s.restricted, 'creator', s.created_by,
    'users', (select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'role',u.role,'listed',x.user_id is not null,'can_edit',coalesce(x.can_edit,true)) order by u.role<>'owner', u.name),'[]'::jsonb)
              from public.users u left join public.ms_sheet_access x on x.sheet_id = p_id and x.user_id = u.id where u.role in ('owner','admin')));
end $$;

create or replace function public.ms_sheet_access_set(p_id uuid, p_restricted boolean, p_users jsonb) returns jsonb
language plpgsql security definer set search_path to 'public','extensions' as $$
declare a record; s public.ms_sheets; names text;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select * into s from public.ms_sheets where id = p_id;
  if s.id is null or not public.ms_sheet_vis(s,a.o_id,a.o_name,a.o_role) then raise exception 'not found'; end if;
  if not (a.o_role='owner' or s.created_by = a.o_name) then raise exception 'not allowed'; end if;
  delete from public.ms_sheet_access where sheet_id = p_id;
  if coalesce(p_restricted,false) then
    insert into public.ms_sheet_access(sheet_id,user_id,can_edit)
      select p_id, u.id, coalesce((e->>'can_edit')::boolean,true)
      from jsonb_array_elements(coalesce(p_users,'[]'::jsonb)) e join public.users u on u.id = e->>'id' where u.role in ('owner','admin')
      on conflict do nothing;
  end if;
  update public.ms_sheets set restricted = coalesce(p_restricted,false) where id = p_id;
  select string_agg(u.name || case when x.can_edit then '' else ' (ເບິ່ງຢ່າງດຽວ)' end, ', ' order by u.name) into names
    from public.ms_sheet_access x join public.users u on u.id = x.user_id where x.sheet_id = p_id;
  insert into public.ms_sheet_changes(sheet_id,version,kind,new_text,user_id,user_name) values (p_id,s.version,'meta',
    case when coalesce(p_restricted,false) then 'ກຳນົດສິດເຂົ້າເຖິງໄຟລ໌: ສະເພາະເຈົ້າຂອງ, ຜູ້ສ້າງ'||coalesce(', '||names,'') else 'ເປີດໃຫ້ທຸກບັນຊີເຂົ້າເຖິງໄຟລ໌' end, a.o_id, a.o_name);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.ms_sheet_access_get(uuid), public.ms_sheet_access_set(uuid,boolean,jsonb) to anon, authenticated;

create or replace function public.ms_sheet_files() returns jsonb
language plpgsql stable security definer set search_path to 'public','extensions' as $$
declare a record; res jsonb;
begin
  select * into a from public.ms_sheet_actor();
  if a.o_id is null then raise exception 'not allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'version',version,'owner_only',owner_only,'staff_readonly',staff_readonly,
      'created_by',created_by,'created_at',created_at,'updated_by',updated_by,'updated_at',updated_at,'bytes',pg_column_size(tabs),
      'tabs',(select count(*) from jsonb_object_keys(tabs)),'deleted_at',deleted_at,'deleted_by',deleted_by,
      'restricted',restricted,'access_n',(select count(*) from public.ms_sheet_access x where x.sheet_id = ms_sheets.id),
      'can_edit',public.ms_sheet_edit(ms_sheets,a.o_id,a.o_name,a.o_role),
      'can_manage',(a.o_role='owner' or created_by = a.o_name)) order by deleted_at is not null, created_at),'[]'::jsonb)
    into res from public.ms_sheets where public.ms_sheet_vis(ms_sheets,a.o_id,a.o_name,a.o_role);
  return jsonb_build_object('me', jsonb_build_object('id',a.o_id,'name',a.o_name,'role',a.o_role), 'files', res);
end $$;

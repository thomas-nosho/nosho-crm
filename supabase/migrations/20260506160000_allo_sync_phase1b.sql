-- Allo ↔ Nosho-CRM sync — Phase 1b: align process_allo_call with the
-- real Allo (Svix) webhook payload.
--
-- Phase 1 was authored against an anticipated schema. The actual call.completed
-- envelope is {topic, version, timestamp, data: {id, start_date, from_number,
-- from_name, to, to_name, length_in_minutes, length, type INBOUND/OUTBOUND,
-- result ANSWERED/VOICEMAIL/..., summary, concatenated_transcript,
-- transcriptions[], data_collected{}, transfer_from{}, transfer_to{},
-- ivr_result[], tag, tags[], user_email, original_to_number, ...}}.
--
-- This migration:
--   1. extends call_logs with the Allo-native fields,
--   2. rewrites process_allo_call to read those fields directly,
--   3. computes ended_at = start_date + length_in_minutes (Allo doesn't send it),
--   4. drops the data.contact_id branch (Allo doesn't include it on calls).

alter table public.call_logs
  add column if not exists tag                 text,
  add column if not exists tags                jsonb,
  add column if not exists length_text         text,
  add column if not exists summary_short       text,
  add column if not exists transcriptions      jsonb,
  add column if not exists data_collected      jsonb,
  add column if not exists transfer_from       jsonb,
  add column if not exists transfer_to         jsonb,
  add column if not exists ivr_result          jsonb,
  add column if not exists user_email          text,
  add column if not exists original_to_number  text,
  add column if not exists original_to_name    text,
  add column if not exists from_name           text,
  add column if not exists to_name             text,
  add column if not exists payload_version     text;

create or replace function public.process_allo_call(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_data            jsonb       := coalesce(p_payload -> 'data', p_payload);
  v_call_id         text        := v_data ->> 'id';
  v_type            text        := upper(coalesce(v_data ->> 'type', 'INBOUND'));
  v_direction       text        := case when v_type = 'OUTBOUND' then 'outbound' else 'inbound' end;
  v_from            text        := v_data ->> 'from_number';
  v_to              text        := v_data ->> 'to';
  v_from_name       text        := nullif(v_data ->> 'from_name', '');
  v_to_name         text        := nullif(v_data ->> 'to_name', '');
  v_line_phone      text;
  v_started_at      timestamptz := nullif(v_data ->> 'start_date', '')::timestamptz;
  v_length_minutes  numeric     := nullif(v_data ->> 'length_in_minutes', '')::numeric;
  v_duration_secs   integer     := case when v_length_minutes is not null then (v_length_minutes * 60)::integer end;
  v_ended_at        timestamptz := case
                                     when v_started_at is not null and v_length_minutes is not null
                                       then v_started_at + make_interval(secs => v_length_minutes * 60)
                                   end;
  v_external_phone  text;
  v_external_norm   text;
  v_sales_id        bigint;
  v_contact_id      bigint;
  v_deal_id         bigint;
  v_lead_tag_id     bigint;
  v_existing        public.call_logs%rowtype;
  v_inserted_id     bigint;
  v_was_inserted    boolean := false;
  v_contact_created boolean := false;
begin
  if v_call_id is null or v_call_id = '' then
    raise exception 'process_allo_call: payload missing data.id';
  end if;

  -- Idempotent re-delivery.
  select * into v_existing from public.call_logs where allo_call_id = v_call_id;
  if found then
    return jsonb_build_object(
      'call_log_id',     v_existing.id,
      'contact_id',      v_existing.contact_id,
      'sales_id',        v_existing.sales_id,
      'deal_id',         v_existing.deal_id,
      'inserted',        false,
      'contact_created', false
    );
  end if;

  -- Allo line = the local side of the call (outbound: from_number; inbound: to).
  v_line_phone := case when v_direction = 'outbound' then v_from else v_to end;

  select lo.sales_id into v_sales_id
    from public.allo_line_owners lo
   where public.allo_normalize_phone(lo.allo_phone_number)
       = public.allo_normalize_phone(v_line_phone)
   limit 1;

  -- Counterparty phone — used for contact matching.
  v_external_phone := case when v_direction = 'outbound' then v_to else v_from end;
  v_external_norm  := public.allo_normalize_phone(v_external_phone);

  -- Match an existing CRM contact by normalized phone (Allo doesn't include
  -- a contact id on call payloads, so the pivot doesn't help here).
  if v_external_norm is not null then
    select c.id into v_contact_id
      from public.contacts c
      cross join lateral jsonb_array_elements(coalesce(c.phone_jsonb, '[]'::jsonb)) as phones(phone_obj)
     where public.allo_normalize_phone(phones.phone_obj ->> 'number') = v_external_norm
     order by c.id
     limit 1;
  end if;

  -- No match → auto-create a contact tagged 'lead-from-allo'.
  if v_contact_id is null then
    select id into v_lead_tag_id from public.tags where name = 'lead-from-allo' limit 1;

    insert into public.contacts (
      first_name,
      last_name,
      sales_id,
      phone_jsonb,
      tags,
      first_seen,
      last_seen,
      _sync_origin
    ) values (
      coalesce(v_from_name, 'Allo'),
      coalesce(v_external_phone, 'Unknown'),
      v_sales_id,
      case
        when v_external_phone is null then '[]'::jsonb
        else jsonb_build_array(jsonb_build_object('number', v_external_phone, 'type', 'Mobile'))
      end,
      case when v_lead_tag_id is null then '{}'::bigint[] else array[v_lead_tag_id] end,
      coalesce(v_started_at, now()),
      coalesce(v_ended_at, v_started_at, now()),
      'allo'
    )
    returning id into v_contact_id;

    v_contact_created := true;
  end if;

  -- Active deal attach.
  select d.id into v_deal_id
    from public.deals d
   where d.archived_at is null
     and d.contact_ids @> array[v_contact_id]
   order by d.updated_at desc, d.id desc
   limit 1;

  insert into public.call_logs (
    allo_call_id,
    direction,
    from_number,
    to_number,
    from_name,
    to_name,
    line_phone,
    status,
    duration_seconds,
    started_at,
    ended_at,
    recording_url,
    ai_summary,
    transcript,
    tag,
    tags,
    length_text,
    summary_short,
    transcriptions,
    data_collected,
    transfer_from,
    transfer_to,
    ivr_result,
    user_email,
    original_to_number,
    original_to_name,
    payload_version,
    contact_id,
    sales_id,
    deal_id,
    raw_payload
  ) values (
    v_call_id,
    v_direction,
    v_from,
    v_to,
    v_from_name,
    v_to_name,
    v_line_phone,
    v_data ->> 'result',
    v_duration_secs,
    v_started_at,
    v_ended_at,
    v_data ->> 'recording_url',
    v_data ->> 'summary',
    v_data ->> 'concatenated_transcript',
    v_data ->> 'tag',
    v_data -> 'tags',
    v_data ->> 'length',
    v_data ->> 'one_sentence_summary',
    v_data -> 'transcriptions',
    v_data -> 'data_collected',
    v_data -> 'transfer_from',
    v_data -> 'transfer_to',
    v_data -> 'ivr_result',
    v_data ->> 'user_email',
    v_data ->> 'original_to_number',
    v_data ->> 'original_to_name',
    p_payload ->> 'version',
    v_contact_id,
    v_sales_id,
    v_deal_id,
    p_payload
  )
  on conflict (allo_call_id) do nothing
  returning id into v_inserted_id;

  v_was_inserted := v_inserted_id is not null;

  if v_inserted_id is null then
    select id into v_inserted_id from public.call_logs where allo_call_id = v_call_id;
  end if;

  return jsonb_build_object(
    'call_log_id',     v_inserted_id,
    'contact_id',      v_contact_id,
    'sales_id',        v_sales_id,
    'deal_id',         v_deal_id,
    'inserted',        v_was_inserted,
    'contact_created', v_contact_created
  );
end;
$$;

grant all on function public.process_allo_call(jsonb) to service_role;
grant all on function public.process_allo_call(jsonb) to authenticated;
revoke all on function public.process_allo_call(jsonb) from public;

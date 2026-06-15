alter table calls
  add column if not exists direction text not null default 'inbound',
  add column if not exists recording_url text;

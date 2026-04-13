-- ─── Tenants ──────────────────────────────────────────────────────────────────

create table tenants (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  phone_number text not null unique,    -- matched to Twilio From field
  email text,
  lot_number text not null unique,
  lot_rent_amount numeric(10,2) not null,
  move_in_date date not null,
  balance_due numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on tenants (phone_number);

create trigger tenants_updated_at
  before update on tenants
  for each row execute function touch_updated_at();


-- ─── Payments ─────────────────────────────────────────────────────────────────

create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  amount numeric(10,2) not null,
  payment_date date not null,
  month_year text not null,   -- e.g. "2025-04" (YYYY-MM)
  status text not null default 'paid',  -- 'paid', 'partial', 'waived'
  notes text,
  created_at timestamptz not null default now()
);

create index on payments (tenant_id);
create index on payments (month_year);


-- ─── Payments view (joins tenant name for display) ────────────────────────────

create view payments_with_tenant as
  select
    p.id,
    p.tenant_id,
    p.amount,
    p.payment_date,
    p.month_year,
    p.status,
    p.notes,
    p.created_at,
    t.first_name,
    t.last_name,
    t.lot_number
  from payments p
  join tenants t on t.id = p.tenant_id
  order by p.payment_date desc;

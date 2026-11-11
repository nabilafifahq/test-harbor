-- ERP snapshot (loaded from data/erp/*.csv)
create table customers (customer_id text primary key, name text not null, payment_terms text, credit_limit numeric(12,2) not null, open_balance numeric(12,2) not null, status text not null);
create table customer_contacts (customer_id text references customers, name text, email text, role text);
create table ship_to_addresses (ship_to_id text primary key, customer_id text references customers, name text, address text, is_default boolean);
create table products (sku text primary key, name text not null, category text, sell_uom text not null, pack text, list_price numeric(12,2) not null, status text not null, replaced_by text);
create table customer_prices (customer_id text, sku text, unit_price numeric(12,2) not null, valid_from date, valid_to date);
create table inventory (sku text primary key references products, on_hand int not null, allocated int not null, available int not null check (available >= 0));
create table incoming_supply (supplier_po text, sku text, qty int, expected_date date);
create table sales_orders (so_number text primary key, customer_id text references customers, ship_to_id text, customer_po text, order_date date, requested_date date, status text not null, source_email text, created_by text);
create table sales_order_lines (so_number text references sales_orders, line_no int, sku text, qty_ordered int not null, qty_shipped int not null default 0, unit_price numeric(12,2) not null, primary key (so_number, line_no));

-- Inbox and tickets
create table emails (email_id text primary key, ticket_no text unique, received_at timestamptz not null, from_name text, from_email text, subject text, body text, attachments jsonb not null default '[]', message_id text);
-- The same mail delivered again. The sender sets the Message-ID, so the sender and the text must match too: a reused ID cannot hide other mail.
create unique index emails_same_mail on emails (message_id, from_email, md5(body));
create table cases (
  email_id text primary key references emails,
  ticket_no text unique,
  intent text, label text, customer_id text,
  lane text not null,                     -- agent routing: auto_committed, needs_review, waiting_on_customer, no_action
  status text not null default 'new',     -- ticket: new, open, pending_customer, resolved, closed
  erp_status text not null default 'none',-- none, committed
  priority text not null default 'normal',
  sla_due_at timestamptz,
  assignee text,
  approver_role text, summary text,
  flags jsonb not null default '[]', checks jsonb not null default '[]',
  proposal jsonb not null default '{}', trace jsonb not null default '[]',
  model text, row_version int not null default 1, updated_at timestamptz not null default now()
);
create table comments (id bigserial primary key, email_id text references cases, author text not null, body text not null, kind text not null default 'note', at timestamptz not null default now());
create table outbox (id bigserial primary key, email_id text references cases, to_email text, subject text, body text, sent_by text, at timestamptz not null default now());
-- The model agent's reading of each email (read-only work, done in parallel before the checks run in arrival order)
create table agent_reads (email_id text primary key references emails, status text not null default 'pending', attempts int not null default 0, model text, reading jsonb, trace jsonb not null default '[]', usage jsonb not null default '{}', error text, started_at timestamptz, finished_at timestamptz);
create table audit_events (id bigserial primary key, at timestamptz not null default now(), actor text not null, actor_type text not null, email_id text, action text not null, detail jsonb not null default '{}');

-- People and sessions
create table users (username text primary key, display_name text not null, role text not null check (role in ('ops','credit','admin')), password_hash text not null, failed_count int not null default 0, locked_until timestamptz);
create table sessions (token_hash text primary key, username text references users on delete cascade, created_at timestamptz not null default now(), last_seen_at timestamptz not null default now());

-- Email and SO numbers, safe when requests arrive together. A reseed keeps the sequences; seed.js moves them past the loaded rows.
create sequence if not exists email_seq;
create sequence if not exists so_number_seq;

create index on customer_contacts (lower(email));
create index on sales_orders (customer_id, customer_po);
create index on audit_events (email_id);
create index on audit_events (actor, at);
create index on cases (status, priority);

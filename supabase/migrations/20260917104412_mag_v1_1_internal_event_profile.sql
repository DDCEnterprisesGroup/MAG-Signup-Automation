-- Preserve the sixth V1 fixture as an internal event, separate from customer metrics.
insert into public.mag_profiles(customer_id, profile_type, profile_scope, label, status)
select id, 'EVENT', 'INTERNAL', 'Christmas At The Magical Midway (2026)', 'ACTIVE'
from public.mag_customers
where scope = 'INTERNAL' and normalized_name = 'magical dream builders'
on conflict (customer_id, profile_type, label) do nothing;

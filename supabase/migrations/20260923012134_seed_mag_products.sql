-- Standard public catalog copied from the canonical Python bot seeds.
-- Preserve later operator price/availability changes on repeated deploys.
insert into public.mag_products(code, name, description, standard_price, active, availability)
values
  ('PR500', '500 Public Records', '500 legitimate online registrations per profile', 4500, true, 'AVAILABLE'),
  ('PR1000', '1,000 Public Records', '1,000 legitimate online registrations per profile', 7500, true, 'AVAILABLE'),
  ('PR1500', '1,500 Public Records', '1,500 legitimate online registrations per profile', 10000, true, 'COMING_SOON'),
  ('PR2500', '2,500 Public Records', '2,500 legitimate online registrations per profile', 15000, true, 'COMING_SOON'),
  ('PR5000', '5,000 Public Records', '5,000 legitimate online registrations per profile', 25000, true, 'COMING_SOON'),
  ('INFO_PUSH', 'Info Push / Quick Service PR', 'Standalone information push service', 2500, true, 'AVAILABLE'),
  ('BACKGROUND', 'Background Search', 'Standalone background search service', 2000, true, 'AVAILABLE'),
  ('EMAIL_CONFIRMATION', 'Email Confirmation Add-On', 'Managed verification emails for an applicable profile', 3500, true, 'AVAILABLE')
on conflict (code) do nothing;
;

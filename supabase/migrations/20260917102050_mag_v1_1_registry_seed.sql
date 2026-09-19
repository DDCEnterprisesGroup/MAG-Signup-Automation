-- Data-driven registry. Adding a normal field here or through the guarded intake
-- workflow does not require a browser-extension release.
insert into public.mag_field_definitions
  (canonical_key, semantic_type, display_name, aliases, description, data_type,
   normalization_rules, validation_rules, security_class, storage_policy,
   cache_policy, autofill_policy, review_requirement, active)
values
  ('full_name','CONTACT_NAME','Full name',array['Full Name','Contact Name','Your Name','Submitter Name'],'Approved public/contact name.','TEXT','{"trim":true}'::jsonb,'{"maxLength":200}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('first_name','FIRST_NAME','First name',array['First Name','Given Name','FName'],'Approved first name.','TEXT','{"trim":true}'::jsonb,'{"maxLength":100}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('last_name','LAST_NAME','Last name',array['Last Name','Family Name','Surname','LName'],'Approved last name.','TEXT','{"trim":true}'::jsonb,'{"maxLength":100}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('business_email','EMAIL','Business email',array['Email','Email Address','Contact Email','Business Email'],'Approved public business email.','EMAIL','{"trim":true,"lowercase":true}'::jsonb,'{"format":"email"}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('business_phone','PHONE','Business phone',array['Phone','Phone Number','Telephone','Mobile Phone','Contact Phone'],'Approved business phone.','PHONE','{"trim":true}'::jsonb,'{"format":"phone"}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('organization_name','ORGANIZATION','Organization name',array['Organization','Organization Name','Company Name','Business Name','Nonprofit Name'],'Approved public organization name.','TEXT','{"trim":true}'::jsonb,'{"maxLength":200}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('website','WEBSITE','Website',array['Website','Web Site','Website URL','Business Website','Organization Website'],'Approved public URL.','URL','{"trim":true}'::jsonb,'{"format":"url","protocols":["https"]}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('address','ADDRESS','Public address',array['Address','Street Address','Mailing Address','Address Line 1'],'Approved public address only.','TEXT','{"trim":true}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('city','CITY','City',array['City','Town','Event City'],'City.','TEXT','{"trim":true}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('state','STATE','State',array['State','Province','Region','Event State'],'State or region.','TEXT','{"trim":true,"uppercase":true}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('zip','ZIP','ZIP / postal code',array['ZIP','Zip Code','Postal Code','Postcode'],'Postal code.','TEXT','{"trim":true}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('event_name','EVENT_NAME','Event name',array['Event Name','Event Title','Name of Event','Listing Title'],'Approved event name.','TEXT','{"trim":true}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('event_date','EVENT_DATE','Event date',array['Event Date','Date of Event','Start Date'],'Approved event date.','DATE','{}'::jsonb,'{"format":"date"}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('start_time','START_TIME','Start time',array['Start Time','Event Start Time','Time Starts'],'Approved start time.','TIME','{}'::jsonb,'{"format":"time"}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('end_time','END_TIME','End time',array['End Time','Event End Time','Time Ends'],'Approved end time.','TIME','{}'::jsonb,'{"format":"time"}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('venue','VENUE','Venue',array['Venue','Venue Name','Event Venue','Location Name'],'Approved public venue.','TEXT','{"trim":true}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('event_description','EVENT_DESCRIPTION','Event description',array['Event Description','Describe the Event','Event Details','About the Event'],'Approved event copy; may contain short/medium/long variants.','JSON','{}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('organization_description','ORGANIZATION_DESCRIPTION','Organization description',array['Organization Description','Company Description','About Your Organization','Business Description'],'Approved organization copy; may contain short/medium/long variants.','JSON','{}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('biography','BIO','Biography',array['Bio','Biography','Founder Bio','Speaker Bio','Your Bio'],'Approved public biography.','JSON','{}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('social_url','SOCIAL_URL','Social link',array['Social URL','Social Media URL','Instagram URL','Facebook URL','LinkedIn URL'],'Approved public social link.','URL','{"trim":true}'::jsonb,'{"format":"url"}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('category','CATEGORY','Category',array['Category','Event Category','Business Category','Type of Event'],'Approved category.','TEXT','{"trim":true}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('admission','ADMISSION','Admission / cost',array['Admission','Admission Cost','Ticket Price','Cost','Price'],'Approved admission language.','TEXT','{"trim":true}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('mission','MISSION','Mission',array['Mission','Mission Statement','Your Mission'],'Approved mission statement.','TEXT','{"trim":true}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('press_release','PRESS_RELEASE','Press release',array['Press Release','News Release','Media Release'],'Approved press release text.','JSON','{}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','CONFIDENCE','USER_REVIEW',true),
  ('comments','COMMENTS','Approved comments',array['Comments','Additional Comments','Additional Information','Anything Else'],'Approved contextual text; always review.','TEXT','{"trim":true}'::jsonb,'{}'::jsonb,'STANDARD','PROFILE','LOCAL','REVIEW_REQUIRED','USER_REVIEW',true),
  ('date_of_birth','DATE_OF_BIRTH','Birthday',array['Birthday','DOB','Date of Birth','Birth Date'],'Private date of birth. Never persistent browser cache.','DATE','{}'::jsonb,'{"format":"date"}'::jsonb,'SENSITIVE','VAULT','NONE','REVIEW_REQUIRED','ADMIN_REQUIRED',true),
  ('ssn','SOCIAL_SECURITY_NUMBER','Social Security number',array['SSN','Social Security Number'],'Restricted government identifier.','TEXT','{}'::jsonb,'{}'::jsonb,'RESTRICTED','VAULT','NONE','EXPLICIT_UNLOCK','REAUTH_AND_APPROVAL',true),
  ('tax_identifier','TAX_IDENTIFIER','Tax identifier',array['Tax ID','TIN','EIN','Tax Identifier'],'Restricted tax identifier when required by a legitimate workflow.','TEXT','{}'::jsonb,'{}'::jsonb,'RESTRICTED','VAULT','NONE','EXPLICIT_UNLOCK','REAUTH_AND_APPROVAL',true),
  ('bank_account','BANK_ACCOUNT','Bank account',array['Bank Account','Account Number'],'Restricted bank account information.','TEXT','{}'::jsonb,'{}'::jsonb,'RESTRICTED','VAULT','NONE','EXPLICIT_UNLOCK','REAUTH_AND_APPROVAL',true),
  ('routing_number','ROUTING_NUMBER','Routing number',array['Routing Number','ABA Routing Number'],'Restricted bank routing information.','TEXT','{}'::jsonb,'{}'::jsonb,'RESTRICTED','VAULT','NONE','EXPLICIT_UNLOCK','REAUTH_AND_APPROVAL',true),
  ('password','CREDENTIAL','Password',array['Password','Passcode'],'Credentials are outside MAG and are never stored.','TEXT','{}'::jsonb,'{}'::jsonb,'CREDENTIAL','FORBIDDEN','NONE','NEVER','ADMIN_REQUIRED',false),
  ('api_key','CREDENTIAL','API key',array['API Key','Access Token','Private Token'],'Secrets are outside MAG and are never stored.','TEXT','{}'::jsonb,'{}'::jsonb,'CREDENTIAL','FORBIDDEN','NONE','NEVER','ADMIN_REQUIRED',false)
on conflict (canonical_key) do update set
  semantic_type = excluded.semantic_type,
  display_name = excluded.display_name,
  aliases = excluded.aliases,
  description = excluded.description,
  data_type = excluded.data_type,
  normalization_rules = excluded.normalization_rules,
  validation_rules = excluded.validation_rules,
  security_class = excluded.security_class,
  storage_policy = excluded.storage_policy,
  cache_policy = excluded.cache_policy,
  autofill_policy = excluded.autofill_policy,
  review_requirement = excluded.review_requirement,
  active = excluded.active,
  updated_at = now();

-- Internal V1 fixtures remain available as INTERNAL scope and never count as clients.
with names(display_name, normalized_name) as (values
  ('Magical Dream Builders','magical dream builders'),
  ('Altaire Financial Group','altaire financial group'),
  ('Ice House Jewelers','ice house jewelers'),
  ('K.N. Roberts House / Dollar District','k n roberts house dollar district'),
  ('D''Andre D. Combs Jr.','d andre d combs jr')
)
insert into public.mag_customers(scope,status,display_name,normalized_name)
select 'INTERNAL','ACTIVE',display_name,normalized_name from names
on conflict (scope, normalized_name) do nothing;

insert into public.mag_profiles(customer_id,profile_type,profile_scope,label,status)
select c.id,
  case when c.normalized_name = 'd andre d combs jr' then 'PERSON' else 'ORGANIZATION' end,
  'INTERNAL', c.display_name, 'ACTIVE'
from public.mag_customers c
where c.scope = 'INTERNAL'
on conflict (customer_id, profile_type, label) do nothing;

create view public.mag_customer_metrics
with (security_invoker = true)
as
select
  count(*) filter (where c.status = 'ACTIVE')::bigint as active_customers,
  count(*) filter (where c.status <> 'ARCHIVED')::bigint as total_customers,
  count(distinct o.id) filter (where o.status <> 'ARCHIVED')::bigint as total_orders
from public.mag_customers c
left join public.mag_orders o on o.customer_id = c.id
where c.scope = 'CUSTOMER';

revoke all on public.mag_customer_metrics from public, anon;
grant select on public.mag_customer_metrics to authenticated;

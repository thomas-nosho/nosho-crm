-- Insert contact: Laurent Lerda (Institut Paoli-Calmettes, IPC)
-- Idempotent: finds or creates the IPC company, then inserts the contact
-- only if a matching (first_name, last_name, company_id) row does not exist.

DO $$
DECLARE
    v_company_id bigint;
BEGIN
    SELECT id
      INTO v_company_id
      FROM public.companies
     WHERE name = 'Institut Paoli-Calmettes'
     LIMIT 1;

    IF v_company_id IS NULL THEN
        INSERT INTO public.companies (name)
             VALUES ('Institut Paoli-Calmettes')
          RETURNING id INTO v_company_id;
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.contacts
         WHERE first_name = 'Laurent'
           AND last_name  = 'Lerda'
           AND company_id = v_company_id
    ) THEN
        INSERT INTO public.contacts (first_name, last_name, company_id, phone_jsonb)
        VALUES (
            'Laurent',
            'Lerda',
            v_company_id,
            '[{"number":"0660293957","type":"Work"}]'::jsonb
        );
    END IF;
END $$;

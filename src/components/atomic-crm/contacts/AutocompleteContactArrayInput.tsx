import { useRef, useState } from "react";
import { useFormContext } from "react-hook-form";

import { AutocompleteArrayInput } from "@/components/admin/autocomplete-array-input";
import { contactOptionText } from "../misc/ContactOption";
import { ContactCreateSheet } from "./ContactCreateSheet";
import type { Contact } from "../types";

/**
 * Champ de sélection multi-contacts pour le formulaire d'opportunité.
 *
 * Quand l'utilisateur tape un nom qui ne correspond à aucun contact, une
 * option « Créer le contact « X » » s'affiche dans la liste. Au clic, un
 * sheet de création de contact s'ouvre, pré-rempli avec :
 * - first_name / last_name déduits du texte tapé (split sur le premier
 *   espace : « Marie Dupont » → first="Marie", last="Dupont")
 * - company_id récupéré depuis le formulaire d'opportunité parent (via
 *   useFormContext) — vide si pas encore choisi, l'utilisateur peut le
 *   sélectionner ou créer une société à la volée dans le sheet
 *
 * Doit être utilisé à l'intérieur d'un <ReferenceArrayInput
 * source="contact_ids" reference="contacts_summary">.
 */
export const AutocompleteContactArrayInput = () => {
  const [open, setOpen] = useState(false);
  const [defaults, setDefaults] = useState<Partial<Contact>>({});
  const { getValues } = useFormContext();
  const resolverRef = useRef<((record: Contact | undefined) => void) | null>(
    null,
  );

  const handleCreate = (filter: string) => {
    const trimmed = filter.trim();
    const [first, ...rest] = trimmed.split(/\s+/);
    setDefaults({
      first_name: first ?? "",
      last_name: rest.join(" "),
      company_id: getValues("company_id") ?? null,
    });
    setOpen(true);
    return new Promise<Contact | undefined>((resolve) => {
      resolverRef.current = resolve;
    });
  };

  const handleCreated = (contact: Contact) => {
    resolverRef.current?.(contact);
    resolverRef.current = null;
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && resolverRef.current) {
      resolverRef.current(undefined);
      resolverRef.current = null;
    }
    setOpen(next);
  };

  return (
    <>
      <AutocompleteArrayInput
        label="Contacts associés"
        optionText={contactOptionText}
        helperText={false}
        onCreate={handleCreate}
        createItemLabel="Créer le contact « %{item} »"
      />
      <ContactCreateSheet
        open={open}
        onOpenChange={handleOpenChange}
        defaultValues={defaults}
        onCreated={handleCreated}
      />
    </>
  );
};

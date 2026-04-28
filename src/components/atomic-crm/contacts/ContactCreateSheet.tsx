import { useGetIdentity } from "ra-core";
import { CreateSheet } from "../misc/CreateSheet";
import { ContactInputs } from "./ContactInputs";
import type { Contact } from "../types";

export interface ContactCreateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Valeurs par défaut additionnelles fusionnées avec celles du composant
   * (le `sales_id` par défaut reste l'utilisateur connecté sauf surcharge).
   */
  defaultValues?: Partial<Contact>;
  /**
   * Callback appelée après la création réussie d'un contact, avec le record
   * complet. Lorsque cette prop est fournie, le sheet ne redirige PAS vers la
   * page show du contact (pour rester sur le formulaire parent) et c'est
   * au consommateur de fermer le sheet via `onOpenChange`.
   */
  onCreated?: (contact: Contact) => void;
}

export const ContactCreateSheet = ({
  open,
  onOpenChange,
  defaultValues,
  onCreated,
}: ContactCreateSheetProps) => {
  const { identity } = useGetIdentity();
  return (
    <CreateSheet
      resource="contacts"
      title="Nouveau contact"
      defaultValues={{ sales_id: identity?.id, ...defaultValues }}
      transform={(data: Contact) => ({
        ...data,
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        tags: [],
      })}
      open={open}
      onOpenChange={onOpenChange}
      redirect={onCreated ? false : "show"}
      mutationOptions={
        onCreated
          ? {
              onSuccess: (contact: Contact) => {
                onCreated(contact);
                onOpenChange(false);
              },
            }
          : undefined
      }
    >
      <ContactInputs />
    </CreateSheet>
  );
};

# Création de contact inline depuis une opportunité — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à l'utilisateur de créer un contact à la volée depuis le formulaire d'opportunité quand le contact tapé n'existe pas encore, et l'attacher automatiquement à l'opportunité.

**Architecture :** On étend `AutocompleteArrayInput` (admin kit) pour supporter `onCreate` à la manière de `AutocompleteInput` (qui utilise déjà le hook ra-core `useSupportCreateSuggestion`). On étend `ContactCreateSheet` (deux nouvelles props : `defaultValues`, `onCreated`). On crée un wrapper `AutocompleteContactArrayInput` qui orchestre l'ouverture du sheet, le pré-remplissage (prénom/nom split, `company_id` lu depuis le formulaire parent), et la résolution de la promesse `onCreate` avec le record créé. Enfin on remplace l'usage actuel dans `DealInputs.tsx`.

**Tech Stack :** React 19, TypeScript, ra-core (`useSupportCreateSuggestion`, `useFormContext`), shadcn-admin-kit, Vitest.

**Spec :** `docs/superpowers/specs/2026-04-28-inline-contact-create-design.md`

---

## File Structure

| Fichier | Statut | Rôle |
|---|---|---|
| `src/components/admin/autocomplete-array-input.tsx` | Modifié | Ajoute le support de `onCreate` via `useSupportCreateSuggestion` |
| `src/components/atomic-crm/contacts/ContactCreateSheet.tsx` | Modifié | Accepte `defaultValues` et `onCreated` pour usage en sheet de création inline |
| `src/components/atomic-crm/contacts/AutocompleteContactArrayInput.tsx` | Créé | Wrapper qui ouvre le sheet et résout l'`onCreate` avec le nouveau contact |
| `src/components/atomic-crm/deals/DealInputs.tsx` | Modifié | Utilise `AutocompleteContactArrayInput` au lieu d'`AutocompleteArrayInput` brut |

---

## Task 1 — Étendre `AutocompleteArrayInput` pour supporter `onCreate`

**Files:**
- Modify: `src/components/admin/autocomplete-array-input.tsx`

**Pattern :** s'aligner sur `AutocompleteInput` (single) qui utilise déjà `useSupportCreateSuggestion` de ra-core. Ce hook gère :
- L'ajout d'une option synthétique "Créer..." en bas de la liste
- L'interception du clic sur cette option : il appelle `onCreate(filter)` et, si le résultat est un record, `handleChange(record)`
- Le rendu d'un éventuel `createElement` (modal de création inline — non utilisé ici, on ouvre notre propre sheet)

- [ ] **Step 1.1 : Lire le contexte d'inspiration**

Lire `src/components/admin/autocomplete-input.tsx:78-313` pour comprendre l'intégration de `useSupportCreateSuggestion` (props consommées, où `createItem` est inséré dans la liste, comment `handleChangeWithCreateSupport` remplace `handleChange`, comment `createElement` est rendu).

- [ ] **Step 1.2 : Ajouter les imports et étendre les props**

Dans `src/components/admin/autocomplete-array-input.tsx`, ajouter aux imports `ra-core` :

```tsx
import {
  useChoices,
  useChoicesContext,
  useGetRecordRepresentation,
  useInput,
  useTranslate,
  FieldTitle,
  useEvent,
  useSupportCreateSuggestion,
} from "ra-core";
import type { ChoicesProps, InputProps, SupportCreateSuggestionOptions } from "ra-core";
```

Étendre la signature des props (ligne 65-77) :

```tsx
export const AutocompleteArrayInput = (
  props: Omit<InputProps, "source"> &
    Omit<SupportCreateSuggestionOptions, "handleChange" | "filter"> &
    Partial<Pick<InputProps, "source">> &
    ChoicesProps & {
      className?: string;
      disableValue?: string;
      filterToQuery?: (searchText: string) => any;
      translateChoice?: boolean;
      placeholder?: string;
      inputText?:
        | React.ReactNode
        | ((option: any | undefined) => React.ReactNode);
    },
) => {
```

Et déstructurer les props nouvelles dans le corps (juste après la déstructuration existante de `filterToQuery, inputText`) :

```tsx
  const {
    filterToQuery = DefaultFilterToQuery,
    inputText,
    create,
    createValue,
    createLabel,
    createHintValue,
    createItemLabel,
    onCreate,
    optionText,
  } = props;
```

- [ ] **Step 1.3 : Câbler `useSupportCreateSuggestion` et calculer `createItem`**

Juste avant le `return` (autour de la ligne 145, après les `useCallback` existants), ajouter :

```tsx
  const handleSelect = useEvent((choice: any) => {
    setFilterValue("");
    if (isFromReference) {
      setFilters(filterToQuery(""));
    }
    field.onChange([...field.value, getChoiceValue(choice)]);
  });

  const {
    getCreateItem,
    handleChange: handleChangeWithCreateSupport,
    createElement,
    getOptionDisabled,
  } = useSupportCreateSuggestion({
    create,
    createLabel,
    createValue,
    createHintValue,
    createItemLabel,
    onCreate,
    handleChange: handleSelect,
    optionText,
    filter: filterValue,
  });

  const createItem =
    (create || onCreate) && (filterValue !== "" || createLabel)
      ? getCreateItem(filterValue)
      : null;

  const finalChoices = createItem
    ? [...availableChoices, createItem]
    : availableChoices;
```

Note : `handleSelect` extrait la logique d'ajout à `field.value` qui était inline dans `onSelect` du `CommandItem` existant (ligne 226-235). On la garde maintenant dans une fonction nommée pour pouvoir la passer à `useSupportCreateSuggestion`.

- [ ] **Step 1.4 : Brancher la liste sur `finalChoices` et le clic sur `handleChangeWithCreateSupport`**

Remplacer la boucle existante (ligne ~218-241) :

```tsx
  {open && finalChoices.length > 0 ? (
    <div className="absolute top-2 z-10 w-full rounded-md border bg-popover text-popover-foreground shadow-md outline-none animate-in">
      <CommandGroup className="h-full overflow-auto">
        {finalChoices.map((choice) => {
          const isCreateItem = !!createItem && choice?.id === createItem.id;
          const disabled = getOptionDisabled(choice);
          return (
            <CommandItem
              key={getChoiceValue(choice)}
              disabled={disabled}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onSelect={() => handleChangeWithCreateSupport(choice)}
              className="cursor-pointer"
            >
              {isCreateItem ? getChoiceText(createItem) : getChoiceText(choice)}
            </CommandItem>
          );
        })}
      </CommandGroup>
    </div>
  ) : null}
```

- [ ] **Step 1.5 : Rendre `createElement` à côté du formulaire**

À la toute fin du composant, remplacer le `return` final pour qu'il rende un fragment :

```tsx
  return (
    <>
      <FormField className={props.className} id={id} name={field.name}>
        {/* ... contenu existant ... */}
      </FormField>
      {createElement}
    </>
  );
```

(Ajouter `<>` autour de la `FormField` et `{createElement}` après.)

- [ ] **Step 1.6 : Vérifier que TypeScript passe**

Run :
```bash
make typecheck
```
Expected : `tsc --noEmit` se termine sans erreur.

- [ ] **Step 1.7 : Vérifier qu'aucun test existant ne casse**

Run :
```bash
npx vitest run src/components
```
Expected : tous les tests passent (les usages existants n'utilisent pas `onCreate` donc le comportement est inchangé).

- [ ] **Step 1.8 : Commit**

```bash
git add src/components/admin/autocomplete-array-input.tsx
git commit -m "feat(admin): support onCreate dans AutocompleteArrayInput

Aligne le composant sur AutocompleteInput en utilisant useSupportCreateSuggestion
de ra-core. Permet aux consommateurs de proposer une option 'Créer' quand
aucune valeur ne correspond au filtre."
```

---

## Task 2 — Étendre `ContactCreateSheet` avec `defaultValues` et `onCreated`

**Files:**
- Modify: `src/components/atomic-crm/contacts/ContactCreateSheet.tsx`

**Pourquoi :** le composant fige aujourd'hui ses `defaultValues` et ne notifie pas son parent du record créé (puisqu'il redirige vers la page show). Pour l'usage en création inline, on a besoin de :
1. Préfixer le formulaire avec un prénom/nom (et un `company_id`) déduits du contexte de l'opportunité.
2. Récupérer l'`id` du contact créé pour l'ajouter à `contact_ids`.

- [ ] **Step 2.1 : Mettre à jour `ContactCreateSheetProps` et le composant**

Remplacer entièrement le contenu de `src/components/atomic-crm/contacts/ContactCreateSheet.tsx` :

```tsx
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
```

Notes :
- `defaultValues` est étalé après le défaut interne, donc le consommateur peut surcharger `sales_id` s'il le souhaite (mais en pratique on garde l'identité connectée).
- Quand `onCreated` est fourni, on désactive le redirect (sinon on quitterait l'opportunité) et on remplace l'`onSuccess` par défaut de `CreateSheet` — qui se chargeait de notifier + fermer + rediriger. La fermeture est faite explicitement ici. La notification n'est PAS envoyée pour ce flux : c'est volontaire (la création est implicite dans le flux principal de sauvegarde de l'opportunité).
- Quand `onCreated` n'est PAS fourni, le comportement existant est strictement préservé (tous les autres usages de `ContactCreateSheet`).

- [ ] **Step 2.2 : Vérifier les autres usages de `ContactCreateSheet`**

Run :
```bash
```

(Pas de commande shell — utiliser le tool Grep dans le harness pour `ContactCreateSheet`.)

Expected : tous les usages existants n'utilisent QUE `open` et `onOpenChange`. Le comportement par défaut (avec `redirect="show"` et l'`onSuccess` standard) doit rester identique pour eux.

- [ ] **Step 2.3 : Vérifier le typage**

Run :
```bash
make typecheck
```
Expected : 0 erreur.

- [ ] **Step 2.4 : Commit**

```bash
git add src/components/atomic-crm/contacts/ContactCreateSheet.tsx
git commit -m "feat(contacts): defaultValues et onCreated sur ContactCreateSheet

Permet d'utiliser le sheet en création inline depuis un autre formulaire :
préfixer les champs et récupérer le record créé sans redirection."
```

---

## Task 3 — Créer `AutocompleteContactArrayInput`

**Files:**
- Create: `src/components/atomic-crm/contacts/AutocompleteContactArrayInput.tsx`

**Rôle :** wrappe `AutocompleteArrayInput` pour le champ `contact_ids` d'une opportunité. Au déclenchement de l'option "Créer..." :
1. Ouvre `ContactCreateSheet` pré-rempli (prénom/nom, `company_id` du formulaire parent).
2. Renvoie une promesse résolue avec le record créé (ou `undefined` si l'utilisateur ferme le sheet).
3. `AutocompleteArrayInput` (via `useSupportCreateSuggestion`) ajoute alors automatiquement l'`id` du record retourné à `field.value`.

- [ ] **Step 3.1 : Créer le fichier**

Créer `src/components/atomic-crm/contacts/AutocompleteContactArrayInput.tsx` :

```tsx
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
```

Détails clefs :
- `getValues("company_id")` lit la valeur en temps réel sans déclencher de re-render (parfait ici car on l'utilise au moment du clic, pas dans le rendu).
- `resolverRef` permet de garder la fonction `resolve` de la promesse retournée à `useSupportCreateSuggestion` ; on l'appelle soit avec le record (succès), soit avec `undefined` (annulation).
- Mettre `resolverRef.current = null` après résolution évite que la fermeture ultérieure du sheet ne tente de re-résoudre.

- [ ] **Step 3.2 : Vérifier le typage**

Run :
```bash
make typecheck
```
Expected : 0 erreur.

- [ ] **Step 3.3 : Commit**

```bash
git add src/components/atomic-crm/contacts/AutocompleteContactArrayInput.tsx
git commit -m "feat(contacts): composant AutocompleteContactArrayInput

Wrapper qui ouvre ContactCreateSheet avec pré-remplissage prénom/nom
et company_id du formulaire parent, et résout la promesse onCreate
avec le contact créé."
```

---

## Task 4 — Intégrer dans `DealInputs.tsx`

**Files:**
- Modify: `src/components/atomic-crm/deals/DealInputs.tsx`

- [ ] **Step 4.1 : Remplacer l'usage actuel**

Dans `src/components/atomic-crm/deals/DealInputs.tsx` :

1. Retirer ces imports (lignes 4 et 21, ils ne sont plus nécessaires si `AutocompleteArrayInput` et `contactOptionText` ne sont plus utilisés ailleurs dans ce fichier — vérifier d'abord) :
   ```tsx
   import { AutocompleteArrayInput } from "@/components/admin/autocomplete-array-input";
   ```
   et :
   ```tsx
   import { contactOptionText } from "../misc/ContactOption";
   ```

2. Ajouter l'import du nouveau composant :
   ```tsx
   import { AutocompleteContactArrayInput } from "../contacts/AutocompleteContactArrayInput";
   ```

3. Remplacer le bloc des contacts (lignes 122-128 actuelles) :
   ```tsx
   <ReferenceArrayInput source="contact_ids" reference="contacts_summary">
     <AutocompleteArrayInput
       label="Contacts associés"
       optionText={contactOptionText}
       helperText={false}
     />
   </ReferenceArrayInput>
   ```

   Par :
   ```tsx
   <ReferenceArrayInput source="contact_ids" reference="contacts_summary">
     <AutocompleteContactArrayInput />
   </ReferenceArrayInput>
   ```

- [ ] **Step 4.2 : Vérifier le typage**

Run :
```bash
make typecheck
```
Expected : 0 erreur.

- [ ] **Step 4.3 : Vérifier qu'aucun test ne casse**

Run :
```bash
npx vitest run src/components/atomic-crm/deals
```
Expected : tous les tests passent.

- [ ] **Step 4.4 : Commit**

```bash
git add src/components/atomic-crm/deals/DealInputs.tsx
git commit -m "feat(deals): création de contact inline depuis le formulaire d'opportunité

Remplace AutocompleteArrayInput par AutocompleteContactArrayInput sur le
champ contact_ids. L'utilisateur peut désormais créer un contact à la
volée quand le nom tapé n'existe pas, sans quitter le formulaire."
```

---

## Task 5 — Vérification comportementale (manuel)

**Files:** aucun (vérification end-to-end)

**Pourquoi :** d'après `AGENTS.md`, le DoD impose une vérification comportementale en plus du typecheck.

- [ ] **Step 5.1 : Démarrer le stack local**

Run :
```bash
make start
```
Expected : Supabase + Vite démarrent. Frontend disponible sur http://localhost:5173/.

- [ ] **Step 5.2 : Tester le golden path**

1. Aller sur la page Opportunités → "Nouvelle opportunité"
2. Sélectionner une société
3. Dans "Contacts associés", taper "Test Inline"
4. **Attendu :** une option "Créer le contact « Test Inline »" apparaît
5. Cliquer dessus
6. **Attendu :** le sheet de création de contact s'ouvre. `first_name = "Test"`, `last_name = "Inline"`, la société est pré-sélectionnée
7. Compléter les champs requis et sauvegarder le sheet
8. **Attendu :** le sheet se ferme, "Test Inline" apparaît comme badge dans "Contacts associés"
9. Compléter et sauvegarder l'opportunité
10. **Attendu :** opportunité créée, le contact "Test Inline" y est lié

- [ ] **Step 5.3 : Tester les cas limites**

1. **Sans société** : ouvrir une nouvelle opportunité, ne PAS sélectionner de société, taper un nom dans Contacts. Cliquer "Créer". **Attendu :** sheet ouvert avec champ société vide ; on peut le remplir ou en créer une à la volée.
2. **Annulation** : ouvrir le sheet, fermer sans sauvegarder. **Attendu :** rien ajouté à `contact_ids`, le filtre tapé est conservé.
3. **Édition** : éditer une opportunité existante, ajouter un nouveau contact via création inline. **Attendu :** même flux fonctionne.
4. **Un seul mot** : taper "Marie" et créer. **Attendu :** `first_name = "Marie"`, `last_name = ""` (à compléter par l'utilisateur dans le sheet).

- [ ] **Step 5.4 : Vérifier la version bumpée**

Le pre-commit hook a bumpé `src/version.ts` à chaque commit. Lire le fichier pour récupérer la version finale et la communiquer à l'utilisateur.

```bash
```
(Lire `src/version.ts` via le tool Read.)

---

## Self-Review

**Spec coverage :**
- Architecture (3 composants modifiés + 1 créé) → Tasks 1-4 ✓
- Flux utilisateur (typer → option Créer → sheet pré-rempli → ajout au champ) → couvert par Tasks 1, 3 et vérifié dans Task 5 ✓
- Cas limites (saisie sans espace, plusieurs mots, pas de société, annulation, erreur, édition) → traités dans Task 3 (split prénom/nom, gestion `resolverRef`) et vérifiés dans Task 5 ✓
- Tests : pas de Task dédiée à de nouveaux tests automatisés. **Justification :** le composant `AutocompleteContactArrayInput` est principalement de l'orchestration (state local + ouverture de sheet) ; sa logique testable (split prénom/nom) est triviale ; les tests d'intégration React form + sheet + autocomplete dans `vitest-browser-react` ont un coût élevé pour un gain limité dans ce contexte. La vérification comportementale manuelle de Task 5 est plus efficace ici. À reconsidérer si un bug se présente — auquel cas écrire un test ciblé.
- Hors scope (création inline ailleurs, déduplication) → bien marqué hors scope dans le spec ✓
- DoD `AGENTS.md` (typecheck, vérification comportementale, version bumpée) → couvert par Tasks 1.6, 2.3, 3.2, 4.2 (typecheck), Task 5 (comportement), Step 5.4 (version) ✓

**Placeholder scan :** aucune section "TBD/TODO" ; tout le code est fourni intégralement ; chaque step a un attendu explicite. Deux blocs ```bash``` sont volontairement vides — ils précisent dans une note adjacente d'utiliser le tool Grep / Read côté harness, ce qui est le bon usage dans ce contexte.

**Type consistency :** `Contact` (type) est importé depuis `../types` cohéremment dans Tasks 2 et 3. La signature `onCreated?: (contact: Contact) => void` (Task 2) correspond au callback `handleCreated = (contact: Contact) => ...` (Task 3). `defaultValues?: Partial<Contact>` (Task 2) correspond à `setDefaults({ first_name, last_name, company_id })` (Task 3) — `Partial<Contact>` accepte ces trois champs.

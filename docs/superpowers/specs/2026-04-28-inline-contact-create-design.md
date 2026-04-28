# Création de contact inline depuis une opportunité

## Contexte

Lors de la création ou de l'édition d'une opportunité (deal), l'utilisateur sélectionne un ou plusieurs contacts associés via le champ « Contacts associés » (`contact_ids`). Si le contact n'existe pas encore, l'utilisateur doit aujourd'hui :

1. Annuler / mettre en pause la saisie de l'opportunité
2. Aller créer le contact dans la section Contacts
3. Revenir sur l'opportunité et le sélectionner

Cette friction est inutile : le pattern existe déjà pour les sociétés (`AutocompleteCompanyInput`) qui permet de créer une société à la volée à partir d'un nom. Pour les contacts, le besoin est similaire mais plus riche (plusieurs champs obligatoires).

## Objectif

Permettre à l'utilisateur, depuis le formulaire d'opportunité, de créer un contact directement quand il tape un nom qui ne correspond à aucun contact existant. Le contact créé est automatiquement ajouté à la liste des contacts associés.

## Architecture

Un nouveau composant `AutocompleteContactArrayInput` remplace l'usage de `AutocompleteArrayInput` sur le champ `contact_ids` dans `DealInputs.tsx`. Il s'appuie sur :

- `AutocompleteArrayInput` (admin kit) — étendu pour supporter une prop `onCreate`
- `ContactCreateSheet` (existant) — ouvert pré-rempli pour créer le contact dans un panneau latéral

Pourquoi un sheet plutôt qu'une création directe en un clic comme pour les sociétés : un contact requiert plusieurs champs obligatoires (`first_name`, `last_name`, `sales_id`) — le seul nom tapé ne suffit pas. Le sheet réutilise le formulaire complet existant.

## Composants modifiés ou créés

### 1. `src/components/admin/autocomplete-array-input.tsx` (modifié)

Ajout du support de `onCreate`, aligné sur ce qui existe déjà dans `AutocompleteInput` (single).

Nouvelles props (toutes optionnelles, donc rétrocompatible) :

- `onCreate?: (filter: string) => Promise<any> | any` — callback déclenchée quand l'utilisateur clique sur l'option « Créer ». Reçoit le texte tapé. Si elle retourne un objet de type `{ id, ... }` (un record ou un id), il est ajouté à `field.value`.
- `createItemLabel?: string` — libellé de l'option de création (ex : `"Créer %{item}"`). `%{item}` est remplacé par le texte tapé.
- `createLabel?: string` — libellé affiché si la liste est vide ET le filtre est vide (optionnel, ex : `"Tapez pour créer un nouveau contact"`).

Comportement :

- Si `onCreate` est défini ET `filterValue` n'est pas vide ET aucune `availableChoice` ne correspond strictement, afficher un `CommandItem` « Créer ... » en bas de la liste.
- Au clic, appeler `onCreate(filterValue)`. Si le retour est un record avec `id`, ajouter `id` à `field.value`. Vider le filtre. Refermer la liste.
- Si `onCreate` retourne `undefined` (annulation, erreur), ne rien ajouter, garder le filtre.

### 2. `src/components/atomic-crm/contacts/ContactCreateSheet.tsx` (modifié)

Le composant fige aujourd'hui ses `defaultValues` à `{ sales_id: identity?.id }` et ne permet pas de surcharger le comportement post-création (le parent ne voit que `open`/`onOpenChange`). On l'étend pour le rendre réutilisable :

- Nouvelle prop optionnelle `defaultValues?: Partial<Contact>` — fusionnée avec le défaut existant (`sales_id`).
- Nouvelle prop optionnelle `onCreated?: (contact: Contact) => void` — appelée juste avant la fermeture du sheet quand la création réussit. Permet au parent de récupérer l'id du contact créé.

Implémentation : passer ces deux props au `<CreateSheet>` sous-jacent. `defaultValues` est concaténé. `onCreated` est branché via `mutationOptions.onSuccess` en wrappant le comportement par défaut (notification + fermeture) pour conserver l'UX standard.

Note : on n'utilise pas `redirect={false}` — `CreateSheet` redirige par défaut vers la page show. On garde l'`onSuccess` par défaut (notification + fermeture) et on ajoute notre callback. Aucun redirect ne se produira parce que le sheet est déjà fermé et que la `redirectTo` route vers `show` du contact, ce qui n'est pas souhaité ici. Donc on passe `redirect={false}` au `CreateSheet` quand `onCreated` est fourni.

### 3. `src/components/atomic-crm/contacts/AutocompleteContactArrayInput.tsx` (nouveau)

Wrappe `AutocompleteArrayInput`. Gère :

- L'ouverture du `ContactCreateSheet` au déclenchement de `onCreate`
- Le pré-remplissage des valeurs initiales du sheet
- La récupération de l'id du contact créé pour l'ajouter au formulaire parent

Code (essentiel) :

```tsx
const AutocompleteContactArrayInput = () => {
  const [open, setOpen] = useState(false);
  const [defaults, setDefaults] = useState<Partial<Contact>>({});
  const { getValues } = useFormContext();
  const resolverRef = useRef<(record: Contact | undefined) => void>();

  const handleCreate = (filter: string) => {
    const [first, ...rest] = filter.trim().split(/\s+/);
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

  const handleCreated = (record: Contact) => {
    resolverRef.current?.(record);
    resolverRef.current = undefined;
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && resolverRef.current) {
      resolverRef.current(undefined); // user cancelled
      resolverRef.current = undefined;
    }
    setOpen(next);
  };

  return (
    <>
      <AutocompleteArrayInput
        label="Contacts associés"
        optionText={contactOptionText}
        onCreate={handleCreate}
        createItemLabel="Créer le contact « %{item} »"
        helperText={false}
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

Le retour de `handleCreate` est une promesse résolue dans `onCreated` (succès) ou dans `onOpenChange(false)` (annulation). `AutocompleteArrayInput` await ce retour : si c'est un record, il ajoute son `id` à `field.value` ; sinon, rien.

`useFormContext` permet de lire le `company_id` actuellement sélectionné dans le formulaire d'opportunité.

### 4. `src/components/atomic-crm/deals/DealInputs.tsx` (modifié)

Remplacement, dans `DealLinkedToInputs` :

```tsx
<ReferenceArrayInput source="contact_ids" reference="contacts_summary">
  <AutocompleteContactArrayInput />
</ReferenceArrayInput>
```

L'option `optionText`/`label` passe maintenant côté du wrapper.

## Flux utilisateur

1. L'utilisateur ouvre la création d'une opportunité (ou édite une existante).
2. Il sélectionne une société (ou la crée à la volée — déjà supporté).
3. Dans « Contacts associés », il tape « Marie Dupont ».
4. Aucun contact ne correspond → une ligne **« Créer le contact « Marie Dupont » »** apparaît dans la liste.
5. Au clic, le `ContactCreateSheet` s'ouvre avec :
   - `first_name = "Marie"`, `last_name = "Dupont"`
   - `company_id` pré-rempli avec celui de l'opportunité (vide si pas encore choisi — l'utilisateur peut le sélectionner dans le sheet avec création à la volée déjà supportée)
   - `sales_id` = utilisateur connecté (défaut existant de `ContactCreateSheet`)
6. L'utilisateur complète, choisit le responsable commercial, valide.
7. Le sheet se ferme. Le nouveau contact apparaît comme badge dans « Contacts associés ».
8. L'utilisateur termine et sauvegarde l'opportunité.

## Cas limites

| Cas | Comportement |
|---|---|
| Saisie sans espace (« Marie ») | `first_name = "Marie"`, `last_name = ""`. L'utilisateur complète dans le sheet (validation rendra le champ obligatoire). |
| Plusieurs mots (« Jean Marie Dupont ») | `first_name = "Jean"`, `last_name = "Marie Dupont"`. |
| Pas de société choisie dans l'opportunité | Sheet ouvert avec `company_id` vide. L'utilisateur choisit (ou crée) une société dans le sheet. |
| Utilisateur ferme le sheet sans sauvegarder | Aucun contact ajouté à `contact_ids`. Le filtre dans l'autocomplete est conservé pour permettre une nouvelle tentative. |
| Erreur de création (validation, réseau) | Notification d'erreur (déjà gérée par `CreateBase`), sheet reste ouvert pour correction. |
| Édition d'opportunité existante | Mêmes comportements — `useFormContext` fournit `company_id` quel que soit le mode. |
| Doublon (un contact avec le même nom existe ailleurs) | Pas de détection — c'est un sujet séparé (déduplication contact). |

## Tests

- **Test unitaire** sur le split prénom/nom (ex : utilitaire `splitContactName(filter)` ou test directement sur le composant)
- **Test d'intégration** dans `DealCreate.test.tsx` ou nouveau `AutocompleteContactArrayInput.test.tsx` :
  - Taper un nom inexistant → option de création visible
  - Cliquer → sheet ouvert avec valeurs par défaut correctes
  - Sauvegarder → contact ajouté dans `contact_ids`
  - Annuler le sheet → rien n'est ajouté

## Hors scope

- Création inline de contacts depuis d'autres formulaires (notes, tâches) — le composant pourra y être réutilisé plus tard.
- Détection / fusion de doublons à la création.
- Modification du `AutocompleteInput` simple (déjà fonctionnel pour les sociétés).
- Création inline de société depuis le sheet contact (ce flux fonctionne déjà via `AutocompleteCompanyInput`).

## Vérifications de fin (Definition of Done)

D'après `AGENTS.md` :

1. `make typecheck` passe sans erreur
2. Pas de migration SQL nécessaire (pure feature frontend)
3. Vérification comportementale : démo manuelle du flux complet (création d'opportunité → création contact inline → sauvegarde)
4. Le hook pre-commit bumpe `src/version.ts` automatiquement ; mentionner la version dans le message de commit

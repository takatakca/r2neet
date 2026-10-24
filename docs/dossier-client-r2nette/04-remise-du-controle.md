# R2NETTE — remise du contrôle au client

Le propriétaire doit pouvoir reprendre le travail avec les fichiers, les comptes
et les preuves, sans dépendre de la mémoire d’un agent.

| Élément à remettre | État au 24 octobre 2026 |
| --- | --- |
| Code et historique | Dépôt GitHub du propriétaire ; PR 43 consultable |
| Description du fonctionnement | Ce dossier et `docs/customer-database.md` |
| Inventaire de contacts et sources | Préparé dans des fichiers privés ; 105 contacts à qualifier |
| Accès au répertoire du site | Réservé au rôle OWNER ; activation de production en attente |
| Comptes clients existants | Vue dédiée ; aucune fusion automatique avec les contacts courriel |
| Choix marketing | Formulaire codé et testé ; décision du titulaire distincte des messages transactionnels |
| Notes OneDrive existantes | Lecture et classement en attente d’accès |
| Accès et responsabilités d’exploitation | Compte administrateur serveur à rendre disponible par le propriétaire |
| Reprise des données d’autres systèmes | Wave, Setmore et autres sources à fournir/connecter ultérieurement |

## Deux niveaux de dossier

Le propriétaire R2NETTE gère son répertoire de contacts. Un client final du
service de ménage ne doit accéder qu’à son propre compte et ses propres données.
Il ne reçoit pas l’inventaire complet des autres contacts. La portabilité d’un
dossier individuel complet n’a pas été implémentée par la PR 43 ; elle devra être
spécifiée et vérifiée séparément si demandée.

## Reprise par le prochain intervenant

Lire d’abord l’index, le journal du dépôt et les notes OneDrive quand elles seront
accessibles. Vérifier la branche et la CI au lieu de recréer le travail. Conserver
la provenance des données et le statut de chaque livraison. Les droits d’accès
restent dans les comptes du propriétaire ; aucune clé ni aucun mot de passe ne
doit être ajouté au dossier technique public.

Les montants, budgets et documents de financement du propriétaire ne sont pas
déduits du nombre de contacts ni d’un contrôle technique réussi.

---
Note signée : **Codex — assistant OpenAI**. Date : **2026-10-24**, America/New_York.
Source : demande de remise du propriétaire et périmètre effectivement développé.

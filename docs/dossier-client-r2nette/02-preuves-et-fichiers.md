# R2NETTE — registre des preuves techniques

## Référence fonctionnelle vérifiée

- Dépôt : [takatakca/r2neet](https://github.com/takatakca/r2neet).
- Travail proposé : [PR 43](https://github.com/takatakca/r2neet/pull/43).
- Commit fonctionnel testé : `effa46d6f6df1b5f043f11ce319d05d07cfcde83`.
- CI : [40079381092](https://github.com/takatakca/r2neet/actions/runs/40079381092).
- Résultats : Typecheck and build, Tests PostgreSQL, Safety invariants,
  Container builds and starts et contrôle global CI tous réussis.
- Les ajouts de documentation postérieurs doivent garder cette preuve de code
  distincte de leur propre commit et de leur éventuelle CI.

Les tests PostgreSQL de contacts prouvent le réimport sans doublons, la
conservation du classement et du nom corrigés, les bornes de dates, la suppression
des seules références associées et les imports simultanés. Ils vérifient aussi
que l’import ne crée pas de compte client, téléphone vérifié ou événement d’identité.

## Cartographie des fichiers

| Ensemble | Fichiers principaux |
| --- | --- |
| Schéma | `prisma/schema.prisma` ; `prisma/migrations/20261024090000_add_customer_contacts/migration.sql` |
| Extraction privée | `scripts/extract-gmail-contacts.py` ; `scripts/test_extract_gmail_contacts.py` |
| Import et projection | `src/migration/customer-contacts.ts` ; `scripts/import-customer-contacts.ts` |
| API privée | `src/api/customer-contacts.ts` ; montage dans `src/api/ops.ts` |
| Autorisation | `src/auth/staff-auth.ts`, permission OWNER `customers.manage` |
| Interface du répertoire | `web/admin.html` ; `web/src/lib/customer-contacts.ts` |
| Préférences marketing | `src/api/app.ts` ; `web/src/lib/account.ts` ; `web/src/i18n/index.ts` |
| Tests de contacts | `tests/customer-contacts.test.ts` ; `tests/customer-contacts-db.test.ts` |
| Tests marketing | `tests/marketing-preferences.test.ts` |
| Procédure opérateur | `docs/customer-database.md` |
| Reprise et décisions | `WORKLOG.md` et les cinq documents de continuité dans `docs/` |

## Preuve de mise en ligne : à obtenir

La [dernière livraison complète inspectée, 38952711773](https://github.com/takatakca/r2neet/actions/runs/38952711773),
a échoué faute d’espace disque pendant l’extraction de l’image sur Contabo.
Le [correctif manuel de page de connexion, 39255689426](https://github.com/takatakca/r2neet/actions/runs/39255689426),
a réussi ; il ne prouve pas une livraison complète de la nouvelle image.
L’état disque actuel nécessite une nouvelle vérification par un accès serveur.

Après une livraison, consigner séparément le commit, la migration appliquée, le
run de déploiement non sauté, les sondes de santé et le contrôle du parcours réel.
Un contrôle CI réussi ne remplit pas cette section à lui seul.

---
Note signée : **Codex — assistant OpenAI**. Date : **2026-10-24**, America/New_York.
Sources : résultats GitHub et fichiers du dépôt ; aucune donnée client brute dans ce document.

# R2NETTE — Parcours premium et audit de reprise

2026-10-29 — Codex — assistant OpenAI · session r2neet.

## Demande et périmètre

Matt demande le renommage GitHub en R2net.ca, une inscription par courriel avant achat, un téléphone vérifié après le premier paiement, un parcours mobile guidé, le commercial, les profils sociaux/avis et un consentement explicite aux traceurs. Complément : audit A–Z, calendriers jour/semaine/mois/compact, GPS, photos avant/après, signature électronique, forfaits et suivi signé dans GitHub/Drive.

Le domaine public reste **r2nette.ca**. Le renommage demandé vise le dépôt uniquement. Aucun outil de renommage/administration du dépôt n'est disponible ici ; le dépôt n'a pas été renommé. PR43 (CRM/import historique) reste indépendante, non incluse ni écrasée par ce chantier.

## Ce que cette branche implémente

- `/login`, `/auth`, `/signup` : code courriel Supabase vérifié côté serveur ; challenge aléatoire en cookie HttpOnly, hash en PostgreSQL, expiration et consommation atomique. Session EMAIL distincte d'une preuve téléphone. Aucun mot de passe, aucun consentement marketing implicite. Un courriel de profil historique ne suffit jamais à rattacher une identité de connexion. Anciennes connexions téléphone conservées à `/phone-login`, profils anciens à `/profile`. En production, un nouveau numéro sur l'ancien endpoint reçoit une réponse neutre sans émission SMS ; l'ancien mode d'inscription n'est disponible que sur dépendance explicitement injectée pour migrations/tests.
- `/account/phone/*` : activation volontaire uniquement après un Payment SUCCEEDED positif trouvé côté serveur. Un SetupIntent à zéro, un paiement en attente ou une réservation ne suffisent pas. Aucun transfert du téléphone d'un autre compte. Verrou transactionnel par client et unicité téléphone.
- Réservation : dialogue natif mobile/ordinateur avec fermeture et reprise des sélections non identifiantes ; consultation sans connexion puis courriel avant l'adresse. Session client rechargée au démarrage (ancien défaut corrigé). Le montant/politique du paiement vient du devis/rendez-vous serveur. `/payment` utilise Stripe.js/Payment Element et attend la confirmation serveur ; aucune validation de paiement depuis le navigateur seul. Les politiques PAY_LATER existantes ne deviennent pas des prélèvements arbitraires.
- `/commercial` : parcours FR/EN bureaux, commerces, bars/restauration et cuisines/hottes. Fréquences ponctuelle, quotidienne, hebdomadaire, mensuelle et proposition annuelle. Une demande authentifiée est conservée en PostgreSQL et visible à `/admin#commercial` avec les droits callbacks. Le moment souhaité est en heure de Montréal, à confirmer : aucune fausse réservation Calendly ni créneau ménage créé. Tarifs et documents sur proposition.
- Compte : calendrier jour/semaine/mois/compact avec API bornée à 43 jours et 500 visites, toujours limitée au client de session. Liste et déplacement existants conservés. Liens Google Maps, Waze et Apple Plans à action volontaire, aucune carte distante chargée automatiquement.
- Consentement : bandeau refuser/personnaliser/accepter, facultatif refusé par défaut. Historique pseudonyme versionné dans PrivacyConsent ; retrait accessible en permanence. Aucun pixel Meta avant accord publicité ; uniquement si ID explicitement configuré, sur pages publiques sans paramètres. Jamais sur login/compte/admin/paiement. Aucun CAPI ajouté ni donnée de client envoyée par cette branche. Newsletter distincte. Pages `/privacy` et `/terms` accessibles.
- Footer : Facebook fourni par Matt et Instagram trouvé au registre ; autres URLs uniquement via configuration validée (hôtes autorisés). Les avis publiés existants continuent de venir de la base : pas de faux avis sociaux ou d'étiquettes « live » sans source.

## Validation et limites

La génération Prisma normale est refusée par le proxy sur binaries.prisma.sh. Un client **sans moteur** a été généré localement depuis le vrai schéma par le générateur Prisma et sa DMMF WASM, sans désactiver les sommes de contrôle ni contourner le proxy. Cela permet le typage et les tests HTTP simulés ; ce n'est pas un test PostgreSQL. La CI doit appliquer la migration à une base jetable, vérifier le diff de schéma et exécuter les nouveaux tests PostgreSQL (course de consommation, absence de rapprochement historique, premier paiement positif et demande commerciale).

Les tests navigateur utilisent des réponses API de test : ils ne prouvent ni livraison courriel/SMS ni paiement réel ni calendrier d'un agent externe. Les simulations sont identifiées comme telles dans le rapport de livraison.

## Activation — bloquants concrets

Le dernier déploiement réellement vérifié est **74434524f6b8f9348240be9e13d158d0060566c5**, Deploy **40450497185**, job **122011814392**, 2026-10-27 : étape Roll exécutée, /healthz et /readyz OK, SHA exact confirmé. Cela remplace les anciens blocs ENOSPC comme dernier état connu. Le même journal signale Stripe, SMS/Voice, Maps, S3 et alertes non configurés. Ce n'est pas une mesure des secrets actuels du serveur.

Avant mise en production de l'inscription : vérifier SMTP, Email Auth, modèle de courriel incluant `{{ .Token }}` et la livraison réelle dans le projet Supabase TAKATAK ; puis `R2NETTE_EMAIL_AUTH_ENABLED=true` dans l'environnement protégé. Sans cet opt-in, le formulaire annonce son indisponibilité et n'invente pas un courriel envoyé. Ne pas déployer un nouveau parcours d'inscription inaccessible : fournir cette preuve avant fusion/release. Stripe nécessite clés et webhook signé, Maps sa clé et l'origine métier. Aucun secret ne doit être écrit dans GitHub ou Drive.

Le modèle courriel ne crée pas encore d'événement outbox TAKATAK : l'intégration reste désactivée jusqu'à validation du destinataire/du périmètre. Les réseaux Pinterest/X/YouTube demandent les URLs R2NETTE vérifiées, ou un export tenant-scopé approuvé de TAKATAK V1 ; aucune collecte multi-marques ni connexion automatique hors consentement.

## Reste demandé — à reprendre, pas à déclarer livré

1. Photos avant/après : stockage privé durable distinct des backups, contrôle taille/type, accès par réservation, retrait des métadonnées, historique et rétention. Aucun stockage public ni faux upload local éphémère.
2. Signature électronique : identifier le prestataire déjà choisi par Matt, contrat de consentement, preuve horodatée et lien signataire. Aucun simple tracé présenté comme intégration existante.
3. Transfert d'un rendez-vous à un autre client : règle d'autorisation, accord et audit. Le déplacement de date existant ne transfère pas la propriété du dossier.
4. Contrats/forfaits commerciaux facturables jour/mois/an : prix approuvés, périmètre de service, taxes et renouvellement/annulation ; aucune somme ou certification inventée. Les fréquences du formulaire sont des besoins, pas des forfaits Stripe créés.
5. Agent IA conversationnel : le concierge guidé existant reste honnête, avec rappel et catalogue. Pas de modèle LLM, facturation ou transfert de données vers un nouvel outil activé dans cette branche. Définir fournisseur, périmètre et transmission avant activation.
6. Audit réel de production de bout en bout après configuration protégée : FR/EN mobile/ordinateur, courriel, devis, créneau, paiement et webhook, SMS après paiement, notification, calendriers, avis, consentement/retrait, accès client/opérateur.

Signature : **Codex — assistant OpenAI**, 2026-10-29.

## Résultats vérifiés de cette passe

- PR **46**, commit initial **5bb6460337ad8495a3f09ef44e72a3421103f985** : CI **40843380976** réussie ; **35 fichiers de tests / 764 tests** tous exécutés et réussis, dont les 3 tests PostgreSQL nouveaux. Migration à vide et comparaison schéma/migrations réussies, typage, deux builds, invariants et conteneur verts. Aucune mise en production de cette branche.
- Audit Chromium local FR, **390×844** et **1440×1000**, réponses API explicitement simulées : inscription courriel → reprise → adresse enregistrée → créneau → facture → confirmation ; calendrier et demande commerciale. 0 erreur JavaScript, 0 appel SMS à l'inscription, aucun script Meta avant accord. Accord puis retrait testés : Meta non rechargé après retrait. Le script de test bloque les vrais appels tiers.
- Inspection visuelle a trouvé puis corrigé du texte blanc de facture sur fond blanc, le résumé mobile mal affiché sur ordinateur et le bouton sticky « Continuer » pouvant avancer sans créer la réservation. Confirmation mobile branchée au même appel serveur que le bouton principal, désactivée tant que la politique de paiement n'est pas vérifiée. Total TTC visible sur mobile, même pour PAY_LATER à zéro aujourd'hui. Le script reproductible est `scripts/verify-premium-browser.ts` (nécessite Vite et Chromium local). Tests et captures ne sont pas une preuve de fournisseurs réels.
- Inspection Supabase en lecture seule : projets TAKATAK STAGING et TAKATAK User Official Dashboard V1 accessibles ; aucun réglage SMTP/Email Templates disponible par ces outils, aucune configuration changée et aucun rattachement deviné. Le destinataire de production doit être confirmé depuis l'environnement protégé.
- Photos/signatures/transfert/forfaits/agent LLM : toujours à réaliser selon les dépendances énumérées. Une question est laissée à Matt pour identifier son service de signature existant ; l'absence de réponse n'est pas un accord de remplacement.
- Suivi visuel final et documentation de clôture : CI du dernier SHA à vérifier après publication ; la référence exacte est consignée dans la conversation de PR.

04:48 EDT — [Codex — assistant OpenAI · session R2NETTE] — Résultats et limitations consignés ; pas d'envoi réel, de paiement réel, de SMS réel ni de migration production.

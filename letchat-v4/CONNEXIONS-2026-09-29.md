# Fluidité des connexions — 29 septembre 2026

Cette mise à jour s'applique après la refonte de l'administration du 29 septembre.
Elle évite que les calculs de mots de passe bloquent le traitement JavaScript du tchat.
Les identifiants, mots de passe, codes de récupération et données existants sont conservés.

## Installation sur GitHub et Render

1. Extraire `letchat-correctif-connexions-fluides.zip`.
2. Sur GitHub, ouvrir le dossier `letchat-v4` du dépôt `letchatfr/letchat`.
3. Choisir **Add file → Upload files**.
4. Déposer le **contenu** du dossier `letchat-v4` extrait : `server.js`, `package.json`, les dossiers `lib` et `test`, et ce guide.
5. Ne pas déposer le dossier parent lui-même : cela créerait un niveau `letchat-v4/letchat-v4` supplémentaire.
6. Enregistrer avec le message **Amélioration de la fluidité des connexions**.
7. Attendre que Render affiche **Live**.
8. Tester une connexion avec un compte existant, puis un échange de messages privés entre deux comptes. Sur un compte de test, vérifier aussi la récupération du mot de passe et conserver son nouveau code de secours.

Aucun nouveau paquet, changement de variable Render ou migration SQL n'est nécessaire.
Le fichier `lib/passwords.js` doit être déposé en même temps que `server.js` et `lib/accounts.js`.

## Fonctionnement

- Inscription, connexion, récupération de mot de passe et renouvellement du code de secours utilisent un service asynchrone commun.
- Les paramètres scrypt restent identiques : N=16384, r=8, p=1, clé de 64 octets, sel transmis comme chaîne UTF-8, résultat hexadécimal. La comparaison utilise `timingSafeEqual`.
- Chaque processus accepte au maximum deux calculs simultanés et huit demandes en attente. Une attente supérieure à cinq secondes, ou une file pleine, renvoie HTTP 503 avec un message explicite et `Retry-After: 2`.
- Les limites de tentatives existantes restent actives. La limite de calcul s'applique au processus entier, tous parcours confondus.
- L'inscription effectue son calcul avant d'ouvrir une transaction SQL.
- Une connexion commencée avant une récupération de mot de passe ou une révocation administrative ne peut pas obtenir un jeton correspondant à la nouvelle version de session. Un compte supprimé ne reçoit pas de jeton.
- Le renouvellement d'un code de secours vérifie toujours la version de session avant sa mise à jour. Une récupération concurrente ne peut pas voir son nouveau code écrasé par une demande devenue obsolète.

Le coût cryptographique demeure : les calculs utilisent les tâches natives de Node.js. La limite réduit leur concurrence ; elle ne garantit pas un nombre de visiteurs supportés par une offre Render donnée.
Référence : [documentation officielle de Node.js, crypto.scrypt](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback).

## Vérifications locales effectuées

- `npm run check` : 33 fichiers JavaScript valides.
- `npm test` : 59 tests réussis, dont sept dédiés aux mots de passe.
- `node test/password-integration.mjs` : 20 contrôles HTTP réussis.
- `node test/integration.mjs` : 66 contrôles généraux réussis.
- `node test/admin-integration.mjs` : 76 contrôles d'administration réussis.

Les tests vérifient la compatibilité avec les anciens hashages, y compris les accents, caractères Unicode, espaces et mots de passe de 200 caractères ; les limites de concurrence ; l'expiration de la file ; la libération des places après une erreur ; et la disponibilité de la boucle d'événements pendant de vrais calculs scrypt.

Les scénarios HTTP reproduisent une récupération, une révocation ou une suppression de compte pendant une vérification de mot de passe. Ils vérifient également qu'un message privé peut être envoyé et lu pendant que les places de calcul sont occupées, que dix connexions sont acceptées et qu'une onzième reçoit une réponse temporaire de surcharge.

Les tests HTTP utilisent une base locale isolée PGlite. La suspension contrôlée des calculs dans `test/password-pause.mjs` sert uniquement à reproduire des chevauchements ; ce module n'est jamais chargé en production. Ces vérifications ne constituent pas une mesure de capacité sur Render ni une validation des verrous de PostgreSQL en environnement multiprocessus.

Pour relancer les tests spécifiques : `npm run test:passwords`.

## Retour arrière

Annuler le commit de cette mise à jour sur GitHub puis redéployer la version précédente. Aucune donnée n'a changé de format ; les anciens comptes et les comptes créés avec cette mise à jour utilisent le même format de mot de passe.

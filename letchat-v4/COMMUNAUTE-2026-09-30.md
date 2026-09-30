# Mise à jour communauté — 30 septembre 2026

Base : `df0dd3b000c4bf10edf2ae0ee18a2c648fa42f0a` du dépôt `letchatfr/letchat`.

## Ce qui change

- **Accueil connecté** : accessible après connexion, après acceptation des règles et via le logo. Six salons publics classés selon leur fréquentation réelle, membres disponibles et accès direct à une discussion. Le mode calme propose de lancer un échange au Café. Les compteurs excluent ses propres connexions, les doublons d’onglets, les comptes bloqués et les membres en mode discret. L’activité se rafraîchit à l’arrivée et au départ des membres, puis toutes les 15 secondes lorsque l’accueil est ouvert.
- **Rencontre Surprise** : jusqu’à trois centres d’intérêt facultatifs pour chaque recherche. Deux sélections doivent avoir au moins un intérêt commun ; une sélection vide signifie « ouvert à tous les sujets ». Choix conservés pour « Passer », durée d’attente visible, accès aux salons après annulation de la recherche. Les protections existantes de blocage, d’âge, de consentement et de messages privés restent actives.
- **Mobile** : barre basse Salons, Messages, Membres et Profil, compteur de messages privés non lus et état de navigation. La barre se masque pendant la saisie lorsque le clavier réduit l’espace disponible. Les notifications de messages se placent au-dessus de la zone de saisie.
- **Invité vers compte permanent** : bouton dans l’accueil, dans le profil et dans un rappel discret du tchat. Identifiant, mot de passe confirmé et code de récupération. Conversion transactionnelle du compte existant : même identifiant interne, profil, amis et conversations encore disponibles. Ancien jeton invité invalidé. La durée de vie des messages reste de 48 heures.

## Installation

La mise à jour concerne uniquement le dossier **letchat-v4**. Le fichier `server.js` à la racine du dépôt et les anciens dossiers ne sont pas l’application concernée.

1. Intégrer le commit de cette mise à jour dans la branche déployée après validation.
2. Vérifier que le service Render utilise bien `letchat-v4` comme dossier racine.
3. Garder `npm ci` comme installation et `npm start` comme commande de démarrage. Le script `prestart` reconstruit les ressources avec leurs nouvelles empreintes.
4. Après déploiement, vérifier le nouveau parcours avec un compte de test invité et un second navigateur.

Aucune nouvelle dépendance, variable d’environnement ou migration de structure n’est nécessaire. Les comptes convertis restent compatibles avec la version précédente du serveur si l’interface doit être rétablie.

## Vérifications effectuées localement

- `npm run build` : 31 ressources générées.
- `npm run check` : 36 fichiers JavaScript vérifiés.
- `node --test test/client.test.mjs test/passwords.test.mjs` : 8 tests réussis.
- `npm run test:surprise` : 32 contrôles d’intégration réussis.
- `npm run test:community`, avec le parcours navigateur activé : 39 contrôles réussis.
- Navigateur Chromium : ordinateur 1365 × 940, mobile 390 × 844, petite largeur 320 px, thème clair/sombre, fenêtre réduite pour simuler le clavier, échange privé réel entre deux sessions de test et conversion de compte.

La base de test est PGlite, isolée de la production. Les essais de connexion utilisent les comptes locaux ; Firebase est simulé dans les tests de navigateur. La connexion Google, les paiements Stripe et les appels caméra réels ne sont pas retestés par cette mise à jour. Aucun compte utilisateur de production n’a été modifié.

Le test d’intégration accepte aussi `LETCHAT_COMMUNITY_TEST_DATABASE_URL` pour une base PostgreSQL de test vierge. Cette option ne doit jamais viser la production. Pour le parcours navigateur : `LETCHAT_BROWSER_QA=1 npm run test:community`, avec Playwright et Chromium disponibles dans l’environnement de test.

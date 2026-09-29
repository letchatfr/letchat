# Letchat — correctifs du 29 septembre 2026

Base : letchat-main(14).zip fourni par Yann le 29 septembre 2026.

## Corrections livrées
- F02 : seuls les services push de navigateur autorisés sont acceptés ; contrôle HTTPS, hôte, port, identifiants et clés P-256. Vérification des adresses DNS au moment de la connexion, refus des adresses locales/privées/réservées, délai d’envoi de 5 secondes. Les anciennes lignes invalides sont rejetées avant envoi. Maximum 10 abonnements par membre et limitation de fréquence. Le changement de compte sur un appareil transfère l’abonnement au nouveau compte.
- F03 : identifiant de connexion stable distinct du nom affiché. Visible uniquement dans son propre profil, renvoyé par l’API de récupération et inscrit dans le fichier de récupération. La connexion restitue le nom affiché actuel. Aucun identifiant existant ni mot de passe n’est modifié par la mise à jour.
- F08 : nom accessible ajouté aux trois fenêtres de récupération.
- F09 : cinq tests publicitaires obsolètes remis en accord avec le chargement préalable du consentement, le délai de 20 secondes et le libellé actuel. Le code publicitaire et les réglages Google restent inchangés.
- F01 : la correction précédente sur la confidentialité des signalements et blocages est conservée et vérifiée.

## Vérifications
- Construction : 26 ressources publiques générées avec empreinte.
- Syntaxe : 30 fichiers JavaScript contrôlés.
- Tests unitaires : 52 réussis, 0 échec. Comprend les contrôles DNS/URL/clés et le téléchargement réel d’un Blob de récupération dans JSDOM.
- Suite d’intégration existante : 66 vérifications réussies.
- Nouvelle suite ciblée : 33 vérifications réussies (récupération après renommage, sessions révoquées, notifications, limite d’appareils, changement de compte, exports).
- Vérification finale du client sur le HTML généré : réussie.
Ces scénarios comportent des recouvrements ; les nombres ne désignent pas autant de fonctionnalités distinctes.

Tests réalisés avec Node.js 24 et une base locale PGlite éphémère. Aucune donnée de production ni livraison push réelle utilisée. Le contrôle visuel sur téléphone, la livraison réelle Chrome/Firefox/Safari/Edge et les verrous concurrents sur PostgreSQL de production restent à valider. Le lot ne clôt pas l’ensemble de l’audit : F04, F05, F06, F07, F10 à F15 restent à traiter selon leurs prérequis. Les réglages AdSense nécessitent toujours une vérification propre dans Google.

## Installation
1. Extraire letchat-correctifs-comptes-notifications.zip.
2. Dans le dépôt GitHub, ouvrir le dossier existant letchat-v4.
3. Choisir Add file > Upload files.
4. Glisser le CONTENU du dossier letchat-v4 extrait : lib, public, templates, test, server.js et ce document. Ne pas glisser le dossier letchat-v4 lui-même à l’intérieur de letchat-v4.
5. Vérifier les chemins : letchat-v4/server.js, letchat-v4/lib/push-security.js et letchat-v4/templates/index.html.
6. Enregistrer avec Commit changes, puis attendre le déploiement Render.
7. Recharger Letchat. Dans son profil, vérifier les deux champs Identifiant de connexion et Nom affiché. Avec un compte de test, changer seulement le nom affiché, générer un nouveau code puis télécharger le fichier : il doit contenir l’identifiant initial.
8. Tester la récupération avec ce fichier et un nouveau mot de passe. La récupération révoque les anciennes sessions comme auparavant.

Le correctif contient à la fois les sources et les fichiers publics générés. Aucune nouvelle dépendance ni variable d’environnement n’est nécessaire. Conserver la racine actuelle du service Render pour ce lot.

Commandes de contrôle depuis letchat-v4 :
    npm ci
    npm run build
    npm run check
    npm test
    npm run test:integration
    node test/priority-integration.mjs

## Références techniques consultées
- Mozilla, services push de production : https://mozilla-services.github.io/autopush-rs/
- Chromium, destination Web Push /wp/ : https://chromium.googlesource.com/chromium/src/+/refs/tags/141.0.7390.94/components/push_messaging/push_messaging_constants.cc
- WebKit, domaines push Apple : https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Microsoft, Push API : https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/push
- Transport web-push 3.6.7 : code installé vérifié (https.request, absence de suivi des redirections).

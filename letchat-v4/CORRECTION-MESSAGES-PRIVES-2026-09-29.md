# Letchat — correctif des destinataires privés (29 septembre 2026)

Suite du lot Comptes et notifications, déployé puis vérifié par Yann.
Ce lot traite le point F04 de l’audit.

## Comportement
- Destinataire absent ou supprimé : erreur 404 et message explicite.
- Compte invité expiré ou profil local sans compte associé : erreur 410.
- Un membre permanent simplement hors ligne peut toujours recevoir un message.
- Contrôle des deux participants afin de couvrir aussi une suppression du compte expéditeur pendant la requête.
- Verrous de transaction cohérents entre envoi, suppression et nettoyage des invités expirés. Vérification de l’expiration au moment de l’insertion.
- Le message, les préférences de conversation et la notification sont enregistrés dans une même transaction. Un échec annule les trois ; les événements temps réel et push sont émis après la validation de la transaction.
- L’interface affiche déjà les erreurs reçues et conserve le brouillon : ce comportement a été testé.

Les blocages, le mode amis uniquement, le refus des messages privés, les conversations silencieuses et les médias existants sont conservés. Les correctifs de récupération, notifications et confidentialité des exports du lot précédent sont présents.

## Contrôles réalisés localement
- Reproduction avant correction : l’envoi à un identifiant inexistant répondait 201.
- 22 contrôles ciblés réussis : destinataires absents/supprimés/expirés, profils locaux orphelins, absence de messages/notifications/conversations créés après refus, confidentialité des messages, blocages, mode silencieux, destinataire hors ligne, annulation complète après une panne simulée de notification et serveur toujours disponible après cette panne.
- 52 tests unitaires réussis, dont l’affichage de l’erreur et la conservation du brouillon côté client.
- 66 contrôles d’intégration générale réussis sur le code final.
- 33 contrôles du précédent lot comptes/notifications réussis pendant la validation de ce lot.
- Contrôle de syntaxe : 30 fichiers JavaScript.
Ces suites se recouvrent : leurs nombres ne représentent pas autant de fonctions distinctes.

Environnement : Node.js 24, base PGlite éphémère. Aucune donnée de production modifiée pendant ces tests. Les suppressions simultanées multi-processus sur PostgreSQL natif restent à valider en préproduction : le serveur natif n’a pas pu être exécuté sous un utilisateur non privilégié dans cet environnement. Ne pas présenter ces cas comme testés sur Render.
La panne de notification est injectée uniquement par test/private-fault-injection.mjs, chargé explicitement par le serveur de test. npm start ne charge jamais ce module.

## Installation GitHub
1. Extraire letchat-correctif-messages-prives.zip.
2. Dans le dépôt GitHub, ouvrir le dossier letchat-v4 déjà utilisé sur Render.
3. Add file > Upload files.
4. Glisser le CONTENU du dossier letchat-v4 extrait : server.js, le dossier test et ce document.
5. Enregistrer avec le message « Correction des destinataires des messages privés ».
6. Attendre Live sur Render.

Aucune nouvelle dépendance, variable d’environnement ou modification de la racine Render n’est requise.

## Contrôle en ligne après déploiement
Utiliser uniquement deux comptes de test. Avec A, ouvrir une conversation avec B. Envoyer un premier message normal. Supprimer ensuite B depuis son propre profil. En conservant la conversation ouverte côté A, tenter un nouvel envoi : le site doit afficher que le compte est indisponible, conserver le texte saisi et ne pas ajouter le message à la conversation.
Ne pas supprimer un compte principal pour ce test.

## Commandes depuis letchat-v4
    npm run check
    npm test
    npm run test:integration
    node test/priority-integration.mjs
    node test/private-recipient-integration.mjs

Référence sur les verrous de ligne : https://www.postgresql.org/docs/current/explicit-locking.html

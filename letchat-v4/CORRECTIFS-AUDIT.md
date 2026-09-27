# Correctifs Letchat V2 — 27 septembre 2026

Base : dépôt `letchatfr/letchat`, dossier `letchat-v4`, commit `b20e476fa52c595963c208e0aaab84a864b61a7d`.

Ce lot est préparé et testé localement. Il n’a pas été envoyé sur GitHub ni déployé sur Render : l’intégration GitHub a refusé l’écriture (403). Ce document ne remplace pas une recette en préproduction.

## État des 12 points

| Audit | Modification | État / limite |
|---|---|---|
| A01 | Identifiant d’appel, invitation, acceptation, participants contrôlés côté serveur ; fermeture après refus, blocage, changement de salon, expiration et déconnexion ; quotas de signalisation | Tests unitaires et Socket.IO passés. Flux caméra/micro réels à valider. Un appel direct par participant. |
| A02 | Seuls identifiant, nom et photo sont transmis dans les signaux d’appel | Test avec e-mail et ville fictifs : ces champs ne sont pas transmis. |
| A03 | Vérification de la signature des médias, liste de formats, réencodage WebP des images et avatars, SVG refusés, limites de taille et de pixels ; réponses média avec CSP sandbox et nosniff ; récupération par en-tête Authorization puis URL blob | Tests HTTP passés, dont confidentialité et lecture unique concurrente. Les médias restent sur le même domaine, protégés par ces contrôles ; un domaine séparé n’a pas été provisionné. Les anciens clients doivent être rechargés. |
| A04 | E-mail de contact réel, majorité à 18 ans, méthodes de connexion, récupération et informations techniques de conservation actualisées ; abonnements décrits | Partiel : identité/statut/adresse de l’éditeur, directeur de publication, entité/adresse de l’hébergeur, durées de sécurité/journaux et conditions de vente détaillées à compléter et valider. Aucun de ces éléments n’a été inventé. |
| A05 | Paiement refusé aux invités côté serveur et interface | Test HTTP 403 passé. Les éventuels anciens invités déjà abonnés nécessitent un traitement manuel. |
| A06 | Liens corrigés ; `/privacy.html` redirige vers `/confidentialite.html` ; véritables 404 | Tests HTTP passés. |
| A07 | Injection AdSense supprimée, absence de chargement publicitaire explicitée | Protection appliquée par suspension de la publicité. Une CMP Google certifiée et la recette du consentement restent nécessaires avant reprise. Le compte AdSense n’a pas été modifié. |
| A08 | Code de récupération de 192 bits, empreinte en base, consommation atomique, nouveau code après utilisation, génération depuis le profil avec mot de passe courant ; invalidation des sessions | Tests de réutilisation et concurrence passés. Les anciens comptes doivent générer et conserver leur code ; un compte déjà inaccessible sans code n’est pas récupérable automatiquement. Les comptes Google utilisent Google. |
| A09 | Expiration des sockets, validation des sessions pendant l’utilisation, déconnexion serveur après suppression/récupération ; purge des comptes invités expirés | Tests passés. Les invités liés à un abonnement non terminé sont exclus de la purge. La suppression des données invitées expirées est effective dès le nettoyage après déploiement. |
| A10 | Client Stripe stable, clé de paiement persistante, file d’attente par compte et verrou PostgreSQL, réutilisation du paiement ouvert, expiration avant changement de formule, contrôle d’abonnement existant ; suppression du compte coordonnée avec la facturation | Scénarios avec Stripe simulé passés. Aucun paiement réel/test Stripe effectué. Les verrous entre plusieurs processus doivent être validés avec PostgreSQL réel ; les anciennes sessions créées avant ce lot ne sont pas automatiquement réconciliées. |
| A11 | `robots.txt`, description, canonique et métadonnées de partage | Tests HTTP passés. Search Console et indexation réelle non vérifiés. |
| A12 | Ressources publiques avec empreinte dans le nom, cache immutable, service worker cache-first pour ces fichiers ; HTML revalidé, API et médias exclus du cache | Tests HTTP et génération passés. Pas de score Lighthouse annoncé. |

La connexion Google bénéficie aussi d’une politique COOP compatible avec les fenêtres OAuth et d’un bouton de reprise dans l’onglet. Le blocage initial du navigateur distant n’a pas été reproduit dans un navigateur utilisateur : sa cause n’est pas certifiée.

## Vérifications effectuées

- 10 tests automatisés ciblés : invitations et refus, tiers non invité, concurrence d’invitations, blocages, filtrage des profils, formats média, réencodage, codes de récupération et initialisation de l’interface dans un DOM simulé.
- 37 vérifications d’intégration : vrai serveur HTTP et Socket.IO, comptes fictifs, migrations SQL, règles d’accès, médias publics/privés, récupération concurrente, révocation, expiration et suppression ; moteur PostgreSQL WASM isolé (PGlite), services Stripe simulés.
- 12 fichiers JavaScript actifs/modules/scripts contrôlés pour la syntaxe.
- Échantillons audio WebM, audio M4A et vidéo MP4 acceptés avec le bon type après détection.
- `npm audit --omit=dev` : aucune vulnérabilité connue signalée dans les dépendances de production au moment du contrôle. Sharp est fixé à 0.35.4.
- Pas de modification des données de production, ni de paiement, de message à un membre ou de connexion réussie au compte personnel pendant ce travail.

Le DOM simulé ne valide pas le rendu visuel sur appareil réel. La recette Chrome Android/Safari iPhone, Google/Firebase, caméra/micro/TURN, Stripe test et les verrous PostgreSQL entre processus restent nécessaires.

## Installation

1. Conserver une sauvegarde de la base PostgreSQL et la révision actuelle du code avant la mise à jour. Les nouveaux champs sont ajoutés sans remplacement des tables. Le nettoyage supprime désormais les comptes invités expirés et leurs données actives.
2. Dans GitHub, créer une branche depuis `main`, puis envoyer les dossiers du paquet à la racine du dépôt. Le dossier `letchat-v4` du paquet doit fusionner avec le dossier existant du même nom. Il ne doit pas être placé à l’intérieur de `letchat-v4/public` ni doublé en `letchat-v4/letchat-v4`.
3. Enregistrer les changements sur cette branche et ouvrir la proposition de fusion. Le contrôle automatisé fourni exécute les tests avec un service PostgreSQL 16 temporaire. Ce contrôle n’a pas encore été exécuté sur GitHub faute de droit d’écriture.
4. Déployer d’abord cette branche sur un service de préproduction avec une base séparée et les clés Stripe de test. Ne pas relier cette préproduction à la base de production.
5. Pour Render : répertoire de travail `letchat-v4`, commande de construction `npm ci --omit=dev && npm run build`, commande de démarrage `npm start`. Node >= 20.9 requis ; Node 24 recommandé et utilisé pour les tests. Conserver les variables Firebase, Stripe, PostgreSQL, JWT et TURN existantes. `PUBLIC_BASE_URL` doit correspondre au domaine du service.
6. Vérifier les scénarios ci-dessous avant fusion et déploiement en production. Après déploiement, recharger les anciens onglets : les appels et les URL des médias ont changé de protocole.

Les fichiers envoyés sont complets ; aucun fragment à insérer manuellement. Les fichiers du dépôt absents du paquet doivent être conservés. `templates/index.html` devient la source de l’accueil ; `npm run build` génère `public/index.html`, les ressources à empreinte et le service worker. Ne modifier ensuite que le modèle pour les changements d’accueil.

## Recette avant production

| Parcours | Résultat attendu |
|---|---|
| Deux navigateurs et un tiers | A appelle B, B accepte ; C ne peut pas rejoindre. Refus, blocage, sortie de salon et déconnexion ferment l’appel. |
| Caméra et voix | Image et son dans les deux sens, réactivation caméra, microphone et partage d’écran ; tests entre réseaux différents. |
| Google sur ordinateur et téléphone | Popup ou redirection aboutit, session conservée et renouvelée ; aucun blocage CSP dans la console. |
| Compte pseudonyme | Enregistrer le code, se déconnecter, utiliser « Mot de passe oublié », vérifier que l’ancien code et les anciennes sessions ne fonctionnent plus. |
| Médias | Images, voix et vidéo ; agrandissement ; réception privée ; lecture unique ; refus d’un SVG ou d’un faux format. |
| Stripe test | Abandon puis reprise, deux onglets, changement de formule, retour paiement, webhook signé, renouvellement, impayé, résiliation et nouvelle souscription après fin. |
| Invité | Paiement impossible ; expiration et purge ; compte permanent existant conservé. |
| Téléphone | Menus, clavier, modales de récupération, mode sombre et affichage des médias. |

## Éléments extérieurs au lot

- Renseigner les données légales manquantes, confirmer les durées de conservation, la rétractation, les conditions de vente et la médiation applicables.
- Choisir/configurer la CMP AdSense avant toute reprise publicitaire. Le chargement d’AdSense est également exclu de la CSP actuelle : sa réactivation nécessite une modification explicitement testée.
- Vérifier les sessions Stripe historiques, les éventuels comptes invités déjà abonnés et les paiements dont la réponse aurait été perdue depuis plus de 23 heures.
- Vérifier la chaîne de confiance TLS de PostgreSQL avant de remplacer la configuration historique `rejectUnauthorized: false`. Ce paramètre n’a pas été changé sans validation de l’infrastructure.
- Fixer la politique de conservation des preuves de signalement avant de stocker des copies supplémentaires de médias. Le présent lot n’en crée pas.
- Tester sauvegarde/restauration, capacité, supervision et architecture multi-instance. La présence et les appels restent en mémoire d’un seul processus ; ce lot ne rend pas l’application multi-instance.

Références techniques utilisées : [MDN COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy), [Sharp](https://sharp.pixelplumbing.com/api-constructor/), [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions), [PGlite et ses limites](https://pglite.dev/docs/pglite-socket). Informations juridiques à adapter : [CNIL traceurs](https://www.cnil.fr/fr/cookies-et-autres-traceurs/que-dit-la-loi), [Service Public rétractation](https://www.service-public.gouv.fr/particuliers/vosdroits/F10485).

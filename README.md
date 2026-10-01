# Letchat — communauté V3

Application maintenue : **`letchat-v4/`**. Le nom de ce dossier est historique ; il reste stable pour les services Render existants. La V3 désigne la nouvelle version produit (le package technique historique reste en 4.0.0).

## Exécuter

Node.js 20.9 ou plus récent. Depuis `letchat-v4` :

```sh
npm ci
npm run build
npm run check
npm test
npm run test:v3
npm start
```

Le démarrage nécessite `DATABASE_URL` et `JWT_SECRET` (au moins 32 caractères). Conserver les valeurs existantes de Firebase, Stripe, TURN, VAPID et des accès administrateurs. Ne jamais placer de secrets dans Git.

À la racine, `npm ci` installe les dépendances de l’application et `npm start` lance la même application. `node server.js` est également un point d’entrée de compatibilité.

## Organisation

- `letchat-v4/server.js` : serveur Express et Socket.IO.
- `letchat-v4/lib/` : fonctionnalités serveur, sécurité et accès aux données.
- `letchat-v4/public/` : sources de l’interface et pages publiques.
- `letchat-v4/templates/` : pages reconstruites au démarrage.
- `letchat-v4/scripts/build-assets.mjs` : empreintes des ressources, feuille de style commune, cache public.
- `letchat-v4/test/` : tests unitaires et d’intégration, bases locales temporaires.
- `archive/versions-historiques.zip` : les 99 fichiers historiques conservés avec leurs chemins et leur contenu, jamais servis par l’application et à ne pas déployer.
- `render.yaml` : seul Blueprint actif, ciblant `letchat-v4` et la base existante.

## Déploiement et retour arrière

La branche V3 doit être examinée et testée avant fusion dans `main`. Aucune synchronisation Render n’est nécessaire pour examiner la branche. Vérifier le dossier racine `letchat-v4`, les commandes et les variables existantes avant une mise en ligne. Ne pas recréer la base PostgreSQL.

Le Blueprint n’attribue aucun nouveau plan et ne crée aucune base. Les secrets `sync: false` doivent reprendre les valeurs du service existant lors d’une première synchronisation. Référence : https://render.com/docs/blueprint-spec

Les migrations V3 ajoutent des tables et deux colonnes `edited_at`. Elles ne suppriment aucune table existante. Un retour au commit antérieur ignore ces ajouts ; les fonctions V3 deviennent alors indisponibles. Sauvegarder la base selon le dispositif de l’hébergeur avant la publication. Le redémarrage coupe brièvement les connexions et réinitialise les rencontres en attente et les compteurs techniques.

Consulter `letchat-v4/V3-2026-10-01.md` pour le périmètre et les vérifications.

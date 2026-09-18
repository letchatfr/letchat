# Letchat 3.0

Base de production avec PostgreSQL, authentification, tchat général temps réel et messages privés.

## Render

- Build command : `npm install`
- Start command : `npm start`
- Variable `JWT_SECRET` : générer une valeur secrète
- Variable `DATABASE_URL` : URL de la base PostgreSQL Render

Au démarrage, Letchat crée automatiquement les tables :
`users`, `messages`, `conversations`, `private_messages`.

## Déploiement

1. Créer une base PostgreSQL sur Render.
2. Copier sa `DATABASE_URL` dans le Web Service.
3. Ajouter `JWT_SECRET`.
4. Déployer.
5. Ouvrir `/api/health` : `database:true` confirme la connexion.

## Sécurité

Ne jamais mettre de clé secrète Stripe, OpenAI ou autre API dans le navigateur ou dans GitHub.

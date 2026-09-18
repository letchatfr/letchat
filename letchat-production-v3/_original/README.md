# Letchat — version temps réel

Cette version remplace les utilisateurs/messages de démonstration par :
- comptes utilisateurs stockés en PostgreSQL ;
- mots de passe hachés avec bcrypt ;
- authentification JWT ;
- salon général persistant ;
- conversations privées persistantes ;
- présence en ligne via Socket.IO/WebSockets ;
- déploiement Render compatible.

## Render

1. Crée un Render Postgres dans la même région que ton Web Service. Render fournit une URL de connexion interne à utiliser depuis le Web Service. citeturn701639search1
2. Dans le Web Service `letchat`, ajoute :
   - `DATABASE_URL` = URL interne de Render Postgres
   - `JWT_SECRET` = une longue valeur aléatoire
   - tes variables Stripe existantes.
3. Build: `npm install`
4. Start: `npm start`
5. Le serveur écoute sur `0.0.0.0:$PORT`, ce qui est requis par Render pour un Web Service public. citeturn701639search2
6. Render accepte les WebSockets entrants, ce qui permet au tchat temps réel de fonctionner. citeturn701639search0

## Important

- Ne mets jamais `.env` dans GitHub.
- `JWT_SECRET`, `DATABASE_URL` et les clés Stripe doivent rester dans les variables d'environnement Render.
- Cette version utilise une seule instance serveur pour la présence. Pour plusieurs instances, il faudra ajouter un adaptateur partagé (par ex. Redis) afin de synchroniser les connexions WebSocket. Render documente ce besoin pour les serveurs WebSocket multi-instances. citeturn701639search12

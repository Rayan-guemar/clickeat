# Click Eat — serveur et base de données

## Démarrage local

Node.js >= 22.13 (Node 24 conseillé), sans dépendance npm externe.

```sh
npm start
```

Ouvrir http://127.0.0.1:4173. Le serveur HTTP fournit l’interface et l’API. La base SQLite persistante est créée dans `data/click-eat.sqlite` (ignorée par Git). `PORT`, `HOST` et `DATA_DIR` sont configurables. L’écoute est limitée à la machine locale par défaut. Ne pas exposer ce serveur directement sur Internet sans authentification et HTTPS.

## Fonctionnement

- Le serveur est la source de vérité pour commandes, stocks, quotas, pauses et réservations par session.
- Les validations utilisent un numéro de révision atomique, avec réessai en cas de modification concurrente : deux paniers ne peuvent pas réserver la dernière ressource simultanément.
- Réservations de cinq minutes, expiration évaluée côté serveur à chaque lecture et écriture. Les réservations expirées ne consomment plus de capacité ou de stock.
- Les requêtes ont un identifiant idempotent conservé sept jours : une répétition réseau ne crée pas une deuxième commande ou un deuxième passage en cuisine.
- Les écrans actualisent les données toutes les deux secondes. Les actions cuisine sans réseau sont conservées dans une file locale et réessayées. Un conflit de statut est signalé au lieu d’avancer deux fois.
- Le paiement demeure simulé. Aucun SMS ou remboursement réel n’est envoyé.
- La base démarre sans commande fictive, avec les stocks de départ du prototype. Les anciennes données locales ne sont pas importées automatiquement.

## API

`GET /api/health`, `GET /api/state`, `POST /api/action`.

Le POST reçoit `{requestId, action, payload}`. Actions : `reserve`, `release`, `pay`, `advance`, `delay`, `cancel`, `stock`, `capacity`, `pause`. Les mutations nécessitent une origine identique, le type JSON et l’en-tête `X-Click-Eat: 1`. Session navigateur dans un cookie HttpOnly, SameSite=Strict et Secure sous HTTPS.

## Hébergement

`npm run build` produit un Worker Cloudflare dans `dist/server/index.js` et les ressources navigateur dans `dist/client`. Le serveur utilise la liaison D1 `DB` pour la base et `ASSETS` pour les ressources. Sites conserve son accès privé. Les migrations versionnées dans `drizzle/` créent le schéma avant publication. Le serveur local initialise le même schéma SQLite.

La base utilise une ligne `service_state` avec contenu JSON, numéro de révision et comparaison atomique de révision. Cette première implémentation garantit la cohérence du prototype ; elle n’est pas une validation de la charge cible. Une normalisation des tables et des essais de charge sont nécessaires pour l’objectif de 4 000 commandes/soir et 1 000 visiteurs concurrents. Le mécanisme actuel transfère un instantané complet du service et ne repose pas sur WebSockets.

L’accès privé Sites protège l’ensemble de l’application ; il n’y a pas encore de séparation de rôles client/cuisine/manager. Ne pas rendre le site public avant cette séparation. Les prix et recettes restent fixes, les quotas sont globaux et les retards ne réordonnancent pas toute la capacité.

## Vérification

`npm test` : concurrence, réservations, expiration, paiement idempotent, protection des sessions, cycle cuisine, validation des entrées et persistance.

## Photo

Jemima Whyles / Unsplash : https://unsplash.com/photos/a-pizza-sitting-in-a-stone-oven-with-flames-coming-out-of-it-KUdkIGMGnhM (licence Unsplash).

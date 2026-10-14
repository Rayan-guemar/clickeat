# Migration du serveur — 14 octobre 2026

## Résultat

Le serveur autonome est maintenant implémenté dans `backend/` en Python/FastAPI, avec Psycopg et PostgreSQL. Le Dockerfile utilise Python 3.13 ; Compose lance `app` et `db` (image PostgreSQL 17), avec un volume PostgreSQL persistant et sans port base publié sur l'hôte.

Le contrat des routes client/pilotage est conservé. Les règles métier portées incluent les recettes/BOM, les prix figés, les stocks cumulés, les créneaux, les quotas individuels, l'expiration à cinq minutes, les étapes cuisine et les identités client privées.

PostgreSQL contient des tables distinctes pour les ingrédients, recettes et compositions, créneaux, commandes, réservations, visiteurs, notifications et tickets idempotents. Les détails figés sont des instantanés JSONB par commande/réservation. Une transaction enregistre la décision métier et la réponse du ticket ; les verrous transactionnels ordonnent les tickets et empêchent les surréservations entre plusieurs processus.

L'authentification du pilotage autonome utilise HTTP Basic (compte `admin`, secret configuré), sans faire confiance aux en-têtes Sites du navigateur. Les secrets ne sont ni intégrés à l'image ni enregistrés dans Git.

## Vérifications effectuées

- **25 tests réussis**, aucun test ignoré, avec Python **3.13** et un véritable PostgreSQL **16.2 temporaire**, accessible par une socket privée ; pas de modification de la base du site publié.
- 18 tests métier/contrat HTTP : panier cumulé, validation des entrées, quotas différents, conservation des réservations existantes, prix/BOM figés, catalogue versionné, cycle cuisine, confidentialité, authentification et origine des mutations.
- 7 tests d'intégration PostgreSQL : 30 clients/3 produits attribués aux premiers tickets ; idempotence de paiements concurrents ; catalogue/quota/expiration ; isolation client ; capacité concurrente et rollback simulé ; parcours HTTP FastAPI réel ; cycle de démarrage/arrêt et reprise de tickets par le traitement de fond.
- Migrations répétables avec vérification d'intégrité des fichiers déjà appliqués.
- Installation des versions Python épinglées et `pip check` sans conflit de dépendances.
- Vérification de syntaxe Python et absence d'erreurs d'espacement Git.

Une alerte de dépréciation de Starlette concernant son adaptateur de test HTTPX est présente ; elle n'empêche pas la réussite des tests. Elle ne concerne pas le transport Uvicorn utilisé par l'application.

## Limites précises

Docker n'est pas installé sur la machine de préparation. **L'image Docker n'a donc pas été construite ni exécutée et Compose n'a pas été validé par le moteur Docker.** Les tests PostgreSQL 16.2 ne constituent pas une exécution de l'image PostgreSQL 17 prévue par Compose. Ces vérifications sont la prochaine étape du guide.

Aucun test de charge à 1 000 visiteurs n'a été réalisé sur cette nouvelle architecture. Les écritures métier restent sérialisées et certaines lectures chargent toutes les commandes : il ne faut pas conclure que le seuil de 200 ms est atteint.

La base PostgreSQL démarre sans commandes. L'import SQLite/D1 n'est pas effectué, le site Sites déjà publié n'est pas remplacé et les fichiers historiques sont conservés. Le dossier `server/` est désormais une implémentation historique, exclue de l'image Docker. Paiement et notifications restent simulés.

## Suite

Suivre [DOCKER.md](DOCKER.md) : installer/ouvrir Docker Desktop, préparer les deux secrets dans `.env`, valider la configuration, construire puis lancer les services et vérifier leur état `healthy`.

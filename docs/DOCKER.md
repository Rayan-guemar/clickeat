# Click Eat : FastAPI + PostgreSQL, étape par étape

## Ce qui a changé

Le nouveau serveur est écrit en **Python avec FastAPI**, servi par Uvicorn. La base est un **service PostgreSQL séparé**. Node.js et SQLite ne sont pas utilisés dans cette image.

```text
Navigateur → localhost:4173 → service app (FastAPI)
                                     ↓ réseau privé Compose
                              service db (PostgreSQL)
                                     ↓
                              volume postgres-data
```

- `Dockerfile` construit l'image Python avec le serveur et les écrans existants.
- `compose.yaml` décrit les deux services et attend que PostgreSQL soit disponible avant de lancer l'API.
- `.env` contient les deux mots de passe. Ce fichier est ignoré par Git et exclu de l'image.
- Le volume nommé `postgres-data` conserve les données après remplacement des conteneurs.
- Le service PostgreSQL n'expose aucun port sur le Mac. `app` le contacte par le nom `db`, sur le port interne 5432.
- L'application utilise un compte PostgreSQL dédié à cette base. Dans cette configuration de développement, il est aussi propriétaire du schéma et exécute les migrations.

## 1. Vérifier Docker

Installer et ouvrir Docker Desktop, puis dans le terminal :

```sh
docker --version
docker compose version
docker info
```

La dernière commande doit joindre le moteur Docker. `command not found` signifie que Docker n'est pas disponible ; une erreur de connexion au daemon signifie généralement que Docker Desktop n'est pas démarré.

## 2. Préparer les mots de passe

```sh
cd "$HOME/Documents/ChatGPT/click eat"
cp -n .env.example .env
```

Ouvrir `.env` dans un éditeur et renseigner :

```dotenv
PILOTAGE_PASSWORD='un-mot-de-passe-personnel-de-16-caracteres-minimum'
POSTGRES_PASSWORD='un-autre-mot-de-passe-long-et-personnel'
CLICK_EAT_PORT=4173
PUBLIC_ORIGIN=
```

Choisir ses propres valeurs ; les exemples ne sont pas des identifiants à utiliser. Ne pas transmettre les mots de passe dans le chat. `PILOTAGE_PASSWORD` protège le pilotage ; `POSTGRES_PASSWORD` permet à FastAPI de joindre PostgreSQL. Garder `PUBLIC_ORIGIN` vide pour ce lancement local.

## 3. Vérifier puis démarrer

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

`--build` construit l'image ; `-d` laisse les services tourner en arrière-plan. Au premier lancement, les images et dépendances sont téléchargées. Les deux services doivent devenir `healthy`.

L'API applique les migrations SQL versionnées de `backend/migrations` et initialise le catalogue de démonstration uniquement sur une base neuve. Une modification d'une migration déjà appliquée est refusée : ajouter un nouveau fichier numéroté pour les évolutions.

## 4. Utiliser l'application

- Boutique : http://localhost:4173/
- Pilotage : http://localhost:4173/pilotage
- Identifiant du pilotage : **admin** ; mot de passe : `PILOTAGE_PASSWORD`.
- Santé serveur et connexion base : http://localhost:4173/api/health (retour `database: postgresql`).

Le navigateur présente une boîte de connexion HTTP Basic. En local, le port n'est publié que sur `127.0.0.1`. Avant toute exposition Internet, ajouter un frontal HTTPS et définir `PUBLIC_ORIGIN=https://votre-domaine.fr` : ne pas envoyer ces identifiants sur HTTP public. Aucun en-tête d'identité Sites fourni par le navigateur n'est accepté comme authentification.

## 5. Vérifier les services et les tables

```sh
docker compose logs --tail=100 app
docker compose logs --tail=100 db
docker compose exec db psql -U clickeat -d clickeat -c '\dt'
```

Tables : ingrédients, recettes, composition des recettes, capacités, visiteurs, réservations, commandes, notifications et file de requêtes. Les détails historiques d'une commande (prix et composition figés) sont des instantanés JSONB par commande ; la base n'est pas un fichier SQLite ni un document unique contenant tout le service.

## Concurrence et reprise

Chaque action reçoit un ticket persistant et une clé d'idempotence. Les transactions PostgreSQL traitent les tickets dans leur ordre d'enregistrement. Un verrou transactionnel partagé entre les instances de l'API protège la décision stock/capacité et son enregistrement atomique. Les demandes refusées restent auditables ; rejouer une demande acceptée ne débite pas les ingrédients une deuxième fois. Après un redémarrage, un traitement de fond reprend les tickets en attente.

Les réservations expirent après cinq minutes. Le contrôle du panier est informatif ; la réservation vérifie de nouveau les quantités dans la transaction. Les commandes déjà réservées conservent leur prix et leur composition en cas de modification du catalogue.

Les écritures métier sont actuellement sérialisées et certaines lectures parcourent toutes les commandes. Ce choix privilégie la cohérence ; **il ne valide pas le seuil de 200 ms pour 1 000 clients simultanés**. Les mesures de l'ancienne API ne s'appliquent pas à cette nouvelle version. Paiement et notifications restent simulés.

## Arrêt, mise à jour et sauvegarde

```sh
# Arrêter en conservant PostgreSQL et ses données
docker compose down
# Reconstruire après une modification du code
docker compose up -d --build
# Sauvegarde logique (contient des données client ; garder privée)
docker compose exec -T db pg_dump -U clickeat -d clickeat -Fc > sauvegarde.dump
```

Ne pas utiliser `docker compose down -v` pour un arrêt normal : cette option supprime les volumes. Le volume n'est pas une sauvegarde. Modifier `POSTGRES_PASSWORD` dans `.env` ne change pas le mot de passe d'une base déjà initialisée : une rotation doit aussi modifier le rôle PostgreSQL, sans supprimer le volume.

## Tests Python et PostgreSQL

Pour tester sans Docker, installer Python 3.13 ou supérieur et disposer d'un PostgreSQL de test :

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements-dev.txt
python -m pytest
```

Sans `TEST_DATABASE_URL`, les tests métier/HTTP passent et les tests PostgreSQL sont explicitement ignorés. Pour les exécuter, définir cette variable vers une base de test accessible, puis relancer `python -m pytest`. La suite crée un schéma aléatoire isolé, puis supprime uniquement ce schéma à la fin ; le compte de test doit pouvoir créer des schémas.

Pour démarrer FastAPI sans Docker, définir `DATABASE_URL` (ou `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`) et `PILOTAGE_PASSWORD`, puis :

```sh
uvicorn backend.main:create_app --factory --host 127.0.0.1 --port 4173 --no-proxy-headers
```

Le fichier `.env` est chargé automatiquement par Compose, pas par cette commande Uvicorn.

## Données existantes et site publié

Le nouveau PostgreSQL commence sans commandes, avec un catalogue initial. Il n'importe pas automatiquement les données de `data/` ou du site hébergé. Aucun ancien fichier de base n'est supprimé. Une reprise de données nécessiterait une migration dédiée.

Le site Sites publié reste sur son serveur précédent. Cette migration prépare un déploiement Docker autonome ; elle ne remplace pas à distance son environnement d'exécution. Les sources historiques sont conservées pour permettre de le maintenir.

## Références

- [FastAPI : conteneurs Docker](https://fastapi.tiangolo.com/deployment/docker/)
- [Psycopg : pools de connexions](https://www.psycopg.org/psycopg3/docs/advanced/pool.html)
- [PostgreSQL : verrous transactionnels](https://www.postgresql.org/docs/17/explicit-locking.html)

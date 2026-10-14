> **Serveur autonome actuel : Python / FastAPI + PostgreSQL.**
> Le démarrage Docker utilise deux services (`app` et `db`) : voir [le guide Docker](docs/DOCKER.md).
> Le dossier `backend/` contient l'API Python et les migrations PostgreSQL.
> Les anciens fichiers `server/*.mjs`, `db/` et `drizzle/` sont conservés pour la version Sites déjà publiée ; ils ne sont pas utilisés dans les conteneurs.
> Le passage à PostgreSQL ne migre pas automatiquement les données SQLite/D1 et ne certifie pas l'objectif de 1 000 clients simultanés.

# Spécifications Fonctionnelles Générales — Application Click & Collect Pizzeria Haute Cadence

> **Périmètre & Enjeux :** Système de commande Click & Collect, moteur d'allocation capacitaire temps réel, gestion fine des stocks d'ingrédients (BOM) et ordonnanceur de production cuisine avec validation manuelle.  
> **Dimensionnement opérationnel :** Régime nominal à **300 pizzas/heure**, capacité de crête jusqu'à **4 000 pizzas par soirée** (~800 à 1 000 pizzas/h en pic).  
> **Contrainte Matériel :** Absence de capteurs IoT ou de fours connectés. Les passages d'étapes (enfournement, cuisson terminée, mise en boîte) reposent sur un **ordonnanceur théorique piloté par validation manuelle** des pizzaïolos via écran tactile.

---

## 1. Vue d’Ensemble du Système & Architecture Modulaire

L'application est découpée en quatre modules fonctionnels communicant en temps réel via des flux événementiels et des connexions WebSockets :

1. **Front Client (Web Responsive / PWA)**
   * Consultation du catalogue et des recettes avec disponibilité dynamique.
   * Réservation de créneau horaire garanti et paiement en ligne sécurisé.
   * Suivi d'avancement de la commande (*Tracking client mis à jour par les clics cuisine*).

2. **Moteur d'Allocation Temps Réel (*Core Engine : "Can We Deliver?"*)**
   * Arbitrage instantané à chaque ajout au panier et sélection de créneau.
   * Croisement synchrone : **Stocks ingrédients** × **Capacité théorique déclarée des fours** × **Quota du créneau horaire**.
   * Gestion d'un verrou temporaire (TTL de 5 minutes) évitant les surréservations pendant le paiement.

3. **Ordonnanceur de Production & KDS Manuel (*Kitchen Display System*)**
   * Écran tactile unique ou double poste (Garnissage / Sortie).
   * Ordonnancement automatique des commandes par ordre de priorité selon l'heure de retrait promise.
   * Déclenchement et validation manuelle des étapes par les opérateurs (boutons tactiles rapides).

4. **Back-Office Opérationnel & Manager**
   * Gestion du catalogue, des fiches techniques (Nomenclature / BOM) et stocks.
   * Paramétrage des cadences théoriques par tranche horaire (nombre max de pizzas enfournables par 10 min).
   * Bouton d'urgence (*Panic Button*) pour ajuster ou suspendre les commandes en cas de décalage en cuisine.

---

## 2. Le Moteur d'Acceptation : Algorithme *"Can We Deliver?"*

Le moteur valide la faisabilité de la commande via un calcul théorique prévisionnel sans dépendre d'une mesure machine directe.

```text
[ Client : Ajout panier & Choix créneau T ]
                   │
                   ▼
┌──────────────────────────────────────────────┐
│  Étape 1 : Disponibilité Ingrédients (BOM)   │
│  La somme requise est-elle <= Stock actuel ?  │
└──────────────────────┬───────────────────────┘
                       │
             Non ──────┴────── Oui
              │                 │
              ▼                 ▼
     [ Recette masquée    ┌──────────────────────────────────────────────┐
       ou désactivée ]    │  Étape 2 : Quota Four Théorique sur [T]      │
                          │  Pizzas déjà planifiées + Panier <= Capacité │
                          └──────────────────────┬───────────────────────┘
                                                 │
                                       Non ──────┴────── Oui
                                        │                 │
                                        ▼                 ▼
                               [ Proposer créneau   ┌──────────────────────────────────────────────┐
                                 suivant (ex: T+10) ]│  Étape 3 : Verrouillage Temporaire (TTL 5m)  │
                                                    │  Réservation slot + ingrédients              │
                                                    └──────────────────────┬───────────────────────┘
                                                                           │
                                                                 [ Paiement Validé ? ]
                                                                           │
                                                                 Non ──────┴────── Oui
                                                                  │                 │
                                                                  ▼                 ▼
                                                           [ Rollback /       [ Injection dans
                                                             Libération ]       l'Ordonnanceur ]
```

---

## 3. Spécifications Détaillées par Module

### 3.1. Front Client (Click & Collect)

* **Menu Dynamique :**
  * Dès qu'un ingrédient critique atteint son seuil d'épuisement, les pizzas associées passent immédiatement en `Épuisé`.
* **Sélecteur de Créneaux Basé sur la Capacité Théorique :**
  * Découpage du temps en fenêtres de **10 ou 15 minutes**.
  * Chaque créneau applique un plafond strict de pizzas (ex: max 60 pizzas par tranche de 10 min pour un débit de 360/h).
  * Si le plafond est atteint, le créneau devient grisé et l'utilisateur est orienté vers le créneau disponible suivant.
* **Tunnel d'Achat avec Réservation Temporaire :**
  * Verrou de **5 minutes** sur le panier et le créneau pour sécuriser le temps de paiement.
* **Suivi de Commande Client :**
  * Statuts clairs alimentés par les clics des cuisiniers : *Confirmée* → *En préparation* → *Prête au comptoir*.

---

### 3.2. Gestion des Recettes & Nomenclature (BOM - Bill of Materials)

* **Composition Unitaire par Recette :**
  * Déclaration précise des composants par pizza (pâton, sauce, fromages, garnitures, emballage boîte).
* **Décompte Automatique à la Commande :**
  * Décrémentation instantanée dès validation du paiement.
* **Alertes Stocks Visuelles :**
  * Seuils d'alerte pour avertir le manager sur le back-office avant rupture critique pendant le rush.

---

### 3.3. Ordonnanceur Cuisine & KDS Tactile (100% Manuel)

Puisque les fours ne transmettent aucune donnée, l'outil sert de **guide de travail** et de **file d'attente intelligente** pour l'équipe :

* **Calcul Prévisionnel du Rétro-Planning :**
  * L'ordonnanceur classe les commandes selon la formule :  
    $$\text{Heure de début de préparation} = \text{Heure de retrait client} - (\text{Temps moyen étalage/garnissage} + \text{Temps moyen cuisson})$$
  * Les commandes n'apparaissent sur l'écran actif que lorsqu'il est temps de les lancer, évitant de surcharger visuellement les pizzaïolos.
* **Interface Tactile Simplifiée (Gros Boutons) :**
  * **Poste Préparation :** Le pizzaïolo voit les commandes à préparer classées par priorité horaire.
    * Clic sur `Commencer` (passe la commande en préparation).
    * Clic sur `Enfourné` (retire la commande de la liste de préparation et incrémente le statut interne).
  * **Poste Sortie / Comptoir :**
    * Une liste des commandes attendues en sortie s'affiche avec un chronomètre théorique indicatif.
    * Le pizzaïolo ou l'emballeur clique sur `Prête / Emballée` dès que la pizza sort du four et qu'elle est en boîte.
    * Ce clic déclenche immédiatement l'envoi du SMS/notification au client pour retrait au comptoir.
* **Bouton Retard / Décalage Rapide :**
  * Si la cuisine prend du retard, un bouton `+5 min` sur une commande réajuste automatiquement l'estimation et peut prévenir le client en direct.

---

### 3.4. Back-Office & Ajustement Opérationnel

* **Calibrage de la Capacité Théorique :**
  * Définition simple du plafond de pizzas réalisables par quart d'heure (ex: 50, 75 ou 100 pizzas / 15 min).
  * Possibilité de baisser ce quota en plein service si un employé manque ou si un four chauffe mal.
* **Panic Button :**
  * Blocage d'urgence des commandes en ligne pour 15, 30 ou 60 minutes si la cuisine physique est débordée.
* **Gestion des Stocks Manuelle d'Urgence :**
  * Bouton "Rupture" rapide sur un ingrédient pour désactiver immédiatement toutes les recettes liées sur le site client.

---

## 4. Matrice du Cycle de Vie des Commandes (Pilotage Manuel)

| Statut Système | Condition de Déclenchement | Action Opérateur (Cuisine) | Vue Côté Client |
| :--- | :--- | :--- | :--- |
| `PENDING_PAYMENT` | Début du paiement web. | Aucune action (invisible). | *Finalisation du paiement...* |
| `QUEUED` | Paiement validé. | En attente dans la file planifiée de l'ordonnanceur. | *Commande confirmée* |
| `PREPARING` | Atteinte de l'heure cible de lancement. | Clic manuel sur `Commencer la préparation`. | *En préparation* |
| `READY` | Pizzas cuites et mises en boîte. | Clic manuel sur `Commande prête / Emballée`. | *Prête au comptoir ! (SMS)* |
| `COLLECTED` | Remise de la commande au client. | Clic sur `Retirée` au comptoir. | *Commande terminée* |
| `CANCELLED` | Refus de paiement ou annulation manuelle. | Commande rayée/retirée. | *Commande annulée* |

---

## 5. Exigences Non-Fonctionnelles

* **Performance & Robustesse :**
  * Validation des créneaux en **< 200 ms** même sous un afflux de 1 000 visiteurs simultanés.
  * Capacité d'ordonnancement de 4 000 commandes sans ralentissement sur l'écran tactile.
* **Ergonomie Écran Cuisine :**
  * Interface épurée avec contrastes élevés, conçue pour être manipulée d'un seul doigt sans manipulation fine (grosses tuiles de commande).
* **Résilience Réseau Local :**
  * L'écran de cuisine continue de fonctionner et de stocker les clics manuels même en cas de micro-coupure internet, puis se synchronise dès le rétablissement de la connexion.

# Application actuelle : FastAPI + PostgreSQL

Les spécifications ci-dessus sont les objectifs fonctionnels ; elles ne constituent pas une certification de conformité ou de charge.

Le backend autonome est dans `backend/`. Il utilise FastAPI/Uvicorn, Psycopg et un service PostgreSQL séparé. L'interface client et le pilotage existants sont servis par Python. Docker n'embarque ni le serveur Node.js ni SQLite.

## Démarrage

Suivre [le guide Docker étape par étape](docs/DOCKER.md) : préparer `.env` avec deux mots de passe puis exécuter `docker compose up -d --build`.

- Boutique : http://localhost:4173/
- Pilotage : http://localhost:4173/pilotage ; utilisateur `admin`, mot de passe `PILOTAGE_PASSWORD`.
- Base PostgreSQL : service privé `db`, volume persistant `postgres-data`.

## Fonctionnalités conservées

Catalogue modifiable, composition des recettes, stock cumulé, quotas par créneau, réservations de cinq minutes, suivi client, cuisine manuelle et reprise des actions. Les prix et ingrédients sont figés lors de la réservation. Paiements et notifications restent simulés.

Les mutations sont des tickets idempotents persistants, traités en FIFO dans des transactions PostgreSQL. Les verrous fonctionnent entre processus ; les lectures utilisent des instantanés cohérents. Le compte propriétaire est protégé par HTTP Basic en local ; HTTPS est nécessaire avant exposition Internet.

## API et validation

`GET /api/health`, `GET /api/state`, `POST /api/check`, `POST /api/action`, `GET /api/pilotage/state`, `POST /api/pilotage/action`.
Les mutations nécessitent une origine autorisée et `X-Click-Eat: 1`. Les commandes privées sont filtrées selon le cookie HttpOnly du client. Le serveur ignore les en-têtes d'identité Sites fournis par le navigateur.

Dans un environnement Python activé : `pip install -r backend/requirements-dev.txt`, puis `python -m pytest`. Définir `TEST_DATABASE_URL` pour les tests d'intégration PostgreSQL. Voir [le rapport de migration](docs/MIGRATION-FASTAPI.md).

Le seuil de 200 ms à 1 000 clients n'est pas validé. Le passage à PostgreSQL ne suffit pas à garantir cette performance ; les écritures métier sont encore sérialisées et certaines lectures chargent l'ensemble des commandes.

## Version Sites précédente

Le site déjà publié n'est pas remplacé par ce travail local. Son serveur et ses migrations sont conservés, mais exclus des conteneurs : [archive technique](docs/LEGACY-SITES.md). L'import des anciennes données SQLite/D1 dans PostgreSQL n'est pas automatique.

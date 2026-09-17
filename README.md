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
# Click Eat — prototype interactif
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

`npm run build` produit un Worker Cloudflare dans `dist/server/index.js` et les ressources navigateur dans `dist/client`. Le serveur utilise la liaison D1 `DB` pour la base et `ASSETS` pour les ressources. Sites conserve son accès privé. Le schéma version initiale est créé sans destruction au premier accès à l’API.

La base utilise une ligne `service_state` avec contenu JSON, numéro de révision et comparaison atomique de révision. Cette première implémentation garantit la cohérence du prototype ; elle n’est pas une validation de la charge cible. Une normalisation des tables et des essais de charge sont nécessaires pour l’objectif de 4 000 commandes/soir et 1 000 visiteurs concurrents. Le mécanisme actuel transfère un instantané complet du service et ne repose pas sur WebSockets.

L’accès privé Sites protège l’ensemble de l’application ; il n’y a pas encore de séparation de rôles client/cuisine/manager. Ne pas rendre le site public avant cette séparation. Les prix et recettes restent fixes, les quotas sont globaux et les retards ne réordonnancent pas toute la capacité.

## Vérification

`npm test` : concurrence, réservations, expiration, paiement idempotent, protection des sessions, cycle cuisine, validation des entrées et persistance.

## Photo

Jemima Whyles / Unsplash : https://unsplash.com/photos/a-pizza-sitting-in-a-stone-oven-with-flames-coming-out-of-it-KUdkIGMGnhM (licence Unsplash).

# Livraison et validation — 30 septembre 2026

## Fonctions livrées

- Contrôle serveur du panier cumulé après ajout/retrait ou changement de créneau ; somme des ingrédients partagés entre recettes et des réservations actives. Le bouton de réservation reste bloqué tant que le contrôle échoue. Un prochain créneau disponible est sélectionné si nécessaire. Ce contrôle informatif ne remplace pas l'arbitrage atomique FIFO lors de la réservation.
- Quota de 0 à 200 pizzas propre à chacun des huit prochains créneaux, avec retour au quota général. Zéro ferme le créneau aux nouvelles réservations. Les réservations déjà acceptées restent valides.
- Création et modification des recettes, nom, description, accroche, prix, visibilité et quantités de chaque ingrédient existant. Une version du catalogue empêche l'écrasement de modifications simultanées. Une recette masquée reste dans l'historique.
- Prix, noms et composition figés dès la réservation de cinq minutes ; paiement et restitution lors d'une annulation utilisent la composition réservée.
- Cuisine paginée à 40 commandes par colonne, triées par retrait prévu ; affichage limité à 160 cartes.

## Validation fonctionnelle

`npm test` : **12 tests réussis**, zéro échec. Réservations concurrentes/FIFO, idempotence, droits propriétaire, persistance, cumul BOM, quota individuel, fermeture, proposition du créneau suivant, catalogue et historique couverts.

Vérification navigateur sur base en mémoire isolée : modification Margherita à 12,50 €, propagation au client ; fermeture d'un créneau sans modifier les autres ; panier Margherita + Regina bloqué avec un seul pâton. Aucune donnée du site publié n'a été utilisée pour ces essais.

## Performance : objectif non validé

Mesure reproductible : `npm run test:performance`. SQLite WAL temporaire avec 4 000 commandes, serveur HTTP et générateur sur la même machine et dans le même processus. Les chiffres incluent le transport HTTP local. Rapport brut : `performance-results.json` ; première mesure avant optimisation : `performance-baseline.json`.

| Scénario final | Requêtes / simultanéité | p50 | p95 | Maximum | Erreurs |
|---|---:|---:|---:|---:|---:|
| Contrôle panier séquentiel | 100 / 1 | 4,89 ms | 9,14 ms | 101,46 ms | 0 |
| Pic de contrôles panier | 1 000 / 1 000 | 2 394,08 ms | 7 989,07 ms | 8 043,04 ms | 125 expirations de connexion |
| Lecture pilotage, 4 000 commandes | 20 / 1 | 119,80 ms | 396,11 ms | 580,73 ms | 0 |

Le pic de 1 000 requêtes **échoue** au seuil de 200 ms. Les expirations sont des erreurs de connexion locales ETIMEDOUT, pas des refus métier. Ces résultats ne permettent ni de garantir ni de mesurer directement la capacité Cloudflare D1 en production. La latence du pilotage varie également sous la charge de la machine.

Optimisations réalisées : projection du contrôle panier mise en cache avec vérification de révision en base à chaque demande, invalidation à expiration des réservations ; suppression de la migration d'identité inutile pour un nouveau visiteur ; pagination de la cuisine. L'état métier et les mutations restent dans un document JSON commun, ce qui limite la montée en charge des écritures.

Navigateur local, 4 000 commandes (1 000 par état) : 160 cartes affichées ; rendu JavaScript synchrone de **22,7 ms**, puis **26,6 ms** pour la page suivante. Mesure ponctuelle, hors peinture/composition, réseau et matériel tactile réel. La navigation 41–80/1 000 a été vérifiée. Ce n'est pas une certification complète « sans ralentissement ».

## Pour valider la charge en production

Un essai distribué représentatif sur un environnement de préproduction D1 doit couvrir les visiteurs établis, l'actualisation toutes les deux secondes, les contrôles panier, les réservations simultanées et les paiements. Il doit distinguer les temps d'attente réseau, l'accès base et les conflits d'écriture. Si le seuil reste dépassé, normaliser les stocks, réservations et commandes en tables transactionnelles, puis servir des vues limitées et des mises à jour incrémentales plutôt que l'état complet.

Les paiements et notifications demeurent simulés, comme avant cette livraison. Ce document complète l'audit initial ; il ne constitue pas une déclaration de conformité totale des spécifications.

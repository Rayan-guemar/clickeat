# Vérification des spécifications — 30 septembre 2026

**Audit initial conservé pour historique.** Les points panier cumulé, quotas distincts et édition du catalogue ont depuis été traités. Voir [la livraison et les mesures actualisées](VALIDATION.md). La performance à 1 000 requêtes simultanées reste non validée.

Périmètre : comparaison du cahier des charges fourni et repris dans README.md avec le code local, révision `0fbfe140e6b1f73f493b42984797a40d35494d35`. Relecture des contrôles serveur et des écrans. Exécution de `npm test` : **9 tests réussis, aucun échec**. Aucun test de charge en production ni certification tactile/hors ligne complète réalisé dans cet audit. La réussite des tests existants ne prouve pas la couverture de toutes les exigences.

| Exigence | État constaté | Preuve ou écart |
|---|---|---|
| Boutique et pilotage distincts | Implémenté et testé | Routes client/pilotage ; autorisation propriétaire côté API et commandes filtrées par client. |
| Identifiant client distinct | Implémenté et testé | UUID persistant ; identité ChatGPT ou cookie anonyme. |
| Priorité entre commandes simultanées | Implémenté et testé | Numéro de réservation atomique, traitement dans l’ordre ; test de 30 demandes pour 3 produits. Ne certifie pas 1 000 visiteurs. |
| Contrôle global des ingrédients à la réservation | Implémenté et testé | Somme BOM, réservations actives et stock physique vérifiés côté serveur. |
| Contrôle à chaque ajout au panier | Partiel | L’interface compare les quantités recette par recette. Elle ne vérifie pas la consommation cumulée d’un ingrédient partagé avant la réservation serveur. |
| Créneaux de 10 ou 15 minutes | Implémenté en 10 minutes | Fenêtres de 10 minutes ; pas de réglage à 15 minutes. Le texte autorise 10 ou 15, mais donne ensuite des exemples au quart d’heure. |
| Plafond strict de réservation | Implémenté et testé | Quota global, panier et réservations actives contrôlés atomiquement. |
| Proposition du créneau disponible suivant | Partiel | Créneaux pleins désactivés ; en cas de conflit au paiement, le serveur refuse mais le parcours connecté ne sélectionne pas automatiquement le suivant. |
| Réservation de cinq minutes | Implémenté et testé | Expiration évaluée au serveur ; libération logique des ressources à expiration ou annulation. |
| Paiement en ligne sécurisé | Non implémenté | Bouton de validation simulée ; aucun prestataire, transaction bancaire ni webhook de paiement vérifié. |
| Déduction des ingrédients après paiement | Fonctionne en simulation | Déduction atomique après validation simulée, idempotence testée. |
| Gestion du catalogue et des fiches BOM | Partiel | Consultation des fiches ; recettes et prix codés en dur, pas de création/modification via le pilotage. |
| Nomenclature exhaustive | Partiel | Pâton, base, garnitures principales et boîte présents ; basilic, huile et roquette annoncés ne figurent pas dans les BOM. |
| Stocks, alertes, rupture urgente | Implémenté | Quantités modifiables, seuils visibles, recettes liées indisponibles lors de la prochaine actualisation. |
| Quotas par tranche horaire | Partiel | Une capacité globale commune à tous les créneaux ; pas de planning de quotas individualisés. |
| Pause 15/30/60 minutes | Implémenté | Contrôle serveur des nouvelles réservations ; les commandes déjà acceptées sont conservées. |
| Rétroplanning | Implémenté | Lancement à retrait moins 12 minutes (5 préparation + 7 cuisson), tri horaire et filtrage des commandes futures. |
| Étapes cuisine manuelles | Implémenté et testé | Commencer, enfourné, prête/emballée, retirée ; statut attendu vérifié pour éviter un double passage. |
| Chronomètre de cuisson indicatif | Implémenté | Durée depuis l’enfournement, aucune dépendance IoT. |
| Retard de cinq minutes | Implémenté pour l’estimation | Retrait estimé et affichage modifiés ; pas de réallocation globale des capacités, ni notification externe. |
| Suivi client | Implémenté | Statuts des seules commandes du client actualisés toutes les deux secondes. |
| SMS ou notification de retrait envoyée | Non implémenté | Journal de notifications simulées ; pas de SMS ni notification push externe. |
| Matrice de statuts | Partielle | PENDING_PAYMENT représenté par une réservation temporaire ; étapes de production présentes, avec BAKING interne. Refus bancaire et remboursement réels absents. |
| Flux événementiels / WebSockets | Non implémenté | Interrogation du serveur toutes les deux secondes, sans WebSockets. |
| Résilience cuisine hors ligne | Partielle | File locale de certaines actions et répétition idempotente ; pas de progression locale complète des états ni de restauration complète de l’écran après rechargement sans réseau. |
| Ergonomie responsive/tactile | Implémentation présente, recette terrain à faire | Dispositions adaptatives et boutons cuisine ; utilisation sur matériel réel non certifiée. |
| < 200 ms avec 1 000 visiteurs simultanés | Non validé | Aucun essai représentatif. État métier JSON partagé, comparaisons de révision et instantanés complets : architecture à éprouver sous charge. |
| 4 000 commandes sans ralentissement KDS | Non validé | Aucun test d’affichage à cette volumétrie ; pas de virtualisation des commandes actives. |

## Écarts à résoudre avant clôture complète

1. Intégrer un prestataire de paiement avec validation serveur, webhooks idempotents, échecs et remboursements.
2. Brancher un canal réel de notification de retrait/retard.
3. Rendre catalogue, recettes/BOM et cadences par tranche horaire configurables ; compléter les ingrédients manquants.
4. Vérifier le panier cumulé avant réservation et proposer le prochain créneau après un conflit.
5. Mettre en œuvre les échanges événementiels/WebSockets spécifiés et terminer la reprise hors ligne cuisine.
6. Exécuter des essais de charge et une recette tactile à 1 000 visiteurs / 4 000 commandes ; corriger l’architecture selon les résultats.

## Éléments techniques examinés

- `server/domain.mjs` : stocks, BOM, créneaux, réservations, étapes et retards.
- `server/repository.mjs` : transactions par révision, identités, file FIFO et idempotence.
- `server/api.mjs` : séparation des droits et validation des demandes.
- `dist/server-client.js` : interrogations périodiques, réservations et file locale.
- `dist/app.js`, `dist/sw.js`, `dist/index.html` : écrans, états, cache et métadonnées.
- `tests/server.test.mjs` : neuf tests fonctionnels existants.

Aucune modification fonctionnelle ni publication effectuée dans cet audit. Aucun accord de conformité totale n’est donné.

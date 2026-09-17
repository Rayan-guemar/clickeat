# Click Eat — prototype interactif

Prototype en français d’une application click & collect pour pizzeria. Ouvrir l’application via un serveur HTTP servant `dist/` (ex. `python3 -m http.server 4173 --directory dist`). Aucun outil de compilation nécessaire.

## Parcours

- Tableau de bord, commandes et suivi des notifications simulées.
- Boutique : quatre recettes, panier, contrôle BOM, choix de créneau et verrou de cinq minutes, paiement simulé.
- Cuisine : lancement à retrait moins 12 minutes, préparation, enfournement manuel, commande prête, retrait et retard de cinq minutes.
- Manager : ajustement des stocks, rupture immédiate, quota global par dix minutes, pause de 15/30/60 minutes.
- Données de démonstration conservées dans le navigateur. Réinitialisation dans Capacité & service.
- Cache hors connexion après la première ouverture réussie ; les actions restent enregistrées localement. Les onglets du même navigateur reçoivent les mises à jour.

## Limites intentionnelles

Ce prototype n’est pas un système de production : aucun paiement, SMS ou remboursement réel, pas d’authentification par rôle, de base serveur, de WebSockets, ni de synchronisation entre appareils. Les réservations ne sont pas des transactions distribuées ; ne pas utiliser pour la vente réelle ou des utilisateurs concurrents. Une réservation simultanée par profil navigateur. Le quota est global pour les huit créneaux affichés, non paramétrable individuellement. Recettes et temps théoriques fixes. Les performances 1 000 visiteurs / 4 000 commandes ne sont pas certifiées. Les délais ajoutés modifient l’estimation client sans recalcul global du planning. Les stocks des commandes annulées sont réintégrés uniquement avant préparation.

Pour la production : stockage transactionnel et verrouillage atomique stocks/créneaux, réservations par session avec expiration serveur, traitement idempotent des webhooks de paiement, authentification/autorisation, file événementielle, synchronisation des actions cuisine hors ligne et prestataire de notifications.

## Photo

Jemima Whyles / Unsplash — https://unsplash.com/photos/a-pizza-sitting-in-a-stone-oven-with-flames-coming-out-of-it-KUdkIGMGnhM — licence Unsplash.

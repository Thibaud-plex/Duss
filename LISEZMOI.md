# 3V Sécurité : installation

Application web pour le hors-piste aux 3 Vallées : carte en relief en 2D et 3D, pentes dangereuses, pistes et remontées, itinéraires hors-piste, météo sur 5 heures, alertes, forfaits et partage de position.

## 1. La mettre en ligne (GitHub Pages, environ 5 minutes)

1. Sur github.com, crée un nouveau dépôt, par exemple `3v-securite`, en **public**.
2. Ouvre le dépôt, clique sur **Add file › Upload files** et glisse **tout le contenu** du dossier dézippé. Il faut glisser les fichiers et les dossiers `vendor` et `icons`, pas le dossier parent.
3. Clique sur **Commit changes**.
4. Va dans **Settings › Pages**. Dans « Branch », choisis `main` et `/ (root)`, puis clique sur **Save**.
5. Après une minute environ, l'adresse s'affiche, de la forme `https://<ton-compte>.github.io/3v-securite/`.

L'adresse doit commencer par **https** : le GPS et le mode hors-ligne ne fonctionnent pas sans.

## 2. L'installer sur l'iPhone de ton frère

1. Ouvre l'adresse dans **Safari**. Chrome sur iPhone ne permet pas l'installation.
2. Appuie sur le bouton **Partager** (le carré avec une flèche), puis sur **Sur l'écran d'accueil**.
3. L'icône « 3V Sécu » apparaît : elle s'ouvre en plein écran, comme une vraie appli.
4. Au premier lancement, accepte la **localisation** pour avoir la position GPS.
5. En wifi : bouton **Calques › Enregistrer la carte pour le hors-ligne**. La carte reste alors disponible sans réseau.

## 3. D'où viennent les données

| Fonction | Source |
|---|---|
| Fond « Relief » (couleurs d'altitude, ombrage, courbes de niveau), 3D, calcul des pentes | AWS Terrain Tiles, avec le module maplibre-contour pour les courbes |
| Fond « Topo » | OpenTopoMap |
| Plan IGN, photo aérienne, carte des pentes, traces hivernales | IGN (Géoplateforme) |
| Noms des sommets | OpenStreetMap |
| Pistes et remontées | OpenStreetMap |
| Itinéraires hors-piste et sorties récentes | Camptocamp (collaboratif) |
| Météo | Open-Meteo, modèle AROME de Météo-France |
| Risque avalanche | saisi à la main, ou automatique avec une clé gratuite Météo-France (Alertes › Réglage avancé) |
| Prix des forfaits | relevés le 19/11/2026 sur les sites des stations, à mettre à jour dans `app.js` (bloc `PRICES`) |

Si la carte des pentes de l'IGN ne répond pas, l'appli calcule elle-même les pentes à partir du relief.

## 4. Utilisation sur les pistes

- **Bandeau du haut** : le risque avalanche du jour (à saisir le matin) et la météo. Touche l'un ou l'autre pour le détail.
- **Toucher n'importe où sur la carte** affiche l'altitude, la pente et l'orientation à cet endroit.
- **Toucher une piste, une remontée ou un point orange** affiche sa fiche détaillée.
- **Boutons de droite** : 3D ou à plat, choix du fond de carte et des calques, carte des pentes, ta position.
- **Bouton rouge SOS** : appel au 112 et envoi de ta position.

## 5. Pour modifier

- Les prix sont dans `app.js`, en haut du fichier (bloc `PRICES`).
- Les textes sur la faune et la flore sont dans `lib.js`, dans la fonction `nature`.
- Après chaque modification, change `3v-shell-v1` en `3v-shell-v2` dans `sw.js`, pour que les iPhone récupèrent la nouvelle version.

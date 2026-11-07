<div align="center">
  <h1>🏁 RaceHub OG</h1>
  <p><strong>Le cockpit de course open source pour Carrera DIGITAL 132 / 124</strong></p>
  <p>Organisez les courses, gérez le paddock, animez la soirée et analysez les résultats — sur votre propre ordinateur.</p>
  <p>
    <a href="https://github.com/DickHorner/RaceHubOS_Dick/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/DickHorner/RaceHubOS_Dick/actions/workflows/ci.yml/badge.svg?branch=main"></a>
    <a href="LICENSE"><img alt="AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue"></a>
  </p>
  <p>
    <a href="README.md"><kbd>🇬🇧 English</kbd></a> &nbsp;
    <a href="README.de.md"><kbd>🇩🇪 Deutsch</kbd></a> &nbsp;
    <strong><kbd>🇫🇷 Français</kbd></strong>
  </p>
  <p>
    <a href="#direction-de-course">Courses</a> ·
    <a href="#garage-et-paddock">Garage</a> ·
    <a href="#spectacle-et-son">Show &amp; Son</a> ·
    <a href="#analyses">Analyses</a> ·
    <a href="#demarrage">Démarrage</a> ·
    <a href="#contribuer">Contribuer</a>
  </p>
</div>

RaceHub OG est une continuation communautaire indépendante de [RaceHubOS](https://github.com/AnselmeSDR/RaceHubOS). Cette application de gestion des courses fonctionne localement dans le navigateur et se connecte à la Control Unit Carrera par Bluetooth LE / AppConnect. Le simulateur intégré permet de découvrir le logiciel sans circuit. Aucun compte cloud n'est nécessaire pour une soirée de course locale.

| [![Illustration de la direction de course](packages/frontend/public/illustrations/race.svg)](#direction-de-course) | [![Illustration d'un garage de voitures de course](packages/frontend/public/illustrations/garage.svg)](#garage-et-paddock) |
|:---:|:---:|
| **[Direction de course](#direction-de-course)** — Sessions, championnats, règles et arbitrage | **[Garage et paddock](#garage-et-paddock)** — Voitures, pilotes, équipes et circuits |
| [![Illustration d'une scène et de haut-parleurs](packages/frontend/public/illustrations/show.svg)](#spectacle-et-son) | [![Illustration de graphiques](packages/frontend/public/illustrations/analysis.svg)](#analyses) |
| **[Spectacle et son](#spectacle-et-son)** — Pads tactiles, écrans et annonces | **[Analyses](#analyses)** — Temps au tour, historique, statistiques et exports |

## Direction de course

- Essais, qualifications et courses avec chronométrage en direct, classement, feux de départ, podium et résultats.
- Championnats manuels et automatiques avec groupes de qualification, progression des manches et classement général.
- Règles de météo et pneus secs/pluie, carburant virtuel et ravitaillement, arrêts obligatoires, pondération des temps par le poids du carburant et dégâts simulés.
- Écrans individuels pour les pilotes et direction de course mobile séparée pour les pénalités, leur exécution confirmée, les décisions aux stands et la Virtual Safety Car (VSC). Les actions disponibles dépendent de l'état de la session, de la connexion et des droits.

## Garage et paddock

- Gestion des pilotes, voitures, équipes et circuits, avec images, fiches, records et historique.
- Fiches techniques détaillées et réglages de vitesse, freinage et carburant de la Control Unit sur dix niveaux.
- Comparaison des performances par sessions d'équilibrage dédiées et statistiques de tours.

## Spectacle et son

- Soundboard tactile autonome pour l'opérateur de spectacle, sans droits de direction de course.
- Bibliothèque de clips et de messages vocaux personnalisés, ainsi que déclencheurs sonores automatiques (notamment pour le carburant et les pénalités).
- Annonces vocales, ambiance sonore locale facultative réduite pendant les annonces, écrans personnels des pilotes et tableau de classement spectateur en lecture seule.
- La lecture sonore à distance exige un navigateur récepteur prêt et les autorisations déjà prévues.

## Analyses

- Historique des sessions et championnats, tours, événements, statistiques et classements.
- Exports Excel/CSV des données pertinentes et vue de résultats imprimable.
- Export **HTML hors ligne** facultatif pour les courses/qualifications terminées : aperçu avant téléchargement, pilotes anonymisés par défaut et noms ajoutés uniquement après sélection et validation explicites.

### Distinguer matériel et simulation

| Fonction | Effet |
|---|---|
| Simulation météo et pneus | Modifie le classement temporel virtuel, **pas** les tours mesurés ni la vitesse physique des voitures. |
| Carburant virtuel, stratégie aux stands et poids du carburant | Calculés indépendamment du mode carburant propre à la Control Unit. |
| VSC et réglages de vitesse/freinage | Peuvent envoyer des commandes à la **véritable CU**. Vérifiez leur effet sur votre circuit : un simulateur ou une CI réussie ne constitue pas une preuve matérielle. |

## Démarrage

**Prérequis :** [Node.js 22.13+](https://nodejs.org/), npm 10+ et Git. Pour les courses réelles : une Control Unit Carrera DIGITAL 132/124 compatible, AppConnect et un adaptateur Bluetooth LE fonctionnel. Le simulateur ne nécessite aucun matériel Carrera.

> [!WARNING]
> Les scripts fournis `RaceHubOS-install-win.bat` et `RaceHubOS-install-mac.command` téléchargent encore le dépôt d'origine `AnselmeSDR/RaceHubOS`, **et non ce fork**. Pour RaceHub OG, utilisez l'installation manuelle ci-dessous. La vérification de version intégrée interroge également le dépôt d'origine : elle n'indique pas de façon fiable les mises à jour de ce fork.

<details open>
<summary><strong>🪟 Windows — PowerShell</strong></summary>

Ouvrez PowerShell après avoir installé Node.js, npm et Git :

```powershell
git clone https://github.com/DickHorner/RaceHubOS_Dick.git
cd RaceHubOS_Dick
npm install
npm run dev
```

</details>

<details>
<summary><strong>🍎 macOS — Terminal</strong></summary>

```bash
git clone https://github.com/DickHorner/RaceHubOS_Dick.git
cd RaceHubOS_Dick
npm install
npm run dev
```

</details>

<details>
<summary><strong>🐧 Linux — Terminal</strong></summary>

```bash
git clone https://github.com/DickHorner/RaceHubOS_Dick.git
cd RaceHubOS_Dick
npm install
npm run dev
```

L'utilisation du Bluetooth matériel sous Linux nécessite BlueZ et les permissions D-Bus du système. Consultez le guide [Bluetooth Linux](docs/LINUX-BLUETOOTH.md). Ne lancez pas le backend en root.

</details>

L'interface de développement est accessible sur **http://localhost:5173** et le backend sur **http://localhost:3001**. Au démarrage, le client Prisma et les migrations de base de données sont générés/vérifiés ou appliqués automatiquement.

Pour une installation locale compilée, arrêtez d'abord le mode développement, puis :

```bash
npm run build
npm start
```

Ouvrez **http://localhost:3001**. Avant toute mise à jour, vérifiez que le dépôt distant Git pointe vers **ce fork** et sauvegardez les données de course. Ne vous fiez pas à l'installateur ou à l'indicateur de version encore orientés vers l'amont.

<details>
<summary><strong>Simulateur, appareils en réseau et accès du directeur</strong></summary>

- **Simulateur :** activez le mode admin/développeur dans les paramètres pour faire apparaître le simulateur parmi les appareils. Il teste les parcours logiciels, pas le Bluetooth réel.
- **Téléphones et écrans :** utilisez l'adresse LAN du PC de course sur un réseau local de confiance. `localhost` sur un téléphone désigne le téléphone, pas le PC de course.
- **Direction de course :** configurez l'identifiant du directeur localement sur le PC de course. Les liens de pilotes ne donnent pas ces droits. N'exposez pas l'API sur l'Internet public ; le bouton Chaos n'est pas un arrêt d'urgence certifié. Consultez [direction mobile et sécurité des accès](docs/MOBILE-RACE-CONTROL.md).

</details>

<details>
<summary><strong>Développement et vérifications</strong></summary>

Le monorepo utilise React/Vite, Tailwind et Socket.IO dans `packages/frontend`, Node/Express et Prisma/SQLite dans `packages/backend`, ainsi qu'une logique métier partagée dans `packages/shared`.

```bash
npm run check -- --ci
npm run build
npm test -w @racehubos/backend
```

Les tests de l'interface utilisent Playwright. Voir [CONTRIBUTING.md](CONTRIBUTING.md), les [conventions du dépôt](docs/CONVENTIONS.md) et [l'architecture](docs/ARCHITECTURE.md). Les tests backend utilisent une base jetable. Une compilation ou une CI réussie ne prouve pas le fonctionnement avec une véritable Control Unit.

</details>

## Contribuer

Signalements de bogues, idées, traductions, améliorations UX et code sont les bienvenus. Consultez les [issues](https://github.com/DickHorner/RaceHubOS_Dick/issues), lisez [CONTRIBUTING.md](CONTRIBUTING.md) et proposez des pull requests ciblées. Les questions matérielles doivent être vérifiées sur une vraie CU et non déduites du simulateur.

## Licence et crédits

Le projet est distribué sous [GNU Affero General Public License v3 ou ultérieure](LICENSE) (`AGPL-3.0-or-later`). Voir les [mentions relatives aux composants tiers](THIRD_PARTY_NOTICES.md).

**Origines :** [RaceHubOS](https://github.com/AnselmeSDR/RaceHubOS) a été créé par **Anselme Schneider**, avec **Romain Danna** comme co-auteur. RaceHub OG poursuit ce travail dans ce dépôt. Les références sur le protocole Carrera comprennent [Stephan Hess / slotbaer.de](http://www.slotbaer.de/), [carreralib](https://github.com/tkem/carreralib) et [OpenLap](https://github.com/tkem/openlap), de Thomas Kemmer. Merci à toutes les personnes qui contribuent au projet.

*RaceHub OG est un projet communautaire indépendant, sans affiliation officielle avec Carrera.*

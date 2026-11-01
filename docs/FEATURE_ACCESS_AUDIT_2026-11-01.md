# Erreichbarkeit der Ergänzungen aus PR #80–#103

Stand: 1.11.2026. Geprüfte Basis: `29c4c06801a7cb771d2bd6cefdd0b97ef2b5e5af`.

Ergebnis: **nicht durchgehend selbsterklärend**. Die Funktionen waren weitgehend implementiert, aber direkte Einstiege und erkennbare Voraussetzungen fehlten insbesondere bei Fahrerfunktionen, Diagnose und Rennleitungsaktionen.

Dieser Patch ergänzt direkte Startseiten-/Bereichslinks aus einer gemeinsamen Navigationsliste. Hash-Ziele werden auch nach Laden einer Lazy-Route angesprungen. Rollen-, Session- und Datengrenzen bleiben serverseitig bestehen; gesperrte Funktionen erläutern ihre Voraussetzungen.

| PR | Funktion | Sichtbarer Weg / Voraussetzung |
|---|---|---|
| #80 | Rennleitercode wiederherstellen | Startseite → Rennleiterzugang; Wiederherstellung direkt am Renn-PC über localhost erklärt |
| #81 | Verwaiste Sessions auflösen | Startseite → laufende Sessions aufräumen; vor Anmeldung sichtbar, Bedienung mit Rennleitercode |
| #82 | Virtuellen Verbrauch konfigurieren | Startseite → Tankregeln; Strecke/Session wählen, vor Start bearbeiten |
| #83 | Beobachtete Stopps und virtuelle Betankung | Rennleitung, Fahreransicht und Sessiondetail; Beobachtung bleibt von tatsächlicher Betankung getrennt |
| #84, #86, #90–#92 | Persönlicher Starttank und Boxenstrategie, Prozent-/Rundenziele, Vorschau, Zielbedarf | Startseite → persönlicher Fahrerlink; eigener Link, virtueller Tank, Sessiontyp/-phase und Mindestdaten für Schätzung werden erklärt |
| #85 | Pflichtstopps | Tankregeln vor Start, Erfüllungsstatus in Fahrer-/Rennleitung-/Historienansicht |
| #87, #89, #93 | Startdiagnose und Download | Startseite/Datenlabor → Startdiagnose; Aktivierung vor Versuch und Download-Autorisierung sichtbar |
| #88, #97 | Simulator-/Startup-Korrekturen | Betriebsfixes ohne eigenen Funktionsschalter; kein künstlicher Navigationseintrag |
| #94, #95 | Tankverlauf und Gewichtsvorschau | Startseite/Datenlabor → Historie; gespeicherte Session mit virtuellem Tank auswählen |
| #96, #98–#100 | Soundbibliothek, automatische Trigger und Fehlerzustände | Startseite/Show & Sound → Soundverwaltung; direkt geöffnet, Ladezustand und Empfängerfreigabe erklärt |
| #101 | Persistierte Tankgewichts-Wertung | Tankregeln; virtueller Tank und Rennen/Qualifying erforderlich, nach Start gesperrt; historische Werte separat gekennzeichnet |
| #102 | Strafableistung | Startseite → Zeitstrafen; Zugang sichtbar, eigener Rennleitercode und gestartetes Rennen für Bedienung |
| #103 | Lokales Rennambiente | Startseite/Show & Sound → Rennambiente in Sessionansicht; ausdrücklicher Klick, lokale Wiedergabe und Sessionende erklärt |

Zusätzlich bleiben virtuelle Reifen und die Zielreichweitenfunktion in der Fahreransicht sichtbar, wenn Wetter, geeignete Sessionphase oder Fahrerlink fehlen. Die Bedienung ist dann gesperrt und begründet. Fahrerlinks werden auch ohne bereits zugeordnete Fahrer als Funktion angezeigt, mit Hinweis auf die notwendige Zuordnung.

Nachweise: Quellcodeabgleich der gemergten PRs, gezielte Browserprüfungen für direkte Links/Ankersprung, gesperrte Rennleitungsfunktionen und Fahrerfunktionen ohne Voraussetzungen. CI prüft die bestehenden Abläufe mit. Kein Nachweis physischer CU-Wirkung; Berechtigungsgrenzen werden nicht aufgehoben.

# Optional static result export — issue #23

## Implemented slice

Open a finished race or qualifying session → **Result sheet / HTML**. The static export panel is visible directly. Review its exact table, optionally include driver names, acknowledge the selected data, then download `racehub-results.html`. Changing the name selection clears the acknowledgement.

The generated file contains only the generic title/note and the preview table: place/DNF, anonymous driver number or explicitly selected driver name, classified lap count, measured best lap, and applicable simulated best/classified total. It reuses the existing race/qualifying classification; it never serializes a session object.

Excluded even with names enabled: IDs, session/track/championship names, timestamps, cars, email, account or device data, access tokens, URLs and raw lap logs. Driver aliases are anonymous labels for this export, not a guarantee against identification through result correlation.

## Threat boundaries

- A mistaken name disclosure: names default off; preview and a fresh review are required when names change. A neutral filename omits the session name/ID.
- Markup or network injection through names: all displayed values are HTML-escaped. The file contains no scripts, requests, external assets or links. Its CSP denies resources except the embedded style and forbids base URLs/forms. Offline browser validation checks escaped malicious names and absence of executable elements.
- Unintended upload: generation and download run locally in the browser. No upload endpoint, background publication, hosting credential or required third-party account is added. The existing local/LAN result page remains separate.
- Stale or copied results: the artifact explicitly identifies itself as a static snapshot. Local deletion cannot revoke third-party copies or caches.

## Hosting remains unverified

No public URL, hosted expiry or remote deletion is implemented or claimed. With a future real user-controlled endpoint, a separate trial must verify upload authorization, the intended public fields, public access, update/expiry behavior, deletion, and cache expectations. Credentials must stay out of session data. Until that flow exists and is tested, issue #23's public-hosting boundary remains open.

## Repository precedents

`SessionResults.jsx` supplies the existing classification, `ExportButton.jsx` supplies the browser Blob/download pattern, and `sessionResults.spec.js` covers local sharing, completed-session gates and simulated timing. The new regression checks both the rendered review and the downloaded standalone file offline.

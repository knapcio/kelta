# Security policy

## Supported versions

Kelta is currently a research prototype and has no supported production release. Do not use it to process untrusted application definitions or sensitive production data.

## Reporting a vulnerability

Once the repository is published, use GitHub private vulnerability reporting rather than a public issue. Include a minimal reproduction, affected commit, impact and any suggested mitigation.

Particularly important areas are:

- HTML, attribute, style or script injection during compilation;
- resume-capsule data exposure;
- prototype pollution in decoded plans or state;
- key/marker parsing that crosses DOM ownership boundaries;
- capability or server/client placement mistakes.

The project intentionally rejects functions, executable strings and raw HTML in its optimizable IR. That is a defense boundary, not merely a style preference.

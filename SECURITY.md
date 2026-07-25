# Security Policy

Siphon brokers access to remote servers and to folders on the machine it runs on, so security
reports are taken seriously. Thank you for helping keep users safe.

## Supported versions

Siphon is developed on a rolling basis. Security fixes target the latest release and the
`main` branch. Please make sure you can reproduce an issue against a recent version before
reporting it.

| Version        | Supported   |
| -------------- | ----------- |
| Latest release | Yes         |
| `main`         | Yes         |
| Older releases | Best effort |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the impact, and steps to reproduce.

If you cannot use private reporting, contact the maintainer ([@dentifrag](https://github.com/dentifrag))
directly on GitHub and ask for a secure channel before sharing details.

### What to include

- A clear description of the vulnerability and its impact.
- Steps to reproduce or a proof of concept.
- The version, commit, or deployment type (Docker or single-file binary) affected.
- Any suggested remediation, if you have one.

### What to expect

- An acknowledgement of your report, typically within a few days.
- An assessment and, where warranted, a fix and coordinated disclosure.
- Credit for the report if you would like it, once a fix is available.

## Scope and known limitations

Some behavior is intentional and documented rather than a vulnerability:

- Siphon does **not** verify SFTP host keys. Run it only on networks you trust. This is called
  out in the README.
- "Open mode" intentionally serves the UI without authentication for trusted LAN use. Do not
  expose an open-mode instance to untrusted networks.
- By default, with neither `DOWNLOAD_DIRS` nor `DOWNLOAD_DIR` set, Siphon is unconfined: the
  folder picker can browse the whole machine and transfers can target any absolute path on the
  server. Set `DOWNLOAD_DIRS` to restrict downloads and uploads to specific folders, and enable
  authentication before exposing Siphon.

If you are unsure whether something is in scope, report it privately and we will figure it out
together.

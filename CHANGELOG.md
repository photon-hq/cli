# Changelog

## 3.1.0 (2026-11-13)


### Features

* **completion:** add photon completion and reject unknown shells (ENG-5739)

## 3.0.2 (2026-11-12)


### Bug Fixes

* **cli:** fix four 3.0 defects before 3.0.2 (ENG-5647)
* **release:** attach the installers to every release (ENG-5637)


### Documentation

* **cli:** remove the guides that move to photon-hq/docs (ENG-5498)
* remove README links to CLI guides that aren't published (ENG-5498)

## 3.0.1 (2026-11-12)


### Bug Fixes

* **release:** pass npm the tarball as a file and dry-run it before approval (ENG-3791)

## 3.0.0 (2026-11-12)


### ⚠ BREAKING CHANGES

* **cli:** print the API's response as the WhatsApp Business commands' JSON (ENG-4845)
* **cli:** print the API's response as the platform purchase, connect, release and list commands' JSON (ENG-4845)
* **cli:** print the API's response as the project billing commands' JSON (ENG-4845)
* **cli:** print the API's response as the project platform voice commands' JSON (ENG-4845)
* **cli:** print the API's response as account and account service key commands' JSON (ENG-4845)
* **cli:** print the API's response as organization, member, invitation and billing commands' JSON (ENG-4845)
* **cli:** print the API's response as project, agent profile and API key commands' JSON (ENG-4845)
* **cli:** print the API's response as project platform read commands' JSON (ENG-4845)
* **cli:** print the API's response as OAuth commands' JSON (ENG-4845)
* **cli:** print the API's response as webhook and OAuth connection list JSON, with golden tests (ENG-4845)
* **cli:** page invoice and OAuth connection lists with --limit and --page-token (ENG-4845)
* **cli:** print one JSON document on stdout, the result or the error (ENG-4845)
* **cli:** photon greet no longer exists.
* **cli:** the JSON error drops httpStatus, problemType and remediation, API errors keep the server's code instead of per-service codes, and connection and response failures use API_CONNECTION_ERROR and API_PROTOCOL_ERROR.
* **cli:** internal builds are @photon-hq/cli-staging with the photon-staging command, and keep credentials under photon-v3-staging. Log in again after updating.

### Features

* check every Photon ID against its exact format (ENG-4558)
* **cli:** add a beta label to command definitions (ENG-4557)
* **cli:** add staging and production build targets (ENG-3778)
* **cli:** build production on @photon-ai/api and make it the default target (ENG-3789)
* **cli:** decide prompts, color and spinners in one module and wind down on SIGTERM and SIGHUP (ENG-5207)
* **cli:** leave internal-only commands out of production builds (ENG-3787)
* **cli:** make help and usage errors readable and copyable (ENG-5203)
* **cli:** make help and usage errors readable and copyable (ENG-5203)
* **cli:** make photon login work in CI and containers (ENG-3781)
* **cli:** map every API error through one core mapper (ENG-4556)
* **cli:** name the key's kind and variable when Photon refuses it with a 403 (ENG-3781)
* **cli:** name the project and organization a command acts on (ENG-5204)
* **cli:** name the project and organization a command acts on (ENG-5204)
* **cli:** page invoice and OAuth connection lists with --limit and --page-token (ENG-4845)
* **cli:** point Photon CLI 1.0 commands and credentials to the legacy CLI (ENG-3787)
* **cli:** print one JSON document on stdout, the result or the error (ENG-4845)
* **cli:** print the API's response as account and account service key commands' JSON (ENG-4845)
* **cli:** print the API's response as OAuth commands' JSON (ENG-4845)
* **cli:** print the API's response as organization, member, invitation and billing commands' JSON (ENG-4845)
* **cli:** print the API's response as project platform read commands' JSON (ENG-4845)
* **cli:** print the API's response as project, agent profile and API key commands' JSON (ENG-4845)
* **cli:** print the API's response as the platform purchase, connect, release and list commands' JSON (ENG-4845)
* **cli:** print the API's response as the project billing commands' JSON (ENG-4845)
* **cli:** print the API's response as the project platform voice commands' JSON (ENG-4845)
* **cli:** print the API's response as the WhatsApp Business commands' JSON (ENG-4845)
* **cli:** print the API's response as webhook and OAuth connection list JSON, with golden tests (ENG-4845)
* **cli:** print the API's whole project as link's JSON and golden-test the sign-in and local commands (ENG-4845)
* **cli:** refuse photon link when --org doesn't match the project's organization (ENG-5548)
* **cli:** remove the greet sample command (ENG-3787)
* **cli:** save the folder's project with photon link (ENG-4558)
* **cli:** send a User-Agent that names the CLI version and agent (ENG-3779)
* **cli:** send unrecognized AI_AGENT values as cleaned names (ENG-3779)
* **cli:** use the key in PHOTON_API_TOKEN for every command (ENG-3781)
* **cli:** wind down on SIGTERM and SIGHUP like Ctrl-C and exit 128 plus the signal (ENG-5207)
* **output:** settle prompts, confirmation and exit codes (ENG-3780)
* save each folder's project in .photon/project.json (ENG-4558)
* **update:** add install scripts, photon update and the update notice (ENG-4847)
* **update:** add install scripts, photon update and the update notice (ENG-4847)


### Bug Fixes

* **build:** run the build scripts when started through a symlink (ENG-5212)
* **cli:** accept every email address the Account API returns when signing in (ENG-5584)
* **cli:** accept fields the API adds to email-domain and MFA responses (ENG-4845)
* **cli:** address review on proxies, cancellation and requests outside the SDK (ENG-5212)
* **cli:** address review on titles, links, quoting, voice step and cancellation (ENG-4556)
* **cli:** answer a malformed Voice profile ID from Photon in outbound enable and rotate as a protocol error (ENG-5573)
* **cli:** answer a wrong-kind operation ID given to email dns as an input error (ENG-5556)
* **cli:** answer an invalid account email in login --service-key as a protocol error (ENG-5574)
* **cli:** ask Photon for active senders only in whatsapp-business number list (ENG-5593)
* **cli:** carry --no-input into a moved command's replacement (ENG-3780)
* **cli:** carry a boolean option into a moved command as the parser reads it (ENG-5203)
* **cli:** carry help and usage errors onto the exact ID checks (ENG-5203)
* **cli:** check every read of a platform operation wait against the operation and resource it started (ENG-5592)
* **cli:** check the account email before saving a device login (ENG-5584)
* **cli:** confirm the target only for deletes with remote operations (ENG-5069)
* **cli:** correct the docs and error messages the hand test found (ENG-5615)
* **cli:** drop the retry warnings that copied the SDK's retry rules (ENG-5212)
* **cli:** explain the Node.js version pnpm cli and pnpm dev need (ENG-3789)
* **cli:** find a moved or legacy command's words the way the parser reads global options (ENG-5550)
* **cli:** give every not-signed-in error one message and next step (ENG-3781)
* **cli:** give every not-signed-in error one message and next step (ENG-3781)
* **cli:** give five WhatsApp Business number add errors steps that fix them (ENG-5507)
* **cli:** hide the secret of a malformed API key in the 1.0 pointer (ENG-5206)
* **cli:** join a dash-led value to its option in the next page command (ENG-5205)
* **cli:** keep only the origin of a URL in an error name (ENG-5211)
* **cli:** keep stdout for the answer and say when a list has more pages (ENG-5205)
* **cli:** keep stdout for the answer and say when a list has more pages (ENG-5205)
* **cli:** keep the help rewrite inside runCli error handling (ENG-5203)
* **cli:** keep the next steps an argument error brings (ENG-5348)
* **cli:** keep the production test running when a command exits before reading stdin (ENG-3790)
* **cli:** keep the signal's exit code through a selection prompt and a closed terminal (ENG-5207)
* **cli:** keep the spinner going on a terminal that reports 0 columns (ENG-3780)
* **cli:** keep words after a secret key in --debug output (ENG-4556)
* **cli:** leave out remediation links with sig, key or jwt parameters (ENG-4556)
* **cli:** list a parse error once when it was thrown for several values (ENG-5203)
* **cli:** make API strings inert in text output (ENG-4845)
* **cli:** move to SDK build 259 and fix OAuth secret and subscription commands (ENG-3786)
* **cli:** name a missing input before asking for confirmation; ask before a new key adds a Telegram bot (ENG-3780)
* **cli:** name key kinds the way Photon's docs and Dashboard do (ENG-3781)
* **cli:** name the build's command in argument error hints (ENG-3778)
* **cli:** name the host when sign-in, refresh or MFA requests fail (ENG-5212)
* **cli:** name the proxy when it refuses the connection or its name doesn't resolve (ENG-5212)
* **cli:** never take an option as the value of a moved command global option (ENG-5203)
* **cli:** print a single next step with its description (ENG-4556)
* **cli:** print API problem titles unredacted (ENG-4556)
* **cli:** read --flag=false, empty values and missing values (ENG-5211)
* **cli:** read --flag=false, empty values and missing values (ENG-5211)
* **cli:** read the User-Agent's SDK version from the SDK each target bundles (ENG-3789)
* **cli:** read WhatsApp Business sender detail in the shape Platforms returns (ENG-5624)
* **cli:** recognize --no-input in moved-command pointers (ENG-3780)
* **cli:** redact bare token values and apostrophe-bearing URLs in --debug output (ENG-5552)
* **cli:** redact credentials before shortening URLs in error text (ENG-5211)
* **cli:** refuse a platform re-read or release that answers for another operation or resource (ENG-5587)
* **cli:** refuse a secret ID after -- in oauth-client secret revoke (ENG-3786)
* **cli:** refuse a secret ID in oauth-client secret revoke (ENG-3786)
* **cli:** refuse a Voice profile read that answers for another profile in outbound enable and rotate (ENG-5585)
* **cli:** refuse an argument after -- even when an optional positional is free (ENG-5203)
* **cli:** remove the Onboarded line from account view (ENG-5563)
* **cli:** report a cancelled MFA request as interrupted (ENG-4556)
* **cli:** report connect timeouts and refused proxy tunnels as network errors (ENG-5212)
* **cli:** report several refused secret IDs the way one is reported (ENG-5203)
* **cli:** resolve an interrupted delete only when its target is gone (ENG-5069)
* **cli:** resolve an interrupted delete only when its target is gone (ENG-5069)
* **cli:** say credentials were preserved only for a stored sign-in, and send CI to a service identity key (ENG-3781)
* **cli:** send the update check through the proxy variables (ENG-5212)
* **cli:** send voice assignment changes to the line named, and fail when the answer leaves one out (ENG-5572)
* **cli:** show a failed billing operation in project billing operation view (ENG-5602)
* **cli:** show iMessage line health from detail.imessageHealth (ENG-5621)
* **cli:** show options in square brackets on help's usage line unless required (ENG-5566)
* **cli:** show required option values as &lt;name&gt; in help (ENG-5555)
* **cli:** show scheduled plan changes in project billing overview (ENG-3786)
* **cli:** stop reading output flags at -- when printing an error (ENG-5551)
* **cli:** stop the old-token check reading --help and --version after -- (ENG-5564)
* **cli:** take an API key by ID only in api-key revoke (ENG-5206)
* **cli:** take an API key by ID only in api-key revoke (ENG-5206)
* **cli:** use the proxy variables and name the host in network errors (ENG-5212)
* **cli:** use the proxy variables and name the host in network errors (ENG-5212)
* **cli:** write the organization into the rerun of org-scoped confirmations (ENG-3780)
* **operation:** finish a replayed email disconnect on a 404 (ENG-5596)
* **output:** keep a one-time secret's record and report a failed stdout write (ENG-5612)
* skip another build's .photon/project.json, and report the .gitignore outcome in JSON (ENG-4558)
* **update:** find a project dependency from the folder photon runs in (ENG-4847)
* **update:** find pnpm 10 and 11 global installs and stop timed-out installs (ENG-4847)
* **update:** follow links to the global folder and keep each install's notice apart (ENG-4847)
* **update:** follow pnpm's stable links and stop commands with their trees (ENG-4847)
* **update:** harden the installers and photon update after review (ENG-4847)
* **update:** keep one notice record for both commands of an install (ENG-4847)
* **update:** read --json the way the CLI does, and never let the notice fail a command
* **update:** retry the Windows binary swap while another process holds the file (ENG-4847)
* **update:** run package managers outside the project and settle stopped commands (ENG-4847)
* **update:** stop the Windows swap on an interrupt, and name the backup when it cannot go back
* **update:** tell a pnpm project dependency from a global install of the same copy (ENG-4847)
* **update:** widen only pnpm 10's global folder when telling a start apart (ENG-4847)


### Documentation

* **cli:** allow the install token in the agent rules (ENG-3783)
* **cli:** document every command's JSON shape and the 3.x promise on the output page (ENG-4845)
* **cli:** install the plain @photon-ai/cli package instead of photon-cli (ENG-3784)
* **cli:** keep the Dashboard's Keep &lt;plan&gt; label out of MDX parsing (ENG-3786)
* **cli:** list LEGACY_TOKEN among the exit-2 codes
* **cli:** name the secret command to run instead of the CLI pointing to it (ENG-4556)
* **cli:** name the services that exist in the agent guide (ENG-3783)
* **cli:** place the text-mode next page line after the example (ENG-5205)
* **cli:** use --yes and the - stdin form in the command pages; waits under --json (ENG-3780)
* **cli:** write the agent guide in AGENTS.md (ENG-3783)
* **cli:** write the agent guide in AGENTS.md (ENG-3783)
* **export:** add the community files photon-hq/cli's new main starts from (ENG-4846)
* say the committed installers carry the production defaults
* **update:** list PHOTON_NO_UPDATE_NOTIFIER with the environment variables (ENG-4847)
* use a valid organization ID in the next-page example (ENG-4558)

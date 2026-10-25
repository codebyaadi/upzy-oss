# Upstream templates

The files in `upstream/` are unmodified copies of templates from
[projectdiscovery/nuclei-templates](https://github.com/projectdiscovery/nuclei-templates), MIT licensed
(Copyright (c) ProjectDiscovery, Inc.), taken at commit `b6fd8ba791874e70ea76b42a448f346f3fad4238`.

Every one is a plain `GET` for a file or page that should not be public. None sends a payload that changes anything,
guesses a credential, fuzzes a parameter or needs an out-of-band server, which is the bar for this set: an owner who
reads the list sees only requests that a curious visitor could make.

To add or update a template, copy it from that repository, record the commit here, read it, and rebuild. Templates
that are not listed here do not run, and the scanner never fetches templates at run time.

Files:

- `aws-config.yaml`
- `docker-compose-config.yaml`
- `dockercfg-config.yaml`
- `dockerfile-hidden-disclosure.yaml`
- `git-credentials-disclosure.yaml`
- `github-workflows-disclosure.yaml`
- `gitlab-ci-yml.yaml`
- `laravel-env.yaml`
- `phpinfo-files.yaml`
- `ssh-authorized-keys.yaml`
- `svn-wc-db.yaml`
- `symfony-database-config.yaml`

The upstream license text is in `upstream-LICENSE.md`.

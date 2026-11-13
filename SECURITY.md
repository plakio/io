# Security

## Threat model

IO gives the model a shell that runs as your user. It is designed to reduce
accidental damage and make model actions visible. It is **not a sandbox** and
does not protect against a malicious or prompt-injected model.

The permission layer:

- asks for approval before commands that match a conservative destructive
  pattern;
- supports user-defined allow/ask/deny rules;
- denies a small set of credential files and known AWS/provider variables;
- keeps the active permission mode and rules in memory for the session, so a
  config-file edit does not unlock the current session.

It does **not**:

- isolate files, processes, credentials, or network access;
- fully parse shell syntax (quoting, variables, functions, and shell builtins
  can still express destructive behavior);
- hide ambient environment variables other than the provider credentials listed
  in the README;
- prevent a model from writing `config.json` for a future session.

If you need to run untrusted prompts, repositories, or plugins, use an OS-level
sandbox (a separate user, container, `bwrap`, or macOS `sandbox-exec`) and do not
mount your real home directory or credentials.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Contact the
maintainer privately through the repository owner profile, or use GitHub's
private vulnerability reporting for the repository. Include the version
(`io --version`), the command or prompt involved, and a minimal reproduction.

## Operational guidance

- Do not export long-lived tokens (`GH_TOKEN`, cloud credentials, SSH agent
  sockets) into the environment that runs io. IO removes known provider keys,
  not every ambient credential.
- Use `verbosity normal` or `high` when auditing a session: `low` hides tool
  panels.
- Review `/debug` output before sharing it; it contains transcript content.
- Session files are private user data. IO sets them to `0600` and keeps the data directory (`0700`) private.

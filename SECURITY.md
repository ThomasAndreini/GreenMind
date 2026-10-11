# Security Policy

## Supported Versions

| GreenMind | Node-RED | Node.js | Supported          |
| --------- | -------- | ------- | ------------------ |
| 2.x       | 5.x      | 24 LTS (22 LTS on 32 bit ARM) | :white_check_mark: |
| 0.x / 1.x | 2.x-3.x  | 18      | :x:                |

## Protecting your installation

- The installer asks for a user name and a password and stores the bcrypt hash and a
  random credential secret in `~/.node-red/greenmind-auth.json` (file mode 600).
  The same credentials protect the Node-RED editor, the dashboard and its socket.io channel.
- Never commit `greenmind-auth.json` or any `*_cred.json` file.
- To change the password delete `~/.node-red/greenmind-auth.json` and run the installer again,
  or put a new hash created with `node-red admin hash-pw` in the file, then restart Node-RED.
- GreenMind is meant to run inside your local network. Do not expose port 1880 to the internet:
  use a VPN or a reverse proxy with HTTPS if you need remote access.

## Reporting a Vulnerability

Please report vulnerabilities privately with GitHub's
[private vulnerability reporting](https://github.com/ThomasAndreini/GreenMind/security/advisories/new)
instead of opening a public issue. You will receive an answer as soon as possible; accepted
issues are fixed in the next release and credited in the changelog.

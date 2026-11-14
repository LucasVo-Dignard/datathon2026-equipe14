# Chatbot (prototype)

Node.js server with no dependencies: username-only login (no password, this is
a prototype), conversations per user, data in a JSON file.

- `server.js`: API (`/api/login`, `/api/chats`, ...) and static files
- `bot.js`: **where the agents plug in**. Replace `reply()` with a call to your agents.
- `public/`: interface (HTML/CSS/JS)

Run locally:

```bash
node app/server.js   # http://localhost:3000, data in app/data/db.json
```

Deployed to the EC2 by Terraform (see `../infra/README.md`).

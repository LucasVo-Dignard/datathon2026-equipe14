# Chatbot (prototype)

Node.js server: username-only login (no password, this is
a prototype), conversations per user, data in a JSON file.

- `server.js`: API (`/api/login`, `/api/chats`, ...) and static files
- `bot.js`: **the agent**. Basic version: Claude Opus 5.5 on Amazon Bedrock
  (`@anthropic-ai/bedrock-sdk`), no tools or search, replies from the
  conversation history. Refusals fall back to Claude Opus 4.8.
  `AGENT_MODEL` / `AGENT_EFFORT` env vars override the model and effort.
- `public/`: interface (HTML/CSS/JS)

Run locally:

```bash
npm install
npm run dev   # http://localhost:3000, loads AWS credentials from .env-aws,
              # data in app/data/db.json
```

Deployed to the EC2 by Terraform (see `../infra/README.md`).

On the EC2, the agent needs `npm install` (the SDK) and the instance role
needs `bedrock-mantle:CreateInference`: until then it answers with an error
message. The current user_data deployment doesn't install dependencies.

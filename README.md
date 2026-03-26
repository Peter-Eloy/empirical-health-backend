# OpenD Backend

Simple Express.js backend for Don Vicente AI.

## Quick Deploy to Railway

### 1. Create Backend Files

 railway.json 
{
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node server.js"
  }
}

 package.json 
{
  "name": "empirical-health-api",
  "version": "1.0.0",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "jsonwebtoken": "^9.0.2"
  }
}

### 2. Deploy

1. Push this backend folder to GitHub
2. Go to railway.app
3. New Project → Deploy from GitHub repo
4. Add environment variables:
   - `KIMI_API_KEY` = your actual key
   - `JWT_SECRET` = random string (generate: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
5. Done! Railway gives you a URL like `https://empirical-api.up.railway.app`

### 3. Update App

In vicenteProxy.ts, change:
```javascript
const PROXY_BASE_URL = 'https://your-railway-url.up.railway.app/v1';
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `KIMI_API_KEY` | Your Kimi API key (sk-...) |
| `JWT_SECRET` | Random string for JWT signing |
| `PORT` | Port to run on (Railway sets this) |

## Testing

```bash
curl -X POST https://your-api.up.railway.app/v1/vicente/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test-token" \
  -d '{
    "message": "Hello Don Vicente",
    "context": {"currentGlucose": {"value": 120}}
  }'
```

# BisFly redeploy setup

This project is ready for a simple Node deployment.

## Local run

```bash
npm install
npm start
```

Visit: http://localhost:8082

## Render deployment

1. Push this folder to a GitHub repository.
2. Create a new Web Service on Render.
3. Connect the repo.
4. Use these values:
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Environment variables:
     - `PORT=10000`
     - `HOST=0.0.0.0`
     - `EMAIL_USER=bisflytravels@gmail.com`
     - `EMAIL_PASS=your_app_password`

## Railway deployment

1. Push to GitHub.
2. Import repo on Railway.
3. Set the Start Command to: `node server.js`
4. Add the same environment variables as above.

## Default admin login

- Username: admin
- Password: BisFly@2026

## Important note

This app stores data in local JSON files and uploads on the server filesystem. It is suitable for a temporary deployment, but not a true multi-instance production database setup.

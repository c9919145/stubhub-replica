# Deploying to GitHub Pages

This repo is a static site (all HTML/CSS/JS in the root), so it deploys to GitHub Pages with no build step. The workflow in `.github/workflows/pages.yml` builds and publishes it automatically.

## One-time setup

1. Create a public repo (or push this folder to an existing one):
   ```sh
   git init
   git add .
    git commit -m "TicketVault"
   git branch -M main
   git remote add origin https://github.com/<YOUR_USERNAME>/<REPO>.git
   git push -u origin main
   ```
   If using SSH instead of HTTPS: `git@github.com:<YOUR_USERNAME>/<REPO>.git`.

2. On GitHub, open **Settings → Pages** for the repo and set:
   - **Source:** `GitHub Actions`
   - Everything else can stay default. The action deploys on every push to `main`.

3. Wait ~1 minute for the first deployment, then open the URL shown in **Settings → Pages**.

## Public URL

Because the site lives in a repo (not a `USERNAME.github.io` repo), the URL is a subpath:

```
https://<YOUR_USERNAME>.github.io/<REPO>/
```

All asset paths in the site are already relative, so CSS/JS/images resolve correctly under the subpath.

## Custom domain / subdomain (optional)

To serve it from your own subdomain, e.g. `tickets.example.com`:

1. Add a file named `CNAME` in the repo root containing just `tickets.example.com` (push it to `main`).
2. In the DNS for `example.com`, add a `CNAME` record:
   - Name: `tickets`
   - Target: `<YOUR_USERNAME>.github.io`
3. GitHub will provision the TLS certificate automatically (can take minutes to hours). Verify under **Settings → Pages → Custom domain** shows "DNS check successful" and the domain is "Enforced HTTPS".

Note: a user-site repo named exactly `<YOUR_USERNAME>.github.io` uses the root domain `https://<YOUR_USERNAME>.github.io/` instead of a subpath.

## What works on GitHub Pages

Static pages that only use `localStorage` work fully:
`index.html`, `search.html`, `matt-rife.html`, `event.html`, `tickets.html`.

Pages that talk to the Node/Stripe/PayPal backend (`checkout.html`, `admin.html`, `confirmation.html`)
need the server from `npm start` — they can't run on static hosting. They still load the UI, but
API data won't populate. Run the backend separately and open those pages against it if you need the full flow.
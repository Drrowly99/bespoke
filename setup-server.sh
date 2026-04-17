#!/bin/bash
# automated deployment setup for bespoke-backend

echo "--- Installing Nginx config ---"
sudo ln -sf $(pwd)/bespoke.nginx.conf /etc/nginx/sites-enabled/bespoke
sudo nginx -t && sudo systemctl reload nginx

echo "--- Setup Playwright ---"
cd backend
npx playwright install --with-deps chromium

echo "--- Starting with PM2 ---"
# Note: Ensure you have edited ecosystem.config.cjs with your actual keys first!
pm2 start ecosystem.config.cjs
pm2 save

echo "--- Deployment Complete! ---"
echo "Check logs with: pm2 logs bespoke-backend"

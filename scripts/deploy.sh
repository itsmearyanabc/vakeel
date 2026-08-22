#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "Starting deployment of Vakeel..."

# 1. Pull the latest code (assuming you have already cloned the repo)
# If this is the first time, you need to run: git clone https://github.com/itsmearyanabc/vakeel.git .
echo "Pulling latest code from git..."
git pull origin main

# 2. Install dependencies
echo "Installing dependencies..."
npm install

# 3. Build the NestJS project
echo "Building the project..."
npm run build

# 4. Restart or start the PM2 process
# We use the start-all.js script to run both web and worker together.
echo "Restarting PM2 process..."
pm2 restart vakeel || pm2 start scripts/start-all.js --name "vakeel"

# 5. Save PM2 list so it restarts on server reboot
echo "Saving PM2 list..."
pm2 save

echo "Deployment complete! Run 'pm2 list' or 'pm2 logs vakeel' to verify."
